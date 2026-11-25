import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  LINE_WEBHOOK_MAX_BODY_BYTES,
  lineSignature,
  verifyLineSignature,
} from './line-webhook-signature.js';

const SECRET = 's2-synthetic-channel-secret';

test('S2-LINE signature is computed from the raw bytes actually received, including whitespace, newline and emoji', () => {
  const bodies = [
    '{"destination":"Ubot","events":[]}',
    '{"destination":"Ubot",\n  "events": [ ]\n}',
    '{"destination":"Ubot","events":[{"type":"message","text":"ยืนยันแล้ว 🙏"}]}', // allow-thai: non-ASCII raw-byte signature input
    '{"destination":"Ubot","events":[{"type":"message","text":"ยืนยันแล้ว 🙏 "}]}', // allow-thai: non-ASCII raw-byte signature input
  ];
  const digests = bodies.map((body) => lineSignature(Buffer.from(body, 'utf8'), SECRET));
  // they differ even when the difference is only trailing whitespace — so re-serializing before verify is unusable
  assert.equal(new Set(digests).size, bodies.length);
  for (const [index, body] of bodies.entries()) {
    const raw = Buffer.from(body, 'utf8');
    assert.ok(verifyLineSignature(raw, SECRET, digests[index]));
    assert.equal(
      digests[index],
      createHmac('sha256', SECRET).update(raw).digest('base64'),
      'must be HMAC-SHA256 base64 per the LINE contract',
    );
  }
});

test('S2-LINE a missing signature, a wrong one, a different length or a wrong secret all fail', () => {
  const raw = Buffer.from('{"destination":"Ubot","events":[]}', 'utf8');
  const valid = lineSignature(raw, SECRET);
  assert.equal(verifyLineSignature(raw, SECRET, undefined), false);
  assert.equal(verifyLineSignature(raw, SECRET, ''), false);
  assert.equal(verifyLineSignature(raw, SECRET, `${valid}x`), false);
  assert.equal(verifyLineSignature(raw, SECRET, valid.slice(0, -1)), false);
  assert.equal(verifyLineSignature(raw, 'secret-ที่ไม่ใช่ของ-channel-นี้', valid), false); // allow-thai: non-ASCII wrong-secret input
  assert.equal(verifyLineSignature(Buffer.concat([raw, Buffer.from(' ')]), SECRET, valid), false);
  assert.ok(verifyLineSignature(raw, SECRET, valid));
});

test('S2-LINE the body ceiling is declared so ingress rejects before reading', () => {
  assert.equal(LINE_WEBHOOK_MAX_BODY_BYTES, 1024 * 1024);
});
