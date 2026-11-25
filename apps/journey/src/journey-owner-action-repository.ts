/**
 * J2.3 — durable foundation of the owner action lifecycle (Cases/Dialer)
 *
 * Journey keeps only its own action intent, command outbox and result inbox —
 * it does not write canonical Case/Campaign/Callback state per #121. Stable business
 * `actionKey = enrollmentId:journeyVersion:stepId`; a retry must always use the same actionKey/
 * commandId/requestHash (#123). There is no real owner implementation
 * or relay transport here yet (see #131 J2.3 scope)
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  commandId as toCommandId,
  tenantId as toTenantId,
  validateOwnerCommandPayload,
  withOwnerRequestHash,
  type J2OutcomeReferenceV1,
  type J2OwnerCommandDraftV1,
  type J2OwnerCommandPayloadV1,
} from '@d-contact/cxa-contracts';
import {
  Prisma,
  type JrOwnerAction,
  type JrOwnerActionKind,
  type JrOwnerActionState,
  type JrOwnerCommandOutbox,
  type JrOwnerResultInbox,
  type JrOwnerResultKind,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  continueOwnerResultInTransaction,
  type OwnerContinuationCheckpoint,
} from './journey-owner-continuation.js';

/** states that can still receive a result from the owner, per the lifecycle diagram confirmed in #123 */
const OPEN_ACTION_STATES: JrOwnerActionState[] = [
  'PENDING',
  'DISPATCHED',
  'ACK_UNKNOWN',
  'CANCEL_REQUESTED',
];

/** states that can still be cancelled — ACKNOWLEDGED is not here because the owner already created the entity */
const CANCELLABLE_ACTION_STATES: JrOwnerActionState[] = ['PENDING', 'DISPATCHED', 'ACK_UNKNOWN'];

/** commands that cancel/replace an earlier positive effect — their result decides an action that is CANCEL_REQUESTED */
const CANCEL_COMMAND_TYPES = new Set([
  'CANCEL_CAMPAIGN_TARGET',
  'CANCEL_CALLBACK',
  'SUPERSEDE_CAMPAIGN_TARGET',
  'SUPERSEDE_CALLBACK',
]);

/**
 * J2.1 frozen contract: cancel/supersede use the same actionKey (`intent.originalActionKey ===
 * actionKey`) but a new commandId — there is no cancel kind for ENSURE_CASE because a Case that is already committed
 * must remain (#123)
 */
const CANCEL_COMMAND_TYPE_BY_KIND: Partial<
  Record<
    JrOwnerActionKind,
    {
      cancel: J2OwnerCommandPayloadV1['commandType'];
      supersede: J2OwnerCommandPayloadV1['commandType'];
    }
  >
> = {
  ADMIT_CAMPAIGN_TARGET: {
    cancel: 'CANCEL_CAMPAIGN_TARGET',
    supersede: 'SUPERSEDE_CAMPAIGN_TARGET',
  },
  SCHEDULE_CALLBACK: { cancel: 'CANCEL_CALLBACK', supersede: 'SUPERSEDE_CALLBACK' },
};

/**
 * The commandId of a cancel must be an opaque reference (≤160 characters) that is stable per (action, request key) —
 * always including actionKey, otherwise the same request key for different actions (e.g. an Idempotency-Key an admin
 * reuses) would get the same commandId and silently upsert over it, leaving the second action with no cancel command
 */
export function cancelCommandIdFor(
  tenantId: string,
  actionKey: string,
  cancelRequestKey: string,
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([tenantId, actionKey, cancelRequestKey]))
    .digest('hex');
  return `cancel-${digest.slice(0, 48)}`;
}

function payloadCommandType(payload: unknown): string | undefined {
  return payload && typeof payload === 'object' && 'commandType' in payload
    ? String((payload as { commandType: unknown }).commandType)
    : undefined;
}

function actionLockKey(tenantId: string, actionKey: string): string {
  return `jr-owner-action:${tenantId}:${actionKey}`;
}

export class OwnerActionHashConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(readonly actionKey: string) {
    super(`Owner action actionKey already exists with a different requestHash: ${actionKey}`);
    this.name = 'OwnerActionHashConflictError';
  }
}

export interface EnsureOwnerActionInput {
  tenantId: string;
  actionKey: string;
  enrollmentId: string;
  /** J5.0: exact Journey cursor that created this action; both fields are all-or-none. */
  stepId?: string;
  stepSequence?: number;
  outcomeReceiptId?: string;
  kind: JrOwnerActionKind;
  requestHash: string;
  correlationId: string;
  /** the command to dispatch together in the same transaction — never call the owner during this transaction */
  commandId: string;
  /** the full J2OwnerCommandPayloadV1 ready for a real relay (J2.8); undefined for old callers */
  commandPayload?: unknown;
}

export interface EnsureOwnerActionResult {
  action: JrOwnerAction;
  /** false for an idempotent replay of the same actionKey — no new command is created */
  isNew: boolean;
}

export interface ApplyOwnerResultInput {
  tenantId: string;
  commandId: string;
  actionKey: string;
  resultKind: JrOwnerResultKind;
  resultHash: string;
  correlationId: string;
  ownerAggregateRef?: string;
  ownerAggregateVersion?: number;
}

export type ApplyOwnerResultOutcome = 'APPLIED' | 'DUPLICATE' | 'CONFLICT' | 'TERMINAL_IGNORED';

export interface RequestOwnerCancellationInput {
  tenantId: string;
  actionKey: string;
  /**
   * the logical idempotency key of the cancel request (e.g. the admin's Idempotency-Key or a key computed from
   * actionKey) — the real commandId is always computed from this key, so a repeated request gets the same command
   */
  cancelRequestKey: string;
  correlationId: string;
  /** stable code the owner records alongside the cancellation */
  reasonCode?: string;
  /** when set = SUPERSEDE_x instead of CANCEL_x */
  supersedingOutcome?: J2OutcomeReferenceV1;
  /** admin recovery (#136) must always send it; an internal caller that races with no one may omit it */
  expectedVersion?: number;
}

export class OwnerActionCancellationUnavailableError extends Error {
  readonly code = 'CANCELLATION_UNAVAILABLE' as const;

  constructor(readonly actionKey: string) {
    super(
      `owner action ${actionKey} has no original command payload to build a cancel command from`,
    );
    this.name = 'OwnerActionCancellationUnavailableError';
  }
}

export interface ApplyOwnerResultResult {
  outcome: ApplyOwnerResultOutcome;
  action: JrOwnerAction;
}

export class OwnerActionNotFoundError extends Error {
  readonly code = 'ACTION_NOT_FOUND' as const;

  constructor(readonly actionKey: string) {
    super(`owner action not found: ${actionKey}`);
    this.name = 'OwnerActionNotFoundError';
  }
}

/** admin recovery must reference the version it really saw — prevents a replay from overwriting state that has moved on */
export class OwnerActionVersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT' as const;

  constructor(
    readonly actionKey: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`owner action ${actionKey} is at version ${actualVersion}, not ${expectedVersion}`);
    this.name = 'OwnerActionVersionConflictError';
  }
}

/** states in which a command can still be replayed — once terminal it must never be resent */
const REPLAYABLE_ACTION_STATES: JrOwnerActionState[] = [
  'PENDING',
  'DISPATCHED',
  'ACK_UNKNOWN',
  'CANCEL_REQUESTED',
];

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** JrOwnerResultKind is always a subset of JrOwnerActionState — mapped one to one without a sloppy cast */
const RESULT_KIND_TO_ACTION_STATE: Record<JrOwnerResultKind, JrOwnerActionState> = {
  ACKNOWLEDGED: 'ACKNOWLEDGED',
  REJECTED: 'REJECTED',
  ACK_UNKNOWN: 'ACK_UNKNOWN',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
  TOO_LATE: 'TOO_LATE',
  RECONCILING: 'RECONCILING',
};

export class JourneyOwnerActionRepository {
  private readonly id: () => string;
  private readonly now: () => Date;
  private readonly checkpoint?: (phase: OwnerContinuationCheckpoint) => void | Promise<void>;

  constructor(
    private readonly database: PrismaClient,
    options: {
      id?: () => string;
      now?: () => Date;
      /** test-only fault injection for proving transaction rollback at crash boundaries */
      checkpoint?: (phase: OwnerContinuationCheckpoint) => void | Promise<void>;
    } = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.checkpoint = options.checkpoint;
  }

  /**
   * creates the action + stages the first command in one transaction — a retry with the same actionKey/
   * requestHash returns the existing action without creating a duplicate command (idempotent per #123)
   */
  async ensureAction(
    input: EnsureOwnerActionInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<EnsureOwnerActionResult> {
    if (
      (input.stepId === undefined) !== (input.stepSequence === undefined) ||
      (input.stepSequence !== undefined && input.stepSequence < 0)
    ) {
      throw new TypeError(
        'stepId and stepSequence must be given together and stepSequence must not be negative',
      );
    }
    const run = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${actionLockKey(input.tenantId, input.actionKey)}))`,
      );
      const existing = await transaction.jrOwnerAction.findUnique({
        where: { tenantId_actionKey: { tenantId: input.tenantId, actionKey: input.actionKey } },
      });
      if (existing) {
        if (existing.requestHash !== input.requestHash) {
          throw new OwnerActionHashConflictError(input.actionKey);
        }
        if (
          input.stepId !== undefined &&
          (existing.stepId !== input.stepId || existing.stepSequence !== input.stepSequence)
        ) {
          throw new OwnerActionHashConflictError(input.actionKey);
        }
        return { action: existing, isNew: false };
      }

      const action = await transaction.jrOwnerAction.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          actionKey: input.actionKey,
          enrollmentId: input.enrollmentId,
          ...(input.stepId !== undefined && input.stepSequence !== undefined
            ? { stepId: input.stepId, stepSequence: input.stepSequence }
            : {}),
          ...(input.outcomeReceiptId ? { outcomeReceiptId: input.outcomeReceiptId } : {}),
          kind: input.kind,
          requestHash: input.requestHash,
          state: 'PENDING',
          correlationId: input.correlationId,
        },
      });
      await transaction.jrOwnerCommandOutbox.upsert({
        where: { tenantId_commandId: { tenantId: input.tenantId, commandId: input.commandId } },
        create: {
          id: this.id(),
          tenantId: input.tenantId,
          commandId: input.commandId,
          actionId: action.id,
          actionKey: action.actionKey,
          kind: input.kind,
          requestHash: input.requestHash,
          correlationId: input.correlationId,
          state: 'PENDING',
          ...(input.commandPayload !== undefined
            ? { payload: input.commandPayload as Prisma.InputJsonValue }
            : {}),
        },
        update: {},
      });
      return { action, isNew: true };
    };
    return transaction
      ? run(transaction)
      : withTenantDatabaseTransaction(this.database, input.tenantId, run);
  }

  getAction(tenantId: string, actionKey: string): Promise<JrOwnerAction | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOwnerAction.findUnique({
        where: { tenantId_actionKey: { tenantId, actionKey } },
      }),
    );
  }

  /** a command that has been dispatched (a real relay transport is the scope of a later ticket) */
  async markCommandDispatched(tenantId: string, commandId: string): Promise<JrOwnerCommandOutbox> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const command = await transaction.jrOwnerCommandOutbox.update({
        where: { tenantId_commandId: { tenantId, commandId } },
        data: { state: 'SENT', sentAt: new Date() },
      });
      await transaction.jrOwnerAction.updateMany({
        where: { tenantId, actionKey: command.actionKey, state: 'PENDING' },
        data: { state: 'DISPATCHED', dispatchedAt: new Date(), version: { increment: 1 } },
      });
      return command;
    });
  }

  async markCommandFailed(
    tenantId: string,
    commandId: string,
    backoffMs: number,
    errorMessage: string,
  ): Promise<JrOwnerCommandOutbox> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOwnerCommandOutbox.update({
        where: { tenantId_commandId: { tenantId, commandId } },
        data: {
          state: 'PENDING',
          attempts: { increment: 1 },
          availableAt: new Date(Date.now() + backoffMs),
          lastError: errorMessage.slice(0, 1_000),
        },
      }),
    );
  }

  findPendingCommands(tenantId: string, limit = 10): Promise<JrOwnerCommandOutbox[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOwnerCommandOutbox.findMany({
        where: { tenantId, state: 'PENDING', availableAt: { lte: new Date() } },
        orderBy: { availableAt: 'asc' },
        take: limit,
      }),
    );
  }

  /**
   * applies a result from the owner idempotently per `(tenantId, commandId)`; a terminal that
   * has committed (ACKNOWLEDGED/REJECTED/CANCELLED/TOO_LATE) always wins — a late result
   * does not revert the state and does not create a new Case/Campaign/Callback effect
   */
  async applyResult(input: ApplyOwnerResultInput): Promise<ApplyOwnerResultResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      this.applyResultInTransaction(transaction, input),
    );
  }

  /**
   * Transactional primitive for J5.0 callers that must commit owner result, action terminal
   * state, continuation ledger, step run and cursor CAS as one unit.
   */
  async applyResultInTransaction(
    transaction: Prisma.TransactionClient,
    input: ApplyOwnerResultInput,
  ): Promise<ApplyOwnerResultResult> {
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${actionLockKey(input.tenantId, input.actionKey)}))`,
    );
    const existingResult = await transaction.jrOwnerResultInbox.findUnique({
      where: { tenantId_commandId: { tenantId: input.tenantId, commandId: input.commandId } },
    });
    const action = await transaction.jrOwnerAction.findUnique({
      where: { tenantId_actionKey: { tenantId: input.tenantId, actionKey: input.actionKey } },
    });
    if (!action) throw new OwnerActionNotFoundError(input.actionKey);

    if (existingResult) {
      if (existingResult.resultHash !== input.resultHash) {
        return { outcome: 'CONFLICT' as const, action };
      }
      // J5.0 legacy recovery: a result may have committed before the continuation ledger existed, so replaying
      // the original result fills in the missing cursor evidence through the same transaction, without changing the action again
      await continueOwnerResultInTransaction(
        transaction,
        {
          tenantId: input.tenantId,
          commandId: existingResult.commandId,
          resultKind: existingResult.resultKind,
          resultHash: existingResult.resultHash,
          correlationId: existingResult.correlationId,
          action,
          effectiveState: action.state,
        },
        {
          id: this.id,
          now: this.now,
          ...(this.checkpoint ? { checkpoint: this.checkpoint } : {}),
        },
      );
      return { outcome: 'DUPLICATE' as const, action };
    }

    const isOpenForResult = OPEN_ACTION_STATES.includes(action.state);
    const command = await transaction.jrOwnerCommandOutbox.findUnique({
      where: { tenantId_commandId: { tenantId: input.tenantId, commandId: input.commandId } },
      select: { payload: true },
    });
    const nextState = this.nextStateForResult(
      action.state,
      input.resultKind,
      CANCEL_COMMAND_TYPES.has(payloadCommandType(command?.payload) ?? ''),
    );
    const updated = isOpenForResult
      ? await transaction.jrOwnerAction.update({
          where: { id: action.id },
          data: {
            state: nextState,
            ...(input.ownerAggregateRef ? { ownerAggregateRef: input.ownerAggregateRef } : {}),
            ...(input.ownerAggregateVersion !== undefined
              ? { ownerAggregateVersion: input.ownerAggregateVersion }
              : {}),
            ...(input.resultKind === 'ACKNOWLEDGED' ? { acknowledgedAt: new Date() } : {}),
            version: { increment: 1 },
          },
        })
      : action;

    // a savepoint keeps the P2002 of this insert from rolling back the action update above
    // with it — Postgres aborts the whole transaction until rollback if there is no savepoint
    await transaction.$executeRaw`SAVEPOINT apply_result_insert`;
    try {
      await transaction.jrOwnerResultInbox.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          commandId: input.commandId,
          actionKey: input.actionKey,
          resultKind: input.resultKind,
          resultHash: input.resultHash,
          outcome: isOpenForResult ? 'APPLIED' : 'DUPLICATE',
          correlationId: input.correlationId,
          ...(input.ownerAggregateRef ? { ownerAggregateRef: input.ownerAggregateRef } : {}),
          ...(input.ownerAggregateVersion !== undefined
            ? { ownerAggregateVersion: input.ownerAggregateVersion }
            : {}),
        },
      });
      await transaction.$executeRaw`RELEASE SAVEPOINT apply_result_insert`;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await transaction.$executeRaw`ROLLBACK TO SAVEPOINT apply_result_insert`;
      // race: another worker already inserted the same result first — treated as a safe duplicate
      return { outcome: 'DUPLICATE' as const, action: updated };
    }

    await this.checkpoint?.('RESULT_PERSISTED');
    await continueOwnerResultInTransaction(
      transaction,
      {
        tenantId: input.tenantId,
        commandId: input.commandId,
        resultKind: input.resultKind,
        resultHash: input.resultHash,
        correlationId: input.correlationId,
        action: updated,
        effectiveState: updated.state,
      },
      { id: this.id, now: this.now, ...(this.checkpoint ? { checkpoint: this.checkpoint } : {}) },
    );

    return {
      outcome: isOpenForResult ? ('APPLIED' as const) : ('TERMINAL_IGNORED' as const),
      action: updated,
    };
  }

  /**
   * J5.0 recovery for a result committed before deployment that has no continuation ledger yet.
   * Selects only actions with a deterministic step binding; unbound legacy rows are left for the
   * operator to quarantine instead of guessing the cursor.
   */
  async reconcileCommittedContinuations(tenantId: string, limit = 50): Promise<number> {
    const candidates = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.$queryRaw<
        Array<{
          commandId: string;
          actionKey: string;
          resultKind: JrOwnerResultKind;
          resultHash: string;
          correlationId: string;
          ownerAggregateRef: string | null;
          ownerAggregateVersion: number | null;
        }>
      >(Prisma.sql`
        SELECT
          result.command_id AS "commandId",
          result.action_key AS "actionKey",
          result.result_kind AS "resultKind",
          result.result_hash AS "resultHash",
          result.correlation_id AS "correlationId",
          result.owner_aggregate_ref AS "ownerAggregateRef",
          result.owner_aggregate_version AS "ownerAggregateVersion"
        FROM jr_owner_result_inbox result
        JOIN jr_owner_actions action
          ON action.tenant_id = result.tenant_id AND action.action_key = result.action_key
        LEFT JOIN jr_owner_continuations continuation
          ON continuation.tenant_id = action.tenant_id AND continuation.action_id = action.id
        WHERE result.tenant_id = ${tenantId}::uuid
          AND result.result_kind IN ('ACKNOWLEDGED', 'REJECTED')
          AND action.step_id IS NOT NULL
          AND action.step_sequence IS NOT NULL
          AND continuation.id IS NULL
        ORDER BY result.received_at, result.command_id
        LIMIT ${limit}
      `),
    );

    let reconciled = 0;
    for (const candidate of candidates) {
      const outcome = await this.applyResult({
        tenantId,
        commandId: candidate.commandId,
        actionKey: candidate.actionKey,
        resultKind: candidate.resultKind,
        resultHash: candidate.resultHash,
        correlationId: candidate.correlationId,
        ...(candidate.ownerAggregateRef ? { ownerAggregateRef: candidate.ownerAggregateRef } : {}),
        ...(candidate.ownerAggregateVersion === null
          ? {}
          : { ownerAggregateVersion: candidate.ownerAggregateVersion }),
      });
      if (outcome.outcome === 'DUPLICATE') reconciled += 1;
    }
    return reconciled;
  }

  /**
   * A result the owner answers during CANCEL_REQUESTED must be told apart by which command it came from:
   *
   * - a "successful" result of the original positive command arriving before the cancel result must not close the action as
   *   ACKNOWLEDGED — otherwise the CANCELLED result that follows would be treated as a late result and Journey and the owner
   *   would see different states; keep the aggregate but wait for the cancel result to decide
   * - a cancel the owner rejects (e.g. cannot find the original effect) does not mean the action was rejected —
   *   send it to RECONCILING for a person to check instead of guessing
   */
  private nextStateForResult(
    current: JrOwnerActionState,
    resultKind: JrOwnerResultKind,
    fromCancelCommand: boolean,
  ): JrOwnerActionState {
    if (fromCancelCommand && resultKind === 'REJECTED') return 'RECONCILING';
    if (!fromCancelCommand && current === 'CANCEL_REQUESTED' && resultKind === 'ACKNOWLEDGED') {
      return 'CANCEL_REQUESTED';
    }
    return RESULT_KIND_TO_ACTION_STATE[resultKind];
  }

  /**
   * Requests cancel/supersede — only for states that are still reversible per #123; other states are an idempotent no-op
   *
   * - the command never left Journey (outbox PENDING/FAILED and action PENDING) → cancel in-house
   *   immediately, the original command is not dispatched and the owner need not be bothered (#123: terminal before the owner accepts)
   * - already left → stage CANCEL_x/SUPERSEDE_x per the contract: the same actionKey, a new commandId computed
   *   from `cancelRequestKey`, and the cancel command's own requestHash (the result binding uses this value)
   * - an ENSURE_CASE that already left has no cancel contract — a Case the owner may have committed must remain,
   *   so the existing action is returned without changing anything
   *
   * locks the action's outbox row with FOR UPDATE — the relay claims with SKIP LOCKED so it cannot pick up the original
   * command to send in a race with the in-house cancellation; if the relay claimed first (PROCESSING) it counts as already left
   */
  async requestCancellation(
    input: RequestOwnerCancellationInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<JrOwnerAction> {
    const run = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${actionLockKey(input.tenantId, input.actionKey)}))`,
      );
      const action = await transaction.jrOwnerAction.findUnique({
        where: { tenantId_actionKey: { tenantId: input.tenantId, actionKey: input.actionKey } },
      });
      if (!action) throw new OwnerActionNotFoundError(input.actionKey);
      if (input.expectedVersion !== undefined && action.version !== input.expectedVersion) {
        throw new OwnerActionVersionConflictError(
          input.actionKey,
          input.expectedVersion,
          action.version,
        );
      }
      if (!CANCELLABLE_ACTION_STATES.includes(action.state)) return action;

      const commands = await transaction.$queryRaw<
        Array<{ id: string; state: string; payload: unknown }>
      >(Prisma.sql`
        SELECT id, state, payload
        FROM jr_owner_command_outbox
        WHERE tenant_id = ${input.tenantId}::uuid AND action_id = ${action.id}::uuid
        ORDER BY created_at
        FOR UPDATE
      `);
      const neverDispatched =
        action.state === 'PENDING' &&
        commands.every((command) => command.state === 'PENDING' || command.state === 'FAILED');
      if (neverDispatched) {
        await transaction.jrOwnerCommandOutbox.updateMany({
          where: {
            tenantId: input.tenantId,
            actionId: action.id,
            state: { in: ['PENDING', 'FAILED'] },
          },
          data: { state: 'CANCELLED' },
        });
        return transaction.jrOwnerAction.update({
          where: { id: action.id },
          data: {
            state: 'CANCELLED',
            cancelRequestedAt: new Date(),
            version: { increment: 1 },
          },
        });
      }

      const commandTypes = CANCEL_COMMAND_TYPE_BY_KIND[action.kind];
      if (!commandTypes) return action;
      const original = commands.find(
        ({ payload }) => payload && !CANCEL_COMMAND_TYPES.has(payloadCommandType(payload) ?? ''),
      );
      if (!original) throw new OwnerActionCancellationUnavailableError(input.actionKey);
      const originalCommand = validateOwnerCommandPayload(original.payload);

      const commandId = cancelCommandIdFor(input.tenantId, input.actionKey, input.cancelRequestKey);
      const reasonCode = input.reasonCode ?? 'JOURNEY_CANCELLED';
      const {
        commandType: _positive,
        intent: _intent,
        requestHash: _hash,
        ...common
      } = originalCommand;
      const draft = (
        input.supersedingOutcome
          ? {
              ...common,
              commandId: toCommandId(commandId),
              commandType: commandTypes.supersede,
              intent: {
                originalActionKey: originalCommand.actionKey,
                reasonCode,
                supersedingOutcome: input.supersedingOutcome,
              },
            }
          : {
              ...common,
              commandId: toCommandId(commandId),
              commandType: commandTypes.cancel,
              intent: { originalActionKey: originalCommand.actionKey, reasonCode },
            }
      ) as J2OwnerCommandDraftV1;
      const cancelCommand = withOwnerRequestHash(toTenantId(input.tenantId), draft);

      const cancelled = await transaction.jrOwnerAction.update({
        where: { id: action.id },
        data: {
          state: 'CANCEL_REQUESTED',
          cancelRequestedAt: new Date(),
          // the cancel phase chases a new result (of the cancel command) — start counting the ceiling afresh, not eating the quota
          // already used by the ACK_UNKNOWN of the original command
          attempts: 0,
          version: { increment: 1 },
        },
      });
      await transaction.jrOwnerCommandOutbox.upsert({
        where: { tenantId_commandId: { tenantId: input.tenantId, commandId } },
        create: {
          id: this.id(),
          tenantId: input.tenantId,
          commandId,
          actionId: action.id,
          actionKey: action.actionKey,
          kind: action.kind,
          requestHash: cancelCommand.requestHash,
          correlationId: input.correlationId,
          state: 'PENDING',
          payload: cancelCommand as unknown as Prisma.InputJsonValue,
        },
        update: {},
      });
      return cancelled;
    };
    return transaction
      ? run(transaction)
      : withTenantDatabaseTransaction(this.database, input.tenantId, run);
  }

  /**
   * Returns the action's command to the relay queue again, for admin recovery (#136)
   *
   * Not a blind retry: it must reference the `expectedVersion` actually seen, the action must not be terminal yet
   * and the original `commandId` is always reused — so the owner can dedupe under the J2.8 at-least-once contract,
   * not a creation of a new effect
   */
  async replayCommands(input: {
    tenantId: string;
    actionKey: string;
    expectedVersion: number;
  }): Promise<{ action: JrOwnerAction; replayedCommandIds: string[] }> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${actionLockKey(input.tenantId, input.actionKey)}))`,
      );
      const action = await transaction.jrOwnerAction.findUnique({
        where: { tenantId_actionKey: { tenantId: input.tenantId, actionKey: input.actionKey } },
      });
      if (!action) throw new OwnerActionNotFoundError(input.actionKey);
      if (action.version !== input.expectedVersion) {
        throw new OwnerActionVersionConflictError(
          input.actionKey,
          input.expectedVersion,
          action.version,
        );
      }
      if (!REPLAYABLE_ACTION_STATES.includes(action.state)) {
        return { action, replayedCommandIds: [] };
      }

      const commands = await transaction.jrOwnerCommandOutbox.findMany({
        where: {
          tenantId: input.tenantId,
          actionKey: input.actionKey,
          state: { in: ['SENT', 'FAILED'] },
        },
      });
      if (commands.length === 0) return { action, replayedCommandIds: [] };

      await transaction.jrOwnerCommandOutbox.updateMany({
        where: {
          tenantId: input.tenantId,
          actionKey: input.actionKey,
          state: { in: ['SENT', 'FAILED'] },
        },
        data: { state: 'PENDING', availableAt: new Date(), sentAt: null },
      });
      const replayed = await transaction.jrOwnerAction.update({
        where: { id: action.id },
        data: { version: { increment: 1 } },
      });
      return { action: replayed, replayedCommandIds: commands.map((c) => c.commandId) };
    });
  }

  /**
   * an action that was dispatched but the owner is still silent past the deadline and the retry quota is not used up
   *
   * `attempts` controls bounded retry: past the ceiling it is not picked up again and is left for a person to decide
   * through the admin recovery API instead of calling the owner forever
   */
  findStaleDispatched(
    tenantId: string,
    dispatchedBefore: Date,
    maxAttempts: number,
    limit = 10,
  ): Promise<JrOwnerAction[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOwnerAction.findMany({
        where: {
          tenantId,
          state: { in: ['DISPATCHED', 'ACK_UNKNOWN'] },
          dispatchedAt: { not: null, lte: dispatchedBefore },
          attempts: { lt: maxAttempts },
        },
        orderBy: { dispatchedAt: 'asc' },
        take: limit,
      }),
    );
  }

  /**
   * DISPATCHED/ACK_UNKNOWN -> ACK_UNKNOWN with the attempt count increased by one
   *
   * uses a version guard so it does not overwrite an action that just got a real result meanwhile — returns null when it loses the race
   */
  async markAckUnknown(
    tenantId: string,
    actionKey: string,
    expectedVersion: number,
  ): Promise<JrOwnerAction | null> {
    const moved = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOwnerAction.updateMany({
        where: {
          tenantId,
          actionKey,
          version: expectedVersion,
          state: { in: ['DISPATCHED', 'ACK_UNKNOWN'] },
        },
        data: { state: 'ACK_UNKNOWN', attempts: { increment: 1 }, version: { increment: 1 } },
      }),
    );
    if (moved.count === 0) return null;
    return this.getAction(tenantId, actionKey) as Promise<JrOwnerAction>;
  }

  /** an action that asked for cancel/supersede but the owner has not confirmed the result past the deadline and the quota is not used up */
  findStaleCancelRequested(
    tenantId: string,
    requestedBefore: Date,
    maxAttempts: number,
    limit = 10,
  ): Promise<JrOwnerAction[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOwnerAction.findMany({
        where: {
          tenantId,
          state: 'CANCEL_REQUESTED',
          cancelRequestedAt: { not: null, lte: requestedBefore },
          attempts: { lt: maxAttempts },
        },
        orderBy: { cancelRequestedAt: 'asc' },
        take: limit,
      }),
    );
  }

  /**
   * counts an attempt of chasing the cancel result while keeping the CANCEL_REQUESTED state (unlike markAckUnknown) —
   * the version guard prevents overwriting an action that just got the cancel result meanwhile; returns null when it loses the race
   */
  async markCancelUnconfirmed(
    tenantId: string,
    actionKey: string,
    expectedVersion: number,
  ): Promise<{ action: JrOwnerAction; cancelRequestHash: string } | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const moved = await transaction.jrOwnerAction.updateMany({
        where: { tenantId, actionKey, version: expectedVersion, state: 'CANCEL_REQUESTED' },
        data: { attempts: { increment: 1 }, version: { increment: 1 } },
      });
      if (moved.count === 0) return null;
      const action = await transaction.jrOwnerAction.findUniqueOrThrow({
        where: { tenantId_actionKey: { tenantId, actionKey } },
      });
      const commands = await transaction.jrOwnerCommandOutbox.findMany({
        where: { tenantId, actionId: action.id },
        orderBy: { createdAt: 'desc' },
        select: { requestHash: true, payload: true },
      });
      const cancel = commands.find(({ payload }) =>
        CANCEL_COMMAND_TYPES.has(payloadCommandType(payload) ?? ''),
      );
      if (!cancel) throw new OwnerActionCancellationUnavailableError(actionKey);
      return { action, cancelRequestHash: cancel.requestHash };
    });
  }

  findResultsFor(tenantId: string, actionKey: string): Promise<JrOwnerResultInbox[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOwnerResultInbox.findMany({
        where: { tenantId, actionKey },
        orderBy: { receivedAt: 'asc' },
      }),
    );
  }
}
