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

  return { owner, tenantId, otherTenantId, contactId, otherContactId, segmentId, seedStream, call };
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
