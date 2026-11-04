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
 * Cus360 C3 (#793) S2: owner ของ contact point association ตาม R1 B.2–B.4 และ E1 A
 *
 * - association เป็นของ contact; หลาย contact ใช้ค่าเดียวกันได้ ไม่ merge/verify/ย้าย consent
 * - เปลี่ยนค่า = retire เดิม + add ใหม่ใน transaction เดียว; attribute เดิมแก้ไม่ได้ (DB trigger)
 * - ACTIVE ไม่เกิน 10 ต่อชนิดต่อ contact; legacy ที่เกินอยู่แล้วอ่าน/retire/replace ได้ แต่เพิ่มไม่ได้
 * - mutation จริงเพิ่ม `contacts.profile_revision` ครั้งเดียว; ค่าเดิมที่ ACTIVE อยู่แล้ว = NO_OP
 *
 * ฟังก์ชันเหล่านี้ใช้ภายใน `perform` ของ `executeC360ProfileCommand` หลัง caller ถือ fences และตรวจ
 * `access.manage` แล้ว (`fenceC360ContactMutation`) จึงคืน `C360ProfileEffect` ให้ engine เขียน
 * audit/receipt ใน transaction เดียวกัน; business rule ไม่ผ่านโยน `C360ProfileCommandRejection`
 */
export const C360_CONTACT_POINT_QUOTA = 10;

export type C360ContactPointKind = 'PHONE' | 'EMAIL';

export interface C360PointWriteContext {
  tenantId: string;
  contactId: string;
  /** จาก command ที่ engine admit แล้ว: FK ของ created/retired command ชี้ไปที่ command นี้ */
  actorIdentityKey: string;
  commandId: string;
  /** R1 F: expectedProfileRevision เป็น decimal string */
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

/** E1 G: contact row เป็น profile fence ของ point writers (NOWAIT; busy = rollback แล้ว retry) */
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
  // owner ป้องกันซ้ำจาก authorization: แก้ได้เฉพาะ canonical ACTIVE (legacy ไม่มี head ยังแก้ไม่ได้)
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
  // CAS ชั้นที่สองนอกจาก row lock: revision ต้องยังเป็นค่าที่อ่านไว้ ไม่เขียนค่าตายตัวทับผู้ชนะ
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
  // point ของ contact อื่นตอบเหมือนไม่พบ ไม่เปิดเผยว่ามีอยู่
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
    // audit ไม่คัดลอกค่า phone/email ก่อน–หลัง (E1 A) มีแค่ field และ revision
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
 * Replace = retire เดิม + add ใหม่ใน transaction เดียว ค่าใหม่ที่ ACTIVE อยู่แล้วบน contact เดียวกันไม่ insert ซ้ำ
 * แทน ACTIVE ด้วย ACTIVE จำนวนไม่เพิ่ม จึงไม่ติด quota (legacy ที่เกินเพดานแก้ค่าที่ผิดได้) แต่แทน
 * REVIEW_REQUIRED ด้วยค่าที่ใช้ได้คือการเพิ่ม ACTIVE ใหม่ จึงต้องผ่าน quota เหมือน add
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
