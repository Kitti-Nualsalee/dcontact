/**
 * J3.8 (#219) — sanitized query API ของ segment membership stream
 *
 * ครอบสิ่งที่ acceptance บังคับ: generic cross-tenant `404 RESOURCE_NOT_FOUND`,
 * ETag/If-None-Match, และ response ที่ไม่มี payload/digest/PII หลุดออกไป
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
      throw new Error('token ไม่ถูกต้อง');
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

  /** สร้าง stream จริงผ่าน repository — ไม่ยัดแถวเข้าฐานข้อมูลตรง ๆ */
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
        payload: { contractVersion: 1, secretBusinessField: 'ห้ามหลุดออก API' },
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

test('คืน stream ของ tenant ตัวเองพร้อม ETag และไม่มี payload หลุดออกไป', async (t) => {
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

  // forensic API ต้องไม่เปิดสิ่งที่ไม่ใช่ identity/state
  const wire = JSON.stringify(view);
  for (const forbidden of [
    'secretBusinessField',
    'payload',
    'payloadHash',
    'reasonDigest',
    'stateDigest',
    HASH,
  ]) {
    assert.doesNotMatch(wire, new RegExp(forbidden), `${forbidden} ต้องไม่ออกทาง API`);
  }
});

test('If-None-Match ที่ตรงกับ ETag ได้ 304 โดยไม่ส่ง body', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId);

  const first = await h.call(`${h.contactId}/${h.segmentId}`, 'admin-token');
  const etag = first.headers.get('etag') ?? '';

  const cached = await h.call(`${h.contactId}/${h.segmentId}`, 'admin-token', {
    'if-none-match': etag,
  });
  assert.equal(cached.status, 304);
  assert.equal((await cached.text()).trim(), '');

  // ETag ที่ไม่ตรงต้องได้ body เต็ม
  const stale = await h.call(`${h.contactId}/${h.segmentId}`, 'admin-token', {
    'if-none-match': '"jr-segment:0:0"',
  });
  assert.equal(stale.status, 200);
});

test('stream ของ tenant อื่นแยกไม่ออกจาก stream ที่ไม่เคยมีอยู่จริง', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId);
  await h.seedStream(h.otherTenantId, h.otherContactId);

  /**
   * ทั้งสามเคสต้องได้คำตอบเหมือนกันเป๊ะ ๆ ไม่งั้นผู้เรียกจะ probe ได้ว่า contact/segment ไหน
   * มีอยู่จริงใน tenant อื่น
   */
  const cases: Array<[string, string]> = [
    ['stream ของ tenant อื่น', `${h.otherContactId}/${h.segmentId}`],
    ['contact ที่ไม่มีอยู่', `${randomUUID()}/${h.segmentId}`],
    ['segment ที่ไม่มีอยู่', `${h.contactId}/segment-ไม่มีจริง`],
  ];
  const bodies = new Set<string>();
  for (const [label, path] of cases) {
    const response = await h.call(path, 'admin-token');
    assert.equal(response.status, 404, label);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, 'RESOURCE_NOT_FOUND', label);
    bodies.add(JSON.stringify(body));
  }
  assert.equal(bodies.size, 1, 'ทุกเคสต้องตอบเหมือนกันทุกตัวอักษร');
});

test('role ที่ไม่ใช่ admin/compliance เข้าไม่ได้', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId);

  const response = await h.call(`${h.contactId}/${h.segmentId}`, 'agent-token');
  assert.equal(response.status, 403);
});

test('gap ใน stream ถูกรายงานให้ operator เห็น', async (t) => {
  const h = await harness(t);
  await h.seedStream(h.tenantId, h.contactId, 1);
  // revision 3 มาถึงโดยที่ 2 ไม่เคยมา — รูที่ operator ต้องตามหา
  await h.seedStream(h.tenantId, h.contactId, 3);

  const response = await h.call(`${h.contactId}/${h.segmentId}`, 'admin-token');
  const view = (await response.json()) as { gaps: number[]; receipts: unknown[] };
  assert.deepEqual(view.gaps, [2]);
  assert.equal(view.receipts.length, 2);
});

/** ดัน receipt ไปอยู่สถานะ REVIEW แล้วคืน eventId กับ version ที่ operator จะเห็น */
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

test('REPLAY คืน receipt เข้าคิวด้วย identity เดิมและบันทึก audit', async (t) => {
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

  // identity เดิมทุกอย่างต้องไม่ถูกแตะ
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

test('blind retry ด้วย version เก่าถูกปฏิเสธเป็น 409 และไม่แก้อะไร', async (t) => {
  const h = await harness(t);
  const target = await reviewedReceipt(h);

  const first = await h.post(`receipts/${target.eventId}/replay`, 'admin-token', {
    idempotencyKey: randomUUID(),
    body: { expectedVersion: target.version, reasonCode: 'OPERATOR_REPLAY' },
  });
  assert.equal(first.status, 201);

  // operator คนที่สองยังถือหน้าจอเก่าอยู่
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
    'คำสั่งที่ถูกปฏิเสธต้องไม่ถูกบันทึกเป็น audit',
  );
});

test('recovery ไม่รับ payload ทดแทน และบังคับ Idempotency-Key กับ reasonCode', async (t) => {
  const h = await harness(t);
  const target = await reviewedReceipt(h);

  const cases: Array<[string, { idempotencyKey?: string; body: unknown }]> = [
    ['ขาด Idempotency-Key', { body: { expectedVersion: 1, reasonCode: 'X_REPLAY' } }],
    [
      'reasonCode เป็นประโยคอิสระ',
      { idempotencyKey: randomUUID(), body: { expectedVersion: 1, reasonCode: 'ลูกค้าโทรมาบ่น' } },
    ],
    ['ขาด expectedVersion', { idempotencyKey: randomUUID(), body: { reasonCode: 'X_REPLAY' } }],
    [
      'แนบ payload ทดแทน',
      {
        idempotencyKey: randomUUID(),
        body: {
          expectedVersion: 1,
          reasonCode: 'X_REPLAY',
          payload: { membershipRevision: 99, contactId: 'ปลอม' },
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

test('receipt ที่ APPLIED แล้ว replay ไม่ได้ — effect เกิดไปแล้ว', async (t) => {
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

test('recovery ข้าม tenant แยกไม่ออกจากเป้าหมายที่ไม่เคยมี', async (t) => {
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
  assert.equal(bodies.size, 1, 'ทั้งสองเคสต้องตอบเหมือนกันทุกตัวอักษร');
});

test('REVALIDATE ปลุกงาน re-filter ที่ถูกพักไว้ แต่ปลุกงานที่จบแล้วไม่ได้', async (t) => {
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

  // ปิดงานแล้วปลุกไม่ได้ — ห้าม revive cancelled work
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
