import { randomUUID } from 'node:crypto';
import {
  C360ContactPointError,
  normalizeC360Email,
  normalizeC360Phone,
  type C360NormalizedContactPoint,
} from '@d-contact/contact-points';
import { Prisma } from '@d-contact/db';
import { authorizeC360ContactCreate, type C360VerifiedActor } from './profile-authorization.js';
import {
  C360ProfileCommandError,
  C360ProfileCommandRejection,
  type C360CommandActor,
  type C360PreparedProfileCommand,
  type C360ProfileEffect,
} from './profile-command.js';
import { c360IdentityFenceKey, fenceC360ContactMutation } from './profile-fences.js';
import { initializeC360IdentityHead } from './segment-membership-repository.js';
import { C360_CONTACT_POINT_QUOTA } from './profile-points.js';

import { C360_PROFILE_RULE_VERSION, C360_PROFILE_TEXT_RULES } from './profile-field-rules.js';
export const C360_PROFILE_WRITE_VERSION = C360_PROFILE_RULE_VERSION;
export const C360_PROFILE_NAME_MAX = C360_PROFILE_TEXT_RULES.displayName.maxCodeUnits;
export const C360_PROFILE_COMPANY_MAX = C360_PROFILE_TEXT_RULES.company.maxCodeUnits;

export class C360WriteValidationError extends Error {
  constructor(readonly fieldErrors: readonly { field: string; code: string }[]) {
    super('VALIDATION_FAILED');
  }
}

export class C360WriteNotFound extends Error {
  constructor() {
    super('RESOURCE_NOT_FOUND');
  }
}
export class C360WriteScopeUnavailable extends Error {
  constructor() {
    super('SCOPE_UNAVAILABLE');
  }
}

export class C360WriteDenied extends Error {
  constructor() {
    super('CUSTOMER_ACCESS_DENIED');
  }
}

export interface C360CreateProfile {
  displayName: string;
  company: string | null;
  vip: boolean;
  points: C360NormalizedContactPoint[];
}

/** ตรวจและ normalize เฉพาะฟิลด์ที่ส่งมา โดยไม่สะท้อนค่าที่กรอกใน error */
export function normalizeC360CreateProfile(input: Record<string, unknown>): C360CreateProfile {
  if (
    Object.keys(input).some(
      (key) => !['commandId', 'displayName', 'company', 'vip', 'points'].includes(key),
    )
  )
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  const clean = (value: unknown, field: string, max: number, required: boolean): string | null => {
    if (value === null && !required) return null;
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}/u.test(value))
      throw new C360WriteValidationError([{ field, code: 'FIELD_INVALID' }]);
    const normalized = value.trim().normalize('NFC');
    if (normalized.length > max || (required && normalized.length === 0))
      throw new C360WriteValidationError([{ field, code: 'FIELD_INVALID' }]);
    return normalized || null;
  };
  if (input.vip !== undefined && typeof input.vip !== 'boolean')
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  const points: C360NormalizedContactPoint[] = [];
  if (input.points !== undefined) {
    if (!Array.isArray(input.points) || input.points.length > C360_CONTACT_POINT_QUOTA * 2)
      throw new C360WriteValidationError([{ field: 'points', code: 'POINT_QUOTA_EXCEEDED' }]);
    for (const [index, raw] of input.points.entries()) {
      const field = `points.${index}`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new C360WriteValidationError([{ field, code: 'INVALID_REQUEST' }]);
      const point = raw as Record<string, unknown>;
      if (Object.keys(point).some((key) => !['kind', 'value', 'explicitCountry'].includes(key)))
        throw new C360WriteValidationError([{ field, code: 'INVALID_REQUEST' }]);
      try {
        if (point.kind === 'PHONE')
          points.push(normalizeC360Phone(point.value, point.explicitCountry));
        else if (
          point.kind === 'EMAIL' &&
          (point.explicitCountry === undefined || point.explicitCountry === null)
        )
          points.push(normalizeC360Email(point.value));
        else throw new C360WriteValidationError([{ field, code: 'INVALID_REQUEST' }]);
      } catch (error) {
        if (error instanceof C360ContactPointError)
          throw new C360WriteValidationError([{ field, code: error.code }]);
        throw error;
      }
    }
    for (const kind of ['PHONE', 'EMAIL'] as const) {
      const matching = points.filter((point) => point.kind === kind);
      if (matching.length > C360_CONTACT_POINT_QUOTA)
        throw new C360WriteValidationError([{ field: 'points', code: 'POINT_QUOTA_EXCEEDED' }]);
      if (
        new Set(matching.map((point) => `${point.normalizationVersion}:${point.normalizedValue}`))
          .size !== matching.length
      )
        throw new C360WriteValidationError([{ field: 'points', code: 'POINT_DUPLICATE' }]);
    }
  }
  return {
    points,
    displayName: clean(input.displayName, 'displayName', C360_PROFILE_NAME_MAX, true)!,
    company:
      input.company === undefined
        ? null
        : clean(input.company, 'company', C360_PROFILE_COMPANY_MAX, false),
    vip: input.vip === true,
  };
}

export interface C360ProfilePatch {
  displayName?: string;
  company?: string | null;
  vip?: boolean;
}

export function normalizeC360ProfilePatch(input: Record<string, unknown>): C360ProfilePatch {
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'commandId',
          'expectedProfileRevision',
          'expectedLineageRevision',
          'displayName',
          'company',
          'vip',
        ].includes(key),
    )
  )
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  const patch: C360ProfilePatch = {};
  for (const field of ['displayName', 'company'] as const) {
    if (!Object.hasOwn(input, field)) continue;
    const value = input[field];
    if (field === 'company' && value === null) {
      patch.company = null;
      continue;
    }
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]|\p{Cs}/u.test(value))
      throw new C360WriteValidationError([{ field, code: 'FIELD_INVALID' }]);
    const normalized = value.trim().normalize('NFC');
    if (
      normalized.length >
        (field === 'displayName' ? C360_PROFILE_NAME_MAX : C360_PROFILE_COMPANY_MAX) ||
      (field === 'displayName' && !normalized)
    )
      throw new C360WriteValidationError([{ field, code: 'FIELD_INVALID' }]);
    if (field === 'displayName') patch.displayName = normalized;
    else patch.company = normalized || null;
  }
  if (Object.hasOwn(input, 'vip')) {
    if (typeof input.vip !== 'boolean')
      throw new C360WriteValidationError([{ field: 'vip', code: 'FIELD_INVALID' }]);
    patch.vip = input.vip;
  }
  if (Object.keys(patch).length === 0) throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  return patch;
}

/** ตรวจสิทธิ์ resource อีกครั้งภายใต้ fence เดียวกับ operator grant/revoke และ C360 owner */
export async function updateC360Profile(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  contactId: string,
  expectedProfileRevision: string,
  expectedLineageRevision: string,
  patch: C360ProfilePatch,
): Promise<C360ProfileEffect> {
  const access = (await fenceC360ContactMutation(tx, actor, [contactId])).get(contactId);
  if (!access || access.decision === 'DENY') throw new C360WriteNotFound();
  if (access.decision === 'DEFER') throw new C360WriteScopeUnavailable();
  if (!access.manage) throw new C360WriteDenied();
  let rows: {
    display_name: string | null;
    company: string | null;
    vip: boolean;
    profile_revision: bigint;
    lineage_revision: number | null;
  }[];
  try {
    rows = await tx.$queryRaw`SELECT c.display_name, c.company, c.vip, c.profile_revision,
      (SELECT h.lineage_revision FROM c360_identity_heads h WHERE h.tenant_id = c.tenant_id AND h.contact_id = c.id) AS lineage_revision
      FROM contacts c WHERE c.tenant_id = ${actor.tenantId}::uuid AND c.id = ${contactId}::uuid FOR NO KEY UPDATE OF c NOWAIT`;
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (/55P03|lock_not_available|could not obtain lock/.test(text))
      throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
    throw error;
  }
  const row = rows[0];
  if (!row) throw new C360ProfileCommandRejection('RESOURCE_NOT_FOUND', 404);
  if (
    row.profile_revision.toString() !== expectedProfileRevision ||
    row.lineage_revision?.toString() !== expectedLineageRevision
  )
    throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
  const changed: string[] = [];
  if (patch.displayName !== undefined && patch.displayName !== row.display_name)
    changed.push('displayName');
  if (patch.company !== undefined && patch.company !== row.company) changed.push('company');
  if (patch.vip !== undefined && patch.vip !== row.vip) changed.push('vip');
  const before = row.profile_revision.toString();
  if (!changed.length)
    return {
      outcome: 'NO_OP',
      committedRevisions: { profile: before },
      resourceRefs: [{ type: 'CONTACT', id: contactId }],
    };
  const after = (row.profile_revision + 1n).toString();
  await tx.contact.update({
    where: { id: contactId },
    data: {
      ...patch,
      ...(changed.includes('vip') ? { vipSource: 'PROFILE_COMMAND' } : {}),
      profileRevision: BigInt(after),
    },
  });
  return {
    outcome: 'APPLIED',
    httpStatus: 200,
    committedRevisions: { profile: after },
    resourceRefs: [{ type: 'CONTACT', id: contactId }],
    audits: [
      {
        operation: 'CONTACT_UPDATE',
        resourceType: 'CONTACT',
        resourceId: contactId,
        changedFields: changed,
        beforeRevisions: { profile: before },
        afterRevisions: { profile: after },
      },
    ],
  };
}

/** เรียกภายใน transaction ของ command หลังตรวจสิทธิ์และถือ command fence */
export async function createC360Profile(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  commandActor: C360CommandActor,
  command: C360PreparedProfileCommand,
  profile: C360CreateProfile,
): Promise<C360ProfileEffect> {
  try {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM users WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${actor.userId}::uuid
      FOR NO KEY UPDATE NOWAIT`;
    if (!rows.length || !(await authorizeC360ContactCreate(tx, actor))) throw new C360WriteDenied();
  } catch (error) {
    if (error instanceof C360WriteDenied) throw error;
    const text = error instanceof Error ? error.message : '';
    if (/55P03|lock_not_available|could not obtain lock/.test(text))
      throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
    throw error;
  }
  const contactId = randomUUID();
  const [fence] = await tx.$queryRaw<{ locked: boolean }[]>`
    SELECT pg_try_advisory_xact_lock(hashtext(${c360IdentityFenceKey(actor.tenantId, contactId)})) AS locked`;
  if (!fence?.locked) throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
  await tx.contact.create({
    data: {
      id: contactId,
      tenantId: actor.tenantId,
      displayName: profile.displayName,
      company: profile.company,
      vip: profile.vip,
      vipSource: 'PROFILE_COMMAND',
    },
  });
  const head = await initializeC360IdentityHead(tx, actor.tenantId, contactId);
  if (head.outcome !== 'INITIALIZED') throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
  await tx.c360ContactCustodianGrant.create({
    data: {
      id: randomUUID(),
      tenantId: actor.tenantId,
      contactId,
      granteeUserId: actor.userId,
      permission: 'MANAGE',
      origin: 'CREATOR',
      actorIdentityKey: commandActor.actorIdentityKey,
      commandId: command.commandId,
      actorUserId: actor.userId,
    },
  });
  if (profile.points.length) {
    await tx.c360ContactPoint.createMany({
      data: profile.points.map((point) => ({
        id: randomUUID(),
        tenantId: actor.tenantId,
        contactId,
        ...point,
        state: 'ACTIVE',
        sourceKind: 'PROFILE_COMMAND',
        createdActorIdentityKey: commandActor.actorIdentityKey,
        createdCommandId: command.commandId,
      })),
    });
  }
  return {
    outcome: 'APPLIED',
    httpStatus: 201,
    committedRevisions: { profile: '0', tag: '0', lineage: '0' },
    resourceRefs: [{ type: 'CONTACT', id: contactId }],
    audits: [
      {
        operation: 'CONTACT_CREATE',
        resourceType: 'CONTACT',
        resourceId: contactId,
        changedFields: [
          'displayName',
          'company',
          'vip',
          ...(profile.points.length ? ['points'] : []),
        ],
        beforeRevisions: {},
        afterRevisions: { profile: '0', tag: '0', lineage: '0' },
      },
    ],
  };
}

/** เพิ่ม/ถอดแท็กที่มีอยู่ภายใต้ identity, custodian, profile และ tag row fences */
export async function updateC360ProfileTags(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  commandActor: C360CommandActor,
  command: C360PreparedProfileCommand,
  contactId: string,
  expectedTagRevision: string,
  expectedLineageRevision: string,
  attachIds: string[],
  detachIds: string[],
): Promise<C360ProfileEffect> {
  const access = (await fenceC360ContactMutation(tx, actor, [contactId])).get(contactId);
  if (!access || access.decision === 'DENY') throw new C360WriteNotFound();
  if (access.decision === 'DEFER') throw new C360WriteScopeUnavailable();
  if (!access.manage) throw new C360WriteDenied();
  let contacts: { tag_revision: bigint; lineage_revision: number | null }[];
  try {
    contacts = await tx.$queryRaw`SELECT c.tag_revision,
      (SELECT h.lineage_revision FROM c360_identity_heads h WHERE h.tenant_id = c.tenant_id AND h.contact_id = c.id) AS lineage_revision
      FROM contacts c WHERE c.tenant_id = ${actor.tenantId}::uuid AND c.id = ${contactId}::uuid FOR NO KEY UPDATE OF c NOWAIT`;
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (/55P03|lock_not_available|could not obtain lock/.test(text))
      throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
    throw error;
  }
  const contact = contacts[0];
  if (!contact) throw new C360ProfileCommandRejection('RESOURCE_NOT_FOUND', 404);
  if (
    contact.tag_revision.toString() !== expectedTagRevision ||
    contact.lineage_revision?.toString() !== expectedLineageRevision
  )
    throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
  const ids = [...attachIds, ...detachIds].sort();
  let tags: { id: string; state: string }[] = [];
  if (ids.length) {
    try {
      tags = await tx.$queryRaw(Prisma.sql`SELECT id, state FROM c360_tags
        WHERE tenant_id = ${actor.tenantId}::uuid AND id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
        ORDER BY id FOR SHARE NOWAIT`);
    } catch (error) {
      const text = error instanceof Error ? error.message : '';
      if (/55P03|lock_not_available|could not obtain lock/.test(text))
        throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
      throw error;
    }
    if (tags.length !== ids.length) throw new C360ProfileCommandRejection('TAG_NOT_FOUND', 404);
  }
  const existing = await tx.c360ContactTag.findMany({
    where: { tenantId: actor.tenantId, contactId },
    select: { tagId: true },
  });
  const existingIds = new Set(existing.map((tag) => tag.tagId));
  const add = attachIds.filter((id) => !existingIds.has(id));
  const remove = detachIds.filter((id) => existingIds.has(id));
  if (add.some((id) => tags.find((tag) => tag.id === id)?.state !== 'ACTIVE'))
    throw new C360ProfileCommandRejection('TAG_RETIRED', 409);
  const before = contact.tag_revision.toString();
  if (!add.length && !remove.length)
    return {
      outcome: 'NO_OP',
      committedRevisions: { tag: before },
      resourceRefs: [{ type: 'CONTACT', id: contactId }],
    };
  if (remove.length)
    await tx.c360ContactTag.deleteMany({
      where: { tenantId: actor.tenantId, contactId, tagId: { in: remove } },
    });
  if (add.length)
    await tx.c360ContactTag.createMany({
      data: add.map((tagId) => ({
        tenantId: actor.tenantId,
        contactId,
        tagId,
        actorIdentityKey: commandActor.actorIdentityKey,
        commandId: command.commandId,
      })),
    });
  const after = (contact.tag_revision + 1n).toString();
  await tx.contact.update({ where: { id: contactId }, data: { tagRevision: BigInt(after) } });
  return {
    outcome: 'APPLIED',
    httpStatus: 200,
    committedRevisions: { tag: after },
    resourceRefs: [{ type: 'CONTACT', id: contactId }],
    audits: [...(add.length ? ['TAG_ATTACH'] : []), ...(remove.length ? ['TAG_DETACH'] : [])].map(
      (operation) => ({
        operation,
        resourceType: 'CONTACT',
        resourceId: contactId,
        changedFields: ['tags'],
        beforeRevisions: { tag: before },
        afterRevisions: { tag: after },
      }),
    ),
  };
}
