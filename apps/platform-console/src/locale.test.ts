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

test('ภาษา: ค่าในแท็บชนะ browser; browser ที่ไม่รองรับไหลไป th', () => {
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

test('storage อ่าน/เขียนไม่ได้ยัง resolve ภาษาและไม่โยน error ให้ UI', () => {
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

test('ภาษาในแท็บคงอยู่ข้าม OIDC state และ restore marker โดยไม่แตะข้อมูลอื่น', async () => {
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

test('catalog ของ platform และ ui สลับพร้อมกัน; เวลา operator แยกจาก tenant เสมอ', async () => {
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
