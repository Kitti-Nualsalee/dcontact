/**
 * A1.4 (#409) real boundary: Keycloak 26 + mailpit + Postgres จริง — ไม่อยู่ใน fast gate
 *
 * ครอบ acceptance ของ #409: create, verified adoption, duplicate/replay, conflict, timeout,
 * lost response, invitation 72 ชั่วโมง, resend cap แบบ race-safe และ first-admin ที่ทำ execute
 * actions ครบแล้ว login ผ่าน tenant boundary ได้ (และ platform boundary ไม่รับ)
 *
 * ต้องมี: `pnpm infra:up` และ `pnpm infra:identity:link && pnpm infra:identity:platform`
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
  firstAdminUserId,
  KeycloakOrganizationPort,
  PROVISIONING_REQUEST_ATTRIBUTE,
} from './keycloak-provisioning-ports.js';
import {
  actionTokenClaims,
  cleanupKeycloak,
  completeInvitation,
  invitationLinks,
  keycloakAdmin,
  MAILPIT_URL,
  messagesTo,
  provisionerClient,
  tenantLogin,
} from './keycloak-test-support.js';
import { createPlatformFixture, OPERATOR, SIP_BASE } from './platform-fixture.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { ProvisioningSagaWorker } from './provisioning-saga.js';

type Fault = (url: string, method: string) => 'lose-response' | 'hang' | undefined;

/** fetch ที่ส่งคำขอจริงแล้วทำเหมือน response หาย หรือค้างจน timeout — จำลอง fault ที่ Keycloak ทำไปแล้ว */
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

/** fault ครั้งเดียวต่อ (method, path ที่ match) */
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
  const firstAdmin = new FirstAdminPort(keycloak, f.provisioner, organizations);
  const outbox = new InvitationOutbox(f.platform, keycloak, firstAdmin, {
    probe: options.probe ?? mailpitDeliveryProbe(MAILPIT_URL),
  });
  const fakes = createFakeProvisioningPorts();
  const ports = {
    ...fakes.ports,
    KEYCLOAK_ORGANIZATION: organizations,
    FIRST_ADMIN: firstAdmin,
    INVITATION: outbox.port(),
  };
  const worker = new ProvisioningSagaWorker(f.platform, ports, {
    workerId: `boundary-${randomUUID().slice(0, 8)}`,
    sipBaseDomain: SIP_BASE,
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
  /** เดิน saga จนนิ่ง (retry ที่ backoff 1ms จะถูกหยิบทันทีรอบถัดไป) */
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
  return { f, keycloak, organizations, firstAdmin, outbox, fakes, worker, accept, drain, state };
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

test('create: Organization + first-admin + invitation 72 ชั่วโมง แล้ว tenant ACTIVE', async (t) => {
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
  // D-Contact ไม่สร้าง credential ใด ๆ ให้ first-admin
  const { body: credentials } = await keycloakAdmin<unknown[]>(
    'GET',
    `/users/${user!.id}/credentials`,
  );
  assert.deepEqual(credentials, []);

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

  // evidence ไม่มี raw email
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

test('replay/duplicate: execute ซ้ำระหว่าง PROVISIONING ไม่สร้างซ้ำ แล้ว saga adopt ทั้งหมด', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const request = await s.state(accepted.requestId);
  const { provisioningStepContext } = await import('./provisioning-saga.js');
  const signal = new AbortController().signal;
  // จำลอง worker หลายตัว/crash ที่ execute ขั้นเดียวกันซ้ำก่อนมีใครบันทึก receipt
  for (let round = 0; round < 2; round += 1) {
    await s.organizations.execute(
      provisioningStepContext(request, 'KEYCLOAK_ORGANIZATION', 1),
      signal,
    );
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
  ]);
  // หลัง ACTIVE แล้ว provisioner แตะแถว users ของ tenant นี้ไม่ได้อีก (#388 decision)
  assert.equal(await s.f.provisioner.user.count({ where: { tenantId: accepted.tenantId } }), 0);
});

test('lost response ของการสร้าง Organization และ user: attempt ถัดไป adopt ไม่สร้างซ้ำ', async (t) => {
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
  // Organization: find ของ attempt ถัดไปพบ org ที่ correlation ตรง = verified adoption
  // user: พบ identity ของเราที่ยังไม่ครบ (ไม่มี role/membership) จึง execute เติมส่วนที่ขาดโดยไม่สร้างใหม่
  const adopted = await s.f.owner.pfActionHistory.findMany({
    where: { requestId: accepted.requestId, reasonCode: 'VERIFIED_ADOPTION' },
  });
  assert.deepEqual(
    adopted.map((row) => row.stepKey),
    ['KEYCLOAK_ORGANIZATION'],
  );
});

test('timeout ระหว่างสร้าง user: abort เป็น ambiguous แล้วรอบหน้า adopt', async (t) => {
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

test('conflict: org ชื่อเดียวกันของคนอื่นไม่ถูกยึด และ email ของ identity อื่นได้ code คงที่ไม่เผย tenant', async (t) => {
  const s = await setup(t);
  // org ต่างเจ้าของที่ใช้ชื่อ (slug) เดียวกัน
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

  // email ที่เป็นของ tenant user เดิมใน dev realm
  const emailTaken = await s.accept({
    firstAdmin: { email: 'admin@demo.local', displayName: 'Taken' },
  });
  await s.drain();

  const orgConflict = await s.state(slugTaken.requestId);
  assert.equal(orgConflict.status, 'ACTION_REQUIRED');
  assert.equal(orgConflict.failureCode, 'KEYCLOAK_ORGANIZATION_CONFLICT');
  const [foreign] = await organizationsOf(foreignTenant);
  assert.ok(foreign, 'org ของคนอื่นต้องยังอยู่');
  assert.equal(foreign.attributes[PROVISIONING_REQUEST_ATTRIBUTE], undefined);

  const emailConflict = await s.state(emailTaken.requestId);
  assert.equal(emailConflict.status, 'ACTION_REQUIRED');
  assert.equal(emailConflict.failureCode, 'FIRST_ADMIN_EMAIL_CONFLICT');
  const history = JSON.stringify(
    await s.f.owner.pfActionHistory.findMany({ where: { requestId: emailTaken.requestId } }),
  );
  assert.equal(history.includes('demo'), false);
  // identity เดิมไม่ถูกแตะ
  const { body: existing } = await keycloakAdmin<{ attributes: Record<string, string[]> }[]>(
    'GET',
    `/users?${new URLSearchParams({ username: 'admin@demo.local', exact: 'true', briefRepresentation: 'false' })}`,
  );
  assert.equal(existing[0]!.attributes[PROVISIONING_REQUEST_ATTRIBUTE], undefined);
  // หยุดตั้งแต่ find (MISMATCH) จึงไม่มีแถว users ถูกสร้าง
  assert.equal(
    await s.f.owner.user.count({ where: { id: firstAdminUserId(emailTaken.requestId) } }),
    0,
  );
});

test('invitation lost response: reconcile ด้วยหลักฐานใน email sink ไม่ส่งซ้ำ; ไม่มีหลักฐาน = ACTION_REQUIRED', async (t) => {
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
  // ห้าม blind resend: ฉบับเดียวที่ถึงจริงคือฉบับที่ response หาย
  assert.equal((await messagesTo(ambiguous.input.firstAdmin.email)).length, 1);
});

test('resend: operator action ที่ audit ทุกผล และ cap 3 ครั้ง/ชั่วโมงแบบ race-safe', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  await s.drain();
  const resend = () =>
    s.outbox.resend({
      requestId: accepted.requestId,
      reasonCode: 'RECIPIENT_REQUESTED',
      comment: 'ผู้รับแจ้งว่าไม่ได้รับอีเมล',
      actor: OPERATOR,
      correlationId: `corr-resend-${randomUUID()}`,
    });
  // ยิงพร้อมกันหลายรอบจนครบ cap — ไม่มีรอบไหนเกิน 3
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

test('first-admin ทำ execute actions ครบแล้ว login ผ่าน tenant boundary ได้ และ platform boundary ไม่รับ', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  await s.drain();
  const [link] = await invitationLinks(accepted.input.firstAdmin.email);
  const password = `Boundary-${randomUUID().slice(0, 8)}!`;
  const completed = await completeInvitation(link!, password);
  assert.ok(completed.totpSecret, `ต้องผ่านหน้า TOTP (${completed.pages.join(' → ')})`);
  assert.equal((await s.outbox.status(accepted.requestId)).activation, 'ACTIVATED');

  const login = await tenantLogin({
    username: accepted.input.firstAdmin.email,
    password,
    totpSecret: completed.totpSecret!,
  });
  assert.equal(login.status, 200, `tenant login ล้มเหลว: ${login.error}`);
  const claims = JSON.parse(Buffer.from(login.accessToken!.split('.')[1]!, 'base64url').toString());
  const identity = toVerifiedWorkspaceIdentity(claims);
  assert.deepEqual(
    [identity.tenantId, identity.userId, identity.roles.includes('admin')],
    [accepted.tenantId, firstAdminUserId(accepted.requestId), true],
  );
  // token ของ tenant ไม่ใช่ platform token: คนละ client/audience และมี tenant context (A1.2 ปฏิเสธ)
  assert.notEqual(claims.azp, 'platform-console');
  assert.equal([claims.aud].flat().includes('dcontact-platform-api'), false);

  // activate แล้ว resend ไม่ได้
  await assert.rejects(
    s.outbox.resend({
      requestId: accepted.requestId,
      reasonCode: 'RECIPIENT_REQUESTED',
      comment: 'ลองส่งซ้ำหลัง activate',
      actor: OPERATOR,
      correlationId: 'corr-after-activation',
    }),
    (error: unknown) =>
      (error as PlatformProvisioningError).code === 'RECOVERY_PRECONDITION_FAILED',
  );
});
