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
    name: 'Overdue debt collection',
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

test('createVersion creates the first DRAFT version and returns the same value on retry with the same input', async (t) => {
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

test('the same version with different content returns IDEMPOTENCY_CONFLICT and does not modify the existing row', async (t) => {
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

test('a non-contiguous version is rejected as NON_SEQUENTIAL_VERSION', async (t) => {
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

test('publishVersion changes to PUBLISHED once and a repeated retry is idempotent', async (t) => {
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

test('publish with a mismatched expectedContentHash is rejected as IDEMPOTENCY_CONFLICT', async (t) => {
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
        expectedContentHash: 'hash-mismatch',
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

test('publish of a version that does not exist returns VERSION_NOT_FOUND', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyDefinitionRepository(f.application, evaluator);

  await assert.rejects(
    () =>
      repository.publishVersion({
        tenantId: f.tenantId,
        journeyId: randomUUID(),
        version: 1,
        expectedContentHash: 'irrelevant',
        correlationId: 'publish-missing',
      }),
    (error: unknown) => {
      assert.ok(error instanceof JourneyVersionNotFoundError);
      assert.equal(error.code, 'VERSION_NOT_FOUND');
      return true;
    },
  );
});

test('publish of a version whose graph fails validation is rejected and the state does not change', async (t) => {
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

test('publish of a version whose ownerTeamId is not a real team in the same tenant is rejected', async (t) => {
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

test('J2.2: a definition using an INTERACTION_OUTCOME trigger and action intent steps can really be published', async (t) => {
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

test('J2.2: an outcomeType outside the allowlist is rejected at publish and the state does not change', async (t) => {
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

test('the same journeyId in different tenants is independent', async (t) => {
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
 * Creates a Customer 360 segment that a Journey can reference
 *
 * `published` = false simulates a segment that exists but is not yet announced — the head has no currentVersion,
 * which must be rejected just like a segment that does not exist
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
      // the lifecycle check of #213 requires PUBLISHED to have both effectiveFrom and publishedAt
      ...(published ? { effectiveFrom: new Date(), publishedAt: new Date() } : {}),
    },
  });
  await f.owner.c360SegmentDefinitionHead.create({
    data: {
      tenantId: f.tenantId,
      segmentId,
      // the state check of #213: headVersion 0 = no published version yet (current must be null)
      headVersion: published ? 1 : 0,
      ...(published ? { currentVersion: 1, currentDigest: 'a'.repeat(64) } : {}),
    },
  });
  return segmentId;
}

function segmentTrigger(segmentId: string) {
  return { kind: 'SEGMENT_ENTRY', segmentId, coalescingPolicy: 'PER_SEGMENT_ENTRY' } as const;
}

test('a SEGMENT_ENTRY that references an already published segment can publish and round-trips completely', async (t) => {
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
  // immutable snapshot: reading back must return every original field including the content hash
  const reread = await repository.getVersion(f.tenantId, journeyId, 1);
  assert.deepEqual(reread, published);
  assert.equal(reread?.contentHash, draft.contentHash);
});

test('a SEGMENT_ENTRY whose segment does not exist, belongs to another tenant or is not published is rejected with the same code', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const repository = new JourneyDefinitionRepository(f.application, evaluator);

  const foreign = await segment(other, `segment-foreign-${other.tenantId.slice(0, 8)}`);
  const draftOnly = await segment(f, `segment-draft-${f.tenantId.slice(0, 8)}`, false);
  const cases: Array<[string, string]> = [
    ['does not exist', `segment-missing-${f.tenantId.slice(0, 8)}`],
    ['belongs to another tenant', foreign],
    ['exists but is not published', draftOnly],
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
        // the same code in every case, otherwise the caller could guess whether that segmentId exists in another tenant
        assert.deepEqual(error.reasonCodes, ['SEGMENT_REFERENCE_UNTRUSTED']);
        return true;
      },
      `${label} must fail closed`,
    );
    // after rejection no PUBLISHED state may be left behind
    assert.equal((await repository.getVersion(f.tenantId, journeyId, 1))?.status, 'DRAFT');
  }
});

test('the SEGMENT_ENTRY definition keeps no attribute values or segment definition JSON at all', async (t) => {
  const f = await fixture(t);
  const journeyId = randomUUID();
  const segmentId = await segment(f, `segment-gold-${f.tenantId.slice(0, 8)}`);
  const repository = new JourneyDefinitionRepository(f.application, evaluator);
  await repository.createVersion(input(f, journeyId, { trigger: segmentTrigger(segmentId) }));

  const row = await f.owner.jrJourneyDefinition.findFirstOrThrow({
    where: { tenantId: f.tenantId, journeyId, version: 1 },
  });
  // the trigger must have exactly these three keys and no trace of the segment definition
  assert.deepEqual(row.trigger, segmentTrigger(segmentId));
  assert.deepEqual(Object.keys(row.trigger as object).sort(), [
    'coalescingPolicy',
    'kind',
    'segmentId',
  ]);

  /**
   * the whole row must contain nothing that belongs to Customer 360
   *
   * do not check for the word DC_EXPR or expressions across the whole row, because a BRANCH step in the Journey's own graph
   * legitimately uses DC_EXPR — what is forbidden is the segment definition/members/attribute values
   */
  const wire = JSON.stringify(row);
  for (const forbidden of [
    'contractVersion',
    'memberContactIds',
    'membershipSnapshot',
    'contentDigest',
    'evaluatorVersion',
  ]) {
    assert.doesNotMatch(wire, new RegExp(forbidden), `${forbidden} must not be persisted`);
  }
});

test('the original EVENT/SCHEDULE/INTERACTION_OUTCOME triggers still round-trip unchanged', async (t) => {
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

test('findPublishedByOutcomeTrigger does not mix in SEGMENT_ENTRY definitions', async (t) => {
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
