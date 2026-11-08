import { Prisma, lockTeamReferences } from '@d-contact/db';
import { performance } from 'node:perf_hooks';
import type { C360ImportDuplicateAuthority } from './import-preview.js';
import type { C360CreateProfile } from './profile-write.js';
import {
  c360DeferredContactSql,
  c360ReadableContactSql,
  authorizeC360ContactCreate,
  type C360VerifiedActor,
} from './profile-authorization.js';
import {
  c360IdentityFenceKey,
  lockIamScopeVersionsShared,
  tryC360CustodianFences,
  tryIamContactProjectionFences,
} from './profile-fences.js';
import { C360ReadError } from './profile-read.js';

const CHUNK_SIZE = 500;
const MAX_ROWS = 10_000;
const MAX_MATCHES = 200;
const BUDGET_MS = 5_000;
const unavailable = () => new C360ReadError(503, 'SCOPE_UNAVAILABLE', true);

type Match = { row_indexes: number[]; id: string; readable: boolean; deferred: boolean };

/**
 * ต้องเรียกใน tenant-scoped READ COMMITTED transaction หลัง gateway ตรวจ identity/proof แล้ว
 * ใช้ current Contact VIEW predicate ของ C2 และคืนเพียง boolean ต่อ input row; ไม่คืน count/id/PII.
 * เรียกเสร็จ caller ต้องตรวจ owner/proof/capability อีกครั้งก่อนส่ง preview ทุกหน้า
 */
export function createC360ImportDuplicateAuthority(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
): C360ImportDuplicateAuthority {
  return {
    async findReadableDuplicates(
      profiles: readonly C360CreateProfile[],
    ): Promise<readonly boolean[]> {
      if (
        actor.role !== 'ADMIN' ||
        profiles.length > MAX_ROWS ||
        profiles.some(
          (profile) =>
            profile.points.length > 2 ||
            profile.points.some(
              (point) =>
                !['PHONE', 'EMAIL'].includes(point.kind) ||
                typeof point.normalizedValue !== 'string' ||
                point.normalizedValue.length > 512,
            ),
        )
      )
        throw unavailable();
      const started = performance.now();
      const budget = () => {
        if (performance.now() - started >= BUDGET_MS) throw unavailable();
      };
      const [isolation] = await tx.$queryRawUnsafe<{ transaction_isolation: string }[]>(
        'SHOW transaction_isolation',
      );
      if (isolation?.transaction_isolation !== 'read committed') throw unavailable();
      await tx.$executeRaw`SELECT set_config('lock_timeout', '250ms', true), set_config('statement_timeout', '2s', true)`;
      try {
        if (actor.teamId) {
          await lockTeamReferences(tx, actor.tenantId, [actor.teamId]);
          await lockIamScopeVersionsShared(tx, actor.tenantId, [actor.teamId]);
        }
        const users = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM users WHERE tenant_id=${actor.tenantId}::uuid AND id=${actor.userId}::uuid
            AND is_active AND role::text='ADMIN' AND team_id IS NOT DISTINCT FROM ${actor.teamId}::uuid
          FOR SHARE NOWAIT`;
        if (!users.length || !(await authorizeC360ContactCreate(tx, actor))) throw unavailable();
      } catch {
        throw unavailable();
      }
      const noMerged = Prisma.sql`NOT EXISTS (SELECT 1 FROM c360_identity_heads ih WHERE ih.tenant_id=c.tenant_id AND ih.contact_id=c.id AND ih.state='MERGED')`;
      const scopeReady = async () => {
        budget();
        const [row] = await tx.$queryRaw<{ deferred: boolean }[]>(Prisma.sql`
          SELECT EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id=${actor.tenantId}::uuid
            AND ${noMerged} AND ${c360DeferredContactSql(actor)}) AS deferred`);
        if (row?.deferred !== false) throw unavailable();
      };
      const query = async (from: number): Promise<Match[]> => {
        budget();
        const entries = profiles.slice(from, from + CHUNK_SIZE).flatMap((profile, offset) =>
          profile.points.map((point) => ({
            row_index: from + offset,
            kind: point.kind,
            value: point.normalizedValue,
          })),
        );
        if (!entries.length) return [];
        return tx.$queryRaw<Match[]>(Prisma.sql`
          WITH input AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(entries)}::jsonb)
            AS p(row_index integer, kind text, value text))
          SELECT c.id, array_agg(DISTINCT input.row_index) AS row_indexes, ${c360ReadableContactSql(actor)} AS readable,
            ${c360DeferredContactSql(actor)} AS deferred
          FROM input JOIN c360_contact_points cp ON cp.tenant_id=${actor.tenantId}::uuid
            AND cp.kind=input.kind AND cp.normalized_value=input.value AND cp.state='ACTIVE'
          JOIN contacts c ON c.tenant_id=cp.tenant_id AND c.id=cp.contact_id
          WHERE c.tenant_id=${actor.tenantId}::uuid AND ${noMerged}
            AND (${c360ReadableContactSql(actor)} OR ${c360DeferredContactSql(actor)})
          GROUP BY c.id, c.tenant_id
          LIMIT ${MAX_MATCHES + 1}`);
      };
      await scopeReady();
      const initial: Match[] = [];
      for (let offset = 0; offset < profiles.length; offset += CHUNK_SIZE) {
        initial.push(...(await query(offset)));
        if (new Set(initial.map((row) => row.id)).size > MAX_MATCHES) throw unavailable();
      }
      const ids = [...new Set(initial.map((row) => row.id))].sort();
      try {
        for (const id of ids) {
          budget();
          const [row] = await tx.$queryRaw<
            { locked: boolean }[]
          >`SELECT pg_try_advisory_xact_lock(hashtext(${c360IdentityFenceKey(actor.tenantId, id)})) AS locked`;
          if (!row?.locked) throw unavailable();
        }
        if (actor.teamId) await tryIamContactProjectionFences(tx, actor.tenantId, ids);
        await tryC360CustodianFences(tx, actor.tenantId, ids);
      } catch {
        throw unavailable();
      }
      await scopeReady();
      const latest: Match[] = [];
      for (let offset = 0; offset < profiles.length; offset += CHUNK_SIZE)
        latest.push(...(await query(offset)));
      const signature = (rows: Match[]) =>
        rows
          .map(
            (r) =>
              `${r.id}:${r.readable}:${r.deferred}:${[...r.row_indexes].sort((a, b) => a - b).join(',')}`,
          )
          .sort();
      const before = signature(initial),
        after = signature(latest);
      if (
        before.length !== after.length ||
        before.some((entry, i) => entry !== after[i]) ||
        latest.some((row) => row.deferred)
      )
        throw unavailable();
      const results = profiles.map(() => false);
      for (const row of latest)
        if (row.readable) for (const index of row.row_indexes) results[index] = true;
      budget();
      return results;
    },
  };
}
