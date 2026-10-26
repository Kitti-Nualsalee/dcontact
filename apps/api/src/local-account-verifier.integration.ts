import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  WorkspaceSessionGateway,
  WorkspaceSessionRegistry,
  type VerifiedOidcClaims,
} from '@d-contact/workspace-session';
import { withLocalAccountAdmission } from './local-account-verifier.js';

test('PostgreSQL/RLS: JWT เดิมเปิด Workspace ใหม่ไม่ได้หลัง local disable และข้าม tenant ไม่ได้', async (context) => {
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  context.after(async () => {
    await Promise.all([application.$disconnect(), owner.$disconnect()]);
  });
  const tenantId = randomUUID();
  const foreignTenant = randomUUID();
  const userId = randomUUID();
  const [role] = await withTenantDatabaseTransaction(
    application,
    tenantId,
    (transaction) =>
      transaction.$queryRaw<{ name: string; bypass: boolean }[]>`
      SELECT rolname AS name,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`,
  );
  assert.deepEqual(role, { name: 'dcontact_app', bypass: false });
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Account admission',
      slug: tenantId,
      sipDomain: `${tenantId}.test`,
    },
  });
  await owner.tenant.create({
    data: {
      id: foreignTenant,
      name: 'Foreign account',
      slug: foreignTenant,
      sipDomain: `${foreignTenant}.test`,
    },
  });
  await owner.user.create({
    data: {
      id: userId,
      tenantId,
      email: `${userId}@example.test`,
      displayName: 'Admission Agent',
      role: 'AGENT',
      isActive: true,
      passwordHash: '!keycloak-managed',
    },
  });
  const claims: VerifiedOidcClaims = {
    tenant_id: tenantId,
    tenant_slug: tenantId,
    organization: { [tenantId]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: 'existing-session',
    exp: 2_000_000_000,
    realm_access: { roles: ['agent'] },
  };
  const verifier = withLocalAccountAdmission(application, {
    verifyAccessToken: async () => claims,
  });
  const gateway = new WorkspaceSessionGateway(verifier, new WorkspaceSessionRegistry(), {
    isActive: async () => true,
  });
  const handshake = { accessToken: 'same-unexpired-token', tabId: 'before-disable' };
  assert.equal((await gateway.connect(handshake)).userId, userId);
  await owner.user.update({ where: { id: userId }, data: { isActive: false } });
  await assert.rejects(gateway.connect({ ...handshake, tabId: 'after-disable' }));
  await assert.rejects(gateway.refresh(handshake));
  await assert.rejects(gateway.claimWorkingTab(handshake));
  await owner.user.update({ where: { id: userId }, data: { isActive: true } });
  claims.tenant_id = foreignTenant;
  claims.tenant_slug = foreignTenant;
  claims.organization = { [foreignTenant]: { tenant_id: [foreignTenant] } };
  await assert.rejects(gateway.connect({ ...handshake, tabId: 'foreign-tenant' }));
});
