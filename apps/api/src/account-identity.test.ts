import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AccountError,
  AccountSecretBox,
  base32,
  generateTotpSecret,
  otpauthUri,
  passwordRulesOf,
} from './account-identity.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

test('a password policy error is mapped to rules[] without passing on the raw message', () => {
  assert.deepEqual(
    passwordRulesOf({
      error: 'invalidPasswordMinUpperCaseCharsMessage',
      error_description: 'Invalid password: must contain at least 1 upper case characters.',
    }),
    [{ rule: 'UPPER_CASE', value: 1 }],
  );
  assert.deepEqual(
    passwordRulesOf({
      error: 'invalidPasswordMinLengthMessage',
      error_description: 'Invalid password: minimum length 12.',
    }),
    [{ rule: 'MIN_LENGTH', value: 12 }],
  );
  assert.deepEqual(passwordRulesOf({ error: 'invalidPasswordHistoryMessage' }), [
    { rule: 'HISTORY' },
  ]);
  assert.deepEqual(passwordRulesOf({ error: 'invalidPasswordSomethingNewMessage' }), [
    { rule: 'OTHER' },
  ]);
  assert.equal(passwordRulesOf({ error: 'unknown_error' }), undefined);
  assert.equal(passwordRulesOf(undefined), undefined);
});

test('Base32 per RFC 4648 (no padding)', () => {
  const vectors: Array<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];
  for (const [input, expected] of vectors) assert.equal(base32(Buffer.from(input)), expected);
});

test('the TOTP secret and otpauth URI match the realm OTP policy and carry no identity system name', () => {
  const secret = generateTotpSecret();
  assert.match(secret, /^[A-Za-z0-9]{20}$/);
  assert.notEqual(secret, generateTotpSecret());
  const uri = new URL(otpauthUri('abc', 'somchai@example.com'));
  assert.equal(uri.protocol, 'otpauth:');
  assert.equal(uri.host, 'totp');
  assert.equal(decodeURIComponent(uri.pathname), '/D-Contact:somchai@example.com');
  assert.deepEqual(Object.fromEntries(uri.searchParams), {
    secret: 'MFRGG',
    issuer: 'D-Contact',
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  assert.doesNotMatch(uri.href, /keycloak/i);
});

test('secret box: decryptable only with the original context, a tampered ciphertext cannot be decrypted, the key must be 32 bytes', () => {
  const box = new AccountSecretBox(KEY);
  const sealed = box.seal('Abc123secret', 'totp:t:u:e1');
  assert.ok(!sealed.includes('Abc123secret'));
  assert.notEqual(sealed, box.seal('Abc123secret', 'totp:t:u:e1'), 'the iv is random every time');
  assert.equal(box.open(sealed, 'totp:t:u:e1'), 'Abc123secret');
  const unavailable = (error: unknown) =>
    error instanceof AccountError && error.code === 'IDENTITY_UNAVAILABLE';
  assert.throws(() => box.open(sealed, 'totp:t:u:e2'), unavailable);
  const parts = sealed.split('.');
  parts[3] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => box.open(parts.join('.'), 'totp:t:u:e1'), unavailable);
  assert.throws(() => box.open('garbage', 'totp:t:u:e1'), unavailable);
  assert.throws(() => new AccountSecretBox(Buffer.alloc(16).toString('base64')), TypeError);
  assert.throws(
    () =>
      new AccountSecretBox(KEY).open(
        new AccountSecretBox(Buffer.alloc(32, 9).toString('base64')).seal('x', 'c'),
        'c',
      ),
    unavailable,
  );
});
