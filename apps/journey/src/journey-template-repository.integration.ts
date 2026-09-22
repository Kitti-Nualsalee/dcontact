import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamJourneyAuthoringAuthorizer } from '@d-contact/iam';
import type {
  AuthoringDocumentV1,
  JourneyAuthoringCapability,
  JourneyTemplateParameterV1,
} from '@d-contact/cxa-contracts';
import { JourneyAuthoringError } from './journey-authoring-model.js';
import type { JourneyCommandContext } from './journey-authoring-repository.js';
import { BuiltInTemplateCatalog } from './journey-template-catalog.js';
import { JourneyTemplateRepository } from './journey-template-repository.js';

const evaluator = new DcExprEvaluator();
const catalog = new BuiltInTemplateCatalog();
const REMINDER = '5b0c7a4e-8f1d-4c3a-9b2e-1a7d3c5e9f01';
const CALLBACK = '5b0c7a4e-8f1d-4c3a-9b2e-1a7d3c5e9f02';
const bindings = { reminderContent: 'content-reminder', senderIdentity: 'sender-line-oa' };

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
  const teamA = randomUUID();
  const teamB = randomUUID();
  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: { id, name: `J5.4 ${id}`, slug: `j5-4-${id}`, sipDomain: `${id}.j5-4.test` },
    });
    await owner.jrAuthoringRolloutState.create({
      data: {
        tenantId: id,
        stage: 'INTERNAL_SYNTHETIC',
        canvasWriteEnabled: true,
        publishUiEnabled: true,
        templateCatalogEnabled: true,
        templateUpgradeEnabled: true,
        updatedByRef: 'ops',
        evidenceRef: 'j5-4-test',
      },
    });
  }
  await owner.team.createMany({
    data: [
      { id: teamA, tenantId, name: `j5-4-a-${teamA}` },
      { id: teamB, tenantId, name: `j5-4-b-${teamB}` },
    ],
  });
  const grants: Array<[string, JourneyAuthoringCapability, string]> = [
    ['author', 'template.read', teamA],
    ['author', 'template.edit', teamA],
    ['author', 'template.publish', teamA],
    ['author', 'journey.read', teamA],
    ['author', 'journey.edit', teamA],
    ['reviewer', 'template.read', teamA],
    ['reviewer', 'template.review', teamA],
    ['outsider', 'template.read', teamB],
    ['outsider', 'journey.edit', teamB],
    ['admin', 'template.visibility', teamA],
    ['admin', 'template.lifecycle', teamA],
  ];
  for (const subjectId of ['author', 'reviewer', 'outsider', 'admin']) {
    await owner.iamAuthoringSubject.create({
      data: { tenantId, subjectId, authenticationStrength: 'STANDARD' },
    });
  }
  for (const [subjectId, capability, teamId] of grants) {
    await owner.iamAuthoringCapabilityGrant.create({
      data: {
        tenantId,
        subjectId,
        capability,
        scopeKind: 'TEAM',
        scopeId: teamId,
        grantedByRef: 'iam-admin',
      },
    });
  }

  t.after(async () => {
    const where = { tenantId: { in: [tenantId, otherTenantId] } };
    await owner.jrTemplateUpgradeApplication.deleteMany({ where });
    await owner.jrTemplateProvenance.deleteMany({ where });
    await owner.jrAuthoringOutbox.deleteMany({ where });
    await owner.jrAuthoringAudit.deleteMany({ where });
    await owner.jrAuthoringCommandReceipt.deleteMany({ where });
    await owner.jrReviewDecisionRecord.deleteMany({ where });
    await owner.jrReviewCandidate.deleteMany({ where });
    await owner.$transaction([
      owner.jrJourneyHead.deleteMany({ where }),
      owner.jrJourneyDraft.deleteMany({ where }),
      owner.jrTemplateHead.deleteMany({ where }),
      owner.jrTemplateVersion.deleteMany({ where }),
      owner.jrTemplateDraft.deleteMany({ where }),
    ]);
    await owner.iamAuthoringCapabilityGrant.deleteMany({ where });
    await owner.iamAuthoringSubject.deleteMany({ where });
    await owner.jrAuthoringRolloutState.deleteMany({ where });
    await owner.team.deleteMany({ where });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const repo = new JourneyTemplateRepository(application, {
    authorization: new IamJourneyAuthoringAuthorizer(),
    evaluator,
    catalog,
    flags: { canvasWrite: true, publishUi: true, templateCatalog: true, templateUpgrade: true },
  });
  const as = (
    subjectId: string,
    key = `key-${randomUUID()}`,
    tenant = tenantId,
  ): JourneyCommandContext => ({
    tenantId: tenant,
    actor: { subjectId, correlationId: `corr-${randomUUID()}` },
    idempotencyKey: key,
  });
  const actor = (subjectId: string) => as(subjectId).actor;
  const builtIn = catalog.get(REMINDER)!;

  /** tenant template: สร้าง → submit → reviewer อนุมัติ → author publish */
  const publishTenantTemplate = async (
    document: AuthoringDocumentV1,
    parameterSchema: readonly JourneyTemplateParameterV1[],
    templateId?: string,
  ) => {
    let head;
    if (!templateId) {
      const created = await repo.createTemplateDraft(as('author'), {
        ownerTeamId: teamA,
        visibility: 'TEAM',
        name: 'tenant-reminder',
        document,
        parameterSchema,
      });
      templateId = created.templateId;
    } else {
      head = await owner.jrTemplateHead.findUniqueOrThrow({
        where: { tenantId_templateId: { tenantId, templateId } },
      });
      await repo.updateTemplateDraft(as('author'), {
        templateId,
        expectedHeadVersion: head.version,
        expectedDraftRevision: head.currentDraftRevision,
        expectedDraftDigest: head.currentDraftDigest,
        document,
        parameterSchema,
      });
    }
    head = await owner.jrTemplateHead.findUniqueOrThrow({
      where: { tenantId_templateId: { tenantId, templateId } },
    });
    const review = await repo.submitTemplateReview(as('author'), {
      templateId,
      draftRevision: head.currentDraftRevision,
      draftDigest: head.currentDraftDigest,
      baseHeadVersion: head.version,
    });
    await repo.decideTemplateReview(as('reviewer'), {
      templateId,
      reviewId: review.reviewId,
      decision: 'APPROVE',
      reasonCode: 'OK',
      evidenceRef: 'e',
    });
    return repo.publishTemplateVersion(as('author'), {
      templateId,
      reviewId: review.reviewId,
      draftRevision: head.currentDraftRevision,
      draftDigest: head.currentDraftDigest,
      expectedHeadVersion: head.version,
    });
  };

  return {
    owner,
    tenantId,
    otherTenantId,
    teamA,
    teamB,
    repo,
    as,
    actor,
    builtIn,
    publishTenantTemplate,
  };
}

const rejects = (promise: Promise<unknown>, code: string) =>
  assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof JourneyAuthoringError, String(error));
    assert.equal(error.code, code);
    return true;
  });

test('J5-F03 instantiate built-in แบบ idempotent และ detached พร้อม provenance; parameter/reference/digest fail closed', async (t) => {
  const f = await setup(t);
  const request = {
    origin: 'PLATFORM_BUILTIN' as const,
    templateId: REMINDER,
    version: 1,
    expectedContentDigest: f.builtIn.contentDigest,
    bindings,
    targetOwnerTeamId: f.teamA,
    name: 'my reminder',
  };
  const key = `instantiate-${randomUUID()}`;
  const created = await f.repo.instantiateTemplate(f.as('author', key), request);
  assert.deepEqual(await f.repo.instantiateTemplate(f.as('author', key), request), created);
  await rejects(
    f.repo.instantiateTemplate(f.as('author', key), { ...request, name: 'other' }),
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(await f.owner.jrJourneyHead.count({ where: { tenantId: f.tenantId } }), 1);

  const provenance = await f.owner.jrTemplateProvenance.findFirstOrThrow({
    where: { journeyId: created.journeyId },
  });
  assert.equal(provenance.templateOrigin, 'PLATFORM_BUILTIN');
  assert.equal(provenance.sourceContentDigest, f.builtIn.contentDigest);
  // provenance/audit ไม่มีค่า parameter ดิบ มีแค่ digest
  const serialized = JSON.stringify([
    provenance,
    await f.owner.jrAuthoringAudit.findMany({ where: { resourceId: created.journeyId } }),
  ]);
  assert.ok(!serialized.includes('content-reminder') && !serialized.includes('sender-line-oa'));
  // draft ที่ได้เป็นของ tenant ครบทั้งชุดและ compile ได้
  const compiled = await f.repo.compileJourneyDraft(f.tenantId, f.actor('author'), {
    journeyId: created.journeyId,
    draftRevision: 1,
    draftDigest: created.draftDigest,
  });
  assert.deepEqual(compiled.diagnostics, []);

  await rejects(
    f.repo.instantiateTemplate(f.as('author'), {
      ...request,
      expectedContentDigest: 'f'.repeat(64),
    }),
    'TEMPLATE_DIGEST_MISMATCH',
  );
  await rejects(
    f.repo.instantiateTemplate(f.as('author'), { ...request, bindings: { senderIdentity: 'x' } }),
    'TEMPLATE_PARAMETER_REQUIRED',
  );
  await rejects(
    f.repo.instantiateTemplate(f.as('author'), {
      ...request,
      bindings: { ...bindings, apiKey: 'sk-live' },
    }),
    'TEMPLATE_PARAMETER_INVALID',
  );
  // reference ของ tenant อื่นหรือที่ไม่มีจริงผูกไม่ได้
  const callback = catalog.get(CALLBACK)!;
  await rejects(
    f.repo.instantiateTemplate(f.as('author'), {
      ...request,
      templateId: CALLBACK,
      expectedContentDigest: callback.contentDigest,
      bindings: {
        caseType: 'case-x',
        routingIntent: 'routing-x',
        targetTeam: randomUUID(),
        senderIdentity: 'sender-1',
      },
    }),
    'TEMPLATE_REFERENCE_UNTRUSTED',
  );
  // outsider เขียน journey ในทีมตัวเองได้ แต่สร้างใส่ทีม A ไม่ได้
  await rejects(f.repo.instantiateTemplate(f.as('outsider'), request), 'CAPABILITY_REQUIRED');
});

test('J5-TI01 tenant catalog: TEAM มองเห็นเฉพาะทีมเจ้าของ, TENANT เห็นทั้ง tenant, tenant อื่นไม่เห็นเลย', async (t) => {
  const f = await setup(t);
  const content = f.builtIn.content;
  const published = await f.publishTenantTemplate(content.document, content.parameterSchema);
  const names = async (subjectId: string, tenant = f.tenantId) =>
    (await f.repo.listVisibleTemplates(tenant, f.actor(subjectId))).items
      .filter((entry) => entry.origin === 'TENANT')
      .map((entry) => entry.templateId);

  assert.deepEqual(await names('author'), [published.templateId]);
  assert.deepEqual(await names('outsider'), []);
  await rejects(
    f.repo.instantiateTemplate(f.as('outsider'), {
      origin: 'TENANT',
      templateId: published.templateId,
      version: 1,
      expectedContentDigest: published.contentDigest,
      bindings,
      targetOwnerTeamId: f.teamB,
      name: 'x',
    }),
    'TEMPLATE_NOT_FOUND',
  );
  const head = await f.owner.jrTemplateHead.findUniqueOrThrow({
    where: { tenantId_templateId: { tenantId: f.tenantId, templateId: published.templateId } },
  });
  await f.repo.changeTemplateVisibility(f.as('admin'), {
    templateId: published.templateId,
    expectedHeadVersion: head.version,
    visibility: 'TENANT',
    reasonCode: 'SHARE_TENANT',
  });
  assert.deepEqual(await names('outsider'), [published.templateId]);
  // tenant อื่นเห็นแค่ built-in
  const foreign = (await f.repo.listVisibleTemplates(f.otherTenantId, f.actor('author'))).items;
  assert.deepEqual(
    foreign.map((entry) => entry.origin),
    ['PLATFORM_BUILTIN', 'PLATFORM_BUILTIN'],
  );
});

test('J5-ID02/RC02 upgrade: notice แบบ advisory, proposal deterministic, apply สร้าง draft revision ใหม่เท่านั้น และ deprecate ไม่แตะ instance', async (t) => {
  const f = await setup(t);
  const content = structuredClone(f.builtIn.content);
  const v1 = await f.publishTenantTemplate(content.document, content.parameterSchema);
  const instance = await f.repo.instantiateTemplate(f.as('author'), {
    origin: 'TENANT',
    templateId: v1.templateId,
    version: 1,
    expectedContentDigest: v1.contentDigest,
    bindings,
    targetOwnerTeamId: f.teamA,
    name: 'instance',
  });
  assert.deepEqual(
    await f.repo.listTemplateNotices(f.tenantId, f.actor('author'), instance.journeyId),
    [],
  );

  const changed = structuredClone(content) as any;
  changed.document.nodes.find((node: any) => node.templateNodeKey === 'done').config.reason =
    'REMINDER_DONE';
  await f.publishTenantTemplate(changed.document, changed.parameterSchema, v1.templateId);
  const notices = await f.repo.listTemplateNotices(
    f.tenantId,
    f.actor('author'),
    instance.journeyId,
  );
  assert.deepEqual(
    notices.map((notice) => [notice.kind, notice.latestVersion]),
    [['UPDATE_AVAILABLE', 2]],
  );
  // notice ไม่ได้เปลี่ยน draft ใด ๆ
  const before = await f.owner.jrJourneyHead.findUniqueOrThrow({
    where: { tenantId_journeyId: { tenantId: f.tenantId, journeyId: instance.journeyId } },
  });
  assert.equal(before.currentDraftRevision, 1);

  const check = {
    journeyId: instance.journeyId,
    draftRevision: 1,
    draftDigest: instance.draftDigest,
    targetVersion: 2,
  };
  const proposal = await f.repo.checkTemplateUpgrade(f.tenantId, f.actor('author'), check);
  assert.equal(
    (await f.repo.checkTemplateUpgrade(f.tenantId, f.actor('author'), check)).proposalDigest,
    proposal.proposalDigest,
  );
  assert.deepEqual(proposal.conflicts, []);
  const applied = await f.repo.applyTemplateUpgrade(f.as('author'), {
    journeyId: instance.journeyId,
    targetVersion: 2,
    expectedHeadVersion: before.version,
    expectedDraftRevision: 1,
    expectedDraftDigest: instance.draftDigest,
    proposalDigest: proposal.proposalDigest,
    conflictDigest: proposal.conflictDigest,
    resolutions: {},
  });
  assert.equal(applied.draftRevision, 2);
  const after = await f.owner.jrJourneyHead.findUniqueOrThrow({
    where: { tenantId_journeyId: { tenantId: f.tenantId, journeyId: instance.journeyId } },
  });
  assert.equal(after.lifecycle, 'DRAFT_ONLY');
  assert.equal(after.activeVersion, null);
  assert.equal(
    await f.owner.jrJourneyDefinition.count({ where: { journeyId: instance.journeyId } }),
    0,
  );
  assert.equal(
    (
      await f.owner.jrTemplateUpgradeApplication.findFirstOrThrow({
        where: { journeyId: instance.journeyId },
      })
    ).state,
    'APPLIED',
  );
  assert.deepEqual(
    await f.repo.listTemplateNotices(f.tenantId, f.actor('author'), instance.journeyId),
    [],
  );

  // deprecate: สร้าง instance ใหม่ไม่ได้ แต่ instance เดิมไม่ถูกแตะและได้ notice แบบข้อมูล
  const head = await f.owner.jrTemplateHead.findUniqueOrThrow({
    where: { tenantId_templateId: { tenantId: f.tenantId, templateId: v1.templateId } },
  });
  await f.repo.changeTemplateLifecycle(f.as('admin'), {
    templateId: v1.templateId,
    expectedHeadVersion: head.version,
    target: 'DEPRECATED',
    reasonCode: 'RETIRED',
  });
  await rejects(
    f.repo.instantiateTemplate(f.as('author'), {
      origin: 'TENANT',
      templateId: v1.templateId,
      version: 2,
      expectedContentDigest: (
        await f.owner.jrTemplateVersion.findFirstOrThrow({
          where: { templateId: v1.templateId, version: 2 },
        })
      ).contentDigest,
      bindings,
      targetOwnerTeamId: f.teamA,
      name: 'x',
    }),
    'TEMPLATE_DEPRECATED',
  );
  const unchanged = await f.owner.jrJourneyHead.findUniqueOrThrow({
    where: { tenantId_journeyId: { tenantId: f.tenantId, journeyId: instance.journeyId } },
  });
  assert.equal(unchanged.currentDraftDigest, after.currentDraftDigest);
  assert.deepEqual(
    (await f.repo.listTemplateNotices(f.tenantId, f.actor('author'), instance.journeyId)).map(
      (notice) => notice.kind,
    ),
    ['DEPRECATED'],
  );
});

test('J5-CC01 maker-checker ของ template และ fork เป็น tenant template ใหม่ที่ไม่ผูกกับต้นทาง', async (t) => {
  const f = await setup(t);
  const content = f.builtIn.content;
  const created = await f.repo.createTemplateDraft(f.as('author'), {
    ownerTeamId: f.teamA,
    visibility: 'TEAM',
    name: 'self-approve',
    document: content.document,
    parameterSchema: content.parameterSchema,
  });
  const review = await f.repo.submitTemplateReview(f.as('author'), {
    templateId: created.templateId,
    draftRevision: 1,
    draftDigest: created.draftDigest,
    baseHeadVersion: 1,
  });
  await rejects(
    f.repo.publishTemplateVersion(f.as('author'), {
      templateId: created.templateId,
      reviewId: review.reviewId,
      draftRevision: 1,
      draftDigest: created.draftDigest,
      expectedHeadVersion: 1,
    }),
    'APPROVAL_REQUIRED',
  );
  // secret parameter ใน tenant template บันทึกไม่ได้ตั้งแต่ draft
  await rejects(
    f.repo.createTemplateDraft(f.as('author'), {
      ownerTeamId: f.teamA,
      visibility: 'TEAM',
      name: 'bad',
      document: content.document,
      parameterSchema: [
        ...content.parameterSchema,
        {
          parameterKey: 'apiKey',
          labelKey: 'x',
          type: 'SECRET',
          required: true,
          bindTargets: [],
        } as never,
      ],
    }),
    'TEMPLATE_PARAMETER_INVALID',
  );

  const forked = await f.repo.forkTemplate(f.as('author'), {
    origin: 'PLATFORM_BUILTIN',
    templateId: REMINDER,
    version: 1,
    expectedContentDigest: f.builtIn.contentDigest,
    targetOwnerTeamId: f.teamA,
    name: 'forked',
    visibility: 'TEAM',
  });
  const forkedHead = await f.owner.jrTemplateHead.findUniqueOrThrow({
    where: { tenantId_templateId: { tenantId: f.tenantId, templateId: forked.templateId } },
  });
  assert.notEqual(forked.templateId, REMINDER);
  assert.equal(forkedHead.lifecycle, 'DRAFT_ONLY');
  assert.equal(forkedHead.activeVersion, null);
});

test('J5.5 getTemplate แนบ draft เฉพาะผู้แก้ได้ และ discard กลับเป็นเนื้อหา version ที่ active', async (t) => {
  const f = await setup(t);
  const content = f.builtIn.content;
  const published = await f.publishTenantTemplate(content.document, content.parameterSchema);
  const changed = structuredClone(content) as any;
  changed.document.nodes.find((node: any) => node.templateNodeKey === 'done').config.reason =
    'CHANGED';
  let head = await f.owner.jrTemplateHead.findUniqueOrThrow({
    where: { tenantId_templateId: { tenantId: f.tenantId, templateId: published.templateId } },
  });
  const updated = await f.repo.updateTemplateDraft(f.as('author'), {
    templateId: published.templateId,
    expectedHeadVersion: head.version,
    expectedDraftRevision: head.currentDraftRevision,
    expectedDraftDigest: head.currentDraftDigest,
    document: changed.document,
    parameterSchema: changed.parameterSchema,
  });
  assert.notEqual(updated.draftDigest, published.contentDigest);

  const asAuthor = await f.repo.getTemplate(f.tenantId, f.actor('author'), {
    templateId: published.templateId,
  });
  assert.equal(asAuthor.version?.version, 1);
  assert.equal(asAuthor.draft?.digest, updated.draftDigest);
  const asReviewer = await f.repo.getTemplate(f.tenantId, f.actor('reviewer'), {
    templateId: published.templateId,
  });
  assert.equal(asReviewer.draft, null);
  await rejects(
    f.repo.getTemplate(f.tenantId, f.actor('outsider'), { templateId: published.templateId }),
    'TEMPLATE_NOT_FOUND',
  );
  await rejects(
    f.repo.getTemplate(f.tenantId, f.actor('author'), { templateId: REMINDER, version: 9 }),
    'TEMPLATE_VERSION_NOT_FOUND',
  );

  head = await f.owner.jrTemplateHead.findUniqueOrThrow({
    where: { tenantId_templateId: { tenantId: f.tenantId, templateId: published.templateId } },
  });
  const discarded = await f.repo.discardTemplateDraft(f.as('author'), {
    templateId: published.templateId,
    expectedHeadVersion: head.version,
    expectedDraftRevision: head.currentDraftRevision,
    expectedDraftDigest: head.currentDraftDigest,
    reasonCode: 'DISCARD',
  });
  assert.equal(discarded.draftRevision, head.currentDraftRevision + 1);
  assert.equal(discarded.draftDigest, published.contentDigest);
});
