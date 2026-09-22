import {
  JOURNEY_AUTHORING_REGISTRY_VERSION,
  JOURNEY_AUTHORING_SCHEMA_VERSION,
  JOURNEY_TEMPLATE_LIFECYCLE_TRANSITIONS,
  JOURNEY_TEMPLATE_SCHEMA_VERSION,
  type ApplyTemplateUpgradeRequestV1,
  type AuthoringDocumentV1,
  type CheckTemplateUpgradeRequestV1,
  type JourneyAuthoringAuthorizationScope,
  type JourneyTemplateContentV1,
  type JourneyTemplateLifecycle,
  type JourneyTemplateNoticeV1,
  type JourneyTemplateOrigin,
  type JourneyTemplateParameterV1,
  type JourneyTemplateParameterValue,
  type JourneyTemplateUpgradeProposalV1,
  type JourneyTemplateVersionViewV1,
  type JourneyTemplateVisibility,
} from '@d-contact/cxa-contracts';
import {
  Prisma,
  withTenantDatabaseTransaction,
  type JrTemplateHead,
  type PrismaClient,
} from '@d-contact/db';
import { journeyAuthoringDigest, journeyCapabilityDigest } from './journey-authoring-canonical.js';
import { JourneyAuthoringError, type JourneyAuthoringActor } from './journey-authoring-model.js';
import {
  JourneyAuthoringRepository,
  type JourneyAuthoringRepositoryOptions,
  type JourneyCommandContext,
  type JourneyDraftResult,
} from './journey-authoring-repository.js';
import { bindTemplate, validateTemplatePackage } from './journey-template-binder.js';
import { BuiltInTemplateCatalog, templateNodeMappingDigest } from './journey-template-catalog.js';
import {
  TemplateUpgradeConflictError,
  TemplateUpgradeStaleError,
  applyTemplateUpgrade,
  checkTemplateUpgrade,
} from './journey-template-upgrade.js';

/**
 * J5.4 (#342): tenant template catalog, instantiate/fork และ explicit upgrade (คำตัดสิน #330)
 *
 * - built-in มาจาก `BuiltInTemplateCatalog` เท่านั้น ไม่มีแถวใน DB; tenant template อยู่ในตาราง RLS
 * - instantiate/fork สร้างของใหม่แบบ detached — ไม่มี live pointer กลับ template; source ที่
 *   อัปเดต/deprecate ภายหลังไม่เปลี่ยน draft, published version หรือ enrollment ที่สร้างไปแล้ว
 * - upgrade คือ proposal แบบ three-way ที่ apply ได้เป็น draft revision ใหม่เท่านั้น ไม่ publish เอง
 * - ของที่มองไม่เห็นตอบ TEMPLATE_NOT_FOUND แบบเดียวกับไม่มีอยู่จริง
 */

type Tx = Prisma.TransactionClient;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TemplateSource {
  readonly origin: JourneyTemplateOrigin;
  readonly view: JourneyTemplateVersionViewV1;
  readonly head: JrTemplateHead | null;
}

export interface JourneyTemplateRepositoryOptions extends JourneyAuthoringRepositoryOptions {
  readonly catalog?: BuiltInTemplateCatalog;
}

export class JourneyTemplateRepository extends JourneyAuthoringRepository {
  private readonly catalog: BuiltInTemplateCatalog;

  constructor(database: PrismaClient, options: JourneyTemplateRepositoryOptions) {
    super(database, options);
    this.catalog =
      options.catalog ?? new BuiltInTemplateCatalog({ capabilities: this.capabilities });
  }

  // ── Tenant template draft / review / publish ──────────────────────────────

  async createTemplateDraft(
    context: JourneyCommandContext,
    input: {
      readonly ownerTeamId: string;
      readonly visibility: JourneyTemplateVisibility;
      readonly name: string;
      readonly document: AuthoringDocumentV1;
      readonly parameterSchema: readonly JourneyTemplateParameterV1[];
    },
  ) {
    const templateId = this.id();
    return this.command(
      context,
      'CreateTemplateDraft',
      templateId,
      input,
      async (tx) => {
        await this.assertWriteEnabled(tx, context.tenantId, 'templateCatalog');
        await this.authorize(tx, context, 'template.edit', { teamId: input.ownerTeamId });
        const content = this.contentOf(input.document, input.parameterSchema);
        const diagnostics = this.assertTemplateSavable(content);
        const draftId = this.id();
        const digest = journeyAuthoringDigest(content);
        await tx.jrTemplateDraft.create({
          data: {
            id: draftId,
            tenantId: context.tenantId,
            templateId,
            revision: 1,
            schemaVersion: JOURNEY_TEMPLATE_SCHEMA_VERSION,
            registryVersion: JOURNEY_AUTHORING_REGISTRY_VERSION,
            document: input.document as unknown as Prisma.InputJsonValue,
            parameterSchema: input.parameterSchema as unknown as Prisma.InputJsonValue,
            contentDigest: digest,
            createdByRef: context.actor.subjectId,
          },
        });
        await tx.jrTemplateHead.create({
          data: {
            tenantId: context.tenantId,
            templateId,
            name: input.name,
            ownerTeamId: input.ownerTeamId,
            visibility: input.visibility,
            currentDraftId: draftId,
            currentDraftRevision: 1,
            currentDraftDigest: digest,
          },
        });
        await this.record(
          tx,
          context,
          templateId,
          1,
          'TEMPLATE_DRAFT_CREATED',
          'USER_EDIT',
          null,
          digest,
          'TEMPLATE',
        );
        return { templateId, headVersion: 1, draftRevision: 1, draftDigest: digest, diagnostics };
      },
      'TEMPLATE',
    );
  }

  async updateTemplateDraft(
    context: JourneyCommandContext,
    input: {
      readonly templateId: string;
      readonly expectedHeadVersion: number;
      readonly expectedDraftRevision: number;
      readonly expectedDraftDigest: string;
      readonly document: AuthoringDocumentV1;
      readonly parameterSchema: readonly JourneyTemplateParameterV1[];
    },
  ) {
    return this.command(
      context,
      'UpdateTemplateDraft',
      input.templateId,
      input,
      async (tx) => {
        await this.assertWriteEnabled(tx, context.tenantId, 'templateCatalog');
        const head = await this.lockedTemplateHead(tx, context.tenantId, input.templateId);
        await this.authorize(tx, context, 'template.edit', this.templateScope(head));
        this.assertTemplateEditable(head);
        if (head.version !== input.expectedHeadVersion) {
          throw new JourneyAuthoringError('TEMPLATE_VERSION_CONFLICT', {
            currentHeadVersion: head.version,
          });
        }
        if (
          head.currentDraftRevision !== input.expectedDraftRevision ||
          head.currentDraftDigest !== input.expectedDraftDigest
        ) {
          throw new JourneyAuthoringError('DRAFT_VERSION_CONFLICT', {
            currentDraftRevision: head.currentDraftRevision,
            currentDraftDigest: head.currentDraftDigest,
          });
        }
        const content = this.contentOf(input.document, input.parameterSchema);
        const diagnostics = this.assertTemplateSavable(content);
        const revision = head.currentDraftRevision + 1;
        const digest = journeyAuthoringDigest(content);
        const draftId = this.id();
        await tx.jrTemplateDraft.create({
          data: {
            id: draftId,
            tenantId: context.tenantId,
            templateId: head.templateId,
            revision,
            schemaVersion: JOURNEY_TEMPLATE_SCHEMA_VERSION,
            registryVersion: JOURNEY_AUTHORING_REGISTRY_VERSION,
            document: input.document as unknown as Prisma.InputJsonValue,
            parameterSchema: input.parameterSchema as unknown as Prisma.InputJsonValue,
            contentDigest: digest,
            createdByRef: context.actor.subjectId,
          },
        });
        await this.supersedeTemplateReviews(tx, context.tenantId, head.templateId);
        const headVersion = await this.casTemplateHead(tx, head, {
          currentDraftId: draftId,
          currentDraftRevision: revision,
          currentDraftDigest: digest,
        });
        await this.record(
          tx,
          context,
          head.templateId,
          headVersion,
          'TEMPLATE_DRAFT_UPDATED',
          'USER_EDIT',
          head.currentDraftDigest,
          digest,
          'TEMPLATE',
        );
        return {
          templateId: head.templateId,
          headVersion,
          draftRevision: revision,
          draftDigest: digest,
          diagnostics,
        };
      },
      'TEMPLATE',
    );
  }

  /** template publish ต้องผ่าน maker-checker เหมือน Journey (#331 §10) — candidate pin content digest */
  async submitTemplateReview(
    context: JourneyCommandContext,
    input: {
      readonly templateId: string;
      readonly draftRevision: number;
      readonly draftDigest: string;
      readonly baseHeadVersion: number;
    },
  ) {
    return this.command(
      context,
      'SubmitTemplateReview',
      input.templateId,
      input,
      async (tx) => {
        const head = await this.lockedTemplateHead(tx, context.tenantId, input.templateId);
        const decision = await this.authorize(
          tx,
          context,
          'template.edit',
          this.templateScope(head),
        );
        this.assertTemplateEditable(head);
        this.assertTemplateCas(head, input.baseHeadVersion, input.draftRevision, input.draftDigest);
        const content = await this.draftContent(tx, head);
        const diagnostics = validateTemplatePackage(content, this.capabilities);
        if (diagnostics.length > 0)
          throw new JourneyAuthoringError(diagnostics[0]!.code, undefined, diagnostics);
        await this.supersedeTemplateReviews(tx, context.tenantId, head.templateId);
        const reviewId = this.id();
        await tx.jrReviewCandidate.create({
          data: {
            id: reviewId,
            tenantId: context.tenantId,
            resourceKind: 'TEMPLATE',
            resourceId: head.templateId,
            draftRevision: head.currentDraftRevision,
            draftDigest: head.currentDraftDigest,
            compileDigest: journeyAuthoringDigest(content.document),
            runtimeHash: journeyAuthoringDigest(content),
            baseHeadVersion: head.version,
            referenceDigest: journeyAuthoringDigest(content.parameterSchema),
            capabilityDigest: journeyCapabilityDigest(this.capabilities),
            makerSubjectId: context.actor.subjectId,
            makerAuthorizationEpoch: decision.authorizationEpoch,
            makerScopeVersion: decision.scopeVersion,
            state: 'IN_REVIEW',
          },
        });
        await this.record(
          tx,
          context,
          head.templateId,
          head.version,
          'TEMPLATE_REVIEW_SUBMITTED',
          'SUBMIT',
          head.currentDraftDigest,
          head.currentDraftDigest,
          'TEMPLATE',
        );
        return { reviewId, state: 'IN_REVIEW' as const };
      },
      'TEMPLATE',
    );
  }

  async decideTemplateReview(
    context: JourneyCommandContext,
    input: {
      readonly templateId: string;
      readonly reviewId: string;
      readonly decision: 'APPROVE' | 'REJECT' | 'REQUEST_CHANGES';
      readonly reasonCode: string;
      readonly evidenceRef: string;
    },
  ) {
    return this.command(
      context,
      'DecideTemplateReview',
      input.templateId,
      input,
      async (tx) => {
        const head = await this.lockedTemplateHead(tx, context.tenantId, input.templateId);
        const decision = await this.authorize(
          tx,
          context,
          'template.review',
          this.templateScope(head),
          { requireDirect: true },
        );
        const candidate = await tx.jrReviewCandidate.findFirst({
          where: {
            tenantId: context.tenantId,
            id: input.reviewId,
            resourceKind: 'TEMPLATE',
            resourceId: head.templateId,
          },
        });
        if (!candidate) throw new JourneyAuthoringError('TEMPLATE_NOT_FOUND');
        if (candidate.state !== 'IN_REVIEW' || candidate.draftDigest !== head.currentDraftDigest) {
          throw new JourneyAuthoringError('REVIEW_CANDIDATE_STALE');
        }
        if (candidate.makerSubjectId === context.actor.subjectId)
          throw new JourneyAuthoringError('APPROVAL_SELF_FORBIDDEN');
        await tx.jrReviewDecisionRecord.create({
          data: {
            id: this.id(),
            tenantId: context.tenantId,
            candidateId: candidate.id,
            decision: input.decision,
            reviewerSubjectId: context.actor.subjectId,
            capability: 'template.review',
            capabilitySource: decision.source,
            authorizationEpoch: decision.authorizationEpoch,
            scopeVersion: decision.scopeVersion,
            evidenceRef: input.evidenceRef,
            reasonCode: input.reasonCode,
            decidedAt: this.now(),
          },
        });
        const state =
          input.decision === 'APPROVE'
            ? 'APPROVED'
            : input.decision === 'REJECT'
              ? 'REJECTED'
              : 'CHANGES_REQUESTED';
        await tx.jrReviewCandidate.update({ where: { id: candidate.id }, data: { state } });
        await this.record(
          tx,
          context,
          head.templateId,
          head.version,
          `TEMPLATE_REVIEW_${state}`,
          input.reasonCode,
          candidate.draftDigest,
          candidate.draftDigest,
          'TEMPLATE',
        );
        return { reviewId: candidate.id, state };
      },
      'TEMPLATE',
    );
  }

  async publishTemplateVersion(
    context: JourneyCommandContext,
    input: {
      readonly templateId: string;
      readonly reviewId: string;
      readonly draftRevision: number;
      readonly draftDigest: string;
      readonly expectedHeadVersion: number;
    },
  ) {
    return this.command(
      context,
      'PublishTemplateVersion',
      input.templateId,
      input,
      async (tx) => {
        await this.assertWriteEnabled(tx, context.tenantId, 'templateCatalog');
        const head = await this.lockedTemplateHead(tx, context.tenantId, input.templateId);
        await this.authorize(tx, context, 'template.publish', this.templateScope(head), {
          requireDirect: true,
        });
        this.assertTemplateEditable(head);
        this.assertTemplateCas(
          head,
          input.expectedHeadVersion,
          input.draftRevision,
          input.draftDigest,
        );
        const candidate = await tx.jrReviewCandidate.findFirst({
          where: {
            tenantId: context.tenantId,
            id: input.reviewId,
            resourceKind: 'TEMPLATE',
            resourceId: head.templateId,
          },
        });
        if (!candidate || candidate.state !== 'APPROVED')
          throw new JourneyAuthoringError('APPROVAL_REQUIRED');
        if (
          candidate.draftDigest !== head.currentDraftDigest ||
          candidate.baseHeadVersion !== head.version
        ) {
          throw new JourneyAuthoringError('REVIEW_CANDIDATE_STALE');
        }
        await this.assertTemplateApproval(
          tx,
          context.tenantId,
          head,
          candidate.id,
          candidate.makerSubjectId,
        );
        const content = await this.draftContent(tx, head);
        const diagnostics = validateTemplatePackage(content, this.capabilities);
        if (diagnostics.length > 0)
          throw new JourneyAuthoringError(diagnostics[0]!.code, undefined, diagnostics);

        const version = (head.activeVersion ?? 0) + 1;
        const versionId = this.id();
        const contentDigest = journeyAuthoringDigest(content);
        await tx.jrTemplateVersion.create({
          data: {
            id: versionId,
            tenantId: context.tenantId,
            templateId: head.templateId,
            version,
            visibility: head.visibility,
            ownerTeamId: head.ownerTeamId,
            schemaVersion: JOURNEY_TEMPLATE_SCHEMA_VERSION,
            registryVersion: JOURNEY_AUTHORING_REGISTRY_VERSION,
            document: content.document as unknown as Prisma.InputJsonValue,
            parameterSchema: content.parameterSchema as unknown as Prisma.InputJsonValue,
            contentDigest,
            compileDigest: journeyAuthoringDigest(content.document),
            nodeMappingDigest: templateNodeMappingDigest(content),
            publishedByRef: context.actor.subjectId,
            publishedAt: this.now(),
          },
        });
        const headVersion = await this.casTemplateHead(tx, head, {
          activeVersion: version,
          activeVersionId: versionId,
          lifecycle: head.lifecycle === 'DRAFT_ONLY' ? 'ACTIVE' : head.lifecycle,
        });
        await tx.jrReviewCandidate.update({
          where: { id: candidate.id },
          data: { state: 'SUPERSEDED' },
        });
        await this.record(
          tx,
          context,
          head.templateId,
          headVersion,
          'TEMPLATE_VERSION_PUBLISHED',
          'PUBLISH',
          head.currentDraftDigest,
          contentDigest,
          'TEMPLATE',
        );
        return { templateId: head.templateId, version, contentDigest, headVersion };
      },
      'TEMPLATE',
    );
  }

  async changeTemplateVisibility(
    context: JourneyCommandContext,
    input: {
      readonly templateId: string;
      readonly expectedHeadVersion: number;
      readonly visibility: JourneyTemplateVisibility;
      readonly reasonCode: string;
    },
  ) {
    return this.command(
      context,
      'ChangeTemplateVisibility',
      input.templateId,
      input,
      async (tx) => {
        const head = await this.lockedTemplateHead(tx, context.tenantId, input.templateId);
        await this.authorize(tx, context, 'template.visibility', this.templateScope(head), {
          requireDirect: true,
        });
        if (head.version !== input.expectedHeadVersion) {
          throw new JourneyAuthoringError('TEMPLATE_VERSION_CONFLICT', {
            currentHeadVersion: head.version,
          });
        }
        const headVersion = await this.casTemplateHead(tx, head, { visibility: input.visibility });
        await this.record(
          tx,
          context,
          head.templateId,
          headVersion,
          'TEMPLATE_VISIBILITY_CHANGED',
          input.reasonCode,
          null,
          null,
          'TEMPLATE',
        );
        return { templateId: head.templateId, headVersion, visibility: input.visibility };
      },
      'TEMPLATE',
    );
  }

  /** deprecate/archive/restore ไม่แตะ version ที่ publish แล้วหรือ Journey ที่สร้างไปแล้ว (#330 §12) */
  async changeTemplateLifecycle(
    context: JourneyCommandContext,
    input: {
      readonly templateId: string;
      readonly expectedHeadVersion: number;
      readonly target: Exclude<JourneyTemplateLifecycle, 'DRAFT_ONLY'>;
      readonly reasonCode: string;
    },
  ) {
    return this.command(
      context,
      input.target === 'ARCHIVED'
        ? 'ArchiveTemplate'
        : input.target === 'DEPRECATED'
          ? 'DeprecateTemplate'
          : 'RestoreTemplate',
      input.templateId,
      input,
      async (tx) => {
        const head = await this.lockedTemplateHead(tx, context.tenantId, input.templateId);
        await this.authorize(tx, context, 'template.lifecycle', this.templateScope(head), {
          requireDirect: true,
          allowInactiveTeam: true,
        });
        if (head.version !== input.expectedHeadVersion) {
          throw new JourneyAuthoringError('TEMPLATE_VERSION_CONFLICT', {
            currentHeadVersion: head.version,
          });
        }
        if (
          !(JOURNEY_TEMPLATE_LIFECYCLE_TRANSITIONS[head.lifecycle] as readonly string[]).includes(
            input.target,
          )
        ) {
          throw new JourneyAuthoringError('JOURNEY_LIFECYCLE_CONFLICT', {
            from: head.lifecycle,
            to: input.target,
          });
        }
        const headVersion = await this.casTemplateHead(tx, head, { lifecycle: input.target });
        await this.record(
          tx,
          context,
          head.templateId,
          headVersion,
          `TEMPLATE_${input.target}`,
          input.reasonCode,
          null,
          null,
          'TEMPLATE',
        );
        return { templateId: head.templateId, headVersion, lifecycle: input.target };
      },
      'TEMPLATE',
    );
  }

  // ── Catalog ───────────────────────────────────────────────────────────────

  /**
   * built-in ทั้งหมด + tenant template ที่ publish แล้วและผู้เรียกอ่านได้ตาม visibility — ARCHIVED
   * ไม่อยู่ใน catalog ปกติ; ของที่อ่านไม่ได้ไม่ถูกนับหรือบอกใบ้ว่ามีอยู่
   */
  async listVisibleTemplates(
    tenantId: string,
    actor: JourneyAuthoringActor,
  ): Promise<JourneyTemplateVersionViewV1[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const heads = await tx.jrTemplateHead.findMany({
        where: {
          tenantId,
          activeVersionId: { not: null },
          lifecycle: { in: ['ACTIVE', 'DEPRECATED'] },
        },
        orderBy: { templateId: 'asc' },
      });
      const visible: JourneyTemplateVersionViewV1[] = [
        ...this.catalog.list().filter((entry) => entry.lifecycle !== 'ARCHIVED'),
      ];
      for (const head of heads) {
        if (!(await this.canRead(tx, tenantId, actor, head))) continue;
        visible.push(await this.tenantVersionView(tx, head, head.activeVersion!));
      }
      return visible;
    });
  }

  // ── Instantiate / fork ────────────────────────────────────────────────────

  /**
   * สร้าง Journey ใหม่แบบ detached จาก version ที่ระบุแน่นอน (id + version + digest) พร้อม provenance;
   * retry ด้วย key เดิมได้ Journey เดิม ไม่สร้างซ้ำ
   */
  async instantiateTemplate(
    context: JourneyCommandContext,
    input: {
      readonly origin: JourneyTemplateOrigin;
      readonly templateId: string;
      readonly version: number;
      readonly expectedContentDigest: string;
      readonly bindings: Readonly<Record<string, JourneyTemplateParameterValue>>;
      readonly targetOwnerTeamId: string;
      readonly name: string;
    },
  ): Promise<
    JourneyDraftResult & { readonly templateId: string; readonly templateVersion: number }
  > {
    const journeyId = this.id();
    return this.command(context, 'InstantiateTemplate', journeyId, input, async (tx) => {
      await this.assertWriteEnabled(tx, context.tenantId, 'templateCatalog');
      const source = await this.resolveSource(tx, context.tenantId, context.actor, input);
      if (source.view.lifecycle !== 'ACTIVE')
        throw new JourneyAuthoringError('TEMPLATE_DEPRECATED');
      await this.authorize(tx, context, 'journey.edit', { teamId: input.targetOwnerTeamId });
      const bound = bindTemplate(source.view.content, input.bindings, {
        journeyId,
        name: input.name,
      });
      if (!bound.document) {
        throw new JourneyAuthoringError(bound.diagnostics[0]!.code, undefined, bound.diagnostics);
      }
      await this.verifyReferences(tx, context.tenantId, bound.references);
      const diagnostics = this.assertSavable(bound.document);
      await this.lockJourney(tx, context.tenantId, journeyId);
      const draft = await this.insertDraft(tx, context, journeyId, 1, null, bound.document);
      await tx.jrJourneyHead.create({
        data: {
          tenantId: context.tenantId,
          journeyId,
          name: input.name,
          ownerTeamId: input.targetOwnerTeamId,
          currentDraftId: draft.id,
          currentDraftRevision: 1,
          currentDraftDigest: draft.contentDigest,
        },
      });
      await tx.jrTemplateProvenance.create({
        data: {
          tenantId: context.tenantId,
          journeyId,
          draftRevision: 1,
          templateOrigin: source.origin,
          sourceTemplateId: source.view.templateId,
          sourceTemplateVersion: source.view.version,
          sourceContentDigest: source.view.contentDigest,
          bindingDigest: bound.bindingDigest,
          nodeMapping: bound.nodeMapping,
          nodeMappingDigest: journeyAuthoringDigest(bound.nodeMapping),
        },
      });
      await this.record(
        tx,
        context,
        journeyId,
        1,
        'TEMPLATE_INSTANTIATED',
        'INSTANTIATE',
        source.view.contentDigest,
        draft.contentDigest,
      );
      return {
        journeyId,
        headVersion: 1,
        draftRevision: 1,
        draftDigest: draft.contentDigest,
        diagnostics,
        templateId: source.view.templateId,
        templateVersion: source.view.version,
      };
    });
  }

  /** fork สร้าง tenant template ใหม่จาก version ที่ระบุ — copy แบบ exact ไม่มี latest pointer */
  async forkTemplate(
    context: JourneyCommandContext,
    input: {
      readonly origin: JourneyTemplateOrigin;
      readonly templateId: string;
      readonly version: number;
      readonly expectedContentDigest: string;
      readonly targetOwnerTeamId: string;
      readonly name: string;
      readonly visibility: JourneyTemplateVisibility;
    },
  ) {
    const forkedId = this.id();
    return this.command(
      context,
      'ForkTemplate',
      forkedId,
      input,
      async (tx) => {
        await this.assertWriteEnabled(tx, context.tenantId, 'templateCatalog');
        const source = await this.resolveSource(tx, context.tenantId, context.actor, input);
        if (source.view.lifecycle !== 'ACTIVE')
          throw new JourneyAuthoringError('TEMPLATE_DEPRECATED');
        await this.authorize(tx, context, 'template.edit', { teamId: input.targetOwnerTeamId });
        const content = source.view.content;
        const digest = journeyAuthoringDigest(content);
        const draftId = this.id();
        await tx.jrTemplateDraft.create({
          data: {
            id: draftId,
            tenantId: context.tenantId,
            templateId: forkedId,
            revision: 1,
            schemaVersion: JOURNEY_TEMPLATE_SCHEMA_VERSION,
            registryVersion: JOURNEY_AUTHORING_REGISTRY_VERSION,
            document: content.document as unknown as Prisma.InputJsonValue,
            parameterSchema: content.parameterSchema as unknown as Prisma.InputJsonValue,
            contentDigest: digest,
            createdByRef: context.actor.subjectId,
          },
        });
        await tx.jrTemplateHead.create({
          data: {
            tenantId: context.tenantId,
            templateId: forkedId,
            name: input.name,
            ownerTeamId: input.targetOwnerTeamId,
            visibility: input.visibility,
            currentDraftId: draftId,
            currentDraftRevision: 1,
            currentDraftDigest: digest,
          },
        });
        await this.record(
          tx,
          context,
          forkedId,
          1,
          'TEMPLATE_FORKED',
          'FORK',
          source.view.contentDigest,
          digest,
          'TEMPLATE',
        );
        return { templateId: forkedId, headVersion: 1, draftRevision: 1, draftDigest: digest };
      },
      'TEMPLATE',
    );
  }

  // ── Upgrade / notice ──────────────────────────────────────────────────────

  async checkTemplateUpgrade(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: CheckTemplateUpgradeRequestV1 & { readonly journeyId: string },
  ): Promise<JourneyTemplateUpgradeProposalV1> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const upgrade = await this.upgradeInput(
        tx,
        tenantId,
        actor,
        input.journeyId,
        input.targetVersion,
        'journey.read',
      );
      if (
        upgrade.head.currentDraftRevision !== input.draftRevision ||
        upgrade.head.currentDraftDigest !== input.draftDigest
      ) {
        throw new JourneyAuthoringError('TEMPLATE_UPGRADE_STALE');
      }
      return checkTemplateUpgrade(upgrade.input);
    });
  }

  /** apply สร้าง draft revision ใหม่ + provenance ใหม่เท่านั้น ไม่ publish/activate (#330 §10) */
  async applyTemplateUpgrade(
    context: JourneyCommandContext,
    input: ApplyTemplateUpgradeRequestV1 & { readonly journeyId: string },
  ): Promise<JourneyDraftResult> {
    return this.command(context, 'ApplyTemplateUpgrade', input.journeyId, input, async (tx) => {
      await this.assertWriteEnabled(tx, context.tenantId, 'templateUpgrade');
      const upgrade = await this.upgradeInput(
        tx,
        context.tenantId,
        context.actor,
        input.journeyId,
        input.targetVersion,
        'journey.edit',
      );
      const head = upgrade.head;
      if (head.version !== input.expectedHeadVersion) {
        throw new JourneyAuthoringError('PUBLISHED_HEAD_CONFLICT', {
          currentHeadVersion: head.version,
        });
      }
      if (
        head.currentDraftRevision !== input.expectedDraftRevision ||
        head.currentDraftDigest !== input.expectedDraftDigest
      ) {
        throw new JourneyAuthoringError('TEMPLATE_UPGRADE_STALE');
      }
      let applied: ReturnType<typeof applyTemplateUpgrade>;
      try {
        applied = applyTemplateUpgrade(upgrade.input, input);
      } catch (error) {
        if (error instanceof TemplateUpgradeStaleError)
          throw new JourneyAuthoringError('TEMPLATE_UPGRADE_STALE');
        if (error instanceof TemplateUpgradeConflictError) {
          throw new JourneyAuthoringError('TEMPLATE_UPGRADE_CONFLICT', {
            unresolved: error.conflictIds.length,
          });
        }
        throw error;
      }
      const diagnostics = this.assertSavable(applied.document);
      const result = await this.appendDraft(
        tx,
        context,
        head,
        applied.document,
        null,
        'TEMPLATE_UPGRADE_APPLIED',
        'UPGRADE',
        diagnostics,
      );
      await tx.jrTemplateProvenance.create({
        data: {
          tenantId: context.tenantId,
          journeyId: head.journeyId,
          draftRevision: result.draftRevision,
          templateOrigin: upgrade.source.origin,
          sourceTemplateId: upgrade.source.view.templateId,
          sourceTemplateVersion: upgrade.target.version,
          sourceContentDigest: upgrade.target.contentDigest,
          bindingDigest: upgrade.provenance.bindingDigest,
          nodeMapping: applied.nodeMapping,
          nodeMappingDigest: journeyAuthoringDigest(applied.nodeMapping),
        },
      });
      await tx.jrTemplateUpgradeApplication.create({
        data: {
          tenantId: context.tenantId,
          journeyId: head.journeyId,
          fromTemplateVersion: upgrade.provenance.sourceTemplateVersion,
          toTemplateVersion: upgrade.target.version,
          baseDraftDigest: journeyAuthoringDigest(upgrade.input.base.document),
          localDraftDigest: head.currentDraftDigest,
          proposedDraftDigest: result.draftDigest,
          conflictDigest: input.conflictDigest,
          state: 'APPLIED',
          requestHash: journeyAuthoringDigest(input),
          idempotencyKey: context.idempotencyKey,
          appliedAt: this.now(),
        },
      });
      return result;
    });
  }

  /** แจ้งเตือนเชิงข้อมูลเท่านั้น (#330 §9) — คำนวณตอนอ่าน ไม่ auto-apply/publish และไม่แตะ enrollment */
  async listTemplateNotices(
    tenantId: string,
    actor: JourneyAuthoringActor,
    journeyId: string,
  ): Promise<JourneyTemplateNoticeV1[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const head = await this.head(tx, tenantId, journeyId);
      await this.authorize(tx, { tenantId, actor }, 'journey.read', this.scopeOf(head));
      const provenance = await tx.jrTemplateProvenance.findFirst({
        where: { tenantId, journeyId },
        orderBy: { draftRevision: 'desc' },
      });
      if (!provenance) return [];
      const latest = await this.latestSourceVersion(
        tx,
        tenantId,
        provenance.templateOrigin,
        provenance.sourceTemplateId,
      );
      if (!latest) return [];
      const source = {
        origin: provenance.templateOrigin,
        templateId: provenance.sourceTemplateId,
        version: provenance.sourceTemplateVersion,
        contentDigest: provenance.sourceContentDigest,
      };
      const notices: JourneyTemplateNoticeV1[] = [];
      if (latest.version > provenance.sourceTemplateVersion) {
        notices.push({
          kind: 'UPDATE_AVAILABLE',
          journeyId,
          source,
          latestVersion: latest.version,
        });
      }
      if (latest.lifecycle === 'DEPRECATED' || latest.lifecycle === 'ARCHIVED') {
        notices.push({ kind: 'DEPRECATED', journeyId, source, latestVersion: latest.version });
      }
      return notices;
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private contentOf(
    document: AuthoringDocumentV1,
    parameterSchema: readonly JourneyTemplateParameterV1[],
  ): JourneyTemplateContentV1 {
    return {
      templateSchemaVersion: JOURNEY_TEMPLATE_SCHEMA_VERSION,
      authoringSchemaVersion: JOURNEY_AUTHORING_SCHEMA_VERSION,
      registryVersion: JOURNEY_AUTHORING_REGISTRY_VERSION,
      document,
      parameterSchema,
      requiredCapabilities: [],
    };
  }

  /** package ที่ไม่น่าเชื่อถือ (schema/ชนิด parameter ต้องห้าม) บันทึกไม่ได้; ข้อบกพร่องอื่นแก้ต่อได้ */
  private assertTemplateSavable(content: JourneyTemplateContentV1) {
    const diagnostics = validateTemplatePackage(content, this.capabilities);
    const blocking = diagnostics.filter(
      (item) =>
        item.code === 'TEMPLATE_PACKAGE_UNTRUSTED' ||
        (item.code === 'TEMPLATE_PARAMETER_INVALID' && item.safeParams?.reason === 'TYPE'),
    );
    if (blocking.length > 0)
      throw new JourneyAuthoringError(blocking[0]!.code, undefined, blocking);
    return diagnostics;
  }

  private templateScope(
    head: Pick<JrTemplateHead, 'ownerTeamId' | 'templateId'>,
  ): JourneyAuthoringAuthorizationScope {
    return { teamId: head.ownerTeamId, resource: { kind: 'TEMPLATE', id: head.templateId } };
  }

  private assertTemplateEditable(head: JrTemplateHead) {
    if (head.lifecycle === 'DEPRECATED' || head.lifecycle === 'ARCHIVED') {
      throw new JourneyAuthoringError('TEMPLATE_DEPRECATED');
    }
  }

  private assertTemplateCas(
    head: JrTemplateHead,
    expectedHeadVersion: number,
    draftRevision: number,
    draftDigest: string,
  ) {
    if (head.version !== expectedHeadVersion) {
      throw new JourneyAuthoringError('TEMPLATE_VERSION_CONFLICT', {
        currentHeadVersion: head.version,
      });
    }
    if (head.currentDraftRevision !== draftRevision || head.currentDraftDigest !== draftDigest) {
      throw new JourneyAuthoringError('DRAFT_VERSION_CONFLICT', {
        currentDraftRevision: head.currentDraftRevision,
        currentDraftDigest: head.currentDraftDigest,
      });
    }
  }

  private async templateHead(
    tx: Tx,
    tenantId: string,
    templateId: string,
  ): Promise<JrTemplateHead> {
    const head = UUID.test(templateId)
      ? await tx.jrTemplateHead.findUnique({
          where: { tenantId_templateId: { tenantId, templateId } },
        })
      : null;
    if (!head) throw new JourneyAuthoringError('TEMPLATE_NOT_FOUND');
    return head;
  }

  private async lockedTemplateHead(tx: Tx, tenantId: string, templateId: string) {
    await this.templateHead(tx, tenantId, templateId);
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`jr-template-authoring:${tenantId}:${templateId}`}))`,
    );
    return this.templateHead(tx, tenantId, templateId);
  }

  private async casTemplateHead(
    tx: Tx,
    head: JrTemplateHead,
    data: Prisma.JrTemplateHeadUpdateManyMutationInput,
  ) {
    const headVersion = head.version + 1;
    const updated = await tx.jrTemplateHead.updateMany({
      where: { tenantId: head.tenantId, templateId: head.templateId, version: head.version },
      data: { ...data, version: headVersion },
    });
    if (updated.count !== 1)
      throw new JourneyAuthoringError('TEMPLATE_VERSION_CONFLICT', {
        currentHeadVersion: head.version,
      });
    return headVersion;
  }

  private async supersedeTemplateReviews(tx: Tx, tenantId: string, templateId: string) {
    await tx.jrReviewCandidate.updateMany({
      where: {
        tenantId,
        resourceKind: 'TEMPLATE',
        resourceId: templateId,
        state: { in: ['IN_REVIEW', 'APPROVED'] },
      },
      data: { state: 'SUPERSEDED' },
    });
  }

  private async draftContent(tx: Tx, head: JrTemplateHead): Promise<JourneyTemplateContentV1> {
    const draft = await tx.jrTemplateDraft.findFirstOrThrow({
      where: {
        tenantId: head.tenantId,
        templateId: head.templateId,
        revision: head.currentDraftRevision,
      },
    });
    return this.contentOf(
      draft.document as unknown as AuthoringDocumentV1,
      draft.parameterSchema as unknown as JourneyTemplateParameterV1[],
    );
  }

  /** approver อิสระที่ยังมี direct template.review ณ ตอน publish และ epoch/scope ไม่เปลี่ยน */
  private async assertTemplateApproval(
    tx: Tx,
    tenantId: string,
    head: JrTemplateHead,
    candidateId: string,
    makerSubjectId: string,
  ) {
    const votes = await tx.jrReviewDecisionRecord.findMany({
      where: {
        tenantId,
        candidateId,
        decision: 'APPROVE',
        delegationId: null,
        reviewerSubjectId: { not: makerSubjectId },
      },
    });
    for (const vote of votes) {
      const current = await this.options.authorization.authorize(tx, {
        tenantId,
        subjectId: vote.reviewerSubjectId,
        capability: 'template.review',
        scope: this.templateScope(head),
        requireDirect: true,
      });
      if (
        current.allowed &&
        current.authorizationEpoch === vote.authorizationEpoch &&
        current.scopeVersion === vote.scopeVersion
      )
        return;
    }
    throw new JourneyAuthoringError(votes.length === 0 ? 'APPROVAL_REQUIRED' : 'APPROVAL_STALE');
  }

  private async canRead(
    tx: Tx,
    tenantId: string,
    actor: JourneyAuthoringActor,
    head: JrTemplateHead,
  ) {
    const decision = await this.options.authorization.authorize(tx, {
      tenantId,
      subjectId: actor.subjectId,
      capability: 'template.read',
      scope: this.templateScope(head),
      anyTeam: head.visibility === 'TENANT',
    });
    return decision.allowed;
  }

  private async tenantVersionView(
    tx: Tx,
    head: JrTemplateHead,
    version: number,
  ): Promise<JourneyTemplateVersionViewV1> {
    const row = await tx.jrTemplateVersion.findUnique({
      where: {
        tenantId_templateId_version: {
          tenantId: head.tenantId,
          templateId: head.templateId,
          version,
        },
      },
    });
    if (!row) throw new JourneyAuthoringError('TEMPLATE_VERSION_NOT_FOUND');
    return {
      origin: 'TENANT',
      templateId: row.templateId,
      version: row.version,
      contentDigest: row.contentDigest,
      name: head.name,
      visibility: head.visibility,
      ownerTeamId: head.ownerTeamId,
      lifecycle: head.lifecycle,
      content: this.contentOf(
        row.document as unknown as AuthoringDocumentV1,
        row.parameterSchema as unknown as JourneyTemplateParameterV1[],
      ),
      compileDigest: row.compileDigest,
      nodeMappingDigest: row.nodeMappingDigest,
      publishedAt: row.publishedAt.toISOString(),
    };
  }

  /** resolve version ที่ระบุแน่นอนและต้องมองเห็นได้; digest ไม่ตรง = คนละ package */
  private async resolveSource(
    tx: Tx,
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: {
      readonly origin: JourneyTemplateOrigin;
      readonly templateId: string;
      readonly version: number;
      readonly expectedContentDigest: string;
    },
  ): Promise<TemplateSource> {
    let source: TemplateSource;
    if (input.origin === 'PLATFORM_BUILTIN') {
      const view = this.catalog.get(input.templateId, input.version);
      if (!view) throw new JourneyAuthoringError('TEMPLATE_NOT_FOUND');
      source = { origin: 'PLATFORM_BUILTIN', view, head: null };
    } else {
      const head = await this.templateHead(tx, tenantId, input.templateId);
      if (!(await this.canRead(tx, tenantId, actor, head)))
        throw new JourneyAuthoringError('TEMPLATE_NOT_FOUND');
      source = {
        origin: 'TENANT',
        view: await this.tenantVersionView(tx, head, input.version),
        head,
      };
    }
    if (source.view.contentDigest !== input.expectedContentDigest)
      throw new JourneyAuthoringError('TEMPLATE_DIGEST_MISMATCH');
    return source;
  }

  private async latestSourceVersion(
    tx: Tx,
    tenantId: string,
    origin: JourneyTemplateOrigin,
    templateId: string,
  ) {
    if (origin === 'PLATFORM_BUILTIN') return this.catalog.get(templateId);
    const head = await tx.jrTemplateHead.findUnique({
      where: { tenantId_templateId: { tenantId, templateId } },
    });
    return head?.activeVersion
      ? { version: head.activeVersion, lifecycle: head.lifecycle }
      : undefined;
  }

  private async upgradeInput(
    tx: Tx,
    tenantId: string,
    actor: JourneyAuthoringActor,
    journeyId: string,
    targetVersion: number,
    capability: 'journey.read' | 'journey.edit',
  ) {
    const head =
      capability === 'journey.edit'
        ? await this.lockedHead(tx, tenantId, journeyId)
        : await this.head(tx, tenantId, journeyId);
    await this.authorize(tx, { tenantId, actor }, capability, this.scopeOf(head));
    this.assertEditable(head);
    const provenance = await tx.jrTemplateProvenance.findFirst({
      where: { tenantId, journeyId },
      orderBy: { draftRevision: 'desc' },
    });
    if (!provenance) throw new JourneyAuthoringError('TEMPLATE_PROVENANCE_INVALID');
    const reference = {
      origin: provenance.templateOrigin,
      templateId: provenance.sourceTemplateId,
    };
    const base = await this.resolveSource(tx, tenantId, actor, {
      ...reference,
      version: provenance.sourceTemplateVersion,
      expectedContentDigest: provenance.sourceContentDigest,
    });
    const targetSource =
      reference.origin === 'PLATFORM_BUILTIN'
        ? this.catalog.get(reference.templateId, targetVersion)
        : await this.tenantVersionView(tx, base.head!, targetVersion);
    if (!targetSource || targetVersion <= provenance.sourceTemplateVersion)
      throw new JourneyAuthoringError('TEMPLATE_VERSION_NOT_FOUND');
    const draft = await tx.jrJourneyDraft.findFirstOrThrow({
      where: { tenantId, journeyId, revision: head.currentDraftRevision },
    });
    return {
      head,
      provenance,
      source: base,
      target: targetSource,
      input: {
        journeyId,
        fromVersion: provenance.sourceTemplateVersion,
        toVersion: targetVersion,
        base: base.view.content,
        target: targetSource.content,
        local: draft.document as unknown as AuthoringDocumentV1,
        nodeMapping: provenance.nodeMapping as Record<string, string>,
        capabilities: this.capabilities,
      },
    };
  }

  /** reference ทุกตัวตรวจกับ tenant/scope ปัจจุบันตอน instantiate (#330 §5) */
  private async verifyReferences(
    tx: Tx,
    tenantId: string,
    references: ReadonlyArray<{ resourceKind: string; id: string }>,
  ) {
    for (const { resourceKind, id } of references) {
      const uuid = UUID.test(id);
      const exists = await (async () => {
        switch (resourceKind) {
          case 'OWNER_TEAM':
          case 'TARGET_TEAM':
            return uuid && (await tx.team.count({ where: { tenantId, id, isActive: true } })) > 0;
          case 'SEGMENT':
            return (
              (await tx.c360SegmentDefinitionHead.count({
                where: { tenantId, segmentId: id, currentVersion: { not: null } },
              })) > 0
            );
          case 'QUEUE':
            return uuid && (await tx.queue.count({ where: { tenantId, id, isActive: true } })) > 0;
          case 'AGENT':
            return uuid && (await tx.user.count({ where: { tenantId, id, isActive: true } })) > 0;
          case 'CAMPAIGN':
            return uuid && (await tx.obCampaign.count({ where: { tenantId, id } })) > 0;
          case 'CASE_TYPE':
            return (await tx.csCaseTypePolicy.count({ where: { tenantId, policyRef: id } })) > 0;
          case 'ROUTING_INTENT':
            return (await tx.csRoutingPolicy.count({ where: { tenantId, policyRef: id } })) > 0;
          default:
            // CONTENT/SENDER_IDENTITY ยังไม่มี owner store ใน repo นี้ — ผ่านได้แค่ opaque shape ที่ binder ตรวจแล้ว
            return true;
        }
      })();
      if (!exists)
        throw new JourneyAuthoringError('TEMPLATE_REFERENCE_UNTRUSTED', { resourceKind });
    }
  }
}
