import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

/**
 * Cus360 C1 (#791) S2: command admission/receipt/reconcile per Phase Contract E1 item B
 *
 * - admission is its own transaction so GET/reconcile can really see PENDING after a crash
 * - execution holds the same command advisory lock as admission/reconcile and re-checks the receipt before the effect;
 *   business effect + audit + terminal receipt commit in one transaction
 * - a reconcile that gets the lock closes the command with REJECTED/COMMAND_NOT_APPLIED (tombstone if not yet admitted)
 *   so a late POST can never run afterwards
 * - no automatic purge; the receipt keeps only revisions/refs and no payload/PII snapshot
 */

export const C360_PROFILE_COMMAND_SCHEMA_VERSION = 1;
/** E1 G: lock_timeout/statement_timeout/transaction timeout for Cus360 mutations */
export const C360_MUTATION_LOCK_TIMEOUT = '250ms';
export const C360_MUTATION_STATEMENT_TIMEOUT = '2s';
export const C360_MUTATION_TRANSACTION_TIMEOUT_MS = 2_000;
const MAX_BUSY_RETRIES = 2;

export type C360ProfileCommandErrorCode =
  'INVALID_REQUEST' | 'COMMAND_PAYLOAD_MISMATCH' | 'COMMAND_UNKNOWN' | 'RESOURCE_BUSY';

export class C360ProfileCommandError extends Error {
  constructor(
    readonly code: C360ProfileCommandErrorCode,
    readonly httpStatus: number,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'C360ProfileCommandError';
  }
}

/**
 * A business rejection that must be recorded as a terminal receipt (e.g. revision mismatch)
 * Do not use this class for authorization failure: throw directly so no evidence is created for an unauthorized caller
 */
export class C360ProfileCommandRejection extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: 404 | 409 | 422,
  ) {
    super(code);
    this.name = 'C360ProfileCommandRejection';
  }
}

export interface C360CommandActor {
  tenantId: string;
  /** From c360ActorIdentityKey — not bound to token bytes or a browser session */
  actorIdentityKey: string;
  /** null for a trusted operator that is not a domain User */
  actorUserId: string | null;
}

export interface C360TrustedIdentity {
  issuer: string;
  subject: string;
  tenantId: string;
  userId: string | null;
}

/**
 * E1 B.1: identity key from trusted issuer/subject/domain user/tenant
 * excludes sid/client/token so the original owner can check the result after reauth with a new session
 */
export function c360ActorIdentityKey(identity: C360TrustedIdentity): string {
  if (!identity.issuer || !identity.subject)
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  return createHash('sha256')
    .update(
      JSON.stringify([
        'c360-actor-v1',
        identity.issuer,
        identity.subject,
        c360Uuid(identity.tenantId),
        identity.userId === null ? null : c360Uuid(identity.userId),
      ]),
    )
    .digest('hex');
}

export function c360Uuid(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  return value.toLowerCase();
}

/** Canonical JSON: keys sorted by code unit; rejects non-finite numbers/undefined/class instances */
export function c360CanonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(c360CanonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${c360CanonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(',')}}`;
  }
  throw new C360ProfileCommandError('INVALID_REQUEST', 400);
}

const REVISION = /^(0|[1-9][0-9]{0,18})$/;

export interface C360ProfileCommandInput {
  commandId: unknown;
  action: string;
  resourceType: string;
  resourceId: string | null;
  /** decimal strings per the R1 contract, e.g. { profile: '3' } */
  expectedRevisions: Record<string, string>;
  normalizationContractVersion: string;
  /** the request after validate + normalize per the pinned version; used only to compute the digest and never stored */
  normalizedRequest: unknown;
}

export interface C360PreparedProfileCommand {
  commandId: string;
  action: string;
  resourceType: string;
  resourceId: string | null;
  expectedRevisions: Record<string, string>;
  normalizationContractVersion: string;
  payloadDigest: string;
}

/** E1 B.2: digest covers action/resource/expected revisions/normalized request as canonical JSON */
export function prepareC360ProfileCommand(
  input: C360ProfileCommandInput,
): C360PreparedProfileCommand {
  const commandId = c360Uuid(input.commandId);
  const resourceId = input.resourceId === null ? null : c360Uuid(input.resourceId);
  if (
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.action) ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(input.resourceType) ||
    !input.normalizationContractVersion ||
    !input.expectedRevisions ||
    typeof input.expectedRevisions !== 'object' ||
    Array.isArray(input.expectedRevisions) ||
    Object.values(input.expectedRevisions).some(
      (value) =>
        typeof value !== 'string' || !REVISION.test(value) || BigInt(value) > 9223372036854775807n,
    )
  )
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  const expectedRevisions = JSON.parse(c360CanonicalJson(input.expectedRevisions)) as Record<
    string,
    string
  >;
  const descriptor = {
    schemaVersion: C360_PROFILE_COMMAND_SCHEMA_VERSION,
    action: input.action,
    resourceType: input.resourceType,
    resourceId,
    expectedRevisions,
    normalizationContractVersion: input.normalizationContractVersion,
    request: input.normalizedRequest,
  };
  return {
    commandId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId,
    expectedRevisions,
    normalizationContractVersion: input.normalizationContractVersion,
    payloadDigest: createHash('sha256').update(c360CanonicalJson(descriptor)).digest('hex'),
  };
}

export interface C360ResourceRef {
  type: string;
  id: string;
}

export interface C360AuditEvent {
  operation: string;
  resourceType: string;
  resourceId: string;
  changedFields: string[];
  beforeRevisions: Record<string, string>;
  afterRevisions: Record<string, string>;
  evidenceRefs?: string[];
}

export type C360ProfileEffect =
  | {
      outcome: 'APPLIED';
      httpStatus: 200 | 201;
      committedRevisions: Record<string, string>;
      resourceRefs: C360ResourceRef[];
      audits: C360AuditEvent[];
    }
  /** E1 B/R1: NO_OP after auth + matching revision has a receipt but no new data revision or change-audit */
  | {
      outcome: 'NO_OP';
      committedRevisions: Record<string, string>;
      resourceRefs: C360ResourceRef[];
    };

export interface C360ProfileCommandReceiptView {
  commandId: string;
  action: string | null;
  resourceType: string | null;
  resourceId: string | null;
  outcome: 'APPLIED' | 'NO_OP' | 'REJECTED';
  code: string | null;
  originalHttpStatus: number;
  committedRevisions: Record<string, string>;
  resourceRefs: C360ResourceRef[];
  committedAt: string;
  /** The success UI must read the current resource back according to permissions and not use the receipt in place of data */
  readbackRequired: boolean;
}

export type C360ProfileCommandResult =
  | { status: number; state: 'TERMINAL'; receipt: C360ProfileCommandReceiptView }
  | { status: 202; state: 'PENDING'; commandId: string }
  | { status: 404; state: 'UNKNOWN'; commandId: string };

type StoredCommandOwner = {
  resourceType?: string | null;
  resourceId?: string | null;
  actorUserId: string | null;
  action: string | null;
  isTombstone: boolean;
};

export interface C360CommandAuthorization {
  /**
   * checks the active actor/current capability inside the transaction; called again in every transaction and after the effect
   * must throw when not permitted (no receipt is created)
   */
  authorize: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Validates the command type before opening a receipt or changing state */
  /** Resource fences are used only after the command fence; the read-only lookup is called before reading the receipt */
  fence?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Checks deadline/permission after audit+receipt+constraints without any network call */
  beforeCommit?: (tx: Prisma.TransactionClient) => Promise<void>;
  canAccessCommand?: (command: StoredCommandOwner) => boolean;
  /** Collects all resource IDs before taking fences to preserve the receipt lock order */
  fenceReceiptRefs?: (tx: Prisma.TransactionClient, refs: C360ResourceRef[]) => Promise<void>;
  /** E1 B.8: refs the current reader has no permission for must not be returned */
  canReadRef?: (tx: Prisma.TransactionClient, ref: C360ResourceRef) => Promise<boolean>;
}

function ownsCommand(
  actor: C360CommandActor,
  command: StoredCommandOwner,
  authorization: C360CommandAuthorization,
): boolean {
  return (
    command.actorUserId === (actor.actorUserId?.toLowerCase() ?? null) &&
    (authorization.canAccessCommand?.(command) ?? true)
  );
}

export interface C360ProfileCommandHooks {
  /** Checkpoints are controlled by the server/tests only and must never take values from HTTP input */
  afterAdmission?: () => Promise<void>;
  afterCommandLock?: () => Promise<void>;
  afterEffect?: () => Promise<void>;
  afterCommit?: () => Promise<void>;
}

/** Transaction for a Cus360 mutation: READ COMMITTED + timeouts per E1 G */
export function c360MutationTransaction<T>(
  db: PrismaClient,
  tenantId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return withTenantDatabaseTransaction(
    db,
    tenantId,
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('lock_timeout', ${C360_MUTATION_LOCK_TIMEOUT}, true), set_config('statement_timeout', ${C360_MUTATION_STATEMENT_TIMEOUT}, true)`;
      return work(tx);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 1_000,
      timeout: C360_MUTATION_TRANSACTION_TIMEOUT_MS,
    },
  );
}

/** E1 B.3: one shared advisory namespace for admission/execution/reconcile */
export async function tryC360CommandLock(
  tx: Prisma.TransactionClient,
  actor: C360CommandActor,
  commandId: string,
): Promise<boolean> {
  const key = `c360-profile-command:${c360Uuid(actor.tenantId)}:${actor.actorIdentityKey}:${commandId}`;
  const rows = await tx.$queryRaw<
    { locked: boolean }[]
  >`SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`;
  return rows[0]?.locked === true;
}

function commandKey(actor: C360CommandActor, commandId: string) {
  return {
    tenantId: c360Uuid(actor.tenantId),
    actorIdentityKey: actor.actorIdentityKey,
    commandId,
  };
}

async function receiptView(
  tx: Prisma.TransactionClient,
  command: {
    commandId: string;
    action: string | null;
    resourceType: string | null;
    resourceId: string | null;
  },
  receipt: {
    outcome: string;
    code: string | null;
    httpStatus: number;
    committedRevisions: Prisma.JsonValue;
    resourceRefs: Prisma.JsonValue;
    committedAt: Date;
  },
  authorization: C360CommandAuthorization,
): Promise<C360ProfileCommandResult> {
  const storedRefs = receipt.resourceRefs as unknown as C360ResourceRef[];
  await authorization.fenceReceiptRefs?.(tx, [
    ...storedRefs,
    ...(command.resourceType && command.resourceId
      ? [{ type: command.resourceType, id: command.resourceId }]
      : []),
  ]);
  const refs: C360ResourceRef[] = [];
  for (const ref of storedRefs)
    if (!authorization.canReadRef || (await authorization.canReadRef(tx, ref))) refs.push(ref);
  const outcome = receipt.outcome as C360ProfileCommandReceiptView['outcome'];
  const result: C360ProfileCommandResult = {
    status: receipt.httpStatus,
    state: 'TERMINAL',
    receipt: {
      commandId: command.commandId,
      action: command.action,
      resourceType: command.resourceType,
      // the command's resourceId may point to a resource the reader no longer has permission for, so pass it through the same filter as refs
      resourceId:
        command.resourceId &&
        command.resourceType &&
        (!authorization.canReadRef ||
          (await authorization.canReadRef(tx, {
            type: command.resourceType,
            id: command.resourceId,
          })))
          ? command.resourceId
          : null,
      outcome,
      code: receipt.code,
      originalHttpStatus: receipt.httpStatus,
      committedRevisions: receipt.committedRevisions as Record<string, string>,
      resourceRefs: refs,
      committedAt: receipt.committedAt.toISOString(),
      readbackRequired: outcome !== 'REJECTED',
    },
  };
  if (authorization.beforeCommit) {
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    await authorization.beforeCommit(tx);
  }
  return result;
}

function isLockBusy(error: unknown): boolean {
  if (error instanceof C360ProfileCommandError) return error.code === 'RESOURCE_BUSY';
  // 55P03 lock_not_available (NOWAIT/lock_timeout); Prisma wraps the PG error in the message
  const text = error instanceof Error ? error.message : '';
  return /55P03|lock_not_available|could not obtain lock|canceling statement due to lock timeout/.test(
    text,
  );
}

/**
 * E1 G: retry internally at most 2 times with jitter, starting a whole new transaction
 * (re-checking auth/revisions every time); never catch and continue inside an aborted transaction
 */
async function withBusyRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isLockBusy(error)) throw error;
      if (attempt >= MAX_BUSY_RETRIES)
        throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
      await delay(25 + Math.floor(Math.random() * 50));
    }
  }
}

/**
 * Engine for Cus360 profile mutations: perform applies the effect under its own locks/fences and returns
 * APPLIED/NO_OP, or throws C360ProfileCommandRejection to record REJECTED
 */
export async function executeC360ProfileCommand(
  db: PrismaClient,
  actor: C360CommandActor,
  input: C360ProfileCommandInput,
  authorization: C360CommandAuthorization,
  perform: (
    tx: Prisma.TransactionClient,
    command: C360PreparedProfileCommand,
  ) => Promise<C360ProfileEffect>,
  hooks: C360ProfileCommandHooks = {},
): Promise<C360ProfileCommandResult> {
  const prepared = prepareC360ProfileCommand(input);
  const key = commandKey(actor, prepared.commandId);

  const admission = await withBusyRetry(() =>
    c360MutationTransaction(db, key.tenantId, async (tx) => {
      await authorization.authorize(tx);
      if (!(await tryC360CommandLock(tx, actor, key.commandId)))
        throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
      await authorization.fence?.(tx);
      const row = await tx.c360ProfileCommand.findUnique({
        where: { tenantId_actorIdentityKey_commandId: key },
      });
      if (row) {
        if (!ownsCommand(actor, row, authorization))
          throw new C360ProfileCommandError('COMMAND_PAYLOAD_MISMATCH', 409);
        const receipt = await tx.c360ProfileCommandReceipt.findUnique({
          where: { tenantId_actorIdentityKey_commandId: key },
        });
        // the tombstone has closed the key: a late POST gets the original NOT_APPLIED and does not execute
        if (row.isTombstone && receipt) return receiptView(tx, row, receipt, authorization);
        if (row.payloadDigest !== prepared.payloadDigest)
          throw new C360ProfileCommandError('COMMAND_PAYLOAD_MISMATCH', 409);
        if (receipt) return receiptView(tx, row, receipt, authorization);
        return null;
      }
      await tx.c360ProfileCommand.create({
        data: {
          ...key,
          actorUserId: actor.actorUserId,
          action: prepared.action,
          resourceType: prepared.resourceType,
          resourceId: prepared.resourceId,
          payloadDigest: prepared.payloadDigest,
          normalizationContractVersion: prepared.normalizationContractVersion,
          expectedRevisions: prepared.expectedRevisions,
        },
      });
      await authorization.beforeCommit?.(tx);
      return null;
    }),
  );
  if (admission) return admission;
  await hooks.afterAdmission?.();

  const result = await withBusyRetry(() =>
    c360MutationTransaction(db, key.tenantId, async (tx) => {
      await authorization.authorize(tx);
      if (!(await tryC360CommandLock(tx, actor, key.commandId)))
        throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
      await authorization.fence?.(tx);
      const row = await tx.c360ProfileCommand.findUniqueOrThrow({
        where: { tenantId_actorIdentityKey_commandId: key },
      });
      if (!ownsCommand(actor, row, authorization))
        throw new C360ProfileCommandError('COMMAND_PAYLOAD_MISMATCH', 409);
      const existing = await tx.c360ProfileCommandReceipt.findUnique({
        where: { tenantId_actorIdentityKey_commandId: key },
      });
      if (existing) return receiptView(tx, row, existing, authorization);
      if (row.payloadDigest !== prepared.payloadDigest)
        throw new C360ProfileCommandError('COMMAND_PAYLOAD_MISMATCH', 409);
      await hooks.afterCommandLock?.();

      await tx.$executeRawUnsafe('SAVEPOINT c360_profile_effect');
      let effect: C360ProfileEffect;
      try {
        effect = await perform(tx, prepared);
        await hooks.afterEffect?.();
      } catch (error) {
        if (!(error instanceof C360ProfileCommandRejection)) throw error;
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT c360_profile_effect');
        await authorization.authorize(tx);
        const receipt = await tx.c360ProfileCommandReceipt.create({
          data: { ...key, outcome: 'REJECTED', code: error.code, httpStatus: error.httpStatus },
        });
        return receiptView(tx, row, receipt, authorization);
      }
      // permission must still hold at the point before the effect/receipt commit
      await authorization.authorize(tx);
      if (effect.outcome === 'APPLIED') {
        for (const [ordinal, audit] of effect.audits.entries()) {
          await tx.c360ProfileAudit.create({
            data: {
              id: randomUUID(),
              ...key,
              eventOrdinal: ordinal,
              actorUserId: actor.actorUserId,
              operation: audit.operation,
              resourceType: audit.resourceType,
              resourceId: audit.resourceId,
              changedFields: audit.changedFields,
              beforeRevisions: audit.beforeRevisions,
              afterRevisions: audit.afterRevisions,
              evidenceRefs: audit.evidenceRefs ?? [],
            },
          });
        }
      }
      const receipt = await tx.c360ProfileCommandReceipt.create({
        data: {
          ...key,
          outcome: effect.outcome,
          httpStatus: effect.outcome === 'APPLIED' ? effect.httpStatus : 200,
          committedRevisions: effect.committedRevisions,
          resourceRefs: effect.resourceRefs as unknown as Prisma.InputJsonArray,
        },
      });
      return receiptView(tx, row, receipt, authorization);
    }),
  );
  await hooks.afterCommit?.();
  return result;
}

/** E1 B.4: GET receipt — PENDING when admitted but no terminal receipt yet, UNKNOWN when not found */
export async function lookupC360ProfileCommand(
  db: PrismaClient,
  actor: C360CommandActor,
  commandIdInput: unknown,
  authorization: C360CommandAuthorization,
  options?: { boundedRecovery?: boolean },
): Promise<C360ProfileCommandResult> {
  const key = commandKey(actor, c360Uuid(commandIdInput));
  const transact = options?.boundedRecovery
    ? c360MutationTransaction
    : withTenantDatabaseTransaction;
  return transact(db, key.tenantId, async (tx) => {
    await authorization.authorize(tx);
    await authorization.fence?.(tx);
    const row = await tx.c360ProfileCommand.findUnique({
      where: { tenantId_actorIdentityKey_commandId: key },
    });
    if (!row || !ownsCommand(actor, row, authorization))
      return { status: 404, state: 'UNKNOWN', commandId: key.commandId };
    const receipt = await tx.c360ProfileCommandReceipt.findUnique({
      where: { tenantId_actorIdentityKey_commandId: key },
    });
    if (!receipt) return { status: 202, state: 'PENDING', commandId: key.commandId };
    return receiptView(tx, row, receipt, authorization);
  });
}

/**
 * E1 B.4–B.5: reconcile takes only a commandId and an empty body; if the command is running it returns 202 PENDING
 * if it gets the lock and there is no terminal receipt yet, close with COMMAND_NOT_APPLIED (tombstone if not yet admitted)
 */
export async function reconcileC360ProfileCommand(
  db: PrismaClient,
  actor: C360CommandActor,
  commandIdInput: unknown,
  body: unknown,
  authorization: C360CommandAuthorization,
): Promise<C360ProfileCommandResult> {
  const commandId = c360Uuid(commandIdInput);
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 0)
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  const key = commandKey(actor, commandId);
  return c360MutationTransaction(db, key.tenantId, async (tx) => {
    await authorization.authorize(tx);
    const locked = await tryC360CommandLock(tx, actor, commandId);
    if (locked) await authorization.fence?.(tx);
    let row = await tx.c360ProfileCommand.findUnique({
      where: { tenantId_actorIdentityKey_commandId: key },
    });
    if (row && !ownsCommand(actor, row, authorization))
      return { status: 404, state: 'UNKNOWN', commandId };
    if (!locked) return { status: 202, state: 'PENDING', commandId };
    if (row) {
      const receipt = await tx.c360ProfileCommandReceipt.findUnique({
        where: { tenantId_actorIdentityKey_commandId: key },
      });
      if (receipt) return receiptView(tx, row, receipt, authorization);
    } else {
      row = await tx.c360ProfileCommand.create({
        data: { ...key, actorUserId: actor.actorUserId, isTombstone: true },
      });
    }
    const receipt = await tx.c360ProfileCommandReceipt.create({
      data: { ...key, outcome: 'REJECTED', code: 'COMMAND_NOT_APPLIED', httpStatus: 409 },
    });
    return receiptView(tx, row, receipt, authorization);
  });
}
