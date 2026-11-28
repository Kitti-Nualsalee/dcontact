/**
 * J2.6 — Dialer owner implementation of `J2DialerOwnerPort` for
 * `SCHEDULE_CALLBACK`, `CANCEL_CALLBACK` and `SUPERSEDE_CALLBACK`. Dialer is
 * the sole canonical writer of `ob_callbacks` per #121 — scheduling never
 * creates a Governance reservation, and there is no actual originate/
 * telephony command here (that is a later ticket; see #134 out of scope).
 *
 * Reuses `ob_dialer_command_inbox` from J2.5 (same pull-model shape, same
 * table — `commandType` was reserved for exactly this). `ADMIT_CAMPAIGN_TARGET`
 * is out of this service's scope and fails closed with
 * `DialerCommandNotImplementedError` rather than silently mishandling it.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  actionKey as toActionKey,
  commandId as toCommandId,
  tenantId as toTenantId,
  J2_ERROR_CONTRACT,
  type CancelOwnerActionIntentV1,
  type J2DialerOwnerCommandV1,
  type J2DialerOwnerPort,
  type J2ErrorCode,
  type J2FailureClass,
  type J2OwnerActionQueryV1,
  type J2OwnerCommandPersistedV1,
  type J2OwnerResultPayloadV1,
  type ScheduleCallbackIntentV1,
  type SupersedeOwnerActionIntentV1,
  type TeamContactScopeAuthorizer,
  type TenantId,
} from '@d-contact/cxa-contracts';
import {
  findPositiveReceipt,
  persistDialerCommand,
  queryDialerAction,
} from './dialer-command-inbox.js';

// The `commandType` of CANCEL_*/SUPERSEDE_* in J2DialerOwnerCommandV1 is a union shared with
// Campaign (e.g. 'CANCEL_CAMPAIGN_TARGET' | 'CANCEL_CALLBACK') — Extract by commandType
// alone therefore always yields never (a union property is not assignable to a single literal),
// so Extract by `intent`, which is a type specific to each command, instead.
type ScheduleCallbackCommand = Extract<
  J2DialerOwnerCommandV1,
  { intent: ScheduleCallbackIntentV1 }
>;
type CancelOrSupersedeCallbackCommand =
  | Extract<J2DialerOwnerCommandV1, { intent: CancelOwnerActionIntentV1 }>
  | Extract<J2DialerOwnerCommandV1, { intent: SupersedeOwnerActionIntentV1 }>;
type CallbackCommand = ScheduleCallbackCommand | CancelOrSupersedeCallbackCommand;

const CALLBACK_COMMAND_TYPES = new Set([
  'SCHEDULE_CALLBACK',
  'CANCEL_CALLBACK',
  'SUPERSEDE_CALLBACK',
]);

function isCallbackCommand(command: J2DialerOwnerCommandV1): command is CallbackCommand {
  return CALLBACK_COMMAND_TYPES.has(command.commandType);
}
/** A callback that has not reached the irreversible point per #134 — every other state answers TOO_LATE */
const REVERSIBLE_STATES = new Set(['SCHEDULED']);
/** How long a callback stays valid after requestedFor before it counts as expired */
const EXPIRY_GRACE_MS = 24 * 60 * 60 * 1_000;

/** Alias keeping the original name for callers — all Dialer receipt identity lives in dialer-command-inbox */
export { DialerCommandHashConflictError as CallbackCommandHashConflictError } from './dialer-command-inbox.js';

export class CallbackCommandNotImplementedError extends Error {
  constructor(readonly commandType: string) {
    super(`DialerCallbackService does not support this command type: ${commandType}`);
    this.name = 'CallbackCommandNotImplementedError';
  }
}

export interface CallbackDecision {
  status: 'SCHEDULED' | 'ALREADY_SCHEDULED' | 'CANCELLED' | 'SUPERSEDED' | 'TOO_LATE' | 'REJECTED';
  code: string;
  category: string;
  reasonCode: string;
  failureClass: J2FailureClass;
  retryDisposition: string;
  recordId?: string;
  recordVersion?: number;
}

export function callbackRejection(
  code: J2ErrorCode,
  failureClass: J2FailureClass,
  reasonCode: string,
): CallbackDecision {
  const error = J2_ERROR_CONTRACT[code];
  return {
    status: 'REJECTED',
    code,
    category: error.category,
    reasonCode,
    failureClass,
    retryDisposition: error.retryDisposition,
  };
}

export function tooLate(
  reasonCode: string,
  recordId: string,
  recordVersion: number,
): CallbackDecision {
  const error = J2_ERROR_CONTRACT.ACTION_TOO_LATE;
  return {
    status: 'TOO_LATE',
    code: 'ACTION_TOO_LATE',
    category: error.category,
    reasonCode,
    failureClass: 'BUSINESS',
    retryDisposition: error.retryDisposition,
    recordId,
    recordVersion,
  };
}

export function positive(
  status: 'SCHEDULED' | 'ALREADY_SCHEDULED' | 'CANCELLED' | 'SUPERSEDED',
  reasonCode: string,
  recordId: string,
  recordVersion: number,
): CallbackDecision {
  return {
    status,
    code: status,
    category: 'BUSINESS',
    reasonCode,
    failureClass: 'NONE',
    retryDisposition: 'NONE',
    recordId,
    recordVersion,
  };
}

function lockKey(tenantId: string, contactId: string): string {
  return `ob-callback-dedupe:${tenantId}:${contactId}`;
}

export class DialerCallbackService implements J2DialerOwnerPort {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly scopeAuthorizer: TeamContactScopeAuthorizer,
    options: { id?: () => string; now?: () => Date } = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async persistCommand(
    tenant: TenantId,
    command: J2DialerOwnerCommandV1,
  ): Promise<J2OwnerCommandPersistedV1> {
    if (!isCallbackCommand(command)) {
      throw new CallbackCommandNotImplementedError(command.commandType);
    }
    return persistDialerCommand({
      database: this.database,
      tenant,
      command,
      id: this.id,
      now: this.now,
      decide: (transaction) => this.decide(transaction, tenant, command),
    });
  }

  queryAction(
    tenant: TenantId,
    query: J2OwnerActionQueryV1,
  ): Promise<J2OwnerResultPayloadV1 | undefined> {
    return queryDialerAction(this.database, tenant, query, CALLBACK_COMMAND_TYPES);
  }

  private async decide(
    transaction: Prisma.TransactionClient,
    tenant: TenantId,
    command: CallbackCommand,
  ): Promise<CallbackDecision> {
    const tenantId: string = tenant;
    // cancel/supersede do not re-check scope (see decideCancelOrSupersede) — cancelling must work even when the scope is revoked
    if (command.commandType !== 'SCHEDULE_CALLBACK') {
      return this.decideCancelOrSupersede(transaction, tenantId, command);
    }
    const [contact, sourceTeam, targetTeam] = await Promise.all([
      transaction.contact.findFirst({
        where: { id: command.contactId, tenantId },
        select: { id: true },
      }),
      transaction.team.findFirst({
        where: { id: command.sourceOwnerTeamId, tenantId },
        select: { id: true },
      }),
      transaction.team.findFirst({
        where: { id: command.targetOwnerTeamId, tenantId },
        select: { id: true },
      }),
    ]);
    if (!contact)
      return callbackRejection('CONTACT_NOT_FOUND', 'AUTHORIZATION', 'CONTACT_NOT_FOUND');
    if (!sourceTeam) {
      return callbackRejection(
        'TEAM_SEGMENT_NOT_ALLOWED',
        'AUTHORIZATION',
        'SOURCE_TEAM_NOT_FOUND',
      );
    }
    if (!targetTeam) {
      return callbackRejection(
        'TEAM_SEGMENT_NOT_ALLOWED',
        'AUTHORIZATION',
        'TARGET_TEAM_NOT_FOUND',
      );
    }

    const at = this.now().toISOString();
    const [sourceScope, targetScope] = await Promise.all([
      this.scopeAuthorizer.authorize({
        tenantId: tenant,
        teamId: command.sourceOwnerTeamId,
        contactId: command.contactId,
        permission: 'CONTACT',
        at,
      }),
      this.scopeAuthorizer.authorize({
        tenantId: tenant,
        teamId: command.targetOwnerTeamId,
        contactId: command.contactId,
        permission: 'CONTACT',
        at,
      }),
    ]);
    if (sourceScope.decision === 'DENY' || targetScope.decision === 'DENY') {
      return callbackRejection('TEAM_SEGMENT_NOT_ALLOWED', 'AUTHORIZATION', 'WORK_SCOPE_DENIED');
    }

    return this.decideSchedule(transaction, tenantId, command);
  }

  private async decideSchedule(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    command: ScheduleCallbackCommand,
  ): Promise<CallbackDecision> {
    const [queue, agent] = await Promise.all([
      transaction.queue.findFirst({
        where: { id: command.intent.queueId, tenantId },
        select: { id: true },
      }),
      command.intent.agentId
        ? transaction.user.findFirst({
            where: { id: command.intent.agentId, tenantId },
            select: { id: true },
          })
        : Promise.resolve(undefined),
    ]);
    if (!queue) return callbackRejection('OWNER_REJECTED', 'BUSINESS', 'QUEUE_NOT_FOUND');
    if (command.intent.agentId && !agent) {
      return callbackRejection('OWNER_REJECTED', 'BUSINESS', 'AGENT_NOT_FOUND');
    }
    const requestedFor = new Date(command.intent.requestedFor);
    if (requestedFor.getTime() <= this.now().getTime()) {
      return callbackRejection('OWNER_REJECTED', 'BUSINESS', 'REQUESTED_TIME_INVALID');
    }

    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${lockKey(tenantId, command.contactId)}))`,
    );

    const now = this.now();
    const pending = await transaction.obCallback.findFirst({
      // #1061 agent callbacks share the table; Journey only sees its own
      where: {
        tenantId,
        contactId: command.contactId,
        origin: 'JOURNEY',
        state: 'SCHEDULED',
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (pending) {
      return positive(
        'ALREADY_SCHEDULED',
        'CONTACT_ALREADY_HAS_PENDING_CALLBACK',
        pending.id,
        pending.version,
      );
    }

    const created = await transaction.obCallback.create({
      data: {
        id: this.id(),
        tenantId,
        contactId: command.contactId,
        queueId: command.intent.queueId,
        ...(command.intent.agentId ? { agentId: command.intent.agentId } : {}),
        requestedFor,
        expiresAt: new Date(requestedFor.getTime() + EXPIRY_GRACE_MS),
        sourceOwnerTeamId: command.sourceOwnerTeamId,
        targetOwnerTeamId: command.targetOwnerTeamId,
      },
    });
    return positive('SCHEDULED', 'CALLBACK_SCHEDULED', created.id, created.version);
  }

  /**
   * Does not re-check CONTACT scope — cancelling reduces contact and is the path Journey uses when a scope is revoked.
   * It must still bind to the real original callback: both the contact and the team must match what was scheduled.
   */
  private async decideCancelOrSupersede(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    command: CancelOrSupersedeCallbackCommand,
  ): Promise<CallbackDecision> {
    const original = await findPositiveReceipt(
      transaction,
      tenantId,
      command.intent.originalActionKey,
      'SCHEDULE_CALLBACK',
    );
    if (
      !original ||
      !original.recordId ||
      (original.status !== 'SCHEDULED' && original.status !== 'ALREADY_SCHEDULED')
    ) {
      return callbackRejection('OWNER_REJECTED', 'BUSINESS', 'ORIGINAL_ACTION_NOT_FOUND');
    }

    const callback = await transaction.obCallback.findFirst({
      where: { id: original.recordId, tenantId, origin: 'JOURNEY' },
    });
    if (!callback)
      return callbackRejection('OWNER_REJECTED', 'BUSINESS', 'ORIGINAL_ACTION_NOT_FOUND');
    if (
      callback.contactId !== command.contactId ||
      callback.sourceOwnerTeamId !== command.sourceOwnerTeamId ||
      callback.targetOwnerTeamId !== command.targetOwnerTeamId
    ) {
      return callbackRejection('BINDING_MISMATCH', 'CONTRACT', 'ORIGINAL_ACTION_BINDING_MISMATCH');
    }

    const targetStatus = command.commandType === 'CANCEL_CALLBACK' ? 'CANCELLED' : 'SUPERSEDED';
    const alreadyTerminalByThisKind =
      (targetStatus === 'CANCELLED' && callback.state === 'CANCELLED') ||
      (targetStatus === 'SUPERSEDED' && callback.state === 'SUPERSEDED');
    if (alreadyTerminalByThisKind) {
      const reasonCode =
        targetStatus === 'CANCELLED' ? 'CALLBACK_ALREADY_CANCELLED' : 'CALLBACK_ALREADY_SUPERSEDED';
      return positive(targetStatus, reasonCode, callback.id, callback.version);
    }
    // Any state other than SCHEDULED is treated as irreversible — both ORIGINATING/ACTIVE/
    // actual CONSUMED, and the case where this command differs in kind from the earlier terminal state (e.g. it was
    // already CANCELLED but now comes a SUPERSEDE) has no earlier effect left to change again
    if (!REVERSIBLE_STATES.has(callback.state)) {
      return tooLate('CALLBACK_IRREVERSIBLE', callback.id, callback.version);
    }

    const now = this.now();
    // The commandType of this union member still includes CANCEL_CAMPAIGN_TARGET/SUPERSEDE_CAMPAIGN_TARGET
    // (per the shared J2DialerOwnerCommandV1), so `intent` cannot be narrowed reliably — use
    // the shape of intent itself instead, because SupersedeOwnerActionIntentV1 has supersedingOutcome
    // in addition to CancelOwnerActionIntentV1
    if (!('supersedingOutcome' in command.intent)) {
      const cancelled = await transaction.obCallback.update({
        where: { id: callback.id },
        data: {
          state: 'CANCELLED',
          cancelledAt: now,
          cancelReasonCode: command.intent.reasonCode,
          version: { increment: 1 },
        },
      });
      return positive('CANCELLED', 'CALLBACK_CANCELLED', cancelled.id, cancelled.version);
    }

    const superseded = await transaction.obCallback.update({
      where: { id: callback.id },
      data: {
        state: 'SUPERSEDED',
        supersededAt: now,
        supersedingOutcomeType: command.intent.supersedingOutcome.outcomeType,
        supersedingOutcomeId: command.intent.supersedingOutcome.outcomeId,
        supersedingOutcomeVersion: command.intent.supersedingOutcome.outcomeVersion,
        version: { increment: 1 },
      },
    });
    return positive('SUPERSEDED', 'CALLBACK_SUPERSEDED', superseded.id, superseded.version);
  }
}
