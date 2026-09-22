import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import type { AuthoringDocumentV1 } from '@d-contact/cxa-contracts';
import { JOURNEY_RUNTIME_CAPABILITIES } from './journey-authoring-canonical.js';
import { importJourneyDefinition } from './journey-authoring-compiler.js';
import {
  JourneyAuthoringError,
  type JourneyAuthoringAuthorizationPort,
} from './journey-authoring-model.js';
import {
  JourneyAuthoringRepository,
  type JourneyAuthoringCheckpoint,
  type JourneyCommandContext,
} from './journey-authoring-repository.js';
import type { JourneyDefinitionContent } from './journey-definition.js';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';
import {
  JourneyExecutionService,
  JourneyNotAcceptingEnrollmentsError,
} from './journey-execution.js';

const evaluator = new DcExprEvaluator();
const allow: JourneyAuthoringAuthorizationPort = {
  authorize: async () => ({ allowed: true, authorizationEpoch: 1, scopeVersion: 1 }),
};
const deny: JourneyAuthoringAuthorizationPort = {
  authorize: async () => ({ allowed: false, code: 'CAPABILITY_REQUIRED' }),
};

function fixture(name: string): JourneyDefinitionContent {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'test/fixtures/j5', `${name}.json`), 'utf8'),
  ) as JourneyDefinitionContent;
}

async function setup(t: TestContext) {
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
  const otherTenantId = randomUUID();
  const teamId = randomUUID();
  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: { id, name: `J5.2 ${id}`, slug: `j5-2-${id}`, sipDomain: `${id}.j5-2.test` },
    });
    await owner.jrAuthoringRolloutState.create({
      data: {
        tenantId: id,
        stage: 'INTERNAL_SYNTHETIC',
        canvasWriteEnabled: true,
        publishUiEnabled: true,
        updatedByRef: 'ops',
        evidenceRef: 'j5-2-test',
      },
    });
  }
  await owner.team.create({ data: { id: teamId, tenantId, name: `j5-2-${teamId}` } });

  t.after(async () => {
    const where = { tenantId: { in: [tenantId, otherTenantId] } };
    await owner.jrStepRun.deleteMany({ where });
    await owner.jrEnrollment.deleteMany({ where });
    await owner.jrScheduleOccurrence.deleteMany({ where });
    await owner.jrAuthoringOutbox.deleteMany({ where });
    await owner.jrAuthoringAudit.deleteMany({ where });
    await owner.jrAuthoringCommandReceipt.deleteMany({ where });
    await owner.jrReviewCandidate.deleteMany({ where });
    await owner.$transaction([
      owner.jrJourneyHead.deleteMany({ where }),
      owner.jrJourneyDraft.deleteMany({ where }),
    ]);
    await owner.jrJourneyDefinition.deleteMany({ where });
    await owner.jrAuthoringRolloutState.deleteMany({ where });
    await owner.team.deleteMany({ where });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const repository = (
    options: {
      authorization?: JourneyAuthoringAuthorizationPort;
      checkpoint?: (name: JourneyAuthoringCheckpoint) => void;
      capabilities?: typeof JOURNEY_RUNTIME_CAPABILITIES;
    } = {},
  ) =>
    new JourneyAuthoringRepository(application, {
      authorization: options.authorization ?? allow,
      evaluator,
      capabilities: options.capabilities,
      flags: { canvasWrite: true, publishUi: true },
      checkpoint: options.checkpoint,
    });

  const context = (key = `key-${randomUUID()}`, tenant = tenantId): JourneyCommandContext => ({
    tenantId: tenant,
    actor: { subjectId: 'author-1', correlationId: `corr-${randomUUID()}` },
    idempotencyKey: key,
  });

  const document = (name = 'j1-schedule'): AuthoringDocumentV1 =>
    importJourneyDefinition({ ...fixture(name), ownerTeamId: teamId });

  /** candidate ที่ APPROVED — ขั้น submit/vote เป็นของ J5.3 จึงสร้างตรงด้วย owner role */
  const approve = async (journeyId: string, repo = repository()) => {
    const head = await owner.jrJourneyHead.findUniqueOrThrow({
      where: { tenantId_journeyId: { tenantId, journeyId } },
    });
    const compiled = await repo.compileJourneyDraft(tenantId, context().actor, {
      journeyId,
      draftRevision: head.currentDraftRevision,
      draftDigest: head.currentDraftDigest,
    });
    const artifact = compiled.artifact!;
    const candidate = await owner.jrReviewCandidate.create({
      data: {
        tenantId,
        resourceKind: 'JOURNEY',
        resourceId: journeyId,
        draftRevision: head.currentDraftRevision,
        draftDigest: head.currentDraftDigest,
        compileDigest: artifact.compileDigest,
        runtimeHash: artifact.runtimeHash,
        baseHeadVersion: head.version,
        referenceDigest: artifact.referenceDigest,
        capabilityDigest: artifact.capabilityDigest,
        makerSubjectId: 'author-1',
        makerAuthorizationEpoch: 1,
        makerScopeVersion: 1,
        state: 'APPROVED',
      },
    });
    return {
      journeyId,
      reviewId: candidate.id,
      draftRevision: head.currentDraftRevision,
      draftDigest: head.currentDraftDigest,
      compileDigest: artifact.compileDigest,
      referenceDigest: artifact.referenceDigest,
      capabilityDigest: artifact.capabilityDigest,
      baseHeadVersion: head.version,
      baseHeadDigest: null,
      expectedHeadVersion: head.version,
    };
  };

  return {
    owner,
    application,
    tenantId,
    otherTenantId,
    teamId,
    repository,
    context,
    document,
    approve,
  };
}

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(
    promise,
    (error: unknown) => error instanceof JourneyAuthoringError && error.code === code,
  );

test('J5-ID01 draft CAS + idempotency: key เดิมได้ผลเดิม, key เดิม payload ต่าง conflict, stale ไม่เกิด revision', async (t) => {
  const f = await setup(t);
  const repo = f.repository();
  const createKey = `create-${randomUUID()}`;
  const created = await repo.createJourneyDraft(f.context(createKey), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  assert.equal(created.draftRevision, 1);
  assert.deepEqual(
    await repo.createJourneyDraft(f.context(createKey), {
      ownerTeamId: f.teamId,
      document: f.document(),
    }),
    created,
  );
  assert.equal(await f.owner.jrJourneyHead.count({ where: { tenantId: f.tenantId } }), 1);
  await rejects(
    repo.createJourneyDraft(f.context(createKey), {
      ownerTeamId: f.teamId,
      document: f.document('j1-event'),
    }),
    'IDEMPOTENCY_CONFLICT',
  );

  const edited = f.document();
  (edited.settings as { maxDurationDays: number }).maxDurationDays = 9;
  const cas = {
    journeyId: created.journeyId,
    expectedHeadVersion: created.headVersion,
    expectedDraftRevision: created.draftRevision,
    expectedDraftDigest: created.draftDigest,
  };
  const updated = await repo.updateJourneyDraft(f.context(), { ...cas, document: edited });
  assert.equal(updated.draftRevision, 2);
  assert.equal(updated.headVersion, 2);

  // CAS เก่าแพ้ และไม่มี revision ใหม่เกิดขึ้น — ไม่มี auto-merge
  const staleKey = `stale-${randomUUID()}`;
  await rejects(
    repo.updateJourneyDraft(f.context(staleKey), { ...cas, document: f.document() }),
    'PUBLISHED_HEAD_CONFLICT',
  );
  await rejects(
    repo.updateJourneyDraft(f.context(), {
      ...cas,
      expectedHeadVersion: updated.headVersion,
      document: f.document(),
    }),
    'DRAFT_VERSION_CONFLICT',
  );
  assert.equal(await f.owner.jrJourneyDraft.count({ where: { journeyId: created.journeyId } }), 2);
  // ผลล้มแบบ deterministic ถูกจำใน receipt: key เดิมได้ error เดิมแม้ภายหลังจะผ่านได้
  await rejects(
    repo.updateJourneyDraft(f.context(staleKey), { ...cas, document: f.document() }),
    'PUBLISHED_HEAD_CONFLICT',
  );

  // schema พังบันทึกไม่ได้ แต่ graph ไม่สมบูรณ์บันทึกได้พร้อม diagnostics
  await rejects(
    repo.updateJourneyDraft(f.context(), {
      ...cas,
      expectedHeadVersion: updated.headVersion,
      expectedDraftRevision: 2,
      expectedDraftDigest: updated.draftDigest,
      document: { ...edited, extra: 'x' },
    }),
    'AUTHORING_SCHEMA_INVALID',
  );
  const incomplete = { ...edited, edges: [] };
  const saved = await repo.updateJourneyDraft(f.context(), {
    ...cas,
    expectedHeadVersion: updated.headVersion,
    expectedDraftRevision: 2,
    expectedDraftDigest: updated.draftDigest,
    document: incomplete,
  });
  assert.ok(saved.diagnostics.some((item) => item.code === 'PORT_CARDINALITY_INVALID'));
});

test('J5-CC01 update พร้อมกันด้วย CAS เดียวกันชนะได้ตัวเดียว', async (t) => {
  const f = await setup(t);
  const repo = f.repository();
  const created = await repo.createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const cas = {
    journeyId: created.journeyId,
    expectedHeadVersion: 1,
    expectedDraftRevision: 1,
    expectedDraftDigest: created.draftDigest,
  };
  const variants = [3, 4, 5].map((days) => {
    const document = f.document();
    (document.settings as { maxDurationDays: number }).maxDurationDays = days;
    return repo.updateJourneyDraft(f.context(), { ...cas, document });
  });
  const settled = await Promise.allSettled(variants);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  for (const result of settled) {
    if (result.status === 'rejected') {
      assert.ok(result.reason instanceof JourneyAuthoringError);
      assert.ok(['PUBLISHED_HEAD_CONFLICT', 'DRAFT_VERSION_CONFLICT'].includes(result.reason.code));
    }
  }
  assert.equal(await f.owner.jrJourneyDraft.count({ where: { journeyId: created.journeyId } }), 2);
});

test('J5-AU02 rollout ปิดหรือไม่มีสิทธิ์ fail closed และ tenant อื่นมองไม่เห็น journey', async (t) => {
  const f = await setup(t);
  const created = await f.repository().createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  await rejects(
    f
      .repository({ authorization: deny })
      .createJourneyDraft(f.context(), { ownerTeamId: f.teamId, document: f.document() }),
    'CAPABILITY_REQUIRED',
  );
  const disabled = new JourneyAuthoringRepository(f.application, {
    authorization: allow,
    evaluator,
    flags: { canvasWrite: false, publishUi: false },
  });
  await rejects(
    disabled.createJourneyDraft(f.context(), { ownerTeamId: f.teamId, document: f.document() }),
    'DEPENDENCY_UNAVAILABLE',
  );
  await f.owner.jrAuthoringRolloutState.update({
    where: { tenantId: f.tenantId },
    data: { mutationFrozen: true, version: 2 },
  });
  await rejects(
    f
      .repository()
      .createJourneyDraft(f.context(), { ownerTeamId: f.teamId, document: f.document() }),
    'DEPENDENCY_UNAVAILABLE',
  );

  // foreign/missing ตอบ not-found แบบเดียวกัน
  await rejects(
    f.repository().getJourneyAuthoringState(f.otherTenantId, f.context().actor, created.journeyId),
    'JOURNEY_NOT_FOUND',
  );
  await rejects(
    f.repository().getJourneyAuthoringState(f.tenantId, f.context().actor, randomUUID()),
    'JOURNEY_NOT_FOUND',
  );
});

test('J5-ID01/RC01 publish atomic: key เดิมไม่ duplicate, resolve ด้วย key เดิม และ crash ไม่ทิ้ง state ครึ่งเดียว', async (t) => {
  const f = await setup(t);
  const created = await f.repository().createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const binding = await f.approve(created.journeyId);
  const publishKey = `publish-${randomUUID()}`;

  // crash หลังเขียน definition และหลังขยับ head: rollback ทั้งชุด ไม่มี version ค้าง
  for (const boundary of ['DEFINITION_PUBLISHED', 'HEAD_ACTIVATED'] as const) {
    const crashing = f.repository({
      checkpoint: (name) => {
        if (name === boundary) throw new Error(`crash at ${name}`);
      },
    });
    await assert.rejects(crashing.publishJourneyDraft(f.context(publishKey), binding), /crash at/);
    assert.equal(
      await f.owner.jrJourneyDefinition.count({ where: { journeyId: created.journeyId } }),
      0,
    );
    const resolved = await f.repository().resolvePublish(f.tenantId, {
      journeyId: created.journeyId,
      originalIdempotencyKey: publishKey,
    });
    assert.equal(resolved.outcome, 'NOT_COMMITTED');
  }

  const published = await f.repository().publishJourneyDraft(f.context(publishKey), binding);
  assert.equal(published.outcome, 'PUBLISHED');
  assert.equal(published.version, 1);
  // client ที่ไม่รู้ผลส่งซ้ำด้วย key เดิม: ได้ผลเดิม ไม่เกิด version ใหม่
  assert.deepEqual(
    await f.repository().publishJourneyDraft(f.context(publishKey), binding),
    published,
  );
  assert.deepEqual(
    await f.repository().resolvePublish(f.tenantId, {
      journeyId: created.journeyId,
      originalIdempotencyKey: publishKey,
    }),
    published,
  );
  assert.equal(
    await f.owner.jrJourneyDefinition.count({ where: { journeyId: created.journeyId } }),
    1,
  );

  const head = await f.owner.jrJourneyHead.findUniqueOrThrow({
    where: { tenantId_journeyId: { tenantId: f.tenantId, journeyId: created.journeyId } },
  });
  assert.equal(head.lifecycle, 'ACTIVE');
  assert.equal(head.activeVersion, 1);
  assert.equal(head.activeRuntimeHash, published.runtimeHash);
  const definition = await f.owner.jrJourneyDefinition.findUniqueOrThrow({
    where: {
      tenantId_journeyId_version: {
        tenantId: f.tenantId,
        journeyId: created.journeyId,
        version: 1,
      },
    },
  });
  assert.equal(definition.status, 'PUBLISHED');
  assert.equal(
    (await f.owner.jrReviewCandidate.findUniqueOrThrow({ where: { id: binding.reviewId } })).state,
    'SUPERSEDED',
  );
  // approval ที่ใช้ไปแล้วนำไป publish ซ้ำด้วย key ใหม่ไม่ได้
  await rejects(
    f.repository().publishJourneyDraft(f.context(), {
      ...binding,
      expectedHeadVersion: head.version,
      baseHeadVersion: head.version,
    }),
    'APPROVAL_REQUIRED',
  );

  // audit/outbox เป็น metadata เท่านั้น ไม่มี document หรือ graph
  const outbox = await f.owner.jrAuthoringOutbox.findMany({
    where: { resourceId: created.journeyId },
  });
  assert.ok(outbox.length >= 2);
  for (const row of outbox) {
    assert.deepEqual(Object.keys(row.payload as object).sort(), [
      'action',
      'aggregateVersion',
      'correlationId',
      'digest',
      'reasonCode',
      'resourceId',
      'resourceKind',
    ]);
  }
  assert.ok(
    (await f.owner.jrAuthoringAudit.findMany({ where: { resourceId: created.journeyId } })).some(
      (row) => row.action === 'JOURNEY_PUBLISHED' && row.afterDigest === published.runtimeHash,
    ),
  );
});

test('J5-CC02 stale draft/head/review/capability ไม่เกิด version ใหม่', async (t) => {
  const f = await setup(t);
  const repo = f.repository();
  const created = await repo.createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const binding = await f.approve(created.journeyId);

  // capability registry เปลี่ยนหลัง compile → artifact stale
  const changed = f.repository({
    capabilities: JOURNEY_RUNTIME_CAPABILITIES.map((capability) => ({ ...capability, version: 2 })),
  });
  await rejects(changed.publishJourneyDraft(f.context(), binding), 'COMPILE_ARTIFACT_STALE');
  await rejects(
    repo.publishJourneyDraft(f.context(), { ...binding, compileDigest: 'f'.repeat(64) }),
    'REVIEW_CANDIDATE_STALE',
  );

  // draft ขยับหลัง review: publish ด้วย binding เดิมต้องแพ้
  const edited = f.document();
  (edited.settings as { maxDurationDays: number }).maxDurationDays = 30;
  const updated = await repo.updateJourneyDraft(f.context(), {
    journeyId: created.journeyId,
    expectedHeadVersion: 1,
    expectedDraftRevision: 1,
    expectedDraftDigest: created.draftDigest,
    document: edited,
  });
  await rejects(repo.publishJourneyDraft(f.context(), binding), 'PUBLISHED_HEAD_CONFLICT');
  await rejects(
    repo.publishJourneyDraft(f.context(), { ...binding, expectedHeadVersion: updated.headVersion }),
    'DRAFT_VERSION_CONFLICT',
  );
  assert.equal(
    await f.owner.jrJourneyDefinition.count({ where: { journeyId: created.journeyId } }),
    0,
  );

  // compile ของ revision เก่ายังคืนผลได้แต่ติดธง stale
  const stale = await repo.compileJourneyDraft(f.tenantId, f.context().actor, {
    journeyId: created.journeyId,
    draftRevision: 1,
    draftDigest: created.draftDigest,
  });
  assert.equal(stale.stale, true);
  assert.ok(stale.artifact);
});

test('J5-RC02 lifecycle: PAUSED หยุด enrollment ใหม่แต่ของเดิมเดินต่อ, DEPRECATED แก้ไม่ได้, roll-forward/clone/discard', async (t) => {
  const f = await setup(t);
  const repo = f.repository();
  const created = await repo.createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const published = await repo.publishJourneyDraft(f.context(), await f.approve(created.journeyId));
  const execution = new JourneyExecutionService(
    f.application,
    new JourneyDefinitionRepository(f.application, evaluator),
    evaluator,
  );
  const enroll = (at: string) =>
    execution.enrollFromSchedule(f.tenantId, {
      journeyId: created.journeyId,
      journeyVersion: published.version!,
      occurrenceAt: at,
      correlationId: 'corr',
    });
  const before = await enroll('2026-09-01T09:00:00.000Z');

  let head = await f.owner.jrJourneyHead.findUniqueOrThrow({
    where: { tenantId_journeyId: { tenantId: f.tenantId, journeyId: created.journeyId } },
  });
  const paused = await repo.changeJourneyLifecycle(f.context(), {
    journeyId: created.journeyId,
    target: 'PAUSED',
    expectedHeadVersion: head.version,
    reasonCode: 'OPERATOR_PAUSE',
  });
  await assert.rejects(enroll('2026-09-08T09:00:00.000Z'), JourneyNotAcceptingEnrollmentsError);
  // replay ของ occurrence เดิมยังได้ enrollment ใบเดิม และ enrollment เดิมยังเดินต่อ
  assert.equal((await enroll('2026-09-01T09:00:00.000Z')).enrollmentId, before.enrollmentId);
  const advanced = await execution.advance(f.tenantId, before.enrollmentId, {
    correlationId: 'corr',
  });
  assert.equal(advanced.kind, 'AWAITING_SEND');

  await rejects(
    repo.changeJourneyLifecycle(f.context(), {
      journeyId: created.journeyId,
      target: 'PAUSED',
      expectedHeadVersion: paused.headVersion,
      reasonCode: 'X',
    }),
    'JOURNEY_LIFECYCLE_CONFLICT',
  );
  const resumed = await repo.changeJourneyLifecycle(f.context(), {
    journeyId: created.journeyId,
    target: 'ACTIVE',
    expectedHeadVersion: paused.headVersion,
    reasonCode: 'OPERATOR_RESUME',
  });
  assert.ok(await enroll('2026-09-15T09:00:00.000Z'));

  // roll-forward: draft ใหม่จาก version เดิม, clone: journey ใหม่ที่ไม่มี enrollment ติดไป
  const rolled = await repo.createRollForwardFromVersion(f.context(), {
    journeyId: created.journeyId,
    sourceVersion: 1,
    expectedHeadVersion: resumed.headVersion,
  });
  assert.equal(rolled.draftRevision, 2);
  const discarded = await repo.discardJourneyDraft(f.context(), {
    journeyId: created.journeyId,
    expectedHeadVersion: rolled.headVersion,
    expectedDraftRevision: rolled.draftRevision,
    expectedDraftDigest: rolled.draftDigest,
    reasonCode: 'DISCARD',
  });
  assert.equal(discarded.draftDigest, rolled.draftDigest);
  const cloned = await repo.cloneJourneyFromVersion(f.context(), {
    journeyId: created.journeyId,
    version: 1,
    targetOwnerTeamId: f.teamId,
    name: 'cloned',
  });
  assert.notEqual(cloned.journeyId, created.journeyId);
  assert.equal(await f.owner.jrEnrollment.count({ where: { journeyId: cloned.journeyId } }), 0);

  head = await f.owner.jrJourneyHead.findUniqueOrThrow({
    where: { tenantId_journeyId: { tenantId: f.tenantId, journeyId: created.journeyId } },
  });
  await repo.changeJourneyLifecycle(f.context(), {
    journeyId: created.journeyId,
    target: 'DEPRECATED',
    expectedHeadVersion: head.version,
    reasonCode: 'RETIRED',
  });
  head = await f.owner.jrJourneyHead.findUniqueOrThrow({
    where: { tenantId_journeyId: { tenantId: f.tenantId, journeyId: created.journeyId } },
  });
  await rejects(
    repo.updateJourneyDraft(f.context(), {
      journeyId: created.journeyId,
      expectedHeadVersion: head.version,
      expectedDraftRevision: head.currentDraftRevision,
      expectedDraftDigest: head.currentDraftDigest,
      document: f.document(),
    }),
    'JOURNEY_LIFECYCLE_CONFLICT',
  );
  await assert.rejects(enroll('2026-09-22T09:00:00.000Z'), JourneyNotAcceptingEnrollmentsError);
});
