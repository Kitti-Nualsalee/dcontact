import assert from 'node:assert/strict';
import test from 'node:test';
import {
  C360ReadError,
  c360CursorCodecFromEnv,
  c360FilterDigest,
  c360ScopeDigest,
  createC360CursorCodec,
  maskC360Channel,
  parseC360SearchInput,
  type C360CursorKey,
} from './profile-read.js';

const key = (id: string, byte: number): C360CursorKey => ({ id, key: Buffer.alloc(32, byte) });
const actor = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'ADMIN' as const,
  teamId: null,
};
const expected = {
  kind: 'directory',
  tenantId: actor.tenantId,
  userId: actor.userId,
  filter: c360FilterDigest(['NAME', 'somchai']),
  scope: c360ScopeDigest(actor),
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof C360ReadError) return `${error.status}:${error.code}`;
    throw error;
  }
  return 'OK';
}

test('cursor: seal/open ได้ตำแหน่งเดิม และไม่มี raw query/ID อ่านได้ใน token', () => {
  let now = 1_000;
  const codec = createC360CursorCodec([key('k1', 1)], () => now);
  const token = codec.seal({ ...expected, position: ['2026-11-03T00:00:00.000000', 'id-1'] });
  assert.deepEqual(codec.open(token, expected), ['2026-11-03T00:00:00.000000', 'id-1']);
  const decoded = Buffer.from(token.split('.')[2]!, 'base64url').toString('utf8');
  assert.equal(decoded.includes(actor.userId), false);
  assert.equal(decoded.includes('somchai'), false);
  now += 15 * 60_000 - 1;
  assert.deepEqual(codec.open(token, expected).length, 2);
  now += 1;
  assert.equal(
    code(() => codec.open(token, expected)),
    '410:CURSOR_EXPIRED',
  );
});

test('cursor: tamper, ข้าม actor/tenant/filter/scope/kind และ key ที่ไม่รู้จักถูกปฏิเสธ', () => {
  const codec = createC360CursorCodec([key('k1', 1)]);
  const token = codec.seal({ ...expected, position: ['a', 'b'] });
  const [v, k, data] = token.split('.') as [string, string, string];
  const flipped = Buffer.from(data, 'base64url');
  flipped[20] = (flipped[20] ?? 0) ^ 1;
  for (const bad of [
    `${v}.${k}.${flipped.toString('base64url')}`,
    `${v}.${k}.${data}.x`,
    `v2.${k}.${data}`,
    `${v}.zz.${data}`,
    'garbage',
    '',
  ])
    assert.equal(
      code(() => codec.open(bad, expected)),
      '400:CURSOR_INVALID',
    );
  for (const mismatch of [
    { userId: '33333333-3333-4333-8333-333333333333' },
    { tenantId: '33333333-3333-4333-8333-333333333333' },
    { filter: c360FilterDigest(['NAME', 'other']) },
    { scope: c360ScopeDigest({ ...actor, teamId: '33333333-3333-4333-8333-333333333333' }) },
    { kind: 'timeline' },
  ])
    assert.equal(
      code(() => codec.open(token, { ...expected, ...mismatch })),
      '400:CURSOR_INVALID',
    );
  // key อื่นถอดไม่ได้แม้ใช้ id เดียวกัน
  assert.equal(
    code(() => createC360CursorCodec([key('k1', 2)]).open(token, expected)),
    '400:CURSOR_INVALID',
  );
});

test('cursor: key rotation ถอด token ของ key เก่าได้จนหมดอายุ แต่ออก token ใหม่ด้วย key แรก', () => {
  const oldCodec = createC360CursorCodec([key('k1', 1)]);
  const rotated = createC360CursorCodec([key('k2', 2), key('k1', 1)]);
  const oldToken = oldCodec.seal({ ...expected, position: ['a', 'b'] });
  assert.deepEqual(rotated.open(oldToken, expected), ['a', 'b']);
  assert.match(rotated.seal({ ...expected, position: ['a', 'b'] }), /^v1\.k2\./);
  assert.throws(() => createC360CursorCodec([]), TypeError);
  assert.throws(
    () => createC360CursorCodec([key('k1', 1), key('k1', 2)]),
    TypeError,
    'duplicate id',
  );
  assert.throws(() => createC360CursorCodec([{ id: 'k', key: Buffer.alloc(16) }]), TypeError);
});

test('search input: strict allowlist, ชนิด, ความยาว และข้อความ error ไม่สะท้อนค่าที่กรอก', () => {
  assert.deepEqual(parseC360SearchInput({}), {
    type: 'DIRECTORY',
    key: null,
    limit: 20,
    cursor: null,
  });
  assert.deepEqual(parseC360SearchInput({ type: 'NAME', query: '  Somchai  ', limit: 100 }), {
    type: 'NAME',
    key: 'Somchai',
    limit: 100,
    cursor: null,
  });
  // NFC: ก + สระ รวมเป็นรูปเดียวกัน
  assert.equal(parseC360SearchInput({ type: 'NAME', query: 'ée' }).key, 'ée');
  const rejected: [unknown, string][] = [
    [null, 'body'],
    [[], 'body'],
    [{ other: 1 }, 'other'],
    [{ type: 'FUZZY', query: 'ab' }, 'type'],
    [{ type: 'NAME' }, 'query'],
    [{ type: 'NAME', query: 'a' }, 'query'],
    [{ type: 'NAME', query: 'x'.repeat(161) }, 'query'],
    [{ type: 'NAME', query: 'ab\ncd' }, 'query'],
    [{ type: 'NAME', query: 'ab\ud800' }, 'query'],
    [{ type: 'DIRECTORY', query: 'abc' }, 'query'],
    [{ limit: 0 }, 'limit'],
    [{ limit: 101 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ limit: '5' }, 'limit'],
    [{ cursor: '' }, 'cursor'],
    [{ cursor: 5 }, 'cursor'],
  ];
  for (const [input, field] of rejected) {
    try {
      parseC360SearchInput(input);
      assert.fail(`ต้องปฏิเสธ ${JSON.stringify(input)}`);
    } catch (error) {
      assert.ok(error instanceof C360ReadError);
      assert.equal(error.status, 400);
      assert.equal(error.fieldErrors?.[0]?.field, field);
      assert.equal(JSON.stringify(error.fieldErrors).includes('ab'), false);
    }
  }
});

test('search input: PHONE ต้องเป็นรูปแบบสากล ไม่เดาประเทศ ไม่ fallback digits-only', () => {
  for (const [input, key] of [
    ['+1 213 373 4253', '+12133734253'],
    ['+66 (2) 123-4567', '+6621234567'],
    ['  +44.20.7946.0958 ', '+442079460958'],
  ] as const)
    assert.equal(parseC360SearchInput({ type: 'PHONE', query: input }).key, key);
  for (const input of [
    '0812345678',
    '(213) 373-4253',
    'Call: +12133734253',
    'tel:+12133734253',
    '+12133734253;ext=1',
    '+1 213 373 4253 x12',
    '911',
    '*555',
    '+0123456789',
    '+1234567',
    `+${'1'.repeat(16)}`,
    `+${'1'.repeat(70)}`,
  ])
    assert.equal(
      code(() => parseC360SearchInput({ type: 'PHONE', query: input })),
      '400:VALIDATION_FAILED',
      input,
    );
});

test('search input: EMAIL คง local ตามเดิม lowercase เฉพาะ domain และปฏิเสธรูปแบบที่ไม่ใช่ addr-spec เดี่ยว', () => {
  const key = (query: string) => parseC360SearchInput({ type: 'EMAIL', query }).key;
  assert.equal(key('  User.Name+Tag@EXAMPLE.COM  '), 'User.Name+Tag@example.com');
  assert.equal(key('"A@B"@EXAMPLE.COM'), '"A@B"@example.com');
  assert.equal(key('"A B"@EXAMPLE.COM'), '"A B"@example.com');
  assert.equal(key('User@BÜCHER.DE'), 'User@bücher.de');
  for (const query of [
    'plain',
    '@example.com',
    'a@b',
    'a@.com',
    'a@example..com',
    'a b@example.com',
    'a@exa mple.com',
    'a@example.com\n',
    'a@example.com,b@example.com'.replace(',', '\r'),
    `${'a'.repeat(510)}@b.c`,
  ])
    assert.equal(
      code(() => parseC360SearchInput({ type: 'EMAIL', query })),
      '400:VALIDATION_FAILED',
      query,
    );
});

test('mask: ไม่คืนค่าเต็มของ channel', () => {
  assert.equal(maskC360Channel('PHONE', '+12133734253'), '+12•••••4253');
  assert.equal(maskC360Channel('EMAIL', 'User.Name@example.com'), 'U•••@example.com');
});

test('cursor key จาก env: ไม่มี key ใน production แจ้งเตือน (ไม่ใช่เงียบ) และ key ที่ตั้งไว้ใช้งานได้', () => {
  const warnings: string[] = [];
  const original = process.emitWarning;
  process.emitWarning = ((message: string) => {
    warnings.push(String(message));
  }) as typeof process.emitWarning;
  try {
    c360CursorCodecFromEnv({ NODE_ENV: 'production' });
    assert.equal(warnings.length, 1);
    c360CursorCodecFromEnv({ NODE_ENV: 'development' });
    c360CursorCodecFromEnv({
      NODE_ENV: 'production',
      CUSTOMER_360_CURSOR_KEYS: `a:${Buffer.alloc(32, 1).toString('base64')}`,
    });
    assert.equal(warnings.length, 1);
    assert.throws(
      () =>
        c360CursorCodecFromEnv({
          CUSTOMER_360_CURSOR_KEYS: `a:${Buffer.alloc(32, 1).toString('base64')},a:${Buffer.alloc(32, 2).toString('base64')}`,
        }),
      TypeError,
    );
  } finally {
    process.emitWarning = original;
  }
});
