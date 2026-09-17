/**
 * J2.8 (#136) — durable receipt ของ Dialer owner command ที่ใช้ร่วมกันทุก command type
 *
 * J2.1 contract ให้ CANCEL_x/SUPERSEDE_x ใช้ actionKey เดิมของ positive effect แต่ commandId
 * ใหม่ receipt จึงเป็นหนึ่งใบต่อ `(tenant, commandId)`:
 *
 * - commandId เดิม + requestHash เดิม → duplicate คืนผลเดิมโดยไม่ตัดสินใหม่
 * - commandId เดิม + requestHash ต่าง → IDEMPOTENCY_CONFLICT
 * - positive command (ADMIT/SCHEDULE) ที่ actionKey เดิมแต่ commandId ใหม่และ hash ต่าง →
 *   IDEMPOTENCY_CONFLICT เช่นกัน (positive effect เดียวกันห้ามถูกขอด้วยเนื้อหาอื่น) ส่วน hash เดิม
 *   ถือเป็น duplicate; cancel/supersede ใบใหม่ของ action เดิมตัดสินใหม่ได้เสมอเพราะ idempotent
 *   ในตัว (ยกเลิกซ้ำได้ผล ALREADY_x ไม่มี effect เพิ่ม)
 *
 * ทุก command ของ action เดียวกันถูก serialize ด้วย advisory lock ของ actionKey — cancel ที่มา
 * พร้อม command ต้นเรื่องจึงเห็นผลของต้นเรื่องที่ commit แล้วเสมอ
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type ObDialerCommandInbox,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  actionKey as toActionKey,
  commandId as toCommandId,
  type J2DialerOwnerCommandV1,
  type J2FailureClass,
  type J2OwnerActionQueryV1,
  type J2OwnerCommandPersistedV1,
  type J2OwnerResultPayloadV1,
  type TenantId,
} from '@d-contact/cxa-contracts';

export class DialerCommandHashConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(readonly actionKey: string) {
    super(`Dialer command มีอยู่แล้วด้วย requestHash ต่างกัน: ${actionKey}`);
    this.name = 'DialerCommandHashConflictError';
  }
}

export interface DialerCommandDecision {
  status: J2OwnerResultPayloadV1['status'];
  code: string;
  category: string;
  reasonCode: string;
  failureClass: J2FailureClass;
  retryDisposition: string;
  recordId?: string;
  recordVersion?: number;
}

const AGGREGATE_TYPE_BY_COMMAND: Record<
  J2DialerOwnerCommandV1['commandType'],
  'campaign_target' | 'callback'
> = {
  ADMIT_CAMPAIGN_TARGET: 'campaign_target',
  CANCEL_CAMPAIGN_TARGET: 'campaign_target',
  SUPERSEDE_CAMPAIGN_TARGET: 'campaign_target',
  SCHEDULE_CALLBACK: 'callback',
  CANCEL_CALLBACK: 'callback',
  SUPERSEDE_CALLBACK: 'callback',
};

const POSITIVE_COMMAND_TYPES: ReadonlySet<string> = new Set([
  'ADMIT_CAMPAIGN_TARGET',
  'SCHEDULE_CALLBACK',
]);

export interface PersistDialerCommandOptions<TCommand extends J2DialerOwnerCommandV1> {
  database: PrismaClient;
  tenant: TenantId;
  command: TCommand;
  decide: (transaction: Prisma.TransactionClient) => Promise<DialerCommandDecision>;
  id?: () => string;
  now: () => Date;
}

export async function persistDialerCommand<TCommand extends J2DialerOwnerCommandV1>(
  options: PersistDialerCommandOptions<TCommand>,
): Promise<J2OwnerCommandPersistedV1> {
  const { tenant, command } = options;
  const id = options.id ?? randomUUID;
  await withTenantDatabaseTransaction(options.database, tenant, async (transaction) => {
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`ob-command:${tenant}:${command.actionKey}`}))`,
    );
    const existing =
      (await transaction.obDialerCommandInbox.findUnique({
        where: { tenantId_commandId: { tenantId: tenant, commandId: command.commandId } },
      })) ??
      (POSITIVE_COMMAND_TYPES.has(command.commandType)
        ? await transaction.obDialerCommandInbox.findFirst({
            where: {
              tenantId: tenant,
              actionKey: command.actionKey,
              commandType: command.commandType,
            },
          })
        : null);
    if (existing) {
      if (existing.requestHash !== command.requestHash) {
        throw new DialerCommandHashConflictError(command.actionKey);
      }
      return;
    }

    const decision = await options.decide(transaction);
    await transaction.obDialerCommandInbox.create({
      data: {
        id: id(),
        tenantId: tenant,
        commandId: command.commandId,
        actionKey: command.actionKey,
        commandType: command.commandType,
        requestHash: command.requestHash,
        status: decision.status,
        code: decision.code,
        category: decision.category,
        reasonCode: decision.reasonCode,
        failureClass: decision.failureClass,
        retryDisposition: decision.retryDisposition,
        ...(decision.recordId ? { recordId: decision.recordId } : {}),
        ...(decision.recordVersion !== undefined ? { recordVersion: decision.recordVersion } : {}),
        correlationId: command.commandId,
        observedAt: options.now(),
      },
    });
  });
  return {
    status: 'PERSISTED',
    commandId: command.commandId,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  };
}

/** receipt ของ positive command ต้นเรื่องที่ cancel/supersede อ้างถึงด้วย originalActionKey */
export function findPositiveReceipt(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  actionKey: string,
  commandType: 'ADMIT_CAMPAIGN_TARGET' | 'SCHEDULE_CALLBACK',
): Promise<ObDialerCommandInbox | null> {
  return transaction.obDialerCommandInbox.findFirst({
    where: { tenantId, actionKey, commandType },
  });
}

export function toOwnerResult(row: ObDialerCommandInbox): J2OwnerResultPayloadV1 {
  const commandType = row.commandType as J2DialerOwnerCommandV1['commandType'];
  return {
    contractVersion: 1,
    commandId: toCommandId(row.commandId),
    actionKey: toActionKey(row.actionKey),
    requestHash: row.requestHash,
    commandType,
    status: row.status as J2OwnerResultPayloadV1['status'],
    code: row.code as J2OwnerResultPayloadV1['code'],
    category: row.category as J2OwnerResultPayloadV1['category'],
    reasonCode: row.reasonCode,
    failureClass: row.failureClass as J2OwnerResultPayloadV1['failureClass'],
    retryDisposition: row.retryDisposition as J2OwnerResultPayloadV1['retryDisposition'],
    observedAt: row.observedAt.toISOString(),
    ...(row.recordId && row.recordVersion !== null
      ? {
          ownerAggregate: {
            type: AGGREGATE_TYPE_BY_COMMAND[commandType],
            id: row.recordId,
            version: row.recordVersion,
          },
        }
      : {}),
  };
}

/**
 * query ด้วย `(actionKey, requestHash)` ตาม `J2OwnerActionQueryV1` — cancel กับ command ต้นเรื่อง
 * ใช้ actionKey เดียวกันแต่ hash ต่างกัน requestHash จึงเป็นตัวแยกว่าถามถึง command ใบไหน
 */
export async function queryDialerAction(
  database: PrismaClient,
  tenant: TenantId,
  query: J2OwnerActionQueryV1,
  commandTypes: ReadonlySet<string>,
): Promise<J2OwnerResultPayloadV1 | undefined> {
  const row = await withTenantDatabaseTransaction(database, tenant, (transaction) =>
    transaction.obDialerCommandInbox.findFirst({
      where: { tenantId: tenant, actionKey: query.actionKey, requestHash: query.requestHash },
    }),
  );
  if (!row || !commandTypes.has(row.commandType)) return undefined;
  return toOwnerResult(row);
}
