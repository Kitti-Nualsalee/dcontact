/**
 * Owner: Platform control plane — durable intent of tenant provisioning (A1.1 #406)
 *
 * Authority: #389 (lifecycle/identity/reservation), #390 (durable-intent-first, ledger, idempotency),
 * #393 §5 (append-only Action history), decision on #406
 *
 * Connects to the database with role `dcontact_platform` only — this role has no privilege on tenant business tables
 * The core rules live in the database (unique/composite FK/trigger) so a race is decided in one place, while the repository
 * converts outcomes into stable error codes and does not reveal that another tenant/request's resource really exists
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  IDENTITY_TOMBSTONE_DAYS,
  PROVISIONING_SAGA_LIMITS,
  PROVISIONING_STEP_KEYS,
  PlatformProvisioningError,
  isAllowedProvisioningTransition,
  type IdentityReservationKind,
  type PlatformActionKind,
  type PlatformActorKind,
  type PlatformProvisioningErrorCode,
  type ProvisioningRequestInput,
  type ProvisioningRequestStatus,
  type ProvisioningStepKey,
} from '@d-contact/shared';
import { currentTraceparent } from './platform-tracing.js';
import type { TenantConsoleContext } from './tenant-console-context.js';
import { appendPlatformAction, type PlatformActionEntry } from './action-history.js';
import {
  canonicalizeProvisioningRequest,
  deriveTenantSipDomain,
  platformIdentityHash,
  provisioningPayloadDigest,
} from './provisioning-input.js';

export interface PlatformActor {
  kind: PlatformActorKind;
  /** subject of the platform identity (not an email) */
  subject: string;
  role?: string;
  sessionRef?: string;
}

export interface AcceptProvisioningCommand {
  idempotencyKey: string;
  input: ProvisioningRequestInput;
  /** the plan the caller resolved and pinned from the plan catalog (#392) — a retry always uses the same value */
  plan: { version: number; snapshotDigest: string };
  actor: PlatformActor;
  correlationId: string;
}

export interface ProvisioningRequestRef {
  outcome: 'ACCEPTED' | 'REPLAYED';
  requestId: string;
  tenantId: string;
  status: ProvisioningRequestStatus;
  revision: number;
}

/** the shape the control plane can read — no raw email of the first admin (only a hash) */
export interface ProvisioningRequestView {
  requestId: string;
  tenantId: string;
  status: ProvisioningRequestStatus;
  revision: number;
  displayName: string;
  slug: string;
  primaryDomain: string;
  sipDomain: string;
  planCode: string;
  planVersion: number;
  bootstrapTemplateVersion: string;
  firstAdminEmailHash: string;
  failureCode: string | null;
  acceptedAt: Date;
  deadlineAt: Date;
  terminalAt: Date | null;
  steps: Array<{ stepKey: ProvisioningStepKey; state: string; attempt: number }>;
}

export interface ActionHistoryEntry {
  id: string;
  action: PlatformActionKind;
  actorKind: PlatformActorKind;
  actorSubject: string;
  reasonCode: string | null;
  beforeState: string | null;
  afterState: string | null;
  outcome: string;
  errorCode: string | null;
  stepKey: ProvisioningStepKey | null;
  attempt: number | null;
  correlationId: string;
  occurredAt: Date;
}

export interface ProvisioningRepositoryOptions {
  /** SIP base domain (decision on #406): sipDomain = `<slug>.<base>` */
  sipBaseDomain: string;
  /**
   * #901: issuer/client of the tenant Console — set when this repository closes provisioning work (the saga worker)
   * and then `complete` records the first admin's binding in the same transaction as ACTIVE
   */
  tenantConsole?: TenantConsoleContext;
  now?: () => Date;
  id?: () => string;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CREATE_COMMAND = 'CREATE_PROVISIONING_REQUEST';
const HEX64 = /^[0-9a-f]{64}$/;

/** placeholder of a tenant still PROVISIONING — `~` means it cannot clash with a real slug (see migration) */
export function provisioningPlaceholder(tenantId: string) {
  return { slug: `~pv-${tenantId}`, sipDomain: `~pv-${tenantId}.invalid` };
}

/**
 * reservation of one value: takes over a row whose tombstone has expired (against the DB clock) or creates a new one
 * a row still HELD/CONSUMED/with an unexpired tombstone = PK clash → CONFLICT; the row lock gives a single winner
 * (shared between accept and the first-admin email edit of A1.5b)
 */
export async function reserveIdentity(
  transaction: Prisma.TransactionClient,
  input: { kind: IdentityReservationKind; valueKey: string; tenantId: string; requestId: string },
): Promise<'RESERVED' | 'CONFLICT'> {
  const takenOver = await transaction.$executeRaw`
    UPDATE "pf_identity_reservations"
       SET "tenant_id" = ${input.tenantId}::uuid,
           "request_id" = ${input.requestId}::uuid,
           "state" = 'HELD',
           "tombstoned_until" = NULL,
           "revision" = "revision" + 1,
           "updated_at" = now()
     WHERE "kind" = ${input.kind}::"PfReservationKind"
       AND "value_key" = ${input.valueKey}
       AND "state" = 'TOMBSTONED'
       AND "tombstoned_until" <= now()`;
  if (takenOver === 1) return 'RESERVED';
  // SAVEPOINT: a unique violation must not leave the caller's transaction unusable
  await transaction.$executeRawUnsafe('SAVEPOINT reserve_identity');
  try {
    await transaction.pfIdentityReservation.create({ data: input });
    await transaction.$executeRawUnsafe('RELEASE SAVEPOINT reserve_identity');
    return 'RESERVED';
  } catch (error) {
    if (isUniqueViolation(error)) {
      await transaction.$executeRawUnsafe('ROLLBACK TO SAVEPOINT reserve_identity');
      return 'CONFLICT';
    }
    throw error;
  }
}

class ConflictSignal extends Error {
  constructor(readonly code: PlatformProvisioningErrorCode) {
    super(code);
  }
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const isForeignKeyViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';

export class ProvisioningControlRepository {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly options: ProvisioningRepositoryOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  // ── Accept (durable intent, #390 step 1) ──────────────────────────────────

  /**
   * a single transaction creates Tenant(PROVISIONING) + request + step ledger + reservations + receipt +
   * Action history and returns the immutable `requestId/tenantId`; the same key/payload returns the same result (REPLAYED)
   */
  async accept(command: AcceptProvisioningCommand): Promise<ProvisioningRequestRef> {
    if (!IDEMPOTENCY_KEY.test(command.idempotencyKey)) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', { idempotencyKey: 'INVALID' });
    }
    if (
      !Number.isInteger(command.plan.version) ||
      command.plan.version < 1 ||
      !HEX64.test(command.plan.snapshotDigest)
    ) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', { plan: 'INVALID' });
    }
    const canonical = canonicalizeProvisioningRequest(command.input);
    const payloadDigest = provisioningPayloadDigest(canonical);
    const keyHash = platformIdentityHash('idempotency-key', command.idempotencyKey);

    const replay = await this.replay(keyHash, payloadDigest, command);
    if (replay) return replay;

    const sipDomain = deriveTenantSipDomain(canonical.slug, this.options.sipBaseDomain);
    const emailHash = platformIdentityHash('first-admin-email', canonical.firstAdminEmail);
    const tenantId = this.id();
    const requestId = this.id();
    const now = this.now();
    try {
      await this.database.$transaction(async (transaction) => {
        const template = await transaction.pfBootstrapTemplate.findUnique({
          where: { version: canonical.bootstrapTemplateVersion },
        });
        if (!template || template.status !== 'ACTIVE') {
          throw new PlatformProvisioningError('BOOTSTRAP_TEMPLATE_UNAVAILABLE');
        }
        // A1.5: may pin only a plan snapshot that is in the catalog and still ACTIVE (the FK enforces it again in the DB)
        const plan = await transaction.pfPlanVersion.findUnique({
          where: {
            planCode_version: { planCode: canonical.planCode, version: command.plan.version },
          },
        });
        if (
          !plan ||
          plan.status !== 'ACTIVE' ||
          plan.snapshotDigest !== command.plan.snapshotDigest
        ) {
          throw new PlatformProvisioningError('PLAN_UNAVAILABLE');
        }
        // an ACTIVE/legacy tenant holds the real slug/domain in tenants — check first (the unique at activation is the last line)
        const taken = await transaction.tenant.findFirst({
          where: {
            OR: [
              { slug: canonical.slug },
              { sipDomain },
              { primaryDomain: canonical.primaryDomain },
            ],
          },
          select: { slug: true, sipDomain: true },
        });
        if (taken) {
          throw new ConflictSignal(
            taken.slug === canonical.slug || taken.sipDomain === sipDomain
              ? 'TENANT_SLUG_CONFLICT'
              : 'TENANT_DOMAIN_CONFLICT',
          );
        }

        const placeholder = provisioningPlaceholder(tenantId);
        await transaction.tenant.create({
          data: {
            id: tenantId,
            name: canonical.displayName,
            slug: placeholder.slug,
            sipDomain: placeholder.sipDomain,
            lifecycleStatus: 'PROVISIONING',
          },
        });
        await transaction.pfProvisioningRequest.create({
          data: {
            id: requestId,
            tenantId,
            // A1.8b: the worker joins the saga span to the trace of the HTTP request that accepted this request
            traceParent: currentTraceparent(),
            idempotencyKeyHash: keyHash,
            payloadDigest,
            displayName: canonical.displayName,
            slug: canonical.slug,
            primaryDomain: canonical.primaryDomain,
            sipDomain,
            locale: canonical.locale,
            timezone: canonical.timezone,
            planCode: canonical.planCode,
            planVersion: command.plan.version,
            planSnapshotDigest: command.plan.snapshotDigest,
            bootstrapTemplateVersion: template.version,
            bootstrapTemplateDigest: template.contentDigest,
            firstAdminEmail: canonical.firstAdminEmail,
            firstAdminEmailHash: emailHash,
            firstAdminDisplayName: canonical.firstAdminDisplayName,
            requestedBy: command.actor.subject,
            correlationId: command.correlationId,
            acceptedAt: now,
            deadlineAt: new Date(
              now.getTime() + PROVISIONING_SAGA_LIMITS.requestDeadlineMinutes * 60_000,
            ),
          },
        });
        // TENANT_RECORD succeeds within this very transaction; other steps wait for the worker (A1.3)
        await transaction.pfProvisioningStep.createMany({
          data: PROVISIONING_STEP_KEYS.map((stepKey, index) => ({
            requestId,
            tenantId,
            stepKey,
            ordinal: index + 1,
            ...(stepKey === 'TENANT_RECORD'
              ? { state: 'SUCCEEDED' as const, attempt: 1, startedAt: now, finishedAt: now }
              : {}),
          })),
        });
        await transaction.pfProvisioningStepReceipt.create({
          data: {
            id: this.id(),
            requestId,
            tenantId,
            stepKey: 'TENANT_RECORD',
            attempt: 1,
            outcome: 'SUCCEEDED',
            recordedAt: now,
          },
        });
        for (const [kind, valueKey, code] of [
          ['SLUG', canonical.slug, 'TENANT_SLUG_CONFLICT'],
          ['PRIMARY_DOMAIN', canonical.primaryDomain, 'TENANT_DOMAIN_CONFLICT'],
          ['FIRST_ADMIN_EMAIL', emailHash, 'FIRST_ADMIN_EMAIL_CONFLICT'],
        ] as const) {
          await this.reserve(transaction, { kind, valueKey, tenantId, requestId }, code);
        }
        await transaction.pfCommandReceipt.create({
          data: {
            id: this.id(),
            idempotencyKeyHash: keyHash,
            commandKind: CREATE_COMMAND,
            payloadDigest,
            requestId,
            tenantId,
            actorSubject: command.actor.subject,
          },
        });
        await this.appendAction(transaction, {
          tenantId,
          requestId,
          action: 'REQUEST_ACCEPTED',
          actor: command.actor,
          correlationId: command.correlationId,
          idempotencyKeyHash: keyHash,
          afterState: 'PENDING',
          outcome: 'SUCCEEDED',
          at: now,
        });
      });
    } catch (error) {
      // the loser of a race on the same key always hits the unique first — check for a replay before reporting another conflict
      if (error instanceof ConflictSignal || isUniqueViolation(error)) {
        const raced = await this.replay(keyHash, payloadDigest, command);
        if (raced) return raced;
        if (error instanceof ConflictSignal) throw new PlatformProvisioningError(error.code);
        throw new PlatformProvisioningError(uniqueConflictCode(error));
      }
      throw error;
    }
    return { outcome: 'ACCEPTED', requestId, tenantId, status: 'PENDING', revision: 1 };
  }

  private async reserve(
    transaction: Prisma.TransactionClient,
    input: { kind: IdentityReservationKind; valueKey: string; tenantId: string; requestId: string },
    conflict: PlatformProvisioningErrorCode,
  ): Promise<void> {
    if ((await reserveIdentity(transaction, input)) === 'CONFLICT')
      throw new ConflictSignal(conflict);
  }

  private async replay(
    keyHash: string,
    payloadDigest: string,
    command: AcceptProvisioningCommand,
  ): Promise<ProvisioningRequestRef | null> {
    const receipt = await this.database.pfCommandReceipt.findUnique({
      where: { idempotencyKeyHash: keyHash },
      include: { request: { select: { status: true, revision: true } } },
    });
    if (!receipt) return null;
    if (receipt.commandKind !== CREATE_COMMAND || receipt.payloadDigest !== payloadDigest) {
      throw new PlatformProvisioningError('IDEMPOTENCY_KEY_REUSED');
    }
    // a replay creates no state transition again but records that a replay happened (#393 §5)
    await this.appendAction(this.database, {
      tenantId: receipt.tenantId,
      requestId: receipt.requestId,
      action: 'COMMAND_REPLAYED',
      actor: command.actor,
      correlationId: command.correlationId,
      idempotencyKeyHash: keyHash,
      outcome: 'REPLAYED',
      at: this.now(),
    });
    return {
      outcome: 'REPLAYED',
      requestId: receipt.requestId,
      tenantId: receipt.tenantId,
      status: receipt.request.status,
      revision: receipt.request.revision,
    };
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * reads by the authoritative requestId; if a tenantId is given and does not match, returns `null` as if absent —
   * does not reveal that another tenant's request exists (#388 generic 404)
   */
  async findRequest(input: {
    requestId: string;
    tenantId?: string;
  }): Promise<ProvisioningRequestView | null> {
    if (!isUuid(input.requestId) || (input.tenantId !== undefined && !isUuid(input.tenantId))) {
      return null;
    }
    const request = await this.database.pfProvisioningRequest.findFirst({
      where: { id: input.requestId, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
      include: { steps: { orderBy: { ordinal: 'asc' } } },
    });
    if (!request) return null;
    return {
      requestId: request.id,
      tenantId: request.tenantId,
      status: request.status,
      revision: request.revision,
      displayName: request.displayName,
      slug: request.slug,
      primaryDomain: request.primaryDomain,
      sipDomain: request.sipDomain,
      planCode: request.planCode,
      planVersion: request.planVersion,
      bootstrapTemplateVersion: request.bootstrapTemplateVersion,
      firstAdminEmailHash: request.firstAdminEmailHash,
      failureCode: request.failureCode,
      acceptedAt: request.acceptedAt,
      deadlineAt: request.deadlineAt,
      terminalAt: request.terminalAt,
      steps: request.steps.map((step) => ({
        stepKey: step.stepKey,
        state: step.state,
        attempt: step.attempt,
      })),
    };
  }

  /** timeline newest first, with a cursor (occurredAt + id) — a projection of the same ledger the UI uses */
  async listActionHistory(input: {
    tenantId: string;
    cursor?: { occurredAt: Date; id: string };
    limit?: number;
  }): Promise<ActionHistoryEntry[]> {
    if (!isUuid(input.tenantId)) return [];
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = await this.database.pfActionHistory.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.cursor
          ? {
              OR: [
                { occurredAt: { lt: input.cursor.occurredAt } },
                { occurredAt: input.cursor.occurredAt, id: { lt: input.cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorKind: row.actorKind,
      actorSubject: row.actorSubject,
      reasonCode: row.reasonCode,
      beforeState: row.beforeState,
      afterState: row.afterState,
      outcome: row.outcome,
      errorCode: row.errorCode,
      stepKey: row.stepKey,
      attempt: row.attempt,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt,
    }));
  }

  // ── Transition (CAS) ──────────────────────────────────────────────────────

  /**
   * changes state with `expectedRevision`: the same transition table as the DB trigger; a failed/cancelled terminal
   * releases the reservations as a 30-day tombstone in the same transaction — SUCCEEDED must use `complete`
   */
  async transition(input: {
    requestId: string;
    expectedRevision: number;
    to: Exclude<ProvisioningRequestStatus, 'SUCCEEDED' | 'PENDING'>;
    actor: PlatformActor;
    correlationId: string;
    reasonCode?: string;
    comment?: string;
    failureCode?: string;
  }): Promise<{ status: ProvisioningRequestStatus; revision: number }> {
    const request = await this.requireRequest(input.requestId);
    if (request.revision !== input.expectedRevision) {
      throw new PlatformProvisioningError('REVISION_CONFLICT');
    }
    if (!isAllowedProvisioningTransition(request.status, input.to)) {
      throw new PlatformProvisioningError('INVALID_STATE_TRANSITION');
    }
    const now = this.now();
    const terminal = input.to === 'FAILED_FINAL' || input.to === 'CANCELLED';
    await this.database.$transaction(async (transaction) => {
      const updated = await transaction.pfProvisioningRequest.updateMany({
        where: { id: request.id, revision: input.expectedRevision, status: request.status },
        data: {
          status: input.to,
          revision: { increment: 1 },
          ...(terminal ? { terminalAt: now } : {}),
          ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        },
      });
      if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
      await this.appendAction(transaction, {
        tenantId: request.tenantId,
        requestId: request.id,
        action:
          input.to === 'CANCELLED'
            ? 'CANCEL'
            : input.to === 'FAILED_FINAL'
              ? 'MARK_FAILED_FINAL'
              : 'STATE_CHANGED',
        actor: input.actor,
        correlationId: input.correlationId,
        beforeState: request.status,
        afterState: input.to,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
        outcome: 'SUCCEEDED',
        at: now,
      });
      if (terminal) {
        const tombstoned = await transaction.pfIdentityReservation.updateMany({
          where: { requestId: request.id, state: 'HELD' },
          data: {
            state: 'TOMBSTONED',
            tombstonedUntil: new Date(now.getTime() + IDENTITY_TOMBSTONE_DAYS * 86_400_000),
            revision: { increment: 1 },
          },
        });
        if (tombstoned.count > 0) {
          await this.appendAction(transaction, {
            tenantId: request.tenantId,
            requestId: request.id,
            action: 'RESERVATION_TOMBSTONED',
            actor: { kind: 'SYSTEM', subject: 'platform-control' },
            correlationId: input.correlationId,
            outcome: 'SUCCEEDED',
            at: now,
          });
        }
      }
    });
    return { status: input.to, revision: input.expectedRevision + 1 };
  }

  /**
   * completion invariant (#390): request SUCCEEDED + tenant ACTIVE + reservation CONSUMED in one
   * transaction — the DB rejects it if steps are incomplete or the slug/domain set on the tenant does not match the request
   */
  async complete(input: {
    requestId: string;
    expectedRevision: number;
    actor: PlatformActor;
    correlationId: string;
  }): Promise<{ status: 'SUCCEEDED'; revision: number }> {
    const request = await this.requireRequest(input.requestId);
    if (request.revision !== input.expectedRevision) {
      throw new PlatformProvisioningError('REVISION_CONFLICT');
    }
    if (!isAllowedProvisioningTransition(request.status, 'SUCCEEDED')) {
      throw new PlatformProvisioningError('INVALID_STATE_TRANSITION');
    }
    const now = this.now();
    try {
      await this.database.$transaction(async (transaction) => {
        const updated = await transaction.pfProvisioningRequest.updateMany({
          where: { id: request.id, revision: input.expectedRevision, status: request.status },
          data: { status: 'SUCCEEDED', revision: { increment: 1 }, terminalAt: now },
        });
        if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
        await transaction.tenant.update({
          where: { id: request.tenantId },
          data: {
            lifecycleStatus: 'ACTIVE',
            slug: request.slug,
            sipDomain: request.sipDomain,
            primaryDomain: request.primaryDomain,
          },
        });
        await transaction.pfIdentityReservation.updateMany({
          where: { requestId: request.id, state: 'HELD' },
          data: { state: 'CONSUMED', revision: { increment: 1 } },
        });
        // #901: the first admin gets a positive identity binding at the same moment the tenant becomes ACTIVE — the DB reads
        // the subject/Organization/attester from the request's own evidence and binds only the deployment's issuer/client
        const tenantConsole = this.options.tenantConsole;
        if (tenantConsole) {
          await transaction.$queryRaw`
            SELECT dc_platform_bind_first_admin(${request.tenantId}::uuid, ${request.id}::uuid,
              ${tenantConsole.issuer}, ${tenantConsole.clientId}) AS revision`;
          // #914: the first admin can create/import customers immediately — the DB grants CONTACT_CREATE from this request's own binding
          await transaction.$queryRaw`
            SELECT dc_platform_grant_first_admin_contact_create(${request.tenantId}::uuid,
              ${request.id}::uuid) AS outcome`;
        }
        await this.appendAction(transaction, {
          tenantId: request.tenantId,
          requestId: request.id,
          action: 'STATE_CHANGED',
          actor: input.actor,
          correlationId: input.correlationId,
          beforeState: request.status,
          afterState: 'SUCCEEDED',
          outcome: 'SUCCEEDED',
          at: now,
        });
      });
    } catch (error) {
      if (error instanceof PlatformProvisioningError) throw error;
      // incomplete steps/mismatched binding are a disallowed transition, not a system error
      if (error instanceof Error && /PF_REQUEST_INCOMPLETE|TENANT_/.test(error.message)) {
        throw new PlatformProvisioningError('INVALID_STATE_TRANSITION');
      }
      if (isUniqueViolation(error)) throw new PlatformProvisioningError(uniqueConflictCode(error));
      throw error;
    }
    return { status: 'SUCCEEDED', revision: input.expectedRevision + 1 };
  }

  // ── Step receipts ─────────────────────────────────────────────────────────

  /**
   * records a step result: head + append-only receipt + Action history in one place; the binding
   * `(tenantId, requestId)` must match (composite FK), a mismatch = a generic NOT_FOUND
   * the receipt of an already SUCCEEDED attempt can be replayed as a no-op
   */
  async recordStepOutcome(input: {
    tenantId: string;
    requestId: string;
    stepKey: Exclude<ProvisioningStepKey, 'TENANT_RECORD'>;
    attempt: number;
    outcome: 'SUCCEEDED' | 'ACTION_REQUIRED';
    inputDigest?: string;
    outputDigest?: string;
    externalRef?: string;
    errorCode?: string;
    actor: PlatformActor;
    correlationId: string;
  }): Promise<{ replayed: boolean }> {
    if (!isUuid(input.tenantId) || !isUuid(input.requestId)) {
      throw new PlatformProvisioningError('NOT_FOUND');
    }
    const now = this.now();
    const externalRefHash = input.externalRef
      ? platformIdentityHash('external-ref', input.externalRef)
      : undefined;
    try {
      return await this.database.$transaction(async (transaction) => {
        const step = await transaction.pfProvisioningStep.findFirst({
          where: { requestId: input.requestId, tenantId: input.tenantId, stepKey: input.stepKey },
        });
        if (!step) throw new PlatformProvisioningError('NOT_FOUND');
        if (step.state === 'SUCCEEDED') {
          const receipt = await transaction.pfProvisioningStepReceipt.findFirst({
            where: { requestId: input.requestId, stepKey: input.stepKey, outcome: 'SUCCEEDED' },
          });
          if (receipt?.attempt === input.attempt) return { replayed: true };
          throw new PlatformProvisioningError('INVALID_STATE_TRANSITION');
        }
        await transaction.pfProvisioningStepReceipt.create({
          data: {
            id: this.id(),
            requestId: input.requestId,
            tenantId: input.tenantId,
            stepKey: input.stepKey,
            attempt: input.attempt,
            outcome: input.outcome,
            ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
            ...(input.outputDigest ? { outputDigest: input.outputDigest } : {}),
            ...(externalRefHash ? { externalRefHash } : {}),
            ...(input.errorCode ? { errorCode: input.errorCode } : {}),
            recordedAt: now,
          },
        });
        const updated = await transaction.pfProvisioningStep.updateMany({
          where: { requestId: input.requestId, stepKey: input.stepKey, revision: step.revision },
          data: {
            state: input.outcome,
            attempt: input.attempt,
            revision: { increment: 1 },
            startedAt: step.startedAt ?? now,
            ...(input.outcome === 'SUCCEEDED' ? { finishedAt: now } : {}),
            ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
            ...(input.outputDigest ? { outputDigest: input.outputDigest } : {}),
            ...(input.externalRef ? { externalRef: input.externalRef } : {}),
            errorCode: input.errorCode ?? null,
          },
        });
        if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
        await this.appendAction(transaction, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          action: input.outcome === 'SUCCEEDED' ? 'STEP_SUCCEEDED' : 'STEP_ACTION_REQUIRED',
          actor: input.actor,
          correlationId: input.correlationId,
          stepKey: input.stepKey,
          attempt: input.attempt,
          ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
          ...(input.outputDigest ? { outputDigest: input.outputDigest } : {}),
          ...(externalRefHash ? { externalRefHash } : {}),
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
          outcome: 'SUCCEEDED',
          at: now,
        });
        return { replayed: false };
      });
    } catch (error) {
      if (error instanceof PlatformProvisioningError) throw error;
      if (isForeignKeyViolation(error)) throw new PlatformProvisioningError('NOT_FOUND');
      if (isUniqueViolation(error)) throw new PlatformProvisioningError('REVISION_CONFLICT');
      throw error;
    }
  }

  // ── Support ───────────────────────────────────────────────────────────────

  private async requireRequest(requestId: string) {
    if (!isUuid(requestId)) throw new PlatformProvisioningError('NOT_FOUND');
    const request = await this.database.pfProvisioningRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');
    return request;
  }

  private appendAction(
    client: Prisma.TransactionClient | PrismaClient,
    entry: PlatformActionEntry,
  ) {
    return appendPlatformAction(client, this.id(), entry);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** the tenants unique at activation/race — separates domain from slug/sipDomain by field name */
function uniqueConflictCode(error: unknown): PlatformProvisioningErrorCode {
  const target =
    error instanceof Prisma.PrismaClientKnownRequestError ? error.meta?.target : undefined;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  if (fields.some((field) => field.includes('primary_domain') || field.includes('primaryDomain'))) {
    return 'TENANT_DOMAIN_CONFLICT';
  }
  if (fields.some((field) => field.includes('idempotency'))) return 'IDEMPOTENCY_KEY_REUSED';
  return 'TENANT_SLUG_CONFLICT';
}
