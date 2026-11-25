import { Prisma } from '@prisma/client';

/**
 * Cus360 C3 (#793) S4: compatibility bridge for existing consumers that look up ContactIdentity by value (E1 E)
 *
 * a raw unique match on ContactIdentity is no longer a verified identity: an identity can be used for lookup
 * only when a contact point was imported from that identity (source_kind = LEGACY_IDENTITY) and is still ACTIVE
 * - no mapping = cannot decide yet (UNMAPPED); REVIEW_REQUIRED / RETIRED = not found; no fallback to the raw value
 * - a row superseded at import (a duplicate value on one contact) is decided by the ACTIVE with the same value on the same contact
 * - the same normalized key ACTIVE on another contact too = ambiguous (shared is not interpreted as the same person)
 *
 * used only inside a tenant transaction (RLS); does not modify ContactIdentity or CG evidence
 */
/** UNMAPPED = the identity has not been imported (cannot decide yet); INELIGIBLE = imported but REVIEW_REQUIRED/RETIRED */
export type LegacyIdentityEligibility = 'ELIGIBLE' | 'SHARED' | 'UNMAPPED' | 'INELIGIBLE';

/**
 * a row imported with the same value as an ACTIVE on the same contact is kept as RETIRED by the same command that created it
 * (superseded at import); this row is usable while the ACTIVE with the same value on the same contact still exists (pointing to the same one)
 * a point retired later by another command does not meet this condition
 */
const SUPERSEDED_AT_IMPORT = Prisma.sql`p.state = 'RETIRED' AND p.normalized_value IS NOT NULL
  AND p.retired_command_id = p.created_command_id
  AND p.retired_actor_identity_key = p.created_actor_identity_key`;

export async function legacyIdentityEligibility(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  identityId: string,
): Promise<LegacyIdentityEligibility> {
  const [row] = await transaction.$queryRaw<{ usable: boolean; shared: boolean }[]>`
    SELECT (p.state = 'ACTIVE' OR (${SUPERSEDED_AT_IMPORT} AND EXISTS (
             SELECT 1 FROM c360_contact_points a
             WHERE a.tenant_id = p.tenant_id AND a.contact_id = p.contact_id AND a.state = 'ACTIVE'
               AND a.kind = p.kind AND a.normalization_version = p.normalization_version
               AND a.normalized_value = p.normalized_value))) AS usable,
           EXISTS (
             SELECT 1 FROM c360_contact_points o
             WHERE o.tenant_id = p.tenant_id AND o.state = 'ACTIVE' AND o.kind = p.kind
               AND o.normalization_version = p.normalization_version
               AND o.normalized_value = p.normalized_value AND o.contact_id <> p.contact_id
           ) AS shared
    FROM c360_contact_points p
    WHERE p.tenant_id = ${tenantId}::uuid AND p.source_kind = 'LEGACY_IDENTITY'
      AND p.source_identity_id = ${identityId}::uuid`;
  if (!row) return 'UNMAPPED';
  if (!row.usable) return 'INELIGIBLE';
  return row.shared ? 'SHARED' : 'ELIGIBLE';
}

/**
 * Finds the original identity from a normalized key: it must belong to a single contact and that contact must have an ACTIVE point
 * that came from this legacy identity (a newly created point has no identity evidence, so none is created just to let dispatch pass)
 */
export async function eligibleLegacyIdentityByKey(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  input: { kind: 'PHONE' | 'EMAIL'; normalizationVersion: string; normalizedValue: string },
): Promise<
  | { status: 'RESOLVED'; contactId: string; identityId: string }
  | { status: 'AMBIGUOUS' }
  | { status: 'NOT_FOUND' }
> {
  const rows = await transaction.$queryRaw<{ contact_id: string; identity_id: string | null }[]>`
    SELECT p.contact_id::text AS contact_id, p.source_identity_id::text AS identity_id
    FROM c360_contact_points p
    WHERE p.tenant_id = ${tenantId}::uuid AND p.state = 'ACTIVE' AND p.kind = ${input.kind}
      AND p.normalization_version = ${input.normalizationVersion}
      AND p.normalized_value = ${input.normalizedValue}
    ORDER BY p.contact_id, p.source_identity_id NULLS LAST`;
  const contacts = new Set(rows.map((row) => row.contact_id));
  if (contacts.size > 1) return { status: 'AMBIGUOUS' };
  const legacy = rows.find((row) => row.identity_id !== null);
  if (legacy)
    return { status: 'RESOLVED', contactId: legacy.contact_id, identityId: legacy.identity_id! };
  const [contactId] = contacts;
  if (!contactId) return { status: 'NOT_FOUND' };
  // the ACTIVE for this value did not come from legacy (e.g. created through a profile command) but there is a legacy identity with the same value
  // on the same contact that was superseded at import: use that identity as evidence (pointing to the same ACTIVE)
  const [superseded] = await transaction.$queryRaw<{ identity_id: string }[]>`
    SELECT p.source_identity_id::text AS identity_id FROM c360_contact_points p
    WHERE p.tenant_id = ${tenantId}::uuid AND p.contact_id = ${contactId}::uuid
      AND p.source_kind = 'LEGACY_IDENTITY' AND p.kind = ${input.kind}
      AND p.normalization_version = ${input.normalizationVersion}
      AND p.normalized_value = ${input.normalizedValue} AND ${SUPERSEDED_AT_IMPORT}
    ORDER BY p.source_identity_id LIMIT 1`;
  return superseded
    ? { status: 'RESOLVED', contactId, identityId: superseded.identity_id }
    : { status: 'NOT_FOUND' };
}
