import assert from 'node:assert/strict';
import test from 'node:test';
import {
  accessTokenRealmRoles,
  cleanConsoleCallbackUrl,
  clearConsoleSignOut,
  consumeConsoleReturnLocation,
  consumeConsoleReturnUrl,
  createConsoleOidcSettings,
  isConsoleSignedOutLanding,
  shouldRestoreConsoleSession,
  isOidcCallback,
  rememberConsoleReturnUrl,
  rememberConsoleSignOut,
  resolveConsoleContextId,
  resolveConsoleLocation,
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

test('Console uses in-memory PKCE and accepts only an opaque context UUID', async () => {
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

test('#684 with no view/context open Home even when an old deployment sets the default to Journeys', () => {
  const at = (query: string) => new URL(`https://acme.console.example${query}`);
  assert.equal(resolveConsoleView(at('/?tenant=acme'), 'journeys'), 'home');
  assert.equal(resolveConsoleView(at('/'), undefined), 'home');
  assert.equal(resolveConsoleView(at('/'), 'governance'), 'home');
  // the view in the URL takes precedence over the default, and an Interaction context does not change the page
  assert.equal(resolveConsoleView(at('/?view=governance'), 'journeys'), 'governance');
  assert.equal(
    resolveConsoleView(at('/?context=0f8fad5b-d9cb-469f-a165-70867728950e'), 'journeys'),
    null,
  );
});

test('U1.7 OIDC callback leaves no code/state in the URL but keeps tenant/view/journey', () => {
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

test('E1.16 login from the dphone embedding page returns to the same page without opening a path to an external URL', () => {
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

test('E1.16 the callback returns the active view without reloading the token held in memory', () => {
  const storage = new MemoryStorage();
  const embedding = new URL('https://acme.console.example/?tenant=acme&view=dphone-embedding');
  rememberConsoleReturnUrl(embedding, storage);
  const callback = new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de');

  assert.deepEqual(consumeConsoleReturnLocation(callback, storage, 'journeys'), {
    url: '/?tenant=acme&view=dphone-embedding',
    view: 'dphone-embedding',
  });
});

test('#676 the OIDC callback chooses the page from the remembered destination URL, not from a redirect_uri that has no view', () => {
  const storage = new MemoryStorage();
  const callback = new URL(
    'https://acme.console.example/?tenant=acme&state=abc&session_state=s1&iss=https%3A%2F%2Fidp&code=c0de',
  );
  const links = [
    ['/?tenant=acme&view=governance&section=audit', 'governance'],
    ['/?tenant=acme&view=account', 'account'],
    ['/?tenant=acme&view=journeys', 'journeys'],
    ['/?tenant=acme&view=home', 'home'],
    ['/?tenant=acme', 'home'],
    ['/?tenant=acme&context=0f8fad5b-d9cb-469f-a165-70867728950e', null],
  ] as const;
  for (const [link, view] of links) {
    storage.setItem('dcontact.console.return-url', link);
    const resolved = resolveConsoleLocation(callback, storage);
    // no default view (UAT value) — the page can be chosen only from the remembered link
    assert.equal(resolveConsoleView(resolved, undefined), view, link);
    assert.equal(resolved.searchParams.get('code'), null, 'the destination URL has no code/state');
    assert.equal(resolveTenantAlias(resolved), 'acme');
  }
  storage.setItem(
    'dcontact.console.return-url',
    '/?tenant=acme&context=0f8fad5b-d9cb-469f-a165-70867728950e',
  );
  assert.equal(
    resolveConsoleContextId(resolveConsoleLocation(callback, storage)),
    '0f8fad5b-d9cb-469f-a165-70867728950e',
  );
});

test('#676 reads the remembered value without deleting it, so onSigninCallback uses and deletes it itself', () => {
  const storage = new MemoryStorage();
  storage.setItem('dcontact.console.return-url', '/?tenant=acme&view=governance');
  const callback = new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de');
  resolveConsoleLocation(callback, storage);
  assert.equal(storage.getItem('dcontact.console.return-url'), '/?tenant=acme&view=governance');
  assert.equal(consumeConsoleReturnUrl(callback, storage), '/?tenant=acme&view=governance');
  assert.equal(storage.getItem('dcontact.console.return-url'), null);
});

test('#676 does not trust a destination URL with a different origin/tenant or that is not an internal path', () => {
  const storage = new MemoryStorage();
  const callback = new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de');
  for (const saved of [
    'https://attacker.example/?tenant=acme&view=governance',
    '//attacker.example/?tenant=acme',
    '/?tenant=other&view=governance',
    '/?view=governance',
    'javascript:alert(1)',
  ]) {
    storage.setItem('dcontact.console.return-url', saved);
    assert.equal(resolveConsoleLocation(callback, storage).href, callback.href, saved);
  }
  // no remembered value = use the original callback URL (original behavior)
  const empty = new MemoryStorage();
  assert.equal(resolveConsoleLocation(callback, empty).href, callback.href);
});

test('#676 a URL that is not a callback is not hijacked by a value left in storage', () => {
  const storage = new MemoryStorage();
  storage.setItem('dcontact.console.return-url', '/?tenant=acme&view=governance');
  for (const href of [
    'https://acme.console.example/?tenant=acme',
    'https://acme.console.example/?tenant=acme&view=account',
    'https://acme.console.example/?tenant=acme&code=c0de', // no state
    'https://acme.console.example/?tenant=acme&state=abc', // no code/error
  ]) {
    assert.equal(resolveConsoleLocation(new URL(href), storage).href, href);
    assert.equal(isOidcCallback(new URL(href)), false, href);
  }
  assert.equal(
    isOidcCallback(new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de')),
    true,
  );
  // Keycloak rejection (e.g. access_denied) is also a callback — must return to the original page to show the result, not a context error
  assert.equal(
    isOidcCallback(
      new URL('https://acme.console.example/?tenant=acme&state=abc&error=access_denied'),
    ),
    true,
  );
});

test('#677 after sign-out the "signed out" page is shown only for the page Keycloak returns to', () => {
  const storage = new MemoryStorage();
  const landing = new URL('https://acme.console.example/?tenant=acme');
  // not signed out yet = the original page (no mark)
  assert.equal(isConsoleSignedOutLanding(landing, storage), false);

  rememberConsoleSignOut(
    new URL('https://acme.console.example/?tenant=acme&view=governance&section=audit'),
    storage,
  );
  assert.equal(isConsoleSignedOutLanding(landing, storage), true);
  // a link that names its own page or an OIDC callback is not the post-sign-out page
  for (const href of [
    'https://acme.console.example/?tenant=acme&view=account',
    'https://acme.console.example/?tenant=acme&context=0f8fad5b-d9cb-469f-a165-70867728950e',
    'https://acme.console.example/?tenant=acme&state=abc&code=c0de',
  ]) {
    assert.equal(isConsoleSignedOutLanding(new URL(href), storage), false, href);
  }

  clearConsoleSignOut(storage);
  assert.equal(isConsoleSignedOutLanding(landing, storage), false);
});

test('#677 signing in again after sign-out returns to the page just left', () => {
  const storage = new MemoryStorage();
  rememberConsoleSignOut(
    new URL('https://acme.console.example/?tenant=acme&view=governance&section=audit'),
    storage,
  );
  clearConsoleSignOut(storage); // pressing the sign-in-again button — do not overwrite with the URL of the sign-out page
  const callback = new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de');
  const resolved = resolveConsoleLocation(callback, storage);
  assert.equal(resolveConsoleView(resolved, undefined), 'governance');
  assert.equal(resolved.searchParams.get('section'), 'audit');
  assert.equal(isConsoleSignedOutLanding(resolved, storage), false);
});

test('E1.16 UI reads realm roles from the access token and fails closed on a malformed claim', () => {
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

test('#684 a callback with no return URL opens Home, and signing out from Home can return', () => {
  const storage = new MemoryStorage();
  const home = new URL('https://acme.console.example/?tenant=acme');
  const callback = new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de');
  assert.deepEqual(consumeConsoleReturnLocation(callback, storage, 'journeys'), {
    url: '/?tenant=acme',
    view: 'home',
  });
  rememberConsoleSignOut(home, storage);
  assert.equal(isConsoleSignedOutLanding(home, storage), true);
  clearConsoleSignOut(storage);
  assert.equal(isConsoleSignedOutLanding(home, storage), false);
  assert.equal(resolveConsoleView(resolveConsoleLocation(callback, storage), 'journeys'), 'home');
  assert.deepEqual(consumeConsoleReturnLocation(callback, storage), {
    url: '/?tenant=acme',
    view: 'home',
  });
});

test('#733 restore SSO only on a normal boot; do not hijack a callback or sign back in after an explicit sign-out', () => {
  const storage = new MemoryStorage();
  const home = new URL('https://console.example/?tenant=acme');
  const account = new URL('https://console.example/?tenant=acme&view=account');
  assert.equal(shouldRestoreConsoleSession(home, storage), true);
  assert.equal(shouldRestoreConsoleSession(account, storage), true);
  assert.equal(
    shouldRestoreConsoleSession(
      new URL('https://console.example/?tenant=acme&code=code&state=state'),
      storage,
    ),
    false,
  );
  assert.equal(
    shouldRestoreConsoleSession(
      new URL('https://console.example/?tenant=acme&error=login_required&state=state'),
      storage,
    ),
    false,
  );
  rememberConsoleSignOut(account, storage);
  assert.equal(shouldRestoreConsoleSession(home, storage), false);
  assert.equal(shouldRestoreConsoleSession(account, storage), false);
  clearConsoleSignOut(storage);
  assert.equal(shouldRestoreConsoleSession(account, storage), true);
});
