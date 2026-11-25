import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  buildCg4PolicyScopeKey,
  type Cg4EvidenceAccessRecord,
} from '@d-contact/contact-governance';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import {
  CG4_API_CONTROLLERS,
  CG4_DATABASE,
  CG4_EVIDENCE_ACCESS_SINK,
} from './contact-governance-cg4-api.js';
import {
  CONTACT_GOVERNANCE_DATABASE,
  ContactGovernancePoliciesController,
} from './contact-governance-api.js';

/**
 * CG4.7 (#190): the command/query surface end to end, with two tenants in every fixture.
 *
 * The point of the second tenant is not coverage padding: #179 §3 requires a resource in
 * another tenant to be reported exactly like one that never existed, and that is only
 * provable with a real id that really does exist somewhere else.
 */

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

const DIGEST = 'a'.repeat(64);
const SCOPE_KEY = buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' });

function workspaceClaims(
  tenantId: string,
  userId: string,
  role: 'agent' | 'admin' | 'compliance' | 'platform-operator',
): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: `tenant-${tenantId}`,
    organization: { [`tenant-${tenantId}`]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: [role] },
  };
}

interface TenantFixture {
  tenantId: string;
  contactId: string;
  identityId: string;
  policyId: string;
  maker: string;
  checker: string;
  reader: string;
}

async function seedTenant(label: string): Promise<TenantFixture> {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const identityId = randomUUID();
  const policyId = randomUUID();
  const maker = `maker-${randomUUID()}`;
  const checker = `checker-${randomUUID()}`;
  const reader = `reader-${randomUUID()}`;

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG4.7 ${label} ${tenantId}`,
      slug: `cg47-${label}-${tenantId}`,
      sipDomain: `${tenantId}.cg47.test`,
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'CG4.7' } });
  await owner.contactIdentity.create({
    data: {
      id: identityId,
      tenantId,
      contactId,
      type: 'PHONE',
      value: `+66${tenantId.replace(/\D/g, '').slice(0, 9)}`,
    },
  });
  await owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId,
      policyId,
      version: 1,
      scopeKey: SCOPE_KEY,
      content: { allowedOperationalRuleCodes: ['QUIET_HOURS'] },
      contentDigest: DIGEST,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      // An exception may only pin a policy that is actually in force (#177 §1).
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      makerActorRef: maker,
    },
  });

  // The authorization store is administered outside the application role, exactly as the
  // production grants require — the app can only read it.
  for (const [subjectId, directCompliance] of [
    [maker, false],
    [checker, true],
    [reader, false],
  ] as const) {
    await owner.cg4AuthorizationSubject.create({
      data: {
        id: randomUUID(),
        tenantId,
        subjectId,
        directComplianceAuthority: directCompliance,
        emergencyAuthority: false,
        isServicePrincipal: false,
        authorizationEpoch: 1,
        scopeVersion: 1,
      },
    });
  }
  for (const [subjectId, capability] of [
    [maker, 'cg.exception.request'],
    [maker, 'cg.policy.draft'],
    [checker, 'cg.exception.approve.standard'],
    [checker, 'cg.exception.approve.high'],
    [checker, 'cg.exception.revoke'],
    [checker, 'cg.policy.publish'],
    [checker, 'cg.policy.publish.relaxation'],
  ] as const) {
    await owner.cg4CapabilityGrant.create({
      data: {
        id: randomUUID(),
        tenantId,
        subjectId,
        capability,
        scopeKey: SCOPE_KEY,
        grantedByRef: 'iam-fixture',
      },
    });
  }

  return { tenantId, contactId, identityId, policyId, maker, checker, reader };
}

async function dropTenant(tenantId: string): Promise<void> {
  await owner.cg4ExceptionApproval.deleteMany({ where: { tenantId } });
  await owner.cg4Exception.updateMany({ where: { tenantId }, data: { renewsExceptionId: null } });
  await owner.cg4ExceptionHead.deleteMany({ where: { tenantId } });
  await owner.cg4Exception.deleteMany({ where: { tenantId } });
  await owner.cg4ContactExceptionHead.deleteMany({ where: { tenantId } });
  // CG4.8 (#191): an exception event also advances the contact stream version in cg_contact_state_heads
  await owner.cgContactStateHead.deleteMany({ where: { tenantId } });
  await owner.cg4PolicyApproval.deleteMany({ where: { tenantId } });
  await owner.cg4PolicyTestArtifact.deleteMany({ where: { tenantId } });
  await owner.cg4PolicyActivationJob.deleteMany({ where: { tenantId } });
  await owner.cg4PolicyScopeHead.deleteMany({ where: { tenantId } });
  await owner.cg4Policy.deleteMany({ where: { tenantId } });
  await owner.cg4ScopeKillSwitch.deleteMany({ where: { tenantId } });
  await owner.cg4CapabilityGrant.deleteMany({ where: { tenantId } });
  await owner.cg4AuthorizationSubject.deleteMany({ where: { tenantId } });
  await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
  await owner.cgConsumerAcknowledgement.deleteMany({ where: { tenantId } });
  await owner.cgAuditLog.deleteMany({ where: { tenantId } });
  await owner.cgCommandReceipt.deleteMany({ where: { tenantId } });
  await owner.contactIdentity.deleteMany({ where: { tenantId } });
  await owner.contact.deleteMany({ where: { tenantId } });
  await owner.tenant.deleteMany({ where: { id: tenantId } });
}

async function fixture(t: TestContext) {
  const primary = await seedTenant('a');
  const other = await seedTenant('b');
  const evidenceReads: Cg4EvidenceAccessRecord[] = [];

  const tokens = new Map<string, VerifiedOidcClaims>([
    ['maker-token', workspaceClaims(primary.tenantId, primary.maker, 'admin')],
    ['checker-token', workspaceClaims(primary.tenantId, primary.checker, 'compliance')],
    // Same subject as maker-token, with the gateway role the policy-approval route needs:
    // lets a test isolate the domain-level SoD check from the coarse gateway guard.
    ['maker-compliance-token', workspaceClaims(primary.tenantId, primary.maker, 'compliance')],
    ['reader-token', workspaceClaims(primary.tenantId, primary.reader, 'admin')],
    ['stranger-token', workspaceClaims(primary.tenantId, `unknown-${randomUUID()}`, 'admin')],
    ['other-maker-token', workspaceClaims(other.tenantId, other.maker, 'admin')],
  ]);

  const verifier = {
    verifyAccessToken: async (token: string) => {
      const claims = tokens.get(token);
      if (!claims) throw new Error('invalid token');
      return claims;
    },
  };

  @Module({
    // CG4.10 (#193): the legacy publish alias must work together with the CG4 controller on the same prefix
    controllers: [...CG4_API_CONTROLLERS, ContactGovernancePoliciesController],
    providers: [
      { provide: CG4_DATABASE, useValue: application },
      { provide: CONTACT_GOVERNANCE_DATABASE, useValue: application },
      {
        provide: CG4_EVIDENCE_ACCESS_SINK,
        useValue: { record: (access: Cg4EvidenceAccessRecord) => void evidenceReads.push(access) },
      },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/v1/contact-governance`;

  t.after(async () => {
    await app.close();
    await dropTenant(primary.tenantId);
    await dropTenant(other.tenantId);
  });

  return { primary, other, base, evidenceReads };
}

test.after(async () => {
  await Promise.all([owner.$disconnect(), application.$disconnect()]);
});

function post(url: string, token: string, payload: unknown, idempotencyKey = randomUUID()) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(payload),
  });
}

function get(url: string, token: string) {
  return fetch(url, { headers: { authorization: `Bearer ${token}` } });
}

/**
 * Reads the body exactly once. `assert.equal(res.status, 201, await res.text())` evaluates
 * its message eagerly and leaves the body consumed, which then fails as "Body is unusable".
 */
async function expectJson<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

function exceptionRequest(f: { primary: TenantFixture }, overrides: Record<string, unknown> = {}) {
  return {
    contactId: f.primary.contactId,
    // An EXACT_IDENTITY scope keeps the platform risk floor at STANDARD; CONTACT_WIDE
    // forces HIGH, which is a different (also tested) quorum path.
    identityId: f.primary.identityId,
    channel: 'VOICE',
    purpose: 'SERVICE_NOTIFICATION',
    sourceType: 'DIALER',
    sourceId: 'dialer-1',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: f.primary.policyId,
    policyVersion: 1,
    policyContentDigest: DIGEST,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: '2026-01-05T09:00:00.000Z',
    expiresAt: '2026-01-05T11:00:00.000Z',
    riskTier: 'STANDARD',
    reasonCode: 'OPERATIONAL',
    occurredAt: '2026-01-05T08:00:00.000Z',
    ticketRef: 'ticket://INC-4821',
    evidenceRef: 'evidence://cg47',
    expectedVersion: 0,
    ...overrides,
  };
}

test('a subject that is not in the authorization store is rejected even if the gateway role passes', async (t) => {
  const f = await fixture(t);
  const response = await post(`${f.base}/exceptions`, 'stranger-token', exceptionRequest(f));
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { code: string }).code, 'CAPABILITY_REQUIRED');
});

test('a maker can create an exception, and actorRef comes from the identity, not the body', async (t) => {
  const f = await fixture(t);
  const created = await post(
    `${f.base}/exceptions`,
    'maker-token',
    exceptionRequest(f, { actorRef: 'someone-else', tenantId: f.other.tenantId }),
  );
  assert.equal(created.status, 201);
  const payload = (await created.json()) as { seriesId: string; revision: number };
  assert.equal(payload.revision, 1);

  const row = await owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, exceptionId: payload.seriesId },
  });
  assert.equal(row.actorRef, f.primary.maker, 'actorRef must come from the verified identity');
  assert.equal(row.tenantId, f.primary.tenantId, 'tenantId in the body must be ignored');
});

test('another checker can approve, and a maker cannot approve their own', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };
  const row = await owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, exceptionId: seriesId },
  });

  const decision = {
    decision: 'APPROVE',
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    expectedVersion: 1,
    evidenceRef: 'evidence://approval',
  };

  const selfApproval = await post(
    `${f.base}/exceptions/${seriesId}/approvals`,
    'maker-token',
    decision,
  );
  assert.equal(selfApproval.status, 403);
  assert.equal(((await selfApproval.json()) as { code: string }).code, 'SELF_APPROVAL_FORBIDDEN');

  const approved = await post(
    `${f.base}/exceptions/${seriesId}/approvals`,
    'checker-token',
    decision,
  );
  assert.equal(approved.status, 200);
  const result = (await approved.json()) as { workflowState: string };
  assert.equal(result.workflowState, 'APPROVED');
});

test('a resource of another tenant returns 404, the same as a nonexistent one', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };

  const crossTenant = await get(`${f.base}/exceptions/${seriesId}`, 'other-maker-token');
  const missing = await get(`${f.base}/exceptions/${randomUUID()}`, 'other-maker-token');
  assert.equal(crossTenant.status, 404);
  assert.equal(missing.status, 404);
  assert.deepEqual(await crossTenant.json(), await missing.json());
});

test('a reader without approval capability sees evidence/ticket/actor only as digests', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };

  const asReader = await get(`${f.base}/exceptions/${seriesId}`, 'reader-token');
  assert.equal(asReader.status, 200);
  const summary = (await asReader.json()) as Record<
    string,
    { redacted?: boolean; digest?: string }
  >;
  for (const field of ['evidenceRef', 'ticketRef', 'actorRef']) {
    assert.equal(summary[field]?.redacted, true, field);
    assert.equal(typeof summary[field]?.digest, 'string', field);
  }
  assert.doesNotMatch(JSON.stringify(summary), /INC-4821/);
  assert.doesNotMatch(JSON.stringify(summary), /evidence:\/\/cg47/);

  const asChecker = await get(`${f.base}/exceptions/${seriesId}`, 'checker-token');
  const evidence = (await asChecker.json()) as Record<string, unknown>;
  assert.equal(evidence.evidenceRef, 'evidence://cg47');
  assert.equal(evidence.ticketRef, 'ticket://INC-4821');
  assert.equal(evidence.actorRef, f.primary.maker);
});

test('evidence reads are recorded, while summary reads are not', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };

  await get(`${f.base}/exceptions/${seriesId}`, 'reader-token');
  assert.equal(f.evidenceReads.length, 0);

  await get(`${f.base}/exceptions/${seriesId}`, 'checker-token');
  assert.equal(f.evidenceReads.length, 1);
  assert.equal(f.evidenceReads[0]?.resourceKind, 'EXCEPTION');
  assert.equal(f.evidenceReads[0]?.resourceId, seriesId);
  assert.equal(f.evidenceReads[0]?.viewerSubjectId, f.primary.checker);
});

test('a missing Idempotency-Key is rejected, and the same key with a different body is a conflict', async (t) => {
  const f = await fixture(t);
  const noKey = await fetch(`${f.base}/exceptions`, {
    method: 'POST',
    headers: { authorization: 'Bearer maker-token', 'content-type': 'application/json' },
    body: JSON.stringify(exceptionRequest(f)),
  });
  assert.equal(noKey.status, 400);
  assert.equal(((await noKey.json()) as { code: string }).code, 'VALIDATION_FAILED');

  const key = randomUUID();
  const first = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f), key);
  assert.equal(first.status, 201);
  const replay = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f), key);
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), await first.json());

  const conflicting = await post(
    `${f.base}/exceptions`,
    'maker-token',
    exceptionRequest(f, { reasonCode: 'DIFFERENT' }),
    key,
  );
  assert.equal(conflicting.status, 409);
  assert.equal(((await conflicting.json()) as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
});

test('a stale expectedVersion is a 409 VERSION_CONFLICT', async (t) => {
  const f = await fixture(t);
  await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const stale = await post(
    `${f.base}/exceptions`,
    'maker-token',
    exceptionRequest(f, {
      sourceId: 'dialer-2',
      expectedVersion: 0,
    }),
  );
  assert.equal(stale.status, 409);
  assert.equal(((await stale.json()) as { code: string }).code, 'VERSION_CONFLICT');
});

test('GET returns an ETag bound to the current revision', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };
  const response = await get(`${f.base}/exceptions/${seriesId}`, 'checker-token');
  const etag = response.headers.get('etag');
  assert.ok(etag);
  assert.match(etag, new RegExp(`^"cg4-exception:${seriesId}:1:`));
  // CG4.9 (#192): the query returns the current CAS version that the Console must send back as expectedVersion (#179 §2)
  const view = (await response.json()) as { aggregateVersion: number };
  assert.equal(view.aggregateVersion, 1);
  const listing = (await (
    await get(`${f.base}/contacts/${f.primary.contactId}/exceptions`, 'checker-token')
  ).json()) as { exceptions: Array<{ aggregateVersion: number }> };
  assert.equal(listing.exceptions[0]?.aggregateVersion, 1);
});

test('history and contact listing are redacted per viewer and do not cross tenants', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };

  const history = await get(`${f.base}/exceptions/${seriesId}/history`, 'reader-token');
  assert.equal(history.status, 200);
  const historyBody = await history.text();
  assert.doesNotMatch(historyBody, /INC-4821/);

  const listing = await get(`${f.base}/contacts/${f.primary.contactId}/exceptions`, 'reader-token');
  assert.equal(listing.status, 200);
  const listed = (await listing.json()) as { exceptions: unknown[] };
  assert.equal(listed.exceptions.length, 1);

  // this tenant's contact, seen from another tenant, must be empty, not a 403 that says it exists
  const crossTenant = await get(
    `${f.base}/contacts/${f.primary.contactId}/exceptions`,
    'other-maker-token',
  );
  assert.equal(crossTenant.status, 200);
  assert.deepEqual(((await crossTenant.json()) as { exceptions: unknown[] }).exceptions, []);
});

test('a policy draft builds the scope key from the scope object, not from a string the caller sends', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/policies`, 'maker-token', {
    scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
    scopeKey: 'channel=*|contactKind=*|purpose=*|sourceType=*',
    content: {
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '06:00' }],
      callbackMode: 'NO_OVERRIDE',
      overridableRules: [],
      allowedOperationalRuleCodes: [],
      holidays: [],
    },
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evidenceRef: 'evidence://policy',
  });
  assert.equal(created.status, 201);
  const payload = (await created.json()) as { scopeKey: string; policyId: string };
  assert.equal(payload.scopeKey, SCOPE_KEY, 'scopeKey in the body must be ignored');
});

test('content that escapes a non-overridable rule is rejected at the API', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/policies`, 'maker-token', {
    scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
    content: {
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [],
      callbackMode: 'NO_OVERRIDE',
      overridableRules: [],
      allowedOperationalRuleCodes: ['DNC_GLOBAL'],
      holidays: [],
    },
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evidenceRef: 'evidence://policy',
  });
  assert.equal(created.status, 422);
  assert.equal(((await created.json()) as { code: string }).code, 'NON_OVERRIDABLE_RULE');
});

test('an agent role without a grant is blocked at the gateway, and a subject without a capability matching the scope is blocked at the domain', async (t) => {
  const f = await fixture(t);
  // the reader has a subject in the store but no capability at all
  const denied = await post(`${f.base}/exceptions`, 'reader-token', exceptionRequest(f));
  assert.equal(denied.status, 403);
  const payload = (await denied.json()) as { code: string; capability?: string };
  assert.equal(payload.code, 'CAPABILITY_REQUIRED');
});

test('a kill switch can be opened and the list filters by state', async (t) => {
  const f = await fixture(t);
  const activated = await post(`${f.base}/kill-switches`, 'checker-token', {
    scopeKey: SCOPE_KEY,
    reasonCode: 'INCIDENT',
    evidenceRef: 'evidence://kill',
  });
  assert.equal(activated.status, 201);
  const { killSwitchId } = (await activated.json()) as { killSwitchId: string };

  const listed = await get(`${f.base}/kill-switches?state=ACTIVE`, 'checker-token');
  const rows = (await listed.json()) as { killSwitches: { killSwitchId: string }[] };
  assert.equal(rows.killSwitches.length, 1);
  assert.equal(rows.killSwitches[0]?.killSwitchId, killSwitchId);

  // another tenant must not see this tenant's kill switch
  const crossTenant = await get(`${f.base}/kill-switches?state=ACTIVE`, 'other-maker-token');
  assert.deepEqual(((await crossTenant.json()) as { killSwitches: unknown[] }).killSwitches, []);
});

test('a kill switch clear must be a different subject and have an approval ref', async (t) => {
  const f = await fixture(t);
  const activated = await post(`${f.base}/kill-switches`, 'checker-token', {
    scopeKey: SCOPE_KEY,
    reasonCode: 'INCIDENT',
    evidenceRef: 'evidence://kill',
  });
  const { killSwitchId } = (await activated.json()) as { killSwitchId: string };

  const selfClear = await post(`${f.base}/kill-switches/${killSwitchId}/clear`, 'checker-token', {
    reasonCode: 'RESOLVED',
    clearApprovalRef: 'approval://clear',
    evidenceRef: 'evidence://clear',
  });
  assert.equal(selfClear.status, 422);
  assert.equal(((await selfClear.json()) as { code: string }).code, 'APPROVAL_REQUIRED');
});

const TENANT_PACK = {
  packId: 'TENANT_SYNTHETIC',
  suiteVersion: 'TENANT_SYNTHETIC_V1',
  checks: [
    {
      id: 'tenant:quiet-hours-local-clock',
      kind: 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK',
      timezone: 'Asia/Bangkok',
      fromInstant: '2026-01-05T00:00:00.000Z',
      probeHours: 12,
      stepMinutes: 120,
    },
  ],
};

const POLICY_CONTENT = {
  timezoneFallback: 'Asia/Bangkok',
  quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '06:00' }],
  callbackMode: 'NO_OVERRIDE',
  overridableRules: [],
  allowedOperationalRuleCodes: [],
  holidays: [],
};

test('a policy goes through the full cycle via the API: draft → tests → submit → approve → publish', async (t) => {
  const f = await fixture(t);
  // release the scope the fixture holds, so this scope head is free for a real publish
  await owner.cg4Policy.deleteMany({ where: { tenantId: f.primary.tenantId } });

  const created = await post(`${f.base}/policies`, 'maker-token', {
    scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
    content: POLICY_CONTENT,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evidenceRef: 'evidence://policy',
  });
  const draft = await expectJson<{
    policyId: string;
    policyVersionId: string;
    contentDigest: string;
    draftRevision: number;
  }>(created, 201);

  const tested = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/tests`,
    'maker-token',
    {
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: '2026-01-05T00:00:00.000Z',
      pinnedTimezone: 'Asia/Bangkok',
      evidenceRef: 'evidence://tests',
    },
  );
  const artifact = await expectJson<{
    artifactDigest: string;
    diffClass: string;
    outcome: string;
    baseHeadVersion: number;
    baseHeadDigest: string;
  }>(tested, 201);
  assert.equal(artifact.outcome, 'PASS');
  assert.equal(artifact.diffClass, 'TIGHTENING');

  const submitted = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/submit`,
    'maker-token',
    {
      expectedDraftRevision: draft.draftRevision,
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      evidenceRef: 'evidence://submit',
    },
  );
  await expectJson(submitted, 200);

  const approved = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/approvals`,
    'checker-token',
    {
      decision: 'APPROVE',
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      expectedScopeHeadVersion: artifact.baseHeadVersion,
      expectedScopeHeadDigest: artifact.baseHeadDigest,
      activateAt: '2026-01-05T00:00:00.000Z',
      evidenceRef: 'evidence://approval',
    },
  );
  const approvedBody = await expectJson<{ lifecycleState: string }>(approved, 200);
  assert.equal(approvedBody.lifecycleState, 'APPROVED');

  const row = await owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, id: draft.policyVersionId },
  });
  const published = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/publish`,
    'checker-token',
    {
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      expectedApprovalDigest: row.approvalDigest,
      expectedScopeHeadVersion: artifact.baseHeadVersion,
      expectedScopeHeadDigest: artifact.baseHeadDigest,
      evidenceRef: 'evidence://publish',
    },
  );
  const result = await expectJson<{ lifecycleState: string; scopeKey: string }>(published, 200);
  assert.equal(result.lifecycleState, 'ACTIVE');

  const effective = await get(
    `${f.base}/policy-scopes/${encodeURIComponent(result.scopeKey)}/effective`,
    'checker-token',
  );
  assert.equal(effective.status, 200);
  const head = (await effective.json()) as { activePolicyVersion: number; headVersion: number };
  assert.equal(head.activePolicyVersion, 1);
  assert.equal(head.headVersion, 1);
});

test('CG4.10: legacy POST /policies/{id}/publish enters the same CG4 transaction with deprecation metadata', async (t) => {
  const f = await fixture(t);
  await owner.cg4Policy.deleteMany({ where: { tenantId: f.primary.tenantId } });

  const created = await post(`${f.base}/policies`, 'maker-token', {
    scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
    content: POLICY_CONTENT,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evidenceRef: 'evidence://policy',
  });
  const draft = await expectJson<{
    policyVersionId: string;
    contentDigest: string;
    draftRevision: number;
  }>(created, 201);

  // approvalRef alone is not authority: a version that has not passed test/quorum is rejected
  const early = await post(`${f.base}/policies/${draft.policyVersionId}/publish`, 'checker-token', {
    expectedVersion: 1,
    approvalRef: 'approval://legacy',
  });
  assert.equal(early.headers.get('deprecation'), 'true');
  const earlyBody = await expectJson<{ code: string; lifecycleState: string }>(early, 422);
  assert.equal(earlyBody.code, 'POLICY_CG4_APPROVAL_REQUIRED');
  assert.equal(earlyBody.lifecycleState, 'DRAFT');

  const tested = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/tests`,
    'maker-token',
    {
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: '2026-01-05T00:00:00.000Z',
      pinnedTimezone: 'Asia/Bangkok',
      evidenceRef: 'evidence://tests',
    },
  );
  const artifact = await expectJson<{
    artifactDigest: string;
    baseHeadVersion: number;
    baseHeadDigest: string;
  }>(tested, 201);
  await expectJson(
    await post(`${f.base}/policy-versions/${draft.policyVersionId}/submit`, 'maker-token', {
      expectedDraftRevision: draft.draftRevision,
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      evidenceRef: 'evidence://submit',
    }),
    200,
  );
  await expectJson(
    await post(`${f.base}/policy-versions/${draft.policyVersionId}/approvals`, 'checker-token', {
      decision: 'APPROVE',
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      expectedScopeHeadVersion: artifact.baseHeadVersion,
      expectedScopeHeadDigest: artifact.baseHeadDigest,
      activateAt: '2026-01-05T00:00:00.000Z',
      evidenceRef: 'evidence://approval',
    }),
    200,
  );

  const stale = await post(`${f.base}/policies/${draft.policyVersionId}/publish`, 'checker-token', {
    expectedVersion: 2,
    approvalRef: 'approval://legacy',
  });
  assert.equal((await expectJson<{ code: string }>(stale, 409)).code, 'VERSION_CONFLICT');

  const key = randomUUID();
  const legacy = await post(
    `${f.base}/policies/${draft.policyVersionId}/publish`,
    'checker-token',
    { expectedVersion: 1, approvalRef: 'approval://legacy' },
    key,
  );
  assert.equal(legacy.headers.get('deprecation'), 'true');
  assert.match(legacy.headers.get('link') ?? '', /rel="successor-version"/);
  const result = await expectJson<{
    lifecycleState: string;
    headVersion: number;
    deprecation: { deprecated: boolean; successor: string };
  }>(legacy, 200);
  assert.equal(result.lifecycleState, 'ACTIVE');
  assert.equal(result.headVersion, 1);
  assert.equal(result.deprecation.deprecated, true);
  assert.match(result.deprecation.successor, /policy-versions\/\{versionId\}\/publish$/);

  // retry with the same key returns the original receipt from CG4 and does not advance the head again
  const replay = await post(
    `${f.base}/policies/${draft.policyVersionId}/publish`,
    'checker-token',
    { expectedVersion: 1, approvalRef: 'approval://legacy' },
    key,
  );
  assert.equal((await expectJson<{ headVersion: number }>(replay, 200)).headVersion, 1);
  assert.equal(
    await owner.cgEventOutbox.count({
      where: { tenantId: f.primary.tenantId, eventType: 'policy.changed' },
    }),
    1,
  );
});

test('a maker submits and cannot approve their own, even with the publish capability', async (t) => {
  const f = await fixture(t);
  await owner.cg4CapabilityGrant.create({
    data: {
      id: randomUUID(),
      tenantId: f.primary.tenantId,
      subjectId: f.primary.maker,
      capability: 'cg.policy.publish',
      scopeKey: SCOPE_KEY,
      grantedByRef: 'iam-fixture',
    },
  });
  await owner.cg4Policy.deleteMany({ where: { tenantId: f.primary.tenantId } });

  const created = await post(`${f.base}/policies`, 'maker-token', {
    scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
    content: POLICY_CONTENT,
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    evidenceRef: 'evidence://policy',
  });
  const draft = (await created.json()) as {
    policyVersionId: string;
    contentDigest: string;
    draftRevision: number;
  };
  const tested = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/tests`,
    'maker-token',
    {
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: '2026-01-05T00:00:00.000Z',
      pinnedTimezone: 'Asia/Bangkok',
      evidenceRef: 'evidence://tests',
    },
  );
  const artifact = (await tested.json()) as {
    artifactDigest: string;
    baseHeadVersion: number;
    baseHeadDigest: string;
  };
  await post(`${f.base}/policy-versions/${draft.policyVersionId}/submit`, 'maker-token', {
    expectedDraftRevision: draft.draftRevision,
    expectedContentDigest: draft.contentDigest,
    expectedTestArtifactDigest: artifact.artifactDigest,
    evidenceRef: 'evidence://submit',
  });

  const selfApproval = await post(
    `${f.base}/policy-versions/${draft.policyVersionId}/approvals`,
    'maker-compliance-token',
    {
      decision: 'APPROVE',
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      expectedScopeHeadVersion: artifact.baseHeadVersion,
      expectedScopeHeadDigest: artifact.baseHeadDigest,
      activateAt: '2026-01-05T00:00:00.000Z',
      evidenceRef: 'evidence://approval',
    },
  );
  assert.equal(selfApproval.status, 403);
  assert.equal(((await selfApproval.json()) as { code: string }).code, 'SELF_APPROVAL_FORBIDDEN');
});

test('an approved exception can be revoked, and history keeps every revision', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };
  const row = await owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, exceptionId: seriesId },
  });

  await post(`${f.base}/exceptions/${seriesId}/approvals`, 'checker-token', {
    decision: 'APPROVE',
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    expectedVersion: 1,
    evidenceRef: 'evidence://approval',
  });

  const revoked = await post(`${f.base}/exceptions/${seriesId}/revoke`, 'checker-token', {
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    expectedVersion: 2,
    reasonCode: 'INCIDENT',
    evidenceRef: 'evidence://revoke',
  });
  const revokedBody = await expectJson<{ workflowState: string }>(revoked, 200);
  assert.equal(revokedBody.workflowState, 'REVOKED');

  const history = await get(`${f.base}/exceptions/${seriesId}/history`, 'checker-token');
  const body = (await history.json()) as { revisions: { revision: number }[] };
  assert.equal(body.revisions.length, 1);
  assert.equal(body.revisions[0]?.revision, 1);
});

test('cancel is allowed only for the maker of that request', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };
  const row = await owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, exceptionId: seriesId },
  });
  await owner.cg4CapabilityGrant.create({
    data: {
      id: randomUUID(),
      tenantId: f.primary.tenantId,
      subjectId: f.primary.maker,
      capability: 'cg.exception.amend',
      scopeKey: SCOPE_KEY,
      grantedByRef: 'iam-fixture',
    },
  });
  await owner.cg4CapabilityGrant.create({
    data: {
      id: randomUUID(),
      tenantId: f.primary.tenantId,
      subjectId: f.primary.checker,
      capability: 'cg.exception.amend',
      scopeKey: SCOPE_KEY,
      grantedByRef: 'iam-fixture',
    },
  });

  const payload = {
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    expectedVersion: 1,
    reasonCode: 'WITHDRAWN',
    evidenceRef: 'evidence://cancel',
  };
  // the checker has the capability but is not the maker — must be 404, not a 403 that confirms the resource exists
  const byChecker = await post(`${f.base}/exceptions/${seriesId}/cancel`, 'checker-token', payload);
  assert.equal(byChecker.status, 404);

  const byMaker = await post(`${f.base}/exceptions/${seriesId}/cancel`, 'maker-token', payload);
  const cancelled = await expectJson<{ workflowState: string }>(byMaker, 200);
  assert.equal(cancelled.workflowState, 'CANCELLED');
});

test('CG4.11: the additive acknowledgement query validates input and does not cross tenants', async (t) => {
  const f = await fixture(t);
  const aggregateId = randomUUID();
  await owner.cgConsumerAcknowledgement.create({
    data: {
      tenantId: f.primary.tenantId,
      eventId: randomUUID(),
      consumer: 'journey-governance-cg4',
      aggregateType: 'POLICY',
      aggregateId,
      appliedVersion: 3,
      outcome: 'APPLIED',
      affectedCount: 1,
      payloadHash: 'a'.repeat(64),
      appliedStateDigest: 'b'.repeat(64),
      appliedAt: new Date('2026-09-15T00:00:00.000Z'),
    },
  });

  const invalidType = await get(
    `${f.base}/acknowledgements?aggregateType=EXCEPTION&aggregateId=${aggregateId}`,
    'checker-token',
  );
  assert.equal(invalidType.status, 400);
  const invalidId = await get(
    `${f.base}/acknowledgements?aggregateType=POLICY&aggregateId=not-a-uuid`,
    'checker-token',
  );
  assert.equal(invalidId.status, 400);

  const own = await expectJson<{
    acknowledgements: Array<{
      consumer: string;
      appliedVersion: number;
      appliedStateDigest: string;
    }>;
  }>(
    await get(
      `${f.base}/acknowledgements?aggregateType=POLICY&aggregateId=${aggregateId}`,
      'checker-token',
    ),
    200,
  );
  assert.deepEqual(
    own.acknowledgements.map((ack) => [ack.consumer, ack.appliedVersion, ack.appliedStateDigest]),
    [['journey-governance-cg4', 3, 'b'.repeat(64)]],
  );

  const otherTenant = await expectJson<{ acknowledgements: unknown[] }>(
    await get(
      `${f.base}/acknowledgements?aggregateType=POLICY&aggregateId=${aggregateId}`,
      'other-maker-token',
    ),
    200,
  );
  assert.deepEqual(otherTenant.acknowledgements, []);
});

test('CG4.11: observability returns the own tenant snapshot/alerts/metrics without customer identifiers', async (t) => {
  const f = await fixture(t);
  await owner.cg4ScopeKillSwitch.create({
    data: {
      id: randomUUID(),
      tenantId: f.primary.tenantId,
      scopeKey: SCOPE_KEY,
      state: 'ACTIVE',
      reasonCode: 'CG4_11_OBSERVABILITY',
      evidenceRef: 'evidence://kill',
      activatedByRef: f.primary.checker,
      activatedAt: new Date(),
    },
  });

  const forbidden = await get(`${f.base}/observability`, 'maker-token');
  assert.equal(forbidden.status, 403);

  const body = await expectJson<{
    snapshot: { tenantId: string; killSwitches: { active: number } };
    alerts: Array<{ code: string }>;
    metrics: Array<{ name: string; labels: Record<string, string> }>;
  }>(await get(`${f.base}/observability`, 'checker-token'), 200);
  assert.equal(body.snapshot.tenantId, f.primary.tenantId);
  assert.equal(body.snapshot.killSwitches.active, 1);
  assert.ok(body.alerts.some((alert) => alert.code === 'GOVERNANCE_KILL_SWITCH_ACTIVE'));
  assert.ok(body.metrics.every((metric) => Object.keys(metric.labels).join() === 'tenant_id'));
  const serialized = JSON.stringify(body);
  for (const value of [
    f.primary.contactId,
    f.primary.identityId,
    f.primary.checker,
    f.other.tenantId,
  ]) {
    assert.equal(serialized.includes(value), false, value);
  }
});

// ---- CG4.11+: tenant-wide exception queue (#179 decision gap) -------------

async function seedQueueSeries(
  tenant: TenantFixture,
  overrides: { tier?: string; expiresAt?: string; status?: string } = {},
): Promise<string> {
  const exceptionId = randomUUID();
  const revisionId = randomUUID();
  const status = overrides.status ?? 'PENDING';
  await owner.cg4Exception.create({
    data: {
      id: revisionId,
      tenantId: tenant.tenantId,
      exceptionId,
      revision: 1,
      contactId: tenant.contactId,
      scopeKind: 'CONTACT_WIDE',
      channel: 'VOICE',
      purpose: 'SERVICE_NOTIFICATION',
      sourceType: 'DIALER',
      sourceId: 'source-queue',
      allowedRuleCodes: ['QUIET_HOURS'],
      policyId: tenant.policyId,
      policyVersion: 1,
      policyContentDigest: DIGEST,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      startsAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date(overrides.expiresAt ?? '2026-09-20T00:00:00.000Z'),
      tier: (overrides.tier ?? 'STANDARD') as never,
      status: status as never,
      reasonCode: 'OPERATIONAL',
      evidenceRef: 'evidence:queue',
      actorRef: 'maker-queue',
      requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    },
  });
  await owner.cg4ExceptionHead.create({
    data: {
      id: randomUUID(),
      tenantId: tenant.tenantId,
      exceptionId,
      currentRevisionId: revisionId,
      currentRevision: 1,
      status: status as never,
    },
  });
  return exceptionId;
}

test('CG4.11+: GET /exceptions is a tenant-level queue, cross-tenant is empty not 403, records evidence access per item', async (t) => {
  const f = await fixture(t);
  const mine = await seedQueueSeries(f.primary, { tier: 'EMERGENCY' });
  await seedQueueSeries(f.other, { tier: 'EMERGENCY' });

  const mineOnly = await expectJson<{ items: Array<{ seriesId: string }> }>(
    await get(`${f.base}/exceptions`, 'checker-token'),
    200,
  );
  assert.deepEqual(
    mineOnly.items.map((item) => item.seriesId),
    [mine],
  );
  assert.ok(
    f.evidenceReads.some((read) => read.resourceKind === 'EXCEPTION' && read.level === 'EVIDENCE'),
  );

  // another tenant sees only its own (empty if none, not a 403 or seeing our tenant)
  const otherView = await expectJson<{ items: Array<{ seriesId: string }> }>(
    await get(`${f.base}/exceptions`, 'other-maker-token'),
    200,
  );
  assert.equal(
    otherView.items.some((item) => item.seriesId === mine),
    false,
  );
});

test('CG4.11+: GET /exceptions rejects a filter of the wrong type and an out-of-range limit', async (t) => {
  const f = await fixture(t);
  for (const query of [
    'riskTier=URGENT',
    'workflowState=DONE',
    'channel=SMS',
    'limit=0',
    'limit=201',
  ]) {
    const response = await get(`${f.base}/exceptions?${query}`, 'checker-token');
    assert.equal(response.status, 400, query);
    assert.equal(((await response.json()) as { code: string }).code, 'VALIDATION_FAILED');
  }
});

/**
 * GET with If-None-Match: checks whether the validator the client holds still matches the current body
 * must send `cache-control` itself — otherwise the Fetch spec (undici) adds `Cache-Control: no-cache` when
 * If-None-Match is present, which Express treats as a non-fresh request and always answers 200, so 304 could not be tested
 */
function conditionalGet(url: string, token: string, etag: string) {
  return fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      'if-none-match': etag,
      'cache-control': 'max-age=0',
    },
  });
}

test('#673: the exception ETag changes when the status changes — a client holding the old ETag must not get 304', async (t) => {
  const f = await fixture(t);
  const created = await post(`${f.base}/exceptions`, 'maker-token', exceptionRequest(f));
  const { seriesId } = (await created.json()) as { seriesId: string };
  const url = `${f.base}/exceptions/${seriesId}`;

  const before = await get(url, 'checker-token');
  const pendingEtag = before.headers.get('etag');
  assert.ok(pendingEtag);
  assert.equal(((await before.json()) as { workflowState: string }).workflowState, 'PENDING');
  // the validator still works: nothing changed gives 304
  assert.equal((await conditionalGet(url, 'checker-token', pendingEtag)).status, 304);

  const row = await owner.cg4Exception.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, exceptionId: seriesId },
  });
  const approved = await post(`${f.base}/exceptions/${seriesId}/approvals`, 'checker-token', {
    decision: 'APPROVE',
    expectedRevision: 1,
    expectedContentDigest: row.requestHash,
    expectedVersion: 1,
    evidenceRef: 'evidence://approval',
  });
  assert.equal(approved.status, 200);

  const after = await conditionalGet(url, 'checker-token', pendingEtag);
  assert.equal(after.status, 200, 'the old ETag must not match a body whose status has changed');
  const approvedEtag = after.headers.get('etag');
  assert.ok(approvedEtag);
  assert.notEqual(approvedEtag, pendingEtag);
  assert.match(approvedEtag, new RegExp(`^"cg4-exception:${seriesId}:1:`));
  assert.equal(((await after.json()) as { workflowState: string }).workflowState, 'APPROVED');
  assert.equal((await conditionalGet(url, 'checker-token', approvedEtag)).status, 304);

  // the same body = the same ETag, whether read via detail or the contact listing
  const listing = (await (
    await get(`${f.base}/contacts/${f.primary.contactId}/exceptions`, 'checker-token')
  ).json()) as { exceptions: Array<{ seriesId: string; etag: string }> };
  assert.equal(listing.exceptions.find((item) => item.seriesId === seriesId)?.etag, approvedEtag);

  // readers who see evidence at different levels get different bodies, so they must get different ETags
  const reader = await get(url, 'reader-token');
  assert.notEqual(reader.headers.get('etag'), approvedEtag);
});

test('#673: the ETags of a policy version and scope head change with the lifecycle and kill switch', async (t) => {
  const f = await fixture(t);
  await owner.cg4Policy.deleteMany({ where: { tenantId: f.primary.tenantId } });

  const draft = await expectJson<{
    policyVersionId: string;
    contentDigest: string;
    draftRevision: number;
  }>(
    await post(`${f.base}/policies`, 'maker-token', {
      scope: { channel: 'VOICE', purpose: 'SERVICE_NOTIFICATION' },
      content: POLICY_CONTENT,
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      evidenceRef: 'evidence://policy',
    }),
    201,
  );
  const versionUrl = `${f.base}/policy-versions/${draft.policyVersionId}`;
  const etags: string[] = [];
  const readVersionEtag = async (staleEtag?: string) => {
    const response = staleEtag
      ? await conditionalGet(versionUrl, 'checker-token', staleEtag)
      : await get(versionUrl, 'checker-token');
    assert.equal(response.status, 200, 'the old ETag must not match a lifecycle that has changed');
    const etag = response.headers.get('etag');
    assert.ok(etag);
    etags.push(etag);
    return etag;
  };
  const draftEtag = await readVersionEtag();
  assert.equal((await conditionalGet(versionUrl, 'checker-token', draftEtag)).status, 304);

  const artifact = await expectJson<{
    artifactDigest: string;
    baseHeadVersion: number;
    baseHeadDigest: string;
  }>(
    await post(`${versionUrl}/tests`, 'maker-token', {
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: '2026-01-05T00:00:00.000Z',
      pinnedTimezone: 'Asia/Bangkok',
      evidenceRef: 'evidence://tests',
    }),
    201,
  );
  await expectJson(
    await post(`${versionUrl}/submit`, 'maker-token', {
      expectedDraftRevision: draft.draftRevision,
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      evidenceRef: 'evidence://submit',
    }),
    200,
  );
  const submittedEtag = await readVersionEtag(draftEtag);

  await expectJson(
    await post(`${versionUrl}/approvals`, 'checker-token', {
      decision: 'APPROVE',
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      expectedScopeHeadVersion: artifact.baseHeadVersion,
      expectedScopeHeadDigest: artifact.baseHeadDigest,
      activateAt: '2026-01-05T00:00:00.000Z',
      evidenceRef: 'evidence://approval',
    }),
    200,
  );
  await readVersionEtag(submittedEtag);

  const row = await owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: f.primary.tenantId, id: draft.policyVersionId },
  });
  const published = await expectJson<{ scopeKey: string }>(
    await post(`${versionUrl}/publish`, 'checker-token', {
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: artifact.artifactDigest,
      expectedApprovalDigest: row.approvalDigest,
      expectedScopeHeadVersion: artifact.baseHeadVersion,
      expectedScopeHeadDigest: artifact.baseHeadDigest,
      evidenceRef: 'evidence://publish',
    }),
    200,
  );
  await readVersionEtag(etags[etags.length - 1]);
  assert.equal(
    new Set(etags).size,
    etags.length,
    'every policy version status must have a different ETag',
  );

  // scope head: the kill switch comes from another table so headVersion does not change, but the body does
  const scopeUrl = `${f.base}/policy-scopes/${encodeURIComponent(published.scopeKey)}/effective`;
  const scopeBefore = await get(scopeUrl, 'checker-token');
  const scopeEtag = scopeBefore.headers.get('etag');
  assert.ok(scopeEtag);
  assert.equal(
    ((await scopeBefore.json()) as { killSwitchActive: boolean }).killSwitchActive,
    false,
  );
  assert.equal((await conditionalGet(scopeUrl, 'checker-token', scopeEtag)).status, 304);

  const activated = await post(`${f.base}/kill-switches`, 'checker-token', {
    scopeKey: published.scopeKey,
    reasonCode: 'INCIDENT',
    evidenceRef: 'evidence://kill',
  });
  assert.equal(activated.status, 201);
  const scopeAfter = await conditionalGet(scopeUrl, 'checker-token', scopeEtag);
  assert.equal(scopeAfter.status, 200, 'an opened kill switch must not be hidden by a 304');
  assert.notEqual(scopeAfter.headers.get('etag'), scopeEtag);
  assert.equal(((await scopeAfter.json()) as { killSwitchActive: boolean }).killSwitchActive, true);
});
