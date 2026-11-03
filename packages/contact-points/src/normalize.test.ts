import assert from 'node:assert/strict';
import test from 'node:test';
import {
  C360ContactPointError,
  C360TagNameError,
  normalizeC360Email,
  normalizeC360Phone,
  normalizeC360TagName,
  type C360ContactPointErrorCode,
} from './normalize.js';
import { assertC360ContactPointRuntime } from './runtime-manifest.js';

/** Cus360 C3 (#793) S1: acceptance vectors ของ E1 C (fixture เท่านั้น ไม่โทรหรือส่งอีเมลจริง) */
const rejects = (work: () => unknown, code: C360ContactPointErrorCode) =>
  assert.throws(work, (error) => error instanceof C360ContactPointError && error.code === code);

test('runtime ตรงกับรุ่นที่ pin และ metadata SHA256 ของ E1', () => {
  assert.equal(
    assertC360ContactPointRuntime().phoneMetadataSha256,
    '197aabc11a950b88234f2eb20b8259cffa09e975b3ebe90bdd10badefd91dee4',
  );
});

test('PHONE: international และ explicit country ได้ E.164 เดียวกันพร้อม provenance', () => {
  const international = normalizeC360Phone('+1 213 373 4253');
  assert.equal(international.normalizedValue, '+12133734253');
  assert.equal(international.explicitCountry, null);
  assert.equal(international.rawValue, '+1 213 373 4253');
  const national = normalizeC360Phone('(213) 373-4253', 'US');
  assert.equal(national.normalizedValue, '+12133734253');
  assert.equal(national.explicitCountry, 'US');
  // international ไม่ใช้ประเทศที่เลือก จึงไม่บันทึกเป็น provenance
  assert.equal(normalizeC360Phone('+1 213 373 4253', 'TH').explicitCountry, null);
  // non-geographic international ไม่บังคับ country
  assert.equal(normalizeC360Phone('+800 1234 5678').normalizedValue, '+80012345678');
  assert.equal(normalizeC360Phone('081 234 5678', 'TH').normalizedValue, '+66812345678');
});

test('PHONE: ปฏิเสธชัดเจนโดยไม่ตัดส่วนทิ้ง', () => {
  rejects(() => normalizeC360Phone('(213) 373-4253'), 'PHONE_COUNTRY_REQUIRED');
  rejects(() => normalizeC360Phone('Call: +1 213 373 4253'), 'PHONE_INVALID');
  rejects(() => normalizeC360Phone('911', 'US'), 'PHONE_INVALID');
  rejects(() => normalizeC360Phone('*555', 'US'), 'PHONE_INVALID');
  rejects(() => normalizeC360Phone('1-800-FLOWERS', 'US'), 'PHONE_INVALID');
  rejects(() => normalizeC360Phone('tel:+12133734253'), 'PHONE_INVALID');
  rejects(() => normalizeC360Phone('+12133734253;ext=12'), 'PHONE_INVALID');
  for (const extension of [
    '+1 213 373 4253 ext. 12',
    '+1 213 373 4253 x12',
    '+1 213 373 4253#12',
    '+1 213 373 4253,1234',
  ])
    rejects(() => normalizeC360Phone(extension), 'PHONE_EXTENSION_UNSUPPORTED');
  rejects(() => normalizeC360Phone('+1 213 373 4253', 'us'), 'PHONE_COUNTRY_UNSUPPORTED');
  rejects(() => normalizeC360Phone('+1 213 373 4253', 'ZZ'), 'PHONE_COUNTRY_UNSUPPORTED');
  rejects(() => normalizeC360Phone('+1 213\n373 4253'), 'PHONE_INVALID');
  rejects(() => normalizeC360Phone(12133734253), 'PHONE_INVALID');
});

test('PHONE/EMAIL: ความยาวนับ UTF-16 ก่อน parse และ lone surrogate ถูกปฏิเสธ', () => {
  rejects(() => normalizeC360Phone(`+1 213 373 4253${' '.repeat(50)}`), 'PHONE_TOO_LONG');
  assert.equal(
    normalizeC360Phone(`+1 213 373 4253${' '.repeat(49)}`).normalizedValue,
    '+12133734253',
  );
  rejects(() => normalizeC360Phone('+1 213 373 4253\ud800'), 'PHONE_INVALID');
  const domain = '@example.com';
  rejects(
    () => normalizeC360Email(`${'a'.repeat(513 - domain.length)}${domain}`),
    'EMAIL_TOO_LONG',
  );
  // ไม่มีเพดาน SMTP 64/254 สำหรับการเก็บข้อมูลติดต่อ
  assert.equal(
    normalizeC360Email(`${'a'.repeat(512 - domain.length)}${domain}`).normalizedValue.length,
    512,
  );
  rejects(() => normalizeC360Email('\ud800@example.com'), 'EMAIL_INVALID');
});

test('EMAIL: trim และ lowercase เฉพาะ domain; local tokens คงตามจริง', () => {
  assert.equal(
    normalizeC360Email('  User.Name+Tag@EXAMPLE.COM  ').normalizedValue,
    'User.Name+Tag@example.com',
  );
  assert.equal(normalizeC360Email('"A B"@EXAMPLE.COM').normalizedValue, '"A B"@example.com');
  assert.equal(normalizeC360Email('"A@B"@EXAMPLE.COM').normalizedValue, '"A@B"@example.com');
  assert.equal(normalizeC360Email('"a\\"b"@EXAMPLE.COM').normalizedValue, '"a\\"b"@example.com');
  assert.equal(normalizeC360Email('ผู้ใช้@example.com').normalizedValue, 'ผู้ใช้@example.com');
  assert.equal(normalizeC360Email('😀@example.com').normalizedValue, '😀@example.com');
  assert.equal(normalizeC360Email('User@BÜCHER.DE').normalizedValue, 'User@bücher.de');
});

test('EMAIL: ไม่ทำ key ให้เท่ากันอัตโนมัติ (case/dot/+tag/NFC-NFD/U-label-A-label)', () => {
  const key = (value: string) => normalizeC360Email(value).normalizedValue;
  assert.notEqual(key('User@example.com'), key('user@example.com'));
  assert.notEqual(key('first.last@example.com'), key('firstlast@example.com'));
  assert.notEqual(key('user+tag@example.com'), key('user@example.com'));
  assert.notEqual(key('café@example.com'), key('café@example.com'));
  assert.notEqual(key('a@bücher.de'), key('a@xn--bcher-kva.de'));
});

test('EMAIL: ปฏิเสธ wrapper/list/group/comment/newline/IP/single-label/DNS label ที่ผิด', () => {
  for (const value of [
    'Name <a@b.com>',
    '<a@b.com>',
    'a@b.com, c@d.com',
    'grp: a@b.com;',
    'a(comment)@b.com',
    'a@b.com (comment)',
    'a @b.com',
    'a@b.com\n',
    'a\r@b.com',
    '',
    'not-an-address',
  ])
    rejects(() => normalizeC360Email(value), 'EMAIL_INVALID');
  for (const value of [
    'a@[1.2.3.4]',
    'a@localhost',
    'a@-b.com',
    'a@b-.com',
    'a@xn--zz.com',
    'a@exa_mple.com',
    'a@example。com',
    // IP ในรูป dot-atom และ TLD ตัวเลขล้วนไม่ใช่ DNS name ตาม E1 C
    'a@1.2.3.4',
    'a@example.123',
    `a@${'x'.repeat(64)}.com`,
  ])
    rejects(() => normalizeC360Email(value), 'EMAIL_DOMAIN_INVALID');
  rejects(() => normalizeC360Email('a@b..com'), 'EMAIL_INVALID');
});

test('TAG: Unicode 17 full case fold (C+F) และ NFC ตาม E1', () => {
  const key = (value: string) => normalizeC360TagName(value).nameKey;
  assert.equal(key('VIP'), key('vip'));
  assert.equal(key('Σ'), key('ς'));
  assert.equal(key('Straße'), key('STRASSE'));
  assert.equal(key('É'), key('É'));
  assert.equal(key('İ'), key('i̇'));
  assert.notEqual(key('İ'), key('i'));
  assert.notEqual(key('i'), key('ı'));
  assert.notEqual(key('Ａ'), key('A'));
  assert.equal(key('ﬀ'), key('ff'));
  assert.equal(key('ß'.repeat(80)), 's'.repeat(160));
  // data ต้องไม่ต่ำกว่า Unicode 16: mapping ที่เพิ่มใน 16 (Garay, Latin Extended-D, Cyrillic) ต้องมี
  assert.equal(key('\u{10D50}'), '\u{10D70}');
  assert.equal(key('\uA7DC'), '\u019B');
  assert.equal(key('\u1C89'), '\u1C8A');
  // Latin Extended-D \u0E0A\u0E38\u0E14\u0E43\u0E2B\u0E21\u0E48\u0E17\u0E35\u0E48 package \u0E21\u0E35 mapping (A7CE/A7D2/A7D4): \u0E15\u0E23\u0E36\u0E07\u0E44\u0E27\u0E49\u0E01\u0E31\u0E19\u0E01\u0E32\u0E23 downgrade data
  assert.equal(key('\uA7CE'), '\uA7CF');
  assert.equal(key('\uA7D2'), '\uA7D3');
  assert.equal(key('\uA7D4'), '\uA7D5');
  assert.throws(() => normalizeC360TagName('a'.repeat(81)), C360TagNameError);
});
