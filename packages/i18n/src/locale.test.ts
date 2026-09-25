import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_TIME_ZONE, normalizeLocale, resolveLocale, resolveTimeZone } from './locale.js';

test('normalizeLocale รับรูปแบบ tag ทั่วไป และปฏิเสธภาษาที่ไม่รองรับ', () => {
  assert.equal(normalizeLocale('th'), 'th');
  assert.equal(normalizeLocale('th-TH'), 'th');
  assert.equal(normalizeLocale('EN_us'), 'en');
  assert.equal(normalizeLocale('ja-JP'), undefined);
  assert.equal(normalizeLocale(''), undefined);
  assert.equal(normalizeLocale(undefined), undefined);
});

test('ลำดับภาษา: ผู้ใช้ → tenant → browser → th', () => {
  assert.equal(resolveLocale({ user: 'en', tenant: 'th', browser: ['th-TH'] }), 'en');
  assert.equal(resolveLocale({ tenant: 'en', browser: ['th-TH'] }), 'en');
  assert.equal(resolveLocale({ user: 'fr', tenant: 'xx', browser: ['ja', 'en-US'] }), 'en');
  assert.equal(resolveLocale({ browser: ['ja', 'fr'] }), 'th');
  assert.equal(resolveLocale({}), 'th');
});

test('timezone: ผู้ใช้ → tenant → ค่าคงที่ของระบบ และไม่รับค่าที่ไม่ใช่ IANA', () => {
  assert.equal(resolveTimeZone({ user: 'Europe/London', tenant: 'Asia/Bangkok' }), 'Europe/London');
  assert.equal(resolveTimeZone({ user: 'Mars/Base', tenant: 'Asia/Tokyo' }), 'Asia/Tokyo');
  assert.equal(resolveTimeZone({}), DEFAULT_TIME_ZONE);
});
