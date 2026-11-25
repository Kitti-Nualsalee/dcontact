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
 * External customer API (#954): reading and creating Contacts by a service principal per Phase Contract M3 v1 items 1–2
 *
 * - can read only Contacts with a service READ grant that is not revoked and an active binding; no tenant-wide fallback
 *   the `service` role or token scope does not grant read access by itself, and a grant does not follow to the canonical target after a merge
 * - the caller must pass the principal returned by `lockC360ServicePrincipal` in the same transaction
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
    // the epoch changes whenever an operator edits a binding/grant: the old cursor cannot be reused and the search must restart
    scopeDigest: createHash('sha256')
      .update(`c360-service-scope-v1|${principal.id}|${principal.authz_epoch.toString()}`)
      .digest('hex'),
    readable,
    // a service has no access through team segments, so there is no undecided state
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
 * Creates a Contact on behalf of a service inside the command transaction: Contact + head + evidence + `INTEGRATION` custody
 * for the Admin custodian the operator designates + a service READ grant on the new Contact, all atomic
 * the client cannot choose the custodian, tenant or grant through the payload
 */
export async function createC360ServiceProfile(
  tx: Prisma.TransactionClient,
  principal: C360LockedServicePrincipal,
  commandActor: C360CommandActor,
  command: C360PreparedProfileCommand,
  profile: C360CreateProfile,
): Promise<C360ProfileEffect> {
  try {
    // hold the custodian's User row guard (FOR SHARE NOWAIT) before the effect
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
