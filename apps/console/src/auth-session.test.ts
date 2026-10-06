import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessTokenRealmRoles,
  cleanConsoleCallbackUrl,
  consumeConsoleReturnLocation,
  consumeConsoleReturnUrl,
  createConsoleOidcSettings,
  rememberConsoleReturnUrl,
  resolveConsoleContextId,
  resolveConsoleView,
  resolveTenantAlias,
} from './auth-session.js';

function tokenWithClaims(claims: unknown): string {
  return `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

test('Console ใช้ PKCE ใน memory และรับเฉพาะ opaque context UUID', async () => {
  const sessionStorage = new MemoryStorage();
  const settings = createConsoleOidcSettings({
    issuer: 'https://identity.example/realms/dcontact',
    clientId: 'console',
    origin: 'https://acme.console.d-contact.io',
    tenantAlias: 'acme',
    stateStorage: sessionStorage,
  });
  assert.equal(settings.response_type, 'code');
  assert.equal(settings.scope, 'openid profile email roles organization:acme');
  await settings.userStore?.set('oidc.user:test', '{"access_token":"secret"}');
  assert.equal(sessionStorage.length, 0);
  assert.equal(resolveTenantAlias(new URL('http://localhost:5174/?tenant=acme')), 'acme');
  assert.equal(
    resolveConsoleContextId(
      new URL('https://acme.console.d-contact.io/?context=e5e94bea-4a4f-4f45-a4fb-d0d1db07e899'),
    ),
    'e5e94bea-4a4f-4f45-a4fb-d0d1db07e899',
  );
  assert.throws(() =>
    resolveConsoleContextId(new URL('https://acme.console.d-contact.io/?interaction=x')),
  );
});

test('U1.4 ไม่มี view และ context ใช้ default view ตอน build ได้เฉพาะ journeys', () => {
  const at = (query: string) => new URL(`https://acme.console.example${query}`);
  assert.equal(resolveConsoleView(at('/?tenant=acme'), 'journeys'), 'journeys');
  assert.equal(resolveConsoleView(at('/'), undefined), null);
  assert.equal(resolveConsoleView(at('/'), 'governance'), null);
  // view ใน URL มาก่อน default และ Interaction context ไม่ถูกเปลี่ยนหน้า
  assert.equal(resolveConsoleView(at('/?view=governance'), 'journeys'), 'governance');
  assert.equal(
    resolveConsoleView(at('/?context=0f8fad5b-d9cb-469f-a165-70867728950e'), 'journeys'),
    null,
  );
});

test('U1.7 callback ของ OIDC ไม่ทิ้ง code/state ใน URL แต่คง tenant/view/journey', () => {
  const callback = new URL(
    'https://acme.console.example/?tenant=acme&view=journeys&journey=6f1b2c3d-4e5f-4a60-8b7c-9d0e1f2a3b41&state=abc&session_state=s1&iss=https%3A%2F%2Fidp&code=c0de',
  );
  assert.equal(
    cleanConsoleCallbackUrl(callback),
    '/?tenant=acme&view=journeys&journey=6f1b2c3d-4e5f-4a60-8b7c-9d0e1f2a3b41',
  );
  assert.equal(
    cleanConsoleCallbackUrl(new URL('https://acme.console.example/?tenant=acme')),
    '/?tenant=acme',
  );
});

test('E1.16 login จากหน้า dphone embedding กลับหน้าเดิมโดยไม่เปิดทางให้ external URL', () => {
  const storage = new MemoryStorage();
  const embedding = new URL('https://acme.console.example/?tenant=acme&view=dphone-embedding');
  rememberConsoleReturnUrl(embedding, storage);

  const callback = new URL(
    'https://acme.console.example/?tenant=acme&state=abc&session_state=s1&code=c0de',
  );
  assert.equal(consumeConsoleReturnUrl(callback, storage), '/?tenant=acme&view=dphone-embedding');
  assert.equal(consumeConsoleReturnUrl(callback, storage), '/?tenant=acme');

  storage.setItem('dcontact.console.return-url', 'https://attacker.example/steal');
  assert.equal(consumeConsoleReturnUrl(callback, storage), '/?tenant=acme');
});

test('E1.16 callback คืน active view โดยไม่ reload token ที่เก็บใน memory', () => {
  const storage = new MemoryStorage();
  const embedding = new URL('https://acme.console.example/?tenant=acme&view=dphone-embedding');
  rememberConsoleReturnUrl(embedding, storage);
  const callback = new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de');

  assert.deepEqual(consumeConsoleReturnLocation(callback, storage, 'journeys'), {
    url: '/?tenant=acme&view=dphone-embedding',
    view: 'dphone-embedding',
  });
});

test('E1.16 UI อ่าน realm roles จาก access token และ fail closed เมื่อ claim ผิดรูป', () => {
  assert.deepEqual(
    accessTokenRealmRoles(tokenWithClaims({ realm_access: { roles: ['admin', 'agent'] } })),
    ['admin', 'agent'],
  );
  assert.deepEqual(
    accessTokenRealmRoles(tokenWithClaims({ realm_access: { roles: 'admin' } })),
    [],
  );
  assert.deepEqual(accessTokenRealmRoles('not-a-jwt'), []);
  assert.deepEqual(accessTokenRealmRoles(undefined), []);
});
