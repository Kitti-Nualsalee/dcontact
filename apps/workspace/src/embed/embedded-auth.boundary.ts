/**
 * E1.13 (#487) runtime of auth in the iframe against a real Keycloak (run `pnpm infra:identity:dphone-embedded` first)
 *
 * drives the real `EmbeddedAuth` with Node deps: popup = drives the Keycloak login form then sends a callback
 * the same way as `/dphone/auth/callback` — checks host reload, admin revoke while working (the queue is not lost),
 * logout that revokes the refresh token and no token in storage after logout
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

/** log in through the Keycloak form (identity-first) and return the URL that redirects back to the callback */
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
    assert.ok(action, `login form not found (${response.status})`);
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
  throw new Error('login did not redirect back within 4 steps');
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
    // no real timer — the test triggers refresh itself for a deterministic result
    setTimeout: () => null,
    clearTimeout: () => undefined,
  };
  const auth = new EmbeddedAuth(config, deps);
  /** the user presses the button → login popup → callback sends code/state back */
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

test('login through the popup gets a token usable for API calls; after host reload the session persists without opening a popup', async () => {
  const first = runtime();
  await first.auth.start();
  await first.signIn();
  assert.equal(first.auth.status, 'signed-in');
  assert.equal((await first.auth.fetch(USERINFO)).status, 200);

  // host reload = a new runtime but the same sessionStorage (partitioned by host)
  const reloaded = runtime(first.store);
  await reloaded.auth.start();
  assert.equal(reloaded.auth.status, 'signed-in');
  assert.equal(reloaded.popups.length, 0);
  assert.equal((await reloaded.auth.fetch(USERINFO)).status, 200);
  await reloaded.auth.logout({ busy: false, releaseLease: async () => undefined });
});

test('admin revoke while working → reauth; pending commands are not lost and are sent after the new login', async () => {
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

test('logout while idle truly revokes the refresh token and clears storage; during a call it does not log out', async () => {
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
