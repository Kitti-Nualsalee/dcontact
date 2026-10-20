import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { PeopleTelephonyNode } from './tenant-people-infrastructure.js';

export const TENANT_PEOPLE_READINESS = Symbol('TENANT_PEOPLE_READINESS');
export interface TenantPeopleReadiness {
  isReady(tenantId: string): Promise<boolean>;
  nodesForTenant?(tenantId: string): readonly PeopleTelephonyNode[];
}

export interface TenantPeopleIdentityReadiness {
  isReady(tenantId: string): Promise<boolean>;
}

export class DatabaseTenantPeopleReadiness implements TenantPeopleReadiness {
  constructor(
    private readonly worker: PrismaClient,
    private readonly identities: ReadonlyMap<string, TenantPeopleIdentityReadiness>,
  ) {}

  async isReady(tenantId: string): Promise<boolean> {
    const identity = this.identities.get(tenantId);
    if (!identity) return false;
    try {
      const allowed = await withTenantDatabaseTransaction(
        this.worker,
        tenantId,
        async (transaction) => {
          const rows = await transaction.$queryRaw<{ ready: boolean }[]>`
          SELECT (
            running.rolname='dcontact_tenant_people_worker' AND NOT running.rolsuper AND NOT running.rolbypassrls AND NOT running.rolcanlogin
            AND principal.rolcanlogin AND NOT principal.rolsuper AND NOT principal.rolbypassrls AND NOT principal.rolinherit
            AND EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=${tenantId}::uuid AND b.database_principal=session_user AND b.enabled)
            AND NOT EXISTS(SELECT 1 FROM pg_auth_members membership WHERE membership.member IN (running.oid,principal.oid) AND membership.roleid<>running.oid)
          ) AS ready FROM pg_roles running,pg_roles principal WHERE running.rolname=current_user AND principal.rolname=session_user`;
          return rows[0]?.ready === true;
        },
      );
      return allowed && (await identity.isReady(tenantId));
    } catch {
      return false;
    }
  }
}
