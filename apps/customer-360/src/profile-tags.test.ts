import assert from 'node:assert/strict';
import test from 'node:test';
import type { C360TagName } from './index.js';
import { C360TagNameError, normalizeC360TagName } from './profile-tags.js';

const key = (value: string) => normalizeC360TagName(value).nameKey;

test('tag key vectors per E1: full case fold (C+F) and NFC', () => {
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
  const result: C360TagName = normalizeC360TagName('  VIP  ');
  assert.equal(result.name, 'VIP');
});

test('80 ß characters give a 160-character key and are not truncated; a name over 80 UTF-16 units is rejected before fold', () => {
  const long = 'ß'.repeat(80);
  assert.equal(key(long), 's'.repeat(160));
  assert.throws(
    () => normalizeC360TagName('a'.repeat(81)),
    (error) => error instanceof C360TagNameError && error.code === 'TAG_NAME_TOO_LONG',
  );
  // non-BMP counts by UTF-16: 40 characters = 80 code units passes, 41 characters fails
  assert.doesNotThrow(() => normalizeC360TagName('😀'.repeat(40)));
  assert.throws(() => normalizeC360TagName('😀'.repeat(41)), C360TagNameError);
});

test('rejects an empty name, lone surrogate, CR/LF and non-string values', () => {
  for (const value of ['', '   ', '\ud800', 'a\nb', 'a\rb', 42, null]) {
    assert.throws(
      () => normalizeC360TagName(value),
      (error) => error instanceof C360TagNameError && error.code === 'TAG_NAME_INVALID',
    );
  }
});
