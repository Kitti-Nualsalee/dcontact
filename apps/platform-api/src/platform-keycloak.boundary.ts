/**
 * Real-boundary test ของ A1.2 (#407): ยิง Keycloak จริง (`pnpm infra:up`) — ไม่อยู่ใน fast gate
 *
 * พิสูจน์ว่า identity plane ที่ `scripts/keycloak-platform-setup.mjs` สร้าง ออก token ที่ boundary
 * ของ Platform API ยอมรับ/ปฏิเสธตรงกับ token matrix ของ unit test และ tenant plane กับ platform plane
 * ไม่ข้ามกันทั้งสองทิศ
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';
import {
  KeycloakAccessTokenVerifier,
  toVerifiedWorkspaceIdentity,
} from '@d-contact/workspace-session';
import { toVerifiedPlatformIdentity } from './platform-identity.js';
import { JosePlatformAccessTokenVerifier } from './platform-verifier.js';

const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const issuer = `${keycloakBaseUrl}/realms/dcontact`;
const jwksUri = `${issuer}/protocol/openid-connect/certs`;

// helper เป็น ESM .mjs ที่ใช้ร่วมกับ CLI; package นี้เป็น CJS จึง import แบบ dynamic
const setupModule = import('../../../scripts/keycloak-platform-setup.mjs');
const loginModule = import('../../../scripts/keycloak-platform-login.mjs');
type DevUser = Awaited<typeof setupModule>['PLATFORM_DEV_USERS'][number];

async function adminToken() {
  const response = await fetch(`${keycloakBaseUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
      password: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin',
    }),
  });
  return ((await response.json()) as { access_token: string }).access_token;
}

async function client(token: string, clientId: string) {
  const response = await fetch(
    `${keycloakBaseUrl}/admin/realms/dcontact/clients?clientId=${encodeURIComponent(clientId)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const [representation] = (await response.json()) as Record<string, unknown>[];
  assert.ok(representation, `ไม่พบ client ${clientId}`);
  return representation;
}

function claimsOf(accessToken: string) {
  return JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as Record<
    string,
    unknown
  >;
}

describe('Keycloak platform identity plane (real boundary)', { concurrency: false }, () => {
  const verifier = JosePlatformAccessTokenVerifier.remote({ issuer, jwksUri });
  const tenantVerifier = new KeycloakAccessTokenVerifier({
    issuer,
    jwksUri,
    audience: 'dcontact-api',
  });
  let users: readonly DevUser[];
  const tokens: Record<string, string> = {};
  let login: Awaited<typeof loginModule>['platformConsoleLogin'];

  before(async () => {
    const setup = await setupModule;
    // รันสองรอบ: setup ต้อง idempotent บน realm ที่ตั้งไว้แล้ว
    await setup.setupKeycloakPlatform();
    const result = await setup.setupKeycloakPlatform();
    assert.equal(result.users.length, 2);
    users = setup.PLATFORM_DEV_USERS;
    login = (await loginModule).platformConsoleLogin;
  });

  test('client config: platform-console เป็น public+PKCE ไม่มี direct grant/full scope และผูก MFA flow', async () => {
    const token = await adminToken();
    const consoleClient = await client(token, 'platform-console');
    assert.equal(consoleClient.publicClient, true);
    assert.equal(consoleClient.directAccessGrantsEnabled, false);
    assert.equal(consoleClient.implicitFlowEnabled, false);
    assert.equal(consoleClient.serviceAccountsEnabled, false);
    assert.equal(consoleClient.fullScopeAllowed, false);
    assert.equal(
      (consoleClient.attributes as Record<string, string>)['pkce.code.challenge.method'],
      'S256',
    );
    assert.ok((consoleClient.authenticationFlowBindingOverrides as Record<string, string>).browser);
    assert.deepEqual((consoleClient.defaultClientScopes as string[]).sort(), [
      'acr',
      'basic',
      'roles',
    ]);
    assert.deepEqual(consoleClient.optionalClientScopes, []);
    const apiClient = await client(token, 'dcontact-platform-api');
    assert.equal(apiClient.bearerOnly, true);
  });

  test('operator: password + OTP → token ผ่าน boundary และได้ read + mutate', async () => {
    const operator = users.find((user) => user.role === 'platform_operator')!;
    // หน่วง OTP ข้ามวินาที: amr ต้องยังมี pwd (regression ของ reference maxAge=0)
    const result = await login({ ...operator, otpDelayMs: 2_100 });
    assert.equal(result.status, 'TOKEN');
    tokens.operator = (result as { accessToken: string }).accessToken;
    const identity = toVerifiedPlatformIdentity(await verifier.verifyAccessToken(tokens.operator));
    assert.deepEqual(identity.roles, ['platform_operator']);
    assert.deepEqual(identity.capabilities, ['CONTROL_PLANE_READ', 'PROVISIONING_MUTATE']);
  });

  test('auditor: password + OTP → token ผ่าน boundary แต่ read-only', async () => {
    const auditor = users.find((user) => user.role === 'platform_auditor')!;
    const result = await login(auditor);
    assert.equal(result.status, 'TOKEN');
    tokens.auditor = (result as { accessToken: string }).accessToken;
    const identity = toVerifiedPlatformIdentity(await verifier.verifyAccessToken(tokens.auditor));
    assert.deepEqual(identity.roles, ['platform_auditor']);
    assert.deepEqual(identity.capabilities, ['CONTROL_PLANE_READ']);
  });

  test('token จริงไม่มี tenant claim, realm role หรือ PII', () => {
    for (const token of [tokens.operator, tokens.auditor]) {
      const claims = claimsOf(token);
      for (const forbidden of [
        'tenant_id',
        'tenant_slug',
        'organization',
        'dc_user_id',
        'realm_access',
        'email',
        'preferred_username',
        'name',
      ]) {
        assert.equal(claims[forbidden], undefined, `token มี ${forbidden}`);
      }
      assert.equal(claims.aud, 'dcontact-platform-api');
    }
  });

  test('platform token ใช้กับ tenant API ไม่ได้ (audience + identity mapping)', async () => {
    for (const token of [tokens.operator, tokens.auditor]) {
      await assert.rejects(tenantVerifier.verifyAccessToken(token));
      assert.throws(() => toVerifiedWorkspaceIdentity(claimsOf(token) as never));
    }
  });

  test('ไม่มี OTP หยุดที่หน้า OTP; direct grant ถูกปิด', async () => {
    const operator = users.find((user) => user.role === 'platform_operator')!;
    assert.deepEqual(await login({ ...operator, skipOtp: true }), {
      status: 'STOPPED',
      stage: 'OTP_REQUIRED',
    });
    const direct = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'platform-console',
        username: operator.username,
        password: operator.password,
      }),
    });
    assert.equal(direct.ok, false);
    assert.equal(((await direct.json()) as { error: string }).error, 'unauthorized_client');
  });

  test('tenant user login ผ่าน platform-console ไม่ได้ token และ tenant token ใช้กับ Platform API ไม่ได้', async () => {
    const tenantLogin = await login({ username: 'admin@demo.local', password: 'admin1234' });
    assert.equal(tenantLogin.status, 'STOPPED');

    const tenantToken = await fetch(`${issuer}/protocol/openid-connect/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'dcontact-dev-readiness',
        username: 'admin@demo.local',
        password: 'admin1234',
        scope: 'openid organization',
      }),
    });
    assert.equal(tenantToken.ok, true, 'ต้องได้ tenant token ของ dev realm ก่อน');
    const { access_token: accessToken } = (await tenantToken.json()) as { access_token: string };
    await assert.rejects(verifier.verifyAccessToken(accessToken));
    assert.throws(() => toVerifiedPlatformIdentity(claimsOf(accessToken)));
  });
});
