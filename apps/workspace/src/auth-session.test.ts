import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOidcSettings,
  resolveAuthorizedWorkspaceView,
  resolveTenantAlias,
} from './auth-session.js';

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('tenant alias มาจาก query ใน local dev และ hostname ใน tenant workspace', () => {
  assert.equal(resolveTenantAlias(new URL('http://localhost:5173/?tenant=demo')), 'demo');
  assert.equal(resolveTenantAlias(new URL('https://acme.d-contact.io/')), 'acme');
  assert.throws(() => resolveTenantAlias(new URL('http://localhost:5173/')), /tenant alias/);
});

test('OIDC ใช้ Authorization Code + PKCE และไม่เก็บ access token ใน sessionStorage', async () => {
  const sessionStorage = new MemoryStorage();
  const settings = createOidcSettings({
    issuer: 'https://identity.example/realms/dcontact',
    clientId: 'agent-desktop',
    origin: 'https://acme.d-contact.io',
    tenantAlias: 'acme',
    stateStorage: sessionStorage,
  });

  assert.equal(settings.response_type, 'code');
  assert.equal(settings.scope, 'openid profile email roles organization:acme');
  assert.equal(settings.redirect_uri, 'https://acme.d-contact.io/?tenant=acme');
  assert.equal(settings.automaticSilentRenew, true);

  await settings.userStore?.set('oidc.user:test', '{"access_token":"secret"}');
  assert.equal(sessionStorage.length, 0);
  assert.equal(await settings.userStore?.get('oidc.user:test'), '{"access_token":"secret"}');
});

test('Supervisor Workspace เปิดได้เฉพาะ realm role supervisor หรือ admin', () => {
  const supervisorUrl = new URL('https://acme.d-contact.io/?view=supervisor');

  assert.equal(
    resolveAuthorizedWorkspaceView(supervisorUrl, { realm_access: { roles: ['supervisor'] } }),
    'supervisor',
  );
  assert.equal(
    resolveAuthorizedWorkspaceView(supervisorUrl, { realm_access: { roles: ['admin'] } }),
    'supervisor',
  );
  assert.equal(
    resolveAuthorizedWorkspaceView(supervisorUrl, { realm_access: { roles: ['agent'] } }),
    'forbidden',
  );
  assert.equal(resolveAuthorizedWorkspaceView(supervisorUrl, {}), 'forbidden');
});

test('Agent Workspace เป็น view เริ่มต้นแม้ profile มีข้อมูล role ผิดรูปแบบ', () => {
  assert.equal(
    resolveAuthorizedWorkspaceView(new URL('https://acme.d-contact.io/'), {
      realm_access: { roles: 'supervisor' },
    }),
    'agent',
  );
});
