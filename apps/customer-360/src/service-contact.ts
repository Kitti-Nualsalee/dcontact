import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@d-contact/db';
import {
  C360ProfileCommandError,
  type C360CommandActor,
  type C360PreparedProfileCommand,
  type C360ProfileEffect,
} from './profile-command.js';
import type { C360ContactAccess, C360IdentityView } from './profile-authorization.js';
import type { C360ContactReader } from './profile-read.js';
import {
  C360WriteDenied,
  insertC360CreatedContact,
  type C360CreateProfile,
} from './profile-write.js';
import {
  authorizeC360ServiceCapability,
  recordC360ServiceCreateEvidence,
  type C360LockedServicePrincipal,
} from './service-principal.js';

/**
 * External customer API (#954): การอ่านและสร้าง Contact ของ service principal ตาม Phase Contract M3 v1 ข้อ 1–2
 *
 * - อ่านได้เฉพาะ Contact ที่มี service READ grant ที่ยังไม่ถูกถอน และ binding ยัง active; ไม่มี tenant-wide fallback
 *   role `service` หรือ token scope ไม่ให้สิทธิ์อ่านเอง และ grant ไม่ตามไป canonical target หลัง merge
 * - ผู้เรียกต้องส่ง principal ที่ `lockC360ServicePrincipal` คืนใน transaction เดียวกัน
 */
function serviceReadableSql(principal: C360LockedServicePrincipal): Prisma.Sql {
  return Prisma.sql`(c.tenant_id = ${principal.tenant_id}::uuid
    AND EXISTS (
      SELECT 1 FROM int_service_principals sp
      WHERE sp.tenant_id = c.tenant_id AND sp.id = ${principal.id}::uuid AND sp.active
    )
    AND EXISTS (
      SELECT 1 FROM int_service_contact_grants g
      WHERE g.tenant_id = c.tenant_id AND g.principal_id = ${principal.id}::uuid
        AND g.contact_id = c.id AND g.permission = 'READ'
        AND NOT EXISTS (
          SELECT 1 FROM int_service_contact_revocations r
          WHERE r.tenant_id = g.tenant_id AND r.grant_id = g.id
        )
    ))`;
}

export function c360ServiceContactReader(principal: C360LockedServicePrincipal): C360ContactReader {
  const readable = serviceReadableSql(principal);
  return {
    tenantId: principal.tenant_id,
    cursorSubject: principal.id,
    // epoch เปลี่ยนทุกครั้งที่ operator แก้ binding/grant: cursor เดิมใช้ต่อไม่ได้ ต้องค้นใหม่
    scopeDigest: createHash('sha256')
      .update(`c360-service-scope-v1|${principal.id}|${principal.authz_epoch.toString()}`)
      .digest('hex'),
    readable,
    // service ไม่มีสิทธิ์ผ่าน segment ของทีม จึงไม่มีสถานะที่ยังตัดสินไม่ได้
    deferred: Prisma.sql`false`,
    access: async (tx, contactId): Promise<C360ContactAccess> => {
      const [row] = await tx.$queryRaw<{ readable: boolean; identity: string | null }[]>(Prisma.sql`
        SELECT ${readable} AS readable,
               (SELECT ih.state::text FROM c360_identity_heads ih
                 WHERE ih.tenant_id = c.tenant_id AND ih.contact_id = c.id) AS identity
        FROM contacts c
        WHERE c.tenant_id = ${principal.tenant_id}::uuid AND c.id = ${contactId}::uuid`);
      if (!row?.readable) return { decision: 'DENY' };
      return {
        decision: 'ALLOW',
        read: true,
        manage: false,
        basis: 'SERVICE_READ',
        identity: (row.identity ?? 'LEGACY_MISSING_HEAD') as C360IdentityView,
      };
    },
  };
}

/**
 * สร้าง Contact แทน service ภายใน transaction ของ command: Contact + head + evidence + custody `INTEGRATION`
 * ของ custodian Admin ที่ operator กำหนด + service READ grant ของ Contact ใหม่ ทั้งหมด atomic
 * client เลือก custodian, tenant หรือ grant ผ่าน payload ไม่ได้
 */
export async function createC360ServiceProfile(
  tx: Prisma.TransactionClient,
  principal: C360LockedServicePrincipal,
  commandActor: C360CommandActor,
  command: C360PreparedProfileCommand,
  profile: C360CreateProfile,
): Promise<C360ProfileEffect> {
  try {
    // ถือ User row guard ของ custodian (FOR SHARE NOWAIT) ก่อน effect
    if (!(await authorizeC360ServiceCapability(tx, principal))) throw new C360WriteDenied();
  } catch (error) {
    if (error instanceof C360WriteDenied) throw error;
    const text = error instanceof Error ? error.message : '';
    if (/55P03|lock_not_available|could not obtain lock/.test(text))
      throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
    throw error;
  }
  const evidenceRef = `service-create:${command.commandId}`;
  return insertC360CreatedContact(
    tx,
    principal.tenant_id,
    commandActor,
    command,
    profile,
    async (contactId) => {
      await recordC360ServiceCreateEvidence(
        tx,
        principal,
        { commandId: command.commandId, actorIdentityKey: commandActor.actorIdentityKey },
        contactId,
      );
      await tx.c360ContactCustodianGrant.create({
        data: {
          id: randomUUID(),
          tenantId: principal.tenant_id,
          contactId,
          granteeUserId: principal.custodian_admin_id,
          permission: 'MANAGE',
          origin: 'INTEGRATION',
          integrationPrincipalId: principal.id,
          evidenceRef,
          actorIdentityKey: commandActor.actorIdentityKey,
          commandId: command.commandId,
          actorUserId: null,
        },
      });
      await tx.$executeRaw`INSERT INTO int_service_contact_grants
        (id, tenant_id, principal_id, contact_id, permission, evidence_ref, actor_identity_key, command_id)
        VALUES (${randomUUID()}::uuid, ${principal.tenant_id}::uuid, ${principal.id}::uuid,
          ${contactId}::uuid, 'READ', ${evidenceRef}, ${commandActor.actorIdentityKey},
          ${command.commandId}::uuid)`;
    },
  );
}
