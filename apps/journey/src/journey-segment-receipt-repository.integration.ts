import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  JourneySegmentReceiptRepository,
  SegmentEntryTerminalError,
  SegmentReceiptHashConflictError,
  type IngestSegmentReceiptInput,
} from './journey-segment-receipt-repository.js';

const HASH = 'a'.repeat(64);
const OTHER_HASH = 'b'.repeat(64);

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
  const contactId = randomUUID();
  const survivorId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const segmentId = `segment-gold-${suffix}`;

  t.after(async () => {
    await owner.jrSegmentOutbox.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRefilterCursor.deleteMany({ where: { tenantId } });
    await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId } });
    await owner.jrSegmentHead.deleteMany({ where: { tenantId } });
    await owner.jrSegmentReceipt.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J3.6 segment ${suffix}`,
      slug: `j3-6-segment-${suffix}`,
      sipDomain: `${suffix}.j3-6.test`,
    },
  });
  await owner.contact.createMany({
    data: [contactId, survivorId].map((id) => ({ id, tenantId })),
  });

  return {
    owner,
    application,
    tenantId,
    contactId,
    survivorId,
    segmentId,
    suffix,
    repository: new JourneySegmentReceiptRepository(application),
  };
}

function ingestInput(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<IngestSegmentReceiptInput> = {},
): IngestSegmentReceiptInput {
  return {
    tenantId: f.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: 1,
    changeKind: 'ENTERED',
    entryId: `entry-${f.suffix}`,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: `corr-${f.suffix}`,
    ...overrides,
  };
}

function event(f: Awaited<ReturnType<typeof fixture>>) {
  return {
    eventType: 'journey.segment_entry.intent_recorded',
    orderingKey: `${f.contactId}:${f.segmentId}`,
    payload: { contractVersion: 1, segmentId: f.segmentId },
    payloadHash: HASH,
  };
}

test('revision แรกของ stream พร้อม apply ทันที ส่วน event เดิมที่ส่งซ้ำเป็น DUPLICATE', async (t) => {
  const f = await fixture(t);
  const input = ingestInput(f);

  const first = await f.repository.ingest(input);
  assert.equal(first.outcome, 'READY');

  // ส่งซ้ำทั้งดวงจาก broker — ต้องไม่สร้าง receipt ใบที่สอง
  const replay = await f.repository.ingest(input);
  assert.equal(replay.outcome, 'DUPLICATE');
  assert.equal(replay.receipt.id, first.receipt.id);
  assert.equal(await f.owner.jrSegmentReceipt.count({ where: { tenantId: f.tenantId } }), 1);
});

test('revision เดิมที่มาคนละ eventId ชน logical identity ไม่ใช่ transport', async (t) => {
  const f = await fixture(t);
  await f.repository.ingest(ingestInput(f));

  // hash เดิม = เนื้อหาเดียวกันที่มาสองทาง ถือเป็น duplicate ไม่ใช่ความขัดแย้ง
  const sameContent = await f.repository.ingest(
    ingestInput(f, { eventId: `event-other-${randomUUID()}` }),
  );
  assert.equal(sameContent.outcome, 'DUPLICATE');

  // hash ต่าง = revision เดียวกันแต่เนื้อหาไม่ตรงกัน ต้อง quarantine ไม่ใช่เลือกใบใดใบหนึ่ง
  const conflicting = await f.repository.ingest(
    ingestInput(f, { eventId: `event-conflict-${randomUUID()}`, payloadHash: OTHER_HASH }),
  );
  assert.equal(conflicting.outcome, 'QUARANTINED');
  assert.equal(conflicting.receipt.reviewReasonCode, 'EVENT_HASH_CONFLICT');
  assert.equal(await f.owner.jrSegmentReceipt.count({ where: { tenantId: f.tenantId } }), 1);
});

test('eventId เดิมที่เนื้อหาเปลี่ยนไปถูกปฏิเสธเป็น IDEMPOTENCY_CONFLICT', async (t) => {
  const f = await fixture(t);
  const input = ingestInput(f);
  await f.repository.ingest(input);

  await assert.rejects(
    () => f.repository.ingest({ ...input, payloadHash: OTHER_HASH }),
    (error: unknown) => {
      assert.ok(error instanceof SegmentReceiptHashConflictError);
      assert.equal(error.kind, 'TRANSPORT');
      assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    },
  );
});

test('gap 1/3/2: revision 3 รอจนกว่า 2 จะมาถึง แล้วค่อยพร้อมตามลำดับ', async (t) => {
  const f = await fixture(t);
  const one = await f.repository.ingest(ingestInput(f, { membershipRevision: 1 }));
  assert.equal(one.outcome, 'READY');

  const three = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 3, changeKind: 'CORRECTED' }),
  );
  assert.equal(three.outcome, 'WAITING_FOR_GAP', '3 มาก่อน 2 ต้องรอ ไม่ใช่ apply ข้าม');

  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: one.receipt.id,
      entryId: `entry-${f.suffix}`,
      canonicalContactId: f.contactId,
      intents: [],
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );
  // head อยู่ที่ 1 แล้ว แต่ 3 ยังข้ามไม่ได้เพราะ 2 ยังหายอยู่
  assert.equal(
    (await f.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: three.receipt.id } })).state,
    'WAITING_FOR_GAP',
  );

  const two = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 2, changeKind: 'CORRECTED' }),
  );
  assert.equal(two.outcome, 'READY');
  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: two.receipt.id,
      reasonCode: 'CORRECTED',
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  // 2 apply แล้ว gap ถูกเติม 3 จึงต้องถูกปลดเป็น READY เองโดยไม่ต้องรอ event ใหม่
  assert.equal(
    (await f.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: three.receipt.id } })).state,
    'READY',
  );
});

test('revision ที่หายไประหว่างทางถูก IGNORED_SUPERSEDED และ head ไม่ถอยหลัง', async (t) => {
  const f = await fixture(t);
  const one = await f.repository.ingest(ingestInput(f, { membershipRevision: 1 }));
  const three = await f.repository.ingest(ingestInput(f, { membershipRevision: 3 }));
  assert.equal(three.outcome, 'WAITING_FOR_GAP');

  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: one.receipt.id,
      reasonCode: 'CORRECTED',
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  /**
   * operator สั่ง apply revision 3 ทั้งที่ 2 ยังไม่เคยมาถึง (recovery/replay) head จึงกระโดด
   * ข้าม 2 ไป — พอ 2 ตามมาทีหลังมันคือของที่ถูกกลืนไปแล้ว ต้อง IGNORED_SUPERSEDED ไม่ใช่
   * เดินย้อน head กลับไปหา 2 ซึ่งจะทำให้ 3 ถูก apply ซ้ำ
   */
  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: three.receipt.id,
      reasonCode: 'CORRECTED',
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );
  assert.equal(
    (await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } }))
      .lastAppliedRevision,
    3,
  );

  const late = await f.repository.ingest(ingestInput(f, { membershipRevision: 2 }));
  assert.equal(late.outcome, 'IGNORED_SUPERSEDED');
  assert.equal(
    (await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } }))
      .lastAppliedRevision,
    3,
    'head ห้ามถอยหลัง',
  );

  // revision เดิมที่เคยเห็นแล้วชน logical identity ก่อนถึงขั้นเทียบกับ head
  const seen = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 1, eventId: `event-late-${randomUUID()}` }),
  );
  assert.equal(seen.outcome, 'DUPLICATE');
});

test('หนึ่ง entry สร้าง enrollment ได้อย่างมากหนึ่งใบต่อ journey version แม้ apply ซ้ำ', async (t) => {
  const f = await fixture(t);
  const journeyId = `journey-${f.suffix}`;
  const entryId = `entry-${f.suffix}`;
  const intents = [
    {
      journeyId,
      journeyVersion: 1,
      reasonMembershipRevision: 1,
      reasonDefinitionVersion: 1,
      reasonDigest: HASH,
    },
  ];

  const first = await f.repository.ingest(ingestInput(f));
  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: first.receipt.id,
      entryId,
      canonicalContactId: f.contactId,
      intents,
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  // apply ซ้ำ (worker restart หลัง commit แต่ก่อน ack) ต้อง idempotent ไม่ใช่โยน error
  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: first.receipt.id,
      entryId,
      canonicalContactId: f.contactId,
      intents,
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId, journeyId } }),
    1,
  );
  // reason เก็บได้แค่ ref/version/digest — ห้ามมีค่า attribute หรือ identity ดิบ
  const intent = await f.owner.jrSegmentEnrollmentIntent.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(intent.reasonMembershipRevision, 1);
  assert.equal(intent.reasonDigest, HASH);
  assert.equal(intent.contactId, f.contactId);
});

test('merge: enrollment ผูกกับ survivor แต่ receipt ยังเก็บ contact ต้นทางไว้', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const received = await f.repository.ingest(ingestInput(f));

  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: received.receipt.id,
      entryId,
      canonicalContactId: f.survivorId,
      intents: [
        {
          journeyId: `journey-${f.suffix}`,
          journeyVersion: 1,
          reasonMembershipRevision: 1,
          reasonDefinitionVersion: 1,
          reasonDigest: HASH,
        },
      ],
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  const intent = await f.owner.jrSegmentEnrollmentIntent.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(intent.contactId, f.survivorId, 'enrollment ต้องไปอยู่กับ survivor');
  const receipt = await f.owner.jrSegmentReceipt.findUniqueOrThrow({
    where: { id: received.receipt.id },
  });
  assert.equal(receipt.contactId, f.contactId, 'receipt ต้องยังชี้ contact ต้นทางเพื่อ lineage');
});

test('entry ที่ถูกปิดแล้วสร้าง enrollment ใหม่ไม่ได้ และ terminal เขียนได้ครั้งเดียว', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const entered = await f.repository.ingest(ingestInput(f, { membershipRevision: 1 }));
  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: entered.receipt.id,
      entryId,
      canonicalContactId: f.contactId,
      intents: [],
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  const left = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 2, changeKind: 'LEFT' }),
  );
  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: left.receipt.id,
      reasonCode: 'LEFT',
      terminalEntryId: entryId,
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  const head = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(head.terminalEntryId, entryId);
  assert.equal(head.terminalRevision, 2);
  assert.equal(head.terminalReasonCode, 'LEFT');

  // replay ย้อนหลังต้องชุบชีวิต entry เดิมไม่ได้
  const replayed = await f.repository.ingest(
    ingestInput(f, { membershipRevision: 3, changeKind: 'ENTERED' }),
  );
  await assert.rejects(
    () =>
      f.repository.applyEnrollment(
        {
          tenantId: f.tenantId,
          receiptId: replayed.receipt.id,
          entryId,
          canonicalContactId: f.contactId,
          intents: [
            {
              journeyId: `journey-${f.suffix}`,
              journeyVersion: 1,
              reasonMembershipRevision: 3,
              reasonDefinitionVersion: 1,
              reasonDigest: HASH,
            },
          ],
          correlationId: `corr-${f.suffix}`,
        },
        event(f),
      ),
    (error: unknown) => {
      assert.ok(error instanceof SegmentEntryTerminalError);
      assert.equal(error.code, 'INVALID_MEMBERSHIP_TRANSITION');
      return true;
    },
  );

  // ทรานแซกชันที่ล้มต้องไม่ทิ้งอะไรไว้เลย — ไม่มี intent, ไม่มี outbox, receipt ยังไม่ APPLIED
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
  assert.equal(
    (await f.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: replayed.receipt.id } }))
      .state,
    'READY',
  );

  // terminal ใบแรกต้องไม่ถูกเขียนทับด้วย event ที่มาทีหลัง
  await f.repository.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: replayed.receipt.id,
      reasonCode: 'INVALIDATED',
      terminalEntryId: `entry-other-${f.suffix}`,
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );
  const after = await f.owner.jrSegmentHead.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(after.terminalEntryId, entryId);
  assert.equal(after.terminalReasonCode, 'LEFT');
});

test('lease: worker ที่สองไม่ได้ receipt เดิมจนกว่า lease จะหมดอายุ', async (t) => {
  const f = await fixture(t);
  await f.repository.ingest(ingestInput(f));

  const claimed = await f.repository.claimNextReady(f.tenantId, 'worker-1', 60);
  assert.ok(claimed);
  assert.equal(claimed.state, 'PROCESSING');
  assert.equal(claimed.leaseOwner, 'worker-1');

  assert.equal(
    await f.repository.claimNextReady(f.tenantId, 'worker-2', 60),
    undefined,
    'lease ยังไม่หมดอายุ worker อื่นต้องไม่ได้ไป',
  );

  // lease หมดอายุ = worker แรกตายกลางทาง งานต้องกลับเข้าคิว ไม่ค้างตลอดกาล
  const expired = new JourneySegmentReceiptRepository(f.application, {
    now: () => new Date(Date.now() + 120_000),
  });
  const retaken = await expired.claimNextReady(f.tenantId, 'worker-2', 60);
  assert.equal(retaken?.id, claimed.id);
  assert.equal(retaken?.leaseOwner, 'worker-2');
});

test('markRetryableFailure ปล่อย lease และเลื่อนเวลา ส่วน quarantine เป็นปลายทาง', async (t) => {
  const f = await fixture(t);
  const received = await f.repository.ingest(ingestInput(f));
  await f.repository.claimNextReady(f.tenantId, 'worker-1', 60);

  const retried = await f.repository.markRetryableFailure(
    f.tenantId,
    received.receipt.id,
    60_000,
    'MEMBERSHIP_CONTEXT_STALE',
  );
  assert.equal(retried.state, 'READY');
  assert.equal(retried.leaseOwner, null);
  assert.equal(retried.attempts, 1);
  assert.ok(retried.availableAt.getTime() > Date.now());
  // ยังไม่ถึงเวลา จึง claim ไม่ได้
  assert.equal(await f.repository.claimNextReady(f.tenantId, 'worker-2', 60), undefined);

  const quarantined = await f.repository.markQuarantined(
    f.tenantId,
    received.receipt.id,
    'PAYLOAD_VALIDATION_FAILED',
  );
  assert.equal(quarantined.state, 'QUARANTINED');
  assert.equal(quarantined.leaseOwner, null);
});

test('outbox ถูกเขียนในทรานแซกชันเดียวกับ receipt/head/intent', async (t) => {
  const f = await fixture(t);
  const received = await f.repository.ingest(ingestInput(f));
  await f.repository.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: received.receipt.id,
      entryId: `entry-${f.suffix}`,
      canonicalContactId: f.contactId,
      intents: [
        {
          journeyId: `journey-${f.suffix}`,
          journeyVersion: 1,
          reasonMembershipRevision: 1,
          reasonDefinitionVersion: 1,
          reasonDigest: HASH,
        },
      ],
      correlationId: `corr-${f.suffix}`,
    },
    event(f),
  );

  const outbox = await f.owner.jrSegmentOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(outbox.state, 'PENDING', 'relay ต้องเกิดหลัง commit ไม่ใช่ระหว่าง');
  assert.equal(outbox.receiptId, received.receipt.id);
  assert.equal(outbox.orderingKey, `${f.contactId}:${f.segmentId}`);
  assert.equal(outbox.publishedAt, null);

  // ทุกอย่างต้องอยู่ครบในรอบเดียว
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  assert.equal(await f.owner.jrSegmentHead.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(
    (await f.owner.jrSegmentReceipt.findUniqueOrThrow({ where: { id: received.receipt.id } }))
      .state,
    'APPLIED',
  );

  const wire = JSON.stringify(outbox);
  for (const forbidden of ['attributes', 'tier', 'phone', 'email']) {
    assert.doesNotMatch(wire, new RegExp(forbidden, 'i'), `${forbidden} ต้องไม่อยู่ใน outbox`);
  }
});
