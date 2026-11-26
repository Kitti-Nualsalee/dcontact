import assert from 'node:assert/strict';
import test from 'node:test';
import { createFormatters, createI18n } from '@d-contact/i18n';
import { InMemoryWebStorage } from 'oidc-client-ts';
import {
  PLATFORM_LOCALE_KEY,
  PLATFORM_TIME_ZONE,
  resolvePlatformLocale,
  savePlatformLocale,
} from './i18n/locale.js';
import { DEFAULT_NAMESPACE, resources } from './i18n/resources.js';
import {
  allowPlatformSessionRestore,
  beginPlatformSessionRestore,
  createPlatformOidcSettings,
} from './auth.js';

test('language: the tab value wins over the browser; an unsupported browser falls through to th', () => {
  const storage = new InMemoryWebStorage();
  const resolve = (browser: string[]) => resolvePlatformLocale({ storage: () => storage, browser });
  assert.equal(resolve(['en-US', 'th-TH']), 'en');
  assert.equal(resolve(['ja-JP', 'th-TH']), 'th');
  assert.equal(resolve(['ja-JP']), 'th');
  assert.equal(resolve([]), 'th');
  savePlatformLocale('th', () => storage);
  assert.equal(resolve(['en-GB']), 'th');
  savePlatformLocale('en', () => storage);
  assert.equal(resolve(['th-TH']), 'en');
  for (const invalid of ['en-US', 'TH', '', '{"locale":"en"}', 'tenant-secret']) {
    storage.setItem(PLATFORM_LOCALE_KEY, invalid);
    assert.equal(resolve(['th-TH']), 'th');
  }
});

test('unreadable/unwritable storage still resolves the language and throws no error to the UI', () => {
  const denied = () => {
    throw new DOMException('Denied', 'SecurityError');
  };
  assert.equal(resolvePlatformLocale({ storage: denied, browser: ['en-GB'] }), 'en');
  assert.doesNotThrow(() => savePlatformLocale('en', denied));
  const failedStorage = {
    getItem: denied,
    setItem: () => {
      throw new DOMException('Full', 'QuotaExceededError');
    },
  };
  assert.equal(resolvePlatformLocale({ storage: () => failedStorage, browser: [] }), 'th');
  assert.doesNotThrow(() => savePlatformLocale('th', () => failedStorage));
});

test('the tab language survives the OIDC state and restore marker without touching other data', async () => {
  const storage = new InMemoryWebStorage();
  savePlatformLocale('en', () => storage);
  const settings = createPlatformOidcSettings({
    issuer: 'https://identity.example.test/realms/dcontact',
    clientId: 'platform-console',
    origin: 'https://platform.example.test',
    stateStorage: storage,
  });
  assert.equal(settings.scope, 'openid');
  assert.equal(settings.disablePKCE, false);
  assert.equal(settings.response_type, 'code');
  assert.equal(settings.automaticSilentRenew, false);
  await settings.stateStore!.set('callback', 'opaque-oidc-state');
  await settings.userStore!.set('user', 'synthetic-access-token');
  assert.equal(storage.getItem('dcontact.platform.oidc.user.user') ?? null, null);
  assert.equal(await settings.userStore!.get('user'), 'synthetic-access-token');
  assert.equal(storage.getItem('dcontact.platform.oidc.state.callback'), 'opaque-oidc-state');
  await settings.stateStore!.remove('callback');
  beginPlatformSessionRestore(storage);
  allowPlatformSessionRestore(storage);
  assert.equal(resolvePlatformLocale({ storage: () => storage, browser: ['th'] }), 'en');
  assert.equal(storage.length, 1);
  assert.equal(storage.getItem(PLATFORM_LOCALE_KEY), 'en');
});

test('the platform and ui catalogs switch together; operator time is always separate from the tenant', async () => {
  const i18n = createI18n({ resources, locale: 'th', defaultNamespace: DEFAULT_NAMESPACE });
  assert.equal(i18n.t('auth.signIn'), 'เข้าสู่ระบบ');
  assert.equal(i18n.t('dialog.close', { ns: 'ui' }), 'ปิด');
  const instant = '2026-10-22T03:05:00.000Z';
  assert.equal(
    createFormatters({ locale: 'th', timeZone: PLATFORM_TIME_ZONE }).time(instant),
    '10:05',
  );
  assert.match(
    createFormatters({ locale: 'th', timeZone: PLATFORM_TIME_ZONE }).dateTime(instant),
    /2569/,
  );
  await i18n.changeLanguage('en');
  assert.equal(i18n.t('auth.signIn'), 'Sign in');
  assert.equal(i18n.t('dialog.close', { ns: 'ui' }), 'Close');
  assert.equal(
    createFormatters({ locale: 'en', timeZone: PLATFORM_TIME_ZONE }).dateTime(instant),
    '22 Oct 2026 10:05',
  );
});
