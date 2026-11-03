import {
  normalizeC360ServiceOperatorCommand,
  isC360ServiceOperatorCommand,
  planC360ServiceOperator,
  type C360ServiceOperatorCommand,
} from './service-principal.js';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  C360ProfileCommandError,
  C360ProfileCommandRejection,
  c360ActorIdentityKey,
  c360MutationTransaction,
  c360Uuid,
  executeC360ProfileCommand,
  lookupC360ProfileCommand,
  reconcileC360ProfileCommand,
  type C360CommandAuthorization,
  type C360AuditEvent,
  type C360CommandActor,
  type C360ProfileCommandResult,
  type C360ProfileEffect,
  type C360ResourceRef,
} from './profile-command.js';
import { tryC360IdentityFences } from './profile-fences.js';
import {
  C360_LEGACY_IMPORT_BATCH_MAX,
  importC360LegacyContactPointsBatch,
  inventoryC360LegacyContactPoints,
  type C360LegacyInventory,
} from './profile-points-legacy.js';
import {
  C360TagNameError,
  C360_TAG_NORMALIZATION_VERSION,
  normalizeC360TagName,
} from './profile-tags.js';
import {
  C360MembershipRepositoryError,
  initializeC360IdentityHead,
} from './segment-membership-repository.js';

/**
 * Cus360 C1 (#791) S5: operator commands ตาม E1 D
 *
 * - เป็น command เฉพาะงานของ trusted platform operator ไม่มี public self-grant endpoint
 * - ทุกคำสั่งต้องมี commandId, evidenceRef และ reasonCode (code ไม่ใช่ข้อความอิสระ จึงไม่พา PII เข้า audit)
 * - dry-run ใช้ตรรกะตรวจเดียวกับของจริงใน transaction ที่ไม่เขียนอะไร และคืน preview ที่ไม่มี PII
 * - ของจริงผ่าน S2 engine: admission/receipt/tombstone/idempotency และ effect+audit+receipt atomic
 * - ไม่เชื่อ role/email/token แทนหลักฐาน: grantee ต้องเป็น active ADMIN ปัจจุบัน และไม่ใช่ตัว operator เอง
 */

export const C360_OPERATOR_CONTRACT_VERSION = 'c360-operator-v1';
const TAG_SEED_MAX = 200;

/** Operator ที่ gateway ตรวจ signature/role แล้ว; userId คือ dc_user_id ของ token (อาจไม่มี User row) */
export interface C360TrustedOperator {
  tenantId: string;
  issuer: string;
  subject: string;
  userId: string | null;
}

export type C360OperatorCommand =
  | C360ServiceOperatorCommand
  | {
      action: 'CUSTODIAN_GRANT';
      contactId: string;
      granteeUserId: string;
      permission: 'READ' | 'MANAGE';
    }
  | { action: 'CUSTODIAN_REVOKE'; grantId: string }
  | {
      /** creator/ผู้ถือเดิมใช้ไม่ได้: ให้ Admin ที่อนุมัติแล้วและถอน grant เดิมใน transaction เดียว */
      action: 'CUSTODIAN_RECOVER';
      contactId: string;
      granteeUserId: string;
      permission: 'READ' | 'MANAGE';
      revokeGrantIds: string[];
    }
  | { action: 'CAPABILITY_GRANT'; granteeUserId: string; capability: 'CONTACT_CREATE' }
  | { action: 'CAPABILITY_REVOKE'; grantId: string }
  | { action: 'TAG_SEED'; names: string[] }
  | { action: 'IDENTITY_HEAD_INIT'; contactId: string }
  /** C3 (#793) S3: import legacy ContactIdentity PHONE/EMAIL เป็น contact point ทีละ batch */
  | { action: 'LEGACY_POINT_IMPORT'; batchSize: number };

export interface C360OperatorRequest {
  commandId: unknown;
  evidenceRef: unknown;
  reasonCode: unknown;
  command: C360OperatorCommand;
}

export interface C360OperatorPreview {
  dryRun: true;
  action: C360OperatorCommand['action'];
  outcome: 'WOULD_APPLY' | 'WOULD_NO_OP' | 'WOULD_REJECT';
  code: string | null;
  /** ระบุ resource/ผู้รับสิทธิ์ด้วย ID/role/state เท่านั้น ไม่มีชื่อ email หรือ contact value */
  subjects: Array<{ type: string; id: string; facts: Record<string, string | boolean | null> }>;
}

interface Plan {
  outcome: 'APPLY' | 'NO_OP';
  resourceType: string;
  resourceId: string | null;
  subjects: C360OperatorPreview['subjects'];
  apply: (
    tx: Prisma.TransactionClient,
    command: { commandId: string },
  ) => Promise<{
    refs: C360ResourceRef[];
    audits: C360AuditEvent[];
    committedRevisions?: Record<string, string>;
  }>;
  refs: C360ResourceRef[];
}

function invalid(): never {
  throw new C360ProfileCommandError('INVALID_REQUEST', 400);
}

function evidenceRef(value: unknown): string {
  // reference ทึบไปยังหลักฐานภายนอก (ticket/approval) ไม่ใช่ข้อความอิสระ
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/#-]{2,199}$/.test(value)) invalid();
  return value;
}

function reasonCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(value)) invalid();
  return value;
}

function permission(value: unknown): 'READ' | 'MANAGE' {
  if (value !== 'READ' && value !== 'MANAGE') invalid();
  return value;
}

/** Validate + normalize ก่อนคำนวณ digest; ค่าที่ไม่รู้จักถูกปฏิเสธ ไม่ถูกตัดทิ้งเงียบ ๆ */
export function normalizeC360OperatorCommand(command: unknown): C360OperatorCommand {
  if (!command || typeof command !== 'object' || Array.isArray(command)) invalid();
  const input = command as Record<string, unknown>;
  const only = (...keys: string[]) => {
    if (Object.keys(input).some((key) => !['action', ...keys].includes(key))) invalid();
  };
  switch (input.action) {
    case 'CUSTODIAN_GRANT':
      only('contactId', 'granteeUserId', 'permission');
      return {
        action: input.action,
        contactId: c360Uuid(input.contactId),
        granteeUserId: c360Uuid(input.granteeUserId),
        permission: permission(input.permission),
      };
    case 'CUSTODIAN_REVOKE':
    case 'CAPABILITY_REVOKE':
      only('grantId');
      return { action: input.action, grantId: c360Uuid(input.grantId) };
    case 'CUSTODIAN_RECOVER': {
      only('contactId', 'granteeUserId', 'permission', 'revokeGrantIds');
      if (!Array.isArray(input.revokeGrantIds) || input.revokeGrantIds.length > 20) invalid();
      const revokeGrantIds = [...new Set(input.revokeGrantIds.map(c360Uuid))].sort();
      if (revokeGrantIds.length !== input.revokeGrantIds.length) invalid();
      return {
        action: input.action,
        contactId: c360Uuid(input.contactId),
        granteeUserId: c360Uuid(input.granteeUserId),
        permission: permission(input.permission),
        revokeGrantIds,
      };
    }
    case 'CAPABILITY_GRANT':
      only('granteeUserId', 'capability');
      if (input.capability !== 'CONTACT_CREATE') invalid();
      return {
        action: input.action,
        granteeUserId: c360Uuid(input.granteeUserId),
        capability: input.capability,
      };
    case 'TAG_SEED': {
      only('names');
      if (
        !Array.isArray(input.names) ||
        input.names.length === 0 ||
        input.names.length > TAG_SEED_MAX
      )
        invalid();
      try {
        // เก็บชื่อแสดงตามที่ normalize แล้ว; ซ้ำกันใน request เดียวตัดสินที่ plan (TAG_NAME_DUPLICATE)
        return {
          action: input.action,
          names: input.names.map((n) => normalizeC360TagName(n).name),
        };
      } catch (error) {
        if (error instanceof C360TagNameError) invalid();
        throw error;
      }
    }
    case 'IDENTITY_HEAD_INIT':
      only('contactId');
      return { action: input.action, contactId: c360Uuid(input.contactId) };
    case 'LEGACY_POINT_IMPORT':
      only('batchSize');
      if (
        !Number.isInteger(input.batchSize) ||
        (input.batchSize as number) < 1 ||
        (input.batchSize as number) > C360_LEGACY_IMPORT_BATCH_MAX
      )
        invalid();
      return { action: input.action, batchSize: input.batchSize as number };
    default:
      return normalizeC360ServiceOperatorCommand(input);
  }
}

function operatorActor(operator: C360TrustedOperator): C360CommandActor {
  return {
    tenantId: c360Uuid(operator.tenantId),
    actorIdentityKey: c360ActorIdentityKey({
      issuer: operator.issuer,
      subject: operator.subject,
      tenantId: operator.tenantId,
      userId: operator.userId,
    }),
    // operator ไม่ใช่ domain User ของ tenant; ตัวตนอยู่ใน actorIdentityKey
    actorUserId: null,
  };
}

const isOperatorCommand: NonNullable<C360CommandAuthorization['canAccessCommand']> = (command) =>
  command.actorUserId === null &&
  (command.isTombstone || command.action?.startsWith('OPERATOR_') === true);

async function operatorCommandActor(
  db: PrismaClient,
  operator: C360TrustedOperator,
  commandIdInput: unknown,
): Promise<C360CommandActor> {
  const legacy = operatorActor(operator);
  const commandId = c360Uuid(commandIdInput);
  // คำสั่งที่ admit แล้วใน C1 ยัง recover ได้ด้วย key เดิม
  const stored = await withTenantDatabaseTransaction(db, legacy.tenantId, (tx) =>
    tx.c360ProfileCommand.findUnique({
      where: {
        tenantId_actorIdentityKey_commandId: {
          tenantId: legacy.tenantId,
          actorIdentityKey: legacy.actorIdentityKey,
          commandId,
        },
      },
      select: { actorUserId: true, action: true, isTombstone: true },
    }),
  );
  if (stored && isOperatorCommand(stored)) return legacy;
  // แยก key ของคำสั่งและ tombstone ใหม่จาก namespace ของ domain User
  return {
    ...legacy,
    actorIdentityKey: createHash('sha256')
      .update(JSON.stringify(['c360-operator-actor-v1', legacy.actorIdentityKey]))
      .digest('hex'),
  };
}

async function lockBusy<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    if (/55P03|lock_not_available|could not obtain lock/.test(text))
      throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
    if (error instanceof C360MembershipRepositoryError && error.code === 'RESOURCE_BUSY')
      throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
    throw error;
  }
}

/** grantee ต้องเป็น active ADMIN ปัจจุบันของ tenant และไม่ใช่ operator เอง (ล็อก User ก่อน identity ตาม G) */
async function lockAdminGrantee(
  tx: Prisma.TransactionClient,
  operator: C360TrustedOperator,
  granteeUserId: string,
) {
  const [user] = await lockBusy(
    () =>
      tx.$queryRaw<{ id: string; role: string; is_active: boolean; keycloak_id: string | null }[]>`
      SELECT id, role::text AS role, is_active, keycloak_id FROM users
      WHERE tenant_id = ${operator.tenantId}::uuid AND id = ${granteeUserId}::uuid
      FOR SHARE NOWAIT`,
  );
  if (!user) throw new C360ProfileCommandRejection('GRANTEE_NOT_FOUND', 404);
  if (user.id === operator.userId || user.keycloak_id === operator.subject)
    throw new C360ProfileCommandRejection('SELF_GRANT_FORBIDDEN', 422);
  if (!user.is_active || user.role !== 'ADMIN')
    throw new C360ProfileCommandRejection('GRANTEE_NOT_ACTIVE_ADMIN', 422);
  return {
    type: 'USER',
    id: user.id,
    facts: { role: user.role, active: user.is_active } as Record<string, string | boolean | null>,
  };
}

/** contact ต้องอยู่ใน tenant และเป็น canonical (head ACTIVE) หรือ legacy ที่ยังไม่มี head */
async function lockCanonicalContact(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactId: string,
) {
  await tryC360IdentityFences(tx, tenantId, [contactId]);
  const [row] = await tx.$queryRaw<{ identity: string | null }[]>`
    SELECT (SELECT state::text FROM c360_identity_heads ih
            WHERE ih.tenant_id = c.tenant_id AND ih.contact_id = c.id) AS identity
    FROM contacts c WHERE c.tenant_id = ${tenantId}::uuid AND c.id = ${contactId}::uuid`;
  if (!row) throw new C360ProfileCommandRejection('CONTACT_NOT_FOUND', 404);
  // grant ไม่ตามไป canonical target หลัง merge และไม่ให้บน contact ที่ไม่ใช่ canonical
  if (row.identity !== null && row.identity !== 'ACTIVE')
    throw new C360ProfileCommandRejection('CONTACT_NOT_CANONICAL', 409);
  return {
    type: 'CONTACT',
    id: contactId,
    facts: { identity: row.identity ?? 'LEGACY_MISSING_HEAD' } as Record<
      string,
      string | boolean | null
    >,
  };
}

async function activeCustodian(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactId: string,
  granteeUserId: string,
  level: 'READ' | 'MANAGE',
) {
  return tx.c360ContactCustodianGrant.findFirst({
    where: {
      tenantId,
      contactId,
      granteeUserId,
      permission: level,
      NOT: { id: { in: await revokedCustodianIds(tx, tenantId, contactId) } },
    },
  });
}

async function revokedCustodianIds(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactId: string,
) {
  const rows = await tx.$queryRaw<{ grant_id: string }[]>`
    SELECT r.grant_id FROM c360_contact_custodian_revocations r
    JOIN c360_contact_custodian_grants g ON g.tenant_id = r.tenant_id AND g.id = r.grant_id
    WHERE r.tenant_id = ${tenantId}::uuid AND g.contact_id = ${contactId}::uuid`;
  return rows.map((row) => row.grant_id);
}

async function plan(
  tx: Prisma.TransactionClient,
  operator: C360TrustedOperator,
  command: C360OperatorCommand,
  evidence: string,
  reason: string,
  actor: C360CommandActor,
): Promise<Plan> {
  if (isC360ServiceOperatorCommand(command))
    return planC360ServiceOperator(tx, operator, command, evidence, reason, actor);
  const tenantId = operator.tenantId;
  const audit = (
    operation: string,
    resourceType: string,
    resourceId: string,
    changedFields: string[],
  ): C360AuditEvent => ({
    operation,
    resourceType,
    resourceId,
    changedFields,
    beforeRevisions: {},
    afterRevisions: {},
    evidenceRefs: [evidence, `reason:${reason}`],
  });

  switch (command.action) {
    case 'CUSTODIAN_GRANT':
    case 'CUSTODIAN_RECOVER': {
      const grantee = await lockAdminGrantee(tx, operator, command.granteeUserId);
      const contact = await lockCanonicalContact(tx, tenantId, command.contactId);
      const revoking =
        command.action === 'CUSTODIAN_RECOVER'
          ? await tx.c360ContactCustodianGrant.findMany({
              where: { tenantId, id: { in: command.revokeGrantIds } },
            })
          : [];
      if (command.action === 'CUSTODIAN_RECOVER') {
        const revoked = new Set(await revokedCustodianIds(tx, tenantId, command.contactId));
        if (
          revoking.length !== command.revokeGrantIds.length ||
          revoking.some((grant) => grant.contactId !== command.contactId || revoked.has(grant.id))
        )
          throw new C360ProfileCommandRejection('GRANT_NOT_REVOCABLE', 409);
        if (revoking.some((grant) => grant.granteeUserId === command.granteeUserId))
          throw new C360ProfileCommandRejection('RECOVERY_TARGET_IS_REVOKED_HOLDER', 422);
      }
      const existing = await activeCustodian(
        tx,
        tenantId,
        command.contactId,
        command.granteeUserId,
        command.permission,
      );
      const refs = [{ type: 'CONTACT', id: command.contactId }];
      const subjects = [
        grantee,
        contact,
        ...revoking.map((grant) => ({
          type: 'CUSTODIAN_GRANT',
          id: grant.id,
          facts: { permission: grant.permission, origin: grant.origin, revoke: true },
        })),
      ];
      return {
        outcome: existing && revoking.length === 0 ? 'NO_OP' : 'APPLY',
        resourceType: 'CONTACT',
        resourceId: command.contactId,
        subjects,
        refs,
        apply: async (write, { commandId }) => {
          const audits: C360AuditEvent[] = [];
          for (const grant of revoking) {
            await write.c360ContactCustodianRevocation.create({
              data: {
                id: randomUUID(),
                tenantId,
                grantId: grant.id,
                actorIdentityKey: actor.actorIdentityKey,
                commandId,
                actorUserId: null,
                reason,
                evidenceRef: evidence,
              },
            });
            audits.push(audit('CUSTODIAN_REVOKE', 'CONTACT', command.contactId, ['custodian']));
          }
          if (!existing) {
            await write.c360ContactCustodianGrant.create({
              data: {
                id: randomUUID(),
                tenantId,
                contactId: command.contactId,
                granteeUserId: command.granteeUserId,
                permission: command.permission,
                origin: 'OPERATOR',
                evidenceRef: evidence,
                actorIdentityKey: actor.actorIdentityKey,
                commandId,
                actorUserId: null,
              },
            });
            audits.push(audit('CUSTODIAN_GRANT', 'CONTACT', command.contactId, ['custodian']));
          }
          return { refs, audits };
        },
      };
    }
    case 'CUSTODIAN_REVOKE': {
      const grant = await tx.c360ContactCustodianGrant.findFirst({
        where: { tenantId, id: command.grantId },
      });
      if (!grant) throw new C360ProfileCommandRejection('GRANT_NOT_FOUND', 404);
      await tryC360IdentityFences(tx, tenantId, [grant.contactId]);
      const revoked = await tx.c360ContactCustodianRevocation.findFirst({
        where: { tenantId, grantId: grant.id },
      });
      const refs = [{ type: 'CONTACT', id: grant.contactId }];
      return {
        outcome: revoked ? 'NO_OP' : 'APPLY',
        resourceType: 'CONTACT',
        resourceId: grant.contactId,
        subjects: [
          {
            type: 'CUSTODIAN_GRANT',
            id: grant.id,
            facts: { permission: grant.permission, origin: grant.origin, revoked: !!revoked },
          },
        ],
        refs,
        apply: async (write, { commandId }) => {
          await write.c360ContactCustodianRevocation.create({
            data: {
              id: randomUUID(),
              tenantId,
              grantId: grant.id,
              actorIdentityKey: actor.actorIdentityKey,
              commandId,
              actorUserId: null,
              reason,
              evidenceRef: evidence,
            },
          });
          return {
            refs,
            audits: [audit('CUSTODIAN_REVOKE', 'CONTACT', grant.contactId, ['custodian'])],
          };
        },
      };
    }
    case 'CAPABILITY_GRANT': {
      const grantee = await lockAdminGrantee(tx, operator, command.granteeUserId);
      const existing = await tx.$queryRaw<{ id: string }[]>`
        SELECT g.id FROM c360_actor_capability_grants g
        WHERE g.tenant_id = ${tenantId}::uuid AND g.grantee_user_id = ${command.granteeUserId}::uuid
          AND g.capability = ${command.capability}
          AND NOT EXISTS (SELECT 1 FROM c360_actor_capability_revocations r
                          WHERE r.tenant_id = g.tenant_id AND r.grant_id = g.id)`;
      const refs = [{ type: 'USER', id: command.granteeUserId }];
      return {
        outcome: existing.length > 0 ? 'NO_OP' : 'APPLY',
        resourceType: 'USER',
        resourceId: command.granteeUserId,
        subjects: [grantee],
        refs,
        apply: async (write, { commandId }) => {
          await write.c360ActorCapabilityGrant.create({
            data: {
              id: randomUUID(),
              tenantId,
              granteeUserId: command.granteeUserId,
              capability: command.capability,
              evidenceRef: evidence,
              actorIdentityKey: actor.actorIdentityKey,
              commandId,
              actorUserId: null,
            },
          });
          return {
            refs,
            audits: [audit('CAPABILITY_GRANT', 'USER', command.granteeUserId, ['capability'])],
          };
        },
      };
    }
    case 'CAPABILITY_REVOKE': {
      const grant = await tx.c360ActorCapabilityGrant.findFirst({
        where: { tenantId, id: command.grantId },
      });
      if (!grant) throw new C360ProfileCommandRejection('GRANT_NOT_FOUND', 404);
      const revoked = await tx.c360ActorCapabilityRevocation.findFirst({
        where: { tenantId, grantId: grant.id },
      });
      const refs = [{ type: 'USER', id: grant.granteeUserId }];
      return {
        outcome: revoked ? 'NO_OP' : 'APPLY',
        resourceType: 'USER',
        resourceId: grant.granteeUserId,
        subjects: [
          {
            type: 'CAPABILITY_GRANT',
            id: grant.id,
            facts: { capability: grant.capability, revoked: !!revoked },
          },
        ],
        refs,
        apply: async (write, { commandId }) => {
          await write.c360ActorCapabilityRevocation.create({
            data: {
              id: randomUUID(),
              tenantId,
              grantId: grant.id,
              actorIdentityKey: actor.actorIdentityKey,
              commandId,
              actorUserId: null,
              reason,
              evidenceRef: evidence,
            },
          });
          return {
            refs,
            audits: [audit('CAPABILITY_REVOKE', 'USER', grant.granteeUserId, ['capability'])],
          };
        },
      };
    }
    case 'TAG_SEED': {
      const entries = command.names.map((name) => normalizeC360TagName(name));
      const keys = entries.map((entry) => entry.nameKey);
      if (new Set(keys).size !== keys.length)
        throw new C360ProfileCommandRejection('TAG_NAME_DUPLICATE', 422);
      // fence ต่อ nameKey เรียงลำดับ: seed สองคำสั่งชื่อเดียวกันไม่ชนกันที่ unique แล้วกลายเป็น 500
      for (const nameKey of [...keys].sort()) {
        const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended(${`c360-tag:${tenantId}:${nameKey}`}, 0)) AS locked`;
        if (!row?.locked) throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
      }
      const existing = await tx.c360Tag.findMany({
        where: { tenantId, nameKey: { in: keys } },
      });
      if (existing.some((tag) => tag.state !== 'ACTIVE'))
        throw new C360ProfileCommandRejection('TAG_NAME_RESERVED', 409);
      const present = new Set(existing.map((tag) => tag.nameKey));
      const missing = entries.filter((entry) => !present.has(entry.nameKey));
      const ids = new Map(missing.map((entry) => [entry.nameKey, randomUUID()]));
      const refs = [
        ...existing.map((tag) => ({ type: 'TAG', id: tag.id })),
        ...missing.map((entry) => ({ type: 'TAG', id: ids.get(entry.nameKey)! })),
      ];
      return {
        outcome: missing.length === 0 ? 'NO_OP' : 'APPLY',
        resourceType: 'TAG_CATALOG',
        resourceId: null,
        subjects: [
          ...existing.map((tag) => ({
            type: 'TAG',
            id: tag.id,
            facts: { state: tag.state, create: false },
          })),
          ...missing.map((entry) => ({
            type: 'TAG',
            id: ids.get(entry.nameKey)!,
            facts: { state: 'ACTIVE', create: true },
          })),
        ],
        refs,
        apply: async (write, { commandId }) => {
          const audits: C360AuditEvent[] = [];
          for (const entry of missing) {
            const id = ids.get(entry.nameKey)!;
            await write.c360Tag.create({
              data: {
                id,
                tenantId,
                name: entry.name,
                nameKey: entry.nameKey,
                state: 'ACTIVE',
                revision: 0n,
                actorIdentityKey: actor.actorIdentityKey,
                commandId,
                evidenceRef: evidence,
              },
            });
            audits.push({
              ...audit('TAG_CREATE', 'TAG', id, ['name', 'state']),
              afterRevisions: { tag: '0' },
            });
          }
          return { refs, audits };
        },
      };
    }
    case 'IDENTITY_HEAD_INIT': {
      const contact = await tx.contact.findFirst({
        where: { tenantId, id: command.contactId },
        select: { id: true },
      });
      if (!contact) throw new C360ProfileCommandRejection('CONTACT_NOT_FOUND', 404);
      const check = await lockBusy(() =>
        initializeC360IdentityHead(tx, tenantId, command.contactId, { dryRun: true }),
      );
      if (check.outcome === 'LINEAGE_CONFLICT')
        throw new C360ProfileCommandRejection('IDENTITY_LINEAGE_CONFLICT', 409);
      const refs = [{ type: 'CONTACT', id: command.contactId }];
      return {
        outcome: check.outcome === 'ALREADY_PRESENT' ? 'NO_OP' : 'APPLY',
        resourceType: 'CONTACT',
        resourceId: command.contactId,
        subjects: [
          {
            type: 'CONTACT',
            id: command.contactId,
            facts: {
              identity: check.outcome === 'ALREADY_PRESENT' ? check.state : 'LEGACY_MISSING_HEAD',
            },
          },
        ],
        refs,
        apply: async (write) => {
          await initializeC360IdentityHead(write, tenantId, command.contactId);
          return {
            refs,
            audits: [
              {
                ...audit('IDENTITY_HEAD_INIT', 'CONTACT', command.contactId, ['identity']),
                afterRevisions: { lineage: '0' },
              },
            ],
            committedRevisions: { lineage: '0' },
          };
        },
      };
    }
    case 'LEGACY_POINT_IMPORT': {
      // แต่ละ batch ตรวจแค่ว่ายังมีค้างไหม (จำนวนคงเหลือคำนวณครั้งเดียวหลัง import ใน batch)
      const [row] = await tx.$queryRaw<{ pending: boolean }[]>`
        SELECT EXISTS (
          SELECT 1 FROM contact_identities ci
          WHERE ci.tenant_id = ${tenantId}::uuid AND ci.type::text IN ('PHONE', 'EMAIL')
            AND NOT EXISTS (SELECT 1 FROM c360_contact_points p
                            WHERE p.tenant_id = ci.tenant_id AND p.source_identity_id = ci.id)
        ) AS pending`;
      const pending = row?.pending ? 1 : 0;
      const refs = [{ type: 'TENANT', id: tenantId }];
      return {
        outcome: pending === 0 ? 'NO_OP' : 'APPLY',
        resourceType: 'TENANT',
        resourceId: tenantId,
        subjects: [{ type: 'LEGACY_POINT_IMPORT', id: tenantId, facts: { pending: pending > 0 } }],
        refs,
        apply: async (write, { commandId }) => {
          const batch = await importC360LegacyContactPointsBatch(
            write,
            { tenantId, actorIdentityKey: actor.actorIdentityKey, commandId },
            command.batchSize,
          );
          return {
            refs,
            audits: [
              {
                ...audit('LEGACY_POINT_IMPORT', 'TENANT', tenantId, ['contactPoints']),
                afterRevisions: {
                  imported: String(batch.imported),
                  active: String(batch.active),
                  reviewRequired: String(batch.reviewRequired),
                  contacts: String(batch.contacts.length),
                },
              },
            ],
            committedRevisions: {
              imported: String(batch.imported),
              remaining: String(batch.remaining),
            },
          };
        },
      };
    }
  }
}

function prepared(request: C360OperatorRequest) {
  return {
    command: normalizeC360OperatorCommand(request.command),
    evidence: evidenceRef(request.evidenceRef),
    reason: reasonCode(request.reasonCode),
  };
}

/** Operator authority มาจาก gateway; ภายใน transaction ตรวจเพียงว่า tenant ยังอยู่และ ACTIVE */
async function authorizeOperator(tx: Prisma.TransactionClient, operator: C360TrustedOperator) {
  const [tenant] = await lockBusy(
    () =>
      tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM tenants WHERE id = ${operator.tenantId}::uuid
        AND lifecycle_status::text = 'ACTIVE' FOR SHARE NOWAIT`,
  );
  if (!tenant) throw new C360ProfileCommandError('INVALID_REQUEST', 400);
}

function operatorAuthorization(operator: C360TrustedOperator): C360CommandAuthorization {
  return {
    authorize: (tx) => authorizeOperator(tx, operator),
    canAccessCommand: isOperatorCommand,
    canReadRef: async (tx, ref) => {
      const query = {
        where: { tenantId: operator.tenantId, id: ref.id },
        select: { id: true } as const,
      };
      switch (ref.type) {
        case 'CONTACT':
          return Boolean(await tx.contact.findFirst(query));
        case 'USER':
          return Boolean(await tx.user.findFirst(query));
        case 'TAG':
          return Boolean(await tx.c360Tag.findFirst(query));
        case 'SERVICE_PRINCIPAL':
          return Boolean(await tx.intServicePrincipal.findFirst(query));
        default:
          return false;
      }
    },
  };
}

export async function lookupC360OperatorCommand(
  db: PrismaClient,
  operator: C360TrustedOperator,
  commandId: unknown,
): Promise<C360ProfileCommandResult> {
  return lookupC360ProfileCommand(
    db,
    await operatorCommandActor(db, operator, commandId),
    commandId,
    operatorAuthorization(operator),
  );
}

export async function reconcileC360OperatorCommand(
  db: PrismaClient,
  operator: C360TrustedOperator,
  commandId: unknown,
  body: unknown,
): Promise<C360ProfileCommandResult> {
  return reconcileC360ProfileCommand(
    db,
    await operatorCommandActor(db, operator, commandId),
    commandId,
    body,
    operatorAuthorization(operator),
  );
}

/** Dry-run: ตรวจทุกเงื่อนไขเหมือนของจริงแต่ไม่ admit command และไม่เขียนอะไร */
/** E1 D inventory: counts และ digest เท่านั้น ไม่มีค่า phone/email ดิบ */
function inventorySubject(tenantId: string, inventory: C360LegacyInventory) {
  return {
    type: 'LEGACY_POINT_INVENTORY',
    id: tenantId,
    facts: {
      phoneIdentities: String(inventory.identities.PHONE),
      emailIdentities: String(inventory.identities.EMAIL),
      imported: String(inventory.imported),
      pendingActive: String(inventory.pending.active),
      pendingReviewRequired: String(inventory.pending.reviewRequired),
      reviewReasons: JSON.stringify(inventory.reviewReasons),
      contactsOverQuota: String(inventory.contactsOverQuota),
      sharedKeys: String(inventory.sharedKeys.keys),
      sharedKeyContacts: String(inventory.sharedKeys.contacts),
      sharedKeyDigest: inventory.sharedKeys.digest,
      missingIdentityHeads: String(inventory.identityHeads.missing),
      mergedIdentityHeads: String(inventory.identityHeads.merged),
      ambiguousIdentityHeads: String(inventory.identityHeads.ambiguous),
    } as Record<string, string | boolean | null>,
  };
}

export async function previewC360OperatorCommand(
  db: PrismaClient,
  operator: C360TrustedOperator,
  request: C360OperatorRequest,
): Promise<C360OperatorPreview> {
  const input = prepared(request);
  c360Uuid(request.commandId);
  const actor = operatorActor(operator);
  if (input.command.action === 'LEGACY_POINT_IMPORT') {
    // สแกนทั้ง tenant ใน snapshot เดียว (RepeatableRead) ไม่ใช้ timeout 2 วินาทีของ mutation
    return withTenantDatabaseTransaction(
      db,
      actor.tenantId,
      async (tx) => {
        // dry-run อ่านอย่างเดียวจริงและไม่ถือ lock ของ tenant row ระหว่างสแกน (ไม่ขวาง writer อื่น)
        await tx.$executeRawUnsafe('SET TRANSACTION READ ONLY');
        await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '50s'");
        const [tenant] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM tenants WHERE id = ${operator.tenantId}::uuid
            AND lifecycle_status::text = 'ACTIVE'`;
        if (!tenant) throw new C360ProfileCommandError('INVALID_REQUEST', 400);
        const inventory = await inventoryC360LegacyContactPoints(tx, actor.tenantId);
        return {
          dryRun: true as const,
          action: 'LEGACY_POINT_IMPORT' as const,
          outcome:
            inventory.pending.active + inventory.pending.reviewRequired === 0
              ? ('WOULD_NO_OP' as const)
              : ('WOULD_APPLY' as const),
          code: null,
          subjects: [inventorySubject(actor.tenantId, inventory)],
        };
      },
      { timeout: 60_000, isolationLevel: 'RepeatableRead' },
    );
  }
  return c360MutationTransaction(db, actor.tenantId, async (tx) => {
    await authorizeOperator(tx, operator);
    try {
      const result = await plan(tx, operator, input.command, input.evidence, input.reason, actor);
      return {
        dryRun: true,
        action: input.command.action,
        outcome: result.outcome === 'APPLY' ? 'WOULD_APPLY' : 'WOULD_NO_OP',
        code: null,
        subjects: result.subjects,
      };
    } catch (error) {
      if (!(error instanceof C360ProfileCommandRejection)) throw error;
      return {
        dryRun: true,
        action: input.command.action,
        outcome: 'WOULD_REJECT',
        code: error.code,
        subjects: [],
      };
    }
  });
}

export async function executeC360OperatorCommand(
  db: PrismaClient,
  operator: C360TrustedOperator,
  request: C360OperatorRequest,
): Promise<C360ProfileCommandResult> {
  const input = prepared(request);
  const actor = await operatorCommandActor(db, operator, request.commandId);
  const resourceId =
    'contactId' in input.command
      ? input.command.contactId
      : 'granteeUserId' in input.command
        ? input.command.granteeUserId
        : 'grantId' in input.command
          ? input.command.grantId
          : null;
  return executeC360ProfileCommand(
    db,
    actor,
    {
      commandId: request.commandId,
      action: `OPERATOR_${input.command.action}`,
      resourceType: input.command.action.startsWith('TAG') ? 'TAG_CATALOG' : 'OPERATOR_TARGET',
      resourceId,
      expectedRevisions: {},
      normalizationContractVersion:
        input.command.action === 'TAG_SEED'
          ? `${C360_OPERATOR_CONTRACT_VERSION}+${C360_TAG_NORMALIZATION_VERSION}`
          : C360_OPERATOR_CONTRACT_VERSION,
      normalizedRequest: {
        command: input.command,
        evidenceRef: input.evidence,
        reasonCode: input.reason,
      },
    },
    operatorAuthorization(operator),
    async (tx, command): Promise<C360ProfileEffect> => {
      const result = await plan(tx, operator, input.command, input.evidence, input.reason, actor);
      if (result.outcome === 'NO_OP')
        return { outcome: 'NO_OP', committedRevisions: {}, resourceRefs: result.refs };
      const applied = await result.apply(tx, command);
      return {
        outcome: 'APPLIED',
        httpStatus: 201,
        committedRevisions: applied.committedRevisions ?? {},
        resourceRefs: applied.refs,
        audits: applied.audits,
      };
    },
  );
}

/** Metadata เฉพาะ trusted operator; ไม่คืน issuer/subject/token หรือ customer payload */
export async function readC360ServicePrincipalMetadata(
  db: PrismaClient,
  operator: C360TrustedOperator,
  id: string,
) {
  return c360MutationTransaction(db, operator.tenantId, async (tx) => {
    await authorizeOperator(tx, operator);
    const [p] = await tx.$queryRaw<
      {
        id: string;
        active: boolean;
        authz_epoch: bigint;
        custodian_admin_id: string;
        evidence_ref: string;
      }[]
    >`SELECT id,active,authz_epoch,custodian_admin_id,evidence_ref FROM int_service_principals WHERE tenant_id=${operator.tenantId}::uuid AND id=${c360Uuid(id)}::uuid`;
    if (!p) return null;
    const [scopes] = await tx.$queryRaw<{ read: boolean; create: boolean }[]>`SELECT
   EXISTS(SELECT 1 FROM int_service_contact_grants g WHERE g.tenant_id=${operator.tenantId}::uuid AND g.principal_id=${p.id}::uuid AND NOT EXISTS(SELECT 1 FROM int_service_contact_revocations r WHERE r.tenant_id=g.tenant_id AND r.grant_id=g.id)) AS read,
   EXISTS(SELECT 1 FROM int_service_capability_grants g WHERE g.tenant_id=${operator.tenantId}::uuid AND g.principal_id=${p.id}::uuid AND NOT EXISTS(SELECT 1 FROM int_service_capability_revocations r WHERE r.tenant_id=g.tenant_id AND r.grant_id=g.id)) AS create`;
    return {
      id: p.id,
      active: p.active,
      authzEpoch: p.authz_epoch.toString(),
      custodianUserId: p.custodian_admin_id,
      evidenceRefs: [p.evidence_ref],
      scopes: p.active
        ? [
            ...(scopes?.read ? ['customer360.contacts.read'] : []),
            ...(scopes?.create ? ['customer360.contacts.create'] : []),
          ]
        : [],
    };
  });
}
