import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import type { OidcAccessTokenVerifier } from '@d-contact/workspace-session';
import { Customer360ReadController } from './customer-360-read-api.js';
import { contact, grant } from './customer-360-read-test-fixtures.js';
import { runPeopleActivation } from './tenant-people-activation.js';
import { acceptPeopleCreate } from './tenant-people-operations.js';
import { runPeopleWorkerStep, type TenantPeopleIdentityPort } from './tenant-people-worker.js';
import { coreFixture } from './tenant-core-test-fixtures.js';
import type { VoiceActor } from './tenant-voice-catalog.js';

/**
 * Cus360 C2 (#792): actor ที่ยืนยันผ่านเส้น B2 (verified receipts, #863 `dc_people_configuration_authority`)
 * ได้ "ตัวตน" ของ ADMIN/SUPERVISOR เท่านั้น — ไม่ได้สิทธิ์ลูกค้าเพิ่ม: ไม่มี grant = directory ว่าง/count 0/profile 404
 */

for (const role of ['ADMIN'] as const) {
  test(`B2 ${role} ที่ผ่าน provisioning+activation (ไม่มี manual binding) อ่านลูกค้าได้เฉพาะที่มี custodian grant`, async () => {
    const owner = new PrismaClient();
    const application = new PrismaClient({
      datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
    });
    const principal = `c2b2_${randomUUID().replaceAll('-', '')}`;
    const workerUrl = new URL(process.env.DATABASE_URL!);
    workerUrl.username = principal;
    workerUrl.password = randomUUID();
    workerUrl.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
    const worker = new PrismaClient({ datasources: { db: { url: workerUrl.toString() } } });
    const tenantId = randomUUID();
    const teamId = randomUUID();
    const initialAdminId = randomUUID();
    const slug = `c2b2-${tenantId}`;
    const issuer = 'https://c2b2.test/realms/dcontact';
    let principalCreated = false;
    let fixture: Awaited<ReturnType<typeof coreFixture>> | undefined;
    const initial: VoiceActor = {
      tenantId,
      userId: initialAdminId,
      roles: ['admin'],
      caller: { issuer, subject: initialAdminId, clientId: 'dcontact-console', tenantSlug: slug },
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
        data: { id: tenantId, name: 'C2 B2 authority', slug, sipDomain: `${slug}.test` },
      });
      await owner.team.create({ data: { id: teamId, tenantId, name: 'C2 B2 team' } });
      await owner.user.create({
        data: {
          id: initialAdminId,
          keycloakId: initialAdminId,
          tenantId,
          teamId,
          email: 'bootstrap@c2b2.test',
          displayName: 'Initial Admin',
          passwordHash: '!keycloak-managed',
          role: 'ADMIN',
        },
      });
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active)
      VALUES(${tenantId}::uuid,${initialAdminId}::uuid,${issuer},${initialAdminId},'dcontact-console',${slug},${tenantId}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','isolated-initial-admin',${'a'.repeat(64)},'isolated-operator',now(),1,true)`;
      await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason)
      VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',20,10,3,3,'isolated-operator',now(),'isolated-c2b2','ทดสอบ authority ของบัญชีใหม่กับ Customer 360')`;
      await owner.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref)
      VALUES(${tenantId}::uuid,${principal},'isolated-c2b2')`;
      const created = await acceptPeopleCreate(application, initial, {
        commandId: randomUUID(),
        displayName: 'B2 Admin',
        email: 'b2-admin@c2b2.test',
        role,
        teamId,
      });
      for (let step = 0; step < 6; step++)
        assert.equal(
          await runPeopleWorkerStep(worker, provider, tenantId, created.operationId, 'c2b2-worker'),
          'RECORDED',
        );
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
      );
      const bindings = await owner.$queryRaw<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM tenant_voice_identity_bindings
        WHERE tenant_id=${tenantId}::uuid AND user_id=${created.userId}::uuid`;
      assert.equal(bindings[0]!.count, 0, 'ไม่มี manual binding — ผ่านเส้น B2 เท่านั้น');

      // verifier จำลองเฉพาะบัญชี B2 นี้ (ไม่ใช่ Keycloak): claims ตรงกับ issuer/slug ที่ B2 ตรวจจาก receipts
      const verifier: OidcAccessTokenVerifier = {
        verifyAccessToken: async (token: string) => {
          assert.equal(token, 'b2');
          return {
            iss: issuer,
            sub: created.userId,
            azp: 'dcontact-console',
            tenant_id: tenantId,
            tenant_slug: slug,
            organization: { [slug]: { tenant_id: [tenantId] } },
            dc_user_id: created.userId,
            sid: `c2b2-${created.userId}`,
            exp: 2_000_000_000,
            realm_access: { roles: [role.toLowerCase()] },
          };
        },
      };
      fixture = await coreFixture([Customer360ReadController], verifier);
      const f = fixture;
      // helper ของ read fixtures ใช้เฉพาะ owner/tenantId/actors
      const base = (actors = new Map()) =>
        ({ owner, tenantId, otherTenantId: tenantId, actors }) as unknown as Parameters<
          typeof contact
        >[0];
      const search = (body: unknown = {}) =>
        f.request('customer-360/contacts/search', 'b2', body) as unknown as Promise<{
          status: number;
          body: { items: { contactId: string }[]; accessibleCount: unknown };
        }>;
      const detail = (id: string) => f.request(`customer-360/contacts/${id}`, 'b2');

      const withGrant = await contact(base(), {
        displayName: 'B2 Granted',
      });
      const withoutGrant = await contact(base(), { displayName: 'B2 Hidden' });
      // ตัวตนผ่าน B2 แล้ว แต่ยังไม่มี custodian grant → ว่าง/0/404 (ไม่มี bypass จากตัวตน)
      const before = await search();
      assert.equal(before.status, 200);
      assert.deepEqual(before.body.items, []);
      assert.deepEqual(before.body.accessibleCount, { state: 'AVAILABLE', value: 0 });
      assert.equal((await detail(withGrant)).status, 404);
      assert.equal((await detail(withoutGrant)).status, 404);

      await grant(
        base(new Map([['b2', { id: created.userId, role, tenantId }]])),
        'b2',
        withGrant,
        'READ',
      );
      const after = await search();
      assert.deepEqual(
        after.body.items.map((item) => item.contactId),
        [withGrant],
      );
      assert.deepEqual(after.body.accessibleCount, { state: 'AVAILABLE', value: 1 });
      assert.equal((await detail(withGrant)).status, 200);
      assert.equal((await detail(withoutGrant)).status, 404);
    } finally {
      await fixture?.close();
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
