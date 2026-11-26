import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TIME_ZONE, normalizeLocale, resolveLocale, resolveTimeZone } from './locale.js';

test('normalizeLocale accepts common tag formats and rejects unsupported languages', () => {
  assert.equal(normalizeLocale('th'), 'th');
  assert.equal(normalizeLocale('th-TH'), 'th');
  assert.equal(normalizeLocale('EN_us'), 'en');
  assert.equal(normalizeLocale('ja-JP'), undefined);
  assert.equal(normalizeLocale(''), undefined);
  assert.equal(normalizeLocale(undefined), undefined);
});

test('language order: user → tenant → browser → th', () => {
  assert.equal(resolveLocale({ user: 'en', tenant: 'th', browser: ['th-TH'] }), 'en');
  assert.equal(resolveLocale({ tenant: 'en', browser: ['th-TH'] }), 'en');
  assert.equal(resolveLocale({ user: 'fr', tenant: 'xx', browser: ['ja', 'en-US'] }), 'en');
  assert.equal(resolveLocale({ browser: ['ja', 'fr'] }), 'th');
  assert.equal(resolveLocale({}), 'th');
});

test('timezone: user → tenant → system constant, and rejects values that are not IANA', () => {
  assert.equal(resolveTimeZone({ user: 'Europe/London', tenant: 'Asia/Bangkok' }), 'Europe/London');
  assert.equal(resolveTimeZone({ user: 'Mars/Base', tenant: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(resolveTimeZone({}), DEFAULT_TIME_ZONE);
});
