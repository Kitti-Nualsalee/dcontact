import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import { coreFixture } from './tenant-core-test-fixtures.js';
import { acceptPeopleCreate } from './tenant-people-operations.js';

test('Team/People: actual B2 pending operation/lifecycle คง creation Team แม้ User ย้ายออก; terminal no-effect เหลือประวัติ', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const teamId = randomUUID();
  await f.owner.team.create({ data: { id: teamId, tenantId: f.tenantId, name: 'Pending People' } });
  await f.owner
    .$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,extension_pool) VALUES(${f.tenantId}::uuid,1,'UAT_EXPLICIT',50,20,10,10,'fixture-operator',now(),'isolated-fixture','ทดสอบ Team extension','[]'::jsonb)`;
  const admin = f.actors.get('admin')!;
  const accepted = await acceptPeopleCreate(
    f.db,
    {
      tenantId: f.tenantId,
      userId: admin.id,
      roles: ['admin'],
      caller: {
        issuer: 'https://core-idp.test/realms/dcontact',
        subject: admin.id,
        clientId: 'dcontact-console',
        tenantSlug: `core-${f.tenantId}`,
      },
    },
    {
      commandId: randomUUID(),
      teamId,
      displayName: 'ทดสอบ pending',
      email: `${randomUUID()}@test.invalid`,
      role: 'SUPERVISOR',
    },
  );
  await f.owner.user.update({ where: { id: accepted.userId }, data: { teamId: f.teamId } });
  const close = () =>
    withTenantDatabaseTransaction(f.owner, f.tenantId, (tx) =>
      tx.team.update({ where: { id: teamId }, data: { isActive: false } }),
    );
  await assert.rejects(close(), /TEAM_REFERENCED/);
  await withTenantDatabaseTransaction(f.owner, f.tenantId, async (tx) => {
    await tx.$executeRaw`UPDATE tenant_people_operations SET revision=revision+1,state='REJECTED' WHERE tenant_id=${f.tenantId}::uuid AND id=${accepted.operationId}::uuid`;
    await tx.$executeRaw`UPDATE tenant_user_lifecycles SET revision=revision+1,account_state='ATTENTION_REQUIRED',provisioning_state='REJECTED' WHERE tenant_id=${f.tenantId}::uuid AND user_id=${accepted.userId}::uuid`;
  });
  await close();
});
