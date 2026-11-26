import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { OidcAccessTokenVerifier } from '@d-contact/workspace-session';
import type { PrismaClient } from '@d-contact/db';
import { assertSegmentMembershipChangeEnvelope } from '@d-contact/cxa-contracts';
import { C360SegmentMembershipRelay, C360SegmentRuntime } from '@d-contact/customer-360';
import type { DcProducer } from '@d-contact/kafka';
import { setup } from './customer-360-test-fixtures.js';
import { Customer360WorkController, CUSTOMER_360_WORK_AUTH } from './customer-360-work-api.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { Customer360ReadController } from './customer-360-read-api.js';
import { Customer360ImportController } from './customer-360-import-api.js';
import { CUSTOMER_360_DATABASE } from './customer-360-api.js';
import { OIDC_ACCESS_TOKEN_VERIFIER } from './gateway-auth.js';
import { C360WorkAuthService } from './customer-360-work-auth.js';
import { WorkSessionLeases } from './work-session.js';
import {
  TeamSegmentScopeController,
  TEAM_SEGMENT_SCOPE_DATABASE,
} from './team-segment-scope-api.js';

/**
 * #911: a customer created through HTTP (CSV import and create) → system segment → outbox/relay →
 * IAM projection → an Agent finds them through the real work API, on PostgreSQL with the application role
 * Kafka is replaced by a producer that sends the envelope into the same handler as the IAM consumer (not a real broker)
 */

const PHONE_IMPORTED = '+66812345678';
const PHONE_CREATED = '+66898765432';

async function fixture() {
  let service!: C360WorkAuthService;
  const f = await setup(
    [
      Customer360WorkController,
      Customer360OperatorController,
      Customer360ReadController,
      Customer360ImportController,
      TeamSegmentScopeController,
    ],
    undefined,
    undefined,
    [
      // #915: an Admin grants WORK over HTTP with the same application role as Cus360
      { provide: TEAM_SEGMENT_SCOPE_DATABASE, useExisting: CUSTOMER_360_DATABASE },
      {
        provide: CUSTOMER_360_WORK_AUTH,
        inject: [CUSTOMER_360_DATABASE, OIDC_ACCESS_TOKEN_VERIFIER],
        useFactory: (db: PrismaClient, verifier: OidcAccessTokenVerifier) => {
          service = new C360WorkAuthService(db, verifier, {
            introspect: async () => ({ active: true }),
          });
          return service;
        },
      },
    ],
  );
  const agent = f.actors.get('agent')!;
  const lease = await new WorkSessionLeases(f.db).acquire(
    { tenantId: f.tenantId, userId: agent.id },
    { surface: 'workspace', hostOrigin: null },
    'segment-runtime-fixture',
  );
  const interactionId = randomUUID();
  await f.owner.interaction.create({
    data: {
      id: interactionId,
      tenantId: f.tenantId,
      agentId: agent.id,
      channel: 'VOICE',
      direction: 'INBOUND',
      state: 'ACTIVE',
    },
  });
  await service.reauthenticate({ accessToken: 'agent', leaseId: lease.leaseId });
  const work = async (path: string, body: unknown, token = 'agent') => {
    const response = await fetch(`${f.base}/api/v1/customer-360/work/${interactionId}/${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-work-session-lease-id': lease.leaseId,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const search = (phone: string, token = 'agent') =>
    work('candidates/search', { type: 'PHONE', query: phone }, token);

  // Kafka is replaced by a producer that records the envelope; drain sends it into the same handler as the IAM consumer
  const sent: unknown[] = [];
  const producer: DcProducer = {
    async send(_topic, event) {
      sent.push(event);
    },
    async disconnect() {},
  };
  const relay = new C360SegmentMembershipRelay(f.db, producer);
  const runtime = new C360SegmentRuntime(f.db, f.segments, f.memberships);
  const project = async () => {
    const before = sent.length;
    while (await relay.publishNext(f.tenantId));
    for (const event of sent.slice(before)) {
      const envelope = assertSegmentMembershipChangeEnvelope(event);
      await f.scopes.applyMembershipChange({
        tenantId: envelope.tenantId,
        eventId: envelope.eventId,
        occurredAt: envelope.occurredAt,
        consumerGroup: 'iam-segment-projection-911',
        payload: envelope.payload,
      });
    }
    return sent.slice(before).map((event) => {
      const payload = assertSegmentMembershipChangeEnvelope(event).payload;
      return `${payload.segmentId}:${payload.changeKind}`;
    });
  };
  const heads = async (contactId: string) =>
    Object.fromEntries(
      (
        await f.owner.c360SegmentMembershipHead.findMany({
          where: { tenantId: f.tenantId, contactId },
          select: { segmentId: true, state: true },
        })
      ).map((head) => [head.segmentId, head.state]),
    );
  return { ...f, work, search, runtime, project, heads, interactionId };
}

async function allowCreate(f: Awaited<ReturnType<typeof fixture>>) {
  const grant = await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-911',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  assert.equal(grant.status, 201);
}

async function importCsv(f: Awaited<ReturnType<typeof fixture>>, csv: string) {
  const post = async (path: string, fields: Record<string, string>) => {
    const form = new FormData();
    form.set(
      'mapping',
      JSON.stringify({ version: 1, columns: { displayName: 'name', phone: 'phone' } }),
    );
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set('file', new Blob([csv], { type: 'text/csv' }), 'import.csv');
    const response = await fetch(`${f.base}/api/v1/customer-360/imports/${path}`, {
      method: 'POST',
      headers: { authorization: 'Bearer admin' },
      body: form,
    });
    return (await response.json()) as Record<string, any>;
  };
  const preview = await post('preview', {});
  const done = await post('confirm', { commandId: randomUUID(), planHash: preview.planHash });
  assert.equal(done.state, 'COMPLETED');
  return done.rows[0].contactId as string;
}

test('#911: a customer who is imported/newly created enters the system segment, then an Agent of the team that has WORK finds them and can select them on a call', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  const imported = await importCsv(f, `name,phone\nImported customer,${PHONE_IMPORTED}\n`);
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'VIP customer',
    vip: true,
    points: [{ kind: 'PHONE', value: PHONE_CREATED }],
  });
  assert.equal(created.status, 201);
  const vipId = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command.resourceRefs.find((ref) => ref.type === 'CONTACT')!.id;

  // before the runtime runs: no membership and the Agent does not see them
  assert.deepEqual(await f.heads(imported), {});
  assert.equal((await f.search(PHONE_IMPORTED)).body.items?.length ?? 0, 0);

  const first = await f.runtime.evaluatePending(f.tenantId);
  assert.ok(first.contacts >= 2);
  assert.deepEqual(await f.heads(imported), { 'system:all-customers': 'IN', 'system:vip': 'OUT' });
  assert.deepEqual(await f.heads(vipId), { 'system:all-customers': 'IN', 'system:vip': 'IN' });
  // evaluating again leaves no pending work
  assert.equal((await f.runtime.evaluatePending(f.tenantId)).contacts, 0);

  const events = await f.project();
  assert.ok(events.includes('system:all-customers:ENTERED'));
  assert.ok(events.includes('system:vip:ENTERED'));
  assert.equal(events.filter((event) => event === 'system:vip:ENTERED').length, 1);

  // membership alone grants no permission: a team without WORK does not find them
  assert.equal((await f.search(PHONE_IMPORTED)).body.items?.length ?? 0, 0);

  await f.scopes.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: 'system:all-customers',
    permission: 'WORK',
    correlationId: 'grant-911-work',
  });
  const found = await f.search(PHONE_IMPORTED);
  assert.equal(found.status, 201);
  assert.equal(found.body.items.length, 1);
  assert.equal(found.body.items[0].displayName, 'Imported customer');
  const linked = await f.work('customer-link', {
    commandId: randomUUID(),
    expectedLinkageRevision: '0',
    candidateRef: found.body.items[0].candidateRef,
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.command.outcome, 'APPLIED');
  // another tenant cannot use this work
  assert.notEqual((await f.search(PHONE_IMPORTED, 'foreign')).status, 201);
  assert.equal(
    await f.owner.c360SegmentMembershipHead.count({ where: { tenantId: f.otherTenantId } }),
    0,
  );
});

test('#915: an Admin grants and revokes WORK on a system segment over HTTP, and the Agent finds and does not find accordingly', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  await importCsv(f, `name,phone\nImported customer,${PHONE_IMPORTED}\n`);
  await f.runtime.evaluatePending(f.tenantId);
  await f.project();
  type ScopeBody = {
    outcome: string;
    grantId: string;
    scopes: { permission: string; grantId: string }[];
  };
  const path = 'tenant/team-segment-scopes';
  const call = async (token: string, body?: unknown, query = '') => {
    const response = await f.request(`${path}${query}`, token, body);
    return { status: response.status, body: response.body as unknown as ScopeBody };
  };
  const scope = { teamId: f.teamId, segmentId: 'system:all-customers' };

  // an unsupported permission and other roles are rejected, without extending permission to a supervisor/agent
  assert.equal((await call('admin', { ...scope, permission: 'CONTACT' })).status, 400);
  assert.equal((await call('supervisor', { ...scope, permission: 'WORK' })).status, 403);
  assert.equal((await call('agent', { ...scope, permission: 'WORK' })).status, 403);
  // VIEW (the original default) does not let an Agent search customers in work
  const view = await call('admin', scope);
  assert.equal(view.status, 201);
  assert.equal((await f.search(PHONE_IMPORTED)).body.items?.length ?? 0, 0);

  const work = await call('admin', { ...scope, permission: 'WORK' });
  assert.equal(work.status, 201);
  assert.equal(work.body.outcome, 'GRANTED');
  const again = await call('admin', { ...scope, permission: 'WORK' });
  assert.equal(again.body.outcome, 'DUPLICATE');
  assert.equal(again.body.grantId, work.body.grantId);

  assert.deepEqual(
    (await call('admin')).body.scopes.map((row) => `${row.permission}:${row.grantId}`).sort(),
    [`VIEW:${view.body.grantId}`, `WORK:${work.body.grantId}`].sort(),
  );
  assert.deepEqual(
    (await call('admin', undefined, '?permission=VIEW')).body.scopes.map((row) => row.grantId),
    [view.body.grantId],
  );

  const found = await f.search(PHONE_IMPORTED);
  assert.equal(found.status, 201);
  assert.equal(found.body.items.length, 1);

  const revoked = await fetch(`${f.base}/api/v1/${path}/${work.body.grantId}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
    body: JSON.stringify({ reasonCode: 'Team move' }),
  });
  assert.equal(revoked.status, 204);
  assert.equal((await f.search(PHONE_IMPORTED)).body.items?.length ?? 0, 0);
});

test('#911: editing vip makes VIP membership follow, and evaluating again creates no duplicate event', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  const contactId = await importCsv(f, `name,phone\nNot VIP yet,${PHONE_IMPORTED}\n`);
  await f.runtime.evaluatePending(f.tenantId);
  await f.project();
  assert.equal((await f.heads(contactId))['system:vip'], 'OUT');

  const profile = await f.request(`customer-360/contacts/${contactId}`, 'admin');
  const revisions = (profile.body as unknown as { revisions: { profile: string; lineage: number } })
    .revisions;
  const patch = await f.request(
    `customer-360/contacts/${contactId}`,
    'admin',
    {
      commandId: randomUUID(),
      expectedProfileRevision: revisions.profile,
      expectedLineageRevision: String(revisions.lineage),
      displayName: 'Now VIP',
      company: null,
      vip: true,
    },
    'PATCH',
  );
  assert.equal(patch.status, 200);
  const result = await f.runtime.evaluatePending(f.tenantId);
  assert.equal(result.snapshots, 1);
  assert.equal((await f.heads(contactId))['system:vip'], 'IN');
  // a new snapshot still in "all customers" leaves with CORRECTED per the original commitEvaluation contract
  // (the state is still IN and does not affect permission) while VIP enters the segment as ENTERED
  assert.deepEqual((await f.project()).sort(), [
    'system:all-customers:CORRECTED',
    'system:vip:ENTERED',
  ]);
  assert.equal((await f.heads(contactId))['system:all-customers'], 'IN');
  // nothing changed: no work and no new event
  assert.equal((await f.runtime.evaluatePending(f.tenantId)).contacts, 0);
  assert.deepEqual(await f.project(), []);
});
