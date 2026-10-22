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

test('#684 ไม่มี view/context เปิด Home แม้ deployment เดิมตั้ง default เป็น Journeys', () => {
  const at = (query: string) => new URL(`https://acme.console.example${query}`);
  assert.equal(resolveConsoleView(at('/?tenant=acme'), 'journeys'), 'home');
  assert.equal(resolveConsoleView(at('/'), undefined), 'home');
  assert.equal(resolveConsoleView(at('/'), 'governance'), 'home');
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

test('#676 callback ของ OIDC เลือกหน้าจาก URL ปลายทางที่จำไว้ ไม่ใช่จาก redirect_uri ที่ไม่มี view', () => {
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
    // ไม่มี default view (ค่า UAT) — ต้องเลือกหน้าได้จากลิงก์ที่จำไว้เท่านั้น
    assert.equal(resolveConsoleView(resolved, undefined), view, link);
    assert.equal(resolved.searchParams.get('code'), null, 'URL ปลายทางไม่มี code/state');
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

test('#676 อ่านค่าที่จำไว้โดยไม่ลบ เพื่อให้ onSigninCallback ใช้ต่อและลบเอง', () => {
  const storage = new MemoryStorage();
  storage.setItem('dcontact.console.return-url', '/?tenant=acme&view=governance');
  const callback = new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de');
  resolveConsoleLocation(callback, storage);
  assert.equal(storage.getItem('dcontact.console.return-url'), '/?tenant=acme&view=governance');
  assert.equal(consumeConsoleReturnUrl(callback, storage), '/?tenant=acme&view=governance');
  assert.equal(storage.getItem('dcontact.console.return-url'), null);
});

test('#676 ไม่เชื่อ URL ปลายทางที่ต่าง origin/tenant หรือไม่ใช่ path ภายใน', () => {
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
  // ไม่มีค่าที่จำไว้ = ใช้ URL callback เดิม (พฤติกรรมเดิม)
  const empty = new MemoryStorage();
  assert.equal(resolveConsoleLocation(callback, empty).href, callback.href);
});

test('#676 URL ที่ไม่ใช่ callback ไม่ถูกแย่งด้วยค่าที่ค้างใน storage', () => {
  const storage = new MemoryStorage();
  storage.setItem('dcontact.console.return-url', '/?tenant=acme&view=governance');
  for (const href of [
    'https://acme.console.example/?tenant=acme',
    'https://acme.console.example/?tenant=acme&view=account',
    'https://acme.console.example/?tenant=acme&code=c0de', // ไม่มี state
    'https://acme.console.example/?tenant=acme&state=abc', // ไม่มี code/error
  ]) {
    assert.equal(resolveConsoleLocation(new URL(href), storage).href, href);
    assert.equal(isOidcCallback(new URL(href)), false, href);
  }
  assert.equal(
    isOidcCallback(new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de')),
    true,
  );
  // Keycloak ปฏิเสธ (เช่น access_denied) ก็เป็น callback — ต้องกลับไปหน้าเดิมเพื่อแสดงผล ไม่ใช่ error ของ context
  assert.equal(
    isOidcCallback(
      new URL('https://acme.console.example/?tenant=acme&state=abc&error=access_denied'),
    ),
    true,
  );
});

test('#677 หลัง sign-out แสดงหน้า "ออกจากระบบแล้ว" เฉพาะหน้าที่ Keycloak พากลับมา', () => {
  const storage = new MemoryStorage();
  const landing = new URL('https://acme.console.example/?tenant=acme');
  // ยังไม่ได้ sign-out = หน้าเดิม (ไม่มีเครื่องหมาย)
  assert.equal(isConsoleSignedOutLanding(landing, storage), false);

  rememberConsoleSignOut(
    new URL('https://acme.console.example/?tenant=acme&view=governance&section=audit'),
    storage,
  );
  assert.equal(isConsoleSignedOutLanding(landing, storage), true);
  // ลิงก์ที่ระบุหน้าเองหรือ callback ของ OIDC ไม่ใช่หน้าหลัง sign-out
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

test('#677 เข้าสู่ระบบอีกครั้งหลัง sign-out กลับไปหน้าที่เพิ่งออกมา', () => {
  const storage = new MemoryStorage();
  rememberConsoleSignOut(
    new URL('https://acme.console.example/?tenant=acme&view=governance&section=audit'),
    storage,
  );
  clearConsoleSignOut(storage); // กดปุ่มเข้าสู่ระบบอีกครั้ง — ไม่จำ URL ของหน้า sign-out ทับ
  const callback = new URL('https://acme.console.example/?tenant=acme&state=abc&code=c0de');
  const resolved = resolveConsoleLocation(callback, storage);
  assert.equal(resolveConsoleView(resolved, undefined), 'governance');
  assert.equal(resolved.searchParams.get('section'), 'audit');
  assert.equal(isConsoleSignedOutLanding(resolved, storage), false);
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

test('#684 callback ที่ไม่มี return URL เปิด Home และ sign-out จาก Home กลับมาได้', () => {
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

test('#733 กู้ SSO เฉพาะ boot ปกติ ไม่แย่ง callback หรือกลับเข้าเองหลัง explicit sign-out', () => {
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
