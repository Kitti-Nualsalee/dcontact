import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@d-contact/db';
import {
  C360ProfileCommandError,
  C360ProfileCommandRejection,
  c360CanonicalJson,
  c360Uuid,
  type C360CommandActor,
} from './profile-command.js';
import type { C360TrustedOperator, C360OperatorPreview } from './profile-operator.js';
import { tryC360IdentityFences } from './profile-fences.js';

export type C360ServiceOperatorCommand =
  | {
      action: 'SERVICE_BIND_CREATE';
      issuer: string;
      subject: string;
      clientId: string;
      custodianAdminId: string;
    }
  | { action: 'SERVICE_BIND_DISABLE'; bindingId: string; expectedAuthzEpoch: string }
  | {
      action: 'SERVICE_BIND_REPLACE_CUSTODIAN';
      bindingId: string;
      expectedAuthzEpoch: string;
      custodianAdminId: string;
    }
  | {
      action: 'SERVICE_CAPABILITY_GRANT';
      bindingId: string;
      expectedAuthzEpoch: string;
      capability: 'CONTACT_CREATE';
    }
  | { action: 'SERVICE_CAPABILITY_REVOKE'; grantId: string; expectedAuthzEpoch: string }
  | {
      action: 'SERVICE_CONTACT_GRANT';
      bindingId: string;
      expectedAuthzEpoch: string;
      contactId: string;
      permission: 'READ';
    }
  | { action: 'SERVICE_CONTACT_REVOKE'; grantId: string; expectedAuthzEpoch: string };
export interface C360ServiceIdentity {
  tenantId: string;
  issuer: string;
  subject: string;
  clientId: string;
}
const lockedTransaction: unique symbol = Symbol('service-principal-transaction');
export interface C360LockedServicePrincipal {
  readonly [lockedTransaction]: Prisma.TransactionClient;
  id: string;
  tenant_id: string;
  issuer: string;
  subject: string;
  client_id: string;
  custodian_admin_id: string;
  active: boolean;
  authz_epoch: bigint;
}
function invalid(): never {
  throw new C360ProfileCommandError('INVALID_REQUEST', 400);
}
function reject(code: string, status: 404 | 409 | 422 = 409): never {
  throw new C360ProfileCommandRejection(code, status);
}
function text(v: unknown, max: number) {
  if (typeof v !== 'string' || v.length === 0 || v.length > max || /[\u0000-\u001f\u007f]/u.test(v))
    invalid();
  return v;
}
function epoch(v: unknown) {
  if (
    typeof v !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(v) ||
    BigInt(v) > 9223372036854775807n
  )
    invalid();
  return v;
}
export function isC360ServiceOperatorCommand(c: {
  action: string;
}): c is C360ServiceOperatorCommand {
  return [
    'SERVICE_BIND_CREATE',
    'SERVICE_BIND_DISABLE',
    'SERVICE_BIND_REPLACE_CUSTODIAN',
    'SERVICE_CAPABILITY_GRANT',
    'SERVICE_CAPABILITY_REVOKE',
    'SERVICE_CONTACT_GRANT',
    'SERVICE_CONTACT_REVOKE',
  ].includes(c.action);
}
export function normalizeC360ServiceOperatorCommand(value: unknown): C360ServiceOperatorCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const c = value as Record<string, unknown>;
  const only = (...keys: string[]) => {
    if (Object.keys(c).some((k) => !['action', ...keys].includes(k))) invalid();
  };
  switch (c.action) {
    case 'SERVICE_BIND_CREATE': {
      only('issuer', 'subject', 'clientId', 'custodianAdminId');
      const issuer = text(c.issuer, 512);
      let u: URL;
      try {
        u = new URL(issuer);
      } catch {
        invalid();
      }
      if (
        !['https:', 'http:'].includes(u!.protocol) ||
        u!.username ||
        u!.password ||
        u!.search ||
        u!.hash
      )
        invalid();
      return {
        action: c.action,
        issuer,
        subject: text(c.subject, 512),
        clientId: text(c.clientId, 256),
        custodianAdminId: c360Uuid(c.custodianAdminId),
      };
    }
    case 'SERVICE_BIND_DISABLE':
      only('bindingId', 'expectedAuthzEpoch');
      return {
        action: c.action,
        bindingId: c360Uuid(c.bindingId),
        expectedAuthzEpoch: epoch(c.expectedAuthzEpoch),
      };
    case 'SERVICE_BIND_REPLACE_CUSTODIAN':
      only('bindingId', 'expectedAuthzEpoch', 'custodianAdminId');
      return {
        action: c.action,
        bindingId: c360Uuid(c.bindingId),
        expectedAuthzEpoch: epoch(c.expectedAuthzEpoch),
        custodianAdminId: c360Uuid(c.custodianAdminId),
      };
    case 'SERVICE_CAPABILITY_GRANT':
      only('bindingId', 'expectedAuthzEpoch', 'capability');
      if (c.capability !== 'CONTACT_CREATE') invalid();
      return {
        action: c.action,
        bindingId: c360Uuid(c.bindingId),
        expectedAuthzEpoch: epoch(c.expectedAuthzEpoch),
        capability: c.capability,
      };
    case 'SERVICE_CONTACT_GRANT':
      only('bindingId', 'expectedAuthzEpoch', 'contactId', 'permission');
      if (c.permission !== 'READ') invalid();
      return {
        action: c.action,
        bindingId: c360Uuid(c.bindingId),
        expectedAuthzEpoch: epoch(c.expectedAuthzEpoch),
        contactId: c360Uuid(c.contactId),
        permission: c.permission,
      };
    case 'SERVICE_CAPABILITY_REVOKE':
    case 'SERVICE_CONTACT_REVOKE':
      only('grantId', 'expectedAuthzEpoch');
      return {
        action: c.action,
        grantId: c360Uuid(c.grantId),
        expectedAuthzEpoch: epoch(c.expectedAuthzEpoch),
      };
    default:
      invalid();
  }
}
/** Namespace แยกจาก human/operator; ไม่ผูก token bytes จึงคง identity เมื่อหมุน credential */
export function c360ServiceActor(
  identity: C360ServiceIdentity,
  bindingId: string,
): C360CommandActor {
  return {
    tenantId: c360Uuid(identity.tenantId),
    actorUserId: null,
    actorIdentityKey: createHash('sha256')
      .update(
        c360CanonicalJson({
          type: 'SERVICE',
          tenantId: c360Uuid(identity.tenantId),
          issuer: identity.issuer,
          subject: identity.subject,
          clientId: identity.clientId,
          bindingId: c360Uuid(bindingId),
        }),
      )
      .digest('hex'),
  };
}
/** อ่านและถือ guard ใน transaction เดียวกับ effect; revoke ใช้ row เดียวกันแบบ UPDATE NOWAIT */
export async function lockC360ServicePrincipal(
  tx: Prisma.TransactionClient,
  identity: C360ServiceIdentity,
  expectedEpoch?: string,
) {
  const [p] = await tx.$queryRaw<C360LockedServicePrincipal[]>`SELECT * FROM int_service_principals
 WHERE tenant_id=${identity.tenantId}::uuid AND issuer=${identity.issuer} AND subject=${identity.subject} AND client_id=${identity.clientId} FOR SHARE NOWAIT`;
  if (!p || !p.active) throw new C360ProfileCommandError('INVALID_REQUEST', 403);
  if (expectedEpoch !== undefined && p.authz_epoch !== BigInt(epoch(expectedEpoch)))
    reject('SERVICE_AUTHORIZATION_CHANGED');
  Object.defineProperty(p, lockedTransaction, { value: tx });
  return p;
}
export async function authorizeC360ServiceCapability(
  tx: Prisma.TransactionClient,
  p: C360LockedServicePrincipal,
) {
  if (p[lockedTransaction] !== tx) throw new C360ProfileCommandError('INVALID_REQUEST', 403);
  const [r] = await tx.$queryRaw<
    { allowed: boolean }[]
  >`SELECT EXISTS(SELECT 1 FROM int_service_capability_grants g
 WHERE g.tenant_id=${p.tenant_id}::uuid AND g.principal_id=${p.id}::uuid AND g.capability='CONTACT_CREATE'
 AND NOT EXISTS(SELECT 1 FROM int_service_capability_revocations r WHERE r.tenant_id=g.tenant_id AND r.grant_id=g.id)) AS allowed`;
  const [u] = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM users WHERE tenant_id=${p.tenant_id}::uuid AND id=${p.custodian_admin_id}::uuid AND is_active AND role::text='ADMIN' FOR SHARE NOWAIT`;
  return !!r?.allowed && !!u;
}
export async function authorizeC360ServiceContact(
  tx: Prisma.TransactionClient,
  p: C360LockedServicePrincipal,
  contactId: string,
) {
  if (p[lockedTransaction] !== tx) throw new C360ProfileCommandError('INVALID_REQUEST', 403);
  const [r] = await tx.$queryRaw<
    { allowed: boolean }[]
  >`SELECT EXISTS(SELECT 1 FROM int_service_contact_grants g
 JOIN contacts c ON c.tenant_id=g.tenant_id AND c.id=g.contact_id
 WHERE g.tenant_id=${p.tenant_id}::uuid AND g.principal_id=${p.id}::uuid AND g.contact_id=${c360Uuid(contactId)}::uuid AND g.permission='READ'
 AND NOT EXISTS(SELECT 1 FROM int_service_contact_revocations r WHERE r.tenant_id=g.tenant_id AND r.grant_id=g.id)) AS allowed`;
  return !!r?.allowed;
}
async function custodian(tx: Prisma.TransactionClient, operator: C360TrustedOperator, id: string) {
  const [u] = await tx.$queryRaw<
    { id: string; is_active: boolean; role: string; keycloak_id: string | null }[]
  >`SELECT id,is_active,role::text,keycloak_id FROM users WHERE tenant_id=${operator.tenantId}::uuid AND id=${id}::uuid FOR SHARE NOWAIT`;
  if (!u) reject('GRANTEE_NOT_FOUND', 404);
  if (u.id === operator.userId || u.keycloak_id === operator.subject)
    reject('SELF_GRANT_FORBIDDEN', 422);
  if (!u.is_active || u.role !== 'ADMIN') reject('GRANTEE_NOT_ACTIVE_ADMIN', 422);
}
/** Plan ใช้ทั้ง preview และ shared C1 engine; ไม่มี DB effect จน apply ถูกเรียก */
export async function planC360ServiceOperator(
  tx: Prisma.TransactionClient,
  operator: C360TrustedOperator,
  c: C360ServiceOperatorCommand,
  evidence: string,
  reason: string,
  actor: C360CommandActor,
) {
  const tenantId = operator.tenantId;
  let p: C360LockedServicePrincipal | undefined;
  let targetId: string | null = null;
  const kind = c.action.startsWith('SERVICE_CONTACT') ? 'contact' : 'capability';
  if (c.action === 'SERVICE_BIND_CREATE') {
    // lock key เดียวกันกับ concurrent create; shared mode ของ dry-run ยังไม่เขียน
    const key = `m3-binding:${tenantId}:${c.issuer}:${c.subject}:${c.clientId}`;
    const [l] = await tx.$queryRaw<
      { ok: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${key},0)) AS ok`;
    if (!l?.ok) throw new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
    [p] = await tx.$queryRaw<
      C360LockedServicePrincipal[]
    >`SELECT * FROM int_service_principals WHERE tenant_id=${tenantId}::uuid AND issuer=${c.issuer} AND subject=${c.subject} AND client_id=${c.clientId} FOR UPDATE NOWAIT`;
    await custodian(tx, operator, c.custodianAdminId);
    if (p && (!p.active || p.custodian_admin_id !== c.custodianAdminId))
      reject('SERVICE_BINDING_CONFLICT');
  } else {
    let id: string;
    if ('bindingId' in c) id = c.bindingId;
    else {
      const table = Prisma.raw(`int_service_${kind}_grants`);
      const [grant] = await tx.$queryRaw<{ principal_id: string }[]>(
        Prisma.sql`SELECT principal_id FROM ${table} WHERE tenant_id=${tenantId}::uuid AND id=${c.grantId}::uuid`,
      );
      if (!grant) reject('GRANT_NOT_FOUND', 404);
      id = grant.principal_id;
      targetId = c.grantId;
    }
    [p] = await tx.$queryRaw<
      C360LockedServicePrincipal[]
    >`SELECT * FROM int_service_principals WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid FOR UPDATE NOWAIT`;
    if (!p) reject('SERVICE_PRINCIPAL_NOT_FOUND', 404);
    if (p.authz_epoch !== BigInt(c.expectedAuthzEpoch)) reject('SERVICE_AUTHORIZATION_CHANGED');
    if (
      !p.active &&
      !['SERVICE_BIND_DISABLE', 'SERVICE_CAPABILITY_REVOKE', 'SERVICE_CONTACT_REVOKE'].includes(
        c.action,
      )
    )
      reject('SERVICE_PRINCIPAL_DISABLED');
    if (
      c.action === 'SERVICE_BIND_REPLACE_CUSTODIAN' ||
      c.action === 'SERVICE_CAPABILITY_GRANT' ||
      c.action === 'SERVICE_CONTACT_GRANT'
    )
      await custodian(
        tx,
        operator,
        c.action === 'SERVICE_BIND_REPLACE_CUSTODIAN' ? c.custodianAdminId : p.custodian_admin_id,
      );
  }
  let noop = !!p && c.action === 'SERVICE_BIND_CREATE';
  if (c.action === 'SERVICE_BIND_DISABLE') noop = !p!.active;
  if (c.action === 'SERVICE_BIND_REPLACE_CUSTODIAN')
    noop = p!.custodian_admin_id === c.custodianAdminId;
  if (c.action === 'SERVICE_CONTACT_GRANT') {
    await tryC360IdentityFences(tx, tenantId, [c.contactId]);
    const [contact] = await tx.$queryRaw<
      { state: string | null }[]
    >`SELECT ih.state::text FROM contacts c LEFT JOIN c360_identity_heads ih ON ih.tenant_id=c.tenant_id AND ih.contact_id=c.id WHERE c.tenant_id=${tenantId}::uuid AND c.id=${c.contactId}::uuid`;
    if (!contact) reject('CONTACT_NOT_FOUND', 404);
    if (contact.state && contact.state !== 'ACTIVE') reject('CONTACT_NOT_CANONICAL');
  }
  if (c.action === 'SERVICE_CAPABILITY_GRANT' || c.action === 'SERVICE_CONTACT_GRANT') {
    const grants = Prisma.raw(`int_service_${kind}_grants`),
      revocations = Prisma.raw(`int_service_${kind}_revocations`);
    const predicate =
      c.action === 'SERVICE_CONTACT_GRANT'
        ? Prisma.sql`AND g.contact_id=${c.contactId}::uuid`
        : Prisma.sql`AND g.capability='CONTACT_CREATE'`;
    const [g] = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT g.id FROM ${grants} g WHERE g.tenant_id=${tenantId}::uuid AND g.principal_id=${p!.id}::uuid ${predicate} AND NOT EXISTS(SELECT 1 FROM ${revocations} r WHERE r.tenant_id=g.tenant_id AND r.grant_id=g.id)`,
    );
    noop = !!g;
  }
  if (c.action === 'SERVICE_CAPABILITY_REVOKE' || c.action === 'SERVICE_CONTACT_REVOKE') {
    const table = Prisma.raw(`int_service_${kind}_revocations`);
    const [r] = await tx.$queryRaw<{ id: string }[]>(
      Prisma.sql`SELECT id FROM ${table} WHERE tenant_id=${tenantId}::uuid AND grant_id=${targetId}::uuid`,
    );
    noop = !!r;
  }
  const id = p?.id ?? randomUUID();
  const refs = [{ type: 'SERVICE_PRINCIPAL', id }];
  return {
    outcome: noop ? ('NO_OP' as const) : ('APPLY' as const),
    resourceType: 'SERVICE_PRINCIPAL',
    resourceId: p?.id ?? null,
    refs,
    subjects: [
      {
        type: 'SERVICE_PRINCIPAL',
        id,
        facts: {
          active: p?.active ?? true,
          authzEpoch: p?.authz_epoch.toString() ?? '0',
          custodianAdminId:
            c.action === 'SERVICE_BIND_CREATE' ? c.custodianAdminId : p!.custodian_admin_id,
        },
      },
    ] satisfies C360OperatorPreview['subjects'],
    apply: async (write: Prisma.TransactionClient, { commandId }: { commandId: string }) => {
      if (c.action === 'SERVICE_BIND_CREATE') {
        await write.$executeRaw`INSERT INTO int_service_principals(id,tenant_id,issuer,subject,client_id,custodian_admin_id,service_actor_identity_key,evidence_ref,actor_identity_key,command_id)
     VALUES(${id}::uuid,${tenantId}::uuid,${c.issuer},${c.subject},${c.clientId},${c.custodianAdminId}::uuid,${c360ServiceActor({ tenantId, issuer: c.issuer, subject: c.subject, clientId: c.clientId }, id).actorIdentityKey},${evidence},${actor.actorIdentityKey},${commandId}::uuid)`;
      } else {
        await write.$executeRaw`UPDATE int_service_principals SET authz_epoch=authz_epoch+1,
    active=${c.action === 'SERVICE_BIND_DISABLE' ? false : p!.active}, custodian_admin_id=${c.action === 'SERVICE_BIND_REPLACE_CUSTODIAN' ? c.custodianAdminId : p!.custodian_admin_id}::uuid WHERE tenant_id=${tenantId}::uuid AND id=${id}::uuid`;
        if (c.action === 'SERVICE_CONTACT_GRANT')
          await write.$executeRaw`INSERT INTO int_service_contact_grants(id,tenant_id,principal_id,contact_id,permission,evidence_ref,actor_identity_key,command_id) VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${id}::uuid,${c.contactId}::uuid,'READ',${evidence},${actor.actorIdentityKey},${commandId}::uuid)`;
        if (c.action === 'SERVICE_CAPABILITY_GRANT')
          await write.$executeRaw`INSERT INTO int_service_capability_grants(id,tenant_id,principal_id,capability,evidence_ref,actor_identity_key,command_id) VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${id}::uuid,'CONTACT_CREATE',${evidence},${actor.actorIdentityKey},${commandId}::uuid)`;
        if (c.action === 'SERVICE_CONTACT_REVOKE' || c.action === 'SERVICE_CAPABILITY_REVOKE') {
          const table = Prisma.raw(`int_service_${kind}_revocations`);
          await write.$executeRaw(
            Prisma.sql`INSERT INTO ${table}(id,tenant_id,grant_id,evidence_ref,reason_code,actor_identity_key,command_id) VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${targetId}::uuid,${evidence},${reason},${actor.actorIdentityKey},${commandId}::uuid)`,
          );
        }
      }
      const nextEpoch = c.action === 'SERVICE_BIND_CREATE' ? '0' : (p!.authz_epoch + 1n).toString();
      return {
        refs,
        committedRevisions: { authzEpoch: nextEpoch },
        audits: [
          {
            operation: c.action,
            resourceType: 'SERVICE_PRINCIPAL',
            resourceId: id,
            changedFields: ['serviceAuthorization'],
            beforeRevisions: p
              ? { authzEpoch: p.authz_epoch.toString() }
              : ({} as Record<string, string>),
            afterRevisions: { authzEpoch: nextEpoch },
            evidenceRefs: [evidence, `reason:${reason}`],
          },
        ],
      };
    },
  };
}

/** เรียกใน owner create transaction หลังสร้าง Contact ก่อน INTEGRATION custody; ไม่เปิด public CRUD ของ slice B */
export async function recordC360ServiceCreateEvidence(
  tx: Prisma.TransactionClient,
  p: C360LockedServicePrincipal,
  command: { commandId: string; actorIdentityKey: string },
  contactId: string,
) {
  if (p[lockedTransaction] !== tx || !(await authorizeC360ServiceCapability(tx, p)))
    throw new C360ProfileCommandError('INVALID_REQUEST', 403);
  const expected = c360ServiceActor(
    { tenantId: p.tenant_id, issuer: p.issuer, subject: p.subject, clientId: p.client_id },
    p.id,
  );
  if (command.actorIdentityKey !== expected.actorIdentityKey)
    throw new C360ProfileCommandError('INVALID_REQUEST', 403);
  await tx.$executeRaw`INSERT INTO int_service_command_evidence(tenant_id,actor_identity_key,command_id,principal_id,contact_id,purpose)
 VALUES(${p.tenant_id}::uuid,${command.actorIdentityKey},${c360Uuid(command.commandId)}::uuid,${p.id}::uuid,${c360Uuid(contactId)}::uuid,'CONTACT_CREATE')`;
}
