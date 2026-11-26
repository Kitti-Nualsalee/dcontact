/**
 * Real-boundary test of A1.2 (#407): hits a real Keycloak (`pnpm infra:up`) — not in the fast gate
 *
 * Proves that the identity plane built by `scripts/keycloak-platform-setup.mjs` issues tokens that the
 * Platform API boundary accepts/rejects exactly as the unit test token matrix does, and that the tenant plane and
 * the platform plane do not cross in either direction
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

// the helper is an ESM .mjs shared with the CLI; this package is CJS so it is imported dynamically
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
  assert.ok(representation, `client ${clientId} not found`);
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
    // run twice: setup must be idempotent on a realm that is already set up
    await setup.setupKeycloakPlatform();
    const result = await setup.setupKeycloakPlatform();
    assert.equal(result.users.length, 2);
    users = setup.PLATFORM_DEV_USERS;
    login = (await loginModule).platformConsoleLogin;
  });

  test('client config: platform-console is public+PKCE with no direct grant/full scope and is bound to the MFA flow', async () => {
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

  test('browser flow reuses the cookie session; a new login still requires password and OTP', async () => {
    const token = await adminToken();
    const setup = await setupModule;
    const executions = async (alias: string) => {
      const response = await fetch(
        `${keycloakBaseUrl}/admin/realms/dcontact/authentication/flows/${alias}/executions`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      assert.equal(response.ok, true);
      return (await response.json()) as {
        providerId?: string;
        displayName?: string;
        requirement: string;
      }[];
    };
    const root = await executions(setup.PLATFORM_BROWSER_FLOW);
    assert.equal(
      root.find((step) => step.providerId === 'auth-cookie')?.requirement,
      'ALTERNATIVE',
    );
    assert.equal(
      root.find((step) => step.displayName === setup.PLATFORM_BROWSER_FORMS_FLOW)?.requirement,
      'ALTERNATIVE',
    );
    const forms = await executions(setup.PLATFORM_BROWSER_FORMS_FLOW);
    for (const provider of ['auth-username-password-form', 'auth-otp-form']) {
      assert.equal(forms.find((step) => step.providerId === provider)?.requirement, 'REQUIRED');
    }
  });

  test('operator: password + OTP → token passes the boundary and gets read + mutate', async () => {
    const operator = users.find((user) => user.role === 'platform_operator')!;
    // delay the OTP across a second: amr must still have pwd (regression of reference maxAge=0)
    const result = await login({ ...operator, otpDelayMs: 2_100, verifySsoRestoration: true });
    assert.equal(result.status, 'TOKEN');
    tokens.operator = (result as { accessToken: string }).accessToken;
    const identity = toVerifiedPlatformIdentity(await verifier.verifyAccessToken(tokens.operator));
    assert.deepEqual(identity.roles, ['platform_operator']);
    assert.deepEqual(identity.capabilities, ['CONTROL_PLANE_READ', 'PROVISIONING_MUTATE']);
    const restoredToken = (result as { restoredAccessToken?: string }).restoredAccessToken;
    assert.ok(restoredToken);
    const restored = toVerifiedPlatformIdentity(await verifier.verifyAccessToken(restoredToken));
    assert.equal(restored.subject, identity.subject);
    assert.deepEqual(restored.capabilities, identity.capabilities);
  });

  test('auditor: password + OTP → token passes the boundary but is read-only', async () => {
    const auditor = users.find((user) => user.role === 'platform_auditor')!;
    const result = await login(auditor);
    assert.equal(result.status, 'TOKEN');
    tokens.auditor = (result as { accessToken: string }).accessToken;
    const identity = toVerifiedPlatformIdentity(await verifier.verifyAccessToken(tokens.auditor));
    assert.deepEqual(identity.roles, ['platform_auditor']);
    assert.deepEqual(identity.capabilities, ['CONTROL_PLANE_READ']);
  });

  test('a real token has no tenant claim, realm role or PII', () => {
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
        assert.equal(claims[forbidden], undefined, `token has ${forbidden}`);
      }
      assert.equal(claims.aud, 'dcontact-platform-api');
    }
  });

  test('a platform token cannot be used with the tenant API (audience + identity mapping)', async () => {
    for (const token of [tokens.operator, tokens.auditor]) {
      await assert.rejects(tenantVerifier.verifyAccessToken(token));
      assert.throws(() => toVerifiedWorkspaceIdentity(claimsOf(token) as never));
    }
  });

  test('without OTP it stops at the OTP page; direct grant is disabled', async () => {
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

  test('a tenant user logging in through platform-console gets no token, and a tenant token cannot be used with the Platform API', async () => {
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
    assert.equal(tenantToken.ok, true, 'a tenant token from the dev realm is required first');
    const { access_token: accessToken } = (await tenantToken.json()) as { access_token: string };
    await assert.rejects(verifier.verifyAccessToken(accessToken));
    assert.throws(() => toVerifiedPlatformIdentity(claimsOf(accessToken)));
  });
});
