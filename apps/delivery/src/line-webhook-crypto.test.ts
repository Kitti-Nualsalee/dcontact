/**
 * S2.5 (#369): signature, protected payload และ postback token — ไม่มี database/network
 * ครอบ `S2-LINE-F03` (raw-byte HMAC) และส่วน crypto ของ `S2-LINE-OB02`/`S2-LINE-TI01`
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { inspect } from 'node:util';
import { LinePostbackTokenCodec } from './line-postback-token.js';
import {
  LineProtectedPayloadError,
  StaticLinePayloadKeyring,
  openLinePayload,
  sealLinePayload,
} from './line-protected-payload.js';
import {
  LineChannelSecret,
  lineRecipientFingerprint,
  verifyLineSignature,
} from './line-webhook-signature.js';

const SECRET_VALUE = 'synthetic-channel-secret-for-tests';
const secret = new LineChannelSecret(SECRET_VALUE);
const sign = (body: Buffer) => createHmac('sha256', SECRET_VALUE).update(body).digest('base64');

test('HMAC ใช้ raw bytes ตรงตัว: whitespace, newline และ emoji ที่ต่างกันหนึ่ง byte ทำให้ไม่ผ่าน', () => {
  const bodies = [
    '{"destination":"U0","events":[]}',
    '{ "destination" : "U0",\n  "events": [] }\n',
    '{"destination":"U0","events":[],"note":"สวัสดี 👋🏽"}',
  ].map((text) => Buffer.from(text, 'utf8'));
  for (const body of bodies) {
    assert.equal(verifyLineSignature(body, sign(body), secret), true);
    const altered = Buffer.concat([body, Buffer.from(' ')]);
    assert.equal(verifyLineSignature(altered, sign(body), secret), false);
  }
  // reserialize แล้ว byte เปลี่ยน = signature เดิมใช้ไม่ได้ จึงห้าม parse ก่อน verify
  const pretty = bodies[1]!;
  const normalized = Buffer.from(JSON.stringify(JSON.parse(pretty.toString('utf8'))), 'utf8');
  assert.equal(verifyLineSignature(normalized, sign(pretty), secret), false);
});

test('signature หาย, ไม่ใช่ base64, ยาวผิด หรือใช้ secret อื่น เป็น invalid แบบเดียวกัน', () => {
  const body = Buffer.from('{"destination":"U0","events":[]}');
  assert.equal(verifyLineSignature(body, undefined, secret), false);
  assert.equal(verifyLineSignature(body, '', secret), false);
  assert.equal(verifyLineSignature(body, 'not base64!!', secret), false);
  assert.equal(verifyLineSignature(body, Buffer.alloc(16).toString('base64'), secret), false);
  const foreign = createHmac('sha256', 'other-secret').update(body).digest('base64');
  assert.equal(verifyLineSignature(body, foreign, secret), false);
});

test('channel secret, keyring และ postback codec ไม่เคย serialize ค่าออกมา', () => {
  const key = randomBytes(32);
  const keyring = new StaticLinePayloadKeyring(1, new Map([[1, key]]));
  const codec = new LinePostbackTokenCodec(key);
  for (const holder of [secret, keyring, codec]) {
    const rendered = [String(holder), JSON.stringify({ holder }), inspect(holder, { depth: 5 })];
    for (const text of rendered) {
      assert.match(text, /REDACTED/);
      assert.ok(!text.includes(SECRET_VALUE));
      assert.ok(!text.includes(key.toString('hex')));
      assert.ok(!text.includes(key.toString('base64')));
    }
  }
});

test('protected payload: เปิดได้เฉพาะ tenant+ref เดิม แก้ byte เดียวหรือย้ายแถวก็เปิดไม่ได้', () => {
  const keyring = new StaticLinePayloadKeyring(1, new Map([[1, randomBytes(32)]]));
  const plaintext = Buffer.from('{"source":{"userId":"U0123"},"message":{"text":"ลับ"}}');
  const sealed = sealLinePayload(keyring, 'tenant-a', 'lwp:ref-000001', plaintext);

  assert.deepEqual(openLinePayload(keyring, 'tenant-a', sealed), plaintext);
  assert.ok(!sealed.ciphertext.includes(Buffer.from('U0123')));
  assert.ok(!sealed.ciphertext.includes(Buffer.from('ลับ')));

  const tampered = Buffer.from(sealed.ciphertext);
  tampered[0] = tampered[0]! ^ 1;
  const cases = [
    () => openLinePayload(keyring, 'tenant-b', sealed),
    () => openLinePayload(keyring, 'tenant-a', { ...sealed, payloadRef: 'lwp:ref-000002' }),
    () => openLinePayload(keyring, 'tenant-a', { ...sealed, ciphertext: tampered }),
    () => openLinePayload(keyring, 'tenant-a', { ...sealed, keyVersion: 9 }),
  ];
  for (const open of cases) assert.throws(open, LineProtectedPayloadError);

  // nonce สุ่มต่อครั้ง: plaintext เดิมไม่ได้ ciphertext เดิม
  const again = sealLinePayload(keyring, 'tenant-a', 'lwp:ref-000001', plaintext);
  assert.notDeepEqual(again.ciphertext, sealed.ciphertext);
});

test('protected payload: หมุนกุญแจแล้วแถวเก่ายังเปิดด้วย version ของมัน', () => {
  const oldKey = randomBytes(32);
  const before = new StaticLinePayloadKeyring(1, new Map([[1, oldKey]]));
  const sealed = sealLinePayload(before, 't', 'lwp:ref-rotate', Buffer.from('payload'));
  const after = new StaticLinePayloadKeyring(
    2,
    new Map([
      [1, oldKey],
      [2, randomBytes(32)],
    ]),
  );
  assert.equal(openLinePayload(after, 't', sealed).toString(), 'payload');
  assert.equal(sealLinePayload(after, 't', 'lwp:ref-new', Buffer.from('x')).keyVersion, 2);
  assert.throws(() => new StaticLinePayloadKeyring(1, new Map([[1, randomBytes(16)]])), TypeError);
});

test('postback token: ผูก delivery/config/expiry, แก้หรือใช้กุญแจอื่นไม่ผ่าน และหมดอายุตาม provider timestamp', () => {
  const codec = new LinePostbackTokenCodec(randomBytes(32));
  const expiresAt = new Date('2026-09-23T12:00:00.000Z');
  const token = codec.issue({ deliveryId: 'dlv_1', configDigest: 'a'.repeat(64), expiresAt });
  assert.ok(token.length <= 300);

  const valid = codec.verify(token, new Date('2026-09-23T11:59:59.000Z'));
  assert.deepEqual(valid, {
    status: 'VALID',
    claims: { deliveryId: 'dlv_1', configDigest: 'a'.repeat(64), expiresAt },
  });
  assert.deepEqual(codec.verify(token, expiresAt), { status: 'EXPIRED' });

  const [prefix, body, mac] = token.split('.') as [string, string, string];
  const forged = Buffer.from(
    JSON.stringify({ d: 'dlv_2', c: 'a'.repeat(64), e: expiresAt.getTime(), n: 'x' }),
  ).toString('base64url');
  assert.deepEqual(codec.verify(`${prefix}.${forged}.${mac}`, new Date(0)), { status: 'INVALID' });
  assert.deepEqual(codec.verify(`${prefix}.${body}.${mac.slice(1)}`, new Date(0)), {
    status: 'INVALID',
  });
  assert.deepEqual(new LinePostbackTokenCodec(randomBytes(32)).verify(token, new Date(0)), {
    status: 'INVALID',
  });
  assert.deepEqual(codec.verify('action=buy&item=1', new Date(0)), { status: 'INVALID' });
});

test('recipient fingerprint คงที่ต่อ channel+user และต่าง channel ได้คนละค่า', () => {
  const userId = `U${'0123456789abcdef'.repeat(2)}`;
  const value = lineRecipientFingerprint('2007056595', userId);
  assert.match(value, /^[a-f0-9]{64}$/);
  assert.equal(lineRecipientFingerprint('2007056595', userId), value);
  assert.notEqual(lineRecipientFingerprint('2007056596', userId), value);
  assert.ok(!value.includes(userId.slice(1)));
});
