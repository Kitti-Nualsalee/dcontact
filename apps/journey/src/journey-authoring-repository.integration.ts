import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
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
  authorize: async () => ({
    allowed: true,
    source: 'DIRECT',
    delegationId: null,
    authorizationEpoch: 1,
    scopeVersion: 1,
    directReviewAuthority: false,
    authenticationStrength: 'STANDARD',
  }),
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
    await owner.jrOwnerAction.deleteMany({ where });
    await owner.jrEnrollment.deleteMany({ where });
    await owner.jrOutcomeReceipt.deleteMany({ where });
    await owner.jrScheduleOccurrence.deleteMany({ where });
    await owner.jrAuthoringOutbox.deleteMany({ where });
    await owner.jrAuthoringAudit.deleteMany({ where });
    await owner.jrAuthoringCommandReceipt.deleteMany({ where });
    await owner.jrReviewDecisionRecord.deleteMany({ where });
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

  /** APPROVED candidate — the submit/vote step belongs to J5.3, so it is created directly with the owner role */
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
    // one independent vote — J5.3 rechecks the approver's epoch/scope again at publish
    await owner.jrReviewDecisionRecord.create({
      data: {
        tenantId,
        candidateId: candidate.id,
        decision: 'APPROVE',
        reviewerSubjectId: 'reviewer-1',
        capability: 'journey.review',
        capabilitySource: 'DIRECT',
        authorizationEpoch: 1,
        scopeVersion: 1,
        evidenceRef: 'evidence',
        reasonCode: 'APPROVED',
        decidedAt: new Date(),
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

test('J5-ID01 draft CAS + idempotency: same key gets the same result, same key with a different payload conflicts, stale creates no revision', async (t) => {
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

  // the old CAS loses and no new revision is created — no auto-merge
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
  // a deterministic failure is remembered in the receipt: the same key gets the same error even if it would pass later
  await rejects(
    repo.updateJourneyDraft(f.context(staleKey), { ...cas, document: f.document() }),
    'PUBLISHED_HEAD_CONFLICT',
  );

  // a broken schema cannot be saved, but an incomplete graph can be saved with diagnostics
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

test('J5-CC01 concurrent updates with the same CAS: only one wins', async (t) => {
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

test('J5-AU02 rollout off or no permission fails closed and other tenants cannot see the journey', async (t) => {
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

  // foreign/missing answer with the same not-found
  await rejects(
    f.repository().getJourneyAuthoringState(f.otherTenantId, f.context().actor, created.journeyId),
    'JOURNEY_NOT_FOUND',
  );
  await rejects(
    f.repository().getJourneyAuthoringState(f.tenantId, f.context().actor, randomUUID()),
    'JOURNEY_NOT_FOUND',
  );
});

test('#1067 journey runs: lists enrollments newest first with trigger outcome and owner actions, under journey.read', async (t) => {
  const f = await setup(t);
  const created = await f.repository().createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document('j2-outcome'),
  });
  const other = await f.repository().createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document('j2-outcome'),
  });
  const enrol = async (journeyId: string, at: string, action?: { state: string; ref?: string }) => {
    const outcomeId = randomUUID();
    const interactionId = randomUUID();
    const receipt = await f.owner.jrOutcomeReceipt.create({
      data: {
        tenantId: f.tenantId,
        source: 'INTERACTION',
        eventId: randomUUID(),
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        outcomeId,
        outcomeVersion: 1,
        payloadHash: 'a'.repeat(64),
        payload: { interactionId, outcomeCode: 'FOLLOW_UP_REQUIRED', effectiveAt: at },
        state: 'APPLIED',
        correlationId: 'corr',
      },
    });
    const enrollment = await f.owner.jrEnrollment.create({
      data: {
        tenantId: f.tenantId,
        outcomeReceiptId: receipt.id,
        journeyId,
        journeyVersion: 1,
        state: 'AUTHORIZED',
        runState: 'WAITING',
        currentStepId: 'ensure-case',
        createdAt: new Date(at),
      },
    });
    if (action)
      await f.owner.jrOwnerAction.create({
        data: {
          tenantId: f.tenantId,
          actionKey: `${enrollment.id}:1:ensure-case`,
          enrollmentId: enrollment.id,
          stepId: 'ensure-case',
          stepSequence: 0,
          kind: 'ENSURE_CASE',
          requestHash: 'b'.repeat(64),
          state: action.state as 'PENDING',
          ...(action.ref ? { ownerAggregateRef: action.ref, acknowledgedAt: new Date(at) } : {}),
          correlationId: 'corr',
        },
      });
    return { enrollmentId: enrollment.id, interactionId };
  };
  const caseId = randomUUID();
  const first = await enrol(created.journeyId, '2026-11-28T01:00:00.000Z', {
    state: 'ACKNOWLEDGED',
    ref: caseId,
  });
  const second = await enrol(created.journeyId, '2026-11-28T02:00:00.000Z', { state: 'PENDING' });
  const third = await enrol(created.journeyId, '2026-11-28T03:00:00.000Z');
  await enrol(other.journeyId, '2026-11-28T04:00:00.000Z');

  const actor = f.context().actor;
  const page = await f
    .repository()
    .listJourneyRuns(f.tenantId, actor, { journeyId: created.journeyId, limit: 2 });
  assert.deepEqual(
    page.items.map((item) => item.enrollmentId),
    [third.enrollmentId, second.enrollmentId],
  );
  assert.deepEqual(page.items[0]!.actions, []);
  assert.deepEqual(page.items[1]!.actions, [
    {
      stepId: 'ensure-case',
      kind: 'ENSURE_CASE',
      state: 'PENDING',
      ownerAggregateId: null,
      acknowledgedAt: null,
    },
  ]);
  assert.ok(page.nextCursor);
  const rest = await f.repository().listJourneyRuns(f.tenantId, actor, {
    journeyId: created.journeyId,
    limit: 2,
    cursor: page.nextCursor!,
  });
  assert.equal(rest.nextCursor, null);
  assert.deepEqual(rest.items, [
    {
      enrollmentId: first.enrollmentId,
      journeyVersion: 1,
      state: 'AUTHORIZED',
      runState: 'WAITING',
      terminalReason: null,
      startedAt: '2026-11-28T01:00:00.000Z',
      updatedAt: rest.items[0]!.updatedAt,
      trigger: {
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        outcomeCode: 'FOLLOW_UP_REQUIRED',
        interactionId: first.interactionId,
      },
      actions: [
        {
          stepId: 'ensure-case',
          kind: 'ENSURE_CASE',
          state: 'ACKNOWLEDGED',
          ownerAggregateId: caseId,
          acknowledgedAt: '2026-11-28T01:00:00.000Z',
        },
      ],
    },
  ]);

  const input = { journeyId: created.journeyId };
  // a viewer without journey.read gets the same not-found as a journey that does not exist
  await rejects(
    f.repository({ authorization: deny }).listJourneyRuns(f.tenantId, actor, input),
    'JOURNEY_NOT_FOUND',
  );
  await rejects(f.repository().listJourneyRuns(f.otherTenantId, actor, input), 'JOURNEY_NOT_FOUND');
  await rejects(
    f.repository().listJourneyRuns(f.tenantId, actor, { ...input, cursor: 'bm90LWEtY3Vyc29y' }),
    'REQUEST_MALFORMED',
  );
});

test('J5-ID01/RC01 atomic publish: same key does not duplicate, resolve with the same key, and a crash leaves no half-written state', async (t) => {
  const f = await setup(t);
  const created = await f.repository().createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const binding = await f.approve(created.journeyId);
  const publishKey = `publish-${randomUUID()}`;

  // crash after writing the definition and after moving the head: the whole set rolls back, no dangling version
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
    const resolved = await f.repository().resolvePublish(f.tenantId, f.context().actor, {
      journeyId: created.journeyId,
      originalIdempotencyKey: publishKey,
    });
    assert.equal(resolved.outcome, 'NOT_COMMITTED');
  }

  const published = await f.repository().publishJourneyDraft(f.context(publishKey), binding);
  assert.equal(published.outcome, 'PUBLISHED');
  assert.equal(published.version, 1);
  // a client that does not know the outcome resends with the same key: gets the same result, no new version
  assert.deepEqual(
    await f.repository().publishJourneyDraft(f.context(publishKey), binding),
    published,
  );
  assert.deepEqual(
    await f.repository().resolvePublish(f.tenantId, f.context().actor, {
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
  // an approval that was already used cannot be used to publish again with a new key
  await rejects(
    f.repository().publishJourneyDraft(f.context(), {
      ...binding,
      expectedHeadVersion: head.version,
      baseHeadVersion: head.version,
    }),
    'APPROVAL_REQUIRED',
  );

  // audit/outbox are metadata only, with no document or graph
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

test('J5-CC02 stale draft/head/review/capability creates no new version', async (t) => {
  const f = await setup(t);
  const repo = f.repository();
  const created = await repo.createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const binding = await f.approve(created.journeyId);

  // the capability registry changes after compile → the artifact is stale
  const changed = f.repository({
    capabilities: JOURNEY_RUNTIME_CAPABILITIES.map((capability) => ({ ...capability, version: 2 })),
  });
  await rejects(changed.publishJourneyDraft(f.context(), binding), 'COMPILE_ARTIFACT_STALE');
  await rejects(
    repo.publishJourneyDraft(f.context(), { ...binding, compileDigest: 'f'.repeat(64) }),
    'REVIEW_CANDIDATE_STALE',
  );

  // the draft moved after review: publishing with the old binding must lose
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

  // compiling an old revision still returns a result but flagged stale
  const stale = await repo.compileJourneyDraft(f.tenantId, f.context().actor, {
    journeyId: created.journeyId,
    draftRevision: 1,
    draftDigest: created.draftDigest,
  });
  assert.equal(stale.stale, true);
  assert.ok(stale.artifact);
});

test('J5-RC02 lifecycle: PAUSED stops new enrollment but existing ones continue, DEPRECATED cannot be edited, roll-forward/clone/discard', async (t) => {
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
  // replaying the same occurrence still gets the same enrollment and the existing enrollment continues
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

  // roll-forward: a new draft from the existing version; clone: a new journey with no enrollment carried over
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

for (const operation of ['publish', 'resume', 'transfer', 'rollForward', 'clone'] as const)
  for (const order of ['writer-first', 'deactivate-first'] as const)
    test(`Core Team fence: actual Journey authoring ${operation} ${order}`, async (t) => {
      const f = await setup(t);
      const repo = f.repository();
      const created = await repo.createJourneyDraft(f.context(), {
        ownerTeamId: f.teamId,
        document: f.document(),
      });
      const approval = await f.approve(created.journeyId);
      if (operation !== 'publish' && operation !== 'transfer')
        await repo.publishJourneyDraft(f.context(), approval);
      if (operation === 'resume') {
        const current = await f.owner.jrJourneyHead.findFirstOrThrow({
          where: { tenantId: f.tenantId, journeyId: created.journeyId },
        });
        await repo.changeJourneyLifecycle(f.context(), {
          journeyId: created.journeyId,
          target: 'PAUSED',
          expectedHeadVersion: current.version,
          reasonCode: 'ISOLATED_PAUSE',
        });
      }
      const current = await f.owner.jrJourneyHead.findFirstOrThrow({
        where: { tenantId: f.tenantId, journeyId: created.journeyId },
      });
      const target = operation === 'transfer' || operation === 'clone' ? randomUUID() : f.teamId;
      if (target !== f.teamId)
        await f.owner.team.create({
          data: { id: target, tenantId: f.tenantId, name: 'Target ' + target },
        });
      const write = () => {
        switch (operation) {
          case 'publish':
            return repo.publishJourneyDraft(f.context(), approval);
          case 'resume':
            return repo.changeJourneyLifecycle(f.context(), {
              journeyId: created.journeyId,
              target: 'ACTIVE',
              expectedHeadVersion: current.version,
              reasonCode: 'ISOLATED_RESUME',
            });
          case 'transfer':
            return repo.transferJourneyOwnership(f.context(), {
              journeyId: created.journeyId,
              targetTeamId: target,
              expectedHeadVersion: current.version,
              reasonCode: 'ISOLATED_TRANSFER',
            });
          case 'rollForward':
            return repo.createRollForwardFromVersion(f.context(), {
              journeyId: created.journeyId,
              sourceVersion: 1,
              expectedHeadVersion: current.version,
            });
          case 'clone':
            return repo.cloneJourneyFromVersion(f.context(), {
              journeyId: created.journeyId,
              version: 1,
              targetOwnerTeamId: target,
              name: 'Clone',
            });
        }
      };
      await teamWriterRace({
        owner: f.owner,
        tenantId: f.tenantId,
        teamId: target,
        table: 'jr_journey_heads',
        order,
        existingReferences: target === f.teamId,
        write,
      });
    });

test('Core Team fence: a raw ACTIVE Journey publication must reject a legacy inactive Team', async (t) => {
  const f = await setup(t);
  const repo = f.repository();
  const created = await repo.createJourneyDraft(f.context(), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  await repo.publishJourneyDraft(f.context(), await f.approve(created.journeyId));
  await f.owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
    await tx.team.update({ where: { id: f.teamId }, data: { isActive: false } });
  });
  const nextId = randomUUID();
  await f.owner
    .$executeRaw`INSERT INTO public.jr_journey_definitions SELECT r.* FROM public.jr_journey_definitions v CROSS JOIN LATERAL jsonb_populate_record(NULL::public.jr_journey_definitions,to_jsonb(v)||jsonb_build_object('id',${nextId}::text,'version',2)) r WHERE v.tenant_id=${f.tenantId}::uuid AND v.journey_id=${created.journeyId}::uuid AND v.version=1`;
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (tx) =>
      tx.jrJourneyHead.update({
        where: { tenantId_journeyId: { tenantId: f.tenantId, journeyId: created.journeyId } },
        data: { activeVersion: 2, activeDefinitionId: nextId, version: { increment: 1 } },
      }),
    ),
    /TEAM_INACTIVE/,
  );
  assert.equal(
    (
      await f.owner.jrJourneyHead.findFirstOrThrow({
        where: { tenantId: f.tenantId, journeyId: created.journeyId },
      })
    ).activeVersion,
    1,
  );
});
