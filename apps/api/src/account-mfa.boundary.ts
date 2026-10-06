/**
 * AC2 (#595) กับ Keycloak จริง (dev stack + `pnpm infra:keycloak:extensions` + `pnpm infra:identity:account`):
 *
 * - extension `dc-account`: ไม่มี token → 401, token ของ client อื่น → 403, code ผิด → ไม่สร้าง credential,
 *   ผู้ใช้ต่าง org/platform user → ปฏิเสธ, code ถูก → สร้าง OTP credential, label ซ้ำ → 409
 * - port sync `dc_mfa_required` ของ AC1 แก้เฉพาะ attribute นั้นของ org ของ tenant
 * - browser flow: เปิดบังคับแล้ว session เดิมไม่หลุด; login ครั้งถัดไปต้องตั้ง OTP (CONFIGURE_TOTP),
 *   ผู้ใช้ที่มี OTP ถูกถาม OTP ครั้งเดียว ทั้งตอนบังคับและไม่บังคับ
 * - log ของ Keycloak ไม่มี secret/code (ตรวจเมื่อเรียก docker ได้)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import { after, before, test } from 'node:test';
import { AccountPolicyError } from './account-policy.js';
import {
  KeycloakAccountServiceClient,
  KeycloakOrganizationMfa,
} from './keycloak-account-service.js';

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
const REALM = 'dcontact';
const ISSUER = `${KEYCLOAK}/realms/${REALM}`;
const ADMIN = `${KEYCLOAK}/admin/realms/${REALM}`;
const ACCOUNT_SECRET =
  process.env.KEYCLOAK_ACCOUNT_SERVICE_SECRET ?? 'dcontact-account-service-dev-secret';
const PROVISIONER_SECRET =
  process.env.KEYCLOAK_PROVISIONER_SECRET ?? 'dcontact-provisioner-dev-secret';
const CONTAINER = process.env.KEYCLOAK_CONTAINER ?? 'd-contact-dev-keycloak-1';
const LOGIN_CLIENT = 'agent-desktop';
const REDIRECT = 'http://localhost:5173/';
const PASSWORD = `ac2-${randomBytes(6).toString('hex')}`;

type Organization = { id: string; alias: string; attributes?: Record<string, string[]> };

/** RFC 6238 ด้วย secret ดิบแบบที่ Keycloak เก็บ (UTF-8 bytes) */
function totp(secret: string, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

/** code ที่ห่างจาก code ปัจจุบันเกิน look-ahead window — ถูกปฏิเสธแน่นอน */
function wrongCode(secret: string) {
  const valid = new Set([-1, 0, 1].map((step) => totp(secret, Date.now() + step * 30_000)));
  let code: string;
  do code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  while (valid.has(code));
  return code;
}

/** Keycloak ไม่รับ code เดิมซ้ำใน window เดียวกัน — login ถัดไปของ secret เดียวกันต้องรอ window ใหม่ */
const usedWindows = new Map<string, number>();
async function freshTotp(secret: string) {
  let window = Math.floor(Date.now() / 30_000);
  if (usedWindows.get(secret) === window) {
    await new Promise((resolve) => setTimeout(resolve, (window + 1) * 30_000 - Date.now() + 250));
    window = Math.floor(Date.now() / 30_000);
  }
  usedWindows.set(secret, window);
  return totp(secret);
}

const secret = () => randomBytes(15).toString('base64url').slice(0, 20);

async function clientToken(clientId: string, clientSecret: string) {
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });
  assert.equal(response.status, 200, `token ของ ${clientId}`);
  return ((await response.json()) as { access_token: string }).access_token;
}

let adminAccessToken = '';
async function admin<T = unknown>(method: string, path: string, body?: unknown) {
  const response = await fetch(`${ADMIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminAccessToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${method} ${path} → ${response.status}`);
  const text = await response.text();
  return { body: (text ? JSON.parse(text) : undefined) as T, headers: response.headers };
}

async function extension(path: string, body: unknown, token?: string, method = 'POST') {
  const response = await fetch(`${ISSUER}/dc-account/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
  };
}

const state = {
  serviceToken: '',
  demo: undefined as unknown as Organization,
  demoTwo: undefined as unknown as Organization,
  originalMfa: undefined as string[] | undefined,
  users: [] as string[],
  secrets: [] as string[],
  codes: [] as string[],
};
const tenantOf = (organization: Organization) => organization.attributes!.tenant_id![0]!;

async function organization(alias: string) {
  const { body } = await admin<Organization[]>(
    'GET',
    // name ของ org dev ไม่เท่ากับ alias — ค้นทั้งหมดแล้วกรองด้วย alias
    '/organizations?first=0&max=100',
  );
  const summary = body.find((candidate) => candidate.alias === alias);
  assert.ok(summary, `ต้องมี org ${alias} (pnpm infra:bootstrap)`);
  // list ไม่คืน attributes — อ่านตัวเต็มทีละ org
  const { body: found } = await admin<Organization>('GET', `/organizations/${summary.id}`);
  assert.ok(found.attributes?.tenant_id?.[0], `org ${alias} ต้องมี tenant_id`);
  return found;
}

async function tenantUser(organizationModel: Organization, name: string) {
  const username = `ac2-${name}-${randomBytes(4).toString('hex')}@${organizationModel.alias}.local`;
  const { headers } = await admin('POST', '/users', {
    username,
    email: username,
    emailVerified: true,
    enabled: true,
    firstName: 'AC2',
    lastName: name,
    attributes: { tenant_id: [tenantOf(organizationModel)] },
    credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
  });
  const id = headers.get('location')!.split('/').pop()!;
  state.users.push(id);
  await admin('POST', `/organizations/${organizationModel.id}/members`, id);
  return { id, username };
}

async function otpCredentials(userId: string) {
  const { body } = await admin<Array<{ id: string; type: string; userLabel?: string }>>(
    'GET',
    `/users/${userId}/credentials`,
  );
  return body.filter((credential) => credential.type === 'otp');
}

async function enrol(userId: string, tenantId: string, label = 'โทรศัพท์') {
  const value = secret();
  const code = totp(value);
  state.secrets.push(value);
  state.codes.push(code);
  usedWindows.set(value, Math.floor(Date.now() / 30_000));
  const result = await extension(
    `users/${userId}/totp/verify-and-create`,
    { tenantId, secret: value, code, label },
    state.serviceToken,
  );
  return { ...result, secret: value };
}

const mfaPort = () =>
  new KeycloakOrganizationMfa(
    new KeycloakAccountServiceClient({ issuer: ISSUER, clientSecret: ACCOUNT_SECRET }),
  );

type LoginStep = 'username' | 'password' | 'otp';
type LoginResult =
  | { kind: 'REDIRECT'; steps: LoginStep[]; location: URL }
  | { kind: 'CONFIGURE_TOTP'; steps: LoginStep[] };

/** authorization code + PKCE ผ่านฟอร์มจริงของ Keycloak; `jar` ใช้ซ้ำได้เพื่อทดสอบ SSO session เดิม */
async function login(
  user: { username: string; otpSecret?: string },
  jar = new Map<string, string>(),
): Promise<LoginResult> {
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(`${ISSUER}/protocol/openid-connect/auth`);
  for (const [key, value] of Object.entries({
    client_id: LOGIN_CLIENT,
    redirect_uri: REDIRECT,
    response_type: 'code',
    scope: 'openid',
    state: randomBytes(8).toString('hex'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }))
    url.searchParams.set(key, value);
  const remember = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair!.indexOf('=');
      jar.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
  };
  const cookie = () => [...jar].map(([key, value]) => `${key}=${value}`).join('; ');
  const steps: LoginStep[] = [];
  let response = await fetch(url, { redirect: 'manual', headers: { cookie: cookie() } });
  for (let step = 0; step < 6; step += 1) {
    remember(response);
    const location = response.headers.get('location');
    if (location) {
      const target = new URL(location, ISSUER);
      if (target.href.startsWith(REDIRECT)) return { kind: 'REDIRECT', steps, location: target };
      response = await fetch(target, { redirect: 'manual', headers: { cookie: cookie() } });
      continue;
    }
    const html = await response.text();
    if (/name="totp"/.test(html)) return { kind: 'CONFIGURE_TOTP', steps };
    const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    assert.ok(action, `ไม่พบฟอร์ม login (${response.status})`);
    const fields: Record<string, string> = {};
    if (/name="otp"/.test(html)) {
      assert.ok(user.otpSecret, 'ถูกถาม OTP แต่ผู้ใช้ไม่มี OTP');
      fields.otp = await freshTotp(user.otpSecret);
      steps.push('otp');
    } else {
      if (/id="username"/.test(html)) {
        fields.username = user.username;
        steps.push('username');
      }
      if (/id="password"/.test(html)) {
        fields.password = PASSWORD;
        steps.push('password');
      }
    }
    response = await fetch(action, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookie() },
      body: new URLSearchParams(fields),
    });
  }
  throw new Error(`login ไม่จบภายใน 6 ขั้น (${steps.join(',')})`);
}

before(async () => {
  const response = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
      password: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  adminAccessToken = ((await response.json()) as { access_token: string }).access_token;
  state.serviceToken = await clientToken('dcontact-account-service', ACCOUNT_SECRET);
  state.demo = await organization('demo');
  state.demoTwo = await organization('demo-two');
  state.originalMfa = state.demo.attributes?.dc_mfa_required;
});

after(async () => {
  for (const id of state.users) await admin('DELETE', `/users/${id}`).catch(() => undefined);
  // คืนค่าเดิมของ org dev ด้วย port เดียวกับที่ API ใช้
  await mfaPort().setMfaRequired(
    tenantOf(state.demo),
    state.originalMfa?.includes('true') ?? false,
  );
});

test('extension รับเฉพาะ token ของ dcontact-account-service', async () => {
  const user = await tenantUser(state.demo, 'auth');
  const body = { tenantId: tenantOf(state.demo), secret: secret(), code: '123456', label: 'x' };
  const path = `users/${user.id}/totp/verify-and-create`;
  assert.equal((await extension(path, body)).status, 401);
  const provisioner = await clientToken('dcontact-provisioner', PROVISIONER_SECRET);
  assert.deepEqual(await extension(path, body, provisioner), {
    status: 403,
    body: { code: 'FORBIDDEN' },
  });
  const mfaPath = `organizations/by-tenant/${tenantOf(state.demo)}/mfa-required`;
  assert.equal((await extension(mfaPath, { required: true }, provisioner, 'PUT')).status, 403);
  assert.equal((await extension(mfaPath, { required: true }, undefined, 'PUT')).status, 401);
  assert.deepEqual(await otpCredentials(user.id), []);
});

test('code ผิดไม่สร้าง credential; ผู้ใช้ต่าง org และ platform user ถูกปฏิเสธ; code ถูกสร้าง OTP ได้ครั้งเดียวต่อ label', async () => {
  const user = await tenantUser(state.demo, 'enrol');
  const foreign = await tenantUser(state.demoTwo, 'foreign');
  const tenantId = tenantOf(state.demo);
  const value = secret();
  const path = (id: string) => `users/${id}/totp/verify-and-create`;

  const wrong = await extension(
    path(user.id),
    { tenantId, secret: value, code: wrongCode(value), label: 'โทรศัพท์' },
    state.serviceToken,
  );
  assert.deepEqual(wrong, { status: 400, body: { code: 'INVALID_OTP_CODE' } });
  assert.deepEqual(await otpCredentials(user.id), []);

  // ผู้ใช้ของ demo-two ขอผ่าน tenant ของ demo → ไม่ใช่สมาชิก
  const crossTenant = await extension(
    path(foreign.id),
    { tenantId, secret: value, code: totp(value), label: 'โทรศัพท์' },
    state.serviceToken,
  );
  assert.deepEqual(crossTenant, { status: 403, body: { code: 'USER_NOT_IN_ORGANIZATION' } });
  assert.deepEqual(await otpCredentials(foreign.id), []);

  const { body: platform } = await admin<Array<{ id: string }>>(
    'GET',
    '/users?exact=true&username=platform-operator%40platform.local',
  );
  if (platform[0]) {
    const result = await extension(
      path(platform[0].id),
      { tenantId, secret: value, code: totp(value), label: 'โทรศัพท์' },
      state.serviceToken,
    );
    assert.equal(result.status, 403);
  }
  assert.deepEqual(
    (
      await extension(
        path(user.id),
        {
          tenantId: '00000000-0000-4000-8000-000000000000',
          secret: value,
          code: totp(value),
          label: 'x',
        },
        state.serviceToken,
      )
    ).body,
    { code: 'ORGANIZATION_NOT_FOUND' },
  );
  for (const invalid of [
    { tenantId, secret: 'short', code: totp(value), label: 'x' },
    { tenantId, secret: value, code: '12', label: 'x' },
    { tenantId, secret: value, code: totp(value), label: '' },
    { tenantId, secret: value, code: totp(value), label: 'x'.repeat(65) },
  ]) {
    assert.equal((await extension(path(user.id), invalid, state.serviceToken)).status, 400);
  }

  const created = await enrol(user.id, tenantId);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const [credential] = await otpCredentials(user.id);
  assert.equal(credential?.id, created.body.credentialId);
  assert.equal(credential?.userLabel, 'โทรศัพท์');

  const duplicate = await enrol(user.id, tenantId);
  assert.deepEqual(duplicate.body, { code: 'LABEL_IN_USE' });
  assert.equal((await otpCredentials(user.id)).length, 1);
});

test('port sync ของ AC1 แก้เฉพาะ dc_mfa_required ของ org ของ tenant', async () => {
  const port = mfaPort();
  const before = await organization('demo');
  const otherBefore = await organization('demo-two');
  await port.setMfaRequired(tenantOf(state.demo), true);
  await port.setMfaRequired(tenantOf(state.demo), true);
  const enabled = await organization('demo');
  assert.deepEqual(enabled.attributes, { ...before.attributes, dc_mfa_required: ['true'] });
  assert.deepEqual((await organization('demo-two')).attributes, otherBefore.attributes);

  await port.setMfaRequired(tenantOf(state.demo), false);
  assert.deepEqual((await organization('demo')).attributes?.dc_mfa_required, ['false']);
  await assert.rejects(
    port.setMfaRequired('00000000-0000-4000-8000-000000000000', true),
    (error: unknown) =>
      error instanceof AccountPolicyError && error.code === 'IDENTITY_UNAVAILABLE',
  );
});

test('บังคับ 2FA: session เดิมไม่หลุด; login ครั้งถัดไปต้องตั้ง OTP; มี OTP แล้วถาม OTP ครั้งเดียว', async () => {
  const port = mfaPort();
  const tenantId = tenantOf(state.demo);
  await port.setMfaRequired(tenantId, false);
  const withoutOtp = await tenantUser(state.demo, 'nootp');
  const withOtp = await tenantUser(state.demo, 'otp');
  const enrolled = await enrol(withOtp.id, tenantId);
  assert.equal(enrolled.status, 201);

  // ยังไม่บังคับ: ไม่มี OTP = ไม่ถาม
  const jar = new Map<string, string>();
  const first = await login(withoutOtp, jar);
  assert.equal(first.kind, 'REDIRECT');
  assert.ok(!first.steps.includes('otp'));

  await port.setMfaRequired(tenantId, true);

  // session ที่ใช้อยู่ไม่ถูกตัด: cookie เดิมได้ code ทันทีโดยไม่ผ่านฟอร์ม
  const restored = await login(withoutOtp, jar);
  assert.equal(restored.kind, 'REDIRECT');
  assert.deepEqual(restored.steps, []);
  assert.ok(restored.kind === 'REDIRECT' && restored.location.searchParams.get('code'));

  // login ครั้งถัดไป (ไม่มี session) ต้องตั้ง OTP ก่อน
  const next = await login(withoutOtp);
  assert.equal(next.kind, 'CONFIGURE_TOTP');

  // มี OTP แล้ว: ถาม OTP ครั้งเดียว (subflow 2FA เดิมถูกข้ามด้วย condition แบบ negate)
  const required = await login({ ...withOtp, otpSecret: enrolled.secret });
  assert.equal(required.kind, 'REDIRECT');
  assert.equal(required.steps.filter((step) => step === 'otp').length, 1);

  // ปิดบังคับ: ผู้ใช้ที่มี OTP ยังถูกถามครั้งเดียวตาม flow เดิม; ไม่มี OTP = ไม่ถาม
  await port.setMfaRequired(tenantId, false);
  const optional = await login({ ...withOtp, otpSecret: enrolled.secret });
  assert.equal(optional.kind, 'REDIRECT');
  assert.equal(optional.steps.filter((step) => step === 'otp').length, 1);
  const plain = await login(withoutOtp);
  assert.equal(plain.kind, 'REDIRECT');
  assert.ok(!plain.steps.includes('otp'));
});

test('log ของ Keycloak ไม่มี OTP secret หรือ code ที่ส่งให้ extension', (t) => {
  const logs = spawnSync('docker', ['logs', '--since', '30m', CONTAINER], { encoding: 'utf8' });
  if (logs.status !== 0) {
    t.skip(`อ่าน log ของ ${CONTAINER} ไม่ได้`);
    return;
  }
  const output = `${logs.stdout}${logs.stderr}`;
  assert.ok(state.secrets.length > 0);
  for (const value of [...state.secrets, ...state.codes]) {
    assert.ok(!output.includes(value), 'พบ secret/code ใน log ของ Keycloak');
  }
});
