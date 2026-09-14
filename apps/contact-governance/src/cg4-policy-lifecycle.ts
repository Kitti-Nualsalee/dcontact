import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type Cg4Policy,
  type Cg4PolicyDiffClass as PrismaCg4PolicyDiffClass,
  type Cg4PolicyStatus,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  CG4_EVALUATOR_VERSION,
  CG4_EVENT_TYPES,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  resolveCg4PolicyQuorum,
  type Cg4AuthorizationSubject,
  type Cg4Digest,
  type Cg4PolicyDiffClass,
  type Cg4QuorumEvaluation,
  type Cg4RecordedApproval,
  type Cg4TransitionKind,
} from '@d-contact/cxa-contracts';
import {
  Cg3IdempotencyConflictError,
  Cg3ResourceNotFoundError,
  Cg3VersionConflictError,
  stableDigest,
} from './cg3-persistence.js';
import {
  assertCg4QuorumMet,
  assertCg4RequestAuthorization,
  evaluateCg4Quorum,
} from './cg4-authorization-engine.js';
import {
  cg4EventScopeDimensions,
  cg4PolicyScopesAmbiguous,
  compileCg4Policy,
  Cg4PolicyValidationError,
  type Cg4CompiledPolicy,
  type Cg4PolicyContentV1,
} from './cg4-policy-compiler.js';
import { previewCg4Policy, type Cg4PolicyPreview } from './cg4-policy-preview.js';
import { cg4KillSwitchEvent } from './cg4-kill-switch-event.js';
import type { Cg4PolicyFixturePack } from './cg4-policy-fixtures.js';

/**
 * CG4.5 (#188): the policy studio runtime — immutable versions, deterministic tests,
 * approval binding, atomic immediate/scheduled publish, rollback-as-new-version and the
 * scoped kill switch.
 *
 * Two rules shape every method here. First, published content is never edited: a change
 * is always a new monotonic version, and rollback clones the target's content forward
 * rather than flipping a pointer (#176 §1/§6). Second, nothing is trusted across a
 * transaction boundary: publish re-derives the content digest from the stored content,
 * re-counts the quorum from stored votes, and re-checks the head it was approved against,
 * because an approval only ever means "this exact artifact against that exact head".
 */

const POLICY_LOCK_SCOPE = 'cg4-policy';

export class Cg4PolicyLifecycleError extends Error {
  constructor(
    readonly code:
      | 'INVALID_LIFECYCLE_TRANSITION'
      | 'POLICY_TESTS_REQUIRED'
      | 'POLICY_TESTS_FAILED'
      | 'POLICY_SCOPE_AMBIGUOUS'
      | 'POLICY_HEAD_CONFLICT'
      | 'SCHEDULE_CONFLICT'
      | 'APPROVAL_STALE'
      | 'APPROVAL_REQUIRED'
      | 'POLICY_ACTIVATION_CONFLICT'
      | 'GOVERNANCE_KILL_SWITCH_ACTIVE',
    message: string,
  ) {
    super(message);
    this.name = 'Cg4PolicyLifecycleError';
  }
}

/** Canonical head state: what a publish CASes against and what consumers cache by. */
export function cg4PolicyHeadDigest(head: {
  policyId: string;
  version: number;
  contentDigest: string;
}): Cg4Digest {
  return stableDigest({
    policyId: head.policyId,
    version: head.version,
    contentDigest: head.contentDigest,
  });
}

export const CG4_EMPTY_HEAD_DIGEST = stableDigest({ head: null });

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} ต้องเป็น string ที่ไม่ว่าง`);
  return normalized;
}

function instant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} ต้องเป็น ISO-8601 timestamp`);
  return parsed;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function toRecordedApproval(row: {
  approverRef: string;
  capability: string;
  capabilitySource: string;
  directCompliance: boolean;
  emergencyAuthority: boolean;
  authorizationEpoch: number;
  scopeVersion: number;
  decidedAt: Date;
}): Cg4RecordedApproval {
  return {
    checkerSubjectId: row.approverRef as Cg4RecordedApproval['checkerSubjectId'],
    capability: row.capability as Cg4RecordedApproval['capability'],
    directComplianceAuthority: row.directCompliance,
    emergencyAuthority: row.emergencyAuthority,
    source: row.capabilitySource as Cg4RecordedApproval['source'],
    authorizationEpoch: row.authorizationEpoch,
    scopeVersion: row.scopeVersion,
    decidedAt: row.decidedAt.toISOString(),
  };
}

// ── Inputs / results ─────────────────────────────────────────────────────────

interface CommandBase {
  tenantId: string;
  actor: Cg4AuthorizationSubject;
  evidenceRef: string;
  occurredAt: string;
  idempotencyKey: string;
}

export interface CreateCg4PolicyDraftInput extends CommandBase {
  /** Omit to open a new series; supply it to add the next version to an existing one. */
  policyId?: string;
  scopeKey: string;
  content: unknown;
  effectiveFrom: string;
}

export interface AmendCg4PolicyDraftInput extends CommandBase {
  policyId: string;
  version: number;
  expectedDraftRevision: number;
  content: unknown;
}

export interface Cg4PolicyDraftResult {
  mutationId: string;
  policyId: string;
  policyVersionId: string;
  version: number;
  draftRevision: number;
  scopeKey: string;
  contentDigest: Cg4Digest;
  lifecycleState: Cg4PolicyStatus;
}

/** Preview is read-only, so it needs the candidate and the packs but no actor or receipt. */
export interface PreviewCg4PolicyCommandInput {
  tenantId: string;
  policyId: string;
  version: number;
  expectedContentDigest: string;
  tenantPack: Cg4PolicyFixturePack;
  platformPack?: Cg4PolicyFixturePack;
  pinnedEvaluationTime: string;
  pinnedTimezone: string;
}

export interface RunCg4PolicyTestsCommandInput extends PreviewCg4PolicyCommandInput, CommandBase {}

export interface Cg4PolicyTestResult {
  mutationId: string;
  policyId: string;
  version: number;
  artifactId: string;
  preview: Cg4PolicyPreview;
}

export interface SubmitCg4PolicyInput extends CommandBase {
  policyId: string;
  version: number;
  expectedDraftRevision: number;
  expectedContentDigest: string;
  expectedTestArtifactDigest: string;
}

export interface FinalizeCg4PolicyApprovalInput extends CommandBase {
  policyId: string;
  version: number;
  expectedContentDigest: string;
  expectedTestArtifactDigest: string;
  expectedDiffClass: Cg4PolicyDiffClass;
  expectedScopeHeadVersion: number;
  expectedScopeHeadDigest: string;
  /** Immediate publish when this is at or before the publish instant. */
  activateAt: string;
}

export interface PublishCg4PolicyInput extends CommandBase {
  policyId: string;
  version: number;
  expectedContentDigest: string;
  expectedTestArtifactDigest: string;
  expectedApprovalDigest: string;
  expectedScopeHeadVersion: number;
  expectedScopeHeadDigest: string;
}

export interface ActivateDueCg4PolicyInput {
  tenantId: string;
  policyId: string;
  version: number;
  leaseOwner: string;
  occurredAt: string;
  idempotencyKey: string;
}

export interface RollbackCg4PolicyInput extends CommandBase {
  policyId: string;
  /** The already-superseded version whose canonical content is cloned forward. */
  sourceVersion: number;
  expectedSourceContentDigest: string;
  reasonCode: string;
}

export interface Cg4PolicyPublishResult {
  mutationId: string;
  eventId: string;
  policyId: string;
  policyVersionId: string;
  version: number;
  lifecycleState: Cg4PolicyStatus;
  scopeKey: string;
  headVersion: number;
  headDigest: Cg4Digest;
  activateAt: string;
  quorum: Cg4QuorumEvaluation;
}

export interface Cg4KillSwitchInput extends CommandBase {
  scopeKey: string;
  action: 'ACTIVATE' | 'CLEAR';
  reasonCode: string;
  /** #176 §6: clearing needs an independent publish-grade approval, never automation. */
  clearApprovalRef?: string;
}

export interface Cg4KillSwitchResult {
  mutationId: string;
  eventId: string;
  killSwitchId: string;
  scopeKey: string;
  state: 'ACTIVE' | 'CLEARED';
}

export interface Cg4PolicyLifecycleRepositoryOptions {
  id?: () => string;
  now?: () => Date;
}

type Transaction = Prisma.TransactionClient;

interface HeadSnapshot {
  headVersion: number;
  headDigest: string;
  policyId: string | null;
  policyVersion: number | null;
  policyRevisionId: string | null;
  nextActivationAt: Date | null;
}

export class Cg4PolicyLifecycleRepository {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    options: Cg4PolicyLifecycleRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  // ── Shared helpers ─────────────────────────────────────────────────────────

  /**
   * Serializes every mutation and read-for-update on one scope. Publish, scheduled
   * activation and rollback all take it, which is what gives concurrent publishes a
   * deterministic linearization point instead of a last-writer-wins head (#176 §3).
   */
  private async lockScope(
    transaction: Transaction,
    tenantId: string,
    scopeKey: string,
  ): Promise<void> {
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`${POLICY_LOCK_SCOPE}:${tenantId}:${scopeKey}`}))`,
    );
  }

  private async loadHead(
    transaction: Transaction,
    tenantId: string,
    scopeKey: string,
  ): Promise<HeadSnapshot> {
    const head = await transaction.cg4PolicyScopeHead.findUnique({
      where: { tenantId_scopeKey: { tenantId, scopeKey } },
    });
    if (!head) {
      return {
        headVersion: 0,
        headDigest: CG4_EMPTY_HEAD_DIGEST,
        policyId: null,
        policyVersion: null,
        policyRevisionId: null,
        nextActivationAt: null,
      };
    }
    return {
      headVersion: head.headVersion,
      headDigest: head.headDigest,
      policyId: head.headPolicyId,
      policyVersion: head.headPolicyVersion,
      policyRevisionId: head.headPolicyRevisionId,
      nextActivationAt: head.nextActivationAt,
    };
  }

  private async loadHeadContent(
    transaction: Transaction,
    tenantId: string,
    head: HeadSnapshot,
  ): Promise<Cg4PolicyContentV1 | null> {
    if (!head.policyRevisionId) return null;
    const row = await transaction.cg4Policy.findFirst({
      where: { tenantId, id: head.policyRevisionId },
    });
    if (!row) return null;
    return compileCg4Policy({ content: row.content, version: row.version }).content;
  }

  /**
   * #176 §1: a candidate may not activate while another ACTIVE head at the same
   * specificity could match the same request. There is no publish-time tie-break, so the
   * conflict has to be refused at the write boundary.
   */
  private async assertScopeUnambiguous(
    transaction: Transaction,
    tenantId: string,
    scopeKey: string,
  ): Promise<void> {
    const active = await transaction.cg4Policy.findMany({
      where: { tenantId, status: 'ACTIVE', scopeKey: { not: scopeKey } },
      select: { scopeKey: true },
      distinct: ['scopeKey'],
    });
    const conflict = active.find((row) => cg4PolicyScopesAmbiguous(scopeKey, row.scopeKey));
    if (conflict) {
      throw new Cg4PolicyLifecycleError(
        'POLICY_SCOPE_AMBIGUOUS',
        `scope ${scopeKey} กำกวมกับ active scope ${conflict.scopeKey} ที่ specificity เดียวกัน`,
      );
    }
  }

  private async killSwitchActive(
    transaction: Transaction,
    tenantId: string,
    scopeKey: string,
  ): Promise<boolean> {
    const row = await transaction.cg4ScopeKillSwitch.findFirst({
      where: { tenantId, scopeKey, state: 'ACTIVE' },
    });
    return row !== null;
  }

  private async receipt<T>(
    transaction: Transaction,
    tenantId: string,
    operation: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<T | undefined> {
    const existing = await transaction.cgCommandReceipt.findUnique({
      where: {
        tenantId_operation_idempotencyKey: { tenantId, operation, idempotencyKey },
      },
    });
    if (!existing) return undefined;
    if (existing.requestHash !== requestHash) throw new Cg3IdempotencyConflictError(idempotencyKey);
    return existing.responseBody as unknown as T;
  }

  private async writeReceipt(
    transaction: Transaction,
    input: {
      tenantId: string;
      operation: string;
      idempotencyKey: string;
      requestHash: string;
      expectedVersion: number;
      aggregateVersion: number;
      body: unknown;
    },
  ): Promise<void> {
    await transaction.cgCommandReceipt.create({
      data: {
        id: this.id(),
        tenantId: input.tenantId,
        operation: input.operation,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        expectedVersion: input.expectedVersion,
        aggregateVersion: input.aggregateVersion,
        responseStatus: 200,
        responseBody: json(input.body),
      },
    });
  }

  private async audit(
    transaction: Transaction,
    input: {
      tenantId: string;
      mutationId: string;
      aggregateId: string;
      aggregateVersion: number;
      action: string;
      actorRef: string;
      evidenceRef: string;
      beforeDigest?: string | null;
      afterDigest: string;
      occurredAt: Date;
    },
  ): Promise<void> {
    await transaction.cgAuditLog.create({
      data: {
        id: this.id(),
        tenantId: input.tenantId,
        mutationId: input.mutationId,
        aggregateType: 'POLICY',
        aggregateId: input.aggregateId,
        aggregateVersion: input.aggregateVersion,
        action: input.action,
        actorClass: 'COMPLIANCE',
        actorRef: input.actorRef,
        sourceKind: 'COMPLIANCE',
        evidenceRef: input.evidenceRef,
        ...(input.beforeDigest ? { beforeDigest: input.beforeDigest } : {}),
        afterDigest: input.afterDigest,
        occurredAt: input.occurredAt,
      },
    });
  }

  // ── Authoring ──────────────────────────────────────────────────────────────

  /**
   * Opens a new candidate version. A new series binds its canonical `scopeKey` here and
   * can never move scope afterwards (#176 §1) — a scope change is a new series.
   */
  async createDraft(input: CreateCg4PolicyDraftInput): Promise<Cg4PolicyDraftResult> {
    nonEmpty(input.tenantId, 'tenantId');
    nonEmpty(input.scopeKey, 'scopeKey');
    nonEmpty(input.evidenceRef, 'evidenceRef');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const effectiveFrom = instant(input.effectiveFrom, 'effectiveFrom');
    const compiled = compileCg4Policy({ content: input.content, version: 1 });

    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyId: input.policyId ?? null,
      scopeKey: input.scopeKey,
      contentDigest: compiled.contentDigest,
      effectiveFrom: effectiveFrom.toISOString(),
      actorSubjectId: input.actor.subjectId,
      authorizationEpoch: input.actor.authorizationEpoch,
      scopeVersion: input.actor.scopeVersion,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const replay = await this.receipt<Cg4PolicyDraftResult>(
        transaction,
        input.tenantId,
        'CG4_POLICY_DRAFT_CREATE',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;

      await this.lockScope(transaction, input.tenantId, input.scopeKey);
      assertCg4RequestAuthorization({
        subject: input.actor,
        capability: 'cg.policy.draft',
        scopeKey: input.scopeKey,
        now: this.now(),
      });

      let policyId = input.policyId;
      let version = 1;
      if (policyId) {
        const series = await transaction.cg4Policy.findMany({
          where: { tenantId: input.tenantId, policyId },
          orderBy: { version: 'desc' },
          take: 1,
        });
        const latest = series[0];
        if (!latest) throw new Cg3ResourceNotFoundError();
        if (latest.scopeKey !== input.scopeKey) {
          throw new Cg4PolicyValidationError(
            'SCOPE_INVALID',
            'เปลี่ยน scope ของ series เดิมไม่ได้ ต้องสร้าง series ใหม่',
          );
        }
        version = latest.version + 1;
      } else {
        policyId = this.id();
        await this.assertScopeUnambiguous(transaction, input.tenantId, input.scopeKey);
      }

      const row = await transaction.cg4Policy.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          policyId,
          version,
          scopeKey: input.scopeKey,
          content: json(compiled.content),
          contentDigest: compiled.contentDigest,
          registryVersion: CG4_RULE_REGISTRY_VERSION,
          schemaVersion: CG4_POLICY_SCHEMA_VERSION,
          evaluatorVersion: CG4_EVALUATOR_VERSION,
          draftRevision: 1,
          status: 'DRAFT',
          effectiveFrom,
          makerActorRef: input.actor.subjectId,
        },
      });

      const mutationId = this.id();
      const result: Cg4PolicyDraftResult = {
        mutationId,
        policyId,
        policyVersionId: row.id,
        version,
        draftRevision: 1,
        scopeKey: input.scopeKey,
        contentDigest: compiled.contentDigest,
        lifecycleState: 'DRAFT',
      };
      await this.audit(transaction, {
        tenantId: input.tenantId,
        mutationId,
        aggregateId: policyId,
        aggregateVersion: version,
        action: 'CG4_POLICY_DRAFT_CREATE',
        actorRef: input.actor.subjectId,
        evidenceRef: input.evidenceRef,
        afterDigest: compiled.contentDigest,
        occurredAt,
      });
      await this.writeReceipt(transaction, {
        tenantId: input.tenantId,
        operation: 'CG4_POLICY_DRAFT_CREATE',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: version,
        aggregateVersion: version,
        body: result,
      });
      return result;
    });
  }

  /** Edits a DRAFT under `draftRevision` CAS. Content is frozen the moment it is submitted. */
  async amendDraft(input: AmendCg4PolicyDraftInput): Promise<Cg4PolicyDraftResult> {
    nonEmpty(input.tenantId, 'tenantId');
    nonEmpty(input.policyId, 'policyId');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const compiled = compileCg4Policy({ content: input.content, version: input.version });

    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyId: input.policyId,
      version: input.version,
      expectedDraftRevision: input.expectedDraftRevision,
      contentDigest: compiled.contentDigest,
      actorSubjectId: input.actor.subjectId,
      authorizationEpoch: input.actor.authorizationEpoch,
      scopeVersion: input.actor.scopeVersion,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const replay = await this.receipt<Cg4PolicyDraftResult>(
        transaction,
        input.tenantId,
        'CG4_POLICY_DRAFT_AMEND',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;

      const row = await transaction.cg4Policy.findFirst({
        where: { tenantId: input.tenantId, policyId: input.policyId, version: input.version },
      });
      if (!row) throw new Cg3ResourceNotFoundError();
      await this.lockScope(transaction, input.tenantId, row.scopeKey);
      assertCg4RequestAuthorization({
        subject: input.actor,
        capability: 'cg.policy.draft',
        scopeKey: row.scopeKey,
        now: this.now(),
      });
      if (row.status !== 'DRAFT') {
        throw new Cg4PolicyLifecycleError(
          'INVALID_LIFECYCLE_TRANSITION',
          `แก้ content ของ policy สถานะ ${row.status} ไม่ได้ ต้องสร้าง version ใหม่`,
        );
      }

      const draftRevision = input.expectedDraftRevision + 1;
      const updated = await transaction.cg4Policy.updateMany({
        where: {
          tenantId: input.tenantId,
          id: row.id,
          draftRevision: input.expectedDraftRevision,
          status: 'DRAFT',
        },
        data: {
          content: json(compiled.content),
          contentDigest: compiled.contentDigest,
          draftRevision,
          // Editing the content invalidates whatever was tested against the old one.
          testArtifactDigest: null,
          diffClass: null,
          baseHeadVersion: null,
          baseHeadDigest: null,
        },
      });
      if (updated.count !== 1) {
        throw new Cg3VersionConflictError(input.expectedDraftRevision, row.draftRevision);
      }

      const mutationId = this.id();
      const result: Cg4PolicyDraftResult = {
        mutationId,
        policyId: input.policyId,
        policyVersionId: row.id,
        version: input.version,
        draftRevision,
        scopeKey: row.scopeKey,
        contentDigest: compiled.contentDigest,
        lifecycleState: 'DRAFT',
      };
      await this.audit(transaction, {
        tenantId: input.tenantId,
        mutationId,
        aggregateId: input.policyId,
        aggregateVersion: input.version,
        action: 'CG4_POLICY_DRAFT_AMEND',
        actorRef: input.actor.subjectId,
        evidenceRef: input.evidenceRef,
        beforeDigest: row.contentDigest,
        afterDigest: compiled.contentDigest,
        occurredAt,
      });
      await this.writeReceipt(transaction, {
        tenantId: input.tenantId,
        operation: 'CG4_POLICY_DRAFT_AMEND',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: input.expectedDraftRevision,
        aggregateVersion: draftRevision,
        body: result,
      });
      return result;
    });
  }

  // ── Preview / tests ────────────────────────────────────────────────────────

  /** Read-only deterministic preview; persists nothing, so it can be run freely. */
  async preview(input: PreviewCg4PolicyCommandInput): Promise<Cg4PolicyPreview> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const { compiled, head, baseContent } = await this.loadCandidate(transaction, input);
      return previewCg4Policy({
        compiled,
        baseContent,
        baseHeadVersion: head.headVersion,
        baseHeadDigest: head.headDigest,
        tenantPack: input.tenantPack,
        ...(input.platformPack ? { platformPack: input.platformPack } : {}),
        pinnedEvaluationTime: input.pinnedEvaluationTime,
        pinnedTimezone: input.pinnedTimezone,
      });
    });
  }

  private async loadCandidate(
    transaction: Transaction,
    input: { tenantId: string; policyId: string; version: number; expectedContentDigest: string },
  ): Promise<{
    row: Cg4Policy;
    compiled: Cg4CompiledPolicy;
    head: HeadSnapshot;
    baseContent: Cg4PolicyContentV1 | null;
  }> {
    const row = await transaction.cg4Policy.findFirst({
      where: { tenantId: input.tenantId, policyId: input.policyId, version: input.version },
    });
    if (!row) throw new Cg3ResourceNotFoundError();
    if (row.contentDigest !== input.expectedContentDigest) {
      throw new Cg3VersionConflictError(input.version, row.version);
    }
    // Recompiling proves the stored content still compiles under the current schema and
    // registry, and that the stored digest was not written by a different compiler.
    const compiled = compileCg4Policy({
      content: row.content,
      version: row.version,
      schemaVersion: row.schemaVersion,
      registryVersion: row.registryVersion,
      evaluatorVersion: row.evaluatorVersion,
    });
    if (compiled.contentDigest !== row.contentDigest) {
      throw new Cg4PolicyValidationError(
        'VALIDATION_FAILED',
        'content digest ที่เก็บไว้ไม่ตรงกับ compiler ปัจจุบัน',
      );
    }
    const head = await this.loadHead(transaction, input.tenantId, row.scopeKey);
    const baseContent = await this.loadHeadContent(transaction, input.tenantId, head);
    return { row, compiled, head, baseContent };
  }

  /**
   * Runs the mandatory suite and persists the artifact append-only, then stamps the draft
   * with the artifact/diff/head binding an approval will later be checked against.
   */
  async runTests(input: RunCg4PolicyTestsCommandInput): Promise<Cg4PolicyTestResult> {
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyId: input.policyId,
      version: input.version,
      expectedContentDigest: input.expectedContentDigest,
      pinnedEvaluationTime: input.pinnedEvaluationTime,
      pinnedTimezone: input.pinnedTimezone,
      actorSubjectId: input.actor.subjectId,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const replay = await this.receipt<Cg4PolicyTestResult>(
        transaction,
        input.tenantId,
        'CG4_POLICY_TEST',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;

      const { row, compiled, head, baseContent } = await this.loadCandidate(transaction, input);
      await this.lockScope(transaction, input.tenantId, row.scopeKey);
      assertCg4RequestAuthorization({
        subject: input.actor,
        capability: 'cg.policy.draft',
        scopeKey: row.scopeKey,
        now: this.now(),
      });

      const preview = previewCg4Policy({
        compiled,
        baseContent,
        baseHeadVersion: head.headVersion,
        baseHeadDigest: head.headDigest,
        tenantPack: input.tenantPack,
        ...(input.platformPack ? { platformPack: input.platformPack } : {}),
        pinnedEvaluationTime: input.pinnedEvaluationTime,
        pinnedTimezone: input.pinnedTimezone,
      });

      const artifact = await transaction.cg4PolicyTestArtifact.upsert({
        where: {
          tenantId_policyId_policyVersion_suiteVersion_contentDigest: {
            tenantId: input.tenantId,
            policyId: input.policyId,
            policyVersion: input.version,
            suiteVersion: preview.tests.suiteVersion,
            contentDigest: compiled.contentDigest,
          },
        },
        // A deterministic re-run of the same suite against the same content is a no-op:
        // the artifact digest cannot differ, so there is nothing to rewrite.
        update: {},
        create: {
          id: this.id(),
          tenantId: input.tenantId,
          policyId: input.policyId,
          policyVersion: input.version,
          suiteVersion: preview.tests.suiteVersion,
          artifactDigest: preview.artifactDigest,
          result: json(preview.tests),
          contentDigest: compiled.contentDigest,
          platformFixtureDigest: preview.platformFixturePackDigest,
          tenantFixtureDigest: preview.tenantFixturePackDigest,
          baseHeadVersion: head.headVersion,
          baseHeadDigest: head.headDigest,
          diffClass: preview.diffClass as PrismaCg4PolicyDiffClass,
          outcome: preview.tests.outcome,
          passed: preview.tests.passed,
          failed: preview.tests.failed,
        },
      });

      if (row.status === 'DRAFT') {
        await transaction.cg4Policy.updateMany({
          where: { tenantId: input.tenantId, id: row.id, status: 'DRAFT' },
          data: {
            testArtifactDigest: preview.artifactDigest,
            diffClass: preview.diffClass as PrismaCg4PolicyDiffClass,
            baseHeadVersion: head.headVersion,
            baseHeadDigest: head.headDigest,
          },
        });
      }

      const mutationId = this.id();
      const result: Cg4PolicyTestResult = {
        mutationId,
        policyId: input.policyId,
        version: input.version,
        artifactId: artifact.id,
        preview,
      };
      await this.audit(transaction, {
        tenantId: input.tenantId,
        mutationId,
        aggregateId: input.policyId,
        aggregateVersion: input.version,
        action: 'CG4_POLICY_TEST',
        actorRef: input.actor.subjectId,
        evidenceRef: input.evidenceRef,
        beforeDigest: row.testArtifactDigest,
        afterDigest: preview.artifactDigest,
        occurredAt,
      });
      await this.writeReceipt(transaction, {
        tenantId: input.tenantId,
        operation: 'CG4_POLICY_TEST',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: input.version,
        aggregateVersion: input.version,
        body: result,
      });
      return result;
    });
  }

  // ── Review / approval ──────────────────────────────────────────────────────

  /** DRAFT → IN_REVIEW. Content freezes here; a later edit needs a new version (#176 §1). */
  async submit(input: SubmitCg4PolicyInput): Promise<Cg4PolicyDraftResult> {
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyId: input.policyId,
      version: input.version,
      expectedDraftRevision: input.expectedDraftRevision,
      expectedContentDigest: input.expectedContentDigest,
      expectedTestArtifactDigest: input.expectedTestArtifactDigest,
      actorSubjectId: input.actor.subjectId,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const replay = await this.receipt<Cg4PolicyDraftResult>(
        transaction,
        input.tenantId,
        'CG4_POLICY_SUBMIT',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;

      const { row, compiled, head } = await this.loadCandidate(transaction, input);
      await this.lockScope(transaction, input.tenantId, row.scopeKey);
      assertCg4RequestAuthorization({
        subject: input.actor,
        capability: 'cg.policy.draft',
        scopeKey: row.scopeKey,
        now: this.now(),
      });
      if (row.status !== 'DRAFT') {
        throw new Cg4PolicyLifecycleError(
          'INVALID_LIFECYCLE_TRANSITION',
          `submit จากสถานะ ${row.status} ไม่ได้`,
        );
      }
      await this.assertFreshTests(transaction, {
        tenantId: input.tenantId,
        policyId: input.policyId,
        version: input.version,
        contentDigest: compiled.contentDigest,
        artifactDigest: input.expectedTestArtifactDigest,
        head,
      });

      const updated = await transaction.cg4Policy.updateMany({
        where: {
          tenantId: input.tenantId,
          id: row.id,
          draftRevision: input.expectedDraftRevision,
          status: 'DRAFT',
        },
        data: { status: 'IN_REVIEW', submittedAt: occurredAt },
      });
      if (updated.count !== 1) {
        throw new Cg3VersionConflictError(input.expectedDraftRevision, row.draftRevision);
      }

      const mutationId = this.id();
      const result: Cg4PolicyDraftResult = {
        mutationId,
        policyId: input.policyId,
        policyVersionId: row.id,
        version: input.version,
        draftRevision: input.expectedDraftRevision,
        scopeKey: row.scopeKey,
        contentDigest: compiled.contentDigest,
        lifecycleState: 'IN_REVIEW',
      };
      await this.audit(transaction, {
        tenantId: input.tenantId,
        mutationId,
        aggregateId: input.policyId,
        aggregateVersion: input.version,
        action: 'CG4_POLICY_SUBMIT',
        actorRef: input.actor.subjectId,
        evidenceRef: input.evidenceRef,
        afterDigest: compiled.contentDigest,
        occurredAt,
      });
      await this.writeReceipt(transaction, {
        tenantId: input.tenantId,
        operation: 'CG4_POLICY_SUBMIT',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: input.expectedDraftRevision,
        aggregateVersion: input.version,
        body: result,
      });
      return result;
    });
  }

  /**
   * #176 §2: an artifact is only usable while the content, both fixture packs and the head
   * it was diffed against are all still current. Anything else is a stale test.
   */
  private async assertFreshTests(
    transaction: Transaction,
    input: {
      tenantId: string;
      policyId: string;
      version: number;
      contentDigest: string;
      artifactDigest: string;
      head: HeadSnapshot;
    },
  ): Promise<void> {
    const artifact = await transaction.cg4PolicyTestArtifact.findFirst({
      where: {
        tenantId: input.tenantId,
        policyId: input.policyId,
        policyVersion: input.version,
        artifactDigest: input.artifactDigest,
      },
    });
    if (!artifact) {
      throw new Cg4PolicyLifecycleError(
        'POLICY_TESTS_REQUIRED',
        'ไม่พบ test artifact ที่ตรงกับ digest ที่อ้าง',
      );
    }
    if (artifact.outcome !== 'PASS') {
      throw new Cg4PolicyLifecycleError(
        'POLICY_TESTS_FAILED',
        `test artifact มี ${artifact.failed} check ที่ไม่ผ่าน`,
      );
    }
    if (artifact.contentDigest !== input.contentDigest) {
      throw new Cg4PolicyLifecycleError(
        'POLICY_TESTS_REQUIRED',
        'test artifact ผูกกับ content คนละ digest',
      );
    }
    if (
      artifact.baseHeadVersion !== input.head.headVersion ||
      artifact.baseHeadDigest !== input.head.headDigest
    ) {
      throw new Cg4PolicyLifecycleError(
        'POLICY_HEAD_CONFLICT',
        'test artifact diff กับ head คนละตัวกับ head ปัจจุบัน',
      );
    }
  }

  /**
   * Finalizes review once the recorded votes meet quorum. Votes themselves are written by
   * `Cg4ApprovalRepository.recordPolicyApproval`; this re-counts them under the scope lock
   * so a revoked grant or a changed head between the last vote and finalization is caught.
   */
  async finalizeApproval(
    input: FinalizeCg4PolicyApprovalInput,
  ): Promise<Cg4PolicyDraftResult & { quorum: Cg4QuorumEvaluation; activateAt: string }> {
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const activateAt = instant(input.activateAt, 'activateAt');
    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyId: input.policyId,
      version: input.version,
      expectedContentDigest: input.expectedContentDigest,
      expectedTestArtifactDigest: input.expectedTestArtifactDigest,
      expectedDiffClass: input.expectedDiffClass,
      expectedScopeHeadVersion: input.expectedScopeHeadVersion,
      expectedScopeHeadDigest: input.expectedScopeHeadDigest,
      activateAt: activateAt.toISOString(),
      actorSubjectId: input.actor.subjectId,
    });

    type Result = Cg4PolicyDraftResult & { quorum: Cg4QuorumEvaluation; activateAt: string };
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const replay = await this.receipt<Result>(
        transaction,
        input.tenantId,
        'CG4_POLICY_APPROVE',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;

      const { row, compiled, head } = await this.loadCandidate(transaction, input);
      await this.lockScope(transaction, input.tenantId, row.scopeKey);
      if (row.status !== 'IN_REVIEW') {
        throw new Cg4PolicyLifecycleError(
          'INVALID_LIFECYCLE_TRANSITION',
          `finalize approval จากสถานะ ${row.status} ไม่ได้`,
        );
      }
      if (
        head.headVersion !== input.expectedScopeHeadVersion ||
        head.headDigest !== input.expectedScopeHeadDigest
      ) {
        throw new Cg4PolicyLifecycleError(
          'POLICY_HEAD_CONFLICT',
          `head เปลี่ยนเป็น version ${head.headVersion} ตั้งแต่ตอนขอ approval`,
        );
      }
      await this.assertFreshTests(transaction, {
        tenantId: input.tenantId,
        policyId: input.policyId,
        version: input.version,
        contentDigest: compiled.contentDigest,
        artifactDigest: input.expectedTestArtifactDigest,
        head,
      });
      if (row.diffClass !== input.expectedDiffClass) {
        throw new Cg4PolicyLifecycleError(
          'APPROVAL_STALE',
          `diff class ปัจจุบันคือ ${row.diffClass} ไม่ใช่ ${input.expectedDiffClass}`,
        );
      }

      const approvalRows = await transaction.cg4PolicyApproval.findMany({
        where: {
          tenantId: input.tenantId,
          policyId: input.policyId,
          policyVersion: input.version,
        },
        orderBy: { decidedAt: 'asc' },
      });
      const quorum = evaluateCg4Quorum(
        resolveCg4PolicyQuorum(input.expectedDiffClass),
        approvalRows.filter((approval) => approval.decision === 'APPROVED').map(toRecordedApproval),
        approvalRows.some((approval) => approval.decision === 'REJECTED'),
        this.now(),
      );
      if (quorum.status === 'REJECTED') {
        const rejected = await transaction.cg4Policy.updateMany({
          where: { tenantId: input.tenantId, id: row.id, status: 'IN_REVIEW' },
          data: { status: 'REJECTED' },
        });
        if (rejected.count !== 1) throw new Cg3VersionConflictError(input.version, row.version);
        const mutationId = this.id();
        const rejectedResult: Result = {
          mutationId,
          policyId: input.policyId,
          policyVersionId: row.id,
          version: input.version,
          draftRevision: row.draftRevision,
          scopeKey: row.scopeKey,
          contentDigest: compiled.contentDigest,
          lifecycleState: 'REJECTED',
          quorum,
          activateAt: activateAt.toISOString(),
        };
        await this.audit(transaction, {
          tenantId: input.tenantId,
          mutationId,
          aggregateId: input.policyId,
          aggregateVersion: input.version,
          action: 'CG4_POLICY_REJECT',
          actorRef: input.actor.subjectId,
          evidenceRef: input.evidenceRef,
          afterDigest: compiled.contentDigest,
          occurredAt,
        });
        await this.writeReceipt(transaction, {
          tenantId: input.tenantId,
          operation: 'CG4_POLICY_APPROVE',
          idempotencyKey: input.idempotencyKey,
          requestHash,
          expectedVersion: input.version,
          aggregateVersion: input.version,
          body: rejectedResult,
        });
        return rejectedResult;
      }
      assertCg4QuorumMet(quorum);

      // Binds the exact votes that carried this candidate; publish re-derives it and
      // refuses if a vote was added or removed in between.
      const approvalDigest = stableDigest({
        policyId: input.policyId,
        version: input.version,
        contentDigest: compiled.contentDigest,
        testArtifactDigest: input.expectedTestArtifactDigest,
        diffClass: input.expectedDiffClass,
        headVersion: head.headVersion,
        headDigest: head.headDigest,
        activateAt: activateAt.toISOString(),
        approvals: approvalRows.map((approval) => ({
          approverRef: approval.approverRef,
          decision: approval.decision,
          capability: approval.capability,
          authorizationEpoch: approval.authorizationEpoch,
          scopeVersion: approval.scopeVersion,
          decidedAt: approval.decidedAt.toISOString(),
        })),
      });

      const approved = await transaction.cg4Policy.updateMany({
        where: { tenantId: input.tenantId, id: row.id, status: 'IN_REVIEW' },
        data: { status: 'APPROVED', approvedAt: occurredAt, approvalDigest, activateAt },
      });
      if (approved.count !== 1) throw new Cg3VersionConflictError(input.version, row.version);

      const mutationId = this.id();
      const result: Result = {
        mutationId,
        policyId: input.policyId,
        policyVersionId: row.id,
        version: input.version,
        draftRevision: row.draftRevision,
        scopeKey: row.scopeKey,
        contentDigest: compiled.contentDigest,
        lifecycleState: 'APPROVED',
        quorum,
        activateAt: activateAt.toISOString(),
      };
      await this.audit(transaction, {
        tenantId: input.tenantId,
        mutationId,
        aggregateId: input.policyId,
        aggregateVersion: input.version,
        action: 'CG4_POLICY_APPROVE',
        actorRef: input.actor.subjectId,
        evidenceRef: input.evidenceRef,
        afterDigest: approvalDigest,
        occurredAt,
      });
      await this.writeReceipt(transaction, {
        tenantId: input.tenantId,
        operation: 'CG4_POLICY_APPROVE',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: input.version,
        aggregateVersion: input.version,
        body: result,
      });
      return result;
    });
  }

  // ── Publish / activation ───────────────────────────────────────────────────

  /**
   * Immediate publish when the approved `activateAt` has arrived, otherwise it registers
   * the durable activation job. Both run the same validation, and both move the head under
   * the scope advisory lock inside one transaction (#176 §3/§4).
   */
  async publish(input: PublishCg4PolicyInput): Promise<Cg4PolicyPublishResult> {
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyId: input.policyId,
      version: input.version,
      expectedContentDigest: input.expectedContentDigest,
      expectedTestArtifactDigest: input.expectedTestArtifactDigest,
      expectedApprovalDigest: input.expectedApprovalDigest,
      expectedScopeHeadVersion: input.expectedScopeHeadVersion,
      expectedScopeHeadDigest: input.expectedScopeHeadDigest,
      actorSubjectId: input.actor.subjectId,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const replay = await this.receipt<Cg4PolicyPublishResult>(
        transaction,
        input.tenantId,
        'CG4_POLICY_PUBLISH',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;

      const { row, compiled, head } = await this.loadCandidate(transaction, input);
      await this.lockScope(transaction, input.tenantId, row.scopeKey);
      if (row.status !== 'APPROVED') {
        throw new Cg4PolicyLifecycleError(
          'INVALID_LIFECYCLE_TRANSITION',
          `publish จากสถานะ ${row.status} ไม่ได้`,
        );
      }
      if (row.approvalDigest !== input.expectedApprovalDigest) {
        throw new Cg4PolicyLifecycleError(
          'APPROVAL_STALE',
          'approval digest ไม่ตรงกับที่บันทึกไว้',
        );
      }
      if (
        head.headVersion !== input.expectedScopeHeadVersion ||
        head.headDigest !== input.expectedScopeHeadDigest ||
        row.baseHeadVersion !== head.headVersion ||
        row.baseHeadDigest !== head.headDigest
      ) {
        throw new Cg4PolicyLifecycleError(
          'POLICY_HEAD_CONFLICT',
          `head อยู่ที่ version ${head.headVersion} ไม่ตรงกับ base ที่ approve ไว้`,
        );
      }
      await this.assertFreshTests(transaction, {
        tenantId: input.tenantId,
        policyId: input.policyId,
        version: input.version,
        contentDigest: compiled.contentDigest,
        artifactDigest: input.expectedTestArtifactDigest,
        head,
      });
      await this.assertScopeUnambiguous(transaction, input.tenantId, row.scopeKey);

      const diffClass = (row.diffClass ?? 'RELAXATION') as Cg4PolicyDiffClass;
      // #176 §6: a kill switch outranks policy and only ever tightens, so it must not be
      // undone by publishing something looser underneath it.
      if (
        diffClass === 'RELAXATION' &&
        (await this.killSwitchActive(transaction, input.tenantId, row.scopeKey))
      ) {
        throw new Cg4PolicyLifecycleError(
          'GOVERNANCE_KILL_SWITCH_ACTIVE',
          'scope นี้มี kill switch ทำงานอยู่ publish relaxation ไม่ได้',
        );
      }

      const approvalRows = await transaction.cg4PolicyApproval.findMany({
        where: {
          tenantId: input.tenantId,
          policyId: input.policyId,
          policyVersion: input.version,
        },
        orderBy: { decidedAt: 'asc' },
      });
      const quorum = evaluateCg4Quorum(
        resolveCg4PolicyQuorum(diffClass),
        approvalRows.filter((approval) => approval.decision === 'APPROVED').map(toRecordedApproval),
        approvalRows.some((approval) => approval.decision === 'REJECTED'),
        this.now(),
      );
      assertCg4QuorumMet(quorum);

      const activateAt = row.activateAt ?? occurredAt;
      const scheduled = activateAt.getTime() > occurredAt.getTime();
      const mutationId = this.id();
      const eventId = this.id();

      if (scheduled) {
        const open = await transaction.cg4PolicyActivationJob.findFirst({
          where: {
            tenantId: input.tenantId,
            scopeKey: row.scopeKey,
            state: { in: ['PENDING', 'CLAIMED'] },
          },
        });
        if (open) {
          throw new Cg4PolicyLifecycleError(
            'SCHEDULE_CONFLICT',
            `scope นี้มี scheduled activation ของ version ${open.policyVersion} ค้างอยู่`,
          );
        }
        await transaction.cg4Policy.updateMany({
          where: { tenantId: input.tenantId, id: row.id, status: 'APPROVED' },
          data: { status: 'SCHEDULED' },
        });
        await transaction.cg4PolicyActivationJob.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            policyId: input.policyId,
            policyVersion: input.version,
            scopeKey: row.scopeKey,
            scheduledFor: activateAt,
            state: 'PENDING',
          },
        });
      }

      const result = await this.moveHead(transaction, {
        tenantId: input.tenantId,
        mutationId,
        eventId,
        scopeKey: row.scopeKey,
        head,
        candidate: {
          rowId: row.id,
          policyId: input.policyId,
          version: input.version,
          contentDigest: compiled.contentDigest,
        },
        activateAt,
        occurredAt,
        actorRef: input.actor.subjectId,
        evidenceRef: input.evidenceRef,
        diffClass,
        transitionKind: scheduled ? 'POLICY_CHANGED' : 'POLICY_ACTIVATED',
        action: scheduled ? 'CG4_POLICY_SCHEDULE' : 'CG4_POLICY_PUBLISH',
        activate: !scheduled,
        quorum,
      });

      await this.writeReceipt(transaction, {
        tenantId: input.tenantId,
        operation: 'CG4_POLICY_PUBLISH',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: input.expectedScopeHeadVersion,
        aggregateVersion: result.headVersion,
        body: result,
      });
      return result;
    });
  }

  /**
   * The scheduled-activation worker path. It runs the same head swap as an immediate
   * publish, under the same lock, so a duplicate or retried activation is a no-op that
   * returns the head as it already stands rather than a second swap.
   */
  async activateDue(input: ActivateDueCg4PolicyInput): Promise<Cg4PolicyPublishResult> {
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    nonEmpty(input.leaseOwner, 'leaseOwner');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyId: input.policyId,
      version: input.version,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const replay = await this.receipt<Cg4PolicyPublishResult>(
        transaction,
        input.tenantId,
        'CG4_POLICY_ACTIVATE',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;

      const row = await transaction.cg4Policy.findFirst({
        where: { tenantId: input.tenantId, policyId: input.policyId, version: input.version },
      });
      if (!row) throw new Cg3ResourceNotFoundError();
      await this.lockScope(transaction, input.tenantId, row.scopeKey);
      if (row.status !== 'SCHEDULED') {
        throw new Cg4PolicyLifecycleError(
          'INVALID_LIFECYCLE_TRANSITION',
          `activate จากสถานะ ${row.status} ไม่ได้`,
        );
      }
      const job = await transaction.cg4PolicyActivationJob.findFirst({
        where: {
          tenantId: input.tenantId,
          policyId: input.policyId,
          policyVersion: input.version,
        },
      });
      if (!job) throw new Cg3ResourceNotFoundError();
      if (job.state !== 'PENDING' && job.state !== 'CLAIMED') {
        throw new Cg4PolicyLifecycleError(
          'POLICY_ACTIVATION_CONFLICT',
          `activation job อยู่ในสถานะ ${job.state}`,
        );
      }
      if (job.scheduledFor.getTime() > occurredAt.getTime()) {
        throw new Cg4PolicyLifecycleError(
          'POLICY_ACTIVATION_CONFLICT',
          `ยังไม่ถึงเวลา activate (${job.scheduledFor.toISOString()})`,
        );
      }

      const compiled = compileCg4Policy({
        content: row.content,
        version: row.version,
        schemaVersion: row.schemaVersion,
        registryVersion: row.registryVersion,
        evaluatorVersion: row.evaluatorVersion,
      });
      if (compiled.contentDigest !== row.contentDigest) {
        throw new Cg4PolicyValidationError(
          'VALIDATION_FAILED',
          'content digest ที่เก็บไว้ไม่ตรงกับ compiler ปัจจุบัน',
        );
      }
      const head = await this.loadHead(transaction, input.tenantId, row.scopeKey);
      await this.assertScopeUnambiguous(transaction, input.tenantId, row.scopeKey);

      const diffClass = (row.diffClass ?? 'RELAXATION') as Cg4PolicyDiffClass;
      const approvalRows = await transaction.cg4PolicyApproval.findMany({
        where: {
          tenantId: input.tenantId,
          policyId: input.policyId,
          policyVersion: input.version,
        },
        orderBy: { decidedAt: 'asc' },
      });
      const quorum = evaluateCg4Quorum(
        resolveCg4PolicyQuorum(diffClass),
        approvalRows.filter((approval) => approval.decision === 'APPROVED').map(toRecordedApproval),
        approvalRows.some((approval) => approval.decision === 'REJECTED'),
        this.now(),
      );
      assertCg4QuorumMet(quorum);

      await transaction.cg4PolicyActivationJob.updateMany({
        where: { tenantId: input.tenantId, id: job.id, state: job.state },
        data: {
          state: 'COMPLETE',
          attempts: job.attempts + 1,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: null,
          completedAt: occurredAt,
        },
      });

      const mutationId = this.id();
      const result = await this.moveHead(transaction, {
        tenantId: input.tenantId,
        mutationId,
        eventId: this.id(),
        scopeKey: row.scopeKey,
        head,
        candidate: {
          rowId: row.id,
          policyId: input.policyId,
          version: input.version,
          contentDigest: compiled.contentDigest,
        },
        activateAt: job.scheduledFor,
        occurredAt,
        actorRef: input.leaseOwner,
        evidenceRef: `activation-job:${job.id}`,
        diffClass,
        transitionKind: 'POLICY_ACTIVATED',
        action: 'CG4_POLICY_ACTIVATE',
        activate: true,
        quorum,
      });
      await this.writeReceipt(transaction, {
        tenantId: input.tenantId,
        operation: 'CG4_POLICY_ACTIVATE',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: head.headVersion,
        aggregateVersion: result.headVersion,
        body: result,
      });
      return result;
    });
  }

  /**
   * The single head-swap step shared by immediate publish, scheduling and scheduled
   * activation. `activate` false only records the pending activation on the head — the
   * active version does not move until the schedule fires.
   */
  private async moveHead(
    transaction: Transaction,
    input: {
      tenantId: string;
      mutationId: string;
      eventId: string;
      scopeKey: string;
      head: HeadSnapshot;
      candidate: { rowId: string; policyId: string; version: number; contentDigest: string };
      activateAt: Date;
      occurredAt: Date;
      actorRef: string;
      evidenceRef: string;
      diffClass: Cg4PolicyDiffClass;
      transitionKind: Cg4TransitionKind;
      action: string;
      activate: boolean;
      quorum: Cg4QuorumEvaluation;
    },
  ): Promise<Cg4PolicyPublishResult> {
    const headVersion = input.head.headVersion + 1;

    if (input.activate) {
      if (input.head.policyRevisionId) {
        const superseded = await transaction.cg4Policy.updateMany({
          where: { tenantId: input.tenantId, id: input.head.policyRevisionId, status: 'ACTIVE' },
          data: { status: 'SUPERSEDED', effectiveTo: input.activateAt },
        });
        if (superseded.count !== 1) {
          throw new Cg4PolicyLifecycleError(
            'POLICY_HEAD_CONFLICT',
            'active version เดิมถูกเปลี่ยนไปแล้วระหว่าง publish',
          );
        }
      }
      const activated = await transaction.cg4Policy.updateMany({
        where: {
          tenantId: input.tenantId,
          id: input.candidate.rowId,
          status: { in: ['APPROVED', 'SCHEDULED'] },
        },
        data: {
          status: 'ACTIVE',
          publishedAt: input.occurredAt,
          ...(input.head.policyRevisionId ? { supersedesId: input.head.policyRevisionId } : {}),
        },
      });
      if (activated.count !== 1) {
        throw new Cg3VersionConflictError(input.candidate.version, input.candidate.version);
      }
      // An immediate publish overtakes any schedule still open on this scope.
      await transaction.cg4PolicyActivationJob.updateMany({
        where: {
          tenantId: input.tenantId,
          scopeKey: input.scopeKey,
          state: { in: ['PENDING', 'CLAIMED'] },
          policyVersion: { not: input.candidate.version },
        },
        data: { state: 'CANCELLED', completedAt: input.occurredAt },
      });
    }

    const headPolicyId = input.activate ? input.candidate.policyId : input.head.policyId;
    const headPolicyVersion = input.activate ? input.candidate.version : input.head.policyVersion;
    const headRevisionId = input.activate ? input.candidate.rowId : input.head.policyRevisionId;
    const headDigest = input.activate
      ? cg4PolicyHeadDigest({
          policyId: input.candidate.policyId,
          version: input.candidate.version,
          contentDigest: input.candidate.contentDigest,
        })
      : input.head.headDigest;
    const nextActivationAt = input.activate ? null : input.activateAt;

    // Scheduling the very first version of a scope has no head row to annotate. The
    // schedule is durable in the activation job either way, and the head appears when it
    // activates — so the swap below is skipped rather than refused.
    if (headPolicyId === null || headPolicyVersion === null || headRevisionId === null) {
      await this.emitHeadChange(transaction, {
        ...input,
        headVersion: input.head.headVersion,
        headDigest: input.head.headDigest,
        nextActivationAt,
      });
      return {
        mutationId: input.mutationId,
        eventId: input.eventId,
        policyId: input.candidate.policyId,
        policyVersionId: input.candidate.rowId,
        version: input.candidate.version,
        lifecycleState: 'SCHEDULED',
        scopeKey: input.scopeKey,
        headVersion: input.head.headVersion,
        headDigest: input.head.headDigest,
        activateAt: input.activateAt.toISOString(),
        quorum: input.quorum,
      };
    }

    if (input.head.headVersion === 0) {
      await transaction.cg4PolicyScopeHead.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          scopeKey: input.scopeKey,
          headPolicyId,
          headPolicyVersion,
          headPolicyRevisionId: headRevisionId,
          headVersion,
          headDigest,
          latestMutationId: input.mutationId,
          nextActivationAt,
        },
      });
    } else {
      const updated = await transaction.cg4PolicyScopeHead.updateMany({
        where: {
          tenantId: input.tenantId,
          scopeKey: input.scopeKey,
          headVersion: input.head.headVersion,
        },
        data: {
          headPolicyId,
          headPolicyVersion,
          headPolicyRevisionId: headRevisionId,
          headVersion,
          headDigest,
          latestMutationId: input.mutationId,
          nextActivationAt,
        },
      });
      if (updated.count !== 1) {
        throw new Cg4PolicyLifecycleError(
          'POLICY_HEAD_CONFLICT',
          `head ถูกเปลี่ยนไปแล้วระหว่าง publish (คาด version ${input.head.headVersion})`,
        );
      }
    }

    await this.emitHeadChange(transaction, { ...input, headVersion, headDigest, nextActivationAt });

    return {
      mutationId: input.mutationId,
      eventId: input.eventId,
      policyId: input.candidate.policyId,
      policyVersionId: input.candidate.rowId,
      version: input.candidate.version,
      lifecycleState: input.activate ? 'ACTIVE' : 'SCHEDULED',
      scopeKey: input.scopeKey,
      headVersion,
      headDigest,
      activateAt: input.activateAt.toISOString(),
      quorum: input.quorum,
    };
  }

  /** Canonical `policy.changed` outbox record plus its audit entry, after the head moved. */
  private async emitHeadChange(
    transaction: Transaction,
    input: {
      tenantId: string;
      mutationId: string;
      eventId: string;
      scopeKey: string;
      head: HeadSnapshot;
      candidate: { rowId: string; policyId: string; version: number; contentDigest: string };
      activateAt: Date;
      occurredAt: Date;
      actorRef: string;
      evidenceRef: string;
      diffClass: Cg4PolicyDiffClass;
      transitionKind: Cg4TransitionKind;
      action: string;
      activate: boolean;
      headVersion: number;
      headDigest: string;
      nextActivationAt: Date | null;
    },
  ): Promise<void> {
    const payload = {
      contractVersion: 1,
      mutationId: input.mutationId,
      transitionKind: input.transitionKind,
      subjectId: input.candidate.policyId,
      subjectVersion: input.candidate.version,
      state: input.activate ? 'ACTIVE' : 'SCHEDULED',
      effectiveAt: input.activateAt.toISOString(),
      affectedScope: { scopeKey: input.scopeKey, ...cg4EventScopeDimensions(input.scopeKey) },
      scopeDigest: stableDigest({ scopeKey: input.scopeKey }),
      policyVersion: input.candidate.version,
      policyContentDigest: input.candidate.contentDigest,
      ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
      policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
      evaluatorVersion: CG4_EVALUATOR_VERSION,
      stateDigest: input.headDigest,
      restrictiveness: input.diffClass,
      ...(input.nextActivationAt ? { nextActivationAt: input.nextActivationAt.toISOString() } : {}),
    };
    await transaction.cgEventOutbox.create({
      data: {
        id: input.eventId,
        mutationId: input.mutationId,
        tenantId: input.tenantId,
        aggregateType: 'POLICY',
        aggregateId: input.candidate.policyId,
        aggregateVersion: input.headVersion,
        eventType: CG4_EVENT_TYPES.POLICY_CHANGED,
        orderingKey: `${input.tenantId}:${input.scopeKey}`,
        payload: json(payload),
        payloadHash: stableDigest(payload),
      },
    });
    await this.audit(transaction, {
      tenantId: input.tenantId,
      mutationId: input.mutationId,
      aggregateId: input.candidate.policyId,
      aggregateVersion: input.headVersion,
      action: input.action,
      actorRef: input.actorRef,
      evidenceRef: input.evidenceRef,
      beforeDigest: input.head.headDigest,
      afterDigest: input.headDigest,
      occurredAt: input.occurredAt,
    });
  }

  // ── Rollback ───────────────────────────────────────────────────────────────

  /**
   * #176 §6: rollback never reactivates an old row. It clones the target version's
   * canonical content into a new monotonic version that must earn its own preview, tests
   * and quorum — a rollback whose diff against the *current* active version is a net
   * relaxation needs two checkers, exactly like any other relaxation.
   */
  async rollback(input: RollbackCg4PolicyInput): Promise<Cg4PolicyDraftResult> {
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    nonEmpty(input.reasonCode, 'reasonCode');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyId: input.policyId,
      sourceVersion: input.sourceVersion,
      expectedSourceContentDigest: input.expectedSourceContentDigest,
      reasonCode: input.reasonCode,
      actorSubjectId: input.actor.subjectId,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const replay = await this.receipt<Cg4PolicyDraftResult>(
        transaction,
        input.tenantId,
        'CG4_POLICY_ROLLBACK',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;

      const source = await transaction.cg4Policy.findFirst({
        where: {
          tenantId: input.tenantId,
          policyId: input.policyId,
          version: input.sourceVersion,
        },
      });
      if (!source) throw new Cg3ResourceNotFoundError();
      if (source.contentDigest !== input.expectedSourceContentDigest) {
        throw new Cg3VersionConflictError(input.sourceVersion, source.version);
      }
      await this.lockScope(transaction, input.tenantId, source.scopeKey);
      assertCg4RequestAuthorization({
        subject: input.actor,
        capability: 'cg.policy.rollback',
        scopeKey: source.scopeKey,
        now: this.now(),
      });

      const compiled = compileCg4Policy({
        content: source.content,
        version: source.version,
        schemaVersion: source.schemaVersion,
        registryVersion: source.registryVersion,
        evaluatorVersion: source.evaluatorVersion,
      });
      const latest = await transaction.cg4Policy.findMany({
        where: { tenantId: input.tenantId, policyId: input.policyId },
        orderBy: { version: 'desc' },
        take: 1,
      });
      const version = (latest[0]?.version ?? source.version) + 1;

      const row = await transaction.cg4Policy.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          policyId: input.policyId,
          version,
          scopeKey: source.scopeKey,
          content: json(compiled.content),
          contentDigest: compiled.contentDigest,
          registryVersion: CG4_RULE_REGISTRY_VERSION,
          schemaVersion: CG4_POLICY_SCHEMA_VERSION,
          evaluatorVersion: CG4_EVALUATOR_VERSION,
          draftRevision: 1,
          status: 'DRAFT',
          effectiveFrom: occurredAt,
          makerActorRef: input.actor.subjectId,
          rollbackOfId: source.id,
        },
      });

      const mutationId = this.id();
      const result: Cg4PolicyDraftResult = {
        mutationId,
        policyId: input.policyId,
        policyVersionId: row.id,
        version,
        draftRevision: 1,
        scopeKey: source.scopeKey,
        contentDigest: compiled.contentDigest,
        lifecycleState: 'DRAFT',
      };
      await this.audit(transaction, {
        tenantId: input.tenantId,
        mutationId,
        aggregateId: input.policyId,
        aggregateVersion: version,
        action: 'CG4_POLICY_ROLLBACK',
        actorRef: input.actor.subjectId,
        evidenceRef: input.evidenceRef,
        beforeDigest: source.contentDigest,
        afterDigest: compiled.contentDigest,
        occurredAt,
      });
      await this.writeReceipt(transaction, {
        tenantId: input.tenantId,
        operation: 'CG4_POLICY_ROLLBACK',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: input.sourceVersion,
        aggregateVersion: version,
        body: result,
      });
      return result;
    });
  }

  // ── Kill switch ────────────────────────────────────────────────────────────

  /**
   * #176 §6: activation is immediate and tightening-only, so it needs no quorum — it can
   * only ever stop traffic. Clearing is the dangerous direction and therefore requires an
   * independent publish-grade approval reference; it is never automatic.
   */
  async killSwitch(input: Cg4KillSwitchInput): Promise<Cg4KillSwitchResult> {
    nonEmpty(input.scopeKey, 'scopeKey');
    nonEmpty(input.reasonCode, 'reasonCode');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const requestHash = stableDigest({
      tenantId: input.tenantId,
      scopeKey: input.scopeKey,
      action: input.action,
      reasonCode: input.reasonCode,
      clearApprovalRef: input.clearApprovalRef ?? null,
      actorSubjectId: input.actor.subjectId,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const replay = await this.receipt<Cg4KillSwitchResult>(
        transaction,
        input.tenantId,
        'CG4_KILL_SWITCH',
        input.idempotencyKey,
        requestHash,
      );
      if (replay) return replay;

      await this.lockScope(transaction, input.tenantId, input.scopeKey);
      assertCg4RequestAuthorization({
        subject: input.actor,
        // Clearing restores traffic, so it takes the relaxation-grade capability.
        capability:
          input.action === 'ACTIVATE' ? 'cg.policy.publish' : 'cg.policy.publish.relaxation',
        scopeKey: input.scopeKey,
        now: this.now(),
      });

      const existing = await transaction.cg4ScopeKillSwitch.findFirst({
        where: { tenantId: input.tenantId, scopeKey: input.scopeKey, state: 'ACTIVE' },
        orderBy: { activatedAt: 'desc' },
      });

      let killSwitchId: string;
      // CG4.8 (#191): เปิดซ้ำขณะที่ยัง ACTIVE ไม่เปลี่ยน canonical state จึงไม่ออก event ใหม่ —
      // event ซ้ำที่ version เดิมแต่ mutationId ต่างจะเป็น hash conflict ที่ทุก consumer
      let alreadyActive = false;
      if (input.action === 'ACTIVATE') {
        if (existing) {
          killSwitchId = existing.id;
          alreadyActive = true;
        } else {
          const created = await transaction.cg4ScopeKillSwitch.create({
            data: {
              id: this.id(),
              tenantId: input.tenantId,
              scopeKey: input.scopeKey,
              state: 'ACTIVE',
              reasonCode: input.reasonCode,
              evidenceRef: input.evidenceRef,
              activatedByRef: input.actor.subjectId,
              activatedAt: occurredAt,
            },
          });
          killSwitchId = created.id;
        }
      } else {
        if (!existing) throw new Cg3ResourceNotFoundError();
        if (!input.clearApprovalRef?.trim()) {
          throw new Cg4PolicyLifecycleError(
            'APPROVAL_REQUIRED',
            'clear kill switch ต้องมี independent publish-grade approval',
          );
        }
        if (existing.activatedByRef === input.actor.subjectId) {
          throw new Cg4PolicyLifecycleError(
            'APPROVAL_REQUIRED',
            'ผู้ที่เปิด kill switch เคลียร์เองไม่ได้ ต้องเป็นคนละ subject',
          );
        }
        const cleared = await transaction.cg4ScopeKillSwitch.updateMany({
          where: { tenantId: input.tenantId, id: existing.id, state: 'ACTIVE' },
          data: {
            state: 'CLEARED',
            clearApprovalRef: input.clearApprovalRef.trim(),
            clearedAt: occurredAt,
          },
        });
        if (cleared.count !== 1) throw new Cg3VersionConflictError(1, 0);
        killSwitchId = existing.id;
      }

      const state = input.action === 'ACTIVATE' ? ('ACTIVE' as const) : ('CLEARED' as const);
      const mutationId = this.id();
      const eventId = this.id();
      const {
        version: killSwitchVersion,
        stateDigest,
        outbox,
      } = cg4KillSwitchEvent({
        tenantId: input.tenantId,
        scopeKey: input.scopeKey,
        killSwitchId,
        state,
        mutationId,
        eventId,
        occurredAt,
      });
      if (!alreadyActive) {
        await transaction.cgEventOutbox.create({ data: outbox });
      }
      await this.audit(transaction, {
        tenantId: input.tenantId,
        mutationId,
        aggregateId: killSwitchId,
        aggregateVersion: killSwitchVersion,
        action: `CG4_KILL_SWITCH_${input.action}`,
        actorRef: input.actor.subjectId,
        evidenceRef: input.clearApprovalRef ?? input.evidenceRef,
        afterDigest: stateDigest,
        occurredAt,
      });

      const result: Cg4KillSwitchResult = {
        mutationId,
        eventId,
        killSwitchId,
        scopeKey: input.scopeKey,
        state,
      };
      await this.writeReceipt(transaction, {
        tenantId: input.tenantId,
        operation: 'CG4_KILL_SWITCH',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        expectedVersion: 1,
        aggregateVersion: killSwitchVersion,
        body: result,
      });
      return result;
    });
  }
}
