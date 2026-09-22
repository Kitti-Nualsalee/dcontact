import { randomUUID } from 'node:crypto';
import {
  Prisma,
  withTenantDatabaseTransaction,
  type JrJourneyHead,
  type PrismaClient,
} from '@d-contact/db';
import {
  JOURNEY_AUTHORING_REGISTRY_VERSION,
  JOURNEY_AUTHORING_SCHEMA_VERSION,
  type AuthoringDocumentV1,
  type CompileJourneyResultV1,
  type ExpressionEvaluator,
  type JourneyAuthoringCapability,
  type JourneyAuthoringStateV1,
  type JourneyDiagnosticV1,
  type JourneyLifecycle,
  type PublishJourneyDraftRequestV1,
  type PublishJourneyResultV1,
} from '@d-contact/cxa-contracts';
import {
  JOURNEY_RUNTIME_CAPABILITIES,
  journeyAuthoringDigest,
  type JourneyRuntimeCapability,
} from './journey-authoring-canonical.js';
import { compileJourneyDraft, importJourneyDefinition } from './journey-authoring-compiler.js';
import {
  JourneyAuthoringError,
  assertJourneyLifecycleTransition,
  journeyAuthoringFlagsFromEnvironment,
  type JourneyAuthoringActor,
  type JourneyAuthoringAuthorizationPort,
  type JourneyAuthoringFeatureFlags,
} from './journey-authoring-model.js';
import { validateAuthoringDocument } from './journey-authoring-validator.js';
import {
  JourneyDefinitionValidationError,
  type JourneyDefinitionContent,
} from './journey-definition.js';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';

/**
 * J5.2 (#340): transaction ของ Journey authoring — head/draft/receipt/review/audit/outbox
 * (Phase Spec #337 §2, §5)
 *
 * ทุก mutation:
 * 1. receipt ตาม `Idempotency-Key`: key+hash เดิมคืนผลเดิม, key เดิม hash ต่าง → IDEMPOTENCY_CONFLICT
 * 2. rollout gate (env AND tenant row) และ authorization ปัจจุบันผ่าน port ใน transaction เดียวกัน
 * 3. whole-draft CAS ด้วย head version + draft revision/digest — stale ตอบ conflict ไม่มี auto-merge
 * 4. audit/outbox เก็บเฉพาะ metadata (id/version/digest/code) ไม่มี document/graph/parameter
 *
 * publish ทำทั้งหมดใน transaction เดียวโดยไม่เรียก network/Kafka — ถ้า commit ไม่รู้ผล client ใช้
 * key เดิม resolve ห้าม mint key ใหม่หรือ publish ซ้ำ
 */

type Tx = Prisma.TransactionClient;
type JsonObject = Record<string, Prisma.InputJsonValue | null>;

const SCHEMA_BLOCKING = new Set([
  'AUTHORING_SCHEMA_INVALID',
  'COMPILER_VERSION_UNSUPPORTED',
  'NODE_FIELD_UNKNOWN',
]);
const REFERENCE_CODES = new Set([
  'OWNER_TEAM_UNTRUSTED',
  'TARGET_TEAM_UNTRUSTED',
  'SEGMENT_REFERENCE_UNTRUSTED',
]);

export type JourneyAuthoringCheckpoint = 'DEFINITION_PUBLISHED' | 'HEAD_ACTIVATED';

export interface JourneyAuthoringRepositoryOptions {
  readonly authorization: JourneyAuthoringAuthorizationPort;
  readonly evaluator: ExpressionEvaluator;
  readonly capabilities?: readonly JourneyRuntimeCapability[];
  readonly flags?: JourneyAuthoringFeatureFlags;
  readonly id?: () => string;
  readonly now?: () => Date;
  /** fault injection สำหรับพิสูจน์ว่า crash ทุก boundary ไม่ทิ้ง state ครึ่งเดียว */
  readonly checkpoint?: (name: JourneyAuthoringCheckpoint) => void | Promise<void>;
}

export interface JourneyCommandContext {
  readonly tenantId: string;
  readonly actor: JourneyAuthoringActor;
  readonly idempotencyKey: string;
}

export interface JourneyDraftCas {
  readonly expectedHeadVersion: number;
  readonly expectedDraftRevision: number;
  readonly expectedDraftDigest: string;
}

export interface JourneyDraftResult {
  readonly journeyId: string;
  readonly headVersion: number;
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly diagnostics: readonly JourneyDiagnosticV1[];
}

export class JourneyAuthoringRepository {
  private readonly definitions: JourneyDefinitionRepository;
  private readonly capabilities: readonly JourneyRuntimeCapability[];
  private readonly flags: JourneyAuthoringFeatureFlags;
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly options: JourneyAuthoringRepositoryOptions,
  ) {
    this.definitions = new JourneyDefinitionRepository(database, options.evaluator);
    this.capabilities = options.capabilities ?? JOURNEY_RUNTIME_CAPABILITIES;
    this.flags = options.flags ?? journeyAuthoringFlagsFromEnvironment();
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  // ── Commands ────────────────────────────────────────────────────────────

  async createJourneyDraft(
    context: JourneyCommandContext,
    input: { readonly ownerTeamId: string; readonly document: unknown },
  ): Promise<JourneyDraftResult> {
    const journeyId = this.id();
    return this.command(context, 'CreateJourneyDraft', journeyId, input, async (tx) => {
      await this.assertWriteEnabled(tx, context.tenantId, 'canvasWrite');
      await this.authorize(tx, context, 'journey.edit', {
        kind: 'TEAM',
        teamId: input.ownerTeamId,
      });
      const diagnostics = this.assertSavable(input.document);
      await this.lockJourney(tx, context.tenantId, journeyId);
      const draft = await this.insertDraft(tx, context, journeyId, 1, null, input.document);
      const document = input.document as AuthoringDocumentV1;
      await tx.jrJourneyHead.create({
        data: {
          id: this.id(),
          tenantId: context.tenantId,
          journeyId,
          name: document.settings.name,
          ownerTeamId: input.ownerTeamId,
          currentDraftId: draft.id,
          currentDraftRevision: 1,
          currentDraftDigest: draft.contentDigest,
        },
      });
      await this.record(
        tx,
        context,
        journeyId,
        1,
        'DRAFT_CREATED',
        'USER_EDIT',
        null,
        draft.contentDigest,
      );
      return {
        journeyId,
        headVersion: 1,
        draftRevision: 1,
        draftDigest: draft.contentDigest,
        diagnostics,
      };
    });
  }

  async updateJourneyDraft(
    context: JourneyCommandContext,
    input: JourneyDraftCas & { readonly journeyId: string; readonly document: unknown },
  ): Promise<JourneyDraftResult> {
    return this.command(context, 'UpdateJourneyDraft', input.journeyId, input, async (tx) => {
      await this.assertWriteEnabled(tx, context.tenantId, 'canvasWrite');
      const head = await this.lockedHead(tx, context.tenantId, input.journeyId);
      await this.authorize(tx, context, 'journey.edit', { kind: 'TEAM', teamId: head.ownerTeamId });
      this.assertEditable(head);
      this.assertCas(head, input);
      const diagnostics = this.assertSavable(input.document);
      return this.appendDraft(
        tx,
        context,
        head,
        input.document,
        null,
        'DRAFT_UPDATED',
        'USER_EDIT',
        diagnostics,
      );
    });
  }

  /** ทิ้ง draft กลับไปเป็น version ที่ active อยู่ — ต้องเคย publish แล้ว และเกิดเป็น revision ใหม่ */
  async discardJourneyDraft(
    context: JourneyCommandContext,
    input: JourneyDraftCas & { readonly journeyId: string; readonly reasonCode: string },
  ): Promise<JourneyDraftResult> {
    return this.command(context, 'DiscardJourneyDraft', input.journeyId, input, async (tx) => {
      await this.assertWriteEnabled(tx, context.tenantId, 'canvasWrite');
      const head = await this.lockedHead(tx, context.tenantId, input.journeyId);
      await this.authorize(tx, context, 'journey.edit', { kind: 'TEAM', teamId: head.ownerTeamId });
      this.assertEditable(head);
      this.assertCas(head, input);
      if (head.activeVersion === null) {
        throw new JourneyAuthoringError('JOURNEY_LIFECYCLE_CONFLICT', {
          reason: 'NOTHING_TO_DISCARD_TO',
        });
      }
      const active = await this.publishedContent(
        tx,
        context.tenantId,
        head.journeyId,
        head.activeVersion,
      );
      return this.appendDraft(
        tx,
        context,
        head,
        importJourneyDefinition(active),
        head.activeVersion,
        'DRAFT_DISCARDED',
        input.reasonCode,
        [],
      );
    });
  }

  /** เปิด draft ใหม่จาก version ที่เคย publish — rollback คือ roll-forward ไม่ใช่สลับกลับ (#327) */
  async createRollForwardFromVersion(
    context: JourneyCommandContext,
    input: {
      readonly journeyId: string;
      readonly sourceVersion: number;
      readonly expectedHeadVersion: number;
    },
  ): Promise<JourneyDraftResult> {
    return this.command(
      context,
      'CreateRollForwardFromVersion',
      input.journeyId,
      input,
      async (tx) => {
        await this.assertWriteEnabled(tx, context.tenantId, 'canvasWrite');
        const head = await this.lockedHead(tx, context.tenantId, input.journeyId);
        await this.authorize(tx, context, 'journey.edit', {
          kind: 'TEAM',
          teamId: head.ownerTeamId,
        });
        this.assertEditable(head);
        if (head.version !== input.expectedHeadVersion) {
          throw new JourneyAuthoringError('PUBLISHED_HEAD_CONFLICT', {
            currentHeadVersion: head.version,
          });
        }
        const source = await this.publishedContent(
          tx,
          context.tenantId,
          head.journeyId,
          input.sourceVersion,
        );
        return this.appendDraft(
          tx,
          context,
          head,
          importJourneyDefinition(source),
          head.activeVersion,
          'ROLL_FORWARD_CREATED',
          'ROLL_FORWARD',
          [],
        );
      },
    );
  }

  /** clone สร้าง journeyId ใหม่แบบ detached — ไม่มี enrollment หรือ runtime state ติดไป */
  async cloneJourneyFromVersion(
    context: JourneyCommandContext,
    input: {
      readonly journeyId: string;
      readonly version: number;
      readonly targetOwnerTeamId: string;
      readonly name: string;
    },
  ): Promise<JourneyDraftResult> {
    const cloneId = this.id();
    return this.command(context, 'CloneJourneyFromVersion', cloneId, input, async (tx) => {
      await this.assertWriteEnabled(tx, context.tenantId, 'canvasWrite');
      const source = await this.head(tx, context.tenantId, input.journeyId);
      await this.authorize(tx, context, 'journey.read', {
        kind: 'TEAM',
        teamId: source.ownerTeamId,
      });
      await this.authorize(tx, context, 'journey.edit', {
        kind: 'TEAM',
        teamId: input.targetOwnerTeamId,
      });
      const content = await this.publishedContent(
        tx,
        context.tenantId,
        input.journeyId,
        input.version,
      );
      const imported = importJourneyDefinition(content);
      const document = { ...imported, settings: { ...imported.settings, name: input.name } };
      await this.lockJourney(tx, context.tenantId, cloneId);
      const draft = await this.insertDraft(tx, context, cloneId, 1, null, document);
      await tx.jrJourneyHead.create({
        data: {
          id: this.id(),
          tenantId: context.tenantId,
          journeyId: cloneId,
          name: input.name,
          ownerTeamId: input.targetOwnerTeamId,
          currentDraftId: draft.id,
          currentDraftRevision: 1,
          currentDraftDigest: draft.contentDigest,
        },
      });
      await this.record(
        tx,
        context,
        cloneId,
        1,
        'JOURNEY_CLONED',
        'CLONE',
        null,
        draft.contentDigest,
      );
      return {
        journeyId: cloneId,
        headVersion: 1,
        draftRevision: 1,
        draftDigest: draft.contentDigest,
        diagnostics: [],
      };
    });
  }

  async changeJourneyLifecycle(
    context: JourneyCommandContext,
    input: {
      readonly journeyId: string;
      readonly target: Exclude<JourneyLifecycle, 'DRAFT_ONLY'>;
      readonly expectedHeadVersion: number;
      readonly reasonCode: string;
    },
  ): Promise<{
    readonly journeyId: string;
    readonly headVersion: number;
    readonly lifecycle: JourneyLifecycle;
  }> {
    const commandName =
      input.target === 'PAUSED'
        ? 'PauseJourney'
        : input.target === 'ACTIVE'
          ? 'ResumeJourney'
          : 'DeprecateJourney';
    return this.command(context, commandName, input.journeyId, input, async (tx) => {
      const head = await this.lockedHead(tx, context.tenantId, input.journeyId);
      await this.authorize(tx, context, 'journey.lifecycle', {
        kind: 'TEAM',
        teamId: head.ownerTeamId,
      });
      if (head.version !== input.expectedHeadVersion) {
        throw new JourneyAuthoringError('PUBLISHED_HEAD_CONFLICT', {
          currentHeadVersion: head.version,
        });
      }
      assertJourneyLifecycleTransition(head.lifecycle, input.target);
      const headVersion = await this.casHead(tx, head, { lifecycle: input.target });
      const action =
        input.target === 'PAUSED'
          ? 'JOURNEY_PAUSED'
          : input.target === 'ACTIVE'
            ? 'JOURNEY_RESUMED'
            : 'JOURNEY_DEPRECATED';
      await this.record(
        tx,
        context,
        head.journeyId,
        headVersion,
        action,
        input.reasonCode,
        head.currentDraftDigest,
        head.currentDraftDigest,
      );
      return { journeyId: head.journeyId, headVersion, lifecycle: input.target };
    });
  }

  /**
   * publish แบบ atomic: authorization/review/draft/head/capability ถูกอ่านซ้ำและ recompile ต้องได้
   * digest เดิม แล้ว commit definition + head + review + receipt + audit + outbox พร้อมกัน
   */
  async publishJourneyDraft(
    context: JourneyCommandContext,
    input: PublishJourneyDraftRequestV1 & { readonly journeyId: string },
  ): Promise<PublishJourneyResultV1> {
    return this.command(
      context,
      'PublishJourneyDraft',
      input.journeyId,
      input,
      async (tx, receiptId) => {
        await this.assertWriteEnabled(tx, context.tenantId, 'publishUi');
        const head = await this.lockedHead(tx, context.tenantId, input.journeyId);
        await this.authorize(tx, context, 'journey.publish', {
          kind: 'TEAM',
          teamId: head.ownerTeamId,
        });
        this.assertEditable(head);
        if (head.version !== input.expectedHeadVersion) {
          throw new JourneyAuthoringError('PUBLISHED_HEAD_CONFLICT', {
            currentHeadVersion: head.version,
          });
        }
        if (
          head.currentDraftRevision !== input.draftRevision ||
          head.currentDraftDigest !== input.draftDigest
        ) {
          throw new JourneyAuthoringError('DRAFT_VERSION_CONFLICT', {
            currentDraftRevision: head.currentDraftRevision,
            currentDraftDigest: head.currentDraftDigest,
          });
        }

        const candidate = await tx.jrReviewCandidate.findFirst({
          where: {
            tenantId: context.tenantId,
            id: input.reviewId,
            resourceKind: 'JOURNEY',
            resourceId: head.journeyId,
          },
        });
        if (!candidate || candidate.state !== 'APPROVED') {
          throw new JourneyAuthoringError('APPROVAL_REQUIRED');
        }
        const pinned = [
          candidate.draftRevision === input.draftRevision,
          candidate.draftDigest === input.draftDigest,
          candidate.compileDigest === input.compileDigest,
          candidate.referenceDigest === input.referenceDigest,
          candidate.capabilityDigest === input.capabilityDigest,
          candidate.baseHeadVersion === input.baseHeadVersion,
          candidate.baseHeadDigest === input.baseHeadDigest,
          input.baseHeadVersion === head.version,
        ];
        if (pinned.some((matches) => !matches))
          throw new JourneyAuthoringError('REVIEW_CANDIDATE_STALE');

        // recompile จาก draft ใน DB ด้วย capability ปัจจุบัน — client ส่งได้แค่ digest ไม่ใช่ runtime definition
        const draft = await tx.jrJourneyDraft.findFirstOrThrow({
          where: {
            tenantId: context.tenantId,
            journeyId: head.journeyId,
            revision: head.currentDraftRevision,
          },
        });
        const compiled = this.compile(
          context.tenantId,
          head,
          draft.document,
          draft.revision,
          draft.contentDigest,
        );
        if (!compiled.artifact) {
          throw new JourneyAuthoringError('DEFINITION_INVALID', undefined, compiled.diagnostics);
        }
        const artifact = compiled.artifact;
        if (
          artifact.capabilityDigest !== input.capabilityDigest ||
          artifact.referenceDigest !== input.referenceDigest
        ) {
          throw new JourneyAuthoringError('COMPILE_ARTIFACT_STALE');
        }
        if (artifact.compileDigest !== input.compileDigest) {
          throw new JourneyAuthoringError('COMPILE_DIGEST_MISMATCH');
        }

        const latest = await tx.jrJourneyDefinition.findFirst({
          where: { tenantId: context.tenantId, journeyId: head.journeyId },
          orderBy: { version: 'desc' },
          select: { version: true },
        });
        const version = (latest?.version ?? 0) + 1;
        try {
          const created = await this.definitions.createVersionInTransaction(tx, {
            ...artifact.runtimeDefinition,
            tenantId: context.tenantId,
            journeyId: head.journeyId,
            version,
            correlationId: context.actor.correlationId,
          });
          await this.definitions.publishVersionInTransaction(tx, {
            tenantId: context.tenantId,
            journeyId: head.journeyId,
            version,
            expectedContentHash: created.contentHash,
            correlationId: context.actor.correlationId,
          });
        } catch (error) {
          if (error instanceof JourneyDefinitionValidationError) {
            throw new JourneyAuthoringError(
              error.reasonCodes.some((code) => REFERENCE_CODES.has(code))
                ? 'REFERENCE_UNTRUSTED'
                : 'DEFINITION_INVALID',
              undefined,
              error.reasonCodes.map((code) => ({
                code: REFERENCE_CODES.has(code) ? 'REFERENCE_UNTRUSTED' : 'DEFINITION_INVALID',
                severity: 'ERROR',
                stage: 'PUBLISH',
                messageKey: `journey.authoring.${code}`,
                legacyReasonCode: code,
              })),
            );
          }
          throw error;
        }
        await this.options.checkpoint?.('DEFINITION_PUBLISHED');

        const definition = await tx.jrJourneyDefinition.findUniqueOrThrow({
          where: {
            tenantId_journeyId_version: {
              tenantId: context.tenantId,
              journeyId: head.journeyId,
              version,
            },
          },
          select: { id: true },
        });
        // publish ขณะ PAUSED ไม่ resume เอง (Phase Contract §5)
        const headVersion = await this.casHead(tx, head, {
          lifecycle: head.lifecycle === 'DRAFT_ONLY' ? 'ACTIVE' : head.lifecycle,
          activeDefinitionId: definition.id,
          activeVersion: version,
          activeRuntimeHash: artifact.runtimeHash,
        });
        await this.options.checkpoint?.('HEAD_ACTIVATED');
        await tx.jrReviewCandidate.update({
          where: { id: candidate.id },
          data: { state: 'SUPERSEDED' },
        });
        await this.record(
          tx,
          context,
          head.journeyId,
          headVersion,
          'JOURNEY_PUBLISHED',
          'PUBLISH',
          head.currentDraftDigest,
          artifact.runtimeHash,
        );
        return {
          outcome: 'PUBLISHED',
          journeyId: head.journeyId,
          version,
          runtimeHash: artifact.runtimeHash,
          receiptId,
        };
      },
    );
  }

  /** publish ที่ไม่รู้ผล: อ่าน receipt ของ key เดิมเท่านั้น ไม่ publish ซ้ำ */
  async resolvePublish(
    tenantId: string,
    input: { readonly journeyId: string; readonly originalIdempotencyKey: string },
  ): Promise<PublishJourneyResultV1 & { readonly errorCode?: string }> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const receipt = await tx.jrAuthoringCommandReceipt.findUnique({
        where: {
          tenantId_idempotencyKey: { tenantId, idempotencyKey: input.originalIdempotencyKey },
        },
      });
      if (
        receipt &&
        (receipt.commandName !== 'PublishJourneyDraft' || receipt.resourceId !== input.journeyId)
      ) {
        throw new JourneyAuthoringError('JOURNEY_NOT_FOUND');
      }
      if (!receipt) {
        // ไม่มี receipt = transaction ไม่เคย commit จึง retry ด้วย key เดิมได้อย่างปลอดภัย
        return {
          outcome: 'NOT_COMMITTED',
          journeyId: input.journeyId,
          version: null,
          runtimeHash: null,
          receiptId: '',
        };
      }
      if (receipt.state === 'COMMITTED')
        return receipt.response as unknown as PublishJourneyResultV1;
      return {
        outcome: receipt.httpStatus === 409 ? 'CONFLICT' : 'NOT_COMMITTED',
        journeyId: input.journeyId,
        version: null,
        runtimeHash: null,
        receiptId: receipt.id,
        errorCode: receipt.errorCode ?? undefined,
      };
    });
  }

  // ── Queries ─────────────────────────────────────────────────────────────

  async compileJourneyDraft(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: {
      readonly journeyId: string;
      readonly draftRevision: number;
      readonly draftDigest: string;
    },
  ): Promise<CompileJourneyResultV1<JourneyDefinitionContent>> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const head = await this.head(tx, tenantId, input.journeyId);
      await this.authorize(tx, { tenantId, actor }, 'journey.read', {
        kind: 'TEAM',
        teamId: head.ownerTeamId,
      });
      const draft = await tx.jrJourneyDraft.findFirst({
        where: { tenantId, journeyId: head.journeyId, revision: input.draftRevision },
      });
      if (!draft || draft.contentDigest !== input.draftDigest) {
        throw new JourneyAuthoringError('DRAFT_VERSION_CONFLICT', {
          currentDraftRevision: head.currentDraftRevision,
          currentDraftDigest: head.currentDraftDigest,
        });
      }
      const result = this.compile(
        tenantId,
        head,
        draft.document,
        draft.revision,
        draft.contentDigest,
      );
      // compile ของ revision เก่าที่ draft ขยับไปแล้ว ยังคืนผลได้แต่ห้ามนำไป publish (#329 §5)
      return { ...result, stale: draft.revision !== head.currentDraftRevision };
    });
  }

  async getJourneyAuthoringState(
    tenantId: string,
    actor: JourneyAuthoringActor,
    journeyId: string,
  ): Promise<JourneyAuthoringStateV1> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const head = await this.head(tx, tenantId, journeyId);
      await this.authorize(tx, { tenantId, actor }, 'journey.read', {
        kind: 'TEAM',
        teamId: head.ownerTeamId,
      });
      const draft = await tx.jrJourneyDraft.findFirstOrThrow({
        where: { tenantId, journeyId, revision: head.currentDraftRevision },
      });
      const review = await tx.jrReviewCandidate.findFirst({
        where: {
          tenantId,
          resourceKind: 'JOURNEY',
          resourceId: journeyId,
          state: { in: ['IN_REVIEW', 'APPROVED'] },
        },
        orderBy: { createdAt: 'desc' },
      });
      return {
        head: {
          journeyId,
          name: head.name,
          ownerTeamId: head.ownerTeamId,
          lifecycle: head.lifecycle,
          version: head.version,
          currentDraftRevision: head.currentDraftRevision,
          currentDraftDigest: head.currentDraftDigest,
          activeVersion: head.activeVersion,
          activeRuntimeHash: head.activeRuntimeHash,
        },
        draft: {
          revision: draft.revision,
          digest: draft.contentDigest,
          basePublishedVersion: draft.basePublishedVersion,
          document: draft.document as unknown as AuthoringDocumentV1,
        },
        review: review
          ? { reviewId: review.id, state: review.state, draftRevision: review.draftRevision }
          : null,
      };
    });
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private compile(
    tenantId: string,
    head: JrJourneyHead,
    document: Prisma.JsonValue,
    draftRevision: number,
    draftDigest: string,
  ) {
    return compileJourneyDraft(
      document,
      {
        tenantId,
        journeyId: head.journeyId,
        ownerTeamId: head.ownerTeamId,
        draftRevision,
        draftDigest,
        baseHeadVersion: head.version,
      },
      { evaluator: this.options.evaluator, capabilities: this.capabilities },
    );
  }

  /**
   * idempotency receipt: ผลสำเร็จ commit พร้อม mutation; ผลล้มแบบ deterministic ถูกจำใน transaction แยก
   * เพื่อให้ key เดิมได้คำตอบเดิม — ไม่มี receipt แปลว่าไม่เคย commit
   */
  private async command<T extends object>(
    context: JourneyCommandContext,
    commandName: string,
    resourceId: string,
    request: object,
    body: (tx: Tx, receiptId: string) => Promise<T>,
  ): Promise<T> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(context.idempotencyKey)) {
      throw new JourneyAuthoringError('REQUEST_MALFORMED', { field: 'Idempotency-Key' });
    }
    const requestHash = journeyAuthoringDigest({ commandName, request });
    const receiptId = this.id();
    try {
      return await withTenantDatabaseTransaction(this.database, context.tenantId, async (tx) => {
        await tx.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`jr-authoring-key:${context.tenantId}:${context.idempotencyKey}`}))`,
        );
        const existing = await tx.jrAuthoringCommandReceipt.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: context.tenantId,
              idempotencyKey: context.idempotencyKey,
            },
          },
        });
        if (existing) return this.replay<T>(existing, requestHash);
        const response = await body(tx, receiptId);
        await tx.jrAuthoringCommandReceipt.create({
          data: {
            id: receiptId,
            tenantId: context.tenantId,
            idempotencyKey: context.idempotencyKey,
            commandName,
            resourceKind: 'JOURNEY',
            resourceId,
            requestHash,
            state: 'COMMITTED',
            httpStatus: 200,
            response: response as unknown as Prisma.InputJsonValue,
            correlationId: context.actor.correlationId,
            completedAt: this.now(),
          },
        });
        return response;
      });
    } catch (error) {
      if (error instanceof JourneyAuthoringError && error.storedInReceipt) {
        await this.rememberFailure(context, commandName, resourceId, requestHash, receiptId, error);
      }
      throw error;
    }
  }

  private replay<T>(
    receipt: {
      requestHash: string;
      state: string;
      response: Prisma.JsonValue;
      errorCode: string | null;
    },
    requestHash: string,
  ): T {
    if (receipt.requestHash !== requestHash)
      throw new JourneyAuthoringError('IDEMPOTENCY_CONFLICT');
    if (receipt.state === 'COMMITTED') return receipt.response as unknown as T;
    throw new JourneyAuthoringError(
      (receipt.errorCode ?? 'IDEMPOTENCY_CONFLICT') as JourneyAuthoringError['code'],
    );
  }

  private async rememberFailure(
    context: JourneyCommandContext,
    commandName: string,
    resourceId: string,
    requestHash: string,
    receiptId: string,
    error: JourneyAuthoringError,
  ) {
    await withTenantDatabaseTransaction(this.database, context.tenantId, async (tx) => {
      await tx.jrAuthoringCommandReceipt.createMany({
        data: [
          {
            id: receiptId,
            tenantId: context.tenantId,
            idempotencyKey: context.idempotencyKey,
            commandName,
            resourceKind: 'JOURNEY',
            resourceId,
            requestHash,
            state: 'FAILED',
            httpStatus: error.httpStatus,
            errorCode: error.code,
            correlationId: context.actor.correlationId,
            completedAt: this.now(),
          },
        ],
        // request คู่ขนานที่ key เดียวกันอาจบันทึกไปก่อน — ผลเดิมชนะ
        skipDuplicates: true,
      });
    });
  }

  private async assertWriteEnabled(
    tx: Tx,
    tenantId: string,
    feature: keyof JourneyAuthoringFeatureFlags,
  ) {
    const rollout = await tx.jrAuthoringRolloutState.findUnique({ where: { tenantId } });
    const tenantEnabled =
      feature === 'canvasWrite' ? rollout?.canvasWriteEnabled : rollout?.publishUiEnabled;
    if (
      !this.flags[feature] ||
      !rollout ||
      rollout.stage === 'DISABLED' ||
      rollout.mutationFrozen ||
      !tenantEnabled
    ) {
      throw new JourneyAuthoringError('DEPENDENCY_UNAVAILABLE', { reason: 'ROLLOUT_DISABLED' });
    }
  }

  private async authorize(
    tx: Tx,
    context: Pick<JourneyCommandContext, 'tenantId' | 'actor'>,
    capability: JourneyAuthoringCapability,
    scope: { kind: 'TEAM'; teamId: string },
  ) {
    const decision = await this.options.authorization.authorize(tx, {
      tenantId: context.tenantId,
      subjectId: context.actor.subjectId,
      capability,
      scope,
    });
    if (!decision.allowed) throw new JourneyAuthoringError(decision.code, { capability });
  }

  /** schema พังบันทึกไม่ได้; graph ที่ยังไม่สมบูรณ์บันทึกได้และคืน diagnostics ให้แก้ต่อ */
  private assertSavable(document: unknown): JourneyDiagnosticV1[] {
    const diagnostics = validateAuthoringDocument(document, { capabilities: this.capabilities });
    const blocking = diagnostics.filter(
      (item) => item.severity === 'ERROR' && SCHEMA_BLOCKING.has(item.code),
    );
    if (blocking.length > 0)
      throw new JourneyAuthoringError('AUTHORING_SCHEMA_INVALID', undefined, blocking);
    return diagnostics;
  }

  private assertEditable(head: JrJourneyHead) {
    if (head.lifecycle === 'DEPRECATED') {
      throw new JourneyAuthoringError('JOURNEY_LIFECYCLE_CONFLICT', { lifecycle: head.lifecycle });
    }
  }

  private assertCas(head: JrJourneyHead, cas: JourneyDraftCas) {
    if (head.version !== cas.expectedHeadVersion) {
      throw new JourneyAuthoringError('PUBLISHED_HEAD_CONFLICT', {
        currentHeadVersion: head.version,
      });
    }
    if (
      head.currentDraftRevision !== cas.expectedDraftRevision ||
      head.currentDraftDigest !== cas.expectedDraftDigest
    ) {
      throw new JourneyAuthoringError('DRAFT_VERSION_CONFLICT', {
        currentDraftRevision: head.currentDraftRevision,
        currentDraftDigest: head.currentDraftDigest,
      });
    }
  }

  private async lockJourney(tx: Tx, tenantId: string, journeyId: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`jr-journey-authoring:${tenantId}:${journeyId}`}))`,
    );
  }

  /** missing/foreign/hidden ตอบ not-found แบบเดียวกัน — RLS ทำให้ของ tenant อื่นมองไม่เห็นอยู่แล้ว */
  private async head(tx: Tx, tenantId: string, journeyId: string): Promise<JrJourneyHead> {
    const head = /^[0-9a-f-]{36}$/i.test(journeyId)
      ? await tx.jrJourneyHead.findUnique({
          where: { tenantId_journeyId: { tenantId, journeyId } },
        })
      : null;
    if (!head) throw new JourneyAuthoringError('JOURNEY_NOT_FOUND');
    return head;
  }

  private async lockedHead(tx: Tx, tenantId: string, journeyId: string) {
    const head = await this.head(tx, tenantId, journeyId);
    await this.lockJourney(tx, tenantId, journeyId);
    // อ่านซ้ำหลังได้ lock เพื่อให้ CAS เทียบกับค่าที่ commit ล่าสุด
    return this.head(tx, tenantId, journeyId);
  }

  private async publishedContent(tx: Tx, tenantId: string, journeyId: string, version: number) {
    const row = await tx.jrJourneyDefinition.findUnique({
      where: { tenantId_journeyId_version: { tenantId, journeyId, version } },
    });
    if (!row || row.status !== 'PUBLISHED') throw new JourneyAuthoringError('VERSION_NOT_FOUND');
    return {
      name: row.name,
      ownerTeamId: row.ownerTeamId,
      purpose: row.purpose,
      senderIdentityId: row.senderIdentityId,
      trigger: row.trigger,
      graph: row.graph,
      goal: row.goal,
      exitRules: row.exitRules,
      maxDurationDays: row.maxDurationDays,
    } as unknown as JourneyDefinitionContent;
  }

  private async insertDraft(
    tx: Tx,
    context: JourneyCommandContext,
    journeyId: string,
    revision: number,
    basePublishedVersion: number | null,
    document: unknown,
  ) {
    return tx.jrJourneyDraft.create({
      data: {
        id: this.id(),
        tenantId: context.tenantId,
        journeyId,
        revision,
        basePublishedVersion,
        schemaVersion: JOURNEY_AUTHORING_SCHEMA_VERSION,
        registryVersion: JOURNEY_AUTHORING_REGISTRY_VERSION,
        document: document as Prisma.InputJsonValue,
        contentDigest: journeyAuthoringDigest(document),
        createdByRef: context.actor.subjectId,
      },
    });
  }

  private async appendDraft(
    tx: Tx,
    context: JourneyCommandContext,
    head: JrJourneyHead,
    document: unknown,
    basePublishedVersion: number | null,
    action: string,
    reasonCode: string,
    diagnostics: readonly JourneyDiagnosticV1[],
  ): Promise<JourneyDraftResult> {
    const revision = head.currentDraftRevision + 1;
    const draft = await this.insertDraft(
      tx,
      context,
      head.journeyId,
      revision,
      basePublishedVersion ?? head.activeVersion,
      document,
    );
    const headVersion = await this.casHead(tx, head, {
      currentDraftId: draft.id,
      currentDraftRevision: revision,
      currentDraftDigest: draft.contentDigest,
      name: (document as AuthoringDocumentV1).settings.name,
    });
    await this.record(
      tx,
      context,
      head.journeyId,
      headVersion,
      action,
      reasonCode,
      head.currentDraftDigest,
      draft.contentDigest,
    );
    return {
      journeyId: head.journeyId,
      headVersion,
      draftRevision: revision,
      draftDigest: draft.contentDigest,
      diagnostics,
    };
  }

  /** CAS บน head: version ต้องเท่าเดิมตอนเขียน และ trigger บังคับ +1 อีกชั้น */
  private async casHead(
    tx: Tx,
    head: JrJourneyHead,
    data: Prisma.JrJourneyHeadUpdateManyMutationInput,
  ) {
    const headVersion = head.version + 1;
    const updated = await tx.jrJourneyHead.updateMany({
      where: { tenantId: head.tenantId, journeyId: head.journeyId, version: head.version },
      data: { ...data, version: headVersion },
    });
    if (updated.count !== 1) {
      throw new JourneyAuthoringError('PUBLISHED_HEAD_CONFLICT', {
        currentHeadVersion: head.version,
      });
    }
    return headVersion;
  }

  /** audit + outbox ใน transaction เดียวกับ mutation — metadata เท่านั้น */
  private async record(
    tx: Tx,
    context: JourneyCommandContext,
    journeyId: string,
    headVersion: number,
    action: string,
    reasonCode: string,
    beforeDigest: string | null,
    afterDigest: string | null,
  ) {
    const occurredAt = this.now();
    await tx.jrAuthoringAudit.create({
      data: {
        id: this.id(),
        tenantId: context.tenantId,
        resourceKind: 'JOURNEY',
        resourceId: journeyId,
        action,
        actorSubjectId: context.actor.subjectId,
        reasonCode,
        beforeDigest,
        afterDigest,
        correlationId: context.actor.correlationId,
        occurredAt,
      },
    });
    const payload: JsonObject = {
      resourceKind: 'JOURNEY',
      resourceId: journeyId,
      aggregateVersion: headVersion,
      action,
      digest: afterDigest,
      reasonCode,
      correlationId: context.actor.correlationId,
    };
    await tx.jrAuthoringOutbox.create({
      data: {
        id: this.id(),
        tenantId: context.tenantId,
        eventId: `journey-authoring:${journeyId}:${headVersion}`,
        resourceKind: 'JOURNEY',
        resourceId: journeyId,
        aggregateVersion: headVersion,
        eventType: 'journey.authoring.changed',
        payload,
        payloadHash: journeyAuthoringDigest(payload),
        correlationId: context.actor.correlationId,
      },
    });
  }
}
