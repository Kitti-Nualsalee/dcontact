import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createConsoleOidcSettings,
  resolveConsoleContextId,
  resolveTenantAlias,
} from './auth-session.js';

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
