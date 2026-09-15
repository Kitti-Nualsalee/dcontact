import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  cg4PendingExceptionQueue,
  type Cg4ExceptionQueueFilter,
  type Cg4QueryContext,
} from './cg4-query.js';

/**
 * #179 decision gap: `GET .../exceptions` tenant-wide queue — sorted by risk then expiry,
 * filterable only on workflowState/riskTier/channel/purpose, opaque cursor pagination.
 * Cross-tenant isolation via the gateway is covered at the API layer
 * (contact-governance-cg4-api.integration.ts); this proves the query-layer contract.
 */

const NOW = new Date('2026-09-15T00:00:00.000Z');
const DIGEST = 'a'.repeat(64);
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

test.after(async () => {
  await Promise.all([owner.$disconnect(), application.$disconnect()]);
});

interface SeedInput {
  tenant: string;
  contact: string;
  policyId: string;
  tier: 'STANDARD' | 'HIGH' | 'EMERGENCY';
  expiresAt: string;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REVOKED';
  channel?: string;
  purpose?: string;
}

async function seedSeries(input: SeedInput): Promise<string> {
  const exceptionId = randomUUID();
  const revisionId = randomUUID();
  const status = input.status ?? 'PENDING';
  await owner.cg4Exception.create({
    data: {
      id: revisionId,
      tenantId: input.tenant,
      exceptionId,
      revision: 1,
      contactId: input.contact,
      scopeKind: 'CONTACT_WIDE',
      channel: (input.channel ?? 'VOICE') as never,
      purpose: input.purpose ?? 'SERVICE_NOTIFICATION',
      sourceType: 'DIALER',
      sourceId: 'source-queue',
      allowedRuleCodes: ['QUIET_HOURS'],
      policyId: input.policyId,
      policyVersion: 1,
      policyContentDigest: DIGEST,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      startsAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date(input.expiresAt),
      tier: input.tier,
      status,
      reasonCode: 'OPERATIONAL',
      evidenceRef: 'evidence:queue',
      actorRef: 'maker-queue',
      requestHash: randomUUID().replaceAll('-', '').padEnd(64, '0'),
    },
  });
  await owner.cg4ExceptionHead.create({
    data: {
      id: randomUUID(),
      tenantId: input.tenant,
      exceptionId,
      currentRevisionId: revisionId,
      currentRevision: 1,
      status,
    },
  });
  return exceptionId;
}

async function fixture(t: TestContext) {
  const tenant = randomUUID();
  const contact = randomUUID();
  const policyId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenant,
      name: `CG4 queue ${tenant}`,
      slug: `cg4-queue-${tenant}`,
      sipDomain: `${tenant}.cg4-queue.test`,
    },
  });
  await owner.contact.create({ data: { id: contact, tenantId: tenant, displayName: 'CG4 queue' } });
  // cg_exception has a (tenant, policyId) FK into cg_policy — a fixture policy is required
  // even though the queue itself never reads policy content.
  await owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId: tenant,
      policyId,
      version: 1,
      scopeKey: 'channel=VOICE|contactKind=*|purpose=*|sourceType=*',
      content: { allowedOperationalRuleCodes: ['QUIET_HOURS'] },
      contentDigest: DIGEST,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      status: 'DRAFT',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      makerActorRef: 'maker-queue',
    },
  });
  t.after(async () => {
    await owner.cg4ExceptionHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Exception.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ContactExceptionHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Policy.deleteMany({ where: { tenantId: tenant } });
    await owner.contact.deleteMany({ where: { tenantId: tenant } });
    await owner.tenant.deleteMany({ where: { id: tenant } });
  });
  const context: Cg4QueryContext = { tenantId: tenant, level: 'SUMMARY' };
  const queue = (filter: Cg4ExceptionQueueFilter = {}) =>
    cg4PendingExceptionQueue(application, context, filter, NOW);
  return { tenant, contact, policyId, queue };
}

test('เรียงตาม risk tier ก่อน (EMERGENCY > HIGH > STANDARD) แล้วตาม expiresAt', async (t) => {
  const f = await fixture(t);
  const standard = await seedSeries({
    ...f,
    tier: 'STANDARD',
    expiresAt: '2026-09-16T00:00:00.000Z',
  });
  const emergencyLate = await seedSeries({
    ...f,
    tier: 'EMERGENCY',
    expiresAt: '2026-09-20T00:00:00.000Z',
  });
  const emergencySoon = await seedSeries({
    ...f,
    tier: 'EMERGENCY',
    expiresAt: '2026-09-16T12:00:00.000Z',
  });
  const high = await seedSeries({ ...f, tier: 'HIGH', expiresAt: '2026-09-17T00:00:00.000Z' });

  const page = await f.queue();
  assert.deepEqual(
    page.items.map((item) => item.seriesId),
    [emergencySoon, emergencyLate, high, standard],
  );
  assert.equal(page.nextCursor, undefined);
});

test('filter workflowState/riskTier/channel/purpose ทำงานร่วมกันแบบ AND', async (t) => {
  const f = await fixture(t);
  const wanted = await seedSeries({
    ...f,
    tier: 'HIGH',
    expiresAt: '2026-09-16T00:00:00.000Z',
    channel: 'LINE',
    purpose: 'MARKETING',
  });
  await seedSeries({
    ...f,
    tier: 'HIGH',
    expiresAt: '2026-09-16T00:00:00.000Z',
    status: 'APPROVED',
  });
  await seedSeries({
    ...f,
    tier: 'STANDARD',
    expiresAt: '2026-09-16T00:00:00.000Z',
    channel: 'LINE',
    purpose: 'MARKETING',
  });
  await seedSeries({
    ...f,
    tier: 'HIGH',
    expiresAt: '2026-09-16T00:00:00.000Z',
    channel: 'VOICE',
    purpose: 'SERVICE_NOTIFICATION',
  });

  const filtered = await f.queue({
    workflowState: 'PENDING',
    riskTier: 'HIGH',
    channel: 'LINE',
    purpose: 'MARKETING',
  });
  assert.deepEqual(
    filtered.items.map((item) => item.seriesId),
    [wanted],
  );

  const noWorkflowFilter = await f.queue({ riskTier: 'HIGH' });
  assert.equal(noWorkflowFilter.items.length, 3, 'ไม่ระบุ workflowState เห็นทุกสถานะ');
});

test('cursor เดินหน้าเป็น opaque page ครบทุกแถวไม่ซ้ำไม่ขาด และหน้าสุดท้ายไม่มี nextCursor', async (t) => {
  const f = await fixture(t);
  const ids = [];
  for (let i = 0; i < 5; i += 1) {
    ids.push(
      await seedSeries({
        ...f,
        tier: 'STANDARD',
        expiresAt: `2026-09-${16 + i}T00:00:00.000Z`,
      }),
    );
  }

  const seen: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page += 1) {
    const result = await f.queue({ limit: 2, cursor });
    seen.push(...result.items.map((item) => item.seriesId));
    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }
  assert.deepEqual(seen, ids);
});

test('tampered/expired cursor ไม่ throw แต่ตกกลับไปเป็นหน้าแรกอย่างปลอดภัย', async (t) => {
  const f = await fixture(t);
  const only = await seedSeries({ ...f, tier: 'STANDARD', expiresAt: '2026-09-16T00:00:00.000Z' });
  const page = await f.queue({ cursor: 'not-a-real-cursor' });
  assert.deepEqual(
    page.items.map((item) => item.seriesId),
    [only],
  );
});

test('scope ของ query อยู่ที่ tenantId ของ context เท่านั้น ไม่มีทาง param ใดข้าม tenant ได้', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  await seedSeries({ ...a, tier: 'EMERGENCY', expiresAt: '2026-09-16T00:00:00.000Z' });
  const bItem = await seedSeries({
    ...b,
    tier: 'EMERGENCY',
    expiresAt: '2026-09-16T00:00:00.000Z',
  });

  const pageA = await a.queue();
  const pageB = await b.queue();
  assert.equal(
    pageA.items.some((item) => item.seriesId === bItem),
    false,
  );
  assert.equal(pageB.items.length, 1);
  assert.equal(pageB.items[0]?.seriesId, bItem);
});
