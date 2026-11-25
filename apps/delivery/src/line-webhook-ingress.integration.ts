/**
 * S2.5 (#369) — LINE webhook ingress on real PostgreSQL/RLS
 *
 * Covers acceptance `S2-LINE-F03`, `ID01`, `TI01`, `OB01/OB02` on the ingress side: signature as the authority,
 * atomic commit of the whole request, dedupe/conflict, empty verify, destination mismatch and
 * a durability failure that must not answer 2xx
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import {
  LineWebhookIngress,
  lineProtectedPayloadRef,
  type LineWebhookBinding,
} from './line-webhook-ingress.js';
import {
  createLinePersistenceFixture,
  PILOT_CHANNEL_ACCOUNT_ID,
  type LinePersistenceFixture,
} from './line-persistence-fixture.js';
import { lineSignature } from './line-webhook-signature.js';

const SECRET = 's2-synthetic-channel-secret';
const DESTINATION = 'U1234567890abcdef1234567890abcdef';
const PAYLOAD_KEY = randomBytes(32);

async function setup(t: TestContext) {
  const fixture = await createLinePersistenceFixture();
  t.after(() => fixture.dispose());
  const binding = (tenantId: string): LineWebhookBinding => ({
    tenantId,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    destination: DESTINATION,
    channelSecret: SECRET,
    payloadKeyRef: 'd-contact.line.webhook-payload/v1',
    payloadKey: PAYLOAD_KEY,
  });
  return { fixture, binding };
}

let sequence = 0;
function messageEvent(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return {
    type: 'message',
    mode: 'active',
    webhookEventId: `01JW${String(sequence).padStart(6, '0')}`,
    deliveryContext: { isRedelivery: false },
    timestamp: 1_790_000_000_000 + sequence,
    source: { type: 'user', userId: `U${'a'.repeat(31)}${sequence % 10}` },
    message: { id: `${400_000_000_000 + sequence}`, type: 'text', text: 'Thank you' },
    ...overrides,
  };
}

function request(events: unknown[], destination = DESTINATION) {
  const rawBody = Buffer.from(JSON.stringify({ destination, events }), 'utf8');
  return { rawBody, signature: lineSignature(rawBody, SECRET), receivedAt: new Date() };
}

const inboxOf = (fixture: LinePersistenceFixture, tenantId: string) =>
  fixture.owner.dlLineWebhookInboxEntry.findMany({
    where: { tenantId },
    orderBy: { receivedAt: 'asc' },
  });

test('S2-LINE-F03 a failed signature answers 401 and no row is written', async (t) => {
  const { fixture, binding } = await setup(t);
  const ingress = new LineWebhookIngress(fixture.application, binding(fixture.tenantA));
  const valid = request([messageEvent()]);

  for (const signature of [undefined, '', 'ZGVhZGJlZWY=', `${valid.signature}x`]) {
    const result = await ingress.handle({ ...valid, signature });
    assert.deepEqual(
      [result.status, result.code],
      [401, 'WEBHOOK_SIGNATURE_INVALID'],
      `signature=${String(signature)}`,
    );
  }
  assert.equal((await inboxOf(fixture, fixture.tenantA)).length, 0);
  assert.equal(
    await fixture.owner.dlLineWebhookPayload.count({ where: { tenantId: fixture.tenantA } }),
    0,
  );
});

test('S2-LINE-F03 a request with many events commits together and a verify request answers 200 without creating a row', async (t) => {
  const { fixture, binding } = await setup(t);
  const ingress = new LineWebhookIngress(fixture.application, binding(fixture.tenantA));

  const empty = await ingress.handle(request([]));
  assert.deepEqual([empty.status, empty.code], [200, 'WEBHOOK_EMPTY_VERIFICATION']);
  assert.equal((await inboxOf(fixture, fixture.tenantA)).length, 0);

  const events = [messageEvent(), messageEvent({ type: 'follow' }), messageEvent()];
  const accepted = await ingress.handle(request(events));
  assert.deepEqual(
    [accepted.status, accepted.code, accepted.accepted],
    [200, 'WEBHOOK_ACCEPTED', 3],
  );

  const rows = await inboxOf(fixture, fixture.tenantA);
  assert.equal(rows.length, 3);
  assert.ok(
    rows.every(
      (row) => row.state === 'PENDING' && row.channelAccountId === PILOT_CHANNEL_ACCOUNT_ID,
    ),
  );
  // the inbox keeps only a ref/hash — the userId and the text are in no row at all (#362 §5)
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes('Thank you') && !/U[0-9a-f]{31}/.test(serialized));

  // the event outbox gets one channel.line.inbound.v1 per newly accepted event
  const outbox = await fixture.owner.dlLineEventOutboxEntry.findMany({
    where: { tenantId: fixture.tenantA },
  });
  assert.equal(outbox.length, 3);
  assert.ok(outbox.every((entry) => entry.eventType === 'channel.line.inbound.v1'));
  assert.ok(!JSON.stringify(outbox).includes('Thank you'));
});

test('S2-LINE-ID01 an original redelivery is a duplicate while a different payload on the original event ID is quarantined', async (t) => {
  const { fixture, binding } = await setup(t);
  const ingress = new LineWebhookIngress(fixture.application, binding(fixture.tenantA));
  const event = messageEvent();

  const first = await ingress.handle(request([event]));
  assert.equal(first.accepted, 1);
  // LINE resends with the original event ID but sets `deliveryContext.isRedelivery = true` (#359 §D) — it must still
  // be a duplicate, not an idempotency conflict, and the original row must not be quarantined
  const redelivered = await ingress.handle(
    request([{ ...event, deliveryContext: { isRedelivery: true } }]),
  );
  assert.deepEqual([redelivered.code, redelivered.duplicates], ['WEBHOOK_DUPLICATE', 1]);
  const afterRedelivery = await inboxOf(fixture, fixture.tenantA);
  assert.equal(afterRedelivery.length, 1);
  assert.equal(afterRedelivery[0]!.state, 'PENDING');

  const tampered = await ingress.handle(
    request([{ ...event, message: { id: '999999999999', type: 'text', text: 'edited' } }]),
  );
  assert.deepEqual([tampered.code, tampered.conflicts], ['WEBHOOK_IDEMPOTENCY_CONFLICT', 1]);

  const rows = await inboxOf(fixture, fixture.tenantA);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0]!.state, rows[0]!.outcomeCode],
    ['QUARANTINED', 'WEBHOOK_IDEMPOTENCY_CONFLICT'],
  );
  // the original payload is not overwritten
  assert.equal(
    await fixture.owner.dlLineWebhookPayload.count({ where: { tenantId: fixture.tenantA } }),
    1,
  );
  const audit = await fixture.owner.dlLineAuditEvent.findMany({
    where: { tenantId: fixture.tenantA, category: 'WEBHOOK' },
  });
  assert.ok(audit.some((entry) => entry.code === 'WEBHOOK_IDEMPOTENCY_CONFLICT'));
});

test('S2-LINE-F03 a destination not matching the binding is quarantined but still answers 200 to avoid a redelivery storm', async (t) => {
  const { fixture, binding } = await setup(t);
  const ingress = new LineWebhookIngress(fixture.application, binding(fixture.tenantA));
  const result = await ingress.handle(
    request([messageEvent()], 'Uffffffffffffffffffffffffffffffff'),
  );

  assert.deepEqual([result.status, result.code], [200, 'WEBHOOK_DESTINATION_MISMATCH']);
  const rows = await inboxOf(fixture, fixture.tenantA);
  assert.equal(rows.length, 1);
  assert.deepEqual(
    [rows[0]!.state, rows[0]!.outcomeCode],
    ['QUARANTINED', 'WEBHOOK_DESTINATION_MISMATCH'],
  );
  // the payload of a request with a wrong destination is not kept, and no inbound event goes out
  assert.equal(
    await fixture.owner.dlLineWebhookPayload.count({ where: { tenantId: fixture.tenantA } }),
    0,
  );
  assert.equal(
    await fixture.owner.dlLineEventOutboxEntry.count({ where: { tenantId: fixture.tenantA } }),
    0,
  );
});

test('S2-LINE-RC03 a durability failure answers 503 and leaves no half-written row', async (t) => {
  const { fixture, binding } = await setup(t);
  const failing = new LineWebhookIngress(fixture.application, binding(fixture.tenantA), () => {
    throw new Error('the durable store went down mid-transaction');
  });
  const result = await failing.handle(request([messageEvent(), messageEvent()]));

  assert.deepEqual([result.status, result.code], [503, 'WEBHOOK_DURABILITY_UNAVAILABLE']);
  assert.equal((await inboxOf(fixture, fixture.tenantA)).length, 0);
  assert.equal(
    await fixture.owner.dlLineEventOutboxEntry.count({ where: { tenantId: fixture.tenantA } }),
    0,
  );

  // resending after the system recovers gets full rows, with nothing left over from the previous attempt
  const ingress = new LineWebhookIngress(fixture.application, binding(fixture.tenantA));
  const retry = await ingress.handle(request([messageEvent(), messageEvent()]));
  assert.deepEqual([retry.status, retry.accepted], [200, 2]);
});

test('S2-LINE-TI01 another tenant using the same binding neither sees nor collides on the event ID', async (t) => {
  const { fixture, binding } = await setup(t);
  const event = messageEvent();
  const forTenantA = new LineWebhookIngress(fixture.application, binding(fixture.tenantA));
  const forTenantB = new LineWebhookIngress(fixture.application, binding(fixture.tenantB));

  assert.equal((await forTenantA.handle(request([event]))).accepted, 1);
  // the same webhookEventId of another tenant is a different row, not a cross-tenant duplicate
  assert.equal((await forTenantB.handle(request([event]))).accepted, 1);

  assert.equal((await inboxOf(fixture, fixture.tenantA)).length, 1);
  assert.equal((await inboxOf(fixture, fixture.tenantB)).length, 1);
  const visibleToA = await withTenantDatabaseTransaction(
    fixture.application,
    fixture.tenantA,
    (transaction) => transaction.dlLineWebhookInboxEntry.findMany({}),
  );
  assert.equal(visibleToA.length, 1);
  assert.equal(visibleToA[0]!.tenantId, fixture.tenantA);
});

test('S2-LINE-OB02 the payload is stored as ciphertext and the ref carries no trace of the userId', async (t) => {
  const { fixture, binding } = await setup(t);
  const ingress = new LineWebhookIngress(fixture.application, binding(fixture.tenantA));
  const event = messageEvent();
  await ingress.handle(request([event]));

  const stored = await fixture.owner.dlLineWebhookPayload.findFirstOrThrow({
    where: { tenantId: fixture.tenantA },
  });
  assert.equal(
    stored.protectedPayloadRef,
    lineProtectedPayloadRef(PILOT_CHANNEL_ACCOUNT_ID, event.webhookEventId),
  );
  assert.equal(stored.iv.length, 12);
  assert.equal(stored.authTag.length, 16);
  const ciphertext = Buffer.from(stored.ciphertext).toString('utf8');
  assert.ok(!ciphertext.includes('Thank you'));
  assert.ok(!ciphertext.includes(event.source.userId));
  assert.ok(!stored.protectedPayloadRef.includes(event.source.userId));
});

test('S2-LINE-F03 a malformed body after verify answers 400 without creating a row', async (t) => {
  const { fixture, binding } = await setup(t);
  const ingress = new LineWebhookIngress(fixture.application, binding(fixture.tenantA));
  const malformed = [
    'not json',
    '{"destination":"x"}',
    '{"destination":"x","events":[{"type":1}]}',
  ];

  for (const body of malformed) {
    const rawBody = Buffer.from(body, 'utf8');
    const result = await ingress.handle({
      rawBody,
      signature: lineSignature(rawBody, SECRET),
      receivedAt: new Date(),
    });
    assert.deepEqual([result.status, result.code], [400, 'WEBHOOK_SCHEMA_INVALID'], body);
  }
  assert.equal((await inboxOf(fixture, fixture.tenantA)).length, 0);
});
