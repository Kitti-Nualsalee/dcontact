/**
 * S2.5 (#369): ingress ของ `POST /webhook/line` กับ repository ปลอม — พิสูจน์ลำดับ
 * method/type/size → signature → parse → atomic persist → ack โดยไม่มี database
 * ครอบ `S2-LINE-F03` และ `S2-LINE-OB02` ส่วน "invalid signature ห้าม parse/process/persist"
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import {
  LINE_WEBHOOK_MAX_BODY_BYTES,
  LineWebhookIngress,
  type LineWebhookRequest,
} from './line-webhook-ingress.js';
import {
  LINE_KNOWN_EVENT_TYPES,
  interpretLineEvent,
  parseLineWebhook,
} from './line-webhook-event.js';
import { StaticLinePayloadKeyring, openLinePayload } from './line-protected-payload.js';
import type { AcceptLineWebhookBatchInput } from './line-webhook-repository.js';
import { LineChannelSecret } from './line-webhook-signature.js';
import { LineWebhookRuntimeConfigError, lineWebhookConfigFromEnv } from './line-webhook-runtime.js';

const SECRET = 'synthetic-channel-secret-for-tests';
const TENANT = '11111111-2222-4333-8444-555555555555';
const DESTINATION = `U${'f'.repeat(32)}`;
const USER = `U${'1'.repeat(32)}`;
const keyring = new StaticLinePayloadKeyring(1, new Map([[1, randomBytes(32)]]));

function event(id: string, overrides: Record<string, unknown> = {}) {
  return {
    type: 'message',
    message: {
      id: '468789577898262530',
      type: 'text',
      text: 'ข้อความลับของลูกค้า',
      quoteToken: 'q-token-secret',
    },
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    timestamp: 1_758_620_000_000,
    source: { type: 'user', userId: USER },
    replyToken: 'reply-token-secret',
    mode: 'active',
    ...overrides,
  };
}

function signed(payload: unknown, sign = true): LineWebhookRequest {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    method: 'POST',
    contentType: 'application/json; charset=utf-8',
    signature: sign ? createHmac('sha256', SECRET).update(rawBody).digest('base64') : 'invalid',
    rawBody,
    receivedAt: new Date('2026-09-23T10:00:00.000Z'),
  };
}

function harness(fail = false) {
  const calls: AcceptLineWebhookBatchInput[] = [];
  const ingress = new LineWebhookIngress({
    binding: {
      tenantId: TENANT,
      channelAccountId: '2007056595',
      expectedDestination: DESTINATION,
      secret: new LineChannelSecret(SECRET),
    },
    keyring,
    repository: {
      async acceptBatch(input) {
        calls.push(input);
        if (fail) throw new Error('connection refused while writing webhook');
        return input.events.map((entry) => ({
          webhookEventId: entry.webhookEventId,
          inboxEntryId: entry.id,
          code: 'WEBHOOK_ACCEPTED' as const,
        }));
      },
    },
  });
  return { ingress, calls };
}

test('request ที่ไม่ใช่ POST/JSON หรือใหญ่เกินถูกปัดก่อนดู signature และไม่แตะ repository', async () => {
  const { ingress, calls } = harness();
  const base = signed({ destination: DESTINATION, events: [] });
  assert.equal((await ingress.handle({ ...base, method: 'GET' })).status, 405);
  assert.equal((await ingress.handle({ ...base, contentType: 'text/plain' })).status, 415);
  assert.equal((await ingress.handle({ ...base, contentType: undefined })).status, 415);
  const huge = { ...base, rawBody: Buffer.alloc(LINE_WEBHOOK_MAX_BODY_BYTES + 1, 0x20) };
  assert.equal((await ingress.handle(huge)).status, 413);
  assert.equal(calls.length, 0);
});

test('signature ผิดหรือหาย = fixed 401 โดยไม่ parse และไม่ persist แม้ body จะพังหรือถูกต้อง', async () => {
  const { ingress, calls } = harness();
  const valid = signed(
    { destination: DESTINATION, events: [event('01J8Z0000000000000000000A1')] },
    false,
  );
  const garbage = { ...valid, rawBody: Buffer.from('{not json') };
  for (const request of [valid, garbage, { ...valid, signature: undefined }]) {
    assert.deepEqual(await ingress.handle(request), {
      status: 401,
      code: 'WEBHOOK_SIGNATURE_INVALID',
    });
  }
  assert.equal(calls.length, 0);
});

test('verify request `{events: []}` ตอบ 200 โดยไม่สร้างแถวใด', async () => {
  const { ingress, calls } = harness();
  assert.deepEqual(await ingress.handle(signed({ destination: DESTINATION, events: [] })), {
    status: 200,
    code: 'WEBHOOK_EMPTY_VERIFICATION',
  });
  assert.equal(calls.length, 0);
});

test('multi-event ถูก persist เป็น batch เดียว พร้อม ciphertext ต่อ event และไม่มี plaintext หลุดลง row', async () => {
  const { ingress, calls } = harness();
  const events = [
    event('01J8Z0000000000000000000A1'),
    event('01J8Z0000000000000000000A2', { type: 'follow', message: undefined }),
    event('01J8Z0000000000000000000A3', { type: 'brandNewType', extra: { nested: true } }),
  ];
  const result = await ingress.handle(signed({ destination: DESTINATION, events }));
  assert.equal(result.status, 200);
  assert.deepEqual(result.counts, { WEBHOOK_ACCEPTED: 3 });
  assert.equal(calls.length, 1);

  const batch = calls[0]!;
  assert.equal(batch.events.length, 3);
  assert.equal(batch.payloads?.length, 3);
  assert.equal(batch.quarantineAccepted, undefined);
  // type ที่ไม่รู้จักยังเก็บได้ (forward-compatible) — worker เป็นผู้ quarantine
  assert.equal(batch.events[2]!.eventType, 'brandNewType');

  const rows = JSON.stringify(batch.events);
  for (const secretish of [USER, 'ข้อความลับของลูกค้า', 'reply-token-secret', 'q-token-secret']) {
    assert.ok(!rows.includes(secretish), `inbox row รั่ว ${secretish}`);
    for (const payload of batch.payloads!) {
      assert.ok(!payload.ciphertext.includes(Buffer.from(secretish)));
    }
  }
  const opened = openLinePayload(keyring, TENANT, batch.payloads![0]!);
  assert.equal(JSON.parse(opened.toString('utf8')).replyToken, 'reply-token-secret');
  assert.equal(batch.events[0]!.protectedPayloadRef, batch.payloads![0]!.payloadRef);
});

test('redelivery ของ event เดิมได้ payload ref และ hash เดิม ส่วน payload ต่างได้ ref ใหม่', async () => {
  const { ingress, calls } = harness();
  const original = event('01J8Z0000000000000000000B1');
  await ingress.handle(signed({ destination: DESTINATION, events: [original] }));
  // LINE ส่งซ้ำด้วย isRedelivery=true — ต้องยังเป็น duplicate ไม่ใช่ conflict
  await ingress.handle(
    signed({
      destination: DESTINATION,
      events: [{ ...original, deliveryContext: { isRedelivery: true } }],
    }),
  );
  await ingress.handle(
    signed({
      destination: DESTINATION,
      events: [{ ...original, timestamp: original.timestamp + 1 }],
    }),
  );
  const [first, again, changed] = calls.map((call) => call.events[0]!);
  assert.equal(again!.payloadHash, first!.payloadHash);
  assert.equal(again!.protectedPayloadRef, first!.protectedPayloadRef);
  assert.notEqual(changed!.payloadHash, first!.payloadHash);
  assert.notEqual(changed!.protectedPayloadRef, first!.protectedPayloadRef);
});

test('destination ไม่ตรง binding ยังเก็บและ ack แต่สั่ง quarantine ทั้ง request', async () => {
  const { ingress, calls } = harness();
  const result = await ingress.handle(
    signed({ destination: `U${'a'.repeat(32)}`, events: [event('01J8Z0000000000000000000C1')] }),
  );
  assert.equal(result.status, 200);
  assert.equal(result.code, 'WEBHOOK_DESTINATION_MISMATCH');
  assert.equal(calls[0]!.quarantineAccepted, 'WEBHOOK_DESTINATION_MISMATCH');
});

test('envelope ที่ลงนามถูกแต่ขาด field ของ inbox เป็น 400 และ durability ล้มเป็น 503', async () => {
  const { ingress, calls } = harness();
  const invalid = [
    { events: [] },
    { destination: DESTINATION, events: [event('bad id with spaces')] },
    { destination: DESTINATION, events: [event('01J8Z0000000000000000000D1', { mode: 'other' })] },
    {
      destination: DESTINATION,
      events: [event('01J8Z0000000000000000000D2'), event('01J8Z0000000000000000000D2')],
    },
  ];
  for (const payload of invalid) {
    assert.equal((await ingress.handle(signed(payload))).status, 400);
  }
  assert.equal(calls.length, 0);

  const failing = harness(true);
  const result = await failing.ingress.handle(
    signed({ destination: DESTINATION, events: [event('01J8Z0000000000000000000D3')] }),
  );
  assert.deepEqual(result, { status: 503, code: 'WEBHOOK_DURABILITY_UNAVAILABLE' });
  assert.ok(!JSON.stringify(result).includes('connection refused'));
});

test('interpret: quoted response ใน 1:1 เท่านั้นที่พก userId, group/room ไม่พก และ type ใหม่เป็น unsupported', () => {
  const read = (value: unknown) => interpretLineEvent(Buffer.from(JSON.stringify(value)));
  const quoted = read(event('x', { message: { id: '1', type: 'text', quotedMessageId: '99' } }));
  assert.deepEqual(quoted, {
    kind: 'SIGNAL',
    oneToOneUserId: USER,
    message: { providerMessageId: '1', messageType: 'text', quotedMessageId: '99' },
  });
  const group = read(
    event('x', {
      source: { type: 'group', groupId: 'C1', userId: USER },
      message: { id: '1', type: 'text', quotedMessageId: '99' },
    }),
  );
  assert.equal(group.kind === 'SIGNAL' && group.oneToOneUserId, undefined);
  assert.deepEqual(read(event('x', { type: 'somethingNew' })), { kind: 'UNSUPPORTED' });
  assert.deepEqual(read(event('x', { message: { type: 'text' } })), { kind: 'SCHEMA_INVALID' });
  assert.deepEqual(read(event('x', { type: 'postback', postback: {} })), {
    kind: 'SCHEMA_INVALID',
  });
  assert.ok(LINE_KNOWN_EVENT_TYPES.includes('postback'));
  assert.equal(parseLineWebhook(Buffer.from([0xff, 0xfe])), null);
});

test('runtime ไม่ start กับ channel อื่นนอก test OA และ env ไม่ต้องมีค่า secret', () => {
  const env = {
    LINE_WEBHOOK_TENANT_ID: TENANT,
    LINE_CHANNEL_ID: '2007056595',
    LINE_WEBHOOK_DESTINATION: DESTINATION,
    LINE_CHANNEL_SECRET_KEYCHAIN_SERVICE: 'd-contact.line.channel-secret',
    LINE_WEBHOOK_PAYLOAD_KEY_KEYCHAIN_SERVICE: 'd-contact.line.webhook-payload-key',
  };
  const config = lineWebhookConfigFromEnv(env);
  assert.equal(config.channelSecret.keychainService, 'd-contact.line.channel-secret');
  assert.equal(config.postbackKey, undefined);
  assert.throws(
    () => lineWebhookConfigFromEnv({ ...env, LINE_CHANNEL_ID: '1234567890' }),
    LineWebhookRuntimeConfigError,
  );
  assert.throws(
    () => lineWebhookConfigFromEnv({ ...env, LINE_WEBHOOK_TENANT_ID: 'demo' }),
    LineWebhookRuntimeConfigError,
  );
});
