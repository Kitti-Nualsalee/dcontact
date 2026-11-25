/**
 * E1.14 (#488) on real Postgres with the app role (`dcontact_app`, RLS):
 * - set the screen-pop level per origin: default off, a reason is required, audit `SCREEN_POP_CHANGED`, `custom` cannot be set yet
 * - the payload has no field beyond the level; reduced when there is no `VIEW` scope and when there is a restriction/objection
 * - the origin comes only from an `embedded` lease; another agent's work/another lease gets no data
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { EMBED_ORIGIN_SERVICE, EmbedOriginsController } from './embed-origins-api.js';
import { DPHONE_EMBED_FLAG, EmbedOriginService } from './embed-origins.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { SCREEN_POP_SERVICE, ScreenPopController } from './screen-pop-api.js';
import {
  TEAM_SEGMENT_SCOPE_DATABASE,
  TeamSegmentScopeController,
} from './team-segment-scope-api.js';
import {
  ContactGovernanceDisclosureCheck,
  IamTeamSegmentViewScope,
  SCREEN_POP_POLICY_VERSION,
  ScreenPopService,
  UnavailableTeamSegmentViewScope,
  type TeamSegmentViewScope,
} from './screen-pop.js';
import { WorkSessionLeases } from './work-session.js';

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});

const HOST = 'https://crm.example.test';

function claims(token: string): VerifiedOidcClaims {
  const [tenantId, userId, role] = token.split('|');
  const tenantSlug = `tenant-${tenantId}`;
  return {
    tenant_id: tenantId,
    tenant_slug: tenantSlug,
    organization: { [tenantSlug]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: [role!] },
  };
}

async function setup(t: TestContext, viewScope: TeamSegmentViewScope) {
  const tenantId = randomUUID();
  const slug = `pop-${tenantId.slice(0, 8)}`;
  const users = {
    admin: randomUUID(),
    supervisor: randomUUID(),
    agent: randomUUID(),
    other: randomUUID(),
  };
  await owner.tenant.create({
    data: { id: tenantId, name: slug, slug, sipDomain: `${tenantId}.pop.test` },
  });
  await owner.user.createMany({
    data: [
      { id: users.admin, role: 'ADMIN' as const },
      { id: users.supervisor, role: 'SUPERVISOR' as const },
      { id: users.agent, role: 'AGENT' as const },
      { id: users.other, role: 'AGENT' as const },
    ].map((user) => ({
      ...user,
      tenantId,
      email: `${user.id}@pop.test`,
      passwordHash: 'test',
      displayName: user.role,
    })),
  });
  await owner.tenantUiFlag.create({
    data: {
      tenantId,
      flagKey: DPHONE_EMBED_FLAG,
      enabled: true,
      reason: 'E1.14 test',
      updatedByActor: 't',
    },
  });
  const origins = new EmbedOriginService(application, { allowLocalhost: false });
  const admin = { tenantId, userId: users.admin };
  const origin = await origins.create(admin, { origin: HOST, label: 'CRM' }, 'c-origin');
  const leases = new WorkSessionLeases(application, { embedOrigins: origins });
  const service = new ScreenPopService(application, {
    hostOriginOfLease: (actor, leaseId) => leases.embeddedHostOrigin(actor, leaseId),
    screenPopLevel: (tenant, host) => origins.screenPopLevel(tenant, host),
    disclosure: new ContactGovernanceDisclosureCheck(application, viewScope),
  });
  const agent = { tenantId, userId: users.agent };
  const lease = await leases.acquire(agent, { surface: 'embedded', hostOrigin: HOST }, 'l1');

  const contactId = randomUUID();
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'Test Customer' } });
  const interaction = async (input: { agentId?: string; contactId?: string | null }) => {
    const id = randomUUID();
    const contact = input.contactId === undefined ? contactId : input.contactId;
    const metadata = JSON.stringify({
      caller: '0812345678',
      dnis: '021234567',
      recordingUrl: 'https://rec.test/1.wav',
    });
    // raw SQL: not tied to unrelated columns (the dev DB on some machines does not yet have conversation_id)
    await owner.$executeRaw`
      INSERT INTO interactions (id, tenant_id, channel, direction, state, agent_id, contact_id, metadata)
      VALUES (${id}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND', 'ACTIVE',
              ${input.agentId ?? users.agent}::uuid, ${contact}::uuid, ${metadata}::jsonb)`;
    return id;
  };

  @Module({
    controllers: [EmbedOriginsController, ScreenPopController, TeamSegmentScopeController],
    providers: [
      { provide: EMBED_ORIGIN_SERVICE, useValue: origins },
      { provide: SCREEN_POP_SERVICE, useValue: service },
      { provide: TEAM_SEGMENT_SCOPE_DATABASE, useValue: application },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: { verifyAccessToken: async (token: string) => claims(token) },
      },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  t.after(async () => {
    await app.close();
    await owner.cgRestriction.deleteMany({ where: { tenantId } });
    await owner.$executeRaw`DELETE FROM interactions WHERE tenant_id = ${tenantId}::uuid`;
    await owner.iamScopeInvalidationOutbox.deleteMany({ where: { tenantId } });
    await owner.iamContactSegmentScopeProjection.deleteMany({ where: { tenantId } });
    await owner.iamTeamSegmentScopeRevocation.deleteMany({ where: { tenantId } });
    await owner.iamTeamSegmentScopeActiveGrant.deleteMany({ where: { tenantId } });
    await owner.iamTeamSegmentScopeGrant.deleteMany({ where: { tenantId } });
    await owner.iamTeamScopeVersion.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.agentWorkSessionEvent.deleteMany({ where: { tenantId } });
    await owner.agentWorkSessionLease.deleteMany({ where: { tenantId } });
    await owner.agentStateLog.deleteMany({ where: { tenantId } });
    await owner.tenantEmbedOriginAuditEvent.deleteMany({ where: { tenantId } });
    await owner.tenantEmbedOrigin.deleteMany({ where: { tenantId } });
    await owner.tenantUiFlag.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
  });

  const call = async (
    method: string,
    path: string,
    role: keyof typeof users,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tenantId}|${users[role]}|${role === 'other' ? 'agent' : role}`,
        'x-correlation-id': 'corr-pop',
        'content-type': 'application/json',
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  };
  let revision = origin.revision;
  const setLevel = async (screenPopLevel: string) => {
    const updated = await origins.update(
      admin,
      origin.id,
      { expectedRevision: revision, screenPopLevel, reason: 'Data level test' },
      'c-level',
    );
    revision = updated.revision;
  };
  const restrict = (type: 'OBJECTION' | 'DNC' | 'REGULATORY', expiresAt: Date | null = null) =>
    owner.cgRestriction.create({
      data: {
        tenantId,
        contactId,
        type,
        scope: 'CONTACT',
        reasonCode: `TEST_${type}`,
        source: 'test',
        createdBy: 'test',
        startsAt: new Date(Date.now() - 60_000),
        expiresAt,
      },
    });
  return {
    tenantId,
    users,
    origin,
    origins,
    service,
    agent,
    lease,
    contactId,
    interaction,
    call,
    setLevel,
    restrict,
    revision: () => revision,
  };
}

const allowView: TeamSegmentViewScope = { canView: async () => true };
const common = ['decisionId', 'interactionId', 'level', 'policyVersion', 'requestId', 'type', 'v'];

test('set the level per origin: default off, a reason is required, custom cannot be set yet, before/after audit; a SUPERVISOR cannot edit', async (t) => {
  const f = await setup(t, allowView);
  const path = `/api/v1/tenant/embed-origins/${f.origin.id}`;
  const listed = await f.call('GET', '/api/v1/tenant/embed-origins', 'admin');
  assert.equal(listed.body.origins[0].screenPopLevel, 'off');

  const noReason = await f.call('PATCH', path, 'admin', {
    expectedRevision: 1,
    screenPopLevel: 'ids',
  });
  assert.deepEqual(noReason, {
    status: 400,
    body: { code: 'VALIDATION_FAILED', field: 'reason', reason: 'REQUIRED' },
  });
  const custom = await f.call('PATCH', path, 'admin', {
    expectedRevision: 1,
    screenPopLevel: 'custom',
    reason: 'Needs extra fields',
  });
  assert.deepEqual(custom.body, {
    code: 'VALIDATION_FAILED',
    field: 'screenPopLevel',
    reason: 'UNAVAILABLE',
  });
  const combined = await f.call('PATCH', path, 'admin', {
    expectedRevision: 1,
    screenPopLevel: 'ids',
    enabled: false,
    reason: 'Combined command',
  });
  assert.equal(combined.status, 400);
  const supervisor = await f.call('PATCH', path, 'supervisor', {
    expectedRevision: 1,
    screenPopLevel: 'ids',
    reason: 'Team supervisor',
  });
  assert.equal(supervisor.status, 403);

  const changed = await f.call('PATCH', path, 'admin', {
    expectedRevision: 1,
    screenPopLevel: 'contact',
    reason: 'CRM must show the customer name',
  });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.screenPopLevel, 'contact');
  const audit = await owner.tenantEmbedOriginAuditEvent.findFirstOrThrow({
    where: { tenantId: f.tenantId, action: 'SCREEN_POP_CHANGED' },
  });
  assert.equal((audit.before as any).screenPopLevel, 'off');
  assert.equal((audit.after as any).screenPopLevel, 'contact');
  assert.equal(audit.reason, 'CRM must show the customer name');
  assert.equal(audit.actorUserId, f.users.admin);
  assert.equal(audit.correlationId, 'corr-pop');
});

test('origin turns screen-pop off (default) → off with no call data', async (t) => {
  const f = await setup(t, allowView);
  const interactionId = await f.interaction({});
  assert.deepEqual(
    await f.service.build(f.agent, { leaseId: f.lease.leaseId, interactionId, requestId: 'r1' }),
    { status: 'off' },
  );
});

test('the payload has only the fields of the level that is set (ids / contact) and no data beyond the level', async (t) => {
  const f = await setup(t, allowView);
  const interactionId = await f.interaction({});
  const input = { leaseId: f.lease.leaseId, interactionId, requestId: 'r1' };

  await f.setLevel('ids');
  const ids = await f.service.build(f.agent, input);
  assert.equal(ids.status, 'sent');
  if (ids.status !== 'sent') return;
  assert.equal(ids.hostOrigin, HOST);
  assert.deepEqual(
    Object.keys(ids.message).sort(),
    [...common, 'callState', 'contactId', 'direction'].sort(),
  );
  assert.equal(ids.message.contactId, f.contactId);
  assert.equal(ids.message.policyVersion, SCREEN_POP_POLICY_VERSION);

  await f.setLevel('contact');
  const contact = await f.service.build(f.agent, input);
  assert.equal(contact.status, 'sent');
  if (contact.status !== 'sent') return;
  assert.deepEqual(
    Object.keys(contact.message).sort(),
    [...common, 'callState', 'contactId', 'direction', 'ani', 'dnis', 'displayName'].sort(),
  );
  assert.equal(contact.message.ani, '0812345678');
  assert.equal(JSON.stringify(contact.message).includes('rec.test'), false);
  assert.notEqual(contact.message.decisionId, ids.message.decisionId);
});

test('no VIEW scope (IAM has no VIEW yet → fail closed) → only interactionId + TEAM_SEGMENT_NOT_ALLOWED remain', async (t) => {
  const f = await setup(t, new UnavailableTeamSegmentViewScope());
  const interactionId = await f.interaction({});
  await f.setLevel('contact');
  const outcome = await f.service.build(f.agent, {
    leaseId: f.lease.leaseId,
    interactionId,
    requestId: 'r1',
  });
  assert.equal(outcome.status, 'sent');
  if (outcome.status !== 'sent') return;
  assert.deepEqual(Object.keys(outcome.message).sort(), [...common, 'reasonCode'].sort());
  assert.equal(outcome.message.level, 'interaction');
  assert.equal(outcome.message.reasonCode, 'TEAM_SEGMENT_NOT_ALLOWED');
});

test('the VIEW scope from IAM allows only the agent team and a revoke returns to fail closed', async (t) => {
  const viewScope = new IamTeamSegmentViewScope(application);
  const f = await setup(t, viewScope);
  const teamId = randomUUID();
  await owner.team.create({ data: { id: teamId, tenantId: f.tenantId, name: 'Screen pop VIEW' } });
  await owner.user.update({ where: { id: f.users.agent }, data: { teamId } });
  const scopes = new IamTeamSegmentScopeRepository(application);
  const grant = await scopes.grant({
    tenantId: f.tenantId,
    teamId,
    segmentId: 'VIP',
    permission: 'VIEW',
    correlationId: 'grant-view',
  });
  await withTenantDatabaseTransaction(application, f.tenantId, (transaction) =>
    transaction.iamContactSegmentScopeProjection.create({
      data: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        segmentId: 'VIP',
        state: 'IN',
        membershipRevision: 1,
        entryId: randomUUID(),
        sourceEventId: randomUUID(),
        sourceOccurredAt: new Date(),
      },
    }),
  );
  const interactionId = await f.interaction({});
  await f.setLevel('contact');
  const input = { leaseId: f.lease.leaseId, interactionId, requestId: 'view-allow' };
  const allowed = await f.service.build(f.agent, input);
  assert.equal(allowed.status === 'sent' && allowed.message.level, 'contact');

  await scopes.revoke({
    tenantId: f.tenantId,
    grantId: grant.grant.id,
    reasonCode: 'VIEW_REVOKED',
    correlationId: 'revoke-view',
  });
  const revoked = await f.service.build(f.agent, { ...input, requestId: 'view-revoked' });
  assert.equal(revoked.status, 'sent');
  if (revoked.status !== 'sent') return;
  assert.equal(revoked.message.level, 'interaction');
  assert.equal(revoked.message.reasonCode, 'TEAM_SEGMENT_NOT_ALLOWED');
});

test('HTTP: an ADMIN manages the VIEW scope without extending permission to a SUPERVISOR, and after a revoke the list returns no active grant', async (t) => {
  const f = await setup(t, allowView);
  const teamId = randomUUID();
  await owner.team.create({ data: { id: teamId, tenantId: f.tenantId, name: 'Scope API team' } });
  const path = '/api/v1/tenant/team-segment-scopes';

  assert.equal((await f.call('GET', path, 'supervisor')).status, 403);
  assert.equal(
    (await f.call('POST', path, 'admin', { teamId: 'not-a-uuid', segmentId: 'VIP' })).status,
    400,
  );

  const granted = await f.call('POST', path, 'admin', { teamId, segmentId: 'VIP' });
  assert.equal(granted.status, 201);
  assert.equal(granted.body.outcome, 'GRANTED');
  assert.equal(granted.body.grantId.length, 36);

  const listed = await f.call('GET', path, 'admin');
  assert.equal(listed.status, 200);
  assert.deepEqual(
    listed.body.scopes.map((scope: { teamId: string; segmentId: string; grantId: string }) => ({
      teamId: scope.teamId,
      segmentId: scope.segmentId,
      grantId: scope.grantId,
    })),
    [{ teamId, segmentId: 'VIP', grantId: granted.body.grantId }],
  );

  assert.equal(
    (await f.call('DELETE', `${path}/${granted.body.grantId}`, 'admin', { reasonCode: 'x' }))
      .status,
    400,
  );
  assert.equal(
    (await f.call('DELETE', `${path}/${granted.body.grantId}`, 'admin', { reasonCode: 'removed' }))
      .status,
    204,
  );
  assert.deepEqual(await f.call('GET', path, 'admin'), { status: 200, body: { scopes: [] } });
});

test('a restriction/objection still in effect → reduced to ids; expired or DNC does not reduce', async (t) => {
  const f = await setup(t, allowView);
  const interactionId = await f.interaction({});
  const input = { leaseId: f.lease.leaseId, interactionId, requestId: 'r1' };
  await f.setLevel('contact');

  await f.restrict('DNC');
  await f.restrict('OBJECTION', new Date(Date.now() - 1_000));
  const notReduced = await f.service.build(f.agent, input);
  assert.equal(notReduced.status === 'sent' && notReduced.message.level, 'contact');

  await f.restrict('OBJECTION');
  const reduced = await f.service.build(f.agent, input);
  assert.equal(reduced.status, 'sent');
  if (reduced.status !== 'sent') return;
  assert.equal(reduced.message.level, 'ids');
  assert.equal(reduced.message.reasonCode, 'CONTACT_RESTRICTED');
  assert.equal('ani' in reduced.message, false);
  assert.equal('displayName' in reduced.message, false);
});

test('the contact cannot be identified yet: ANI can be sent only at contact level or above', async (t) => {
  const f = await setup(t, new UnavailableTeamSegmentViewScope());
  const interactionId = await f.interaction({ contactId: null });
  const input = { leaseId: f.lease.leaseId, interactionId, requestId: 'r1' };
  await f.setLevel('ids');
  const ids = await f.service.build(f.agent, input);
  assert.equal(ids.status === 'sent' && 'ani' in ids.message, false);
  await f.setLevel('contact');
  const contact = await f.service.build(f.agent, input);
  assert.equal(contact.status === 'sent' && contact.message.ani, '0812345678');
});

test("HTTP: must have the own embedded lease; another agent's work or a wrong lease gets no data", async (t) => {
  const f = await setup(t, allowView);
  await f.setLevel('ids');
  const mine = await f.interaction({});
  const theirs = await f.interaction({ agentId: f.users.other });
  const path = '/api/v1/workspace/agent/screen-pop';
  const lease = { 'x-work-session-lease-id': f.lease.leaseId };

  const ok = await f.call(
    'POST',
    path,
    'agent',
    { interactionId: mine, requestId: 'req-1' },
    lease,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.status, 'sent');
  assert.equal(ok.body.hostOrigin, HOST);
  assert.equal(ok.body.message.requestId, 'req-1');

  const noLease = await f.call('POST', path, 'agent', { interactionId: mine, requestId: 'req-2' });
  assert.equal(noLease.status, 400);
  const otherWork = await f.call(
    'POST',
    path,
    'agent',
    { interactionId: theirs, requestId: 'req-3' },
    lease,
  );
  assert.equal(otherWork.status, 404);
  const stolenLease = await f.call(
    'POST',
    path,
    'other',
    { interactionId: theirs, requestId: 'req-4' },
    lease,
  );
  assert.equal(stolenLease.status, 404);
  const admin = await f.call('POST', path, 'admin', { interactionId: mine, requestId: 'r' }, lease);
  assert.equal(admin.status, 403);
});

test('disabling the origin during use → the lease is not current so there is no more screen-pop', async (t) => {
  const f = await setup(t, allowView);
  await f.setLevel('ids');
  const interactionId = await f.interaction({});
  await f.origins.update(
    { tenantId: f.tenantId, userId: f.users.admin },
    f.origin.id,
    { expectedRevision: f.revision(), enabled: false },
    'c-off',
  );
  assert.deepEqual(
    await f.service.build(f.agent, { leaseId: f.lease.leaseId, interactionId, requestId: 'r' }),
    { status: 'not_found' },
  );
});
