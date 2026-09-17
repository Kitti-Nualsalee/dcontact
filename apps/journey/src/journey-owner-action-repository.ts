/**
 * J2.3 — durable foundation ของ owner action lifecycle (Cases/Dialer)
 *
 * Journey เก็บเฉพาะ action intent, command outbox และ result inbox ของตัวเอง —
 * ไม่เขียน canonical Case/Campaign/Callback state ตาม #121 stable business
 * `actionKey = enrollmentId:journeyVersion:stepId`; retry ต้องใช้ actionKey/
 * commandId/requestHash เดิมเสมอ (#123) ที่นี่ยังไม่มี owner implementation
 * หรือ relay transport จริง (ดู #131 ขอบเขต J2.3)
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

/** state ที่ยังรับผลจาก owner ได้ต่อ ตาม lifecycle diagram ที่ยืนยันใน #123 */
const OPEN_ACTION_STATES: JrOwnerActionState[] = [
  'PENDING',
  'DISPATCHED',
  'ACK_UNKNOWN',
  'CANCEL_REQUESTED',
];

/** state ที่ยัง cancel ได้ — ACKNOWLEDGED ไม่อยู่ในนี้เพราะ owner สร้าง entity แล้ว */
const CANCELLABLE_ACTION_STATES: JrOwnerActionState[] = ['PENDING', 'DISPATCHED', 'ACK_UNKNOWN'];

/** command ที่ยกเลิก/แทนที่ positive effect เดิม — ผลของมันตัดสิน action ที่ CANCEL_REQUESTED */
const CANCEL_COMMAND_TYPES = new Set([
  'CANCEL_CAMPAIGN_TARGET',
  'CANCEL_CALLBACK',
  'SUPERSEDE_CAMPAIGN_TARGET',
  'SUPERSEDE_CALLBACK',
]);

/**
 * J2.1 frozen contract: cancel/supersede ใช้ actionKey เดิม (`intent.originalActionKey ===
 * actionKey`) แต่ commandId ใหม่ — ไม่มีชนิด cancel ของ ENSURE_CASE เพราะ Case ที่ commit แล้ว
 * ต้องคงอยู่ (#123)
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
 * commandId ของ cancel ต้องเป็น opaque reference (≤160 ตัว) ที่คงที่ต่อ (action, request key) —
 * รวม actionKey เสมอ ไม่งั้น request key เดียวกันของคนละ action (เช่น Idempotency-Key ที่ admin
 * ใช้ซ้ำ) จะได้ commandId เดียวกันแล้ว upsert ทับเงียบ ๆ จน action ที่สองไม่มี cancel command
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
    super(`Owner action actionKey มีอยู่แล้วด้วย requestHash ต่างกัน: ${actionKey}`);
    this.name = 'OwnerActionHashConflictError';
  }
}

export interface EnsureOwnerActionInput {
  tenantId: string;
  actionKey: string;
  enrollmentId: string;
  outcomeReceiptId?: string;
  kind: JrOwnerActionKind;
  requestHash: string;
  correlationId: string;
  /** command ที่จะ dispatch พร้อมกันในธุรกรรมเดียว — ห้ามเรียก owner ระหว่าง transaction นี้ */
  commandId: string;
  /** J2OwnerCommandPayloadV1 เต็มรูปแบบพร้อม relay จริง (J2.8); undefined สำหรับ caller เก่า */
  commandPayload?: unknown;
}

export interface EnsureOwnerActionResult {
  action: JrOwnerAction;
  /** false เมื่อเป็น idempotent replay ของ actionKey เดิม — ไม่มี command ใหม่ถูกสร้าง */
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
   * idempotency key เชิงตรรกะของคำขอ cancel (เช่น Idempotency-Key ของ admin หรือ key ที่คำนวณจาก
   * actionKey) — commandId จริงคำนวณจาก key นี้เสมอ คำขอซ้ำจึงได้ command ใบเดิม
   */
  cancelRequestKey: string;
  correlationId: string;
  /** stable code ที่ owner บันทึกคู่กับการยกเลิก */
  reasonCode?: string;
  /** มีค่า = SUPERSEDE_x แทน CANCEL_x */
  supersedingOutcome?: J2OutcomeReferenceV1;
  /** admin recovery (#136) ต้องส่งมาเสมอ; caller ภายในที่ไม่ได้แข่งกับใครเว้นได้ */
  expectedVersion?: number;
}

export class OwnerActionCancellationUnavailableError extends Error {
  readonly code = 'CANCELLATION_UNAVAILABLE' as const;

  constructor(readonly actionKey: string) {
    super(`owner action ${actionKey} ไม่มี command payload ต้นฉบับให้สร้าง cancel command`);
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
    super(`ไม่พบ owner action: ${actionKey}`);
    this.name = 'OwnerActionNotFoundError';
  }
}

/** admin recovery ต้องอ้าง version ที่เห็นจริง — กัน replay ทับ state ที่ขยับไปแล้ว */
export class OwnerActionVersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT' as const;

  constructor(
    readonly actionKey: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`owner action ${actionKey} อยู่ที่ version ${actualVersion} ไม่ใช่ ${expectedVersion}`);
    this.name = 'OwnerActionVersionConflictError';
  }
}

/** state ที่ยัง replay command ได้ — terminal แล้วห้ามส่งซ้ำเด็ดขาด */
const REPLAYABLE_ACTION_STATES: JrOwnerActionState[] = [
  'PENDING',
  'DISPATCHED',
  'ACK_UNKNOWN',
  'CANCEL_REQUESTED',
];

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** JrOwnerResultKind เป็น subset ของ JrOwnerActionState เสมอ — แม็พตรงตัวโดยไม่ cast มั่ว */
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

  constructor(
    private readonly database: PrismaClient,
    options: { id?: () => string } = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  /**
   * สร้าง action + stage command แรกใน transaction เดียว — retry ด้วย actionKey/
   * requestHash เดิมคืน action เดิมโดยไม่สร้าง command ซ้ำ (idempotent ต่อ #123)
   */
  async ensureAction(
    input: EnsureOwnerActionInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<EnsureOwnerActionResult> {
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
        return { action: existing, isNew: false };
      }

      const action = await transaction.jrOwnerAction.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          actionKey: input.actionKey,
          enrollmentId: input.enrollmentId,
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

  /** command ที่ dispatch แล้ว (relay transport จริงเป็น scope ticket ถัดไป) */
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
   * apply ผลจาก owner แบบ idempotent ต่อ `(tenantId, commandId)`; terminal ที่
   * commit แล้ว (ACKNOWLEDGED/REJECTED/CANCELLED/TOO_LATE) ชนะเสมอ — ผลที่มาช้า
   * ไม่ย้อน state และไม่สร้าง Case/Campaign/Callback effect ใหม่
   */
  async applyResult(input: ApplyOwnerResultInput): Promise<ApplyOwnerResultResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
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

      // savepoint กันไม่ให้ P2002 ของ insert นี้ทำ action update ด้านบนถูก rollback
      // ไปด้วย — Postgres abort ทั้ง transaction จนกว่าจะ rollback ถ้าไม่มี savepoint
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
        // race: อีก worker แทรก result เดิมสำเร็จก่อนแล้ว — ถือเป็น duplicate ปลอดภัย
        return { outcome: 'DUPLICATE' as const, action: updated };
      }

      return {
        outcome: isOpenForResult ? ('APPLIED' as const) : ('TERMINAL_IGNORED' as const),
        action: updated,
      };
    });
  }

  /**
   * ผลที่ owner ตอบระหว่าง CANCEL_REQUESTED ต้องแยกว่ามาจาก command ไหน:
   *
   * - ผลของ positive command เดิมที่ "สำเร็จ" มาถึงก่อนผลของ cancel ห้ามปิด action เป็น
   *   ACKNOWLEDGED — ไม่งั้นผล CANCELLED ที่ตามมาจะถูกมองเป็น late result แล้ว Journey กับ owner
   *   เห็นคนละ state; เก็บ aggregate ไว้แต่รอผลของ cancel ตัดสิน
   * - cancel ที่ owner ปฏิเสธ (เช่นหา effect เดิมไม่เจอ) ไม่ได้แปลว่า action ถูก reject —
   *   ส่งเข้า RECONCILING ให้คนตรวจแทนการเดา
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
   * ขอ cancel/supersede — เฉพาะ state ที่ยัง reversible ตาม #123; state อื่นเป็น no-op idempotent
   *
   * - command ยังไม่เคยออกจาก Journey (outbox PENDING/FAILED และ action PENDING) → ยกเลิกในบ้าน
   *   ทันที command เดิมไม่ถูก dispatch และไม่ต้องรบกวน owner (#123: terminal ก่อน owner รับ)
   * - ออกไปแล้ว → stage CANCEL_x/SUPERSEDE_x ตาม contract: actionKey เดิม, commandId ใหม่ที่คำนวณ
   *   จาก `cancelRequestKey`, requestHash ของ cancel command เอง (result binding ใช้ค่านี้)
   * - ENSURE_CASE ที่ออกไปแล้วไม่มี cancel contract — Case ที่ owner อาจ commit แล้วต้องคงอยู่
   *   จึงคืน action เดิมโดยไม่เปลี่ยนอะไร
   *
   * ล็อกแถว outbox ของ action ด้วย FOR UPDATE — relay claim ด้วย SKIP LOCKED จึงหยิบ command
   * เดิมไปส่งแข่งกับการยกเลิกในบ้านไม่ได้ ถ้า relay claim ไปก่อน (PROCESSING) ถือว่าออกไปแล้ว
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
   * คืน command ของ action ให้กลับเข้าคิว relay อีกครั้ง สำหรับ admin recovery (#136)
   *
   * ไม่ใช่ blind retry: ต้องอ้าง `expectedVersion` ที่เห็นจริง, action ต้องยังไม่ terminal
   * และ `commandId` เดิมถูก reuse เสมอ — owner จึง dedupe ได้ตาม at-least-once contract
   * ของ J2.8 ไม่ใช่การสร้าง effect ใหม่
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
   * action ที่ dispatch ออกไปแล้วแต่ owner ยังเงียบเกิน deadline และยังไม่หมดโควต้า retry
   *
   * `attempts` เป็นตัวคุม bounded retry: เกินเพดานแล้วจะไม่ถูกหยิบอีก ปล่อยให้คนตัดสินใจ
   * ผ่าน admin recovery API แทนการวนเรียก owner ไปเรื่อย ๆ
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
   * DISPATCHED/ACK_UNKNOWN -> ACK_UNKNOWN พร้อมนับ attempt เพิ่มหนึ่ง
   *
   * ใช้ version guard เพื่อไม่ทับ action ที่เพิ่งได้ผลจริงระหว่างทาง — คืน null เมื่อแพ้ race
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

  findResultsFor(tenantId: string, actionKey: string): Promise<JrOwnerResultInbox[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOwnerResultInbox.findMany({
        where: { tenantId, actionKey },
        orderBy: { receivedAt: 'asc' },
      }),
    );
  }
}
