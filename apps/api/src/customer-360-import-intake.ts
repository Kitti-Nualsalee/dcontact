import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  authorizeC360ContactCreate,
  C360ImportCsvError,
  C360ImportMappingError,
  C360ProfileCommandError,
  C360ProfileCommandRejection,
  C360_PROFILE_RULE_VERSION,
  c360MutationTransaction,
  c360Uuid,
  executeC360ProfileCommand,
  lookupC360ProfileCommand,
  parseC360ImportCsv,
  prepareC360ProfileCommand,
  tryC360CommandLock,
  validateC360ImportMapping,
  type C360CommandActor,
  type C360CommandAuthorization,
  type C360ImportMapping,
  type C360ProfileCommandResult,
  type C360VerifiedActor,
} from '@d-contact/customer-360';
import {
  c360CurrentActor,
  commandActor,
  Customer360HttpError,
  type C360RequestIdentity,
} from './customer-360-api.js';
import {
  C360ImportObjectStorage,
  type C360ImportObjectIdentity,
} from './customer-360-import-storage.js';

/** job id เสถียรต่อ actor/command โดยไม่มี token, filename หรือข้อมูลใน CSV */
function importJobId(actor: C360CommandActor, commandId: string): string {
  const bytes = createHash('sha256')
    .update(
      JSON.stringify(['c360-import-job-v1', actor.tenantId, actor.actorIdentityKey, commandId]),
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** จำกัดเฉพาะ original actor ที่ยัง active และถือ create capability ปัจจุบัน */
function importAuthorization(identity: C360RequestIdentity): C360CommandAuthorization {
  let current: C360VerifiedActor | undefined;
  return {
    async authorize(tx) {
      current = await c360CurrentActor(tx, identity);
      if (current.role !== 'ADMIN' || !(await authorizeC360ContactCreate(tx, current)))
        throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
    },
    async fence(tx) {
      const tenants = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM tenants WHERE id=${identity.tenantId}::uuid AND lifecycle_status::text='ACTIVE' FOR SHARE NOWAIT`;
      if (!tenants.length) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      const rows = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM users WHERE tenant_id=${identity.tenantId}::uuid AND id=${identity.userId}::uuid FOR NO KEY UPDATE NOWAIT`;
      if (!rows.length) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      current = await c360CurrentActor(tx, identity);
      if (current.role !== 'ADMIN' || !(await authorizeC360ContactCreate(tx, current)))
        throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
    },
    async canReadRef(tx, ref) {
      if (ref.type !== 'IMPORT_JOB' || !current) return false;
      const job = await tx.c360ImportJob.findUnique({
        where: { tenantId_id: { tenantId: identity.tenantId, id: ref.id } },
      });
      return (
        !!job &&
        job.ownerUserId === identity.userId &&
        job.actorIdentityKey === commandActor(identity).actorIdentityKey
      );
    },
  };
}

/**
 * Admission และ receipt ใช้ command engine ของ C4; object upload อยู่นอก transaction.
 * Attempt ที่ attach ไม่สำเร็จยังคง durable เพื่อให้ cleanup กวาดซ้ำได้
 * และห้ามเรียก service นี้จาก HTTP จนมี owner/expiry/cleanup paths และ tests ครบ.
 */
export async function admitC360Import(input: {
  db: PrismaClient;
  storage: C360ImportObjectStorage;
  identity: C360RequestIdentity;
  commandId: unknown;
  bytes: Buffer;
}): Promise<C360ProfileCommandResult> {
  const { db, storage, identity } = input;
  const commandId = c360Uuid(input.commandId);
  try {
    parseC360ImportCsv(input.bytes);
  } catch (error) {
    if (error instanceof C360ImportCsvError)
      throw new Customer360HttpError(
        error.code === 'IMPORT_LIMIT_EXCEEDED' ? 413 : 400,
        error.code,
      );
    throw error;
  }
  const actor = commandActor(identity);
  const jobId = importJobId(actor, commandId);
  const sourceDigest = createHash('sha256').update(input.bytes).digest('hex');
  const authorization = importAuthorization(identity);
  let attempt: C360ImportObjectIdentity | undefined;
  return executeC360ProfileCommand(
    db,
    actor,
    {
      commandId,
      action: 'IMPORT_UPLOAD',
      resourceType: 'IMPORT_JOB',
      resourceId: jobId,
      expectedRevisions: {},
      normalizationContractVersion: C360_PROFILE_RULE_VERSION,
      normalizedRequest: { sourceDigest, sourceBytes: input.bytes.byteLength },
    },
    authorization,
    async (tx) => {
      if (!attempt) throw new C360ProfileCommandRejection('JOB_STATE_CONFLICT', 409);
      const [job] = await tx.$queryRaw<
        { state: string; source_expires_at: Date }[]
      >`SELECT state, source_expires_at FROM c360_import_jobs WHERE tenant_id=${identity.tenantId}::uuid AND id=${jobId}::uuid FOR UPDATE`;
      if (!job || job.state !== 'UPLOADING')
        throw new C360ProfileCommandRejection('JOB_STATE_CONFLICT', 409);
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock || job.source_expires_at <= clock.now)
        throw new C360ProfileCommandRejection('SOURCE_EXPIRED', 410);
      const updated = await tx.c360ImportUploadAttempt.updateMany({
        where: {
          tenantId: identity.tenantId,
          jobId,
          objectId: attempt.objectId,
          state: 'UPLOADING',
          sourceDigest,
          sourceBytes: input.bytes.byteLength,
        },
        data: { state: 'ATTACHED' },
      });
      if (updated.count !== 1) throw new C360ProfileCommandRejection('JOB_STATE_CONFLICT', 409);
      await tx.c360ImportJob.update({
        where: { tenantId_id: { tenantId: identity.tenantId, id: jobId } },
        data: {
          state: 'DRAFT',
          sourceObjectId: attempt.objectId,
          sourceDigest,
          sourceBytes: input.bytes.byteLength,
        },
      });
      await tx.c360ImportControlAudit.create({
        data: {
          tenantId: identity.tenantId,
          id: randomUUID(),
          jobId,
          actorUserId: identity.userId,
          commandId,
          action: 'IMPORT_UPLOAD',
        },
      });
      return {
        outcome: 'APPLIED',
        httpStatus: 201,
        committedRevisions: { job: '0' },
        resourceRefs: [{ type: 'IMPORT_JOB', id: jobId }],
        audits: [],
      };
    },
    {
      async afterAdmission() {
        attempt = await c360MutationTransaction(db, identity.tenantId, async (tx) => {
          await authorization.authorize(tx);
          if (!(await tryC360CommandLock(tx, actor, commandId)))
            throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
          await authorization.fence?.(tx);
          const key = {
            tenantId: identity.tenantId,
            actorIdentityKey: actor.actorIdentityKey,
            commandId,
          };
          const receipt = await tx.c360ProfileCommandReceipt.findUnique({
            where: { tenantId_actorIdentityKey_commandId: key },
          });
          if (receipt) return undefined;
          const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
          if (!clock) throw new Customer360HttpError(503, 'RESOURCE_BUSY', true);
          let job = await tx.c360ImportJob.findUnique({
            where: { tenantId_id: { tenantId: identity.tenantId, id: jobId } },
          });
          if (!job) {
            job = await tx.c360ImportJob.create({
              data: {
                tenantId: identity.tenantId,
                id: jobId,
                ownerUserId: identity.userId,
                actorIdentityKey: actor.actorIdentityKey,
                state: 'UPLOADING',
                createdAt: clock.now,
                sourceExpiresAt: new Date(clock.now.getTime() + 24 * 60 * 60 * 1000),
              },
            });
          }
          if (
            job.ownerUserId !== identity.userId ||
            job.actorIdentityKey !== actor.actorIdentityKey ||
            job.state !== 'UPLOADING'
          )
            throw new Customer360HttpError(409, 'JOB_STATE_CONFLICT');
          if (job.sourceExpiresAt <= clock.now)
            throw new Customer360HttpError(410, 'SOURCE_EXPIRED');
          const objectId = randomUUID();
          await tx.c360ImportUploadAttempt.create({
            data: {
              tenantId: identity.tenantId,
              jobId,
              objectId,
              state: 'UPLOADING',
              sourceDigest,
              sourceBytes: input.bytes.byteLength,
              createdAt: clock.now,
              expiresAt: job.sourceExpiresAt,
            },
          });
          return { tenantId: identity.tenantId, jobId, objectId };
        });
        if (!attempt) return;
        try {
          await storage.put(attempt, input.bytes);
        } catch {
          // ผล PUT อาจสำเร็จที่ provider แม้ client เห็น timeout: ปล่อย durable attempt ให้ cleanup
          throw new Customer360HttpError(503, 'STORAGE_UNAVAILABLE', true);
        }
      },
    },
  );
}

/** Mapping validation อ่าน source นอก DB lock และตรวจ owner/revision/source ซ้ำก่อน commit */
export async function updateC360ImportMapping(input: {
  db: PrismaClient;
  storage: C360ImportObjectStorage;
  identity: C360RequestIdentity;
  jobId: unknown;
  commandId: unknown;
  expectedRevision: unknown;
  mapping: unknown;
}): Promise<C360ProfileCommandResult> {
  const { db, storage, identity } = input;
  const jobId = c360Uuid(input.jobId);
  const commandId = c360Uuid(input.commandId);
  if (
    typeof input.expectedRevision !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(input.expectedRevision) ||
    BigInt(input.expectedRevision) > 9223372036854775807n
  )
    throw new Customer360HttpError(400, 'INVALID_REQUEST');
  const actor = commandActor(identity);
  const authorization = importAuthorization(identity);
  // Validate shape before replay without loading the expired or unavailable private source.
  // Actual header membership is checked below for new commands.
  let mapping: C360ImportMapping;
  try {
    const columns = (input.mapping as { columns?: unknown } | null)?.columns;
    const headers =
      columns && typeof columns === 'object' && !Array.isArray(columns)
        ? Object.values(columns).filter((value): value is string => typeof value === 'string')
        : [];
    mapping = validateC360ImportMapping(input.mapping, headers);
  } catch (error) {
    if (error instanceof C360ImportMappingError)
      throw new Customer360HttpError(400, 'MAPPING_INVALID');
    throw error;
  }
  const snapshot = await c360MutationTransaction(db, identity.tenantId, async (tx) => {
    await authorization.authorize(tx);
    await authorization.fence?.(tx);
    const job = await tx.c360ImportJob.findUnique({
      where: { tenantId_id: { tenantId: identity.tenantId, id: jobId } },
    });
    if (
      !job ||
      job.ownerUserId !== identity.userId ||
      job.actorIdentityKey !== actor.actorIdentityKey
    )
      throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
    if (job.sourceDigest) {
      const prepared = prepareC360ProfileCommand({
        commandId,
        action: 'IMPORT_MAPPING',
        resourceType: 'IMPORT_JOB',
        resourceId: jobId,
        expectedRevisions: { job: input.expectedRevision as string },
        normalizationContractVersion: C360_PROFILE_RULE_VERSION,
        normalizedRequest: { mapping, sourceDigest: job.sourceDigest },
      });
      const key = {
        tenantId: identity.tenantId,
        actorIdentityKey: actor.actorIdentityKey,
        commandId,
      };
      const command = await tx.c360ProfileCommand.findUnique({
        where: { tenantId_actorIdentityKey_commandId: key },
      });
      if (command) {
        if (command.actorUserId !== identity.userId)
          throw new C360ProfileCommandError('COMMAND_PAYLOAD_MISMATCH', 409);
        const receipt = await tx.c360ProfileCommandReceipt.findUnique({
          where: { tenantId_actorIdentityKey_commandId: key },
        });
        if (command.isTombstone && receipt) return { replay: true as const };
        if (command.payloadDigest !== prepared.payloadDigest)
          throw new C360ProfileCommandError('COMMAND_PAYLOAD_MISMATCH', 409);
        if (receipt) return { replay: true as const };
      }
    }
    const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    if (!clock || clock.now >= job.sourceExpiresAt)
      throw new Customer360HttpError(410, 'SOURCE_EXPIRED');
    if (!job.sourceObjectId || !job.sourceDigest || !['DRAFT', 'READY'].includes(job.state))
      throw new Customer360HttpError(409, 'JOB_STATE_CONFLICT');
    return { replay: false as const, objectId: job.sourceObjectId, digest: job.sourceDigest };
  });
  if (snapshot.replay) return lookupC360ProfileCommand(db, actor, commandId, authorization);
  const storageFailure = async (): Promise<never> => {
    await c360MutationTransaction(db, identity.tenantId, async (tx) => {
      await authorization.authorize(tx);
      await authorization.fence?.(tx);
      const job = await tx.c360ImportJob.findUnique({
        where: { tenantId_id: { tenantId: identity.tenantId, id: jobId } },
      });
      if (
        !job ||
        job.ownerUserId !== identity.userId ||
        job.actorIdentityKey !== actor.actorIdentityKey
      )
        throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock || clock.now >= job.sourceExpiresAt)
        throw new Customer360HttpError(410, 'SOURCE_EXPIRED');
    });
    throw new Customer360HttpError(503, 'STORAGE_UNAVAILABLE', true);
  };
  let source: Uint8Array | null;
  try {
    source = await storage.get(
      { tenantId: identity.tenantId, jobId, objectId: snapshot.objectId },
      snapshot.digest,
    );
  } catch {
    return storageFailure();
  }
  if (!source) return storageFailure();
  try {
    mapping = validateC360ImportMapping(mapping, parseC360ImportCsv(source).headers);
  } catch (error) {
    if (error instanceof C360ImportMappingError)
      throw new Customer360HttpError(400, 'MAPPING_INVALID');
    if (error instanceof C360ImportCsvError)
      throw new Customer360HttpError(503, 'STORAGE_UNAVAILABLE', true);
    throw error;
  }
  const appliedTransactions = new WeakSet<object>();
  authorization.beforeCommit = async (tx) => {
    if (!appliedTransactions.has(tx)) return;
    const [row] = await tx.$queryRaw<
      { valid: boolean }[]
    >`SELECT source_expires_at > clock_timestamp() AS valid FROM c360_import_jobs WHERE tenant_id=${identity.tenantId}::uuid AND id=${jobId}::uuid`;
    if (!row?.valid) throw new Customer360HttpError(410, 'SOURCE_EXPIRED');
  };
  return executeC360ProfileCommand(
    db,
    actor,
    {
      commandId,
      action: 'IMPORT_MAPPING',
      resourceType: 'IMPORT_JOB',
      resourceId: jobId,
      expectedRevisions: { job: input.expectedRevision },
      normalizationContractVersion: C360_PROFILE_RULE_VERSION,
      normalizedRequest: { mapping, sourceDigest: snapshot.digest },
    },
    authorization,
    async (tx) => {
      const [row] = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM c360_import_jobs WHERE tenant_id=${identity.tenantId}::uuid AND id=${jobId}::uuid FOR UPDATE`;
      if (!row) throw new C360ProfileCommandRejection('RESOURCE_NOT_FOUND', 404);
      const job = await tx.c360ImportJob.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: identity.tenantId, id: jobId } },
      });
      if (job.ownerUserId !== identity.userId || job.actorIdentityKey !== actor.actorIdentityKey)
        throw new C360ProfileCommandRejection('RESOURCE_NOT_FOUND', 404);
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock || clock.now >= job.sourceExpiresAt)
        throw new C360ProfileCommandRejection('SOURCE_EXPIRED', 410);
      if (job.revision !== BigInt(input.expectedRevision as string))
        throw new C360ProfileCommandRejection('JOB_REVISION_CONFLICT', 409);
      if (
        !['DRAFT', 'READY'].includes(job.state) ||
        job.sourceObjectId !== snapshot.objectId ||
        job.sourceDigest !== snapshot.digest
      )
        throw new C360ProfileCommandRejection('JOB_STATE_CONFLICT', 409);
      const next = job.revision + 1n;
      await tx.c360ImportJob.update({
        where: { tenantId_id: { tenantId: identity.tenantId, id: jobId } },
        data: {
          revision: next,
          state: 'DRAFT',
          mapping: mapping as unknown as Prisma.InputJsonObject,
          rulesVersion: C360_PROFILE_RULE_VERSION,
          confirmedPlanHash: null,
        },
      });
      await tx.c360ImportControlAudit.create({
        data: {
          tenantId: identity.tenantId,
          id: randomUUID(),
          jobId,
          actorUserId: identity.userId,
          commandId,
          action: 'IMPORT_MAPPING',
        },
      });
      appliedTransactions.add(tx);
      return {
        outcome: 'APPLIED',
        httpStatus: 200,
        committedRevisions: { job: next.toString() },
        resourceRefs: [{ type: 'IMPORT_JOB', id: jobId }],
        audits: [],
      };
    },
  );
}
