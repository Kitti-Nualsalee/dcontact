import { createHash } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  findTenantConfigurationActor,
  type TenantConfigurationIdentity,
} from './tenant-config-identity.js';
import { CoreError, coreFail } from './tenant-core-errors.js';

export type CoreIdentity = TenantConfigurationIdentity;
export function coreUuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    coreFail('INVALID_REQUEST', 400);
  return value.toLowerCase();
}
export function coreIdentityKey(identity: CoreIdentity): string {
  if (!identity.caller) coreFail('CORE_ACCESS_DENIED', 403);
  const { issuer, subject, clientId } = identity.caller;
  return createHash('sha256')
    .update(
      JSON.stringify([
        issuer,
        subject,
        clientId,
        coreUuid(identity.tenantId),
        coreUuid(identity.userId),
      ]),
    )
    .digest('hex');
}
export function coreTransaction<T>(
  db: PrismaClient,
  tenantId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return withTenantDatabaseTransaction(
    db,
    tenantId,
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout','250ms',true),set_config('statement_timeout','2s',true)`;
      const result = await work(tx);
      // บังคับ deferred constraints ภายใน callback ก่อนนำผลไปตอบผู้เรียก
      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      return result;
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1000,
      timeout: 5000,
    },
  );
}
export async function coreActor(
  tx: Prisma.TransactionClient,
  identity: CoreIdentity,
  write = true,
) {
  const actor = await findTenantConfigurationActor(tx, identity, true);
  if (!actor || (write && actor.role !== 'ADMIN')) coreFail('CORE_ACCESS_DENIED', 403);
  return actor;
}
export async function lookupCoreCommand(db: PrismaClient, identity: CoreIdentity, id: unknown) {
  const commandId = coreUuid(id);
  return coreTransaction(db, identity.tenantId, async (tx) => {
    await coreActor(tx, identity);
    const row = await tx.tenantCoreCommand.findUnique({
      where: {
        tenantId_actorIdentityKey_commandId: {
          tenantId: identity.tenantId,
          actorIdentityKey: coreIdentityKey(identity),
          commandId,
        },
      },
      include: { receipt: true },
    });
    if (!row) coreFail('COMMAND_UNKNOWN', 404, { retryable: true });
    if (!row.receipt) return { status: 202, body: { state: 'ADMITTED', commandId } };
    return { status: 200, body: coreReceipt(row, row.receipt) };
  });
}
export function coreReceipt(
  command: {
    commandId: string;
    action: string | null;
    resourceType: string | null;
    resourceId: string | null;
  },
  receipt: {
    outcome: string;
    committedRevision: bigint | null;
    resourceSnapshot: unknown;
    httpStatus: number;
    error: unknown;
    createdAt: Date;
  },
) {
  return {
    command: {
      id: command.commandId,
      action: command.action,
      resourceType: command.resourceType,
      resourceId: command.resourceId,
      outcome: receipt.outcome,
      committedRevision: receipt.committedRevision?.toString() ?? null,
      committedAt: receipt.createdAt.toISOString(),
      resourceSnapshot: receipt.resourceSnapshot,
      originalHttpStatus: receipt.httpStatus,
      error: receipt.error,
    },
    readbackRequired: receipt.outcome === 'APPLIED' || receipt.outcome === 'NO_OP',
  };
}

export async function coreCommandLock(
  tx: Prisma.TransactionClient,
  identity: CoreIdentity,
  commandId: string,
) {
  const key = `core-command:${coreUuid(identity.tenantId)}:${coreIdentityKey(identity)}:${commandId}`;
  const rows = await tx.$queryRaw<
    { locked: boolean }[]
  >`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS locked`;
  return rows[0]?.locked === true;
}
export async function reconcileCoreCommand(
  db: PrismaClient,
  identity: CoreIdentity,
  id: unknown,
  body: unknown,
) {
  const commandId = coreUuid(id);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0)
    coreFail('INVALID_REQUEST', 400);
  return coreTransaction(db, identity.tenantId, async (tx) => {
    const actor = await coreActor(tx, identity);
    if (!(await coreCommandLock(tx, identity, commandId)))
      return { status: 202, body: { state: 'PENDING', commandId } };
    const key = {
      tenantId: identity.tenantId,
      actorIdentityKey: coreIdentityKey(identity),
      commandId,
    };
    let row = await tx.tenantCoreCommand.findUnique({
      where: { tenantId_actorIdentityKey_commandId: key },
      include: { receipt: true },
    });
    if (row?.receipt) return { status: 200, body: coreReceipt(row, row.receipt) };
    if (!row)
      row = await tx.tenantCoreCommand.create({
        data: { ...key, actorUserId: actor.id, isTombstone: true },
        include: { receipt: true },
      });
    const receipt = await tx.tenantCoreCommandReceipt.create({
      data: { ...key, outcome: 'NOT_APPLIED', httpStatus: 409 },
    });
    return { status: 200, body: coreReceipt(row, receipt) };
  });
}

export type CoreAction = 'ORGANIZATION_UPDATE' | 'TEAM_CREATE' | 'TEAM_RENAME' | 'TEAM_DEACTIVATE';
export interface CorePreparedCommand {
  commandId: string;
  action: CoreAction;
  resourceType: 'ORGANIZATION' | 'TEAM';
  resourceId: string;
  expectedRevision: string | null;
  payload: Prisma.InputJsonObject;
  payloadDigest: string;
}
export interface CoreCommandOptions {
  /** Checkpoints ควบคุมโดย server/tests เท่านั้น ห้ามรับค่าจาก HTTP input */
  afterAdmission?: () => Promise<void>;
  afterCommandLock?: () => Promise<void>;
  afterEffect?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
}
export type CoreExecution =
  | { outcome: 'NO_OP'; revision: bigint; snapshot: Prisma.InputJsonObject }
  | {
      outcome: 'APPLIED';
      revision: bigint;
      beforeRevision: bigint | null;
      before: Prisma.InputJsonObject | null;
      snapshot: Prisma.InputJsonObject;
    };
export function coreCanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(coreCanonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${coreCanonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  coreFail('INVALID_REQUEST', 400);
}
export function prepareCoreCommand(input: {
  commandId: unknown;
  action: CoreAction;
  resourceType: 'ORGANIZATION' | 'TEAM';
  resourceId: unknown;
  expectedRevision: unknown;
  payload: Prisma.InputJsonObject;
}): CorePreparedCommand {
  const commandId = coreUuid(input.commandId);
  const resourceId = coreUuid(input.resourceId);
  const create = input.action === 'TEAM_CREATE';
  if (
    !['ORGANIZATION_UPDATE', 'TEAM_CREATE', 'TEAM_RENAME', 'TEAM_DEACTIVATE'].includes(
      input.action,
    ) ||
    input.resourceType !== (input.action === 'ORGANIZATION_UPDATE' ? 'ORGANIZATION' : 'TEAM')
  )
    coreFail('INVALID_REQUEST', 400);
  let expectedRevision: string | null = null;
  if (create) {
    if (input.expectedRevision !== null) coreFail('INVALID_REQUEST', 400);
  } else {
    if (
      typeof input.expectedRevision !== 'string' ||
      !/^(0|[1-9][0-9]*)$/.test(input.expectedRevision) ||
      input.expectedRevision.length > 19 ||
      BigInt(input.expectedRevision) > 9223372036854775807n ||
      (input.resourceType === 'TEAM' && input.expectedRevision === '0')
    )
      coreFail('INVALID_REQUEST', 400);
    expectedRevision = input.expectedRevision;
  }
  const payload = JSON.parse(coreCanonicalJson(input.payload)) as Prisma.InputJsonObject;
  const descriptor = {
    schemaVersion: 1,
    action: input.action,
    resourceId,
    expectedRevision,
    patch: payload,
  };
  return {
    commandId,
    resourceId,
    action: input.action,
    resourceType: input.resourceType,
    expectedRevision,
    payload,
    payloadDigest: createHash('sha256').update(coreCanonicalJson(descriptor)).digest('hex'),
  };
}
function mutationResult(
  command: Parameters<typeof coreReceipt>[0],
  receipt: Parameters<typeof coreReceipt>[1],
  identity: CoreIdentity,
) {
  const body = coreReceipt(command, receipt);
  const error =
    receipt.outcome === 'NOT_APPLIED'
      ? {
          code: 'COMMAND_NOT_APPLIED',
          messageKey: 'core.errors.COMMAND_NOT_APPLIED',
          retryable: false,
        }
      : receipt.error;
  return {
    status: receipt.httpStatus,
    body: { ...body, ...(error ? { error, requestId: identity.correlationId } : {}) },
  };
}

/** Engine สำหรับ resource APIs: admission อยู่ถาวร และ execution แต่ละรอบเป็น atomic unit */
export async function executeCoreCommand(
  db: PrismaClient,
  identity: CoreIdentity,
  command: CorePreparedCommand,
  perform: (tx: Prisma.TransactionClient) => Promise<CoreExecution>,
  options: CoreCommandOptions = {},
) {
  // เตรียมข้อมูลใหม่ที่ขอบเขต engine เพื่อไม่เชื่อ digest/metadata จาก object ที่ผู้เรียกเปลี่ยนได้
  const prepared = prepareCoreCommand(command);
  const key = {
    tenantId: coreUuid(identity.tenantId),
    actorIdentityKey: coreIdentityKey(identity),
    commandId: prepared.commandId,
  };
  const admission = await coreTransaction(db, identity.tenantId, async (tx) => {
    const actor = await coreActor(tx, identity);
    if (!(await coreCommandLock(tx, identity, key.commandId)))
      coreFail('CONFIG_BUSY', 409, { retryable: true });
    let row = await tx.tenantCoreCommand.findUnique({
      where: { tenantId_actorIdentityKey_commandId: key },
      include: { receipt: true },
    });
    if (row?.isTombstone && row.receipt) return mutationResult(row, row.receipt, identity);
    if (row && row.payloadDigest !== prepared.payloadDigest)
      coreFail('COMMAND_PAYLOAD_MISMATCH', 409);
    if (row?.receipt) return mutationResult(row, row.receipt, identity);
    if (!row) {
      row = await tx.tenantCoreCommand.create({
        data: {
          ...key,
          actorUserId: actor.id,
          action: prepared.action,
          resourceType: prepared.resourceType,
          resourceId: prepared.resourceId,
          expectedRevision:
            prepared.expectedRevision === null ? null : BigInt(prepared.expectedRevision),
          payloadDigest: prepared.payloadDigest,
        },
        include: { receipt: true },
      });
    }
    return null;
  });
  if (admission) return admission;
  await options.afterAdmission?.();
  const result = await coreTransaction(db, identity.tenantId, async (tx) => {
    const actor = await coreActor(tx, identity);
    if (!(await coreCommandLock(tx, identity, key.commandId)))
      coreFail('CONFIG_BUSY', 409, { retryable: true });
    const row = await tx.tenantCoreCommand.findUniqueOrThrow({
      where: { tenantId_actorIdentityKey_commandId: key },
      include: { receipt: true },
    });
    if (row.receipt) return mutationResult(row, row.receipt, identity);
    if (row.payloadDigest !== prepared.payloadDigest) coreFail('COMMAND_PAYLOAD_MISMATCH', 409);
    await options.afterCommandLock?.();
    await tx.$executeRawUnsafe('SAVEPOINT core_resource_mutation');
    let effect: CoreExecution;
    try {
      effect = await perform(tx);
      await options.afterEffect?.();
    } catch (error) {
      if (
        !(error instanceof CoreError) ||
        ![404, 409, 422].includes(error.status) ||
        error.detail.retryable
      )
        throw error;
      await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT core_resource_mutation');
      const receipt = await tx.tenantCoreCommandReceipt.create({
        data: {
          ...key,
          outcome: 'REJECTED',
          httpStatus: error.status,
          error: error.detail as unknown as Prisma.InputJsonObject,
        },
      });
      return mutationResult(row, receipt, identity);
    }
    await coreActor(tx, identity);
    if (effect.outcome === 'APPLIED') {
      await tx.tenantCoreConfigAudit.create({
        data: {
          ...key,
          actorUserId: actor.id,
          action: prepared.action,
          resourceType: prepared.resourceType,
          resourceId: prepared.resourceId,
          beforeRevision: effect.beforeRevision,
          afterRevision: effect.revision,
          beforeValues: effect.before === null ? Prisma.DbNull : effect.before,
          afterValues: effect.snapshot,
        },
      });
    }
    const receipt = await tx.tenantCoreCommandReceipt.create({
      data: {
        ...key,
        outcome: effect.outcome,
        committedRevision: effect.revision,
        resourceSnapshot: effect.snapshot,
        httpStatus: prepared.action === 'TEAM_CREATE' ? 201 : 200,
      },
    });
    return mutationResult(row, receipt, identity);
  });
  await options.afterCommit?.();
  return result;
}
