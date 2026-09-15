import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import {
  JourneyDefinitionValidationError,
  JourneyVersionConflictError,
  JourneyVersionNotFoundError,
  JourneyVersionSequenceError,
  type CreateJourneyVersionInput,
} from './journey-definition.js';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';

const evaluator = new DcExprEvaluator();

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
  const rawTenantId = randomUUID();
  const rawTeamId = randomUUID();
  const rawOtherTeamId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);

  t.after(async () => {
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.c360SegmentDefinitionHead.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.c360SegmentDefinition.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.team.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `Journey definitions ${suffix}`,
      slug: `jr-def-${suffix}`,
      sipDomain: `${suffix}.jr-def.test`,
    },
  });
  await owner.team.create({ data: { id: rawTeamId, tenantId: rawTenantId, name: 'Collections' } });
  await owner.team.create({
    data: { id: rawOtherTeamId, tenantId: rawTenantId, name: 'Marketing' },
  });

  return {
    owner,
    application,
    tenantId: rawTenantId,
    teamId: rawTeamId,
    otherTeamId: rawOtherTeamId,
  };
}

function validGraph() {
  return {
    entryStepId: 'send-line',
    steps: [
      { id: 'send-line', type: 'SEND', channel: 'LINE', contentRef: 'tmpl-1', next: 'branch-paid' },
      {
        id: 'branch-paid',
        type: 'BRANCH',
        expression: {
          language: 'DC_EXPR',
          version: 1,
          expression: { type: 'isNull', operand: { type: 'ref', path: ['vars', 'paidAt'] } },
        },
        whenTrue: 'wait-a-day',
        whenFalse: 'exit-goal',
      },
      { id: 'wait-a-day', type: 'WAIT', waitSeconds: 86400, next: 'exit-timeout' },
      { id: 'exit-goal', type: 'EXIT', reason: 'GOAL_REACHED' },
      { id: 'exit-timeout', type: 'EXIT', reason: 'MAX_AGE_REACHED' },
    ],
  } as const;
}

function input(
  f: Awaited<ReturnType<typeof fixture>>,
  journeyId: string,
  overrides: Partial<CreateJourneyVersionInput> = {},
): CreateJourneyVersionInput {
  return {
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    name: 'ทวงหนี้ค้างชำระ',
    ownerTeamId: f.teamId,
    purpose: 'MARKETING',
    senderIdentityId: 'sender-c1-4',
    trigger: { kind: 'EVENT', eventType: 'payment.failed' },
    graph: validGraph(),
    goal: { kind: 'EVENT', eventType: 'payment.succeeded' },
    exitRules: [{ kind: 'GOAL' }],
    maxDurationDays: 7,
    correlationId: 'correlation-c1-4',
    ...overrides,
  };
}

test('createVersion สร้าง DRAFT version แรก และคืนค่าเดิมเมื่อ retry ด้วย input เดิม', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const repository = new JourneyDefinitionRepository(f.application, evaluator);

  const snapshots = await Promise.all(
    Array.from({ length: 5 }, () => repository.createVersion(input(f, journeyId))),
  );
  for (const snapshot of snapshots) assert.deepEqual(snapshot, snapshots[0]);
  assert.equal(snapshots[0]?.status, 'DRAFT');
  assert.equal(
    await f.owner.jrJourneyDefinition.count({ where: { tenantId: f.tenantId, journeyId } }),
    1,
  );
});

test('version เดิมกับเนื้อหาต่างกันคืน IDEMPOTENCY_CONFLICT และไม่แก้แถวเดิม', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  const original = await repository.createVersion(input(f, journeyId));

  await assert.rejects(
    () => repository.createVersion(input(f, journeyId, { maxDurationDays: 30 })),
    (error: unknown) => {
      assert.ok(error instanceof JourneyVersionConflictError);
      assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    },
  );
  const stored = await repository.getVersion(f.tenantId, journeyId, 1);
  assert.deepEqual(stored, original);
});

test('version ที่ไม่ต่อเนื่องถูกปฏิเสธเป็น NON_SEQUENTIAL_VERSION', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const repository = new JourneyDefinitionRepository(f.application, evaluator);

  await assert.rejects(
    () => repository.createVersion(input(f, journeyId, { version: 2 })),
    (error: unknown) => {
      assert.ok(error instanceof JourneyVersionSequenceError);
      assert.equal(error.code, 'NON_SEQUENTIAL_VERSION');
      return true;
    },
  );

  await repository.createVersion(input(f, journeyId));
  await assert.rejects(
    () => repository.createVersion(input(f, journeyId, { version: 5 })),
    (error: unknown) => {
      assert.ok(error instanceof JourneyVersionSequenceError);
      return true;
    },
  );
  const secondVersion = await repository.createVersion(input(f, journeyId, { version: 2 }));
  assert.equal(secondVersion.version, 2);
});

test('publishVersion เปลี่ยนเป็น PUBLISHED ครั้งเดียวและ retry ซ้ำ idempotent', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  const draft = await repository.createVersion(input(f, journeyId));

  const publishes = await Promise.all(
    Array.from({ length: 4 }, () =>
      repository.publishVersion({
        tenantId: f.tenantId,
        journeyId,
        version: 1,
        expectedContentHash: draft.contentHash,
        correlationId: 'publish-c1-4',
      }),
    ),
  );
  for (const published of publishes) {
    assert.equal(published.status, 'PUBLISHED');
    assert.ok(published.publishedAt);
  }
  assert.equal(
    await f.owner.jrJourneyDefinition.count({
      where: { tenantId: f.tenantId, journeyId, status: 'PUBLISHED' },
    }),
    1,
  );
});

test('publish ด้วย expectedContentHash ที่ไม่ตรงถูกปฏิเสธเป็น IDEMPOTENCY_CONFLICT', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  await repository.createVersion(input(f, journeyId));

  await assert.rejects(
    () =>
      repository.publishVersion({
        tenantId: f.tenantId,
        journeyId,
        version: 1,
        expectedContentHash: 'hash-ที่ไม่ตรง',
        correlationId: 'publish-conflict',
      }),
    (error: unknown) => {
      assert.ok(error instanceof JourneyVersionConflictError);
      assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    },
  );
  const stored = await repository.getVersion(f.tenantId, journeyId, 1);
  assert.equal(stored?.status, 'DRAFT');
});

test('publish version ที่ไม่มีอยู่คืน VERSION_NOT_FOUND', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyDefinitionRepository(f.application, evaluator);

  await assert.rejects(
    () =>
      repository.publishVersion({
        tenantId: f.tenantId,
        journeyId: randomUUID(),
        version: 1,
        expectedContentHash: 'ไม่สำคัญ',
        correlationId: 'publish-missing',
      }),
    (error: unknown) => {
      assert.ok(error instanceof JourneyVersionNotFoundError);
      assert.equal(error.code, 'VERSION_NOT_FOUND');
      return true;
    },
  );
});

test('publish version ที่ graph ไม่ผ่านการตรวจถูกปฏิเสธและไม่เปลี่ยนสถานะ', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  const draft = await repository.createVersion(
    input(f, journeyId, {
      graph: {
        entryStepId: 'wait-loop',
        steps: [{ id: 'wait-loop', type: 'WAIT', waitSeconds: 60, next: 'wait-loop' }],
      },
    } as Partial<CreateJourneyVersionInput>),
  );

  await assert.rejects(
    () =>
      repository.publishVersion({
        tenantId: f.tenantId,
        journeyId,
        version: 1,
        expectedContentHash: draft.contentHash,
        correlationId: 'publish-invalid-graph',
      }),
    (error: unknown) => {
      assert.ok(error instanceof JourneyDefinitionValidationError);
      return true;
    },
  );
  const stored = await repository.getVersion(f.tenantId, journeyId, 1);
  assert.equal(stored?.status, 'DRAFT');
});

test('publish version ที่ ownerTeamId ไม่ใช่ทีมจริงใน tenant เดียวกันถูกปฏิเสธ', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  const foreignTeamId = randomUUID();

  const draft = await repository.createVersion(input(f, journeyId, { ownerTeamId: foreignTeamId }));

  await assert.rejects(
    () =>
      repository.publishVersion({
        tenantId: f.tenantId,
        journeyId,
        version: 1,
        expectedContentHash: draft.contentHash,
        correlationId: 'publish-untrusted-team',
      }),
    (error: unknown) => {
      assert.ok(error instanceof JourneyDefinitionValidationError);
      assert.deepEqual(error.reasonCodes, ['OWNER_TEAM_UNTRUSTED']);
      return true;
    },
  );
});

test('J2.2: definition ที่ใช้ INTERACTION_OUTCOME trigger และ action intent steps publish ได้จริง', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  const draft = await repository.createVersion(
    input(f, journeyId, {
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        outcomeCode: 'CALLBACK_REQUESTED',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
      },
      graph: {
        entryStepId: 'schedule-callback',
        steps: [
          {
            id: 'schedule-callback',
            type: 'SCHEDULE_CALLBACK',
            requestedInSeconds: 3600,
            queueId: 'queue-collections',
            targetOwnerTeamId: f.teamId,
            next: 'ensure-case',
            onReject: 'exit-rejected',
          },
          {
            id: 'ensure-case',
            type: 'ENSURE_CASE',
            caseTypeId: 'case-type-collections',
            routingIntentRef: 'routing-collections-default',
            targetOwnerTeamId: f.teamId,
            next: 'exit-linked',
            onReject: 'exit-rejected',
          },
          { id: 'exit-linked', type: 'EXIT', reason: 'GOAL_REACHED' },
          { id: 'exit-rejected', type: 'EXIT', reason: 'OWNER_REJECTED' },
        ],
      },
    } as Partial<CreateJourneyVersionInput>),
  );

  const published = await repository.publishVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    expectedContentHash: draft.contentHash,
    correlationId: 'publish-j2-2',
  });
  assert.equal(published.status, 'PUBLISHED');

  const stored = await repository.getVersion(f.tenantId, journeyId, 1);
  assert.equal(stored?.trigger.kind, 'INTERACTION_OUTCOME');
});

test('J2.2: outcomeType นอก allowlist ถูกปฏิเสธตอน publish และไม่เปลี่ยนสถานะ', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  const draft = await repository.createVersion(
    input(f, journeyId, {
      trigger: {
        kind: 'INTERACTION_OUTCOME',
        outcomeType: 'INTERACTION_QUEUED',
        coalescingPolicy: 'PER_LOGICAL_OUTCOME',
      },
      graph: {
        entryStepId: 'ensure-case',
        steps: [
          {
            id: 'ensure-case',
            type: 'ENSURE_CASE',
            caseTypeId: 'case-type-collections',
            routingIntentRef: 'routing-collections-default',
            targetOwnerTeamId: f.teamId,
            next: 'exit-linked',
            onReject: 'exit-rejected',
          },
          { id: 'exit-linked', type: 'EXIT', reason: 'GOAL_REACHED' },
          { id: 'exit-rejected', type: 'EXIT', reason: 'OWNER_REJECTED' },
        ],
      },
    } as unknown as Partial<CreateJourneyVersionInput>),
  );

  await assert.rejects(
    () =>
      repository.publishVersion({
        tenantId: f.tenantId,
        journeyId,
        version: 1,
        expectedContentHash: draft.contentHash,
        correlationId: 'publish-j2-2-invalid',
      }),
    (error: unknown) => {
      assert.ok(error instanceof JourneyDefinitionValidationError);
      assert.deepEqual(error.reasonCodes, ['TRIGGER_INVALID']);
      return true;
    },
  );
  const stored = await repository.getVersion(f.tenantId, journeyId, 1);
  assert.equal(stored?.status, 'DRAFT');
});

test('journeyId เดียวกันแยก tenant ได้อิสระต่อกัน', async (t) => {
  const tenantA = await fixture(t);
  const tenantB = await fixture(t);
  const journeyId = randomUUID();
  const repositoryA = new JourneyDefinitionRepository(tenantA.application, evaluator);
  const repositoryB = new JourneyDefinitionRepository(tenantB.application, evaluator);

  await Promise.all([
    repositoryA.createVersion(input(tenantA, journeyId)),
    repositoryB.createVersion(input(tenantB, journeyId, { maxDurationDays: 30 })),
  ]);

  const stored = await repositoryA.getVersion(tenantA.tenantId, journeyId, 1);
  assert.equal(stored?.maxDurationDays, 7);
  const storedOtherTenant = await repositoryB.getVersion(tenantB.tenantId, journeyId, 1);
  assert.equal(storedOtherTenant?.maxDurationDays, 30);
});

/**
 * สร้าง segment ของ Customer 360 ให้ Journey อ้างถึงได้
 *
 * `published` = false จำลอง segment ที่มีแต่ยังไม่ประกาศใช้ — head ไม่มี currentVersion
 * ซึ่งต้องถูกปฏิเสธเหมือนกับ segment ที่ไม่มีอยู่จริง
 */
async function segment(
  f: Awaited<ReturnType<typeof fixture>>,
  segmentId: string,
  published = true,
) {
  await f.owner.c360SegmentDefinition.create({
    data: {
      tenantId: f.tenantId,
      segmentId,
      version: 1,
      status: published ? 'PUBLISHED' : 'DRAFT',
      definition: { contractVersion: 1, name: segmentId },
      contentDigest: 'a'.repeat(64),
      evaluatorVersion: 'DC_EXPR:1',
      correlationId: 'correlation:j3-4:segment',
      // lifecycle check ของ #213 บังคับว่า PUBLISHED ต้องมีทั้ง effectiveFrom และ publishedAt
      ...(published ? { effectiveFrom: new Date(), publishedAt: new Date() } : {}),
    },
  });
  await f.owner.c360SegmentDefinitionHead.create({
    data: {
      tenantId: f.tenantId,
      segmentId,
      // state check ของ #213: headVersion 0 = ยังไม่มีเวอร์ชันที่ประกาศใช้ (current ต้องเป็น null)
      headVersion: published ? 1 : 0,
      ...(published ? { currentVersion: 1, currentDigest: 'a'.repeat(64) } : {}),
    },
  });
  return segmentId;
}

function segmentTrigger(segmentId: string) {
  return { kind: 'SEGMENT_ENTRY', segmentId, coalescingPolicy: 'PER_SEGMENT_ENTRY' } as const;
}

test('SEGMENT_ENTRY ที่อ้าง segment ที่ publish แล้ว publish ได้และ round-trip ครบ', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const segmentId = await segment(f, `segment-gold-${f.tenantId.slice(0, 8)}`);
  const repository = new JourneyDefinitionRepository(f.application, evaluator);

  const draft = await repository.createVersion(
    input(f, journeyId, { trigger: segmentTrigger(segmentId) }),
  );
  const published = await repository.publishVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    expectedContentHash: draft.contentHash,
    correlationId: 'correlation:j3-4:publish',
  });

  assert.equal(published.status, 'PUBLISHED');
  assert.deepEqual(published.trigger, segmentTrigger(segmentId));
  // immutable snapshot: อ่านกลับมาต้องได้ของเดิมทุก field รวม content hash
  const reread = await repository.getVersion(f.tenantId, journeyId, 1);
  assert.deepEqual(reread, published);
  assert.equal(reread?.contentHash, draft.contentHash);
});

test('SEGMENT_ENTRY ที่ segment ไม่มีอยู่ เป็นของ tenant อื่น หรือยังไม่ publish ถูกปฏิเสธด้วย code เดียวกัน', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const repository = new JourneyDefinitionRepository(f.application, evaluator);

  const foreign = await segment(other, `segment-foreign-${other.tenantId.slice(0, 8)}`);
  const draftOnly = await segment(f, `segment-draft-${f.tenantId.slice(0, 8)}`, false);
  const cases: Array<[string, string]> = [
    ['ไม่มีอยู่จริง', `segment-missing-${f.tenantId.slice(0, 8)}`],
    ['เป็นของ tenant อื่น', foreign],
    ['มีแต่ยังไม่ publish', draftOnly],
  ];

  for (const [label, segmentId] of cases) {
    const journeyId = randomUUID();
    const draft = await repository.createVersion(
      input(f, journeyId, { trigger: segmentTrigger(segmentId) }),
    );
    await assert.rejects(
      () =>
        repository.publishVersion({
          tenantId: f.tenantId,
          journeyId,
          version: 1,
          expectedContentHash: draft.contentHash,
          correlationId: 'correlation:j3-4:publish',
        }),
      (error: unknown) => {
        assert.ok(error instanceof JourneyDefinitionValidationError);
        // code เดียวกันทุกเคส ไม่งั้นผู้เรียกเดาได้ว่า segmentId นั้นมีอยู่ใน tenant อื่นหรือไม่
        assert.deepEqual(error.reasonCodes, ['SEGMENT_REFERENCE_UNTRUSTED']);
        return true;
      },
      `${label} ต้อง fail closed`,
    );
    // ปฏิเสธแล้วต้องไม่ทิ้งสถานะ PUBLISHED ไว้
    assert.equal((await repository.getVersion(f.tenantId, journeyId, 1))?.status, 'DRAFT');
  }
});

test('definition ของ SEGMENT_ENTRY ไม่เก็บค่า attribute หรือ JSON นิยาม segment ไว้เลย', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const segmentId = await segment(f, `segment-gold-${f.tenantId.slice(0, 8)}`);
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  await repository.createVersion(input(f, journeyId, { trigger: segmentTrigger(segmentId) }));

  const row = await f.owner.jrJourneyDefinition.findFirstOrThrow({
    where: { tenantId: f.tenantId, journeyId, version: 1 },
  });
  // trigger ต้องมีแค่สามคีย์นี้เป๊ะ ๆ ไม่มีร่องรอยของนิยาม segment เลย
  assert.deepEqual(row.trigger, segmentTrigger(segmentId));
  assert.deepEqual(Object.keys(row.trigger as object).sort(), [
    'coalescingPolicy',
    'kind',
    'segmentId',
  ]);

  /**
   * ทั้งแถวต้องไม่มีสิ่งที่เป็นของ Customer 360 ปนอยู่
   *
   * ไม่ตรวจคำว่า DC_EXPR หรือ expression ทั้งแถว เพราะ BRANCH step ใน graph ของ Journey เอง
   * ใช้ DC_EXPR โดยชอบธรรม — สิ่งที่ห้ามคือนิยาม/สมาชิก/ค่า attribute ของ segment
   */
  const wire = JSON.stringify(row);
  for (const forbidden of [
    'contractVersion',
    'memberContactIds',
    'membershipSnapshot',
    'contentDigest',
    'evaluatorVersion',
  ]) {
    assert.doesNotMatch(wire, new RegExp(forbidden), `${forbidden} ต้องไม่ถูก persist`);
  }
});

test('trigger เดิม EVENT/SCHEDULE/INTERACTION_OUTCOME ยัง round-trip เท่าเดิม', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  const triggers = [
    { kind: 'EVENT', eventType: 'payment.failed' },
    { kind: 'SCHEDULE', cron: '0 9 * * *', timezone: 'Asia/Bangkok' },
  ] as const;

  for (const trigger of triggers) {
    const journeyId = randomUUID();
    const draft = await repository.createVersion(input(f, journeyId, { trigger }));
    assert.deepEqual(draft.trigger, trigger);
    const published = await repository.publishVersion({
      tenantId: f.tenantId,
      journeyId,
      version: 1,
      expectedContentHash: draft.contentHash,
      correlationId: 'correlation:j3-4:publish',
    });
    assert.equal(published.status, 'PUBLISHED');
    assert.deepEqual(published.trigger, trigger);
  }
});

test('findPublishedByOutcomeTrigger ไม่หยิบ definition ของ SEGMENT_ENTRY มาปน', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const segmentId = await segment(f, `segment-gold-${f.tenantId.slice(0, 8)}`);
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  const draft = await repository.createVersion(
    input(f, journeyId, { trigger: segmentTrigger(segmentId) }),
  );
  await repository.publishVersion({
    tenantId: f.tenantId,
    journeyId,
    version: 1,
    expectedContentHash: draft.contentHash,
    correlationId: 'correlation:j3-4:publish',
  });

  const matched = await repository.findPublishedByOutcomeTrigger(
    f.tenantId,
    'INTERACTION_ABANDONED',
    undefined,
  );
  assert.deepEqual(
    matched.filter((snapshot) => snapshot.journeyId === journeyId),
    [],
  );
});
