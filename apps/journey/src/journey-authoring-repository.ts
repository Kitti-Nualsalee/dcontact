import { randomUUID } from 'node:crypto';
import {
  Prisma,
  withTenantDatabaseTransaction,
  lockTeamReferences,
  type JrJourneyHead,
  type PrismaClient,
} from '@d-contact/db';
import {
  JOURNEY_AUTHORING_REGISTRY_VERSION,
  JOURNEY_AUTHORING_SCHEMA_VERSION,
  JOURNEY_STRONG_AUTH_MAX_AGE_SECONDS,
  type JourneyAuthoringAuthorizationScope,
  type AuthoringDocumentV1,
  type CompileJourneyResultV1,
  type ExpressionEvaluator,
  type JourneyAuthoringCapability,
  type JourneyAuthoringStateV1,
  type JourneyPendingReviewV1,
  type JourneyDiagnosticV1,
  type JourneyLifecycle,
  type PublishJourneyDraftRequestV1,
  type ReviewDecisionRequestV1,
  type SubmitJourneyReviewRequestV1,
  type TransferJourneyOwnershipRequestV1,
  type JourneyReviewState,
  type PublishJourneyResultV1,
  type PlanPreviewV1,
  type SimulationFixtureV1,
  type SimulationResultV1,
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
import {
  previewJourneyPlan as planPreview,
  simulateJourneyScenario as runSimulation,
} from './journey-authoring-simulator.js';
import { validateAuthoringDocument } from './journey-authoring-validator.js';
import {
  JourneyDefinitionValidationError,
  type JourneyDefinitionContent,
} from './journey-definition.js';
import { JourneyDefinitionRepository } from './journey-definition-repository.js';

/**
 * J5.2 (#340): Journey authoring transaction — head/draft/receipt/review/audit/outbox
 * (Phase Spec #337 §2, §5)
 *
 * Every mutation:
 * 1. receipt by `Idempotency-Key`: same key+hash returns the same result, same key with a different hash → IDEMPOTENCY_CONFLICT
 * 2. rollout gate (env AND tenant row) and current authorization pass through a port in the same transaction
 * 3. whole-draft CAS with head version + draft revision/digest — stale answers conflict, no auto-merge
 * 4. audit/outbox keep metadata only (id/version/digest/code), no document/graph/parameter
 *
 * publish runs entirely in one transaction without calling the network/Kafka — if the commit outcome is unknown the client resolves with
 * the same key; it must not mint a new key or publish again
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

/** Number of rows scanned per round when list filters permissions per row */
const LIST_SCAN_BATCH = 200;

/** #1067: one enrollment of a journey as shown on the results page — ids and codes only */
export interface JourneyRunSummary {
  readonly enrollmentId: string;
  readonly journeyVersion: number;
  readonly state: string;
  readonly runState: string;
  readonly terminalReason: string | null;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly trigger: {
    readonly outcomeType: string;
    readonly outcomeCode: string | null;
    readonly interactionId: string | null;
  } | null;
  readonly actions: ReadonlyArray<{
    readonly stepId: string | null;
    readonly kind: string;
    readonly state: string;
    /** id of what the owner created or matched (a case for ENSURE_CASE); null until the owner answers */
    readonly ownerAggregateId: string | null;
    readonly acknowledgedAt: string | null;
  }>;
}

const RUN_CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function decodeRunCursor(value: string | undefined): { createdAt: Date; id: string } | undefined {
  if (value === undefined) return undefined;
  const match = RUN_CURSOR.exec(Buffer.from(value, 'base64url').toString('utf8'));
  if (!match) throw new JourneyAuthoringError('REQUEST_MALFORMED', { field: 'cursor' });
  return { createdAt: new Date(match[1]!), id: match[2]! };
}

export interface JourneyAuthoringSummary {
  readonly journeyId: string;
  readonly name: string;
  readonly ownerTeamId: string;
  readonly lifecycle: JourneyLifecycle;
  readonly version: number;
  readonly currentDraftRevision: number;
  readonly activeVersion: number | null;
  readonly updatedAt: string;
  /** U1.3 (#431): the Journey's still-open review (if any) — lets list find candidates waiting for review */
  readonly reviewState: 'IN_REVIEW' | 'APPROVED' | null;
}

export type JourneyAuthoringCheckpoint = 'DEFINITION_PUBLISHED' | 'HEAD_ACTIVATED';

export interface JourneyAuthoringRepositoryOptions {
  readonly authorization: JourneyAuthoringAuthorizationPort;
  readonly evaluator: ExpressionEvaluator;
  readonly capabilities?: readonly JourneyRuntimeCapability[];
  readonly flags?: JourneyAuthoringFeatureFlags;
  readonly id?: () => string;
  readonly now?: () => Date;
  /** fault injection to prove that a crash at every boundary leaves no half-written state */
  readonly checkpoint?: (name: JourneyAuthoringCheckpoint) => void | Promise<void>;
  /**
   * U1.1 (#429): an extra check before mutating an existing Journey (after taking the lock) — UAT uses it to close the Journeys of a run that
   * has ended; with no guard = exactly the original J5 behavior
   */
  readonly writeGuard?: JourneyAuthoringWriteGuard;
}

export interface JourneyAuthoringWriteGuard {
  assertJourneyWritable(
    tx: Prisma.TransactionClient,
    tenantId: string,
    journeyId: string,
  ): Promise<void>;
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
  protected readonly definitions: JourneyDefinitionRepository;
  protected readonly capabilities: readonly JourneyRuntimeCapability[];
  protected readonly flags: JourneyAuthoringFeatureFlags;
  protected readonly id: () => string;
  protected readonly now: () => Date;

  constructor(
    protected readonly database: PrismaClient,
    protected readonly options: JourneyAuthoringRepositoryOptions,
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
      await lockTeamReferences(tx, context.tenantId, [input.ownerTeamId]);
      await this.assertWriteEnabled(tx, context.tenantId, 'canvasWrite');
      await this.authorize(tx, context, 'journey.edit', { teamId: input.ownerTeamId });
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
      await this.authorize(tx, context, 'journey.edit', this.scopeOf(head));
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

  /** Discard the draft back to the active version — it must have been published, and it becomes a new revision */
  async discardJourneyDraft(
    context: JourneyCommandContext,
    input: JourneyDraftCas & { readonly journeyId: string; readonly reasonCode: string },
  ): Promise<JourneyDraftResult> {
    return this.command(context, 'DiscardJourneyDraft', input.journeyId, input, async (tx) => {
      await this.assertWriteEnabled(tx, context.tenantId, 'canvasWrite');
      const head = await this.lockedHead(tx, context.tenantId, input.journeyId);
      await this.authorize(tx, context, 'journey.edit', this.scopeOf(head));
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

  /** Open a new draft from a previously published version — rollback is roll-forward, not switching back (#327) */
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
        await this.authorize(tx, context, 'journey.edit', this.scopeOf(head));
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

  /** clone creates a new detached journeyId — no enrollment or runtime state is carried over */
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
      await lockTeamReferences(tx, context.tenantId, [input.targetOwnerTeamId]);
      await this.assertWriteEnabled(tx, context.tenantId, 'canvasWrite');
      const source = await this.head(tx, context.tenantId, input.journeyId);
      await this.authorize(tx, context, 'journey.read', this.scopeOf(source));
      await this.authorize(tx, context, 'journey.edit', { teamId: input.targetOwnerTeamId });
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
      // pause/deprecate work even when the team is inactive so work can be stopped; resume needs an active team
      await this.authorize(tx, context, 'journey.lifecycle', this.scopeOf(head), {
        requireDirect: true,
        allowInactiveTeam: input.target !== 'ACTIVE',
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
   * atomic publish: authorization/review/draft/head/capability are reread and the recompile must produce
   * the same digest, then definition + head + review + receipt + audit + outbox commit together
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
        await this.authorize(tx, context, 'journey.publish', this.scopeOf(head));
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

        await this.assertIndependentApproval(tx, context.tenantId, head, candidate.id);
        return this.publishCompiled(tx, context, head, input, receiptId, {
          candidateId: candidate.id,
          action: 'JOURNEY_PUBLISHED',
          reasonCode: 'PUBLISH',
        });
      },
    );
  }

  /**
   * The only exception to maker-checker (#331 §10): a direct `journey.publish` by someone with direct review
   * authority + still-fresh strong auth + a reason code; the audit is recorded separately as JOURNEY_PUBLISHED_UNILATERAL and it must still
   * pass recompile/reference/head CAS in full like a normal publish
   */
  async publishJourneyDraftUnilateral(
    context: JourneyCommandContext,
    input: Omit<PublishJourneyDraftRequestV1, 'reviewId' | 'baseHeadVersion' | 'baseHeadDigest'> & {
      readonly journeyId: string;
      readonly reasonCode: string;
    },
  ): Promise<PublishJourneyResultV1> {
    return this.command(
      context,
      'PublishJourneyDraftUnilateral',
      input.journeyId,
      input,
      async (tx, receiptId) => {
        await this.assertWriteEnabled(tx, context.tenantId, 'publishUi');
        const head = await this.lockedHead(tx, context.tenantId, input.journeyId);
        const decision = await this.authorize(tx, context, 'journey.publish', this.scopeOf(head), {
          requireDirect: true,
        });
        const authentication = context.actor.authentication;
        const fresh =
          authentication?.strength === 'STRONG' &&
          this.now().getTime() - new Date(authentication.authenticatedAt).getTime() <=
            JOURNEY_STRONG_AUTH_MAX_AGE_SECONDS * 1_000;
        if (
          !decision.directReviewAuthority ||
          decision.authenticationStrength !== 'STRONG' ||
          !fresh
        ) {
          throw new JourneyAuthoringError('STRONG_AUTH_REQUIRED');
        }
        if (!/^[A-Z][A-Z0-9_]*$/.test(input.reasonCode)) {
          throw new JourneyAuthoringError('REQUEST_MALFORMED', { field: 'reasonCode' });
        }
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
        // a pending candidate can no longer be used after a direct publish
        await this.supersedeOpenReviews(tx, context.tenantId, head.journeyId);
        return this.publishCompiled(tx, context, head, input, receiptId, {
          candidateId: null,
          action: 'JOURNEY_PUBLISHED_UNILATERAL',
          reasonCode: input.reasonCode,
        });
      },
    );
  }

  /** recompile → definition → head → review → audit/outbox in the caller's transaction */
  protected async publishCompiled(
    tx: Tx,
    context: JourneyCommandContext,
    head: JrJourneyHead,
    input: {
      readonly compileDigest: string;
      readonly referenceDigest: string;
      readonly capabilityDigest: string;
    },
    receiptId: string,
    publication: {
      readonly candidateId: string | null;
      readonly action: string;
      readonly reasonCode: string;
    },
  ): Promise<PublishJourneyResultV1> {
    const { candidateId, action, reasonCode } = publication;
    // recompile from the draft in the DB with the current capability — the client can only send a digest, not a runtime definition
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
    // publishing while PAUSED does not resume by itself (Phase Contract §5)
    const headVersion = await this.casHead(tx, head, {
      lifecycle: head.lifecycle === 'DRAFT_ONLY' ? 'ACTIVE' : head.lifecycle,
      activeDefinitionId: definition.id,
      activeVersion: version,
      activeRuntimeHash: artifact.runtimeHash,
    });
    await this.options.checkpoint?.('HEAD_ACTIVATED');
    if (candidateId) {
      // the approval was already used — it cannot be used to publish again
      await tx.jrReviewCandidate.update({
        where: { id: candidateId },
        data: { state: 'SUPERSEDED' },
      });
    }
    await this.record(
      tx,
      context,
      head.journeyId,
      headVersion,
      action,
      reasonCode,
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
  }

  // ── Review (maker-checker) and ownership ──────────────────────────────

  /**
   * an immutable candidate pins draft/compile/reference/capability/head and the maker's authorization
   * (#331 §9) — submitting a new candidate makes the still-open candidate of the same journey SUPERSEDED
   */
  async submitJourneyReview(
    context: JourneyCommandContext,
    input: SubmitJourneyReviewRequestV1 & { readonly journeyId: string },
  ): Promise<{ readonly reviewId: string; readonly state: 'IN_REVIEW' }> {
    return this.command(context, 'SubmitJourneyReview', input.journeyId, input, async (tx) => {
      const head = await this.lockedHead(tx, context.tenantId, input.journeyId);
      const decision = await this.authorize(tx, context, 'journey.edit', this.scopeOf(head));
      this.assertEditable(head);
      if (head.version !== input.baseHeadVersion) {
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
        artifact.compileDigest !== input.compileDigest ||
        artifact.referenceDigest !== input.referenceDigest ||
        artifact.capabilityDigest !== input.capabilityDigest
      ) {
        throw new JourneyAuthoringError('COMPILE_ARTIFACT_STALE');
      }
      await this.supersedeOpenReviews(tx, context.tenantId, head.journeyId);
      const reviewId = this.id();
      await tx.jrReviewCandidate.create({
        data: {
          id: reviewId,
          tenantId: context.tenantId,
          resourceKind: 'JOURNEY',
          resourceId: head.journeyId,
          draftRevision: head.currentDraftRevision,
          draftDigest: head.currentDraftDigest,
          compileDigest: artifact.compileDigest,
          runtimeHash: artifact.runtimeHash,
          baseHeadVersion: head.version,
          baseHeadDigest: input.baseHeadDigest,
          referenceDigest: artifact.referenceDigest,
          capabilityDigest: artifact.capabilityDigest,
          makerSubjectId: context.actor.subjectId,
          makerAuthorizationEpoch: decision.authorizationEpoch,
          makerScopeVersion: decision.scopeVersion,
          state: 'IN_REVIEW',
        },
      });
      await this.record(
        tx,
        context,
        head.journeyId,
        head.version,
        'REVIEW_SUBMITTED',
        'SUBMIT',
        head.currentDraftDigest,
        artifact.compileDigest,
      );
      return { reviewId, state: 'IN_REVIEW' as const };
    });
  }

  /**
   * The decider must be a human with direct `journey.review` in the exact scope, not the maker and not a delegation
   * (#331 §10) — the vote stores the epoch/scope version to revalidate again at publish
   */
  async decideJourneyReview(
    context: JourneyCommandContext,
    input: ReviewDecisionRequestV1 & { readonly journeyId: string; readonly reviewId: string },
  ): Promise<{ readonly reviewId: string; readonly state: JourneyReviewState }> {
    return this.command(context, 'DecideJourneyReview', input.journeyId, input, async (tx) => {
      const head = await this.lockedHead(tx, context.tenantId, input.journeyId);
      const decision = await this.authorize(tx, context, 'journey.review', this.scopeOf(head), {
        requireDirect: true,
      });
      if (!/^[A-Z][A-Z0-9_]*$/.test(input.reasonCode)) {
        throw new JourneyAuthoringError('REQUEST_MALFORMED', { field: 'reasonCode' });
      }
      const candidate = await tx.jrReviewCandidate.findFirst({
        where: {
          tenantId: context.tenantId,
          id: input.reviewId,
          resourceKind: 'JOURNEY',
          resourceId: head.journeyId,
        },
      });
      if (!candidate) throw new JourneyAuthoringError('JOURNEY_NOT_FOUND');
      if (candidate.state !== input.expectedReviewState) {
        throw new JourneyAuthoringError('REVIEW_CANDIDATE_STALE', { state: candidate.state });
      }
      if (candidate.makerSubjectId === context.actor.subjectId) {
        throw new JourneyAuthoringError('APPROVAL_SELF_FORBIDDEN');
      }
      if (
        candidate.draftRevision !== head.currentDraftRevision ||
        candidate.draftDigest !== head.currentDraftDigest ||
        candidate.baseHeadVersion !== head.version
      ) {
        throw new JourneyAuthoringError('REVIEW_CANDIDATE_STALE');
      }
      await tx.jrReviewDecisionRecord.create({
        data: {
          id: this.id(),
          tenantId: context.tenantId,
          candidateId: candidate.id,
          decision: input.decision,
          reviewerSubjectId: context.actor.subjectId,
          capability: 'journey.review',
          capabilitySource: decision.source,
          authorizationEpoch: decision.authorizationEpoch,
          scopeVersion: decision.scopeVersion,
          evidenceRef: input.evidenceRef,
          reasonCode: input.reasonCode,
          decidedAt: this.now(),
        },
      });
      const state: JourneyReviewState =
        input.decision === 'APPROVE'
          ? 'APPROVED'
          : input.decision === 'REJECT'
            ? 'REJECTED'
            : 'CHANGES_REQUESTED';
      await tx.jrReviewCandidate.update({ where: { id: candidate.id }, data: { state } });
      const action =
        state === 'APPROVED'
          ? 'REVIEW_APPROVED'
          : state === 'REJECTED'
            ? 'REVIEW_REJECTED'
            : 'REVIEW_CHANGES_REQUESTED';
      await this.record(
        tx,
        context,
        head.journeyId,
        head.version,
        action,
        input.reasonCode,
        candidate.compileDigest,
        candidate.compileDigest,
      );
      return { reviewId: candidate.id, state };
    });
  }

  /**
   * Ownership transfer is an auditable command (#331 §5): requires direct `journey.transfer` on both the source and target teams,
   * the target team must be active, the draft gets a new revision and all existing reviews become SUPERSEDED; the published version
   * and existing enrollments do not change
   */
  async transferJourneyOwnership(
    context: JourneyCommandContext,
    input: TransferJourneyOwnershipRequestV1 & { readonly journeyId: string },
  ): Promise<JourneyDraftResult> {
    return this.command(context, 'TransferJourneyOwnership', input.journeyId, input, async (tx) => {
      const head = await this.lockedHead(tx, context.tenantId, input.journeyId, [
        input.targetTeamId,
      ]);
      await this.authorize(tx, context, 'journey.transfer', this.scopeOf(head), {
        requireDirect: true,
        allowInactiveTeam: true,
      });
      await this.authorize(
        tx,
        context,
        'journey.transfer',
        { teamId: input.targetTeamId },
        { requireDirect: true },
      );
      if (head.version !== input.expectedHeadVersion) {
        throw new JourneyAuthoringError('PUBLISHED_HEAD_CONFLICT', {
          currentHeadVersion: head.version,
        });
      }
      if (input.targetTeamId === head.ownerTeamId) {
        throw new JourneyAuthoringError('OWNERSHIP_TRANSFER_FORBIDDEN', { reason: 'SAME_TEAM' });
      }
      const current = await tx.jrJourneyDraft.findFirstOrThrow({
        where: {
          tenantId: context.tenantId,
          journeyId: head.journeyId,
          revision: head.currentDraftRevision,
        },
      });
      return this.appendDraft(
        tx,
        context,
        head,
        current.document,
        current.basePublishedVersion,
        'OWNERSHIP_TRANSFERRED',
        input.reasonCode,
        [],
        {
          ownerTeamId: input.targetTeamId,
        },
      );
    });
  }

  /** Reading audit requires direct `journey.read` (delegation is not accepted) and the read itself is audited as another layer */
  async listJourneyAudit(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: { readonly journeyId: string; readonly limit?: number; readonly before?: string },
  ) {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const head = await this.head(tx, tenantId, input.journeyId);
      await this.authorize(tx, { tenantId, actor }, 'journey.read', this.scopeOf(head), {
        requireDirect: true,
      });
      const rows = await tx.jrAuthoringAudit.findMany({
        where: {
          tenantId,
          resourceKind: 'JOURNEY',
          resourceId: head.journeyId,
          ...(input.before ? { occurredAt: { lt: new Date(input.before) } } : {}),
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: Math.min(Math.max(input.limit ?? 50, 1), 200),
        select: {
          id: true,
          action: true,
          actorSubjectId: true,
          reasonCode: true,
          beforeDigest: true,
          afterDigest: true,
          correlationId: true,
          occurredAt: true,
        },
      });
      await tx.jrAuthoringAudit.create({
        data: {
          id: this.id(),
          tenantId,
          resourceKind: 'JOURNEY',
          resourceId: head.journeyId,
          action: 'AUDIT_READ',
          actorSubjectId: actor.subjectId,
          reasonCode: 'AUDIT_READ',
          correlationId: actor.correlationId,
          occurredAt: this.now(),
        },
      });
      return rows.map((row) => ({ ...row, occurredAt: row.occurredAt.toISOString() }));
    });
  }

  /** publish with an unknown outcome: only read the receipt of the same key, never publish again */
  async resolvePublish(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: { readonly journeyId: string; readonly originalIdempotencyKey: string },
  ): Promise<PublishJourneyResultV1 & { readonly errorCode?: string }> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      // the publish result reveals the version/runtime hash — the journey must be visible first; knowing the key is not enough to read it
      const head = await this.head(tx, tenantId, input.journeyId);
      await this.authorize(tx, { tenantId, actor }, 'journey.read', this.scopeOf(head));
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
        // no receipt = the transaction never committed, so it is safe to retry with the same key
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
      await this.authorize(tx, { tenantId, actor }, 'journey.read', this.scopeOf(head));
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
      // compiling an old revision whose draft has since moved still returns a result but must not be published (#329 §5)
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
      await this.authorize(tx, { tenantId, actor }, 'journey.read', this.scopeOf(head));
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
          ? {
              reviewId: review.id,
              state: review.state,
              draftRevision: review.draftRevision,
              draftDigest: review.draftDigest,
              compileDigest: review.compileDigest,
              submittedAt: review.createdAt.toISOString(),
              makerIsCaller: review.makerSubjectId === actor.subjectId,
            }
          : null,
        permissions: await this.permissionsOn(tx, tenantId, actor, head),
      };
    });
  }

  /** The capabilities the caller holds on the Journey at read time — for UI affordances only */
  protected async permissionsOn(
    tx: Tx,
    tenantId: string,
    actor: JourneyAuthoringActor,
    head: JrJourneyHead,
  ) {
    const holds = async (capability: 'journey.edit' | 'journey.review' | 'journey.publish') =>
      (
        await this.options.authorization.authorize(tx, {
          tenantId,
          subjectId: actor.subjectId,
          capability,
          scope: this.scopeOf(head),
        })
      ).allowed;
    return {
      edit: await holds('journey.edit'),
      review: await holds('journey.review'),
      publish: await holds('journey.publish'),
    };
  }

  /**
   * U1.3 (#431): pending reviews the caller can decide — keyset by reviewId, filtered by `journey.review` per
   * Journey on the server, and excluding candidates the caller submitted themself (self-approval is already forbidden)
   */
  async listPendingReviews(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: { readonly limit?: number; readonly cursor?: string } = {},
  ): Promise<{ readonly items: JourneyPendingReviewV1[]; readonly nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const items: JourneyPendingReviewV1[] = [];
      let after = input.cursor;
      for (;;) {
        const rows = await tx.jrReviewCandidate.findMany({
          where: {
            tenantId,
            resourceKind: 'JOURNEY',
            state: 'IN_REVIEW',
            makerSubjectId: { not: actor.subjectId },
            ...(after ? { id: { gt: after } } : {}),
          },
          orderBy: { id: 'asc' },
          take: LIST_SCAN_BATCH,
        });
        for (const row of rows) {
          after = row.id;
          const head = await tx.jrJourneyHead.findUnique({
            where: { tenantId_journeyId: { tenantId, journeyId: row.resourceId } },
          });
          if (!head) continue;
          const decision = await this.options.authorization.authorize(tx, {
            tenantId,
            subjectId: actor.subjectId,
            capability: 'journey.review',
            scope: this.scopeOf(head),
          });
          if (!decision.allowed) continue;
          items.push({
            reviewId: row.id,
            journeyId: head.journeyId,
            journeyName: head.name,
            ownerTeamId: head.ownerTeamId,
            draftRevision: row.draftRevision,
            draftDigest: row.draftDigest,
            compileDigest: row.compileDigest,
            submittedAt: row.createdAt.toISOString(),
          });
          if (items.length === limit) return { items, nextCursor: row.id };
        }
        if (rows.length < LIST_SCAN_BATCH) return { items, nextCursor: null };
      }
    });
  }

  /**
   * keyset by journeyId and filtered by per-row read permission — no total/facet so hidden items cannot be counted;
   * the cursor is only the id of the last row the caller saw
   */
  async listVisibleJourneys(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: {
      readonly lifecycle?: JourneyLifecycle;
      readonly ownerTeamId?: string;
      readonly limit?: number;
      readonly cursor?: string;
    } = {},
  ): Promise<{ readonly items: JourneyAuthoringSummary[]; readonly nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const items: JourneyAuthoringSummary[] = [];
      let after = input.cursor;
      for (;;) {
        const rows = await tx.jrJourneyHead.findMany({
          where: {
            tenantId,
            ...(input.lifecycle ? { lifecycle: input.lifecycle } : {}),
            ...(input.ownerTeamId ? { ownerTeamId: input.ownerTeamId } : {}),
            ...(after ? { journeyId: { gt: after } } : {}),
          },
          orderBy: { journeyId: 'asc' },
          take: LIST_SCAN_BATCH,
        });
        for (const row of rows) {
          after = row.journeyId;
          const decision = await this.options.authorization.authorize(tx, {
            tenantId,
            subjectId: actor.subjectId,
            capability: 'journey.read',
            scope: this.scopeOf(row),
          });
          if (!decision.allowed) continue;
          const openReview = await tx.jrReviewCandidate.findFirst({
            where: {
              tenantId,
              resourceKind: 'JOURNEY',
              resourceId: row.journeyId,
              state: { in: ['IN_REVIEW', 'APPROVED'] },
            },
            orderBy: { createdAt: 'desc' },
            select: { state: true },
          });
          items.push({
            journeyId: row.journeyId,
            name: row.name,
            ownerTeamId: row.ownerTeamId,
            lifecycle: row.lifecycle,
            version: row.version,
            currentDraftRevision: row.currentDraftRevision,
            activeVersion: row.activeVersion,
            updatedAt: row.updatedAt.toISOString(),
            reviewState: (openReview?.state as 'IN_REVIEW' | 'APPROVED' | undefined) ?? null,
          });
          if (items.length === limit) return { items, nextCursor: row.journeyId };
        }
        if (rows.length < LIST_SCAN_BATCH) return { items, nextCursor: null };
      }
    });
  }

  /**
   * #1067: what a journey did at runtime — one row per enrollment with its trigger outcome and owner actions.
   * Gated by the same `journey.read` scope as the journey itself; carries internal ids and codes only
   * (no customer data, no free text), so the owner aggregate (e.g. a case) is opened under its own permission.
   */
  async listJourneyRuns(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: { readonly journeyId: string; readonly limit?: number; readonly cursor?: string },
  ): Promise<{ readonly items: JourneyRunSummary[]; readonly nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100);
    const cursor = decodeRunCursor(input.cursor);
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const head = await this.head(tx, tenantId, input.journeyId);
      await this.authorize(tx, { tenantId, actor }, 'journey.read', this.scopeOf(head));
      const rows = await tx.jrEnrollment.findMany({
        where: {
          tenantId,
          journeyId: input.journeyId,
          ...(cursor
            ? {
                OR: [
                  { createdAt: { lt: cursor.createdAt } },
                  { createdAt: cursor.createdAt, id: { lt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          journeyVersion: true,
          state: true,
          runState: true,
          terminalReason: true,
          createdAt: true,
          updatedAt: true,
          outcomeReceipt: { select: { outcomeType: true, payload: true } },
        },
      });
      const page = rows.slice(0, limit);
      const actions =
        page.length === 0
          ? []
          : await tx.jrOwnerAction.findMany({
              where: { tenantId, enrollmentId: { in: page.map((row) => row.id) } },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: {
                enrollmentId: true,
                stepId: true,
                kind: true,
                state: true,
                ownerAggregateRef: true,
                acknowledgedAt: true,
              },
            });
      const items = page.map((row): JourneyRunSummary => {
        const payload = (row.outcomeReceipt?.payload ?? {}) as Record<string, unknown>;
        const text = (value: unknown) => (typeof value === 'string' ? value : null);
        return {
          enrollmentId: row.id,
          journeyVersion: row.journeyVersion,
          state: row.state,
          runState: row.runState,
          terminalReason: row.terminalReason,
          startedAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          trigger: row.outcomeReceipt
            ? {
                outcomeType: row.outcomeReceipt.outcomeType,
                outcomeCode: text(payload.outcomeCode),
                interactionId: text(payload.interactionId),
              }
            : null,
          actions: actions
            .filter((action) => action.enrollmentId === row.id)
            .map((action) => ({
              stepId: action.stepId,
              kind: action.kind,
              state: action.state,
              ownerAggregateId: action.ownerAggregateRef,
              acknowledgedAt: action.acknowledgedAt?.toISOString() ?? null,
            })),
        };
      });
      const last = page.at(-1);
      return {
        items,
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(`${last.createdAt.toISOString()}|${last.id}`, 'utf8').toString(
                'base64url',
              )
            : null,
      };
    });
  }

  /** validate for an exactly specified revision — a draft that has moved on can still be checked but is reported stale */
  async validateJourneyDraft(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: {
      readonly journeyId: string;
      readonly draftRevision: number;
      readonly draftDigest: string;
    },
  ) {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const { head, draft } = await this.readDraft(tx, tenantId, actor, input);
      return {
        draftRevision: draft.revision,
        draftDigest: draft.contentDigest,
        diagnostics: validateAuthoringDocument(draft.document, {
          capabilities: this.capabilities,
        }),
        stale: draft.revision !== head.currentDraftRevision,
      };
    });
  }

  async previewJourneyPlan(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: { readonly journeyId: string; readonly compileDigest: string },
  ): Promise<PlanPreviewV1> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const artifact = await this.currentArtifact(tx, tenantId, actor, input);
      return planPreview(artifact, this.capabilities);
    });
  }

  /** simulation uses only synthetic fixtures and has no port to real side effects (#329 §8) */
  async simulateJourneyScenario(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: {
      readonly journeyId: string;
      readonly compileDigest: string;
      readonly fixture: SimulationFixtureV1;
    },
  ): Promise<SimulationResultV1> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const artifact = await this.currentArtifact(tx, tenantId, actor, input);
      return runSimulation(artifact, input.fixture, {
        evaluator: this.options.evaluator,
        capabilities: this.capabilities,
      });
    });
  }

  /**
   * the route of a review decision has only reviewId — find the owning resource first, then the real command checks permissions;
   * a review that does not exist or belongs to another resource type answers the same not-found
   */
  async reviewResourceId(
    tenantId: string,
    reviewId: string,
    resourceKind: 'JOURNEY' | 'TEMPLATE',
  ): Promise<string> {
    const notFound = resourceKind === 'TEMPLATE' ? 'TEMPLATE_NOT_FOUND' : 'JOURNEY_NOT_FOUND';
    if (!/^[0-9a-f-]{36}$/i.test(reviewId)) throw new JourneyAuthoringError(notFound);
    const candidate = await withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      tx.jrReviewCandidate.findFirst({
        where: { tenantId, id: reviewId, resourceKind },
        select: { resourceId: true },
      }),
    );
    if (!candidate) throw new JourneyAuthoringError(notFound);
    return candidate.resourceId;
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private async readDraft(
    tx: Tx,
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: {
      readonly journeyId: string;
      readonly draftRevision: number;
      readonly draftDigest: string;
    },
  ) {
    const head = await this.head(tx, tenantId, input.journeyId);
    await this.authorize(tx, { tenantId, actor }, 'journey.read', this.scopeOf(head));
    const draft = await tx.jrJourneyDraft.findFirst({
      where: { tenantId, journeyId: head.journeyId, revision: input.draftRevision },
    });
    if (!draft || draft.contentDigest !== input.draftDigest) {
      throw new JourneyAuthoringError('DRAFT_VERSION_CONFLICT', {
        currentDraftRevision: head.currentDraftRevision,
        currentDraftDigest: head.currentDraftDigest,
      });
    }
    return { head, draft };
  }

  /** preview/simulation are bound to the compile digest of the current draft — a mismatch means the client holds an old result */
  private async currentArtifact(
    tx: Tx,
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: { readonly journeyId: string; readonly compileDigest: string },
  ) {
    const head = await this.head(tx, tenantId, input.journeyId);
    await this.authorize(tx, { tenantId, actor }, 'journey.read', this.scopeOf(head));
    const draft = await tx.jrJourneyDraft.findFirstOrThrow({
      where: { tenantId, journeyId: head.journeyId, revision: head.currentDraftRevision },
    });
    const compiled = this.compile(
      tenantId,
      head,
      draft.document,
      draft.revision,
      draft.contentDigest,
    );
    if (!compiled.artifact) {
      throw new JourneyAuthoringError('DEFINITION_INVALID', undefined, compiled.diagnostics);
    }
    if (compiled.artifact.compileDigest !== input.compileDigest) {
      throw new JourneyAuthoringError('COMPILE_ARTIFACT_STALE');
    }
    return compiled.artifact;
  }

  protected compile(
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
   * idempotency receipt: a successful result commits with the mutation; a deterministic failure is remembered in a separate transaction
   * so the same key gets the same answer — no receipt means it never committed
   */
  protected async command<T extends object>(
    context: JourneyCommandContext,
    commandName: string,
    resourceId: string,
    request: object,
    body: (tx: Tx, receiptId: string) => Promise<T>,
    resourceKind: 'JOURNEY' | 'TEMPLATE' = 'JOURNEY',
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
            resourceKind,
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
        await this.rememberFailure(
          context,
          commandName,
          resourceId,
          requestHash,
          receiptId,
          error,
          resourceKind,
        );
      }
      throw error;
    }
  }

  protected replay<T>(
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

  protected async rememberFailure(
    context: JourneyCommandContext,
    commandName: string,
    resourceId: string,
    requestHash: string,
    receiptId: string,
    error: JourneyAuthoringError,
    resourceKind: 'JOURNEY' | 'TEMPLATE' = 'JOURNEY',
  ) {
    await withTenantDatabaseTransaction(this.database, context.tenantId, async (tx) => {
      await tx.jrAuthoringCommandReceipt.createMany({
        data: [
          {
            id: receiptId,
            tenantId: context.tenantId,
            idempotencyKey: context.idempotencyKey,
            commandName,
            resourceKind,
            resourceId,
            requestHash,
            state: 'FAILED',
            httpStatus: error.httpStatus,
            errorCode: error.code,
            correlationId: context.actor.correlationId,
            completedAt: this.now(),
          },
        ],
        // a parallel request with the same key may have recorded first — the existing result wins
        skipDuplicates: true,
      });
    });
  }

  protected async assertWriteEnabled(
    tx: Tx,
    tenantId: string,
    feature: keyof JourneyAuthoringFeatureFlags,
  ) {
    const rollout = await tx.jrAuthoringRolloutState.findUnique({ where: { tenantId } });
    const tenantEnabled = rollout
      ? {
          canvasWrite: rollout.canvasWriteEnabled,
          publishUi: rollout.publishUiEnabled,
          templateCatalog: rollout.templateCatalogEnabled,
          templateUpgrade: rollout.templateUpgradeEnabled,
        }[feature]
      : false;
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

  protected async authorize(
    tx: Tx,
    context: Pick<JourneyCommandContext, 'tenantId' | 'actor'>,
    capability: JourneyAuthoringCapability,
    scope: JourneyAuthoringAuthorizationScope,
    options: {
      readonly requireDirect?: boolean;
      readonly allowInactiveTeam?: boolean;
      readonly anyTeam?: boolean;
    } = {},
  ) {
    const decision = await this.options.authorization.authorize(tx, {
      tenantId: context.tenantId,
      subjectId: context.actor.subjectId,
      capability,
      scope,
      ...options,
    });
    if (decision.allowed) return decision;
    // an invisible object answers the same not-found as one that does not exist; readable but not editable answers capability (#331 §12)
    if (scope.resource) {
      const visible =
        // readable through delegation but requesting direct (e.g. audit) still counts as visible, so answer capability, not not-found
        ((capability !== 'journey.read' && capability !== 'template.read') ||
          options.requireDirect === true) &&
        (
          await this.options.authorization.authorize(tx, {
            tenantId: context.tenantId,
            subjectId: context.actor.subjectId,
            capability: scope.resource.kind === 'TEMPLATE' ? 'template.read' : 'journey.read',
            scope,
          })
        ).allowed;
      if (!visible) {
        throw new JourneyAuthoringError(
          scope.resource.kind === 'TEMPLATE' ? 'TEMPLATE_NOT_FOUND' : 'JOURNEY_NOT_FOUND',
        );
      }
    }
    throw new JourneyAuthoringError(decision.code, { capability });
  }

  /** scope always comes from the canonical head, never a client value */
  protected scopeOf(
    head: Pick<JrJourneyHead, 'ownerTeamId' | 'journeyId'>,
  ): JourneyAuthoringAuthorizationScope {
    return { teamId: head.ownerTeamId, resource: { kind: 'JOURNEY', id: head.journeyId } };
  }

  /**
   * the approval must come from an independent approver who still has permission at publish time (#331 §10, §13): the maker's vote or a
   * delegation does not count, and if the approver's epoch/scope version changed or was revoked → APPROVAL_STALE
   */
  protected async assertIndependentApproval(
    tx: Tx,
    tenantId: string,
    head: JrJourneyHead,
    candidateId: string,
  ) {
    const candidate = await tx.jrReviewCandidate.findUniqueOrThrow({ where: { id: candidateId } });
    const votes = await tx.jrReviewDecisionRecord.findMany({
      where: { tenantId, candidateId, decision: 'APPROVE', delegationId: null },
    });
    const independent = votes.filter((vote) => vote.reviewerSubjectId !== candidate.makerSubjectId);
    if (independent.length === 0) throw new JourneyAuthoringError('APPROVAL_REQUIRED');
    for (const vote of independent) {
      const current = await this.options.authorization.authorize(tx, {
        tenantId,
        subjectId: vote.reviewerSubjectId,
        capability: 'journey.review',
        scope: this.scopeOf(head),
        requireDirect: true,
      });
      if (
        current.allowed &&
        current.authorizationEpoch === vote.authorizationEpoch &&
        current.scopeVersion === vote.scopeVersion
      ) {
        return;
      }
    }
    throw new JourneyAuthoringError('APPROVAL_STALE');
  }

  /** draft/owner/head changed → pending candidates and approvals can no longer be used (#331 §9) */
  protected async supersedeOpenReviews(tx: Tx, tenantId: string, journeyId: string) {
    await tx.jrReviewCandidate.updateMany({
      where: {
        tenantId,
        resourceKind: 'JOURNEY',
        resourceId: journeyId,
        state: { in: ['IN_REVIEW', 'APPROVED'] },
      },
      data: { state: 'SUPERSEDED' },
    });
  }

  /** a broken schema cannot be saved; an incomplete graph can be saved and returns diagnostics to keep fixing */
  protected assertSavable(document: unknown): JourneyDiagnosticV1[] {
    const diagnostics = validateAuthoringDocument(document, { capabilities: this.capabilities });
    const blocking = diagnostics.filter(
      (item) => item.severity === 'ERROR' && SCHEMA_BLOCKING.has(item.code),
    );
    if (blocking.length > 0)
      throw new JourneyAuthoringError('AUTHORING_SCHEMA_INVALID', undefined, blocking);
    return diagnostics;
  }

  protected assertEditable(head: JrJourneyHead) {
    if (head.lifecycle === 'DEPRECATED') {
      throw new JourneyAuthoringError('JOURNEY_LIFECYCLE_CONFLICT', { lifecycle: head.lifecycle });
    }
  }

  protected assertCas(head: JrJourneyHead, cas: JourneyDraftCas) {
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

  protected async lockJourney(tx: Tx, tenantId: string, journeyId: string) {
    await tx.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`jr-journey-authoring:${tenantId}:${journeyId}`}))`,
    );
  }

  /** missing/foreign/hidden answer the same not-found — RLS already makes other tenants' data invisible */
  protected async head(tx: Tx, tenantId: string, journeyId: string): Promise<JrJourneyHead> {
    const head = /^[0-9a-f-]{36}$/i.test(journeyId)
      ? await tx.jrJourneyHead.findUnique({
          where: { tenantId_journeyId: { tenantId, journeyId } },
        })
      : null;
    if (!head) throw new JourneyAuthoringError('JOURNEY_NOT_FOUND');
    return head;
  }

  protected async lockedHead(
    tx: Tx,
    tenantId: string,
    journeyId: string,
    additionalTeams: readonly string[] = [],
  ) {
    const head = await this.head(tx, tenantId, journeyId);
    await lockTeamReferences(tx, tenantId, [head.ownerTeamId, ...additionalTeams]);
    await this.lockJourney(tx, tenantId, journeyId);
    await this.options.writeGuard?.assertJourneyWritable(tx, tenantId, head.journeyId);
    // reread after taking the lock so the CAS compares against the latest committed value
    return this.head(tx, tenantId, journeyId);
  }

  protected async publishedContent(tx: Tx, tenantId: string, journeyId: string, version: number) {
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

  protected async insertDraft(
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

  protected async appendDraft(
    tx: Tx,
    context: JourneyCommandContext,
    head: JrJourneyHead,
    document: unknown,
    basePublishedVersion: number | null,
    action: string,
    reasonCode: string,
    diagnostics: readonly JourneyDiagnosticV1[],
    headChanges: Prisma.JrJourneyHeadUpdateManyMutationInput = {},
  ): Promise<JourneyDraftResult> {
    await this.supersedeOpenReviews(tx, context.tenantId, head.journeyId);
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
      ...headChanges,
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

  /** CAS on head: the version must be unchanged at write time, and a trigger enforces +1 as another layer */
  protected async casHead(
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

  /** audit + outbox in the same transaction as the mutation — metadata only */
  protected async record(
    tx: Tx,
    context: JourneyCommandContext,
    journeyId: string,
    headVersion: number,
    action: string,
    reasonCode: string,
    beforeDigest: string | null,
    afterDigest: string | null,
    resourceKind: 'JOURNEY' | 'TEMPLATE' = 'JOURNEY',
  ) {
    const occurredAt = this.now();
    const auditId = this.id();
    await tx.jrAuthoringAudit.create({
      data: {
        id: auditId,
        tenantId: context.tenantId,
        resourceKind,
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
      resourceKind,
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
        // review does not move the head version, so bind the event to the audit row instead — one audit, one event
        eventId: `journey-authoring:${auditId}`,
        resourceKind,
        resourceId: journeyId,
        aggregateVersion: headVersion,
        eventType:
          resourceKind === 'TEMPLATE' ? 'journey.template.changed' : 'journey.authoring.changed',
        payload,
        payloadHash: journeyAuthoringDigest(payload),
        correlationId: context.actor.correlationId,
      },
    });
  }
}
