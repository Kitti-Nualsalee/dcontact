import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { JourneySegmentBaseline } from './journey-segment-baseline.js';
import { JourneySegmentReceiptRepository } from './journey-segment-receipt-repository.js';

const HASH = 'a'.repeat(64);

async function fixture(t: TestContext) {
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
  const tenantId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const segmentId = `segment-gold-${suffix}`;

  t.after(async () => {
    await owner.jrSegmentOutbox.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRefilterCursor.deleteMany({ where: { tenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId } });
    await owner.jrSegmentHead.deleteMany({ where: { tenantId } });
    await owner.jrSegmentReceipt.deleteMany({ where: { tenantId } });
    await owner.c360SegmentMembershipHead.deleteMany({ where: { tenantId } });
    await owner.c360SegmentEvaluation.deleteMany({ where: { tenantId } });
    await owner.c360FactSnapshot.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinitionHead.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinition.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J3.10 baseline ${suffix}`,
      slug: `j3-10-baseline-${suffix}`,
      sipDomain: `${suffix}.j3-10.test`,
    },
  });
  await owner.c360SegmentDefinition.create({
    data: {
      tenantId,
      segmentId,
      version: 1,
      status: 'PUBLISHED',
      definition: { contractVersion: 1, name: segmentId },
      contentDigest: HASH,
      evaluatorVersion: 'DC_EXPR:1',
      correlationId: 'corr',
      effectiveFrom: new Date(),
      publishedAt: new Date(),
    },
  });
  await owner.c360SegmentDefinitionHead.create({
    data: { tenantId, segmentId, headVersion: 1, currentVersion: 1, currentDigest: HASH },
  });

  return {
    owner,
    application,
    tenantId,
    segmentId,
    suffix,
    baseline: new JourneySegmentBaseline(application),
    receipts: new JourneySegmentReceiptRepository(application),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** สร้าง membership ของ Customer 360 ที่ "มีอยู่ก่อน" เปิด J3 */
async function existingMembership(f: Fixture, revision: number, state: 'IN' | 'OUT' = 'IN') {
  const contactId = randomUUID();
  await f.owner.contact.create({ data: { id: contactId, tenantId: f.tenantId } });
  await f.owner.c360FactSnapshot.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      snapshotVersion: 1,
      attributes: {},
      computed: {},
      sourceCutoffAt: new Date(),
      contentDigest: HASH,
      correlationId: 'corr',
    },
  });
  const evaluation = await f.owner.c360SegmentEvaluation.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      segmentId: f.segmentId,
      segmentDefinitionVersion: 1,
      snapshotVersion: 1,
      outcome: 'MATCH',
      matched: true,
      evaluatorVersion: 'DC_EXPR:1',
      inputDigest: HASH,
      evaluationDigest: HASH,
      evaluatedAt: new Date(),
    },
  });
  await f.owner.c360SegmentMembershipHead.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      segmentId: f.segmentId,
      state,
      membershipRevision: revision,
      ...(state === 'IN' ? { entryId: `entry-${contactId.slice(0, 8)}` } : {}),
      segmentDefinitionVersion: 1,
      snapshotVersion: 1,
      evaluationId: evaluation.id,
      evaluatedAt: new Date(),
      evidenceRef: `evidence-${contactId.slice(0, 8)}`,
      stateDigest: HASH,
    },
  });
  return contactId;
}

test('baseline ตั้ง head ให้ membership ที่มีอยู่ก่อน โดยไม่สร้าง enrollment เลยสักใบ', async (t) => {
  const f = await fixture(t);
  const contacts = await Promise.all([
    existingMembership(f, 5),
    existingMembership(f, 3),
    existingMembership(f, 7),
  ]);

  const result = await f.baseline.baselineTenant(f.tenantId);
  assert.equal(result.baselined, 3);
  assert.equal(result.skipped, 0);

  const heads = await f.owner.jrSegmentHead.findMany({ where: { tenantId: f.tenantId } });
  assert.equal(heads.length, 3);
  for (const contactId of contacts) {
    const head = heads.find((row) => row.contactId === contactId);
    assert.ok(head, 'ทุก stream ต้องมี head');
    assert.equal(head.terminalEntryId, null, 'baseline ไม่ได้เห็นเหตุการณ์ปิด entry จึงห้ามเขียน');
  }

  /**
   * ข้อสำคัญที่สุดของ baseline: ห้ามมี enrollment เกิดขึ้นเลย
   *
   * contact เหล่านี้อยู่ใน segment มาก่อนเปิดระบบ การ enroll ทุกคนตอนเปิดเท่ากับยิงแคมเปญใส่
   * ฐานลูกค้าทั้งหมดพร้อมกันโดยไม่มีใครสั่ง
   */
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
  assert.equal(await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.jrSegmentReceipt.count({ where: { tenantId: f.tenantId } }), 0);
});

test('รัน baseline ซ้ำได้ผลเท่าเดิม ไม่สร้างอะไรเพิ่ม', async (t) => {
  const f = await fixture(t);
  await existingMembership(f, 5);
  await existingMembership(f, 2);

  const first = await f.baseline.baselineTenant(f.tenantId);
  const second = await f.baseline.baselineTenant(f.tenantId);

  assert.equal(first.baselined, 2);
  assert.equal(second.baselined, 0, 'รอบสองต้องไม่ตั้ง baseline ซ้ำ');
  assert.equal(second.skipped, 2);
  assert.equal(await f.owner.jrSegmentHead.count({ where: { tenantId: f.tenantId } }), 2);
});

test('baseline ไม่ดึง head ที่เดินไปไกลแล้วให้ถอยกลับ', async (t) => {
  const f = await fixture(t);
  const contactId = await existingMembership(f, 2);
  // ระบบเดินไปถึง revision 9 แล้วก่อนที่จะมีคนสั่ง baseline ซ้ำ
  await f.owner.jrSegmentHead.create({
    data: {
      tenantId: f.tenantId,
      contactId,
      segmentId: f.segmentId,
      lastAppliedRevision: 9,
    },
  });

  const result = await f.baseline.baselineTenant(f.tenantId);
  assert.equal(result.baselined, 0);
  assert.equal(result.skipped, 1);
  const head = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(head.lastAppliedRevision, 9, 'head ห้ามถูกดึงถอยหลัง');
});

test('baseline แบ่งชุดได้และ resume ต่อจาก cursor เดิมโดยไม่ข้าม stream', async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 5; index += 1) await existingMembership(f, index + 1);

  // รอบแรกทำแค่สองใบแล้วหยุด เหมือนถูก kill กลางทาง
  const first = await f.baseline.baselineNext({ tenantId: f.tenantId, batchSize: 2 });
  assert.equal(first.baselined, 2);
  assert.ok(first.nextCursor, 'ยังไม่จบต้องมี cursor ให้ทำต่อ');

  // resume จาก cursor เดิม
  const rest = await f.baseline.baselineTenant(f.tenantId, 2);
  assert.equal(rest.baselined + first.baselined, 5, 'ทุก stream ต้องถูกทำครบ ไม่มีใครถูกข้าม');
  assert.equal(await f.owner.jrSegmentHead.count({ where: { tenantId: f.tenantId } }), 5);
});

test('membership ที่ OUT อยู่แล้วก็ได้ baseline แต่ไม่ถูกทำเครื่องหมายว่าจบ', async (t) => {
  const f = await fixture(t);
  await existingMembership(f, 4, 'OUT');

  await f.baseline.baselineTenant(f.tenantId);
  const head = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(head.lastAppliedRevision, 4);
  assert.equal(head.terminalEntryId, null);
  assert.equal(head.terminalReasonCode, null);
});

test('rebuild ประกอบ head จาก receipt ที่ apply แล้ว และรันซ้ำได้ผลเท่าเดิม', async (t) => {
  const f = await fixture(t);
  const contactId = await existingMembership(f, 1);
  const entryId = `entry-${f.suffix}`;

  for (const revision of [1, 2]) {
    const received = await f.receipts.ingest({
      tenantId: f.tenantId,
      source: 'CUSTOMER_360',
      eventId: `event-${randomUUID()}`,
      contactId,
      segmentId: f.segmentId,
      membershipRevision: revision,
      changeKind: revision === 1 ? 'ENTERED' : 'CORRECTED',
      entryId,
      segmentDefinitionVersion: 1,
      payloadHash: HASH,
      correlationId: `corr-${f.suffix}`,
    });
    await f.receipts.applyRefilter(
      {
        tenantId: f.tenantId,
        receiptId: received.receipt.id,
        reasonCode: 'CORRECTED',
        correlationId: `corr-${f.suffix}`,
      },
      {
        eventType: 'journey.segment_entry.recorded',
        orderingKey: `${contactId}:${f.segmentId}`,
        payload: { contractVersion: 1 },
        payloadHash: HASH,
      },
    );
  }

  const intentsBefore = await f.owner.jrSegmentEnrollmentIntent.count({
    where: { tenantId: f.tenantId },
  });
  const outboxBefore = await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } });

  // projection เสียหาย — ลบ head ทิ้งแล้วประกอบใหม่จาก ledger
  await f.owner.jrSegmentHead.deleteMany({ where: { tenantId: f.tenantId, contactId } });
  const rebuilt = await f.baseline.rebuildHead(f.tenantId, contactId, f.segmentId);
  assert.equal(rebuilt.lastAppliedRevision, 2);
  assert.equal(rebuilt.rebuilt, true);

  // รันซ้ำต้องได้เท่าเดิมและไม่นับว่าเปลี่ยนอะไร
  const again = await f.baseline.rebuildHead(f.tenantId, contactId, f.segmentId);
  assert.equal(again.lastAppliedRevision, 2);
  assert.equal(again.rebuilt, false, 'rebuild ที่ไม่มีอะไรเปลี่ยนต้องไม่รายงานว่าเขียน');

  // rebuild projection ไม่ใช่การ replay effect
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    intentsBefore,
  );
  assert.equal(
    await f.owner.jrSegmentOutbox.count({ where: { tenantId: f.tenantId } }),
    outboxBefore,
    'rebuild ต้องไม่สร้าง outbox ซ้ำ',
  );
});

test('rebuild ของ stream ที่ไม่มี receipt ที่ apply แล้วไม่สร้าง head ขึ้นมาลอย ๆ', async (t) => {
  const f = await fixture(t);
  const contactId = await existingMembership(f, 1);
  await f.owner.jrSegmentHead.deleteMany({ where: { tenantId: f.tenantId } });

  const result = await f.baseline.rebuildHead(f.tenantId, contactId, f.segmentId);
  assert.equal(result.rebuilt, false);
  assert.equal(result.lastAppliedRevision, 0);
  assert.equal(await f.owner.jrSegmentHead.count({ where: { tenantId: f.tenantId } }), 0);
});
