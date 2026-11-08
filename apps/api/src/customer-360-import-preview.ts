import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  authorizeC360ContactCreate,
  c360FilterDigest,
  c360ReadableContactSql,
  c360ScopeDigest,
  c360Uuid,
  createC360ImportDuplicateAuthority,
  openC360ImportPreviewRef,
  openC360ImportRowsCursor,
  prepareC360ImportPreview,
  sealC360ImportPreviewRef,
  sealC360ImportRowsCursor,
  type C360CursorCodec,
} from '@d-contact/customer-360';
import {
  c360CurrentActor,
  commandActor,
  Customer360HttpError,
  type C360RequestIdentity,
} from './customer-360-api.js';
import { C360ImportObjectStorage } from './customer-360-import-storage.js';
import { findTenantConfigurationActor } from './tenant-config-identity.js';

/** ผลมี raw cells ต้องส่งเฉพาะ owner ที่ผ่าน auth; ห้ามเก็บลง log/receipt */
export async function readC360ImportPreview(input: {
  db: PrismaClient;
  storage: C360ImportObjectStorage;
  identity: C360RequestIdentity;
  codec: C360CursorCodec;
  jobId: unknown;
  limit?: unknown;
  previewRef?: string;
  cursor?: string;
  /** Checkpoints ของ integration test เท่านั้น ห้ามนำค่าจาก HTTP มาใส่ */
  hooks?: { afterInitialFingerprint?: () => Promise<void>; beforeFinalClock?: () => Promise<void> };
}) {
  const { db, storage, identity, codec } = input;
  const jobId = c360Uuid(input.jobId);
  const limit = input.limit ?? 20;
  if (
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (input.cursor !== undefined && !input.previewRef)
  )
    throw new Customer360HttpError(400, 'INVALID_REQUEST');
  const key = commandActor(identity).actorIdentityKey;
  const load = async () =>
    withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      if (actor.role !== 'ADMIN' || !(await authorizeC360ContactCreate(tx, actor)))
        throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      const job = await tx.c360ImportJob.findUnique({
        where: { tenantId_id: { tenantId: identity.tenantId, id: jobId } },
      });
      if (!job || job.ownerUserId !== identity.userId || job.actorIdentityKey !== key)
        throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!clock || clock.now >= job.sourceExpiresAt)
        throw new Customer360HttpError(410, 'SOURCE_EXPIRED');
      if (
        !job.sourceObjectId ||
        !job.sourceDigest ||
        !job.mapping ||
        !['DRAFT', 'READY'].includes(job.state)
      )
        throw new Customer360HttpError(409, 'JOB_STATE_CONFLICT');
      return { job, actor };
    });
  const snapshot = await load();
  let source: Uint8Array | null;
  try {
    source = await storage.get(
      { tenantId: identity.tenantId, jobId, objectId: snapshot.job.sourceObjectId! },
      snapshot.job.sourceDigest!,
    );
  } catch {
    await load();
    throw new Customer360HttpError(503, 'STORAGE_UNAVAILABLE', true);
  }
  if (!source) {
    await load();
    throw new Customer360HttpError(503, 'STORAGE_UNAVAILABLE', true);
  }
  return withTenantDatabaseTransaction(
    db,
    identity.tenantId,
    async (tx) => {
      // tenant lifecycle owner ใช้ row lock; duplicate authority จัดลำดับ team → user → contact fences
      const tenants = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM tenants WHERE id=${identity.tenantId}::uuid AND lifecycle_status::text='ACTIVE' FOR SHARE NOWAIT`;
      if (!tenants.length) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      const actor = await c360CurrentActor(tx, identity);
      if (actor.role !== 'ADMIN' || !(await authorizeC360ContactCreate(tx, actor)))
        throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      const readViewFingerprint = async () => {
        const [view] = await tx.$queryRaw<{ fingerprint: string }[]>(Prisma.sql`
          SELECT concat(count(*), ':',
            coalesce(bit_xor(('x' || substr(md5(c.id::text), 1, 16))::bit(64)::bigint), 0), ':',
            coalesce(bit_xor(('x' || substr(md5(c.id::text), 17, 16))::bit(64)::bigint), 0)
          ) AS fingerprint FROM contacts c WHERE ${c360ReadableContactSql(actor)}`);
        if (!view) throw new Customer360HttpError(503, 'SCOPE_UNAVAILABLE', true);
        return view.fingerprint;
      };
      const beforeView = await readViewFingerprint();
      await input.hooks?.afterInitialFingerprint?.();
      const preview = await prepareC360ImportPreview({
        source,
        sourceDigest: snapshot.job.sourceDigest!,
        mapping: snapshot.job.mapping,
        duplicateAuthority: createC360ImportDuplicateAuthority(tx, actor),
      });
      // duplicate authority ถือ Team/User fences แม้ไม่มี valid rows; ตรวจ actor ปัจจุบันซ้ำก่อนส่ง
      await tx.$queryRaw`SELECT id FROM users WHERE tenant_id=${identity.tenantId}::uuid AND id=${identity.userId}::uuid FOR SHARE NOWAIT`;
      const current = await c360CurrentActor(tx, identity);
      if (current.role !== 'ADMIN' || !(await authorizeC360ContactCreate(tx, current)))
        throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      const [locked] = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM c360_import_jobs WHERE tenant_id=${identity.tenantId}::uuid AND id=${jobId}::uuid FOR SHARE NOWAIT`;
      if (!locked) throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
      const job = await tx.c360ImportJob.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: identity.tenantId, id: jobId } },
      });
      const [clock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (job.ownerUserId !== identity.userId || job.actorIdentityKey !== key)
        throw new Customer360HttpError(404, 'RESOURCE_NOT_FOUND');
      if (!clock || clock.now >= job.sourceExpiresAt)
        throw new Customer360HttpError(410, 'SOURCE_EXPIRED');
      if (
        job.revision !== snapshot.job.revision ||
        job.sourceDigest !== snapshot.job.sourceDigest ||
        job.sourceObjectId !== snapshot.job.sourceObjectId ||
        !['DRAFT', 'READY'].includes(job.state)
      )
        throw new Customer360HttpError(409, 'PREVIEW_STALE');
      const proof = await findTenantConfigurationActor(tx, identity);
      if (!proof) throw new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
      const view = await readViewFingerprint();
      const [capability] = await tx.$queryRaw<{ fingerprint: string }[]>`
      SELECT coalesce(string_agg(g.id::text, ',' ORDER BY g.id), '') AS fingerprint
      FROM c360_actor_capability_grants g WHERE g.tenant_id=${identity.tenantId}::uuid
        AND g.grantee_user_id=${identity.userId}::uuid AND g.capability='CONTACT_CREATE'
        AND NOT EXISTS (SELECT 1 FROM c360_actor_capability_revocations r WHERE r.tenant_id=g.tenant_id AND r.grant_id=g.id)`;
      if (!capability || view !== beforeView || c360ScopeDigest(current) !== c360ScopeDigest(actor))
        throw new Customer360HttpError(503, 'SCOPE_UNAVAILABLE', true);
      const context = {
        tenantId: identity.tenantId,
        userId: identity.userId,
        jobId,
        actorKey: key,
        scopeDigest: c360FilterDigest([
          c360ScopeDigest(current),
          proof.scopeStamp,
          view,
          capability.fingerprint,
        ]),
        revision: job.revision.toString(),
        planHash: preview.planHash,
      };
      const previewRef = input.previewRef ?? sealC360ImportPreviewRef(codec, context);
      if (input.previewRef) openC360ImportPreviewRef(codec, input.previewRef, context);
      const after = input.cursor
        ? openC360ImportRowsCursor(codec, input.cursor, context, previewRef)
        : 0;
      const page = preview.rows.slice(after, after + limit);
      const next =
        after + page.length < preview.rows.length && page.length
          ? sealC360ImportRowsCursor(codec, context, previewRef, page.at(-1)!.rowNo)
          : null;
      await input.hooks?.beforeFinalClock?.();
      const [finalClock] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      if (!finalClock || finalClock.now >= job.sourceExpiresAt)
        throw new Customer360HttpError(410, 'SOURCE_EXPIRED');
      return {
        previewRef,
        sourceDigestRef: snapshot.job.sourceDigest,
        revision: job.revision.toString(),
        rulesVersion: preview.rulesVersion,
        asOf: finalClock.now.toISOString(),
        headers: preview.headers,
        counts: preview.counts,
        rows: page,
        nextCursor: next,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted, timeout: 15_000 },
  );
}
