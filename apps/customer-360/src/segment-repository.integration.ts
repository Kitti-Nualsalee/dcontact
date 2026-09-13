import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import type { C360SegmentDefinitionContentV1 } from './segment-definition.js';
import { C360SegmentEvaluator } from './segment-evaluator.js';
import { C360SegmentRepository, C360SegmentRepositoryError } from './segment-repository.js';

const OWNER_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public';
const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

function definition(name: string, balanceThreshold = 1000): C360SegmentDefinitionContentV1 {
  return {
    contractVersion: 1,
    name,
    expression: {
      language: 'DC_EXPR',
      version: 1,
      expression: {
        type: 'and',
        operands: [
          {
            type: 'comparison',
            operator: 'eq',
            left: { type: 'ref', path: ['contact', 'tier'] },
            right: { type: 'literal', value: 'GOLD' },
          },
          {
            type: 'comparison',
            operator: 'gt',
            left: { type: 'ref', path: ['vars', 'outstandingBalance'] },
            right: { type: 'literal', value: balanceThreshold },
          },
        ],
      },
    },
  };
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_DATABASE_URL } } });
  const application = new PrismaClient({
    datasources: { db: { url: APPLICATION_DATABASE_URL } },
  });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const contactId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  t.after(async () => {
    await owner.c360SegmentEvaluation.deleteMany({ where: { tenantId } });
    await owner.c360FactSnapshot.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinitionHead.deleteMany({ where: { tenantId } });
    await owner.c360SegmentDefinition.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.createMany({
    data: [
      {
        id: tenantId,
        name: `C360 ${suffix}`,
        slug: `c360-${suffix}`,
        sipDomain: `${suffix}.c360.test`,
      },
      {
        id: otherTenantId,
        name: `C360 other ${suffix}`,
        slug: `c360-other-${suffix}`,
        sipDomain: `${suffix}.other.c360.test`,
      },
    ],
  });
  await owner.contact.create({ data: { id: contactId, tenantId } });

  const repository = new C360SegmentRepository(
    application,
    new C360SegmentEvaluator(new DcExprEvaluator()),
  );
  return { owner, application, repository, tenantId, otherTenantId, contactId };
}

async function publishFirst(
  f: Awaited<ReturnType<typeof fixture>>,
  segmentId: string,
  content: C360SegmentDefinitionContentV1 = definition('ลูกค้าทดสอบ'),
) {
  const draft = await f.repository.createVersion({
    tenantId: f.tenantId,
    segmentId,
    version: 1,
    definition: content,
    correlationId: 'correlation:c360:create',
  });
  return f.repository.publishVersion({
    tenantId: f.tenantId,
    segmentId,
    version: 1,
    expectedContentDigest: draft.contentDigest,
    expectedHeadVersion: 0,
  });
}

test('definition/snapshot เดิมให้ evaluation record เดิมข้าม retry และ repository restart', async (t) => {
  const f = await fixture(t);
  const segmentId = 'segment:gold-overdue';
  const published = await publishFirst(f, segmentId);
  const snapshot = await f.repository.recordFactSnapshot({
    tenantId: f.tenantId,
    contactId: f.contactId,
    snapshotVersion: 1,
    attributes: {
      tier: { type: 'STRING', value: 'GOLD' },
      crmLabel: { type: 'STRING', value: 'synthetic-owner-only-label' },
    },
    computed: { outstandingBalance: { type: 'NUMBER', value: 2500 } },
    sourceCutoffAt: '2026-09-13T04:00:00.000Z',
    correlationId: 'correlation:c360:snapshot',
  });
  const input = {
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId,
    segmentDefinitionVersion: published.definition.version,
    snapshotVersion: snapshot.snapshotVersion,
  };
  const first = await f.repository.evaluateStored(input);
  const restarted = new C360SegmentRepository(
    f.application,
    new C360SegmentEvaluator(new DcExprEvaluator()),
  );
  const retry = await restarted.evaluateStored(input);

  assert.deepEqual(retry, first);
  assert.equal(first.outcome, 'MATCH');
  assert.equal(first.matched, true);
  assert.equal(await f.owner.c360SegmentEvaluation.count({ where: { tenantId: f.tenantId } }), 1);
  const storedEvaluation = await f.owner.c360SegmentEvaluation.findUniqueOrThrow({
    where: { id: first.id },
  });
  assert.doesNotMatch(JSON.stringify(storedEvaluation), /synthetic-owner-only-label|GOLD|2500/);
});

test('version create/publish ใช้ idempotency, sequence และ CAS ให้ concurrent publish มี winner เดียว', async (t) => {
  const f = await fixture(t);
  const segmentId = 'segment:cas';
  const first = await publishFirst(f, segmentId, definition('CAS v1', 1000));
  const second = await f.repository.createVersion({
    tenantId: f.tenantId,
    segmentId,
    version: 2,
    definition: definition('CAS v2', 2000),
    correlationId: 'correlation:c360:v2',
  });
  const third = await f.repository.createVersion({
    tenantId: f.tenantId,
    segmentId,
    version: 3,
    definition: definition('CAS v3', 3000),
    correlationId: 'correlation:c360:v3',
  });

  const attempts = await Promise.allSettled([
    f.repository.publishVersion({
      tenantId: f.tenantId,
      segmentId,
      version: 2,
      expectedContentDigest: second.contentDigest,
      expectedHeadVersion: first.headVersion,
    }),
    f.repository.publishVersion({
      tenantId: f.tenantId,
      segmentId,
      version: 3,
      expectedContentDigest: third.contentDigest,
      expectedHeadVersion: first.headVersion,
    }),
  ]);
  const fulfilled = attempts.filter((attempt) => attempt.status === 'fulfilled');
  const rejected = attempts.filter((attempt) => attempt.status === 'rejected');
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(
    rejected[0]?.status === 'rejected' &&
      rejected[0].reason instanceof C360SegmentRepositoryError &&
      rejected[0].reason.code === 'VERSION_CONFLICT',
  );
  assert.equal(
    await f.owner.c360SegmentDefinition.count({
      where: { tenantId: f.tenantId, segmentId, status: 'PUBLISHED' },
    }),
    1,
  );
});

test('published definition, fact snapshot และ evaluation checkpoint แก้ย้อนหลังไม่ได้', async (t) => {
  const f = await fixture(t);
  const segmentId = 'segment:immutable';
  const published = await publishFirst(f, segmentId);
  const snapshot = await f.repository.recordFactSnapshot({
    tenantId: f.tenantId,
    contactId: f.contactId,
    snapshotVersion: 1,
    attributes: { tier: { type: 'STRING', value: 'GOLD' } },
    computed: { outstandingBalance: { type: 'NUMBER', value: 2500 } },
    sourceCutoffAt: '2026-09-13T04:00:00.000Z',
    correlationId: 'correlation:c360:immutable',
  });
  const evaluation = await f.repository.evaluateStored({
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId,
    segmentDefinitionVersion: 1,
    snapshotVersion: 1,
  });

  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.c360SegmentDefinition.update({
        where: { id: published.definition.id },
        data: { definition: { changed: true } },
      }),
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.c360FactSnapshot.update({
        where: { id: snapshot.id },
        data: { contentDigest: 'b'.repeat(64) },
      }),
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.c360SegmentEvaluation.update({
        where: { id: evaluation.id },
        data: { evaluationDigest: 'c'.repeat(64) },
      }),
    ),
  );

  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.c360SegmentDefinition.create({
        data: {
          id: randomUUID(),
          tenantId: f.tenantId,
          segmentId: 'segment:invalid-direct-publish',
          version: 1,
          status: 'PUBLISHED',
          definition: definition('invalid direct publish') as unknown as Prisma.InputJsonValue,
          contentDigest: 'a'.repeat(64),
          evaluatorVersion: 'C360_SEGMENT_EVALUATOR_V1',
          correlationId: 'correlation:c360:invalid-direct-publish',
        },
      }),
    ),
  );

  await assert.rejects(
    f.owner.c360SegmentEvaluation.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        contactId: f.contactId,
        segmentId,
        segmentDefinitionVersion: 1,
        snapshotVersion: 1,
        outcome: 'MATCH',
        matched: false,
        inputDigest: 'd'.repeat(64),
        evaluationDigest: 'e'.repeat(64),
        evaluatorVersion: 'C360_SEGMENT_EVALUATOR_V1',
      },
    }),
  );
});

test('tenant RLS และ foreign contact/segment reference fail closed เป็น NOT_FOUND', async (t) => {
  const f = await fixture(t);
  const segmentId = 'segment:tenant-bound';
  await publishFirst(f, segmentId);

  assert.equal(await f.repository.getVersion(f.otherTenantId, segmentId, 1), undefined);
  await assert.rejects(
    () =>
      f.repository.recordFactSnapshot({
        tenantId: f.otherTenantId,
        contactId: f.contactId,
        snapshotVersion: 1,
        attributes: {},
        computed: {},
        sourceCutoffAt: '2026-09-13T04:00:00.000Z',
        correlationId: 'correlation:c360:foreign',
      }),
    (error: unknown) =>
      error instanceof C360SegmentRepositoryError && error.code === 'RESOURCE_NOT_FOUND',
  );
});

test('type mismatch persist เป็น ERROR checkpoint และไม่กลายเป็น positive match', async (t) => {
  const f = await fixture(t);
  const segmentId = 'segment:type-mismatch';
  await publishFirst(f, segmentId, {
    contractVersion: 1,
    name: 'typed mismatch fixture',
    expression: {
      language: 'DC_EXPR',
      version: 1,
      expression: {
        type: 'comparison',
        operator: 'gt',
        left: { type: 'ref', path: ['contact', 'tier'] },
        right: { type: 'literal', value: 1 },
      },
    },
  });
  await f.repository.recordFactSnapshot({
    tenantId: f.tenantId,
    contactId: f.contactId,
    snapshotVersion: 1,
    attributes: { tier: { type: 'STRING', value: 'GOLD' } },
    computed: {},
    sourceCutoffAt: '2026-09-13T04:00:00.000Z',
    correlationId: 'correlation:c360:type-error',
  });
  const result = await f.repository.evaluateStored({
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId,
    segmentDefinitionVersion: 1,
    snapshotVersion: 1,
  });
  assert.equal(result.outcome, 'ERROR');
  assert.equal(result.matched, false);
  assert.equal(result.errorCode, 'TYPE_MISMATCH');
  const row = await f.owner.c360SegmentEvaluation.findUniqueOrThrow({ where: { id: result.id } });
  assert.equal(row.matched, null);
});
