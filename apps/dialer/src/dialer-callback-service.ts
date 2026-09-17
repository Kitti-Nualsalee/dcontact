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

// `commandType` ของ CANCEL_*/SUPERSEDE_* ใน J2DialerOwnerCommandV1 เป็น union ร่วมกับ
// Campaign (เช่น 'CANCEL_CAMPAIGN_TARGET' | 'CANCEL_CALLBACK') — Extract ด้วย commandType
// เดี่ยวจึงคืน never เสมอ (property ที่เป็น union ไม่ assignable กับ literal เดียว)
// ต้อง Extract ด้วย `intent` ซึ่งเป็น type เฉพาะของแต่ละ command แทน
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
/** callback ที่ยังไม่ถึงจุด irreversible ตาม #134 — state อื่นทั้งหมดตอบ TOO_LATE */
const REVERSIBLE_STATES = new Set(['SCHEDULED']);
/** ระยะเวลาที่ callback ยัง valid หลัง requestedFor ก่อนถือว่า expired */
const EXPIRY_GRACE_MS = 24 * 60 * 60 * 1_000;

/** alias คงชื่อเดิมไว้ให้ caller — receipt identity ของ Dialer ทั้งหมดอยู่ที่ dialer-command-inbox */
export { DialerCommandHashConflictError as CallbackCommandHashConflictError } from './dialer-command-inbox.js';

export class CallbackCommandNotImplementedError extends Error {
  constructor(readonly commandType: string) {
    super(`DialerCallbackService ไม่รองรับ command type นี้: ${commandType}`);
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
    // cancel/supersede ไม่ตรวจ scope ซ้ำ (ดู decideCancelOrSupersede) — ยกเลิกต้องทำได้แม้ scope ถูกถอน
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
      where: { tenantId, contactId: command.contactId, state: 'SCHEDULED', expiresAt: { gt: now } },
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
   * ไม่ตรวจ CONTACT scope ซ้ำ — การยกเลิกลดการติดต่อ และเป็นทางที่ Journey ใช้ตอน scope ถูกถอน
   * แต่ต้อง bind กับ callback เดิมจริง: contact และทีมทั้งสองต้องตรงกับที่ schedule ไว้
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
      where: { id: original.recordId, tenantId },
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
    // state อื่นที่ไม่ใช่ SCHEDULED ถือว่า irreversible แล้ว — ทั้ง ORIGINATING/ACTIVE/
    // CONSUMED จริง และกรณีที่ command นี้ต่างชนิดกับ terminal state เดิม (เช่นเคย
    // CANCELLED ไปแล้วแต่มา SUPERSEDE) ไม่มี effect เดิมให้แก้ไขซ้ำอีก
    if (!REVERSIBLE_STATES.has(callback.state)) {
      return tooLate('CALLBACK_IRREVERSIBLE', callback.id, callback.version);
    }

    const now = this.now();
    // commandType ของ union member นี้ยังรวม CANCEL_CAMPAIGN_TARGET/SUPERSEDE_CAMPAIGN_TARGET
    // อยู่ (ตาม shared J2DialerOwnerCommandV1) จึงไม่ narrow `intent` ให้แน่นอนได้ — ใช้
    // shape ของ intent เองแทน เพราะ SupersedeOwnerActionIntentV1 มี supersedingOutcome
    // เพิ่มจาก CancelOwnerActionIntentV1 จริง ๆ
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
