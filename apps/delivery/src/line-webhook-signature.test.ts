import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import {
  LINE_WEBHOOK_MAX_BODY_BYTES,
  lineSignature,
  verifyLineSignature,
} from './line-webhook-signature.js';

const SECRET = 's2-synthetic-channel-secret';

test('S2-LINE signature คิดจาก raw bytes ที่ได้รับจริง รวม whitespace, newline และ emoji', () => {
  const bodies = [
    '{"destination":"Ubot","events":[]}',
    '{"destination":"Ubot",\n  "events": [ ]\n}',
    '{"destination":"Ubot","events":[{"type":"message","text":"ยืนยันแล้ว 🙏"}]}',
    '{"destination":"Ubot","events":[{"type":"message","text":"ยืนยันแล้ว 🙏 "}]}',
  ];
  const digests = bodies.map((body) => lineSignature(Buffer.from(body, 'utf8'), SECRET));
  // ต่างกันแม้ต่างแค่ whitespace ท้ายบรรทัด — reserialize ก่อน verify จึงใช้ไม่ได้
  assert.equal(new Set(digests).size, bodies.length);
  for (const [index, body] of bodies.entries()) {
    const raw = Buffer.from(body, 'utf8');
    assert.ok(verifyLineSignature(raw, SECRET, digests[index]));
    assert.equal(
      digests[index],
      createHmac('sha256', SECRET).update(raw).digest('base64'),
      'ต้องเป็น HMAC-SHA256 base64 ตามสัญญาของ LINE',
    );
  }
});

test('S2-LINE signature ที่ขาด, ผิด, ความยาวต่าง หรือ secret ผิด ไม่ผ่านทั้งหมด', () => {
  const raw = Buffer.from('{"destination":"Ubot","events":[]}', 'utf8');
  const valid = lineSignature(raw, SECRET);
  assert.equal(verifyLineSignature(raw, SECRET, undefined), false);
  assert.equal(verifyLineSignature(raw, SECRET, ''), false);
  assert.equal(verifyLineSignature(raw, SECRET, `${valid}x`), false);
  assert.equal(verifyLineSignature(raw, SECRET, valid.slice(0, -1)), false);
  assert.equal(verifyLineSignature(raw, 'secret-ที่ไม่ใช่ของ-channel-นี้', valid), false);
  assert.equal(verifyLineSignature(Buffer.concat([raw, Buffer.from(' ')]), SECRET, valid), false);
  assert.ok(verifyLineSignature(raw, SECRET, valid));
});

test('S2-LINE เพดาน body ถูกประกาศไว้ให้ ingress ปฏิเสธก่อนอ่าน', () => {
  assert.equal(LINE_WEBHOOK_MAX_BODY_BYTES, 1024 * 1024);
});
