/**
 * J3.8 (#219) — sanitized query API of the segment membership stream
 *
 * covers what acceptance requires: generic cross-tenant `404 RESOURCE_NOT_FOUND`,
 * ETag/If-None-Match, and a response with no payload/digest/PII leaking out
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { JourneySegmentReceiptRepository } from '@d-contact/journey';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import {
  JOURNEY_SEGMENT_DATABASE,
  JourneySegmentRecoveryController,
} from './journey-segment-recovery-api.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const HASH = 'a'.repeat(64);

async function harness(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const adminUserId = randomUUID();
  const contactId = randomUUID();
  const otherContactId = randomUUID();
  const segmentId = `segment-gold-${tenantId.slice(0, 8)}`;

  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: {
        id,
        name: `J3.8 query ${id.slice(0, 8)}`,
        slug: `j3-8-query-${id.slice(0, 8)}`,
        sipDomain: `${id.slice(0, 8)}.j3-8-query.test`,
      },
    });
  }
  await owner.contact.create({ data: { id: contactId, tenantId } });
  await owner.contact.create({ data: { id: otherContactId, tenantId: otherTenantId } });

  const claims = (roles: string[], tenant: string): VerifiedOidcClaims => ({
    tenant_id: tenant,
    tenant_slug: `j3-8-query-${tenant.slice(0, 8)}`,
    organization: { [`j3-8-query-${tenant.slice(0, 8)}`]: { tenant_id: [tenant] } },
    azp: 'agent-desktop',
    sub: adminUserId,
    preferred_username: 'admin-user',
    exp: 2_000_000_000,
    realm_access: { roles },
    dc_user_id: adminUserId,
    sid: 'admin-session',
  });
  const verifier = {
    verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
      if (token === 'admin-token') return claims(['admin'], tenantId);
      if (token === 'agent-token') return claims(['agent'], tenantId);
      if (token === 'other-tenant-admin') return claims(['admin'], otherTenantId);
      throw new Error('invalid token');
    },
  };

  @Module({
    controllers: [JourneySegmentRecoveryController],
    providers: [
      { provide: JOURNEY_SEGMENT_DATABASE, useValue: application },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const port = (app.getHttpServer().address() as AddressInfo).port;

  t.after(async () => {
    await app.close();
    for (const id of [tenantId, otherTenantId]) {
      await owner.jrRecoveryAudit.deleteMany({ where: { tenantId: id } });
      await owner.jrSegmentOutbox.deleteMany({ where: { tenantId: id } });
      await owner.jrSegmentRefilterCursor.deleteMany({ where: { tenantId: id } });
      await owner.jrEnrollment.deleteMany({ where: { tenantId: id } });
      await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId: id } });
      await owner.jrSegmentHead.deleteMany({ where: { tenantId: id } });
      await owner.jrSegmentReceipt.deleteMany({ where: { tenantId: id } });
      await owner.contact.deleteMany({ where: { tenantId: id } });
      await owner.tenant.deleteMany({ where: { id } });
    }
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const receipts = new JourneySegmentReceiptRepository(application);

  /** creates a real stream through the repository — without stuffing rows straight into the database */
  async function seedStream(tenant: string, contact: string, revision = 1) {
    const entryId = `entry-${tenant.slice(0, 8)}`;
    const received = await receipts.ingest({
      tenantId: tenant,
      source: 'CUSTOMER_360',
      eventId: `event-${randomUUID()}`,
      contactId: contact,
      segmentId,
      membershipRevision: revision,
      changeKind: 'ENTERED',
      entryId,
      segmentDefinitionVersion: 1,
      payloadHash: HASH,
      correlationId: `corr-${tenant.slice(0, 8)}`,
    });
    await receipts.applyEnrollment(
      {
        tenantId: tenant,
        receiptId: received.receipt.id,
        entryId,
        canonicalContactId: contact,
        intents: [
          {
            journeyId: randomUUID(),
            journeyVersion: 1,
            entryStepId: 'send',
            reasonMembershipRevision: revision,
            reasonDefinitionVersion: 1,
            reasonDigest: HASH,
          },
        ],
        correlationId: `corr-${tenant.slice(0, 8)}`,
      },
      {
        eventType: 'journey.segment_entry.recorded',
        orderingKey: `${contact}:${segmentId}`,
        payload: { contractVersion: 1, secretBusinessField: 'must not leak out of the API' },
        payloadHash: HASH,
      },
    );
    return entryId;
  }

  const call = (path: string, token: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/internal/journey/segment-streams/${path}`, {
      headers: { authorization: `Bearer ${token}`, ...headers },
    });

  const post = (
    path: string,
    token: string,
    init: { idempotencyKey?: string; body?: unknown } = {},
  ) =>
    fetch(`http://127.0.0.1:${port}/internal/journey/segment-streams/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(init.idempotencyKey ? { 'idempotency-key': init.idempotencyKey } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });

  return {
    owner,
    application,
    receipts,
    tenantId,
    otherTenantId,
    contactId,
    otherContactId,
    segmentId,
    seedStream,
    call,
    post,
  };
}

test('returns the own tenant stream with an ETag and no payload leaking out', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId);

  const response = await h.call(`${h.contactId}/${h.segmentId}`, 'admin-token');
  assert.equal(response.status, 200);
  const etag = response.headers.get('etag');
  assert.ok(etag);
  assert.match(etag, /^"jr-segment:1:\d+"$/);

  const view = (await response.json()) as Record<string, unknown>;
  assert.equal(view.lastAppliedRevision, 1);
  assert.equal((view.receipts as unknown[]).length, 1);
  assert.equal((view.enrollments as unknown[]).length, 1);
  assert.deepEqual(view.gaps, []);

  // the forensic API must not expose anything that is not identity/state
  const wire = JSON.stringify(view);
  for (const forbidden of [
    'secretBusinessField',
    'payload',
    'payloadHash',
    'reasonDigest',
    'stateDigest',
    HASH,
  ]) {
    assert.doesNotMatch(wire, new RegExp(forbidden), `${forbidden} must not leave through the API`);
  }
});

test('an If-None-Match that matches the ETag gets 304 without sending a body', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId);

  const first = await h.call(`${h.contactId}/${h.segmentId}`, 'admin-token');
  const etag = first.headers.get('etag') ?? '';

  const cached = await h.call(`${h.contactId}/${h.segmentId}`, 'admin-token', {
    'if-none-match': etag,
  });
  assert.equal(cached.status, 304);
  assert.equal((await cached.text()).trim(), '');

  // a non-matching ETag must get the full body
  const stale = await h.call(`${h.contactId}/${h.segmentId}`, 'admin-token', {
    'if-none-match': '"jr-segment:0:0"',
  });
  assert.equal(stale.status, 200);
});

test("another tenant's stream is indistinguishable from a stream that never existed", async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId);
  await h.seedStream(h.otherTenantId, h.otherContactId);

  /**
   * all three cases must get exactly the same answer, otherwise the caller could probe which contact/segment
   * exists in another tenant
   */
  const cases: Array<[string, string]> = [
    ['stream of another tenant', `${h.otherContactId}/${h.segmentId}`],
    ['contact that does not exist', `${randomUUID()}/${h.segmentId}`],
    ['segment that does not exist', `${h.contactId}/segment-does-not-exist`],
  ];
  const bodies = new Set<string>();
  for (const [label, path] of cases) {
    const response = await h.call(path, 'admin-token');
    assert.equal(response.status, 404, label);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, 'RESOURCE_NOT_FOUND', label);
    bodies.add(JSON.stringify(body));
  }
  assert.equal(bodies.size, 1, 'every case must answer identically character for character');
});

test('a role that is not admin/compliance cannot enter', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId);

  const response = await h.call(`${h.contactId}/${h.segmentId}`, 'agent-token');
  assert.equal(response.status, 403);
});

test('a gap in the stream is reported so the operator sees it', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId, 1);
  // revision 3 arrived without 2 ever arriving — a hole the operator must chase
  await h.seedStream(h.tenantId, h.contactId, 3);

  const response = await h.call(`${h.contactId}/${h.segmentId}`, 'admin-token');
  const view = (await response.json()) as { gaps: number[]; receipts: unknown[] };
  assert.deepEqual(view.gaps, [2]);
  assert.equal(view.receipts.length, 2);
});

/** pushes a receipt into the REVIEW state and returns the eventId and version the operator will see */
async function reviewedReceipt(h: Awaited<ReturnType<typeof harness>>) {
  const entryId = `entry-${h.tenantId.slice(0, 8)}`;
  const received = await h.receipts.ingest({
    tenantId: h.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: h.contactId,
    segmentId: h.segmentId,
    membershipRevision: 9,
    changeKind: 'ENTERED',
    entryId,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: 'corr-review',
  });
  await h.receipts.markReview(h.tenantId, received.receipt.id, 'IDENTITY_AMBIGUOUS');
  const row = await h.owner.jrSegmentReceipt.findUniqueOrThrow({
    where: { id: received.receipt.id },
  });
  return { eventId: row.eventId, version: row.version, id: row.id };
}

test('REPLAY returns a queued receipt with the original identity and records an audit', async (t) => {
  const h = await harness(t);
  const target = await reviewedReceipt(h);
  const before = await h.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: target.id } });

  const response = await h.post(`receipts/${target.eventId}/replay`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: target.version, reasonCode: 'OPERATOR_REPLAY' },
  });
  assert.equal(response.status, 201);
  const result = (await response.json()) as { state: string; version: number };
  assert.equal(result.state, 'READY');
  assert.equal(result.version, target.version + 1);

  // the original identity must be untouched
  const after = await h.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: target.id } });
  assert.equal(after.eventId, before.eventId);
  assert.equal(after.membershipRevision, before.membershipRevision);
  assert.equal(after.entryId, before.entryId);
  assert.equal(after.payloadHash, before.payloadHash);

  const audit = await h.owner.jrRecoveryAudit.findFirstOrThrow({
    where: { tenantId: h.tenantId, targetRef: target.eventId },
  });
  assert.equal(audit.operation, 'REPLAY');
  assert.equal(audit.targetKind, 'SEGMENT_RECEIPT');
  assert.equal(audit.reasonCode, 'OPERATOR_REPLAY');
});

test('a blind retry with an old version is rejected as 409 and changes nothing', async (t) => {
  const h = await harness(t);
  const target = await reviewedReceipt(h);

  const first = await h.post(`receipts/${target.eventId}/replay`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: target.version, reasonCode: 'OPERATOR_REPLAY' },
  });
  assert.equal(first.status, 201);

  // a second operator still holds the old screen
  const stale = await h.post(`receipts/${target.eventId}/replay`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: target.version, reasonCode: 'OPERATOR_REPLAY' },
  });
  assert.equal(stale.status, 409);
  const conflict = (await stale.json()) as { code: string; actualVersion: number };
  assert.equal(conflict.code, 'VERSION_CONFLICT');
  assert.equal(conflict.actualVersion, target.version + 1);
  assert.equal(
    await h.owner.jrRecoveryAudit.count({ where: { tenantId: h.tenantId } }),
    1,
    'a rejected command must not be recorded as an audit',
  );
});

test('recovery accepts no replacement payload, and enforces Idempotency-Key and reasonCode', async (t) => {
  const h = await harness(t);
  const target = await reviewedReceipt(h);

  const cases: Array<[string, { idempotencyKey?: string; body: unknown }]> = [
    ['missing Idempotency-Key', { body: { expectedVersion: 1, reasonCode: 'X_REPLAY' } }],
    [
      'reasonCode is free text',
      {
        idempotencyKey: randomUUID(),
        body: { expectedVersion: 1, reasonCode: 'Customer called to complain' },
      },
    ],
    ['missing expectedVersion', { idempotencyKey: randomUUID(), body: { reasonCode: 'X_REPLAY' } }],
    [
      'attaches a replacement payload',
      {
        idempotencyKey: randomUUID(),
        body: {
          expectedVersion: 1,
          reasonCode: 'X_REPLAY',
          payload: { membershipRevision: 99, contactId: 'fake' },
        },
      },
    ],
  ];

  for (const [label, init] of cases) {
    const response = await h.post(`receipts/${target.eventId}/replay`, 'admin-token', init);
    assert.equal(response.status, 400, label);
    assert.equal(((await response.json()) as { code: string }).code, 'VALIDATION_FAILED', label);
  }
  assert.equal(await h.owner.jrRecoveryAudit.count({ where: { tenantId: h.tenantId } }), 0);
});

test('a receipt that is already APPLIED cannot be replayed — the effect has happened', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId);
  const applied = await h.owner.jrSegmentReceipt.findFirstOrThrow({
    where: { tenantId: h.tenantId, state: 'APPLIED' },
  });

  const response = await h.post(`receipts/${applied.eventId}/replay`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: applied.version, reasonCode: 'OPERATOR_REPLAY' },
  });
  assert.equal(response.status, 409);
  assert.equal(((await response.json()) as { code: string }).code, 'RECOVERY_NOT_ALLOWED');
});

test('cross-tenant recovery is indistinguishable from a target that never existed', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.otherTenantId, h.otherContactId);
  const foreign = await h.owner.jrSegmentReceipt.findFirstOrThrow({
    where: { tenantId: h.otherTenantId },
  });

  const bodies = new Set<string>();
  for (const eventId of [foreign.eventId, `event-${randomUUID()}`]) {
    const response = await h.post(`receipts/${eventId}/replay`, 'admin-token', {
      idempotencyKey: randomUUID(),
      body: { expectedVersion: 1, reasonCode: 'OPERATOR_REPLAY' },
    });
    assert.equal(response.status, 404);
    bodies.add(await response.text());
  }
  assert.equal(bodies.size, 1, 'both cases must answer identically character for character');
});

test('REVALIDATE wakes a parked re-filter job, but cannot wake a finished job', async (t) => {
  const h = await harness(t);
  const entryId = `entry-${h.tenantId.slice(0, 8)}`;
  const received = await h.receipts.ingest({
    tenantId: h.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: h.contactId,
    segmentId: h.segmentId,
    membershipRevision: 5,
    changeKind: 'CORRECTED',
    entryId,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: 'corr-refilter',
  });
  await h.receipts.applyRefilter(
    {
      tenantId: h.tenantId,
      receiptId: received.receipt.id,
      reasonCode: 'CORRECTED',
      correlationId: 'corr-refilter',
    },
    {
      eventType: 'journey.segment_entry.recorded',
      orderingKey: `${h.contactId}:${h.segmentId}`,
      payload: { contractVersion: 1 },
      payloadHash: HASH,
    },
  );
  const cursor = await h.owner.jrSegmentRefilterCursor.findFirstOrThrow({
    where: { tenantId: h.tenantId },
  });

  const ok = await h.post(`refilters/${cursor.id}/revalidate`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: cursor.version, reasonCode: 'OPERATOR_REVALIDATE' },
  });
  assert.equal(ok.status, 201);
  assert.equal(((await ok.json()) as { state: string }).state, 'PENDING');

  // a closed job cannot be woken — do not revive cancelled work
  const settled = await h.receipts.settleRefilter(
    h.tenantId,
    cursor.id,
    'CANCELLED',
    'SEGMENT_ENTRY_NOT_ELIGIBLE',
  );
  const denied = await h.post(`refilters/${cursor.id}/revalidate`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: settled.version, reasonCode: 'OPERATOR_REVALIDATE' },
  });
  assert.equal(denied.status, 409);
  assert.equal(((await denied.json()) as { code: string }).code, 'RECOVERY_NOT_ALLOWED');
});
