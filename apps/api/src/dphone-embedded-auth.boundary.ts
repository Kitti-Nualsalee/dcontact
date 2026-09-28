/**
 * E1.13 (#487) กับ Keycloak จริง (ต้องรัน `pnpm infra:identity:dphone-embedded` ก่อน):
 * client `dphone-embedded` — exact redirect, ห้าม implicit/direct grant, PKCE S256 บังคับ, state กลับมาตรง,
 * token 5 นาทีที่ gateway ของ API ยอมรับ, refresh rotation และ reuse detection (ระดับ realm, #487)
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  KeycloakAccessTokenVerifier,
  toVerifiedWorkspaceIdentity,
} from '@d-contact/workspace-session';

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
const REALM = 'dcontact';
const ISSUER = `${KEYCLOAK}/realms/${REALM}`;
const CLIENT = 'dphone-embedded';
const ORIGIN = (process.env.DPHONE_EMBED_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
const REDIRECT = `${ORIGIN}/dphone/auth/callback`;
const AGENT = { username: 'agent1000@demo.local', password: 'agent1234' };

const base64url = (buffer: Buffer) => buffer.toString('base64url');

function pkce() {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: base64url(createHash('sha256').update(verifier).digest()) };
}

function authorizeUrl(params: Record<string, string>) {
  const url = new URL(`${ISSUER}/protocol/openid-connect/auth`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url;
}

/** login ผ่านฟอร์มของ Keycloak แล้วคืน URL ที่ redirect กลับมา (ไม่ follow ไปที่ callback จริง) */
async function login(url: URL): Promise<URL> {
  const cookies = new Map<string, string>();
  const remember = (response: Response) => {
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair!.indexOf('=');
      cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
  };
  const jar = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  let response = await fetch(url, { redirect: 'manual' });
  // organization ทำให้ Keycloak ใช้ identity-first: หน้า username ก่อน แล้วค่อยหน้า password
  for (let step = 0; step < 4; step += 1) {
    remember(response);
    const location = response.headers.get('location');
    if (location) return new URL(location);
    const html = await response.text();
    const action = /<form[^>]*action="([^"]+)"/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    assert.ok(action, `ไม่พบฟอร์ม login (${response.status})`);
    const fields: Record<string, string> = {};
    if (/id="username"/.test(html)) fields.username = AGENT.username;
    if (/id="password"/.test(html)) fields.password = AGENT.password;
    response = await fetch(action, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar() },
      body: new URLSearchParams(fields),
    });
  }
  throw new Error('login ไม่ redirect กลับมาภายใน 4 ขั้น');
}

async function token(body: Record<string, string>) {
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: CLIENT, ...body }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

async function signIn() {
  const { verifier, challenge } = pkce();
  const state = base64url(randomBytes(16));
  const redirected = await login(
    authorizeUrl({
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid organization:demo',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }),
  );
  assert.equal(`${redirected.origin}${redirected.pathname}`, REDIRECT);
  assert.equal(redirected.searchParams.get('state'), state);
  const code = redirected.searchParams.get('code')!;
  return { code, verifier };
}

test('redirect ต้องตรงแบบ exact; implicit และ direct grant ใช้ไม่ได้', async () => {
  for (const redirect of [
    `${REDIRECT}/x`,
    `${ORIGIN}/dphone/auth/callback?x=1`,
    'https://evil.example.test/dphone/auth/callback',
  ]) {
    const response = await fetch(
      authorizeUrl({
        client_id: CLIENT,
        redirect_uri: redirect,
        response_type: 'code',
        scope: 'openid',
      }),
      { redirect: 'manual' },
    );
    assert.equal(response.status, 400, redirect); // Keycloak แสดงหน้า error ไม่ redirect ไป URL ที่ไม่รู้จัก
  }
  const implicit = await fetch(
    authorizeUrl({
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      response_type: 'token',
      scope: 'openid',
    }),
    { redirect: 'manual' },
  );
  const implicitLocation = implicit.headers.get('location') ?? '';
  assert.match(implicitLocation, /error=unauthorized_client|error=unsupported_response_type/);
  const direct = await token({ grant_type: 'password', ...AGENT, scope: 'openid' });
  assert.equal(direct.body.error, 'unauthorized_client');
});

test('PKCE S256 บังคับ: ไม่ส่ง challenge = error; verifier ผิด = แลก code ไม่ได้', async () => {
  const missing = await fetch(
    authorizeUrl({
      client_id: CLIENT,
      redirect_uri: REDIRECT,
      response_type: 'code',
      scope: 'openid',
      state: 's',
    }),
    { redirect: 'manual' },
  );
  assert.match(missing.headers.get('location') ?? '', /error=invalid_request/);
  const { code } = await signIn();
  const wrong = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: base64url(randomBytes(32)),
  });
  assert.equal(wrong.body.error, 'invalid_grant');

  // code ใช้ได้ครั้งเดียว — ใช้ซ้ำแล้ว Keycloak เพิกถอน session ของ code นั้นด้วย
  const fresh = await signIn();
  const exchange = () =>
    token({
      grant_type: 'authorization_code',
      code: fresh.code,
      redirect_uri: REDIRECT,
      code_verifier: fresh.verifier,
    });
  const issued = await exchange();
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal((await exchange()).body.error, 'invalid_grant');
  const revoked = await token({
    grant_type: 'refresh_token',
    refresh_token: issued.body.refresh_token,
  });
  assert.equal(revoked.body.error, 'invalid_grant');
});

test('แลก code ได้ token 5 นาทีที่ gateway ของ API ยอมรับ; refresh rotate และการใช้ refresh token ซ้ำถูกปฏิเสธพร้อมปิด session', async () => {
  const { code, verifier } = await signIn();
  const issued = await token({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
  });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  assert.equal(issued.body.expires_in, 300);
  const verifierOfApi = new KeycloakAccessTokenVerifier({
    issuer: ISSUER,
    audience: 'dcontact-api',
    jwksUri: `${ISSUER}/protocol/openid-connect/certs`,
  });
  const identity = toVerifiedWorkspaceIdentity(
    await verifierOfApi.verifyAccessToken(issued.body.access_token),
  );
  assert.ok(identity.tenantId && identity.userId && identity.roles.includes('agent'));
  const claims = JSON.parse(
    Buffer.from(String(issued.body.access_token).split('.')[1]!, 'base64url').toString(),
  );
  assert.equal(claims.azp, CLIENT);

  const first = await token({
    grant_type: 'refresh_token',
    refresh_token: issued.body.refresh_token,
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.notEqual(first.body.refresh_token, issued.body.refresh_token, 'refresh token ต้อง rotate');

  // ใช้ refresh token เก่าซ้ำ → ปฏิเสธ และ session ถูกปิด (refresh token ใหม่ใช้ต่อไม่ได้)
  const reused = await token({
    grant_type: 'refresh_token',
    refresh_token: issued.body.refresh_token,
  });
  assert.equal(reused.body.error, 'invalid_grant');
  const afterReuse = await token({
    grant_type: 'refresh_token',
    refresh_token: first.body.refresh_token,
  });
  assert.equal(afterReuse.body.error, 'invalid_grant', JSON.stringify(afterReuse.body));
});
