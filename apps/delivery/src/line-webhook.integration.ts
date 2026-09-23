/**
 * S2.5 (#369): LINE webhook ingress, durable inbox และ Touch correlation บน Postgres จริง
 *
 * Authority: #359, #361 §D/§F และ Phase Contract #362 §5/§7/§8
 * ครอบ acceptance checks:
 * - `S2-LINE-F03` raw-body signature, empty/multi-event, atomic durable ack, 503 และ ack latency
 * - `S2-LINE-F04` explicit response binding → Touch ผ่าน Contact Governance ตัวจริง
 * - `S2-LINE-ID01` webhookEventId/providerMessageId/response Touch dedupe และ conflict
 * - `S2-LINE-RC03` redelivery, out-of-order, pending correlation และ restart (lease หมด)
 * - `S2-LINE-TI01` response ของ tenant หนึ่งผูกกับ delivery ของอีก tenant ไม่ได้
 * - `S2-LINE-OB02` negative scan: row, event และ log ไม่มี userId/body/token/signature
 *
 * ทุก write ของ Delivery ใช้ role `dcontact_app` ผ่าน RLS; Touch เขียนผ่าน `ContactGovernanceService`
 * เท่านั้น ค่า LINE ทั้งหมดเป็นของสังเคราะห์
 */
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import { PrismaClient } from '@d-contact/db';
import { LineInboundRepository } from './line-inbound-repository.js';
import {
  PILOT_CHANNEL_ACCOUNT_ID,
  createLinePersistenceFixture,
  digest,
  type LinePersistenceFixture,
} from './line-persistence-fixture.js';
import { LinePostbackTokenCodec } from './line-postback-token.js';
import { StaticLinePayloadKeyring, sealLinePayload } from './line-protected-payload.js';
import { LineWebhookIngress, lineWebhookPayloadRef } from './line-webhook-ingress.js';
import { LineWebhookRepository } from './line-webhook-repository.js';
import { createLineWebhookServer } from './line-webhook-server.js';
import { LineChannelSecret, lineRecipientFingerprint } from './line-webhook-signature.js';
import { startLineWebhookRuntime } from './line-webhook-runtime.js';
import { LineWebhookWorker, type LineWebhookWorkerEvent } from './line-webhook-worker.js';

const SECRET = 'synthetic-channel-secret-for-integration';
const DESTINATION = `U${'e'.repeat(32)}`;
const RECIPIENT = `U${'0a1b2c3d4e5f6789'.repeat(2)}`;
const STRANGER = `U${'9876543210fedcba'.repeat(2)}`;
const MESSAGE_TEXT = 'ขอบคุณค่ะ ได้รับแล้ว — synthetic body';
const REPLY_TOKEN = 'synthetic-reply-token-0001';
const QUOTE_TOKEN = 'synthetic-quote-token-0001';
const BARRIER = new Date('2026-09-22T10:01:00.000Z');
const RESPONSE_AT = new Date('2026-09-22T10:05:00.000Z');

let sequence = 0;
const nextEventId = () => `01J9S2WEBHOOK${String(++sequence).padStart(13, '0')}`;
const nextMessageId = () => String(468_000_000_000_000_000n + BigInt(++sequence));

interface Harness {
  ctx: LinePersistenceFixture;
  tenantId: string;
  keyring: StaticLinePayloadKeyring;
  ingress: LineWebhookIngress;
  worker: LineWebhookWorker;
  events: LineWebhookWorkerEvent[];
  postback: LinePostbackTokenCodec;
  setNow(value: Date): void;
  post(payload: unknown): ReturnType<LineWebhookIngress['handle']>;
}

async function harness(t: TestContext, tenant: 'A' | 'B' = 'A'): Promise<Harness> {
  const ctx = await createLinePersistenceFixture();
  t.after(() => ctx.dispose());
  return build(ctx, tenant === 'A' ? ctx.tenantA : ctx.tenantB);
}

function build(ctx: LinePersistenceFixture, tenantId: string): Harness {
  const keyring = new StaticLinePayloadKeyring(1, new Map([[1, randomBytes(32)]]));
  const postback = new LinePostbackTokenCodec(randomBytes(32));
  const webhooks = new LineWebhookRepository(ctx.application);
  let now = new Date('2026-09-22T10:06:00.000Z');
  const events: LineWebhookWorkerEvent[] = [];
  const ingress = new LineWebhookIngress({
    binding: {
      tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      expectedDestination: DESTINATION,
      secret: new LineChannelSecret(SECRET),
    },
    repository: webhooks,
    keyring,
  });
  const worker = new LineWebhookWorker({
    tenantId,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    webhooks,
    inbound: new LineInboundRepository(ctx.application),
    keyring,
    governance: new ContactGovernanceService(ctx.application),
    events: { publish: async (event) => void events.push(event) },
    postbackTokens: postback,
    leaseMs: 30_000,
    now: () => now,
  });
  return {
    ctx,
    tenantId,
    keyring,
    ingress,
    worker,
    events,
    postback,
    setNow: (value) => {
      now = value;
    },
    post: (payload) => ingress.handle(signedRequest(payload)),
  };
}

function signedRequest(payload: unknown) {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    method: 'POST',
    contentType: 'application/json',
    signature: createHmac('sha256', SECRET).update(rawBody).digest('base64'),
    rawBody,
    receivedAt: new Date('2026-09-22T10:05:01.000Z'),
  };
}

function messageEvent(options: {
  webhookEventId?: string;
  messageId?: string;
  quotedMessageId?: string;
  userId?: string;
  sourceType?: 'user' | 'group';
  at?: Date;
  redelivery?: boolean;
}) {
  return {
    type: 'message',
    message: {
      id: options.messageId ?? nextMessageId(),
      type: 'text',
      text: MESSAGE_TEXT,
      quoteToken: QUOTE_TOKEN,
      ...(options.quotedMessageId ? { quotedMessageId: options.quotedMessageId } : {}),
    },
    webhookEventId: options.webhookEventId ?? nextEventId(),
    deliveryContext: { isRedelivery: options.redelivery ?? false },
    timestamp: (options.at ?? RESPONSE_AT).getTime(),
    source:
      options.sourceType === 'group'
        ? { type: 'group', groupId: `C${'1'.repeat(32)}`, userId: options.userId ?? RECIPIENT }
        : { type: 'user', userId: options.userId ?? RECIPIENT },
    replyToken: REPLY_TOKEN,
    mode: 'active',
  };
}

function postbackEvent(data: string, options: { userId?: string; at?: Date } = {}) {
  return {
    type: 'postback',
    postback: { data },
    webhookEventId: nextEventId(),
    deliveryContext: { isRedelivery: false },
    timestamp: (options.at ?? RESPONSE_AT).getTime(),
    source: { type: 'user', userId: options.userId ?? RECIPIENT },
    replyToken: REPLY_TOKEN,
    mode: 'active',
  };
}

const body = (...events: unknown[]) => ({ destination: DESTINATION, events });

/**
 * LINE delivery ที่ผ่าน run authorization และ provider รับแล้ว — `governanceAccepted` false คือ
 * สถานะที่ webhook มาถึงก่อน Governance commit acceptance (#361 §F)
 */
async function acceptedDelivery(
  h: Harness,
  options: { recipient?: string; sentMessageId?: string; governanceAccepted?: boolean } = {},
) {
  const delivery = await h.ctx.seedDelivery(h.tenantId);
  const { run } = await h.ctx.seedApprovedRun(h.tenantId, `webhook-${delivery.deliveryId}`, {
    recipientFingerprint: lineRecipientFingerprint(
      PILOT_CHANNEL_ACCOUNT_ID,
      options.recipient ?? RECIPIENT,
    ),
  });
  const consumed = await h.ctx.control.consumeRun(h.tenantId, run.id, delivery.deliveryId, BARRIER);
  assert.equal(consumed.status, 'CONSUMED');
  const sentMessageId = options.sentMessageId ?? nextMessageId();
  await recordProviderAcceptance(h, delivery, sentMessageId);
  const attemptId =
    options.governanceAccepted === false ? undefined : await h.ctx.seedAcceptedAttempt(delivery);
  return { delivery, run, sentMessageId, attemptId };
}

function recordProviderAcceptance(
  h: Harness,
  delivery: Awaited<ReturnType<LinePersistenceFixture['seedDelivery']>>,
  sentMessageId: string,
) {
  return h.ctx.attempts.record({
    id: randomUUID(),
    tenantId: h.tenantId,
    deliveryId: delivery.deliveryId,
    providerRequestKey: delivery.providerRequestKey,
    attemptNo: 1,
    providerPayloadDigest: digest(`payload-${delivery.deliveryId}`),
    startedAt: BARRIER,
    finishedAt: BARRIER,
    httpStatus: 200,
    outcomeCode: 'LINE_ACCEPTED',
    lineRequestId: `req-${digest(delivery.deliveryId).slice(0, 12)}`,
    sentMessageIds: [sentMessageId],
  });
}

async function touches(h: Harness) {
  return h.ctx.owner.cgTouch.findMany({ where: { tenantId: h.tenantId } });
}

async function correlations(h: Harness) {
  return h.ctx.owner.dlLineTouchCorrelation.findMany({
    where: { tenantId: h.tenantId },
    orderBy: { createdAt: 'asc' },
  });
}

// ── F03: ingress ────────────────────────────────────────────────────────────

test('HTTP: signed multi-event request commit ครบทุก event แล้วตอบ 200; signature ผิดไม่มีแถว', async (t) => {
  const h = await harness(t);
  const log: object[] = [];
  const server = createLineWebhookServer({ ingress: h.ingress, log: (entry) => log.push(entry) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/line`;

  const payload = body(messageEvent({}), messageEvent({}), { ...messageEvent({}), type: 'follow' });
  const request = signedRequest(payload);
  const send = (signature: string, path = url) =>
    fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': signature },
      body: request.rawBody,
    });

  const forged = await send(Buffer.alloc(32).toString('base64'));
  assert.equal(forged.status, 401);
  assert.equal(await forged.text(), '{}');
  assert.equal(
    await h.ctx.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: h.tenantId } }),
    0,
  );
  assert.equal(
    await h.ctx.owner.dlLineProtectedPayload.count({ where: { tenantId: h.tenantId } }),
    0,
  );

  assert.equal((await send(request.signature, `${url}?tenant=other`)).status, 404);

  const accepted = await send(request.signature);
  assert.equal(accepted.status, 200);
  assert.equal(
    await h.ctx.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: h.tenantId } }),
    3,
  );
  assert.equal(
    await h.ctx.owner.dlLineProtectedPayload.count({ where: { tenantId: h.tenantId } }),
    3,
  );

  // redelivery ทั้ง request: duplicate no-op ไม่มีแถวเพิ่ม
  assert.equal((await send(request.signature)).status, 200);
  assert.equal(
    await h.ctx.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: h.tenantId } }),
    3,
  );

  const logged = JSON.stringify(log);
  assert.ok(!logged.includes(request.signature));
  assert.ok(!logged.includes(RECIPIENT));
  assert.match(logged, /WEBHOOK_SIGNATURE_INVALID/);
});

test('ack หลัง durable commit ภายใน 2s และ p95 ≤ 250ms บน HTTP จริง', async (t) => {
  const h = await harness(t);
  const server = createLineWebhookServer({ ingress: h.ingress });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/line`;

  const durations: number[] = [];
  for (let index = 0; index < 30; index += 1) {
    const request = signedRequest(body(messageEvent({}), messageEvent({})));
    const started = performance.now();
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-line-signature': request.signature },
      body: request.rawBody,
    });
    durations.push(performance.now() - started);
    assert.equal(response.status, 200);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
  assert.ok(durations.at(-1)! < 2_000, `ack ช้าสุด ${durations.at(-1)}ms`);
  assert.ok(p95 <= 250, `p95 ${p95.toFixed(1)}ms`);
  assert.equal(
    await h.ctx.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: h.tenantId } }),
    60,
  );
});

test('batch ที่ล้มกลางทาง rollback ทั้ง request และ database ล่มตอบ 503 โดยไม่มีแถว', async (t) => {
  const h = await harness(t);
  const repository = new LineWebhookRepository(h.ctx.application);
  const good = { id: randomUUID(), webhookEventId: nextEventId(), payloadHash: digest('good') };
  const bad = { id: randomUUID(), webhookEventId: nextEventId(), payloadHash: digest('bad') };
  const events = [good, bad].map((entry) => ({
    ...entry,
    eventType: 'message',
    deliveryMode: 'active' as const,
    isRedelivery: false,
    providerTimestamp: RESPONSE_AT,
    protectedPayloadRef: lineWebhookPayloadRef(
      PILOT_CHANNEL_ACCOUNT_ID,
      entry.webhookEventId,
      entry.payloadHash,
    ),
  }));
  const payloads = [
    sealLinePayload(h.keyring, h.tenantId, events[0]!.protectedPayloadRef, Buffer.from('{}')),
    // ref ผิดรูปแบบ → CHECK ล้มหลังแถวแรกเขียนไปแล้ว
    { ...sealLinePayload(h.keyring, h.tenantId, 'x', Buffer.from('{}')), payloadRef: 'bad ref' },
  ];
  await assert.rejects(
    repository.acceptBatch({
      tenantId: h.tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      receivedAt: RESPONSE_AT,
      events,
      payloads,
    }),
  );
  assert.equal(
    await h.ctx.owner.dlLineWebhookInboxEntry.count({ where: { tenantId: h.tenantId } }),
    0,
  );
  assert.equal(
    await h.ctx.owner.dlLineProtectedPayload.count({ where: { tenantId: h.tenantId } }),
    0,
  );

  const unreachable = new PrismaClient({
    datasources: { db: { url: 'postgresql://dcontact_app:dcontact_app@127.0.0.1:1/none' } },
  });
  t.after(() => unreachable.$disconnect());
  const down = new LineWebhookIngress({
    binding: {
      tenantId: h.tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      expectedDestination: DESTINATION,
      secret: new LineChannelSecret(SECRET),
    },
    repository: new LineWebhookRepository(unreachable),
    keyring: h.keyring,
  });
  assert.deepEqual(await down.handle(signedRequest(body(messageEvent({})))), {
    status: 503,
    code: 'WEBHOOK_DURABILITY_UNAVAILABLE',
  });
});

test('event ID เดิม: redelivery (isRedelivery=true) เป็น duplicate ส่วน payload ต่างเป็น conflict ที่กักของเดิม', async (t) => {
  const h = await harness(t);
  const original = messageEvent({});
  assert.deepEqual((await h.post(body(original))).counts, { WEBHOOK_ACCEPTED: 1 });
  assert.deepEqual(
    (await h.post(body({ ...original, deliveryContext: { isRedelivery: true } }))).counts,
    { WEBHOOK_DUPLICATE: 1 },
  );
  assert.deepEqual(
    (await h.post(body({ ...original, message: { ...original.message, text: 'changed' } }))).counts,
    { WEBHOOK_IDEMPOTENCY_CONFLICT: 1 },
  );
  const [entry] = await h.ctx.owner.dlLineWebhookInboxEntry.findMany({
    where: { tenantId: h.tenantId },
  });
  assert.equal(entry!.state, 'QUARANTINED');
  assert.equal(entry!.outcomeCode, 'WEBHOOK_IDEMPOTENCY_CONFLICT');
  // payload ที่ขัดกันถูกเก็บเป็นหลักฐานแยก ไม่ทับของเดิม
  assert.equal(
    await h.ctx.owner.dlLineProtectedPayload.count({ where: { tenantId: h.tenantId } }),
    2,
  );
});

test('destination ไม่ตรง binding ถูกเก็บเป็น quarantine พร้อม audit และ worker ไม่หยิบ', async (t) => {
  const h = await harness(t);
  const result = await h.post({ destination: `U${'d'.repeat(32)}`, events: [messageEvent({})] });
  assert.equal(result.status, 200);
  const [entry] = await h.ctx.owner.dlLineWebhookInboxEntry.findMany({
    where: { tenantId: h.tenantId },
  });
  assert.equal(entry!.state, 'QUARANTINED');
  assert.equal(entry!.outcomeCode, 'WEBHOOK_DESTINATION_MISMATCH');
  const audit = await h.ctx.owner.dlLineAuditEvent.findMany({ where: { tenantId: h.tenantId } });
  assert.deepEqual(
    audit.map((row) => row.code),
    ['WEBHOOK_DESTINATION_MISMATCH'],
  );
  assert.deepEqual(await h.worker.runOnce(), []);
});

// ── worker: projection + quarantine ─────────────────────────────────────────

test('worker: message เดิมใน event ต่างกันถูก project ครั้งเดียว, type ใหม่/field ขาดถูกกัก', async (t) => {
  const h = await harness(t);
  const messageId = nextMessageId();
  await h.post(
    body(
      messageEvent({ messageId }),
      messageEvent({ messageId }),
      { ...messageEvent({}), type: 'brandNewEventType' },
      { ...messageEvent({}), message: { type: 'text' } },
    ),
  );
  const outcomes = await h.worker.runOnce();
  assert.deepEqual([...outcomes].sort(), [
    'COMPLETED',
    'COMPLETED',
    'QUARANTINED_SCHEMA',
    'QUARANTINED_UNSUPPORTED',
  ]);
  const projected = await h.ctx.owner.dlLineInboundMessage.findMany({
    where: { tenantId: h.tenantId },
  });
  assert.equal(projected.length, 1);
  assert.equal(projected[0]!.providerMessageId, messageId);
  // inbound event หนึ่งตัวต่อ webhook event ที่ complete และ event ID คงที่
  const inbound = h.events.filter((event) => event.type === 'channel.line.inbound.v1');
  assert.equal(inbound.length, 2);
  assert.equal(new Set(inbound.map((event) => event.eventId)).size, 2);
});

test('worker restart: lease ที่หมดถูกหยิบใหม่และประมวลผลครั้งเดียว', async (t) => {
  const h = await harness(t);
  await h.post(body(messageEvent({})));
  const webhooks = new LineWebhookRepository(h.ctx.application);
  // worker ตัวแรกหยิบแล้วตายโดยไม่ complete
  const claimed = await webhooks.claim(
    h.tenantId,
    'crashed-worker',
    new Date('2026-09-22T10:06:00.000Z'),
    1_000,
    10,
  );
  assert.equal(claimed.length, 1);
  assert.deepEqual(await h.worker.runOnce(), []);
  h.setNow(new Date('2026-09-22T10:07:00.000Z'));
  assert.deepEqual(await h.worker.runOnce(), ['COMPLETED']);
  assert.deepEqual(await h.worker.runOnce(), []);
  assert.equal(
    await webhooks.complete(h.tenantId, claimed[0]!.id, 'crashed-worker', new Date()),
    false,
  );
});

// ── F04/RC03: correlation ──────────────────────────────────────────────────

test('quoted response ที่ตรงผู้รับสร้าง Touch เดียวผ่าน Governance และ redelivery ไม่เพิ่ม Touch', async (t) => {
  const h = await harness(t);
  const { delivery, sentMessageId, attemptId } = await acceptedDelivery(h);
  const reservationBefore = await h.ctx.owner.cgReservation.findUniqueOrThrow({
    where: { id: delivery.reservationId },
  });

  const quoted = messageEvent({ quotedMessageId: sentMessageId });
  await h.post(body(quoted));
  assert.deepEqual(await h.worker.runOnce(), ['COMPLETED']);

  const [touch] = await touches(h);
  assert.equal(touch?.attemptId, attemptId);
  assert.equal(touch?.evidenceKind, 'USER_QUOTED_RESPONSE');
  assert.equal(touch?.occurredAt.toISOString(), RESPONSE_AT.toISOString());
  assert.equal(
    touch?.responseEvidenceRef,
    `line-webhook:${PILOT_CHANNEL_ACCOUNT_ID}:${quoted.webhookEventId}`,
  );
  const [correlation] = await correlations(h);
  assert.equal(correlation?.state, 'BOUND');
  assert.equal(correlation?.attemptId, attemptId);
  assert.deepEqual(
    await h.ctx.owner.cgReservation.findUniqueOrThrow({ where: { id: delivery.reservationId } }),
    reservationBefore,
  );

  await h.post(body({ ...quoted, deliveryContext: { isRedelivery: true } }));
  assert.deepEqual(await h.worker.runOnce(), []);
  assert.equal((await touches(h)).length, 1);
  assert.equal(h.events.filter((event) => event.type === 'contact.touch.correlated.v1').length, 1);
});

test('response มาก่อน provider/Governance commit: คง PENDING แล้ว sweep จน bind ได้ภายใน window', async (t) => {
  const h = await harness(t);
  const delivery = await h.ctx.seedDelivery(h.tenantId);
  const { run } = await h.ctx.seedApprovedRun(h.tenantId, 'out-of-order', {
    recipientFingerprint: lineRecipientFingerprint(PILOT_CHANNEL_ACCOUNT_ID, RECIPIENT),
  });
  await h.ctx.control.consumeRun(h.tenantId, run.id, delivery.deliveryId, BARRIER);
  const sentMessageId = nextMessageId();

  await h.post(body(messageEvent({ quotedMessageId: sentMessageId })));
  await h.worker.runOnce();
  assert.equal((await correlations(h))[0]?.state, 'PENDING');

  await recordProviderAcceptance(h, delivery, sentMessageId);
  assert.deepEqual(await h.worker.sweepCorrelations(), ['PENDING']);
  assert.equal((await touches(h)).length, 0);

  await h.ctx.seedAcceptedAttempt(delivery);
  assert.deepEqual(await h.worker.sweepCorrelations(), ['BOUND']);
  assert.equal((await touches(h)).length, 1);
  assert.deepEqual(await h.worker.sweepCorrelations(), []);
});

test('pending ที่เลย window ถูกกักเป็น USER_RESPONSE_UNBOUND โดยไม่เดา candidate', async (t) => {
  const h = await harness(t);
  await h.post(body(messageEvent({ quotedMessageId: nextMessageId() })));
  await h.worker.runOnce();
  h.setNow(new Date(RESPONSE_AT.getTime() + 24 * 60 * 60_000 + 1));
  assert.deepEqual(await h.worker.sweepCorrelations(), ['QUARANTINED:USER_RESPONSE_UNBOUND']);
  assert.equal((await correlations(h))[0]?.quarantineCode, 'USER_RESPONSE_UNBOUND');
});

test('ไม่มี Touch จาก plain message, group, ผู้รับอื่น, ก่อน barrier หรือ message ID ที่ชี้หลาย delivery', async (t) => {
  const h = await harness(t);
  const { sentMessageId } = await acceptedDelivery(h);
  const ambiguousId = nextMessageId();
  // allowlist ห้ามซ้ำต่อผู้รับ จึงใช้ผู้รับคนละคน — AMBIGUOUS ตัดสินก่อนเทียบผู้รับอยู่แล้ว
  await acceptedDelivery(h, { sentMessageId: ambiguousId, recipient: `U${'2'.repeat(32)}` });
  await acceptedDelivery(h, { sentMessageId: ambiguousId, recipient: `U${'3'.repeat(32)}` });

  await h.post(
    body(
      messageEvent({}),
      messageEvent({ quotedMessageId: sentMessageId, sourceType: 'group' }),
      messageEvent({ quotedMessageId: sentMessageId, userId: STRANGER }),
      messageEvent({ quotedMessageId: sentMessageId, at: new Date(BARRIER.getTime() - 1_000) }),
      messageEvent({ quotedMessageId: ambiguousId }),
    ),
  );
  assert.equal((await h.worker.runOnce()).length, 5);
  assert.equal((await touches(h)).length, 0);
  const codes = (await correlations(h)).map((row) => `${row.state}:${row.quarantineCode}`).sort();
  assert.deepEqual(codes, [
    'QUARANTINED:USER_RESPONSE_AMBIGUOUS',
    'QUARANTINED:USER_RESPONSE_RECIPIENT_MISMATCH',
    'QUARANTINED:USER_RESPONSE_UNBOUND',
  ]);
});

test('signed postback ของ delivery สร้าง Touch เดียว; token เดิมซ้ำ, หมดอายุ หรือ config อื่นไม่สร้างเพิ่ม', async (t) => {
  const h = await harness(t);
  const { delivery, attemptId } = await acceptedDelivery(h);
  const token = h.postback.issue({
    deliveryId: delivery.deliveryId,
    configDigest: digest('config-v1'),
    expiresAt: new Date('2026-09-22T12:00:00.000Z'),
  });
  await h.post(body(postbackEvent(token)));
  await h.worker.runOnce();
  const [touch] = await touches(h);
  assert.equal(touch?.attemptId, attemptId);
  assert.equal(touch?.evidenceKind, 'SIGNED_POSTBACK');

  // token เดิมใน event ใหม่ = ใช้ครั้งที่สอง → Governance ปฏิเสธ ไม่ใช่ Touch ที่สอง
  await h.post(body(postbackEvent(token)));
  await h.worker.runOnce();
  const expired = h.postback.issue({
    deliveryId: delivery.deliveryId,
    configDigest: digest('config-v1'),
    expiresAt: new Date(RESPONSE_AT.getTime() - 1),
  });
  const otherConfig = h.postback.issue({
    deliveryId: delivery.deliveryId,
    configDigest: digest('config-v2'),
    expiresAt: new Date('2026-09-22T12:00:00.000Z'),
  });
  await h.post(
    body(postbackEvent(expired), postbackEvent(otherConfig), postbackEvent('action=menu')),
  );
  await h.worker.runOnce();

  assert.equal((await touches(h)).length, 1);
  const states = (await correlations(h)).map((row) => `${row.state}:${row.quarantineCode}`);
  assert.deepEqual(states, [
    'BOUND:null',
    'QUARANTINED:TOUCH_REJECTED_BY_GOVERNANCE',
    'QUARANTINED:POSTBACK_TOKEN_INVALID',
  ]);
});

// ── TI01 + OB02 ─────────────────────────────────────────────────────────────

test('tenant B ผูก response กับ delivery ของ tenant A ไม่ได้ และอ่าน payload ข้าม tenant ไม่ได้', async (t) => {
  const a = await harness(t, 'A');
  const b = build(a.ctx, a.ctx.tenantB);
  const { sentMessageId } = await acceptedDelivery(a);

  await b.post(body(messageEvent({ quotedMessageId: sentMessageId })));
  await b.worker.runOnce();
  assert.equal((await correlations(b))[0]?.state, 'PENDING');
  assert.equal((await touches(a)).length + (await touches(b)).length, 0);

  const [entryB] = await a.ctx.owner.dlLineWebhookInboxEntry.findMany({
    where: { tenantId: b.tenantId },
  });
  const inboundA = new LineInboundRepository(a.ctx.application);
  assert.equal(await inboundA.readPayload(a.tenantId, entryB!.protectedPayloadRef), null);
  assert.equal(await inboundA.findEntry(a.tenantId, entryB!.id), null);
});

test('negative scan: row, event และ log ของ tenant ไม่มี userId, body, reply/quote token หรือ signature', async (t) => {
  const h = await harness(t);
  const { sentMessageId, delivery } = await acceptedDelivery(h);
  const token = h.postback.issue({
    deliveryId: delivery.deliveryId,
    configDigest: digest('config-v1'),
    expiresAt: new Date('2026-09-22T12:00:00.000Z'),
  });
  const request = signedRequest(
    body(messageEvent({ quotedMessageId: sentMessageId }), messageEvent({}), postbackEvent(token)),
  );
  await h.ingress.handle(request);
  await h.worker.runOnce();

  const where = { where: { tenantId: h.tenantId } };
  const rows = await Promise.all([
    h.ctx.owner.dlLineWebhookInboxEntry.findMany(where),
    h.ctx.owner.dlLineTouchCorrelation.findMany(where),
    h.ctx.owner.dlLineInboundMessage.findMany(where),
    h.ctx.owner.dlLineAuditEvent.findMany(where),
    h.ctx.owner.cgTouch.findMany(where),
    h.ctx.owner.dlLineProtectedPayload.findMany(where),
  ]);
  const scanned = JSON.stringify({ rows, events: h.events }, (_key, value) =>
    Buffer.isBuffer(value) || value instanceof Uint8Array
      ? Buffer.from(value).toString('latin1')
      : value,
  );
  for (const forbidden of [
    RECIPIENT,
    RECIPIENT.slice(1),
    MESSAGE_TEXT,
    REPLY_TOKEN,
    QUOTE_TOKEN,
    token,
    request.signature,
    SECRET,
  ]) {
    assert.ok(
      !scanned.includes(forbidden),
      `พบค่าต้องห้ามใน row/event: ${forbidden.slice(0, 12)}…`,
    );
  }
  assert.equal(rows[4].length, 1);
});

test('runtime: composition จริงรับ webhook ผ่าน HTTP แล้ว worker loop ประมวลผลจน COMPLETED และ stop สะอาด', async (t) => {
  const ctx = await createLinePersistenceFixture();
  t.after(() => ctx.dispose());
  const payloadKey = randomBytes(32).toString('base64');
  const reads: string[] = [];
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const runtime = await startLineWebhookRuntime(
    {
      tenantId: ctx.tenantA,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      expectedDestination: DESTINATION,
      port,
      channelSecret: { keychainService: 'test.channel-secret', keychainAccount: '' },
      payloadKey: { keychainService: 'test.payload-key', keychainAccount: '' },
      pollIntervalMs: 100,
    },
    {
      database: ctx.application,
      secrets: {
        async read(reference) {
          reads.push(reference.keychainService);
          return reference.keychainService === 'test.channel-secret' ? SECRET : payloadKey;
        },
      },
    },
  );
  t.after(() => runtime.stop());

  const request = signedRequest(body(messageEvent({})));
  const response = await fetch(`http://127.0.0.1:${port}/webhook/line`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': request.signature },
    body: request.rawBody,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(reads.sort(), ['test.channel-secret', 'test.payload-key']);

  const deadline = Date.now() + 5_000;
  let state = 'PENDING';
  while (state !== 'COMPLETED' && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const entry = await ctx.owner.dlLineWebhookInboxEntry.findFirst({
      where: { tenantId: ctx.tenantA },
    });
    state = entry?.state ?? 'MISSING';
  }
  assert.equal(state, 'COMPLETED');
  assert.equal(await ctx.owner.dlLineInboundMessage.count({ where: { tenantId: ctx.tenantA } }), 1);
});
