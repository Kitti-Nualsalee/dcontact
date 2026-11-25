/**
 * J2.8 (#136) — the durable receipt of a Dialer owner command, shared by every command type
 *
 * The J2.1 contract has CANCEL_x/SUPERSEDE_x use the original actionKey of the positive effect but a new commandId,
 * so a receipt is one per `(tenant, commandId)`:
 *
 * - same commandId + same requestHash → duplicate, returns the earlier result without deciding again
 * - same commandId + different requestHash → IDEMPOTENCY_CONFLICT
 * - positive command (ADMIT/SCHEDULE) with the same actionKey but a new commandId and a different hash →
 *   IDEMPOTENCY_CONFLICT as well (the same positive effect must not be requested with other content); the same hash
 *   counts as a duplicate; a new cancel/supersede of the same action can always be decided again because it is idempotent
 *   by nature (a repeated cancel gives ALREADY_x with no extra effect)
 *
 * Every command of the same action is serialized by an advisory lock on the actionKey — a cancel that arrives
 * together with the originating command therefore always sees the committed result of the originating command
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type ObDialerCommandInbox,
  type PrismaClient,
  withTenantDatabaseTransaction,
  lockTeamReferences,
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
    super(`Dialer command already exists with a different requestHash: ${actionKey}`);
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
    await lockTeamReferences(transaction, tenant, [
      command.sourceOwnerTeamId,
      command.targetOwnerTeamId,
    ]);
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

/** The receipt of the originating positive command that cancel/supersede references via originalActionKey */
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
 * Queries by `(actionKey, requestHash)` per `J2OwnerActionQueryV1` — a cancel and its originating command
 * share the same actionKey but have different hashes, so requestHash tells which command is being asked about
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
