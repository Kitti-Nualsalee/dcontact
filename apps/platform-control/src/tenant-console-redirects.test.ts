import assert from 'node:assert/strict';
import test from 'node:test';
import { TenantConsoleRedirects, tenantConsoleRedirect } from './tenant-console-redirects.js';

const CONTEXT = {
  issuer: 'https://dcontact-uat.osd.co.th/auth/realms/dcontact',
  clientId: 'dcontact-uat-console',
  origin: 'https://dcontact-uat.osd.co.th',
};
const EXISTING = 'https://dcontact-uat.osd.co.th/?tenant=dcontact-uat';

type Client = {
  id: string;
  clientId: string;
  publicClient?: boolean;
  redirectUris?: string[];
  attributes?: Record<string, string>;
  rootUrl?: string;
};

function fakeKeycloak(initial: Client, options: { dropOnPut?: boolean } = {}) {
  let client = structuredClone(initial);
  const calls: { method: string; path: string; body?: Client }[] = [];
  const keycloak = {
    async admin<T>(method: string, path: string, init: { body?: unknown } = {}) {
      calls.push({ method, path, ...(init.body ? { body: init.body as Client } : {}) });
      if (method === 'GET' && path.startsWith('/clients?'))
        return {
          status: 200,
          body: [{ id: client.id, clientId: client.clientId }] as T,
          location: null,
        };
      if (method === 'GET')
        return { status: 200, body: structuredClone(client) as T, location: null };
      if (method === 'PUT') {
        if (!options.dropOnPut) client = structuredClone(init.body as Client);
        return { status: 204, body: undefined as T, location: null };
      }
      throw new Error(`unexpected ${method} ${path}`);
    },
  };
  const locks: string[] = [];
  const lock = {
    async $transaction<R>(
      work: (tx: { $executeRaw: (...args: unknown[]) => Promise<number> }) => Promise<R>,
    ) {
      return work({
        $executeRaw: async (strings: unknown, ...values: unknown[]) => {
          locks.push(String(values[0]));
          return 1;
        },
      });
    },
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    redirects: new TenantConsoleRedirects(keycloak as any, lock as any, CONTEXT),
    calls,
    locks,
    current: () => client,
  };
}

function consoleClient(overrides: Partial<Client> = {}): Client {
  return {
    id: '7a1d0000-0000-4000-8000-000000000001',
    clientId: CONTEXT.clientId,
    publicClient: true,
    redirectUris: [EXISTING],
    rootUrl: 'https://dcontact-uat.osd.co.th',
    attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': EXISTING },
    ...overrides,
  };
}

test('รูปแบบ redirect ตรงกับที่ Console ส่ง (`/?tenant=<slug>`)', () => {
  assert.equal(
    tenantConsoleRedirect(CONTEXT.origin, 'uat-mod1c-20261113'),
    'https://dcontact-uat.osd.co.th/?tenant=uat-mod1c-20261113',
  );
  for (const slug of ['', 'Upper', '-x', 'x-', 'a--b', 'a/b', 'a?b']) {
    assert.throws(() => tenantConsoleRedirect(CONTEXT.origin, slug), /TENANT_CONSOLE_SLUG_INVALID/);
  }
});

test('เพิ่ม redirect และ post-logout ของ tenant โดยคงของเดิมและค่าอื่นของ client', async () => {
  const f = fakeKeycloak(consoleClient());
  assert.equal(await f.redirects.registered('uat-new'), false);
  await f.redirects.register('uat-new');
  const added = 'https://dcontact-uat.osd.co.th/?tenant=uat-new';
  assert.deepEqual(f.current().redirectUris, [EXISTING, added]);
  assert.equal(f.current().attributes!['post.logout.redirect.uris'], `${EXISTING}##${added}`);
  assert.equal(f.current().attributes!['pkce.code.challenge.method'], 'S256');
  assert.equal(f.current().rootUrl, 'https://dcontact-uat.osd.co.th');
  assert.deepEqual(f.locks, ['dc:tenant-console-redirects:dcontact-uat-console']);
  assert.equal(await f.redirects.registered('uat-new'), true);

  // ซ้ำ = ไม่ PUT อีก
  const puts = f.calls.filter((call) => call.method === 'PUT').length;
  await f.redirects.register('uat-new');
  assert.equal(f.calls.filter((call) => call.method === 'PUT').length, puts);
});

test('client ที่ไม่ใช่ tenant Console แบบ public + PKCE ถูกปฏิเสธก่อนแก้', async () => {
  for (const overrides of [
    { publicClient: false },
    { attributes: { 'post.logout.redirect.uris': EXISTING } },
    { clientId: 'platform-console' },
  ]) {
    const f = fakeKeycloak(consoleClient(overrides));
    await assert.rejects(f.redirects.register('uat-new'), /TENANT_CONSOLE_CLIENT/);
    assert.equal(f.calls.filter((call) => call.method === 'PUT').length, 0);
  }
});

test('อ่านกลับแล้วไม่พบ redirect = AMBIGUOUS ไม่ถือว่าสำเร็จ', async () => {
  const f = fakeKeycloak(consoleClient(), { dropOnPut: true });
  await assert.rejects(
    f.redirects.register('uat-new'),
    /AMBIGUOUS.*TENANT_CONSOLE_REDIRECT_READ_BACK_FAILED/,
  );
});
