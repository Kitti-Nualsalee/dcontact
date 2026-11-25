import { createHash, randomUUID } from 'node:crypto';
import {
  C360ContactPointError,
  normalizeC360Email,
  normalizeC360Phone,
  type C360ContactPointErrorCode,
} from '@d-contact/contact-points';
import { Prisma } from '@d-contact/db';
import { C360ProfileCommandError } from './profile-command.js';
import { tryC360IdentityFences } from './profile-fences.js';
import { C360_CONTACT_POINT_QUOTA } from './profile-points.js';

/**
 * Cus360 C3 (#793) S3: inventory and import of legacy ContactIdentity → contact point per E1 D
 *
 * - reads ContactIdentity only; does not change owner/value/verification/consent of the original rows
 * - passes the parser as stored = ACTIVE; no + and no country, an extension or a malformed format =
 *   REVIEW_REQUIRED (no normalized key, so it is neither looked up nor dispatched); the country is not guessed from tenant/locale
 * - several identity rows of one contact that normalize to the same value (or duplicate an existing ACTIVE point) are kept as a point
 *   superseded at import time (RETIRED by the same command that created it, with a normalized key) because a duplicate ACTIVE
 *   cannot exist on one contact; the bridge decides this row by the ACTIVE with the same value on the same contact (chosen by the work owner)
 * - idempotent: unique (tenant_id, source_identity_id) and the FK (tenant, identity, contact) prove
 *   provenance; re-running creates no duplicate rows and legacy rows over quota are not dropped
 * - the report has only counts and a digest, no raw phone/email values
 */
export const C360_LEGACY_IMPORT_BATCH_MAX = 200;

const IMPORTABLE = ['PHONE', 'EMAIL'] as const;
type ImportableType = (typeof IMPORTABLE)[number];

export type C360LegacyClassification =
  | { state: 'ACTIVE'; normalizedValue: string; normalizationVersion: string }
  | { state: 'REVIEW_REQUIRED'; reason: C360ContactPointErrorCode }
  /** value duplicates an ACTIVE on the same contact: kept as RETIRED, created and retired by the same command */
  | { state: 'SUPERSEDED'; normalizedValue: string; normalizationVersion: string };

export function classifyC360LegacyIdentity(
  type: ImportableType,
  value: string,
): C360LegacyClassification {
  try {
    // legacy has no user-selected country, so only international numbers that parse as a whole string are accepted
    const point = type === 'PHONE' ? normalizeC360Phone(value, null) : normalizeC360Email(value);
    return {
      state: 'ACTIVE',
      normalizedValue: point.normalizedValue,
      normalizationVersion: point.normalizationVersion,
    };
  } catch (error) {
    if (error instanceof C360ContactPointError)
      return { state: 'REVIEW_REQUIRED', reason: error.code };
    throw error;
  }
}

interface LegacyIdentityRow {
  id: string;
  contact_id: string;
  type: ImportableType;
  value: string;
  imported: boolean;
}

export interface C360LegacyInventory {
  tenantId: string;
  identities: Record<ImportableType, number>;
  imported: number;
  pending: { active: number; reviewRequired: number; superseded: number };
  reviewReasons: Record<string, number>;
  /** contacts whose ACTIVE count per type exceeds the quota after import (not dropped, but new ones cannot be added) */
  contactsOverQuota: number;
  /** the same normalized key on several contacts (allowed by R1 but must not be interpreted as the same person) */
  sharedKeys: { keys: number; contacts: number; digest: string };
  identityHeads: { missing: number; merged: number; ambiguous: number };
}

function keyDigest(tenantId: string, keys: string[]): string {
  // the digest is bound to the tenant so runs can be compared without revealing values and it cannot be compared across tenants
  const hash = createHash('sha256').update(`c360-legacy-keys-v1\0${tenantId}`);
  for (const key of [...keys].sort()) hash.update(`\0${key}`);
  return hash.digest('hex');
}

/** a duplicate ACTIVE on the same contact is impossible (unique index), so keep it as SUPERSEDED instead of dropping the row */
function dedupe(
  result: C360LegacyClassification,
  row: { contact_id: string; type: string },
  contactKeys: Set<string>,
): C360LegacyClassification {
  if (result.state !== 'ACTIVE') return result;
  const key = `${row.contact_id}\0${row.type}\0${result.normalizationVersion}\0${result.normalizedValue}`;
  if (contactKeys.has(key))
    return {
      state: 'SUPERSEDED',
      normalizedValue: result.normalizedValue,
      normalizationVersion: result.normalizationVersion,
    };
  contactKeys.add(key);
  return result;
}

async function legacyIdentities(
  tx: Prisma.TransactionClient,
  tenantId: string,
  options: { pendingOnly: boolean; limit?: number },
): Promise<LegacyIdentityRow[]> {
  return tx.$queryRaw<LegacyIdentityRow[]>`
    SELECT ci.id, ci.contact_id, ci.type::text AS type, ci.value,
           EXISTS (SELECT 1 FROM c360_contact_points p
                   WHERE p.tenant_id = ci.tenant_id AND p.source_identity_id = ci.id) AS imported
    FROM contact_identities ci
    WHERE ci.tenant_id = ${tenantId}::uuid AND ci.type::text IN ('PHONE', 'EMAIL')
      AND (${!options.pendingOnly} OR NOT EXISTS (
        SELECT 1 FROM c360_contact_points p
        WHERE p.tenant_id = ci.tenant_id AND p.source_identity_id = ci.id))
    ORDER BY ci.id
    ${options.limit === undefined ? Prisma.empty : Prisma.sql`LIMIT ${options.limit}`}`;
}

/** Dry-run: surveys what the import would do without writing anything */
export async function inventoryC360LegacyContactPoints(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<C360LegacyInventory> {
  const rows = await legacyIdentities(tx, tenantId, { pendingOnly: false });
  const identities: Record<ImportableType, number> = { PHONE: 0, EMAIL: 0 };
  const reviewReasons: Record<string, number> = {};
  let imported = 0;
  let active = 0;
  let review = 0;
  let superseded = 0;
  // ACTIVE rows after import per contact/type, and key → contacts for shared/collision
  const perContact = new Map<string, number>();
  const keyContacts = new Map<string, Set<string>>();
  const existing = await tx.c360ContactPoint.findMany({
    where: { tenantId, state: 'ACTIVE' },
    select: { contactId: true, kind: true, normalizedValue: true, normalizationVersion: true },
  });
  const add = (contactId: string, kind: string, key: string) => {
    const slot = `${contactId}\0${kind}`;
    perContact.set(slot, (perContact.get(slot) ?? 0) + 1);
    const contacts = keyContacts.get(key) ?? new Set<string>();
    contacts.add(contactId);
    keyContacts.set(key, contacts);
  };
  const contactKeys = new Set<string>();
  for (const point of existing) {
    add(
      point.contactId,
      point.kind,
      `${point.kind}\0${point.normalizationVersion}\0${point.normalizedValue}`,
    );
    contactKeys.add(
      `${point.contactId}\0${point.kind}\0${point.normalizationVersion}\0${point.normalizedValue}`,
    );
  }
  for (const row of rows) {
    identities[row.type] += 1;
    if (row.imported) {
      imported += 1;
      continue;
    }
    const result = dedupe(classifyC360LegacyIdentity(row.type, row.value), row, contactKeys);
    if (result.state === 'ACTIVE') {
      active += 1;
      add(
        row.contact_id,
        row.type,
        `${row.type}\0${result.normalizationVersion}\0${result.normalizedValue}`,
      );
    } else if (result.state === 'SUPERSEDED') {
      superseded += 1;
    } else {
      review += 1;
      reviewReasons[result.reason] = (reviewReasons[result.reason] ?? 0) + 1;
    }
  }
  const shared = [...keyContacts.entries()].filter(([, contacts]) => contacts.size > 1);
  const [heads] = await tx.$queryRaw<{ missing: bigint; merged: bigint; ambiguous: bigint }[]>`
    SELECT count(*) FILTER (WHERE ih.contact_id IS NULL) AS missing,
           count(*) FILTER (WHERE ih.state::text = 'MERGED') AS merged,
           count(*) FILTER (WHERE ih.state::text = 'AMBIGUOUS') AS ambiguous
    FROM contacts c
    LEFT JOIN c360_identity_heads ih ON ih.tenant_id = c.tenant_id AND ih.contact_id = c.id
    WHERE c.tenant_id = ${tenantId}::uuid`;
  return {
    tenantId,
    identities,
    imported,
    pending: { active, reviewRequired: review, superseded },
    reviewReasons,
    contactsOverQuota: new Set(
      [...perContact.entries()]
        .filter(([, count]) => count > C360_CONTACT_POINT_QUOTA)
        .map(([slot]) => slot.split('\0')[0]),
    ).size,
    sharedKeys: {
      keys: shared.length,
      contacts: new Set(shared.flatMap(([, contacts]) => [...contacts])).size,
      digest: keyDigest(
        tenantId,
        shared.map(([key]) => key),
      ),
    },
    identityHeads: {
      missing: Number(heads?.missing ?? 0),
      merged: Number(heads?.merged ?? 0),
      ambiguous: Number(heads?.ambiguous ?? 0),
    },
  };
}

export interface C360LegacyImportBatch {
  imported: number;
  active: number;
  reviewRequired: number;
  superseded: number;
  contacts: string[];
  remaining: number;
}

/**
 * Import one batch under an operator command (the FK created_command points at this command)
 * lock affected contacts in ID order with NOWAIT, then bump profile_revision once per contact
 * so an edit command holding an old revision gets REVISION_CONFLICT instead of overwriting the imported data
 */
export async function importC360LegacyContactPointsBatch(
  tx: Prisma.TransactionClient,
  context: { tenantId: string; actorIdentityKey: string; commandId: string },
  batchSize: number,
): Promise<C360LegacyImportBatch> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > C360_LEGACY_IMPORT_BATCH_MAX)
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  const rows = await legacyIdentities(tx, context.tenantId, {
    pendingOnly: true,
    limit: batchSize,
  });
  const contacts = [...new Set(rows.map((row) => row.contact_id))].sort();
  // E1 G: identity fence for the whole contact set before profile rows (the canonical transition holds exclusive)
  await tryC360IdentityFences(tx, context.tenantId, contacts);
  for (const contactId of contacts) {
    try {
      await tx.$queryRaw`
        SELECT id FROM contacts WHERE tenant_id = ${context.tenantId}::uuid AND id = ${contactId}::uuid
        FOR NO KEY UPDATE NOWAIT`;
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      if (/55P03|lock_not_available|could not obtain lock/.test(text))
        throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
      throw error;
    }
  }
  let active = 0;
  let reviewRequired = 0;
  let superseded = 0;
  let imported = 0;
  // the revision is bumped only for contacts that actually had a row inserted (a row hitting ON CONFLICT is not a mutation)
  const touched = new Set<string>();
  const contactKeys = new Set(
    contacts.length === 0
      ? []
      : (
          await tx.c360ContactPoint.findMany({
            where: { tenantId: context.tenantId, contactId: { in: contacts }, state: 'ACTIVE' },
            select: {
              contactId: true,
              kind: true,
              normalizedValue: true,
              normalizationVersion: true,
            },
          })
        ).map(
          (point) =>
            `${point.contactId}\0${point.kind}\0${point.normalizationVersion}\0${point.normalizedValue}`,
        ),
  );
  for (const row of rows) {
    const result = dedupe(classifyC360LegacyIdentity(row.type, row.value), row, contactKeys);
    // ON CONFLICT: rows already imported by a previous run (or another batch that committed first) are not created again
    const inserted = await tx.$executeRaw`
      INSERT INTO c360_contact_points
        (id, tenant_id, contact_id, kind, raw_value, normalized_value, normalization_version, state,
         source_kind, source_identity_id, created_actor_identity_key, created_command_id,
         retired_at, retired_actor_identity_key, retired_command_id)
      VALUES (${randomUUID()}::uuid, ${context.tenantId}::uuid, ${row.contact_id}::uuid, ${row.type},
        ${row.value},
        ${result.state === 'REVIEW_REQUIRED' ? null : result.normalizedValue},
        ${result.state === 'REVIEW_REQUIRED' ? null : result.normalizationVersion},
        ${result.state === 'SUPERSEDED' ? 'RETIRED' : result.state}, 'LEGACY_IDENTITY', ${row.id}::uuid,
        ${context.actorIdentityKey}, ${context.commandId}::uuid,
        ${result.state === 'SUPERSEDED' ? new Date() : null},
        ${result.state === 'SUPERSEDED' ? context.actorIdentityKey : null},
        ${result.state === 'SUPERSEDED' ? context.commandId : null}::uuid)
      ON CONFLICT (tenant_id, source_identity_id) WHERE source_kind = 'LEGACY_IDENTITY' DO NOTHING`;
    if (inserted !== 1) continue;
    imported += 1;
    touched.add(row.contact_id);
    if (result.state === 'ACTIVE') active += 1;
    else if (result.state === 'SUPERSEDED') superseded += 1;
    else reviewRequired += 1;
  }
  if (touched.size > 0)
    await tx.$executeRaw`
      UPDATE contacts SET profile_revision = profile_revision + 1
      WHERE tenant_id = ${context.tenantId}::uuid AND id IN (${Prisma.join(
        [...touched].map((id) => Prisma.sql`${id}::uuid`),
      )})`;
  const [left] = await tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM contact_identities ci
    WHERE ci.tenant_id = ${context.tenantId}::uuid AND ci.type::text IN ('PHONE', 'EMAIL')
      AND NOT EXISTS (SELECT 1 FROM c360_contact_points p
                      WHERE p.tenant_id = ci.tenant_id AND p.source_identity_id = ci.id)`;
  return {
    imported,
    active,
    reviewRequired,
    superseded,
    contacts: [...touched].sort(),
    remaining: Number(left?.n ?? 0),
  };
}
