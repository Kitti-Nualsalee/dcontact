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
            next: 'ensure-case',
            onReject: 'exit-rejected',
          },
          {
            id: 'ensure-case',
            type: 'ENSURE_CASE',
            caseTypeId: 'case-type-collections',
            routingIntentRef: 'routing-collections-default',
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
