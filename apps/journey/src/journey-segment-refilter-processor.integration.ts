import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type {
  CustomerSegmentMembershipReader,
  SegmentEntryResolution,
  TeamContactScopeAuthorization,
  TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import { JourneySegmentReceiptRepository } from './journey-segment-receipt-repository.js';
import { JourneySegmentRefilterProcessor } from './journey-segment-refilter-processor.js';

const evaluator = new DcExprEvaluator();
const HASH = 'a'.repeat(64);

const ALLOW: TeamContactScopeAuthorization = {
  decision: 'ALLOW',
  scopeVersion: 1,
  evaluatedAt: '2026-09-15T00:00:00.000Z',
};
const DENY: TeamContactScopeAuthorization = {
  decision: 'DENY',
  reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
  evaluatedAt: '2026-09-15T00:00:00.000Z',
};
const DEFER: TeamContactScopeAuthorization = {
  decision: 'DEFER',
  reasonCode: 'SCOPE_CONTEXT_STALE',
  evaluatedAt: '2026-09-15T00:00:00.000Z',
};

function reader(resolution: SegmentEntryResolution) {
  return {
    async resolveEntry() {
      return resolution;
    },
    async readChanges() {
      return { status: 'NOT_FOUND', reasonCode: 'RESOURCE_NOT_FOUND' } as const;
    },
  } as unknown as CustomerSegmentMembershipReader<never>;
}

function authorizer(decision: TeamContactScopeAuthorization) {
  return {
    async authorize() {
      return decision;
    },
  } as unknown as TeamContactScopeAuthorizer<never>;
}

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
  const teamId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const segmentId = `segment-gold-${suffix}`;

  t.after(async () => {
    await owner.jrSegmentOutbox.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRefilterCursor.deleteMany({ where: { tenantId } });
    await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId } });
    await owner.jrSegmentHead.deleteMany({ where: { tenantId } });
    await owner.jrSegmentReceipt.deleteMany({ where: { tenantId } });
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinitionHead.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinition.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J3.7 refilter ${suffix}`,
      slug: `j3-7-refilter-${suffix}`,
      sipDomain: `${suffix}.j3-7.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Lifecycle' } });
  await owner.contact.create({ data: { id: contactId, tenantId } });
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
    contactId,
    teamId,
    segmentId,
    suffix,
    definitions: new JourneyDefinitionRepository(application, evaluator),
    receipts: new JourneySegmentReceiptRepository(application),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function publishJourney(f: Fixture) {
  const journeyId = randomUUID();
  const draft = await f.definitions.createVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    name: 'เข้าเซกเมนต์',
    ownerTeamId: f.teamId,
    purpose: 'MARKETING',
    senderIdentityId: 'sender-1',
    trigger: {
      kind: 'SEGMENT_ENTRY',
      segmentId: f.segmentId,
      coalescingPolicy: 'PER_SEGMENT_ENTRY',
    },
    graph: {
      entryStepId: 'send',
      steps: [
        { id: 'send', type: 'SEND', channel: 'LINE', contentRef: 'tmpl-1', next: 'exit' },
        { id: 'exit', type: 'EXIT', reason: 'GOAL_REACHED' },
      ],
    },
    goal: { kind: 'EVENT', eventType: 'done' },
    exitRules: [{ kind: 'GOAL' }],
    maxDurationDays: 7,
    correlationId: 'corr',
  });
  await f.definitions.publishVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    expectedContentHash: draft.contentHash,
    correlationId: 'corr',
  });
  return journeyId;
}

/** สร้างงาน re-filter หนึ่งใบผ่านเส้นทางจริง: ingest แล้ว applyRefilter */
async function queueRefilter(f: Fixture, revision: number, changeKind: string, entryId?: string) {
  const received = await f.receipts.ingest({
    tenantId: f.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: revision,
    changeKind,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: `corr-${f.suffix}`,
    ...(entryId ? { entryId } : {}),
  });
  await f.receipts.applyRefilter(
    {
      tenantId: f.tenantId,
      receiptId: received.receipt.id,
      reasonCode: changeKind,
      correlationId: `corr-${f.suffix}`,
    },
    {
      eventType: 'journey.segment_entry.recorded',
      orderingKey: `${f.contactId}:${f.segmentId}`,
      payload: { contractVersion: 1 },
      payloadHash: HASH,
    },
  );
  return received.receipt.id;
}

function eligible(f: Fixture, entryId: string, revision = 1): SegmentEntryResolution {
  return {
    status: 'ELIGIBLE',
    contactId: f.contactId,
    segmentId: f.segmentId,
    entryId,
    segmentDefinitionVersion: 1,
    membershipRevision: revision,
    snapshotVersion: 1,
    evaluatedAt: '2026-09-15T00:00:00.000Z',
    stateDigest: HASH,
  } as unknown as SegmentEntryResolution;
}

function processor(
  f: Fixture,
  resolution: SegmentEntryResolution,
  scope: TeamContactScopeAuthorization = ALLOW,
) {
  return new JourneySegmentRefilterProcessor(f.application, f.definitions, {
    membershipReader: reader(resolution) as never,
    teamContactScopeAuthorizer: authorizer(scope) as never,
  });
}

async function cursor(f: Fixture) {
  return f.owner.jrSegmentRefilterCursor.findFirstOrThrow({
    where: { tenantId: f.tenantId },
    orderBy: { membershipRevision: 'desc' },
  });
}

test('correction ที่ยังอยู่ใน segment ด้วย entry เดิมจบเป็น NO_OP ไม่สร้างอะไรใหม่', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', entryId);

  const outcome = await processor(f, eligible(f, entryId)).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'NO_OP');

  const settled = await cursor(f);
  assert.equal(settled.state, 'NO_OP');
  assert.equal(settled.reasonCode, 'MEMBERSHIP_UNCHANGED');
  assert.ok(settled.settledAt, 'สถานะปลายทางต้องมี settledAt ตาม CHECK ของ #216');
  assert.equal(settled.leaseOwner, null);
  // ห้ามมี enrollment ใหม่จากการ correction
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('ไม่ eligible แล้วจบเป็น CANCELLED', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'LEFT', entryId);

  const outcome = await processor(f, {
    status: 'NOT_ELIGIBLE',
    reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
  }).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'CANCELLED');

  const settled = await cursor(f);
  assert.equal(settled.state, 'CANCELLED');
  assert.equal(settled.reasonCode, 'SEGMENT_ENTRY_NOT_ELIGIBLE');
  assert.ok(settled.settledAt);
});

test('merge/split รอ canonical fact ใบใหม่ ไม่ย้าย enrollment ของ predecessor', async (t) => {
  const f = await fixture(t);
  await publishJourney(f);
  await queueRefilter(f, 1, 'IDENTITY_INVALIDATED', `entry-${f.suffix}`);

  const outcome = await processor(f, eligible(f, `entry-${f.suffix}`)).executeNext(
    f.tenantId,
    'worker-1',
  );
  assert.equal(outcome, 'RECONCILING');

  const held = await cursor(f);
  assert.equal(held.state, 'RECONCILING');
  assert.equal(held.reasonCode, 'IDENTITY_LINEAGE_CONFLICT');
  assert.equal(held.settledAt, null, 'ยังไม่จบ จึงห้ามมี settledAt');
  assert.equal(held.leaseOwner, null, 'ต้องปล่อย lease ไม่ค้างไว้กับ worker');
  assert.ok(held.availableAt.getTime() > Date.now(), 'ต้องมีวันกลับมาเอง');
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('REFILTER_REQUIRED ที่ไม่มี entryId รอ fact ที่ชี้ entry ชัดเจน', async (t) => {
  const f = await fixture(t);
  await publishJourney(f);
  await queueRefilter(f, 1, 'REFILTER_REQUIRED');

  const outcome = await processor(f, eligible(f, 'entry-x')).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'RECONCILING');
  assert.equal((await cursor(f)).reasonCode, 'RECONCILIATION_REQUIRED');
});

test('STALE เลื่อนเป็น DEFERRED ส่วน scope DEFER ก็เช่นกัน', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', entryId);

  assert.equal(
    await processor(f, { status: 'STALE', reasonCode: 'MEMBERSHIP_CONTEXT_STALE' }).executeNext(
      f.tenantId,
      'worker-1',
    ),
    'DEFERRED',
  );
  const deferred = await cursor(f);
  assert.equal(deferred.state, 'DEFERRED');
  assert.equal(deferred.attempts, 1);
  assert.equal(deferred.settledAt, null);

  // ยังไม่ถึงเวลา จึง claim ไม่ได้
  assert.equal(
    await processor(f, eligible(f, entryId)).executeNext(f.tenantId, 'worker-2'),
    undefined,
  );

  // พอถึงเวลาแล้วต้องกลับมาเอง และ scope DEFER ก็ให้ผลเดียวกัน
  const later = new JourneySegmentRefilterProcessor(
    f.application,
    f.definitions,
    {
      membershipReader: reader(eligible(f, entryId)) as never,
      teamContactScopeAuthorizer: authorizer(DEFER) as never,
    },
    { now: () => new Date(Date.now() + 120_000) },
  );
  assert.equal(await later.executeNext(f.tenantId, 'worker-3'), 'DEFERRED');
  assert.equal((await cursor(f)).attempts, 2);
});

test('scope ถูกเพิกถอนหลัง enroll แล้วจบเป็น CANCELLED โดยไม่แตะ Governance', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', entryId);

  const outcome = await processor(f, eligible(f, entryId), DENY).executeNext(
    f.tenantId,
    'worker-1',
  );
  assert.equal(outcome, 'CANCELLED');
  assert.equal((await cursor(f)).reasonCode, 'TEAM_SEGMENT_NOT_ALLOWED');
  assert.equal(
    await f.owner.cgDecisionLog.count({ where: { tenantId: f.tenantId } }).catch(() => 0),
    0,
    'การเพิกถอนสิทธิ์ของทีมห้ามถูกบันทึกเป็น Governance BLOCK',
  );
});

test('entry เปลี่ยนไปแล้วต้องไม่ถือว่าเป็น correction ของ entry เดิม', async (t) => {
  const f = await fixture(t);
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', `entry-old-${f.suffix}`);

  // Customer 360 ตอบด้วย entry ใหม่ = การเข้ารอบใหม่ ไม่ใช่การแก้ค่าของรอบเดิม
  const outcome = await processor(f, eligible(f, `entry-new-${f.suffix}`)).executeNext(
    f.tenantId,
    'worker-1',
  );
  assert.equal(outcome, 'RECONCILING');
  assert.equal((await cursor(f)).reasonCode, 'INVALID_MEMBERSHIP_TRANSITION');
  assert.equal(
    await f.owner.jrSegmentEnrollmentIntent.count({ where: { tenantId: f.tenantId } }),
    0,
    'ห้ามสร้าง enrollment ใหม่จาก re-filter — การเข้าใหม่ต้องมากับ ENTERED เท่านั้น',
  );
});

test('lease: worker ที่สองไม่ได้ cursor เดิมจนกว่า lease จะหมดอายุ', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  await publishJourney(f);
  await queueRefilter(f, 1, 'CORRECTED', entryId);

  const claimed = await f.receipts.claimNextRefilter(f.tenantId, 'worker-1', 60);
  assert.ok(claimed);
  assert.equal(claimed.state, 'REVALIDATING');
  assert.equal(await f.receipts.claimNextRefilter(f.tenantId, 'worker-2', 60), undefined);

  // worker แรกตายกลางทาง งานต้องกลับเข้าคิว
  const expired = new JourneySegmentReceiptRepository(f.application, {
    now: () => new Date(Date.now() + 120_000),
  });
  const retaken = await expired.claimNextRefilter(f.tenantId, 'worker-2', 60);
  assert.equal(retaken?.id, claimed.id);
  assert.equal(retaken?.leaseOwner, 'worker-2');
});

test('ไม่มีงาน re-filter คืน undefined โดยไม่แตะอะไรเลย', async (t) => {
  const f = await fixture(t);
  assert.equal(
    await processor(f, eligible(f, 'entry')).executeNext(f.tenantId, 'worker-1'),
    undefined,
  );
});
