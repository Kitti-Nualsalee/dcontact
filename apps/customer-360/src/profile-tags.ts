/**
 * Cus360 C1 (#791) S5 → C3 (#793): tag name normalization ย้ายไปอยู่ที่ @d-contact/contact-points
 * เพื่อให้ API/operator/UI ใช้กฎและรุ่น dependency ชุดเดียวกับ phone/email; ไฟล์นี้คง export เดิมไว้
 */
export {
  C360TagNameError,
  C360_TAG_NAME_MAX,
  C360_TAG_NORMALIZATION_VERSION,
  normalizeC360TagName,
} from '@d-contact/contact-points';

/** รูปแบบผลลัพธ์เดิมที่ผู้เรียก customer-360 ใช้ร่วมกับ tag normalizer */
export interface C360TagName {
  name: string;
  nameKey: string;
}

import { randomUUID } from 'node:crypto';
import type { Prisma } from '@d-contact/db';
import {
  C360ProfileCommandError,
  C360ProfileCommandRejection,
  type C360CommandActor,
  type C360PreparedProfileCommand,
  type C360ProfileEffect,
} from './profile-command.js';

/** แหล่ง count สำหรับ Overview: ผู้เรียกต้อง authorize catalog ก่อนและใช้ tenant transaction */
export async function countC360CatalogTags(tx: Prisma.TransactionClient, tenantId: string) {
  const [row] = await tx.$queryRaw<{ active: bigint; retired: bigint; as_of: Date }[]>`
    SELECT COUNT(*) FILTER (WHERE state = 'ACTIVE') AS active,
           COUNT(*) FILTER (WHERE state = 'RETIRED') AS retired,
           statement_timestamp() AS as_of
    FROM c360_tags WHERE tenant_id = ${tenantId}::uuid`;
  return {
    activeCount: row!.active.toString(),
    retiredCount: row!.retired.toString(),
    asOf: row!.as_of.toISOString(),
  };
}

/** สร้าง catalog tag ใต้ name-key fence เดียวกับ operator seed โดยไม่เปิดข้อมูลลูกค้า */
export async function createC360CatalogTag(
  tx: Prisma.TransactionClient,
  actor: C360CommandActor,
  command: C360PreparedProfileCommand,
  input: C360TagName,
): Promise<C360ProfileEffect> {
  const [locked] = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtextextended(${`c360-tag:${actor.tenantId}:${input.nameKey}`}, 0)) AS locked`;
  if (!locked?.locked) throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
  if (await tx.c360Tag.findFirst({ where: { tenantId: actor.tenantId, nameKey: input.nameKey } }))
    throw new C360ProfileCommandRejection('TAG_NAME_CONFLICT', 409);
  const id = randomUUID();
  await tx.c360Tag.create({
    data: {
      id,
      tenantId: actor.tenantId,
      name: input.name,
      nameKey: input.nameKey,
      actorIdentityKey: actor.actorIdentityKey,
      commandId: command.commandId,
    },
  });
  return {
    outcome: 'APPLIED',
    httpStatus: 201,
    committedRevisions: { tag: '0' },
    resourceRefs: [{ type: 'TAG', id }],
    audits: [
      {
        operation: 'TAG_CREATE',
        resourceType: 'TAG',
        resourceId: id,
        changedFields: ['name', 'state'],
        beforeRevisions: {},
        afterRevisions: { tag: '0' },
      },
    ],
  };
}

type CatalogTagRow = {
  id: string;
  name: string;
  name_key: string;
  state: string;
  revision: bigint;
};

async function lockCatalogTag(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
): Promise<CatalogTagRow> {
  const rows = await tx.$queryRaw<CatalogTagRow[]>`SELECT id, name, name_key, state, revision
    FROM c360_tags WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR NO KEY UPDATE NOWAIT`;
  if (!rows[0]) throw new C360ProfileCommandRejection('RESOURCE_NOT_FOUND', 404);
  return rows[0];
}

function tagResult(
  id: string,
  before: bigint,
  operation: 'TAG_RENAME' | 'TAG_RETIRE',
): C360ProfileEffect {
  const after = (before + 1n).toString();
  return {
    outcome: 'APPLIED',
    httpStatus: 200,
    committedRevisions: { tag: after },
    resourceRefs: [{ type: 'TAG', id }],
    audits: [
      {
        operation,
        resourceType: 'TAG',
        resourceId: id,
        changedFields: [operation === 'TAG_RENAME' ? 'name' : 'state'],
        beforeRevisions: { tag: before.toString() },
        afterRevisions: { tag: after },
      },
    ],
  };
}

/** เปลี่ยนชื่อโดยถือ name-key fence ร่วมกับ seed และ tag row lock เดียวกับ assignment */
export async function renameC360CatalogTag(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
  expected: string,
  input: C360TagName,
): Promise<C360ProfileEffect> {
  const snapshot = await tx.c360Tag.findFirst({
    where: { tenantId, id },
    select: { nameKey: true },
  });
  if (!snapshot) throw new C360ProfileCommandRejection('RESOURCE_NOT_FOUND', 404);
  for (const key of [...new Set([snapshot.nameKey, input.nameKey])].sort()) {
    const [locked] = await tx.$queryRaw<
      { locked: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`c360-tag:${tenantId}:${key}`}, 0)) AS locked`;
    if (!locked?.locked) throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
  }
  const tag = await lockCatalogTag(tx, tenantId, id);
  if (tag.name_key !== snapshot.nameKey)
    throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
  if (tag.revision.toString() !== expected)
    throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
  if (tag.state === 'RETIRED') throw new C360ProfileCommandRejection('TAG_RETIRED', 409);
  if (tag.name === input.name)
    return {
      outcome: 'NO_OP',
      committedRevisions: { tag: expected },
      resourceRefs: [{ type: 'TAG', id }],
    };
  const other = await tx.c360Tag.findFirst({
    where: { tenantId, nameKey: input.nameKey, NOT: { id } },
    select: { id: true },
  });
  if (other) throw new C360ProfileCommandRejection('TAG_NAME_CONFLICT', 409);
  await tx.c360Tag.update({
    where: { id },
    data: { name: input.name, nameKey: input.nameKey, revision: tag.revision + 1n },
  });
  return tagResult(id, tag.revision, 'TAG_RENAME');
}

/** Retire ถือ row lock ร่วมกับ attach; assignment เดิมคงอยู่และถอดออกภายหลังได้ */
export async function retireC360CatalogTag(
  tx: Prisma.TransactionClient,
  tenantId: string,
  id: string,
  expected: string,
): Promise<C360ProfileEffect> {
  const tag = await lockCatalogTag(tx, tenantId, id);
  if (tag.revision.toString() !== expected)
    throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
  if (tag.state === 'RETIRED')
    return {
      outcome: 'NO_OP',
      committedRevisions: { tag: expected },
      resourceRefs: [{ type: 'TAG', id }],
    };
  await tx.$executeRaw`UPDATE c360_tags SET state = 'RETIRED', retired_at = clock_timestamp(), revision = revision + 1 WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid`;
  return tagResult(id, tag.revision, 'TAG_RETIRE');
}
