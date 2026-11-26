/**
 * A1.4 (#409) real boundary: Keycloak 26 + mailpit + real Postgres — not in the fast gate
 *
 * Covers the acceptance of #409: create, verified adoption, duplicate/replay, conflict, timeout,
 * lost response, 72-hour invitation, a race-safe resend cap, and a first-admin who has completed every execute
 * action being able to log in through the tenant boundary (and the platform boundary not accepting it)
 *
 * Requires: `pnpm infra:up` and `pnpm infra:identity:link && pnpm infra:identity:platform`
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { toVerifiedWorkspaceIdentity } from '@d-contact/workspace-session';
import { PlatformProvisioningError } from '@d-contact/shared';
import {
  InvitationOutbox,
  mailpitDeliveryProbe,
  NO_DELIVERY_PROBE,
  type InvitationDeliveryProbe,
} from './invitation-outbox.js';
import {
  FirstAdminPort,
  KeycloakOrganizationPort,
  PROVISIONING_REQUEST_ATTRIBUTE,
} from './keycloak-provisioning-ports.js';
import {
  FIRST_ADMIN_KEYCLOAK_EVENT_TYPES,
  FirstAdminActivityReconciler,
} from './first-admin-activity.js';
import { firstAdminUserId } from './provisioning-ids.js';
import {
  actionTokenClaims,
  cleanupKeycloak,
  completeInvitation,
  consoleRedirects,
  ensureBoundaryConsole,
  invitationLinks,
  keycloakAdmin,
  MAILPIT_URL,
  messagesTo,
  provisionerClient,
  tenantLogin,
} from './keycloak-test-support.js';
import { createPlatformFixture, OPERATOR, SIP_BASE } from './platform-fixture.js';
import { TenantConsoleRedirects } from './tenant-console-redirects.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { ProvisioningSagaWorker } from './provisioning-saga.js';
import { TenantBootstrapPort, TenantReadinessPort } from './tenant-bootstrap.js';

type Fault = (url: string, method: string) => 'lose-response' | 'hang' | undefined;

/** a fetch that sends the real request then behaves as if the response was lost or hangs until timeout — simulates a fault after Keycloak already acted */
function faultyFetch(fault: Fault): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const kind = fault(url, method);
    const response = await fetch(input, init);
    if (kind === 'lose-response') throw new TypeError('fetch failed: socket hang up');
    if (kind === 'hang') {
      await new Promise((resolve, reject) => {
        init?.signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
        setTimeout(resolve, 30_000).unref();
      });
    }
    return response;
  };
}

/** a one-time fault per (method, matching path) */
function once(method: string, pattern: RegExp, kind: 'lose-response' | 'hang'): Fault {
  let fired = false;
  return (url, requestMethod) => {
    if (fired || requestMethod !== method || !pattern.test(new URL(url).pathname)) return undefined;
    fired = true;
    return kind;
  };
}

async function setup(
  t: TestContext,
  options: { fault?: Fault; probe?: InvitationDeliveryProbe } = {},
) {
  const f = await createPlatformFixture();
  const tenants: string[] = [];
  t.after(async () => {
    await cleanupKeycloak(tenants);
    await f.dispose();
  });
  const keycloak = provisionerClient(options.fault ? faultyFetch(options.fault) : undefined);
  const organizations = new KeycloakOrganizationPort(keycloak);
  // #907: the boundary's real Console client with the same fine-grained permission as UAT
  const tenantConsole = await ensureBoundaryConsole();
  const firstAdmin = new FirstAdminPort(
    keycloak,
    f.provisioner,
    organizations,
    new TenantConsoleRedirects(keycloak, f.provisioner, tenantConsole),
  );
  const outbox = new InvitationOutbox(f.platform, keycloak, firstAdmin, {
    probe: options.probe ?? mailpitDeliveryProbe(MAILPIT_URL),
  });
  const fakes = createFakeProvisioningPorts();
  const bootstrap = new TenantBootstrapPort(f.platform, f.provisioner);
  // every step is real except none — readiness re-checks the identity in Keycloak before ACTIVE
  const ports = {
    ...fakes.ports,
    KEYCLOAK_ORGANIZATION: organizations,
    PLAN_BOOTSTRAP: bootstrap,
    FIRST_ADMIN: firstAdmin,
    INVITATION: outbox.port(),
    READINESS: new TenantReadinessPort(
      f.platform,
      f.provisioner,
      async (context) => (await firstAdmin.find(context)).status === 'FOUND',
    ),
  };
  const worker = new ProvisioningSagaWorker(f.platform, ports, {
    workerId: `boundary-${randomUUID().slice(0, 8)}`,
    sipBaseDomain: SIP_BASE,
    tenantConsole,
    scope: () => ({ tenantId: { in: [...tenants] } }),
    timeoutMs: 3_000,
    backoffBaseMs: 1,
    backoffMaxMs: 1,
  });
  const accept = async (overrides: Parameters<typeof f.input>[0] = {}) => {
    const input = f.input(overrides);
    const key = `idem-${randomUUID()}`;
    const result = await f.repository().accept({
      idempotencyKey: key,
      input,
      plan: f.plan,
      actor: OPERATOR,
      correlationId: `corr-${key}`,
    });
    f.track(result.tenantId);
    tenants.push(result.tenantId);
    return { ...result, input };
  };
  /** walks the saga until it settles (a retry at 1ms backoff is picked up immediately next round) */
  const drain = async () => {
    for (let round = 0; round < 20; round += 1) {
      const results = await worker.drain();
      if (results.length === 0) break;
    }
  };
  const state = (requestId: string) =>
    f.owner.pfProvisioningRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { steps: { orderBy: { ordinal: 'asc' } }, tenant: true, invitations: true },
    });
  return {
    f,
    keycloak,
    organizations,
    bootstrap,
    firstAdmin,
    outbox,
    fakes,
    worker,
    accept,
    drain,
    state,
    tenantConsole,
  };
}

async function organizationsOf(tenantId: string) {
  type Organization = { id: string; name: string; attributes: Record<string, string[]> };
  const { body } = await keycloakAdmin<{ id: string }[]>(
    'GET',
    `/organizations?${new URLSearchParams({ q: `tenant_id:${tenantId}` })}`,
  );
  const organizations: Organization[] = [];
  for (const { id } of body ?? []) {
    organizations.push((await keycloakAdmin<Organization>('GET', `/organizations/${id}`)).body);
  }
  return organizations;
}

async function usersOf(tenantId: string) {
  const { body } = await keycloakAdmin<
    {
      id: string;
      emailVerified: boolean;
      requiredActions: string[];
      attributes: Record<string, string[]>;
    }[]
  >(
    'GET',
    `/users?${new URLSearchParams({ q: `tenant_id:${tenantId}`, briefRepresentation: 'false' })}`,
  );
  return body;
}

test('create: Organization + first-admin + 72-hour invitation, then the tenant is ACTIVE', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  await s.drain();
  const final = await s.state(accepted.requestId);
  assert.deepEqual([final.status, final.tenant.lifecycleStatus], ['SUCCEEDED', 'ACTIVE']);

  const [organization, ...extraOrganizations] = await organizationsOf(accepted.tenantId);
  assert.equal(extraOrganizations.length, 0);
  assert.equal(organization!.name, accepted.input.slug);
  assert.deepEqual(organization!.attributes[PROVISIONING_REQUEST_ATTRIBUTE], [accepted.requestId]);

  const [user, ...extraUsers] = await usersOf(accepted.tenantId);
  assert.equal(extraUsers.length, 0);
  assert.equal(user!.emailVerified, false);
  assert.deepEqual(user!.requiredActions.sort(), [
    'CONFIGURE_TOTP',
    'UPDATE_PASSWORD',
    'VERIFY_EMAIL',
  ]);
  assert.deepEqual(user!.attributes.dc_user_id, [firstAdminUserId(accepted.requestId)]);
  // D-Contact creates no credential of any kind for the first-admin
  const { body: credentials } = await keycloakAdmin<unknown[]>(
    'GET',
    `/users/${user!.id}/credentials`,
  );
  assert.deepEqual(credentials, []);
  // #901: the first admin's binding ties to the real Keycloak subject and Organization together with ACTIVE
  const [binding, ...extraBindings] = await s.f.owner.tenantVoiceIdentityBinding.findMany({
    where: { tenantId: accepted.tenantId },
  });
  assert.equal(extraBindings.length, 0);
  assert.deepEqual(
    [binding!.userId, binding!.subjectId, binding!.organizationId, binding!.sourceKind],
    [firstAdminUserId(accepted.requestId), user!.id, organization!.id, 'PLATFORM_PROVISIONING'],
  );
  assert.deepEqual(
    [binding!.issuer, binding!.clientId, binding!.tenantSlug],
    [s.tenantConsole.issuer, s.tenantConsole.clientId, accepted.input.slug],
  );
  // #907: the tenant's exact redirect is added for both login and post-logout, keeping the existing ones
  const redirect = `${s.tenantConsole.origin}/?tenant=${accepted.input.slug}`;
  const registered = await consoleRedirects();
  assert.ok(registered.redirectUris.includes(redirect));
  assert.ok(registered.postLogout.includes(redirect));
  assert.ok(registered.redirectUris.includes(`${s.tenantConsole.origin}/?tenant=boundary-base`));

  const row = await s.f.owner.user.findUniqueOrThrow({
    where: { id: firstAdminUserId(accepted.requestId) },
  });
  assert.deepEqual(
    [row.tenantId, row.keycloakId, row.role],
    [accepted.tenantId, user!.id, 'ADMIN'],
  );

  assert.equal(final.invitations.length, 1);
  const [invitation] = final.invitations;
  assert.equal(invitation!.state, 'SENT');
  assert.equal(invitation!.expiresAt!.getTime() - invitation!.sentAt!.getTime(), 72 * 3600_000);
  const links = await invitationLinks(accepted.input.firstAdmin.email);
  assert.equal(links.length, 1);
  const claims = actionTokenClaims(links[0]!);
  assert.equal(claims.typ, 'execute-actions');
  assert.equal(claims.exp - claims.iat, 72 * 3600);

  // the evidence has no raw email
  const evidence = JSON.stringify([
    final.steps,
    final.invitations,
    await s.f.owner.pfActionHistory.findMany({ where: { requestId: accepted.requestId } }),
    await s.f.owner.pfProvisioningStepReceipt.findMany({
      where: { requestId: accepted.requestId },
    }),
  ]);
  assert.equal(evidence.includes(accepted.input.firstAdmin.email), false);
});

test('replay/duplicate: a repeated execute during PROVISIONING does not create duplicates, then the saga adopts everything', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const request = await s.state(accepted.requestId);
  const { provisioningStepContext } = await import('./provisioning-saga.js');
  const signal = new AbortController().signal;
  // simulates several workers/a crash executing the same step again before anyone records a receipt
  for (let round = 0; round < 2; round += 1) {
    await s.organizations.execute(
      provisioningStepContext(request, 'KEYCLOAK_ORGANIZATION', 1),
      signal,
    );
    await s.bootstrap.execute(provisioningStepContext(request, 'PLAN_BOOTSTRAP', 1));
    await s.firstAdmin.execute(provisioningStepContext(request, 'FIRST_ADMIN', 1), signal);
    await s.outbox.port().execute(provisioningStepContext(request, 'INVITATION', 1), signal);
  }
  await s.drain();
  const final = await s.state(accepted.requestId);
  assert.deepEqual([final.status, final.tenant.lifecycleStatus], ['SUCCEEDED', 'ACTIVE']);
  assert.equal((await organizationsOf(accepted.tenantId)).length, 1);
  assert.equal((await usersOf(accepted.tenantId)).length, 1);
  const [organization] = await organizationsOf(accepted.tenantId);
  const { body: members } = await keycloakAdmin<unknown[]>(
    'GET',
    `/organizations/${organization!.id}/members`,
  );
  assert.equal(members.length, 1);
  assert.equal(await s.f.owner.pfInvitation.count({ where: { requestId: accepted.requestId } }), 1);
  assert.equal((await messagesTo(accepted.input.firstAdmin.email)).length, 1);
  const adopted = await s.f.owner.pfActionHistory.findMany({
    where: { requestId: accepted.requestId, reasonCode: 'VERIFIED_ADOPTION' },
  });
  assert.deepEqual(adopted.map((row) => row.stepKey).sort(), [
    'FIRST_ADMIN',
    'INVITATION',
    'KEYCLOAK_ORGANIZATION',
    'PLAN_BOOTSTRAP',
  ]);
  // after ACTIVE the provisioner can no longer touch this tenant's users row (#388 decision)
  assert.equal(await s.f.provisioner.user.count({ where: { tenantId: accepted.tenantId } }), 0);
});

test('lost response when creating the Organization and user: the next attempt adopts without creating again', async (t) => {
  const lost = [
    once('POST', /\/organizations$/, 'lose-response'),
    once('POST', /\/users$/, 'lose-response'),
  ];
  const s = await setup(t, {
    fault: (url, method) => lost.map((fault) => fault(url, method)).find(Boolean),
  });
  const accepted = await s.accept();
  await s.drain();
  const final = await s.state(accepted.requestId);
  assert.equal(final.status, 'SUCCEEDED');
  assert.equal((await organizationsOf(accepted.tenantId)).length, 1);
  assert.equal((await usersOf(accepted.tenantId)).length, 1);
  // Organization: the next attempt's find finds an org with a matching correlation = verified adoption
  // user: finds our own identity that is incomplete (no role/membership), so execute fills in what is missing without creating a new one
  const adopted = await s.f.owner.pfActionHistory.findMany({
    where: { requestId: accepted.requestId, reasonCode: 'VERIFIED_ADOPTION' },
  });
  assert.deepEqual(
    adopted.map((row) => row.stepKey),
    ['KEYCLOAK_ORGANIZATION'],
  );
});

test('timeout while creating the user: aborted as ambiguous, then the next round adopts', async (t) => {
  const s = await setup(t, { fault: once('POST', /\/users$/, 'hang') });
  const accepted = await s.accept();
  await s.drain();
  const final = await s.state(accepted.requestId);
  assert.equal(final.status, 'SUCCEEDED');
  assert.equal((await usersOf(accepted.tenantId)).length, 1);
  const retries = await s.f.owner.pfActionHistory.findMany({
    where: { requestId: accepted.requestId, action: 'STEP_RETRY_SCHEDULED' },
  });
  assert.deepEqual(
    retries.map((row) => [row.stepKey, row.errorCode]),
    [['FIRST_ADMIN', 'EXTERNAL_TIMEOUT']],
  );
});

test('conflict: a same-named org of another party is not adopted, and an email of another identity gets a stable code that does not reveal the tenant', async (t) => {
  const s = await setup(t);
  // an org of a different owner that uses the same name (slug)
  const slugTaken = await s.accept();
  const foreignTenant = randomUUID();
  await keycloakAdmin('POST', '/organizations', {
    name: slugTaken.input.slug,
    alias: slugTaken.input.slug,
    enabled: true,
    domains: [{ name: `foreign-${slugTaken.input.primaryDomain}`, verified: false }],
    attributes: { tenant_id: [foreignTenant] },
  });
  t.after(() => cleanupKeycloak([foreignTenant]));

  // an email that belongs to an existing tenant user in the dev realm
  const emailTaken = await s.accept({
    firstAdmin: { email: 'admin@demo.local', displayName: 'Taken' },
  });
  await s.drain();

  const orgConflict = await s.state(slugTaken.requestId);
  assert.equal(orgConflict.status, 'ACTION_REQUIRED');
  assert.equal(orgConflict.failureCode, 'KEYCLOAK_ORGANIZATION_CONFLICT');
  const [foreign] = await organizationsOf(foreignTenant);
  assert.ok(foreign, 'the other party org must still exist');
  assert.equal(foreign.attributes[PROVISIONING_REQUEST_ATTRIBUTE], undefined);

  const emailConflict = await s.state(emailTaken.requestId);
  assert.equal(emailConflict.status, 'ACTION_REQUIRED');
  assert.equal(emailConflict.failureCode, 'FIRST_ADMIN_EMAIL_CONFLICT');
  const history = JSON.stringify(
    await s.f.owner.pfActionHistory.findMany({ where: { requestId: emailTaken.requestId } }),
  );
  assert.equal(history.includes('demo'), false);
  // the existing identity is not touched
  const { body: existing } = await keycloakAdmin<{ attributes: Record<string, string[]> }[]>(
    'GET',
    `/users?${new URLSearchParams({ username: 'admin@demo.local', exact: 'true', briefRepresentation: 'false' })}`,
  );
  assert.equal(existing[0]!.attributes[PROVISIONING_REQUEST_ATTRIBUTE], undefined);
  // stops at find (MISMATCH) so no users row is created
  assert.equal(
    await s.f.owner.user.count({ where: { id: firstAdminUserId(emailTaken.requestId) } }),
    0,
  );
});

test('invitation lost response: reconcile with evidence in the email sink without resending; no evidence = ACTION_REQUIRED', async (t) => {
  const withProbe = await setup(t, {
    fault: once('PUT', /execute-actions-email$/, 'lose-response'),
  });
  const reconciled = await withProbe.accept();
  await withProbe.drain();
  const reconciledState = await withProbe.state(reconciled.requestId);
  assert.equal(reconciledState.status, 'SUCCEEDED');
  assert.equal(reconciledState.invitations[0]!.state, 'SENT');
  assert.equal((await messagesTo(reconciled.input.firstAdmin.email)).length, 1);

  const withoutProbe = await setup(t, {
    fault: once('PUT', /execute-actions-email$/, 'lose-response'),
    probe: NO_DELIVERY_PROBE,
  });
  const ambiguous = await withoutProbe.accept();
  await withoutProbe.drain();
  const ambiguousState = await withoutProbe.state(ambiguous.requestId);
  assert.equal(ambiguousState.status, 'ACTION_REQUIRED');
  assert.equal(ambiguousState.failureCode, 'INVITATION_DELIVERY_AMBIGUOUS');
  assert.equal(ambiguousState.invitations[0]!.state, 'AMBIGUOUS');
  // no blind resend: the only message that really arrived is the one whose response was lost
  assert.equal((await messagesTo(ambiguous.input.firstAdmin.email)).length, 1);
});

test('resend: an operator action that audits every outcome, with a race-safe cap of 3 per hour', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  await s.drain();
  const resend = () =>
    s.outbox.resend({
      requestId: accepted.requestId,
      reasonCode: 'RECIPIENT_REQUESTED',
      comment: 'the recipient said the email was not received',
      actor: OPERATOR,
      correlationId: `corr-resend-${randomUUID()}`,
    });
  // fire several rounds at once until the cap is reached — no round exceeds 3
  const outcomes: string[] = [];
  for (
    let wave = 0;
    wave < 4 && outcomes.filter((outcome) => outcome === 'OK').length < 3;
    wave += 1
  ) {
    const results = await Promise.allSettled([resend(), resend(), resend()]);
    for (const result of results) {
      outcomes.push(
        result.status === 'fulfilled' ? 'OK' : (result.reason as PlatformProvisioningError).code,
      );
    }
  }
  assert.equal(outcomes.filter((outcome) => outcome === 'OK').length, 3);
  await assert.rejects(resend(), (error: unknown) => {
    assert.equal((error as PlatformProvisioningError).code, 'INVITATION_RESEND_LIMITED');
    return true;
  });
  const generations = await s.f.owner.pfInvitation.findMany({
    where: { requestId: accepted.requestId },
    orderBy: { generation: 'asc' },
  });
  assert.equal(generations.length, 4);
  assert.deepEqual(
    generations.map((row) => row.supersededAt === null),
    [false, false, false, true],
  );
  assert.equal((await messagesTo(accepted.input.firstAdmin.email)).length, 4);
  const audits = await s.f.owner.pfActionHistory.findMany({
    where: { requestId: accepted.requestId, action: 'RESEND_INVITATION' },
  });
  assert.equal(audits.filter((row) => row.outcome === 'SUCCEEDED').length, 3);
  assert.ok(audits.some((row) => row.errorCode === 'INVITATION_RESEND_LIMITED'));
  assert.ok(audits.every((row) => row.actorSubject === OPERATOR.subject && row.reasonCode));
  const status = await s.outbox.status(accepted.requestId);
  assert.deepEqual(
    [status.generation, status.delivery, status.activation, status.resendsInLastHour],
    [4, 'SENT', 'PENDING_ACTIVATION', 3],
  );
});

test('a first-admin who completes the execute actions can log in through the tenant boundary, and the platform boundary does not accept it', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  await s.drain();
  const [link] = await invitationLinks(accepted.input.firstAdmin.email);
  const password = `Boundary-${randomUUID().slice(0, 8)}!`;
  const completed = await completeInvitation(link!, password);
  assert.ok(
    completed.totpSecret,
    `must get through the TOTP page (${completed.pages.join(' → ')})`,
  );
  assert.equal((await s.outbox.status(accepted.requestId)).activation, 'ACTIVATED');

  // A1.8 (#413): the timeline separates the First admin actor from real Keycloak user events
  // the realm setup must enable the same events the reconciler reads
  const setupScript = (await import(
    new URL('../../../scripts/keycloak-provisioning-setup.mjs', import.meta.url).href
  )) as { FIRST_ADMIN_EVENT_TYPES: readonly string[] };
  assert.deepEqual([...setupScript.FIRST_ADMIN_EVENT_TYPES], [...FIRST_ADMIN_KEYCLOAK_EVENT_TYPES]);
  const activity = new FirstAdminActivityReconciler(s.f.platform, s.keycloak, {
    scope: () => [accepted.tenantId],
  });
  const synced = await activity.runOnce();
  assert.equal((synced as { code?: string }).code, 'ACTIVATED', JSON.stringify(synced));
  const timeline = await s.f.owner.pfActionHistory.findMany({
    where: { requestId: accepted.requestId, actorKind: 'FIRST_ADMIN' },
    orderBy: { occurredAt: 'asc' },
  });
  assert.deepEqual(timeline.map((row) => row.action).sort(), [
    'FIRST_ADMIN_ACTIVATED',
    'FIRST_ADMIN_EMAIL_VERIFIED',
    'FIRST_ADMIN_PASSWORD_SET',
    'FIRST_ADMIN_TOTP_ENROLLED',
  ]);
  const invitation = await s.f.owner.pfInvitation.findFirstOrThrow({
    where: { requestId: accepted.requestId, supersededAt: null },
  });
  assert.ok(timeline.every((row) => row.actorSubject === invitation.keycloakUserId));
  assert.equal(JSON.stringify(timeline).includes(accepted.input.firstAdmin.email), false);
  assert.deepEqual(await activity.runOnce(), { kind: 'IDLE' });

  const login = await tenantLogin({
    username: accepted.input.firstAdmin.email,
    password,
    totpSecret: completed.totpSecret!,
  });
  assert.equal(login.status, 200, `tenant login failed: ${login.error}`);
  const claims = JSON.parse(Buffer.from(login.accessToken!.split('.')[1]!, 'base64url').toString());
  const identity = toVerifiedWorkspaceIdentity(claims);
  assert.deepEqual(
    [identity.tenantId, identity.userId, identity.roles.includes('admin')],
    [accepted.tenantId, firstAdminUserId(accepted.requestId), true],
  );
  // a tenant token is not a platform token: a different client/audience and it has tenant context (A1.2 rejects it)
  assert.notEqual(claims.azp, 'platform-console');
  assert.equal([claims.aud].flat().includes('dcontact-platform-api'), false);

  // cannot resend after activation
  await assert.rejects(
    s.outbox.resend({
      requestId: accepted.requestId,
      reasonCode: 'RECIPIENT_REQUESTED',
      comment: 'try resending after activation',
      actor: OPERATOR,
      correlationId: 'corr-after-activation',
    }),
    (error: unknown) =>
      (error as PlatformProvisioningError).code === 'RECOVERY_PRECONDITION_FAILED',
  );
});

test('A1.5b (#441): email clashes with an existing identity → edit the email → Retry → ACTIVE with a real Keycloak', async (t) => {
  const s = await setup(t);
  const { ProvisioningRequestEditor } = await import('./provisioning-request-editor.js');
  const { ProvisioningRecoveryService } = await import('./provisioning-recovery.js');
  const accepted = await s.accept({
    firstAdmin: { email: 'admin@demo.local', displayName: 'Taken' },
  });
  await s.drain();
  const stuck = await s.state(accepted.requestId);
  assert.deepEqual(
    [stuck.status, stuck.failureCode],
    ['ACTION_REQUIRED', 'FIRST_ADMIN_EMAIL_CONFLICT'],
  );

  const fixedEmail = `fixed-${randomUUID().slice(0, 8)}@example.test`;
  await new ProvisioningRequestEditor(s.f.platform).edit({
    requestId: accepted.requestId,
    expectedRevision: stuck.revision,
    changes: { firstAdminEmail: fixedEmail },
    reasonCode: 'CUSTOMER_CORRECTION',
    comment: 'the customer gave a new email',
    actor: OPERATOR,
    correlationId: 'corr-email-fix',
  });
  const recovery = new ProvisioningRecoveryService(
    s.f.platform,
    {
      ...s.fakes.ports,
      KEYCLOAK_ORGANIZATION: s.organizations,
      PLAN_BOOTSTRAP: s.bootstrap,
      FIRST_ADMIN: s.firstAdmin,
      INVITATION: s.outbox.port(),
    },
    { sipBaseDomain: SIP_BASE },
  );
  const preview = await recovery.preview({ requestId: accepted.requestId, action: 'RETRY_STEP' });
  assert.deepEqual([preview.allowed, preview.finding], [true, 'NOT_FOUND']);
  await recovery.execute({
    requestId: accepted.requestId,
    action: 'RETRY_STEP',
    expectedRevision: preview.revision,
    previewDigest: preview.previewDigest,
    reasonCode: 'OPERATOR_VERIFIED',
    comment: 'email corrected',
    actor: OPERATOR,
    correlationId: 'corr-email-retry',
  });
  await s.drain();
  const final = await s.state(accepted.requestId);
  assert.deepEqual([final.status, final.tenant.lifecycleStatus], ['SUCCEEDED', 'ACTIVE']);
  // the invitation goes to the new email, not to the existing identity
  assert.equal((await messagesTo(fixedEmail)).length, 1);
  assert.equal((await usersOf(accepted.tenantId)).length, 1);
});

test('#907: the provisioner can edit only the tenant Console client that has the permission, not other clients', async (t) => {
  const s = await setup(t);
  const { body: own } = await s.keycloak.admin<{ id: string }[]>(
    'GET',
    `/clients?clientId=${s.tenantConsole.clientId}`,
  );
  assert.equal(own.length, 1);
  const { body: client } = await s.keycloak.admin<Record<string, unknown>>(
    'GET',
    `/clients/${own[0]!.id}`,
  );
  const allowed = await s.keycloak.admin('PUT', `/clients/${own[0]!.id}`, {
    body: client,
    accept: [204, 403],
  });
  assert.equal(allowed.status, 204);

  const { body: others } = await keycloakAdmin<{ id: string }[]>(
    'GET',
    '/clients?clientId=dcontact-dev-readiness',
  );
  const { body: other } = await keycloakAdmin<Record<string, unknown>>(
    'GET',
    `/clients/${others[0]!.id}`,
  );
  const denied = await s.keycloak.admin('PUT', `/clients/${others[0]!.id}`, {
    body: { ...other, redirectUris: ['https://attacker.invalid/*'] },
    accept: [204, 403, 404],
  });
  assert.notEqual(denied.status, 204);
  const { body: unchanged } = await keycloakAdmin<{ redirectUris?: string[] }>(
    'GET',
    `/clients/${others[0]!.id}`,
  );
  assert.ok(!(unchanged.redirectUris ?? []).includes('https://attacker.invalid/*'));
});
