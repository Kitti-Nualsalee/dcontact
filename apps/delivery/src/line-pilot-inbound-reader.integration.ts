/**
 * #566 — รายการข้อความขาเข้าของ LINE pilot บน PostgreSQL/RLS จริง
 *
 * ingress (signature ถูก) → reader เห็นข้อความทันทีโดยไม่มี worker, redelivery event เดิมไม่ซ้ำ,
 * ไม่มี userId/replyToken/webhookEventId ดิบใน item และ audit หนึ่งแถวต่อการอ่านโดยไม่มีเนื้อหา
 */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { LineAuditRepository } from './line-audit-repository.js';
import {
  LinePilotInboundCursorError,
  LinePilotInboundReader,
  LINE_PILOT_INBOUND_VIEWED,
} from './line-pilot-inbound-reader.js';
import {
  createLinePersistenceFixture,
  PILOT_CHANNEL_ACCOUNT_ID,
} from './line-persistence-fixture.js';
import { LineWebhookIngress } from './line-webhook-ingress.js';
import { EncryptedLineWebhookPayloadVault } from './line-webhook-payload-vault.js';
import { lineSignature } from './line-webhook-signature.js';

const SECRET = 's2-synthetic-channel-secret';
const DESTINATION = 'U1234567890abcdef1234567890abcdef';
const KEY_REF = 'd-contact.line.webhook-payload/v1';
const PAYLOAD_KEY = randomBytes(32);
const SENDER = `U${'b'.repeat(32)}`;

function event(id: string, message: Record<string, unknown>, timestamp: number) {
  return {
    type: 'message',
    mode: 'active',
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    timestamp,
    replyToken: 'synthetic-reply-token-0001',
    source: { type: 'user', userId: SENDER },
    message,
  };
}

function request(events: unknown[]) {
  const rawBody = Buffer.from(JSON.stringify({ destination: DESTINATION, events }), 'utf8');
  return { rawBody, signature: lineSignature(rawBody, SECRET), receivedAt: new Date() };
}

test('#566 reader: ข้อความจาก ingress เห็นทันที ไม่มี ID ดิบ redelivery ไม่ซ้ำ และ audit ทุกการอ่าน', async (t) => {
  const fixture = await createLinePersistenceFixture();
  t.after(() => fixture.dispose());
  const tenantId = fixture.tenantA;
  const ingress = new LineWebhookIngress(fixture.application, {
    tenantId,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    destination: DESTINATION,
    channelSecret: SECRET,
    payloadKeyRef: KEY_REF,
    payloadKey: PAYLOAD_KEY,
  });
  const text = event(
    '01JW566TEXT001',
    { id: '566000000001', type: 'text', text: 'ทดสอบรับ' },
    1_790_000_000_001,
  );
  const sticker = event(
    '01JW566STKR001',
    { id: '566000000002', type: 'sticker', packageId: '1', stickerId: '1' },
    1_790_000_000_002,
  );
  assert.equal((await ingress.handle(request([text, sticker]))).status, 200);
  // redelivery ของ event เดิม
  assert.equal(
    (await ingress.handle(request([{ ...text, deliveryContext: { isRedelivery: true } }]))).status,
    200,
  );

  const vault = new EncryptedLineWebhookPayloadVault(fixture.application, {
    key: (ref) => (ref === KEY_REF ? PAYLOAD_KEY : undefined),
  });
  const reader = new LinePilotInboundReader(
    fixture.application,
    vault,
    new LineAuditRepository(fixture.application),
    { tenantId, channelAccountId: PILOT_CHANNEL_ACCOUNT_ID },
  );
  const actorRef = '619b9c43-8495-420d-b3d3-34d9fd0b5b89';
  const page = await reader.list({ actorRef, limit: 10 });
  assert.equal(page.items.length, 2);
  assert.equal(page.quarantined, 0);
  assert.equal(page.nextCursor, null);
  const byType = Object.fromEntries(page.items.map((item) => [item.messageType, item]));
  assert.equal(byType.text?.text, 'ทดสอบรับ');
  assert.equal(byType.sticker?.text, null);
  assert.equal(byType.text?.senderFingerprint?.length, 12);
  const serialized = JSON.stringify(page);
  for (const forbidden of [SENDER, 'synthetic-reply-token', '01JW566', '566000000001']) {
    assert.ok(!serialized.includes(forbidden), forbidden);
  }

  // หน้าละ 1 รายการ: cursor พาไปรายการถัดไปและหมดที่หน้า 2
  const first = await reader.list({ actorRef, limit: 1 });
  assert.ok(first.nextCursor);
  const second = await reader.list({ actorRef, limit: 1, before: first.nextCursor! });
  assert.notEqual(second.items[0]?.id, first.items[0]?.id);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    reader.list({ actorRef, limit: 1, before: 'bm90LWEtY3Vyc29y' }),
    LinePilotInboundCursorError,
  );

  const audits = await fixture.owner.dlLineAuditEvent.findMany({
    where: { tenantId, code: LINE_PILOT_INBOUND_VIEWED },
  });
  assert.equal(audits.length, 3);
  for (const audit of audits) {
    assert.equal(audit.category, 'WEBHOOK');
    assert.equal(audit.actorRef, actorRef);
    assert.match(audit.evidenceDigest ?? '', /^[a-f0-9]{64}$/);
  }

  // tenant อื่นไม่เห็นข้อมูลของ binding นี้ (RLS)
  const other = new LinePilotInboundReader(
    fixture.application,
    vault,
    new LineAuditRepository(fixture.application),
    { tenantId: fixture.tenantB, channelAccountId: PILOT_CHANNEL_ACCOUNT_ID },
  );
  assert.equal((await other.list({ actorRef, limit: 10 })).items.length, 0);
});
