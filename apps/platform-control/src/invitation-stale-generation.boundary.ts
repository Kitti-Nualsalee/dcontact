/**
 * A1.4b (#436) acceptance: a stale-generation invitation link must not grant access again (#392)
 *
 * - a generation superseded by a resend cannot be used even if the user has not activated (`dc_invitation_not_before`)
 * - after activating with any generation, the other generations cannot change the credential (no required action left)
 * Both are enforced by the Keycloak extension `infra/keycloak/extensions/invitation-guard`
 *
 * Run: `pnpm a1:provisioning:boundary` (needs Keycloak with the extension loaded + mailpit)
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
import { createPlatformFixture, OPERATOR, SIP_BASE, TENANT_CONSOLE } from './platform-fixture.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { ProvisioningSagaWorker } from './provisioning-saga.js';
import { TenantBootstrapPort, TenantReadinessPort } from './tenant-bootstrap.js';

test('#436: after activating with a new generation, the old generation link must not be able to change the credential', async (t) => {
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
      tenantConsole: TENANT_CONSOLE,
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
    comment: 'resent before activation',
    actor: OPERATOR,
    correlationId: `corr-${key}`,
  });
  const [stale, current] = await invitationLinks(input.firstAdmin.email);
  assert.ok(stale && current, 'there must be two invitation generations');
  const [pending] = (
    await keycloakAdmin<{ id: string }[]>(
      'GET',
      `/users?${new URLSearchParams({ username: input.firstAdmin.email, exact: 'true' })}`,
    )
  ).body;
  const credentialCount = async () =>
    (await keycloakAdmin<unknown[]>('GET', `/users/${pending!.id}/credentials`)).body.length;

  // the superseded generation cannot be used even if the user has not activated
  await completeInvitation(stale, `Superseded-${randomUUID().slice(0, 8)}!`);
  assert.equal(
    await credentialCount(),
    0,
    'the superseded generation link could still set a credential (#436)',
  );

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
    'the old generation link could change the credential after activation (#436)',
  );
});
