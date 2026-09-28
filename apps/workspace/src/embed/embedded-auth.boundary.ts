/**
 * E1.13 (#487) runtime ของ auth ใน iframe กับ Keycloak จริง (ต้องรัน `pnpm infra:identity:dphone-embedded` ก่อน)
 *
 * ขับ `EmbeddedAuth` ตัวจริงด้วย deps ของ Node: popup = ขับฟอร์ม login ของ Keycloak แล้วส่ง callback
 * แบบเดียวกับ `/dphone/auth/callback` — ตรวจ reload host, admin revoke ระหว่างทำงาน (คิวไม่หาย),
 * logout ที่ revoke refresh token และไม่มี token ใน storage หลัง logout
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  DPHONE_AUTH_CALLBACK_MESSAGE,
  EmbeddedAuth,
  type EmbeddedAuthDeps,
} from './embedded-auth.js';

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
const REALM = 'dcontact';
const ISSUER = `${KEYCLOAK}/realms/${REALM}`;
const ORIGIN = (process.env.DPHONE_EMBED_ORIGIN ?? 'http://localhost:3000').replace(/\/$/, '');
const AGENT = { username: 'agent1000@demo.local', password: 'agent1234' };
const USERINFO = `${ISSUER}/protocol/openid-connect/userinfo`;
const config = { issuer: ISSUER, clientId: 'dphone-embedded', tenant: 'demo', origin: ORIGIN };

/** login ผ่านฟอร์มของ Keycloak (identity-first) แล้วคืน URL ที่ redirect กลับ callback */
async function completeLogin(url: string): Promise<URL> {
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

function runtime(store = new Map<string, string>()) {
  const popups: { url: string; closed: boolean; close(): void }[] = [];
  const deps: EmbeddedAuthDeps = {
    fetch: (input, init) => fetch(input, init),
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    },
    openPopup: (url) => {
      const popup = { url, closed: false, close: () => (popup.closed = true) };
      popups.push(popup);
      return popup;
    },
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    sha256: async (input) => new Uint8Array(createHash('sha256').update(input).digest()),
    now: () => Date.now(),
    // ไม่ตั้ง timer จริง — test สั่ง refresh เองเพื่อให้ผลแน่นอน
    setTimeout: () => null,
    clearTimeout: () => undefined,
  };
  const auth = new EmbeddedAuth(config, deps);
  /** ผู้ใช้กดปุ่ม → popup login → callback ส่ง code/state กลับมา */
  const signIn = async () => {
    auth.login();
    const popup = popups.at(-1)!;
    const redirected = await completeLogin(popup.url);
    assert.equal(`${redirected.origin}${redirected.pathname}`, `${ORIGIN}/dphone/auth/callback`);
    await auth.handleMessage({
      origin: ORIGIN,
      source: popup,
      data: {
        type: DPHONE_AUTH_CALLBACK_MESSAGE,
        code: redirected.searchParams.get('code'),
        state: redirected.searchParams.get('state'),
      },
    });
  };
  return { auth, store, popups, signIn };
}

async function adminLogout(username: string) {
  const admin = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
      password: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin',
    }),
  }).then((response) => response.json() as Promise<{ access_token: string }>);
  const headers = { authorization: `Bearer ${admin.access_token}` };
  const [user] = (await fetch(
    `${KEYCLOAK}/admin/realms/${REALM}/users?exact=true&username=${encodeURIComponent(username)}`,
    { headers },
  ).then((response) => response.json())) as { id: string }[];
  const response = await fetch(`${KEYCLOAK}/admin/realms/${REALM}/users/${user!.id}/logout`, {
    method: 'POST',
    headers,
  });
  assert.equal(response.status, 204);
}

test('login ผ่าน popup ได้ token ที่ใช้เรียก API ได้; reload host แล้วยังอยู่ในระบบโดยไม่เปิด popup', async () => {
  const first = runtime();
  await first.auth.start();
  await first.signIn();
  assert.equal(first.auth.status, 'signed-in');
  assert.equal((await first.auth.fetch(USERINFO)).status, 200);

  // reload host = runtime ใหม่ แต่ sessionStorage (partition ตาม host) เดิม
  const reloaded = runtime(first.store);
  await reloaded.auth.start();
  assert.equal(reloaded.auth.status, 'signed-in');
  assert.equal(reloaded.popups.length, 0);
  assert.equal((await reloaded.auth.fetch(USERINFO)).status, 200);
  await reloaded.auth.logout({ busy: false, releaseLease: async () => undefined });
});

test('admin revoke ระหว่างทำงาน → reauth; คำสั่งที่รออยู่ไม่หายและส่งหลัง login ใหม่', async () => {
  const { auth, signIn } = runtime();
  await auth.start();
  await signIn();
  await adminLogout(AGENT.username);

  await auth.refresh();
  assert.equal(auth.status, 'reauth');
  const queued = auth.fetch(USERINFO);
  assert.equal(auth.queued, 1);

  await signIn();
  assert.equal(auth.status, 'signed-in');
  assert.equal((await queued).status, 200);
  await auth.logout({ busy: false, releaseLease: async () => undefined });
});

test('logout ตอนว่าง revoke refresh token จริงและล้าง storage; ตอนมีสายไม่ logout', async () => {
  const { auth, store, signIn } = runtime();
  await auth.start();
  await signIn();
  assert.equal(await auth.logout({ busy: true, releaseLease: async () => undefined }), false);
  const refreshToken = store.get('dphone.embed.refresh.demo')!;
  assert.ok(refreshToken);

  assert.equal(await auth.logout({ busy: false, releaseLease: async () => undefined }), true);
  assert.equal(store.size, 0);
  const reused = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  }).then((response) => response.json() as Promise<{ error?: string }>);
  assert.equal(reused.error, 'invalid_grant');
});
