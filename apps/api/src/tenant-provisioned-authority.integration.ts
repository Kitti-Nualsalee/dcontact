import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HttpException } from '@nestjs/common';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { findTenantConfigurationActor } from './tenant-config-identity.js';
import { acceptPeopleCreate } from './tenant-people-operations.js';
import { runPeopleWorkerStep, type TenantPeopleIdentityPort } from './tenant-people-worker.js';
import { runPeopleActivation } from './tenant-people-activation.js';
import { acceptPeopleDisable, runPeopleDisable } from './tenant-people-disable.js';
import type { TenantPeopleDisablePort } from './tenant-people-disable-keycloak.js';
import {
  catalogCapabilities,
  catalogTeams,
  createCatalog,
  type VoiceActor,
} from './tenant-voice-catalog.js';

for (const role of ['ADMIN', 'SUPERVISOR'] as const) {
  test(`B2 ${role} ที่ผ่าน provisioning และ activation ใช้ config ได้โดยไม่มี manual binding`, async () => {
    const owner = new PrismaClient();
    const application = new PrismaClient({
      datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
    });
    const principal = `authority_${randomUUID().replaceAll('-', '')}`;
    const workerUrl = new URL(process.env.DATABASE_URL!);
    workerUrl.username = principal;
    workerUrl.password = randomUUID();
    workerUrl.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
    const worker = new PrismaClient({ datasources: { db: { url: workerUrl.toString() } } });
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const initialAdminId = randomUUID();
    let principalCreated = false;
    const slug = `authority-${tenantId}`;
    const initial: VoiceActor = {
      tenantId,
      userId: initialAdminId,
      roles: ['admin'],
      caller: {
        issuer: 'https://authority.test/realms/dcontact',
        subject: initialAdminId,
        clientId: 'dcontact-console',
        tenantSlug: slug,
      },
    };
    const provider: TenantPeopleIdentityPort = {
      async mutateStep(claim) {
        return {
          outcome: 'SUCCEEDED',
          receiptRef: `isolated-${claim.operationId}-${claim.step}`,
          ...(claim.step.startsWith('VERIFY_') ? { identityId: claim.userId } : {}),
        };
      },
      async readOutcome(claim) {
        return this.mutateStep(claim);
      },
    };
    try {
      await owner.$executeRawUnsafe(
        `CREATE ROLE "${principal}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${workerUrl.password}'`,
      );
      principalCreated = true;
      await owner.$executeRawUnsafe(`GRANT dcontact_tenant_people_worker TO "${principal}"`);
      await owner.tenant.create({
        data: { id: tenantId, name: 'Isolated B2 authority', slug, sipDomain: `${slug}.test` },
      });
      await owner.team.create({ data: { id: teamId, tenantId, name: 'Authority team' } });
      await owner.user.create({
        data: {
          id: initialAdminId,
          keycloakId: initialAdminId,
          tenantId,
          teamId,
          email: 'bootstrap@authority.test',
          displayName: 'Initial Admin',
          passwordHash: '!keycloak-managed',
          role: 'ADMIN',
        },
      });
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active)
      VALUES(${tenantId}::uuid,${initialAdminId}::uuid,${initial.caller!.issuer},${initialAdminId},'dcontact-console',${slug},${tenantId}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','isolated-initial-admin',${'a'.repeat(64)},'isolated-operator',now(),1,true)`;
      await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason)
      VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',20,10,3,3,'isolated-operator',now(),'isolated-authority','ทดสอบ authority ของบัญชีใหม่')`;
      await owner.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref)
      VALUES(${tenantId}::uuid,${principal},'isolated-authority')`;
      const created = await acceptPeopleCreate(application, initial, {
        commandId: randomUUID(),
        displayName: 'New Admin',
        email: 'new-admin@authority.test',
        role,
        teamId,
      });
      const caller = {
        ...initial,
        userId: created.userId,
        roles: [role.toLowerCase()],
        caller: { ...initial.caller!, subject: created.userId },
      };
      const readActor = () =>
        withTenantDatabaseTransaction(application, tenantId, (transaction) =>
          findTenantConfigurationActor(transaction, caller),
        );
      assert.equal(await readActor(), undefined, 'accepted account is not authority');
      for (let step = 0; step < 6; step++) {
        assert.equal(
          await runPeopleWorkerStep(
            worker,
            provider,
            tenantId,
            created.operationId,
            'authority-worker',
          ),
          'RECORDED',
        );
      }
      assert.equal(
        await readActor(),
        undefined,
        'provisioning without activation is not authority',
      );
      assert.equal(
        await runPeopleActivation(
          worker,
          {
            async readActivation(claim) {
              return {
                outcome: 'VERIFIED',
                tenantId: claim.tenantId,
                operationId: claim.operationId,
                userId: claim.userId,
                payloadDigest: claim.payloadDigest,
                probeRef: randomUUID(),
                serverEpoch: Math.floor(Date.now() / 1000),
              };
            },
          },
          tenantId,
          created.operationId,
        ),
        'ACTIVATED',
      );
      const bindings = await owner.$queryRaw<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM tenant_voice_identity_bindings
      WHERE tenant_id=${tenantId}::uuid AND user_id=${created.userId}::uuid`;
      assert.equal(bindings[0].count, 0);
      const actor = await withTenantDatabaseTransaction(application, tenantId, (transaction) =>
        findTenantConfigurationActor(transaction, caller),
      );
      assert.equal(actor?.id, created.userId);
      assert.equal(actor?.role, role);
      assert.equal((await catalogCapabilities(application, caller)).canWrite, role === 'ADMIN');
      const anotherTeamId = randomUUID();
      await owner.team.create({ data: { id: anotherTeamId, tenantId, name: 'Another team' } });
      assert.deepEqual(
        (await catalogTeams(application, caller)).items.map((team) => team.id).sort(),
        (role === 'ADMIN' ? [teamId, anotherTeamId] : [teamId]).sort(),
      );
      const createSkill = () =>
        createCatalog(application, caller, 'skills', {
          commandId: randomUUID(),
          name: 'Verified authority skill',
          code: 'AUTHORITY',
          teamId,
        });
      if (role === 'ADMIN') assert.ok(await createSkill());
      else
        await assert.rejects(
          createSkill,
          (error: unknown) => error instanceof HttpException && error.getStatus() === 403,
        );
      const snapshot = await withTenantDatabaseTransaction(
        application,
        tenantId,
        (transaction) =>
          transaction.$queryRaw<{ snapshot: { admins: { id: string }[] } }[]>`
        SELECT dc_people_disable_snapshot(${tenantId}::uuid,${initialAdminId}::uuid,${initial.caller!.issuer},'dcontact-console',${slug}) AS snapshot`,
      );
      assert.deepEqual(
        snapshot[0].snapshot.admins.map((admin) => admin.id).sort(),
        (role === 'ADMIN' ? [initialAdminId, created.userId] : [initialAdminId]).sort(),
      );
      if (role === 'ADMIN') {
        const rejection: TenantPeopleDisablePort = {
          async probe() {
            return { outcome: 'READY' };
          },
          async disable(attempt) {
            return {
              outcome: 'REJECTED_NO_EFFECT',
              reasonCode: 'LAST_USABLE_ADMIN',
              receiptRef: 'c'.repeat(64),
              identityId: attempt.identityId,
            };
          },
          async readOutcome() {
            assert.fail('fresh rejection does not reconcile');
          },
        };
        const current = await owner.user.findUniqueOrThrow({ where: { id: created.userId } });
        const disabled = await acceptPeopleDisable(
          application,
          initial,
          created.userId,
          {
            commandId: randomUUID(),
            expectedRevision: current.configRevision,
            reasonCode: 'OPERATOR_REQUEST',
            reason: 'ทดสอบคืน authority หลังปฏิเสธ disable',
          },
          rejection,
        );
        assert.equal(await readActor(), undefined, 'DISABLING must close configuration authority');
        assert.equal(
          await runPeopleDisable(
            worker,
            rejection,
            { async flush() {} },
            tenantId,
            disabled.operationId,
          ),
          'REJECTED',
        );
        assert.equal(
          (await readActor())?.id,
          created.userId,
          'compensated Admin retains verified authority',
        );
      }
      for (const denied of [
        { ...caller, roles: ['agent'] },
        { ...caller, caller: { ...caller.caller, clientId: 'platform-console' } },
        {
          ...caller,
          caller: { ...caller.caller, issuer: 'https://another-issuer.test/realms/dcontact' },
        },
        { ...caller, caller: { ...caller.caller, tenantSlug: 'another-tenant' } },
        { ...caller, caller: { ...caller.caller, subject: initialAdminId } },
      ]) {
        assert.equal(
          await withTenantDatabaseTransaction(application, tenantId, (transaction) =>
            findTenantConfigurationActor(transaction, denied),
          ),
          undefined,
        );
      }
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active)
      VALUES(${tenantId}::uuid,${created.userId}::uuid,${initial.caller!.issuer},${created.userId},'dcontact-console',${slug},${tenantId}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','isolated-revoked-proof',${'b'.repeat(64)},'isolated-operator',now(),1,false)`;
      assert.equal(
        await withTenantDatabaseTransaction(application, tenantId, (transaction) =>
          findTenantConfigurationActor(transaction, caller),
        ),
        undefined,
        'revoked operator binding must not fall back to lifecycle authority',
      );
      const revokedSnapshot = await withTenantDatabaseTransaction(
        application,
        tenantId,
        (transaction) =>
          transaction.$queryRaw<{ snapshot: { admins: { id: string }[] } }[]>`
        SELECT dc_people_disable_snapshot(${tenantId}::uuid,${initialAdminId}::uuid,${initial.caller!.issuer},'dcontact-console',${slug}) AS snapshot`,
      );
      assert.deepEqual(
        revokedSnapshot[0].snapshot.admins.map((admin) => admin.id),
        [initialAdminId],
      );
    } finally {
      await Promise.all([worker.$disconnect(), application.$disconnect()]);
      try {
        if (principalCreated) {
          await owner.$executeRaw`DELETE FROM tenant_people_worker_bindings WHERE tenant_id=${tenantId}::uuid AND database_principal=${principal}`;
          await owner.$executeRawUnsafe(`DROP ROLE "${principal}"`);
        }
      } finally {
        await owner.$disconnect();
      }
    }
  });
}
