import assert from 'node:assert/strict';
import test from 'node:test';
import { C360TagNameError, normalizeC360TagName } from './profile-tags.js';

const key = (value: string) => normalizeC360TagName(value).nameKey;

test('tag key vectors ตาม E1: full case fold แบบ C+F และ NFC', () => {
  assert.equal(key('VIP'), key('vip'));
  assert.equal(key('Σ'), key('σ'));
  assert.equal(key('Σ'), key('ς'));
  assert.equal(key('Straße'), key('STRASSE'));
  assert.equal(key('É'), key('É'));
  assert.equal(key('É'), key('é'));
  assert.equal(key('İ'), key('i̇'));
  assert.notEqual(key('İ'), key('i'));
  assert.notEqual(key('i'), key('ı'));
  assert.notEqual(key('Ａ'), key('A'));
  assert.equal(key('ﬀ'), key('ff'));
  assert.equal(normalizeC360TagName('  VIP  ').name, 'VIP');
});

test('ß 80 ตัวมี key 160 ตัวและไม่ถูกตัด; ชื่อเกิน 80 UTF-16 ถูกปฏิเสธก่อน fold', () => {
  const long = 'ß'.repeat(80);
  assert.equal(key(long), 's'.repeat(160));
  assert.throws(
    () => normalizeC360TagName('a'.repeat(81)),
    (error) => error instanceof C360TagNameError && error.code === 'TAG_NAME_TOO_LONG',
  );
  // non-BMP นับตาม UTF-16: 40 ตัว = 80 code units ผ่าน, 41 ตัวไม่ผ่าน
  assert.doesNotThrow(() => normalizeC360TagName('😀'.repeat(40)));
  assert.throws(() => normalizeC360TagName('😀'.repeat(41)), C360TagNameError);
});

test('ปฏิเสธชื่อว่าง, lone surrogate, CR/LF และค่าที่ไม่ใช่ string', () => {
  for (const value of ['', '   ', '\ud800', 'a\nb', 'a\rb', 42, null]) {
    assert.throws(
      () => normalizeC360TagName(value),
      (error) => error instanceof C360TagNameError && error.code === 'TAG_NAME_INVALID',
    );
  }
});
