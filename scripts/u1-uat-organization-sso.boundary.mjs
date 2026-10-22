/** Disposable HTTP → Keycloak ของ UAT จริงผ่าน HTTPS ที่ trust certificate ของ sandbox */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { createKeycloakAdmin } from './u1-uat-keycloak-users.mjs';
import {
  planOrganizationSso,
  applyOrganizationSso,
  rollbackOrganizationSso,
} from './u1-uat-organization-sso.mjs';
const require = createRequire(new URL('../apps/console/package.json', import.meta.url));
const { request } = require('@playwright/test');
const ORIGIN = 'https://127.0.0.1:15442';
const ISSUER = `${ORIGIN}/auth/realms/dcontact`;
const CLIENT = 'dcontact-uat-console';
const PASSWORD = 'SandboxOnly733!';
const SECRET = '12345678901234567890'; // ข้อมูลทดสอบใหม่ ไม่ใช่ secret ของ UAT
const checks = [];
function otp() {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const mac = createHmac('sha1', SECRET).update(counter).digest();
  return String((mac.readUInt32BE(mac.at(-1) & 15) & 0x7fffffff) % 1000000).padStart(6, '0');
}
function authUrl(scope = 'organization:dcontact-uat') {
  const verifier = randomBytes(32).toString('base64url');
  const url = new URL(`${ISSUER}/protocol/openid-connect/auth`);
  for (const [key, value] of Object.entries({
    client_id: CLIENT,
    redirect_uri: `${ORIGIN}/callback`,
    response_type: 'code',
    scope: `openid ${scope}`,
    state: randomBytes(16).toString('hex'),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
  }))
    url.searchParams.set(key, value);
  return { url, verifier };
}
function outcome(response) {
  const url = new URL(response.url());
  return { code: url.searchParams.get('code'), error: url.searchParams.get('error') };
}
async function sso(context, scope) {
  const { url } = authUrl(scope);
  url.searchParams.set('prompt', 'none');
  return outcome(await context.get(url.href));
}
async function login(context, username, otpMode = 'valid') {
  const { url } = authUrl();
  let response = await context.get(url.href);
  let passwordPosted = false,
    otpPosted = false;
  for (let step = 0; step < 5 && !outcome(response).code; step++) {
    const page = await response.text();
    const form = /<form[^>]+action="([^"]+)"/.exec(page);
    assert.ok(form, 'ยังไม่มี code ต้องมี credential challenge');
    const action = form[1].replaceAll('&amp;', '&');
    const isOtp = /name="otp"/.test(page);
    let fields;
    if (isOtp) {
      const value = otp();
      fields = {
        otp:
          otpMode === 'missing'
            ? ''
            : otpMode === 'wrong'
              ? String((Number(value) + 1) % 1000000).padStart(6, '0')
              : value,
      };
      otpPosted = true;
    } else {
      fields = { username, password: PASSWORD, credentialId: '' };
      passwordPosted = /name="password"/.test(page) || passwordPosted;
    }
    response = await context.post(action, { form: fields });
    if (isOtp && otpMode !== 'valid') break;
  }
  return { ...outcome(response), passwordPosted, otpPosted };
}

test(
  'UAT SSO: legacy RED → Organization patch GREEN พร้อม password/OTP และ rollback จริง',
  { timeout: 120000 },
  async () => {
    assert.equal(process.env.UAT_SSO_SANDBOX_CONFIRM, 'owned-disposable');
    assert.ok(process.env.NODE_EXTRA_CA_CERTS, 'ต้อง trust certificate ของ HTTPS sandbox');
    const admin = createKeycloakAdmin({
      baseUrl: `${ORIGIN}/auth`,
      username: 'admin',
      password: 'core733-local-only',
    });
    let ready = false;
    for (let attempt = 0; attempt < 45; attempt++) {
      try {
        await admin.login();
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    assert.ok(ready, 'Keycloak sandbox ต้องพร้อม');
    const previous = await admin.call('/admin/realms/dcontact', { allow404: true });
    if (previous) await admin.call('/admin/realms/dcontact', { method: 'DELETE' });
    const template = JSON.parse(
      readFileSync(new URL('../infra/keycloak/realm-dcontact.uat.json', import.meta.url)),
    );
    const fields = [
      'realm',
      'enabled',
      'sslRequired',
      'ssoSessionIdleTimeout',
      'ssoSessionMaxLifespan',
      'browserFlow',
      'authenticationFlows',
      'requiredActions',
      'organizationsEnabled',
      'otpPolicyType',
      'otpPolicyAlgorithm',
      'otpPolicyDigits',
      'otpPolicyPeriod',
      'loginTheme',
    ];
    const realm = Object.fromEntries(fields.map((key) => [key, template[key]]));
    // Fixture ของ realm เดิมบน VM ก่อน patch; fresh template ต้องมี Organization ตามสเปก
    assert.equal(
      realm.authenticationFlows[0].authenticationExecutions.filter(
        (row) => row.authenticator === 'organization',
      ).length,
      1,
    );
    realm.authenticationFlows[0].authenticationExecutions =
      realm.authenticationFlows[0].authenticationExecutions.filter(
        (row) => row.authenticator !== 'organization',
      );
    await admin.call('/admin/realms', { method: 'POST', body: realm });
    const base = '/admin/realms/dcontact';
    const contexts = [];
    try {
      await admin.call(`${base}/clients`, {
        method: 'POST',
        body: {
          clientId: CLIENT,
          enabled: true,
          publicClient: true,
          standardFlowEnabled: true,
          redirectUris: [`${ORIGIN}/callback`],
          webOrigins: [ORIGIN],
          optionalClientScopes: ['organization'],
          attributes: { 'pkce.code.challenge.method': 'S256' },
        },
      });
      for (const alias of ['dcontact-uat', 'foreign'])
        await admin.call(`${base}/organizations`, {
          method: 'POST',
          body: { name: alias, alias, enabled: true },
        });
      const org = (await admin.call(`${base}/organizations`)).find(
        (row) => row.alias === 'dcontact-uat',
      );
      for (const username of ['legacy', 'missing', 'wrong', 'fresh']) {
        await admin.call(`${base}/users`, {
          method: 'POST',
          body: {
            username,
            enabled: true,
            firstName: 'Sandbox',
            lastName: 'Tester',
            email: `${username}@sandbox.invalid`,
            emailVerified: true,
            credentials: [
              { type: 'password', value: PASSWORD, temporary: false },
              {
                type: 'otp',
                secretData: JSON.stringify({ value: SECRET }),
                credentialData: JSON.stringify({
                  subType: 'totp',
                  digits: 6,
                  period: 30,
                  algorithm: 'HmacSHA1',
                }),
              },
            ],
          },
        });
        const [user] = await admin.call(`${base}/users?username=${username}&exact=true`);
        await admin.call(`${base}/users/${user.id}`, {
          method: 'PUT',
          body: { requiredActions: [] },
        });
        await admin.call(`${base}/organizations/${org.id}/members`, {
          method: 'POST',
          body: user.id,
        });
      }
      const context = async () => {
        const value = await request.newContext();
        contexts.push(value);
        return value;
      };
      const oldSession = await context();
      const first = await login(oldSession, 'legacy');
      assert.ok(first.code && first.passwordPosted && first.otpPosted);
      assert.equal((await sso(oldSession)).error, 'login_required');
      checks.push('legacy Organization SSO fails with valid identity cookie');
      const plan = await planOrganizationSso(admin);
      const record = await applyOrganizationSso(admin, { expectedDigest: plan.digest });
      assert.ok((await sso(oldSession)).code);
      checks.push('Organization SSO succeeds after guarded patch');
      assert.equal(
        (await applyOrganizationSso(admin, { expectedDigest: record.afterDigest })).status,
        'NOOP',
      );
      checks.push('repeat is no-op');
      for (const mode of ['missing', 'wrong']) {
        const result = await login(await context(), mode, mode);
        assert.ok(result.passwordPosted && result.otpPosted && !result.code);
        checks.push(`${mode} OTP cannot issue authorization code`);
      }
      const fresh = await login(await context(), 'fresh');
      assert.ok(fresh.code && fresh.passwordPosted && fresh.otpPosted);
      checks.push('fresh login still requires password and OTP');
      assert.equal((await sso(await context())).error, 'login_required');
      checks.push('no-cookie prompt=none requires login');
      assert.ok(!(await sso(oldSession, 'organization:foreign')).code);
      checks.push('foreign Organization cannot issue code');
      assert.equal((await rollbackOrganizationSso(admin, record)).status, 'ROLLED_BACK');
      assert.equal((await sso(oldSession)).error, 'login_required');
      checks.push('rollback restores legacy behavior');
    } finally {
      for (const context of contexts) await context.dispose();
      await admin.call(base, { method: 'DELETE' });
    }
    mkdirSync('artifacts/uat-sso', { recursive: true });
    writeFileSync(
      'artifacts/uat-sso/boundary.json',
      `${JSON.stringify({ result: 'PASS', sourceSha: process.env.SOURCE_SHA ?? 'local', keycloakImage: 'sha256:d61db55cf4ce68439f98238a44d3b6dce557898c9ec9a7719823580e066046d9', tls: 'trusted-loopback-certificate', checks, vmUat: 'NOT_RUN' }, null, 2)}\n`,
    );
  },
);
