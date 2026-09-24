/**
 * #436 acceptance check (ยังไม่ผ่าน — ตั้งใจให้ FAIL ตรง ๆ จนกว่า #436 จะเสร็จ ห้ามผ่อนเกณฑ์)
 *
 * #392: "เมื่อ required actions สำเร็จ invitation generations อื่นต้องไม่ให้สิทธิ์ซ้ำ"
 * Keycloak 26.0 execute-actions token ของ generation เก่ายังตั้งรหัสผ่าน/เพิ่ม OTP ได้หลัง activation
 *
 * รัน: `pnpm --filter @d-contact/platform-control test:boundary:436` (ต้องมี Keycloak + mailpit)
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
