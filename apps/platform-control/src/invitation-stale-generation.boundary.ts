/**
 * A1.4b (#436) acceptance: ลิงก์ invitation รุ่นเก่าต้องไม่ให้สิทธิ์ซ้ำ (#392)
 *
 * - รุ่นที่ถูก resend แทนแล้วใช้ไม่ได้แม้ผู้ใช้ยังไม่ activate (`dc_invitation_not_before`)
 * - หลัง activate ด้วยรุ่นใดก็ตาม รุ่นอื่นเปลี่ยน credential ไม่ได้ (ไม่มี required action ค้าง)
 * ทั้งสองข้อบังคับโดย Keycloak extension `infra/keycloak/extensions/invitation-guard`
 *
 * รัน: `pnpm a1:provisioning:boundary` (ต้องมี Keycloak ที่โหลด extension + mailpit)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { InvitationOutbox, mailpitDeliveryProbe } from './invitation-outbox.js';
import { FirstAdminPort, KeycloakOrganizationPort } from './keycloak-provisioning-ports.js';
import {
  cleanupKeycloak,
  completeInvitation,
  invitationLinks,
  keycloakAdmin,
  MAILPIT_URL,
  provisionerClient,
} from './keycloak-test-support.js';
import { createPlatformFixture, OPERATOR, SIP_BASE } from './platform-fixture.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { ProvisioningSagaWorker } from './provisioning-saga.js';
import { TenantBootstrapPort, TenantReadinessPort } from './tenant-bootstrap.js';

test('#436: หลัง activate ด้วย generation ใหม่ ลิงก์ generation เก่าต้องเปลี่ยน credential ไม่ได้', async (t) => {
  const f = await createPlatformFixture();
  const tenants: string[] = [];
  t.after(async () => {
    await cleanupKeycloak(tenants);
    await f.dispose();
  });
  const keycloak = provisionerClient();
  const organizations = new KeycloakOrganizationPort(keycloak);
  const firstAdmin = new FirstAdminPort(keycloak, f.provisioner, organizations);
  const outbox = new InvitationOutbox(f.platform, keycloak, firstAdmin, {
    probe: mailpitDeliveryProbe(MAILPIT_URL),
  });
  const worker = new ProvisioningSagaWorker(
    f.platform,
    {
      ...createFakeProvisioningPorts().ports,
      KEYCLOAK_ORGANIZATION: organizations,
      PLAN_BOOTSTRAP: new TenantBootstrapPort(f.platform, f.provisioner),
      FIRST_ADMIN: firstAdmin,
      INVITATION: outbox.port(),
      READINESS: new TenantReadinessPort(f.platform, f.provisioner),
    },
    {
      workerId: `gap-436-${randomUUID().slice(0, 8)}`,
      sipBaseDomain: SIP_BASE,
      scope: () => ({ tenantId: { in: [...tenants] } }),
    },
  );
  const input = f.input();
  const key = `idem-${randomUUID()}`;
  const accepted = await f.repository().accept({
    idempotencyKey: key,
    input,
    plan: f.plan,
    actor: OPERATOR,
    correlationId: key,
  });
  f.track(accepted.tenantId);
  tenants.push(accepted.tenantId);
  await worker.drain();
  await outbox.resend({
    requestId: accepted.requestId,
    reasonCode: 'RECIPIENT_REQUESTED',
    comment: 'ส่งใหม่ก่อน activate',
    actor: OPERATOR,
    correlationId: `corr-${key}`,
  });
  const [stale, current] = await invitationLinks(input.firstAdmin.email);
  assert.ok(stale && current, 'ต้องมี invitation สอง generation');
  const [pending] = (
    await keycloakAdmin<{ id: string }[]>(
      'GET',
      `/users?${new URLSearchParams({ username: input.firstAdmin.email, exact: 'true' })}`,
    )
  ).body;
  const credentialCount = async () =>
    (await keycloakAdmin<unknown[]>('GET', `/users/${pending!.id}/credentials`)).body.length;

  // รุ่นที่ถูก supersede ใช้ไม่ได้แม้ผู้ใช้ยังไม่ activate
  await completeInvitation(stale, `Superseded-${randomUUID().slice(0, 8)}!`);
  assert.equal(await credentialCount(), 0, 'ลิงก์รุ่นที่ถูกแทนแล้วยังตั้ง credential ได้ (#436)');

  await completeInvitation(current, `Current-${randomUUID().slice(0, 8)}!`);
  const [user] = (
    await keycloakAdmin<{ id: string }[]>(
      'GET',
      `/users?${new URLSearchParams({ username: input.firstAdmin.email, exact: 'true' })}`,
    )
  ).body;
  const credentials = async () =>
    (
      await keycloakAdmin<{ type: string; createdDate: number }[]>(
        'GET',
        `/users/${user!.id}/credentials`,
      )
    ).body
      .map((credential) => `${credential.type}:${credential.createdDate}`)
      .sort();
  const before = await credentials();

  await completeInvitation(stale, `Stale-${randomUUID().slice(0, 8)}!`);
  assert.deepEqual(
    await credentials(),
    before,
    'ลิงก์ generation เก่าเปลี่ยน credential ได้หลัง activation (#436)',
  );
});
