import { randomUUID } from 'node:crypto';
import {
  C360ContactPointError,
  normalizeC360Email,
  normalizeC360Phone,
  type C360NormalizedContactPoint,
} from '@d-contact/contact-points';
import { Prisma } from '@d-contact/db';
import {
  C360ProfileCommandError,
  C360ProfileCommandRejection,
  type C360ProfileEffect,
} from './profile-command.js';

/**
 * Cus360 C3 (#793) S2: owner of contact point associations per R1 B.2–B.4 and E1 A
 *
 * - an association belongs to a contact; several contacts may share one value; no merge/verify/consent move
 * - changing a value = retire the old one + add a new one in one transaction; existing attributes cannot be edited (DB trigger)
 * - at most 10 ACTIVE per type per contact; legacy already over the limit can be read/retired/replaced but not added to
 * - a real mutation bumps `contacts.profile_revision` once; a value that is already ACTIVE = NO_OP
 *
 * These functions are used inside the `perform` of `executeC360ProfileCommand` after the caller holds fences and has checked
 * `access.manage` (`fenceC360ContactMutation`), so they return a `C360ProfileEffect` for the engine to write
 * audit/receipt in the same transaction; a failed business rule throws `C360ProfileCommandRejection`
 */
export const C360_CONTACT_POINT_QUOTA = 10;

export type C360ContactPointKind = 'PHONE' | 'EMAIL';

export interface C360PointWriteContext {
  tenantId: string;
  contactId: string;
  /** From a command the engine has admitted: the FKs of the created/retired command point at this command */
  actorIdentityKey: string;
  commandId: string;
  /** R1 F: expectedProfileRevision is a decimal string */
  expectedProfileRevision: string;
}

export interface C360PointInput {
  kind: C360ContactPointKind;
  value: unknown;
  explicitCountry?: unknown;
}

interface LockedContact {
  profileRevision: bigint;
}

function normalize(input: C360PointInput): C360NormalizedContactPoint {
  try {
    if (input.kind === 'PHONE')
      return normalizeC360Phone(input.value, input.explicitCountry ?? null);
    if (input.kind === 'EMAIL') {
      if (input.explicitCountry !== undefined && input.explicitCountry !== null)
        throw new C360ProfileCommandError('INVALID_REQUEST', 400);
      return normalizeC360Email(input.value);
    }
  } catch (error) {
    if (error instanceof C360ContactPointError)
      throw new C360ProfileCommandRejection(error.code, 422);
    throw error;
  }
  throw new C360ProfileCommandError('INVALID_REQUEST', 400);
}

/** E1 G: the contact row is the profile fence for point writers (NOWAIT; busy = rollback then retry) */
async function lockContact(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
): Promise<LockedContact> {
  let rows: { profile_revision: bigint; identity: string | null }[];
  try {
    rows = await tx.$queryRaw`
      SELECT c.profile_revision,
             (SELECT ih.state::text FROM c360_identity_heads ih
              WHERE ih.tenant_id = c.tenant_id AND ih.contact_id = c.id) AS identity
      FROM contacts c
      WHERE c.tenant_id = ${context.tenantId}::uuid AND c.id = ${context.contactId}::uuid
      FOR NO KEY UPDATE OF c NOWAIT`;
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (/55P03|lock_not_available|could not obtain lock/.test(text))
      throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
    throw error;
  }
  const [row] = rows;
  if (!row) throw new C360ProfileCommandRejection('RESOURCE_NOT_FOUND', 404);
  // the owner guards again beyond authorization: editable only for canonical ACTIVE (legacy without a head still cannot be edited)
  if (row.identity !== 'ACTIVE') throw new C360ProfileCommandRejection('IDENTITY_NOT_ACTIVE', 409);
  if (row.profile_revision.toString() !== context.expectedProfileRevision)
    throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
  return { profileRevision: row.profile_revision };
}

async function activeCount(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
  kind: C360ContactPointKind,
): Promise<number> {
  return tx.c360ContactPoint.count({
    where: { tenantId: context.tenantId, contactId: context.contactId, kind, state: 'ACTIVE' },
  });
}

async function activeDuplicate(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
  point: C360NormalizedContactPoint,
) {
  return tx.c360ContactPoint.findFirst({
    where: {
      tenantId: context.tenantId,
      contactId: context.contactId,
      kind: point.kind,
      state: 'ACTIVE',
      normalizationVersion: point.normalizationVersion,
      normalizedValue: point.normalizedValue,
    },
    select: { id: true },
  });
}

async function insertPoint(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
  point: C360NormalizedContactPoint,
): Promise<string> {
  const id = randomUUID();
  await tx.c360ContactPoint.create({
    data: {
      id,
      tenantId: context.tenantId,
      contactId: context.contactId,
      kind: point.kind,
      rawValue: point.rawValue,
      normalizedValue: point.normalizedValue,
      normalizationVersion: point.normalizationVersion,
      explicitCountry: point.explicitCountry,
      state: 'ACTIVE',
      sourceKind: 'PROFILE_COMMAND',
      createdActorIdentityKey: context.actorIdentityKey,
      createdCommandId: context.commandId,
    },
  });
  return id;
}

async function retirePoint(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
  pointId: string,
): Promise<void> {
  await tx.$executeRaw`
    UPDATE c360_contact_points
    SET state = 'RETIRED', retired_at = clock_timestamp(),
        retired_actor_identity_key = ${context.actorIdentityKey},
        retired_command_id = ${context.commandId}::uuid
    WHERE tenant_id = ${context.tenantId}::uuid AND id = ${pointId}::uuid`;
}

async function bumpProfileRevision(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
  current: bigint,
): Promise<string> {
  const next = current + 1n;
  // a second CAS layer besides the row lock: the revision must still be the value read; never write a fixed value over the winner
  const updated = await tx.$executeRaw`
    UPDATE contacts SET profile_revision = ${next}
    WHERE tenant_id = ${context.tenantId}::uuid AND id = ${context.contactId}::uuid
      AND profile_revision = ${current}`;
  if (updated !== 1) throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
  return next.toString();
}

async function lockedPoint(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
  pointId: string,
) {
  const point = await tx.c360ContactPoint.findFirst({
    where: { tenantId: context.tenantId, contactId: context.contactId, id: pointId },
  });
  // a point of another contact is answered as not found and its existence is not revealed
  if (!point) throw new C360ProfileCommandRejection('POINT_NOT_FOUND', 404);
  return point;
}

function applied(
  context: C360PointWriteContext,
  operation: string,
  before: bigint,
  after: string,
  refs: string[],
): C360ProfileEffect {
  return {
    outcome: 'APPLIED',
    httpStatus: 200,
    committedRevisions: { profile: after },
    resourceRefs: [
      { type: 'CONTACT', id: context.contactId },
      ...refs.map((id) => ({ type: 'CONTACT_POINT', id })),
    ],
    // the audit does not copy the phone/email before/after values (E1 A); only the field and revision
    audits: [
      {
        operation,
        resourceType: 'CONTACT',
        resourceId: context.contactId,
        changedFields: ['contactPoints'],
        beforeRevisions: { profile: before.toString() },
        afterRevisions: { profile: after },
      },
    ],
  };
}

function noOp(
  context: C360PointWriteContext,
  revision: bigint,
  pointId: string,
): C360ProfileEffect {
  return {
    outcome: 'NO_OP',
    committedRevisions: { profile: revision.toString() },
    resourceRefs: [
      { type: 'CONTACT', id: context.contactId },
      { type: 'CONTACT_POINT', id: pointId },
    ],
  };
}

export async function addC360ContactPoint(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
  input: C360PointInput,
): Promise<C360ProfileEffect> {
  const point = normalize(input);
  const contact = await lockContact(tx, context);
  const duplicate = await activeDuplicate(tx, context, point);
  if (duplicate) return noOp(context, contact.profileRevision, duplicate.id);
  if ((await activeCount(tx, context, point.kind)) >= C360_CONTACT_POINT_QUOTA)
    throw new C360ProfileCommandRejection('POINT_QUOTA_EXCEEDED', 422);
  const id = await insertPoint(tx, context, point);
  const revision = await bumpProfileRevision(tx, context, contact.profileRevision);
  return applied(context, 'CONTACT_POINT_ADD', contact.profileRevision, revision, [id]);
}

export async function retireC360ContactPoint(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
  pointId: string,
): Promise<C360ProfileEffect> {
  const contact = await lockContact(tx, context);
  const point = await lockedPoint(tx, context, pointId);
  if (point.state === 'RETIRED') return noOp(context, contact.profileRevision, point.id);
  await retirePoint(tx, context, point.id);
  const revision = await bumpProfileRevision(tx, context, contact.profileRevision);
  return applied(context, 'CONTACT_POINT_RETIRE', contact.profileRevision, revision, [point.id]);
}

/**
 * Replace = retire the old one + add a new one in one transaction; a new value already ACTIVE on the same contact is not inserted again
 * replacing ACTIVE with ACTIVE does not increase the count, so quota does not apply (legacy over the cap can fix a wrong value), but replacing
 * REVIEW_REQUIRED with a usable value adds a new ACTIVE, so it must pass the quota like add
 */
export async function replaceC360ContactPoint(
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
  pointId: string,
  input: C360PointInput,
): Promise<C360ProfileEffect> {
  const next = normalize(input);
  const contact = await lockContact(tx, context);
  const current = await lockedPoint(tx, context, pointId);
  if (current.state === 'RETIRED') throw new C360ProfileCommandRejection('POINT_RETIRED', 409);
  if (current.kind !== next.kind) throw new C360ProfileCommandRejection('POINT_KIND_MISMATCH', 422);
  if (
    current.state === 'ACTIVE' &&
    current.normalizationVersion === next.normalizationVersion &&
    current.normalizedValue === next.normalizedValue
  )
    return noOp(context, contact.profileRevision, current.id);
  const duplicate = await activeDuplicate(tx, context, next);
  if (
    current.state !== 'ACTIVE' &&
    !duplicate &&
    (await activeCount(tx, context, next.kind)) >= C360_CONTACT_POINT_QUOTA
  )
    throw new C360ProfileCommandRejection('POINT_QUOTA_EXCEEDED', 422);
  await retirePoint(tx, context, current.id);
  const refs = [current.id];
  if (!duplicate) refs.push(await insertPoint(tx, context, next));
  else refs.push(duplicate.id);
  const revision = await bumpProfileRevision(tx, context, contact.profileRevision);
  return applied(context, 'CONTACT_POINT_REPLACE', contact.profileRevision, revision, refs);
}
