import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { test } from 'node:test';
import {
  base64Url,
  DPHONE_AUTH_CALLBACK_MESSAGE,
  EmbeddedAuth,
  REFRESH_BACKOFF_MS,
  type EmbeddedAuthDeps,
} from './embedded-auth.js';

const config = {
  issuer: 'https://id.dcontact.test/realms/dcontact',
  clientId: 'dphone-embedded',
  tenant: 'demo',
  origin: 'https://api.dcontact.test',
};
const TOKEN = `${config.issuer}/protocol/openid-connect/token`;

function harness() {
  const store = new Map<string, string>();
  const timers: { callback: () => void; ms: number }[] = [];
  const calls: { url: string; init: RequestInit }[] = [];
  const responses: (() => Response)[] = [];
  const popups: { url: string; closed: boolean; close(): void }[] = [];
  let blockPopup = false;
  let now = 1_000_000;
  const deps: EmbeddedAuthDeps = {
    fetch: (async (url: string, init: RequestInit = {}) => {
      calls.push({ url, init });
      const next = responses.shift();
      if (!next) throw new TypeError('network down');
      return next();
    }) as typeof fetch,
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
      removeItem: (key) => void store.delete(key),
    },
    openPopup: (url) => {
      if (blockPopup) return null;
      const popup = { url, closed: false, close: () => (popup.closed = true) };
      popups.push(popup);
      return popup;
    },
    randomBytes: (length) => new Uint8Array(randomBytes(length)),
    sha256: async (input) => new Uint8Array(createHash('sha256').update(input).digest()),
    now: () => now,
    setTimeout: (callback, ms) => {
      const timer = { callback, ms };
      timers.push(timer);
      return timer;
    },
    clearTimeout: (handle) => {
      const index = timers.indexOf(handle as (typeof timers)[number]);
      if (index >= 0) timers.splice(index, 1);
    },
  };
  const tokens = (access: string, refresh: string) => () =>
    Response.json({ access_token: access, refresh_token: refresh, expires_in: 300 });
  return {
    auth: new EmbeddedAuth(config, deps),
    store,
    timers,
    calls,
    responses,
    popups,
    tokens,
    block: (value: boolean) => (blockPopup = value),
    advance: (ms: number) => (now += ms),
    fire: async () => {
      const timer = timers.shift();
      timer?.callback();
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

async function signIn(h: ReturnType<typeof harness>) {
  await h.auth.start();
  h.auth.login();
  const popup = h.popups.at(-1)!;
  const state = new URL(popup.url).searchParams.get('state');
  h.responses.push(h.tokens('access-1', 'refresh-1'));
  await h.auth.handleMessage({
    origin: config.origin,
    source: popup,
    data: { type: DPHONE_AUTH_CALLBACK_MESSAGE, code: 'code-1', state },
  });
  return popup;
}

test('authorize URL: PKCE S256 ที่ตรงกับ verifier, state, exact redirect และ scope ของ tenant', async () => {
  const h = harness();
  await signIn(h);
  const url = new URL(h.popups[0]!.url);
  assert.equal(url.origin + url.pathname, `${config.issuer}/protocol/openid-connect/auth`);
  assert.equal(url.searchParams.get('client_id'), 'dphone-embedded');
  assert.equal(url.searchParams.get('redirect_uri'), `${config.origin}/dphone/auth/callback`);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('scope'), 'openid organization:demo');
  assert.equal(url.searchParams.has('prompt'), false);

  const exchange = new URLSearchParams(h.calls[0]!.init.body as string);
  assert.equal(h.calls[0]!.url, TOKEN);
  assert.equal(exchange.get('grant_type'), 'authorization_code');
  assert.equal(exchange.get('code'), 'code-1');
  const verifier = exchange.get('code_verifier')!;
  assert.equal(
    url.searchParams.get('code_challenge'),
    base64Url(new Uint8Array(createHash('sha256').update(verifier).digest())),
  );
  assert.equal(h.auth.status, 'signed-in');
  assert.equal(h.store.get('dphone.embed.refresh.demo'), 'refresh-1');
});

test('callback ที่ state ไม่ตรง/origin อื่น/source ไม่ใช่ popup ของเรา ไม่ถูกแลก token', async () => {
  const h = harness();
  await h.auth.start();
  h.auth.login();
  const popup = h.popups[0]!;
  const state = new URL(popup.url).searchParams.get('state');
  const data = { type: DPHONE_AUTH_CALLBACK_MESSAGE, code: 'c', state };
  assert.equal(
    await h.auth.handleMessage({ origin: 'https://host.test', source: popup, data }),
    false,
  );
  assert.equal(await h.auth.handleMessage({ origin: config.origin, source: {}, data }), false);
  assert.equal(
    await h.auth.handleMessage({
      origin: config.origin,
      source: popup,
      data: { ...data, state: 'forged' },
    }),
    true,
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.auth.status, 'signed-out');
});

test('popup ถูกบล็อก → สถานะ popup-blocked และกดใหม่ได้', async () => {
  const h = harness();
  await h.auth.start();
  h.block(true);
  h.auth.login();
  assert.equal(h.auth.status, 'popup-blocked');
  h.block(false);
  h.auth.login();
  assert.equal(h.auth.status, 'signing-in');
});

test('fetch แนบ bearer; refresh หมุน token ใช้ครั้งเดียวก่อนหมดอายุ', async () => {
  const h = harness();
  await signIn(h);
  h.responses.push(() => new Response('{}'));
  await h.auth.fetch('/api/v1/workspace/agent/snapshot');
  const headers = new Headers(h.calls.at(-1)!.init.headers);
  assert.equal(headers.get('authorization'), 'Bearer access-1');

  assert.equal(h.timers[0]!.ms, 270_000);
  h.responses.push(h.tokens('access-2', 'refresh-2'));
  await h.fire();
  const refresh = new URLSearchParams(h.calls.at(-1)!.init.body as string);
  assert.equal(refresh.get('grant_type'), 'refresh_token');
  assert.equal(refresh.get('refresh_token'), 'refresh-1');
  assert.equal(h.store.get('dphone.embed.refresh.demo'), 'refresh-2');
});

test('reload host: มี refresh token ใน sessionStorage → เข้าสู่ระบบโดยไม่เปิด popup', async () => {
  const h = harness();
  h.store.set('dphone.embed.refresh.demo', 'refresh-kept');
  h.responses.push(h.tokens('access-9', 'refresh-10'));
  await h.auth.start();
  assert.equal(h.auth.status, 'signed-in');
  assert.equal(h.popups.length, 0);
});

test('network ล้มระหว่าง refresh → backoff ตามลำดับ แล้วต้อง login ใหม่เมื่อครบ', async () => {
  const h = harness();
  await signIn(h);
  for (const delay of REFRESH_BACKOFF_MS) {
    await h.fire(); // refresh ล้ม (ไม่มี response = network down)
    assert.equal(h.auth.status, 'refreshing');
    assert.equal(h.timers[0]!.ms, delay);
  }
  await h.fire();
  assert.equal(h.auth.status, 'reauth');
  assert.equal(h.store.has('dphone.embed.refresh.demo'), false);
});

test('invalid_grant (revoke/reuse/session cap) → reauth ทันที; คำสั่ง API รอในคิวแล้วส่งหลัง login ใหม่', async () => {
  const h = harness();
  await signIn(h);
  h.responses.push(() => Response.json({ error: 'invalid_grant' }, { status: 400 }));
  await h.fire();
  assert.equal(h.auth.status, 'reauth');

  const sent = h.calls.length;
  const pending = h.auth.fetch('/api/v1/workspace/agent/state', { method: 'POST' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.calls.length, sent);
  assert.equal(h.auth.queued, 1);

  // สายจบระหว่าง reauth → ไม่พร้อม + ปล่อย lease (เข้าคิวเช่นกัน)
  const order: string[] = [];
  assert.equal(
    h.auth.afterCallEnded({
      setNotReady: async () => void order.push('not-ready'),
      releaseLease: async () => void order.push('release'),
    }),
    true,
  );

  h.auth.login();
  const popup = h.popups.at(-1)!;
  h.responses.push(h.tokens('access-new', 'refresh-new'), () => new Response('ok'));
  await h.auth.handleMessage({
    origin: config.origin,
    source: popup,
    data: {
      type: DPHONE_AUTH_CALLBACK_MESSAGE,
      code: 'code-2',
      state: new URL(popup.url).searchParams.get('state'),
    },
  });
  assert.equal(await (await pending).text(), 'ok');
  assert.equal(new Headers(h.calls.at(-1)!.init.headers).get('authorization'), 'Bearer access-new');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['not-ready', 'release']);
});

test('logout: ห้ามตอนมีสาย; ตอนว่าง ปล่อย lease → revoke refresh token → ล้าง storage', async () => {
  const h = harness();
  await signIn(h);
  const order: string[] = [];
  assert.equal(
    await h.auth.logout({ busy: true, releaseLease: async () => void order.push('release') }),
    false,
  );
  assert.equal(h.auth.status, 'signed-in');

  h.responses.push(() => new Response(null, { status: 200 }));
  assert.equal(
    await h.auth.logout({ busy: false, releaseLease: async () => void order.push('release') }),
    true,
  );
  const revoke = h.calls.at(-1)!;
  assert.equal(revoke.url, `${config.issuer}/protocol/openid-connect/revoke`);
  assert.equal(new URLSearchParams(revoke.init.body as string).get('token'), 'refresh-1');
  assert.deepEqual(order, ['release']);
  assert.equal(h.store.size, 0);
  assert.equal(h.auth.status, 'signed-out');
  assert.equal(
    h.calls.some((call) => call.url.includes('/logout')),
    false,
  );
});
