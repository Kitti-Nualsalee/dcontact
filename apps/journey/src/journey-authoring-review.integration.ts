import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import {
  IamJourneyAuthoringAuthorizer,
  IamJourneyAuthoringDelegations,
  JourneyAuthoringDelegationError,
} from '@d-contact/iam';
import type { AuthoringDocumentV1, JourneyAuthoringCapability } from '@d-contact/cxa-contracts';
import { importJourneyDefinition } from './journey-authoring-compiler.js';
import { JourneyAuthoringError, type JourneyAuthoringActor } from './journey-authoring-model.js';
import {
  JourneyAuthoringRepository,
  type JourneyCommandContext,
} from './journey-authoring-repository.js';
import type { JourneyDefinitionContent } from './journey-definition.js';

const evaluator = new DcExprEvaluator();
const AUTHOR_CAPS: JourneyAuthoringCapability[] = [
  'journey.read',
  'journey.edit',
  'journey.publish',
  'journey.review',
];

function fixture(): JourneyDefinitionContent {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'test/fixtures/j5/j1-schedule.json'), 'utf8'),
  ) as JourneyDefinitionContent;
}

/**
 * persona ตาม #331 §3 ถูกแปลงเป็น grant ใน IAM store — role ใน token ไม่ถูกอ่านเลย
 * admin = tenant-wide + direct review authority + strong auth enrollment
 */
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
  const otherTeamId = randomUUID();
  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: { id, name: `J5.3 ${id}`, slug: `j5-3-${id}`, sipDomain: `${id}.j5-3.test` },
    });
    await owner.jrAuthoringRolloutState.create({
      data: {
        tenantId: id,
        stage: 'INTERNAL_SYNTHETIC',
        canvasWriteEnabled: true,
        publishUiEnabled: true,
        updatedByRef: 'ops',
        evidenceRef: 'j5-3-test',
      },
    });
  }
  await owner.team.createMany({
    data: [
      { id: teamId, tenantId, name: `j5-3-a-${teamId}` },
      { id: otherTeamId, tenantId, name: `j5-3-b-${otherTeamId}` },
    ],
  });

  const subject = async (
    subjectId: string,
    options: { service?: boolean; strong?: boolean; directReview?: boolean } = {},
  ) =>
    owner.iamAuthoringSubject.create({
      data: {
        tenantId,
        subjectId,
        authenticationStrength: options.strong ? 'STRONG' : 'STANDARD',
        directReviewAuthority: options.directReview ?? false,
        isServicePrincipal: options.service ?? false,
      },
    });
  const grant = (
    subjectId: string,
    capability: JourneyAuthoringCapability,
    scope: 'TEAM' | 'TENANT' = 'TEAM',
    scopeId = teamId,
  ) =>
    owner.iamAuthoringCapabilityGrant.create({
      data: {
        tenantId,
        subjectId,
        capability,
        scopeKind: scope,
        scopeId: scope === 'TENANT' ? tenantId : scopeId,
        grantedByRef: 'iam-admin',
      },
    });

  await subject('author');
  await subject('author-2');
  await subject('reviewer');
  await subject('supervisor');
  await subject('agent');
  await subject('delegate');
  await subject('robot', { service: true });
  await subject('admin', { strong: true, directReview: true });
  for (const capability of AUTHOR_CAPS) {
    await grant('author', capability);
    await grant('author-2', capability);
  }
  await grant('reviewer', 'journey.read');
  await grant('reviewer', 'journey.review');
  await grant('supervisor', 'journey.read');
  await grant('robot', 'journey.review');
  for (const capability of [...AUTHOR_CAPS, 'journey.lifecycle', 'journey.transfer'] as const) {
    await grant('admin', capability, 'TENANT');
  }

  t.after(async () => {
    const where = { tenantId: { in: [tenantId, otherTenantId] } };
    await owner.jrStepRun.deleteMany({ where });
    await owner.jrEnrollment.deleteMany({ where });
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
    await owner.iamAuthoringDelegationRevocation.deleteMany({ where });
    await owner.iamAuthoringDelegation.deleteMany({ where });
    await owner.iamAuthoringCapabilityGrant.deleteMany({ where });
    await owner.iamAuthoringSubject.deleteMany({ where });
    await owner.jrAuthoringRolloutState.deleteMany({ where });
    await owner.team.deleteMany({ where });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const repo = new JourneyAuthoringRepository(application, {
    authorization: new IamJourneyAuthoringAuthorizer(),
    evaluator,
    flags: { canvasWrite: true, publishUi: true },
  });
  const actor = (
    subjectId: string,
    extra: Partial<JourneyAuthoringActor> = {},
  ): JourneyAuthoringActor => ({
    subjectId,
    correlationId: `corr-${randomUUID()}`,
    ...extra,
  });
  const as = (
    subjectId: string,
    extra: Partial<JourneyAuthoringActor> = {},
  ): JourneyCommandContext => ({
    tenantId,
    actor: actor(subjectId, extra),
    idempotencyKey: `key-${randomUUID()}`,
  });
  const document = (days = 7): AuthoringDocumentV1 => {
    const imported = importJourneyDefinition({ ...fixture(), ownerTeamId: teamId });
    return { ...imported, settings: { ...imported.settings, maxDurationDays: days } };
  };

  /** submit ด้วย digest จาก compile ของ server */
  const submit = async (subjectId: string, journeyId: string) => {
    const state = await repo.getJourneyAuthoringState(tenantId, actor(subjectId), journeyId);
    const compiled = await repo.compileJourneyDraft(tenantId, actor(subjectId), {
      journeyId,
      draftRevision: state.draft.revision,
      draftDigest: state.draft.digest,
    });
    const artifact = compiled.artifact!;
    const binding = {
      journeyId,
      draftRevision: state.draft.revision,
      draftDigest: state.draft.digest,
      compileDigest: artifact.compileDigest,
      referenceDigest: artifact.referenceDigest,
      capabilityDigest: artifact.capabilityDigest,
      baseHeadVersion: state.head.version,
      baseHeadDigest: null,
    };
    const review = await repo.submitJourneyReview(as(subjectId), binding);
    return { ...binding, reviewId: review.reviewId, expectedHeadVersion: state.head.version };
  };
  const decide = (
    subjectId: string,
    journeyId: string,
    reviewId: string,
    decision: 'APPROVE' | 'REJECT' = 'APPROVE',
  ) =>
    repo.decideJourneyReview(as(subjectId), {
      journeyId,
      reviewId,
      expectedReviewState: 'IN_REVIEW',
      decision,
      reasonCode: decision === 'APPROVE' ? 'LOOKS_GOOD' : 'NEEDS_WORK',
      evidenceRef: `evidence-${randomUUID()}`,
    });

  return {
    owner,
    application,
    tenantId,
    otherTenantId,
    teamId,
    otherTeamId,
    repo,
    actor,
    as,
    document,
    submit,
    decide,
    grant,
  };
}

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof JourneyAuthoringError, String(error));
    assert.equal(error.code, code);
    return true;
  });

test('J5-AU01 persona matrix: สิทธิ์มาจาก IAM store, membership อย่างเดียวไม่พอ และที่มองไม่เห็นตอบ not-found', async (t) => {
  const f = await setup(t);
  const created = await f.repo.createJourneyDraft(f.as('author'), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });

  // supervisor อ่านได้แต่แก้ไม่ได้ → capability error; agent อ่านไม่ได้ → not-found เหมือนไม่มีอยู่จริง
  assert.equal(
    (await f.repo.getJourneyAuthoringState(f.tenantId, f.actor('supervisor'), created.journeyId))
      .head.journeyId,
    created.journeyId,
  );
  const cas = {
    journeyId: created.journeyId,
    expectedHeadVersion: 1,
    expectedDraftRevision: 1,
    expectedDraftDigest: created.draftDigest,
    document: f.document(9),
  };
  await rejects(f.repo.updateJourneyDraft(f.as('supervisor'), cas), 'CAPABILITY_REQUIRED');
  await rejects(f.repo.updateJourneyDraft(f.as('agent'), cas), 'JOURNEY_NOT_FOUND');
  await rejects(
    f.repo.getJourneyAuthoringState(f.tenantId, f.actor('agent'), created.journeyId),
    'JOURNEY_NOT_FOUND',
  );
  await rejects(
    f.repo.createJourneyDraft(f.as('supervisor'), {
      ownerTeamId: f.teamId,
      document: f.document(),
    }),
    'CAPABILITY_REQUIRED',
  );
  // service principal ไม่มีสิทธิ์ authoring แม้มี grant
  await rejects(
    f.repo.getJourneyAuthoringState(f.tenantId, f.actor('robot'), created.journeyId),
    'JOURNEY_NOT_FOUND',
  );
  // tenant อื่นมองไม่เห็นแม้รู้ ID
  await rejects(
    f.repo.getJourneyAuthoringState(f.otherTenantId, f.actor('admin'), created.journeyId),
    'JOURNEY_NOT_FOUND',
  );
  // admin แบบ tenant-wide เห็นทุกทีม
  assert.ok(await f.repo.getJourneyAuthoringState(f.tenantId, f.actor('admin'), created.journeyId));
});

test('J5-AU01 maker-checker: อนุมัติตัวเอง/service ไม่ได้, แก้หลัง submit ทำให้ approval เดิม stale, ถอนสิทธิ์ผู้อนุมัติแล้ว publish ไม่ผ่าน', async (t) => {
  const f = await setup(t);
  const created = await f.repo.createJourneyDraft(f.as('author'), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const first = await f.submit('author', created.journeyId);
  await rejects(f.decide('author', created.journeyId, first.reviewId), 'APPROVAL_SELF_FORBIDDEN');
  await rejects(f.decide('robot', created.journeyId, first.reviewId), 'JOURNEY_NOT_FOUND');
  await rejects(f.repo.publishJourneyDraft(f.as('author'), first), 'APPROVAL_REQUIRED');

  // แก้ draft หลัง submit → candidate เดิม SUPERSEDED และอนุมัติไม่ได้อีก
  await f.repo.updateJourneyDraft(f.as('author'), {
    journeyId: created.journeyId,
    expectedHeadVersion: 1,
    expectedDraftRevision: 1,
    expectedDraftDigest: created.draftDigest,
    document: f.document(10),
  });
  assert.equal(
    (await f.owner.jrReviewCandidate.findUniqueOrThrow({ where: { id: first.reviewId } })).state,
    'SUPERSEDED',
  );
  await rejects(f.decide('reviewer', created.journeyId, first.reviewId), 'REVIEW_CANDIDATE_STALE');

  const second = await f.submit('author', created.journeyId);
  assert.equal((await f.decide('reviewer', created.journeyId, second.reviewId)).state, 'APPROVED');

  // ผู้อนุมัติถูกยกระดับ epoch (เช่นถูกถอนแล้วคืนสิทธิ์) หลังโหวต → approval stale ไม่เกิด version
  await f.owner.iamAuthoringSubject.update({
    where: { tenantId_subjectId: { tenantId: f.tenantId, subjectId: 'reviewer' } },
    data: { authorizationEpoch: 2 },
  });
  await rejects(f.repo.publishJourneyDraft(f.as('author'), second), 'APPROVAL_STALE');
  assert.equal(
    await f.owner.jrJourneyDefinition.count({ where: { journeyId: created.journeyId } }),
    0,
  );

  // โหวตใหม่ภายใต้ epoch ปัจจุบันจึง publish ได้
  const third = await f.submit('author', created.journeyId);
  await f.decide('reviewer', created.journeyId, third.reviewId);
  const published = await f.repo.publishJourneyDraft(f.as('author'), third);
  assert.equal(published.outcome, 'PUBLISHED');
});

test('J5-CC01 reviewer สองคนอนุมัติพร้อมกัน candidate เปลี่ยนสถานะได้ครั้งเดียว', async (t) => {
  const f = await setup(t);
  await f.grant('supervisor', 'journey.review');
  const created = await f.repo.createJourneyDraft(f.as('author'), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const review = await f.submit('author', created.journeyId);
  const settled = await Promise.allSettled([
    f.decide('reviewer', created.journeyId, review.reviewId),
    f.decide('supervisor', created.journeyId, review.reviewId, 'REJECT'),
  ]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(
    await f.owner.jrReviewDecisionRecord.count({ where: { candidateId: review.reviewId } }),
    1,
  );
});

test('J5-AU01 unilateral publish ต้อง direct grant + direct review authority + strong auth ที่สด และ audit แยก', async (t) => {
  const f = await setup(t);
  const created = await f.repo.createJourneyDraft(f.as('admin'), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const state = await f.repo.getJourneyAuthoringState(
    f.tenantId,
    f.actor('admin'),
    created.journeyId,
  );
  const artifact = (
    await f.repo.compileJourneyDraft(f.tenantId, f.actor('admin'), {
      journeyId: created.journeyId,
      draftRevision: state.draft.revision,
      draftDigest: state.draft.digest,
    })
  ).artifact!;
  const request = {
    journeyId: created.journeyId,
    draftRevision: state.draft.revision,
    draftDigest: state.draft.digest,
    compileDigest: artifact.compileDigest,
    referenceDigest: artifact.referenceDigest,
    capabilityDigest: artifact.capabilityDigest,
    expectedHeadVersion: state.head.version,
    reasonCode: 'INCIDENT_HOTFIX',
  };
  const stale = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await rejects(
    f.repo.publishJourneyDraftUnilateral(
      f.as('admin', { authentication: { strength: 'STRONG', authenticatedAt: stale } }),
      request,
    ),
    'STRONG_AUTH_REQUIRED',
  );
  // author มี publish แต่ไม่มี direct review authority
  await rejects(
    f.repo.publishJourneyDraftUnilateral(
      f.as('author', {
        authentication: { strength: 'STRONG', authenticatedAt: new Date().toISOString() },
      }),
      request,
    ),
    'STRONG_AUTH_REQUIRED',
  );
  const published = await f.repo.publishJourneyDraftUnilateral(
    f.as('admin', {
      authentication: { strength: 'STRONG', authenticatedAt: new Date().toISOString() },
    }),
    request,
  );
  assert.equal(published.outcome, 'PUBLISHED');
  assert.ok(
    (await f.owner.jrAuthoringAudit.findMany({ where: { resourceId: created.journeyId } })).some(
      (row) =>
        row.action === 'JOURNEY_PUBLISHED_UNILATERAL' && row.reasonCode === 'INCIDENT_HOTFIX',
    ),
  );
});

test('J5-AU02 delegation: exact scope ≤8h, ไม่มอบต่อ, ใช้ approve/publish ไม่ได้ และเพิกถอนแล้วหมดสิทธิ์ทันที', async (t) => {
  const f = await setup(t);
  const delegations = new IamJourneyAuthoringDelegations(f.application);
  const created = await f.repo.createJourneyDraft(f.as('author'), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const scope = { kind: 'JOURNEY' as const, id: created.journeyId, teamId: f.teamId };
  const invalid = (promise: Promise<unknown>) =>
    assert.rejects(promise, (error: unknown) => error instanceof JourneyAuthoringDelegationError);

  await invalid(
    delegations.delegate({
      tenantId: f.tenantId,
      delegatorSubjectId: 'author',
      delegateSubjectId: 'delegate',
      capability: 'journey.publish',
      scope,
      durationSeconds: 3_600,
      evidenceRef: 'TICKET-1',
    }),
  );
  await invalid(
    delegations.delegate({
      tenantId: f.tenantId,
      delegatorSubjectId: 'author',
      delegateSubjectId: 'delegate',
      capability: 'journey.edit',
      scope,
      durationSeconds: 9 * 3_600,
      evidenceRef: 'TICKET-1',
    }),
  );
  await invalid(
    delegations.delegate({
      tenantId: f.tenantId,
      delegatorSubjectId: 'author',
      delegateSubjectId: 'robot',
      capability: 'journey.edit',
      scope,
      durationSeconds: 3_600,
      evidenceRef: 'TICKET-1',
    }),
  );
  // supervisor ไม่มี direct edit จึงมอบ edit ให้ใครไม่ได้
  await invalid(
    delegations.delegate({
      tenantId: f.tenantId,
      delegatorSubjectId: 'supervisor',
      delegateSubjectId: 'delegate',
      capability: 'journey.edit',
      scope,
      durationSeconds: 3_600,
      evidenceRef: 'TICKET-1',
    }),
  );

  const edit = await delegations.delegate({
    tenantId: f.tenantId,
    delegatorSubjectId: 'author',
    delegateSubjectId: 'delegate',
    capability: 'journey.edit',
    scope,
    durationSeconds: 3_600,
    evidenceRef: 'TICKET-1',
  });
  await delegations.delegate({
    tenantId: f.tenantId,
    delegatorSubjectId: 'author',
    delegateSubjectId: 'delegate',
    capability: 'journey.read',
    scope,
    durationSeconds: 3_600,
    evidenceRef: 'TICKET-1',
  });
  // no chaining: delegate ที่ได้ edit มาจาก delegation มอบต่อไม่ได้
  await invalid(
    delegations.delegate({
      tenantId: f.tenantId,
      delegatorSubjectId: 'delegate',
      delegateSubjectId: 'agent',
      capability: 'journey.edit',
      scope,
      durationSeconds: 3_600,
      evidenceRef: 'TICKET-2',
    }),
  );

  const updated = await f.repo.updateJourneyDraft(f.as('delegate'), {
    journeyId: created.journeyId,
    expectedHeadVersion: 1,
    expectedDraftRevision: 1,
    expectedDraftDigest: created.draftDigest,
    document: f.document(11),
  });
  // delegated reader อ่าน audit ไม่ได้ (ต้อง direct) แต่ไม่ได้ถูกซ่อนว่ามี journey
  await rejects(
    f.repo.listJourneyAudit(f.tenantId, f.actor('delegate'), { journeyId: created.journeyId }),
    'CAPABILITY_REQUIRED',
  );

  await delegations.revoke({
    tenantId: f.tenantId,
    delegationId: edit.delegationId,
    reasonCode: 'DONE',
    revokedByRef: 'author',
  });
  await rejects(
    f.repo.updateJourneyDraft(f.as('delegate'), {
      journeyId: created.journeyId,
      expectedHeadVersion: updated.headVersion,
      expectedDraftRevision: updated.draftRevision,
      expectedDraftDigest: updated.draftDigest,
      document: f.document(12),
    }),
    // delegation มีอยู่แต่ถูกเพิกถอนแล้ว — บอกสาเหตุตรงกว่า capability ทั่วไป
    'DELEGATION_INVALID',
  );
});

test('J5-CC02 ownership transfer ขึ้น revision ใหม่และ supersede review, team inactive แก้ไม่ได้แต่ยังโอนได้', async (t) => {
  const f = await setup(t);
  const created = await f.repo.createJourneyDraft(f.as('author'), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  const review = await f.submit('author', created.journeyId);
  await f.owner.team.update({ where: { id: f.teamId }, data: { isActive: false } });
  await rejects(
    f.repo.updateJourneyDraft(f.as('author'), {
      journeyId: created.journeyId,
      expectedHeadVersion: 1,
      expectedDraftRevision: 1,
      expectedDraftDigest: created.draftDigest,
      document: f.document(8),
    }),
    'OWNER_TEAM_INACTIVE',
  );
  await rejects(f.decide('reviewer', created.journeyId, review.reviewId), 'OWNER_TEAM_INACTIVE');

  const transferred = await f.repo.transferJourneyOwnership(f.as('admin'), {
    journeyId: created.journeyId,
    targetTeamId: f.otherTeamId,
    expectedHeadVersion: 1,
    reasonCode: 'TEAM_RETIRED',
  });
  assert.equal(transferred.draftRevision, 2);
  const head = await f.owner.jrJourneyHead.findUniqueOrThrow({
    where: { tenantId_journeyId: { tenantId: f.tenantId, journeyId: created.journeyId } },
  });
  assert.equal(head.ownerTeamId, f.otherTeamId);
  assert.equal(
    (await f.owner.jrReviewCandidate.findUniqueOrThrow({ where: { id: review.reviewId } })).state,
    'SUPERSEDED',
  );
  // author มีสิทธิ์แค่ทีมเดิม: หลังโอนออก journey กลายเป็นมองไม่เห็นสำหรับเขา
  await rejects(
    f.repo.getJourneyAuthoringState(f.tenantId, f.actor('author'), created.journeyId),
    'JOURNEY_NOT_FOUND',
  );
  // โอนกลับไปทีม inactive ไม่ได้
  await rejects(
    f.repo.transferJourneyOwnership(f.as('admin'), {
      journeyId: created.journeyId,
      targetTeamId: f.teamId,
      expectedHeadVersion: head.version,
      reasonCode: 'BACK',
    }),
    'OWNER_TEAM_INACTIVE',
  );
});

test('J5-OB01 audit อ่านได้เฉพาะ direct reader, การอ่านถูก audit และไม่มีข้อมูลดิบ', async (t) => {
  const f = await setup(t);
  const created = await f.repo.createJourneyDraft(f.as('author'), {
    ownerTeamId: f.teamId,
    document: f.document(),
  });
  await f.submit('author', created.journeyId);
  const rows = await f.repo.listJourneyAudit(f.tenantId, f.actor('supervisor'), {
    journeyId: created.journeyId,
  });
  assert.deepEqual(rows.map((row) => row.action).sort(), ['DRAFT_CREATED', 'REVIEW_SUBMITTED']);
  assert.ok(
    (await f.owner.jrAuthoringAudit.findMany({ where: { resourceId: created.journeyId } })).some(
      (row) => row.action === 'AUDIT_READ' && row.actorSubjectId === 'supervisor',
    ),
  );
  await rejects(
    f.repo.listJourneyAudit(f.tenantId, f.actor('agent'), { journeyId: created.journeyId }),
    'JOURNEY_NOT_FOUND',
  );
  // audit/outbox ไม่มี graph, settings หรือค่าจาก document
  const serialized = JSON.stringify([
    await f.owner.jrAuthoringAudit.findMany({ where: { resourceId: created.journeyId } }),
    await f.owner.jrAuthoringOutbox.findMany({ where: { resourceId: created.journeyId } }),
  ]);
  for (const leaked of ['content-weekly', 'sender-synthetic', 'survey.completed', 'Asia/Bangkok']) {
    assert.ok(!serialized.includes(leaked), leaked);
  }
});
