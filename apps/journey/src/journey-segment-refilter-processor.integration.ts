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
import { IamTeamContactScopeAuthorizer, IamTeamSegmentScopeRepository } from '@d-contact/iam';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
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
    // enrollment อ้าง intent ด้วย FK จึงต้องลบก่อน
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId } });
    await owner.jrSegmentHead.deleteMany({ where: { tenantId } });
    await owner.jrSegmentReceipt.deleteMany({ where: { tenantId } });
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId } });
    await owner.iamScopeConsumerInbox.deleteMany({ where: { tenantId } });
    await owner.iamScopeInvalidationOutbox.deleteMany({ where: { tenantId } });
    await owner.iamContactSegmentScopeProjection.deleteMany({ where: { tenantId } });
    await owner.iamTeamSegmentScopeRevocation.deleteMany({ where: { tenantId } });
    await owner.iamTeamSegmentScopeActiveGrant.deleteMany({ where: { tenantId } });
    await owner.iamTeamSegmentScopeGrant.deleteMany({ where: { tenantId } });
    await owner.iamTeamScopeVersion.deleteMany({ where: { tenantId } });
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
    actions: new JourneyOwnerActionRepository(application),
    iam: new IamTeamSegmentScopeRepository(application),
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

test('IAM WORK grant ถูก revoke แล้ว re-filter ยกเลิก action ก่อน barrier ผ่าน owner command เดิม', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  const actionKey = `iam-revoke-${f.suffix}`;
  await ownerAction(f, enrollmentId, actionKey);
  const grant = await f.iam.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: f.segmentId,
    permission: 'WORK',
    correlationId: `iam-grant-${f.suffix}`,
  });
  await f.iam.revoke({
    tenantId: f.tenantId,
    grantId: grant.grant.id,
    reasonCode: 'ADMIN_REVOKE',
    correlationId: `iam-revoke-${f.suffix}`,
  });
  await queueRefilter(f, 2, 'CORRECTED', entryId);

  const processor = new JourneySegmentRefilterProcessor(f.application, f.definitions, {
    membershipReader: reader(eligible(f, entryId, 2)) as never,
    teamContactScopeAuthorizer: new IamTeamContactScopeAuthorizer(f.application),
  });
  assert.equal(await processor.executeNext(f.tenantId, 'iam-revoke-worker'), 'CANCELLED');
  assert.equal(
    (
      await f.owner.jrOwnerAction.findFirstOrThrow({
        where: { tenantId: f.tenantId, actionKey },
      })
    ).state,
    'CANCEL_REQUESTED',
  );
  assert.equal(
    await f.owner.jrOwnerCommandOutbox.count({
      where: { tenantId: f.tenantId, commandId: `cancel:segment-refilter:${actionKey}` },
    }),
    1,
  );
  assert.equal(await f.owner.cgDecisionLog.count({ where: { tenantId: f.tenantId } }), 0);
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

/** สร้าง enrollment จริงผ่าน applyEnrollment แล้วคืน enrollmentId */
async function enrollFor(f: Fixture, entryId: string, journeyId: string) {
  const received = await f.receipts.ingest({
    tenantId: f.tenantId,
    source: 'CUSTOMER_360',
    eventId: `event-${randomUUID()}`,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: 1,
    changeKind: 'ENTERED',
    entryId,
    segmentDefinitionVersion: 1,
    payloadHash: HASH,
    correlationId: `corr-${f.suffix}`,
  });
  await f.receipts.applyEnrollment(
    {
      tenantId: f.tenantId,
      receiptId: received.receipt.id,
      entryId,
      canonicalContactId: f.contactId,
      intents: [
        {
          journeyId,
          journeyVersion: 1,
          entryStepId: 'send',
          reasonMembershipRevision: 1,
          reasonDefinitionVersion: 1,
          reasonDigest: HASH,
        },
      ],
      correlationId: `corr-${f.suffix}`,
    },
    {
      eventType: 'journey.segment_entry.recorded',
      orderingKey: `${f.contactId}:${f.segmentId}`,
      payload: { contractVersion: 1 },
      payloadHash: HASH,
    },
  );
  const enrollment = await f.owner.jrEnrollment.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  return enrollment.id;
}

async function ownerAction(f: Fixture, enrollmentId: string, actionKey: string) {
  return f.actions.ensureAction({
    tenantId: f.tenantId,
    actionKey,
    enrollmentId,
    kind: 'ENSURE_CASE',
    requestHash: 'b'.repeat(64),
    correlationId: `corr-${f.suffix}`,
    commandId: `command-${randomUUID()}`,
  });
}

test('pre-barrier: action ที่ owner ยังไม่ ack ถูกสั่งยกเลิกพร้อมเข้าคิว cancel command', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  const actionKey = `action-${f.suffix}`;
  await ownerAction(f, enrollmentId, actionKey);

  await queueRefilter(f, 2, 'LEFT', entryId);
  const outcome = await processor(f, {
    status: 'NOT_ELIGIBLE',
    reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
  }).executeNext(f.tenantId, 'worker-1');
  assert.equal(outcome, 'CANCELLED');

  const action = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(action.state, 'CANCEL_REQUESTED');

  // cancel command ต้องเข้าคิวด้วย binding เดิมของ action
  const cancelCommand = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId, commandId: `cancel:segment-refilter:${actionKey}` },
  });
  assert.equal(cancelCommand.actionKey, actionKey);
  assert.equal(cancelCommand.state, 'PENDING');

  // enrollment ต้องจบด้วยเหตุ CANCELLED
  const enrollment = await f.owner.jrEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  assert.equal(enrollment.runState, 'TERMINAL');
  assert.equal(enrollment.terminalReason, 'CANCELLED');
  assert.equal(enrollment.state, 'BLOCKED');
});

test('post-barrier: action ที่ owner ack แล้วไม่ถูกแตะ เพราะ owner fact ลบไม่ได้', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  const actionKey = `action-${f.suffix}`;
  await ownerAction(f, enrollmentId, actionKey);
  // owner สร้าง Case จริงไปแล้ว — ผ่าน barrier
  await f.owner.jrOwnerAction.updateMany({
    where: { tenantId: f.tenantId, actionKey },
    data: { state: 'ACKNOWLEDGED' },
  });

  await queueRefilter(f, 2, 'LEFT', entryId);
  assert.equal(
    await processor(f, {
      status: 'NOT_ELIGIBLE',
      reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
    }).executeNext(f.tenantId, 'worker-1'),
    'CANCELLED',
  );

  const action = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(action.state, 'ACKNOWLEDGED', 'ของที่ owner สร้างแล้วห้ามถูกย้อน');
  assert.equal(
    await f.owner.jrOwnerCommandOutbox.count({
      where: { tenantId: f.tenantId, commandId: `cancel:segment-refilter:${actionKey}` },
    }),
    0,
    'ห้ามสั่งยกเลิกสิ่งที่ยกเลิกไม่ได้',
  );
});

test('enrollment ที่จบด้วยเหตุอื่นแล้วห้ามถูกเขียนทับเป็น CANCELLED', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  // ถึงเป้าหมายไปก่อนแล้ว — first-terminal-commit-wins
  await f.owner.jrEnrollment.update({
    where: { id: enrollmentId },
    data: { runState: 'TERMINAL', terminalReason: 'GOAL_REACHED', state: 'AUTHORIZED' },
  });

  await queueRefilter(f, 2, 'LEFT', entryId);
  await processor(f, {
    status: 'NOT_ELIGIBLE',
    reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
  }).executeNext(f.tenantId, 'worker-1');

  const enrollment = await f.owner.jrEnrollment.findUniqueOrThrow({ where: { id: enrollmentId } });
  assert.equal(enrollment.terminalReason, 'GOAL_REACHED', 'เหตุผลที่จบต้องบันทึกครั้งเดียว');
  assert.equal(enrollment.state, 'AUTHORIZED');
});

test('ยกเลิกซ้ำไม่สั่ง owner ยกเลิกเป็นครั้งที่สอง', async (t) => {
  const f = await fixture(t);
  const entryId = `entry-${f.suffix}`;
  const journeyId = await publishJourney(f);
  const enrollmentId = await enrollFor(f, entryId, journeyId);
  const actionKey = `action-${f.suffix}`;
  await ownerAction(f, enrollmentId, actionKey);

  for (const revision of [2, 3]) {
    await queueRefilter(f, revision, 'LEFT', entryId);
    await new JourneySegmentRefilterProcessor(
      f.application,
      f.definitions,
      {
        membershipReader: reader({
          status: 'NOT_ELIGIBLE',
          reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE',
        }) as never,
        teamContactScopeAuthorizer: authorizer(ALLOW) as never,
      },
      { now: () => new Date(Date.now() + revision * 120_000) },
    ).executeNext(f.tenantId, `worker-${revision}`);
  }

  // commandId คำนวณจาก actionKey จึง upsert ทับใบเดิม ไม่ใช่สั่งซ้ำ
  assert.equal(
    await f.owner.jrOwnerCommandOutbox.count({
      where: { tenantId: f.tenantId, commandId: `cancel:segment-refilter:${actionKey}` },
    }),
    1,
  );
});
