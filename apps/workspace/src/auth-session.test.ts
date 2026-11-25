import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createOidcSettings,
  workspaceReturnUrl,
  workspaceCallbackUrl,
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

test('tenant alias comes from the query in local dev and from the hostname in a tenant workspace', () => {
  assert.equal(resolveTenantAlias(new URL('http://localhost:5173/?tenant=demo')), 'demo');
  assert.equal(resolveTenantAlias(new URL('https://acme.d-contact.io/')), 'acme');
  assert.throws(() => resolveTenantAlias(new URL('http://localhost:5173/')), /tenant alias/);
});

test('OIDC uses Authorization Code + PKCE and does not store the access token in sessionStorage', async () => {
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
  assert.equal(settings.popup_redirect_uri, settings.redirect_uri);
  assert.equal(settings.automaticSilentRenew, true);

  await settings.userStore?.set('oidc.user:test', '{"access_token":"secret"}');
  assert.equal(sessionStorage.length, 0);
  assert.equal(await settings.userStore?.get('oidc.user:test'), '{"access_token":"secret"}');
});

test('Supervisor Workspace opens only for realm role supervisor or admin', () => {
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

test('Agent Workspace is the default view even when the profile has malformed role data', () => {
  assert.equal(
    resolveAuthorizedWorkspaceView(new URL('https://acme.d-contact.io/'), {
      realm_access: { roles: 'supervisor' },
    }),
    'agent',
  );
});

test('Supervisor callback returns the original view, clears OAuth parameters, and rejects external/cross-tenant destinations', () => {
  const before = new URL('https://workspace.example/?tenant=uat&view=supervisor');
  const callback = new URL(
    'https://workspace.example/?tenant=uat&code=secret&state=opaque&session_state=x&iss=idp',
  );
  const state = workspaceReturnUrl(before);
  assert.equal(workspaceCallbackUrl(callback, state), '/?tenant=uat&view=supervisor');
  for (const invalid of [
    '//evil.example/?tenant=uat',
    '/\\evil.example/?tenant=uat',
    '/?tenant=other&view=supervisor',
    'https://evil.example/',
    {},
  ]) {
    assert.equal(workspaceCallbackUrl(callback, invalid), '/?tenant=uat');
  }
});

test('Workspace uses roles from the access token because the Keycloak roles scope puts no roles in the ID token', () => {
  const token = (roles: unknown) =>
    `header.${btoa(JSON.stringify({ realm_access: { roles } }))}.signature`;
  const url = new URL('https://workspace.example/?tenant=uat&view=supervisor');
  assert.equal(resolveAuthorizedWorkspaceView(url, {}, token(['supervisor'])), 'supervisor');
  assert.equal(resolveAuthorizedWorkspaceView(url, {}, token(['admin'])), 'supervisor');
  assert.equal(
    resolveAuthorizedWorkspaceView(url, { realm_access: { roles: ['admin'] } }, token(['agent'])),
    'forbidden',
  );
  assert.equal(resolveAuthorizedWorkspaceView(url, {}, 'invalid'), 'forbidden');
});
