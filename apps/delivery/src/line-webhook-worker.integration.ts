/**
 * S2.5 (#369) — inbox worker, projection dedupe and Touch correlation on real PostgreSQL/RLS
 *
 * Covers acceptance `S2-LINE-F04`, `ID01`, `RC03`, `TI01`: the same message object is projected once,
 * a Touch arises only from a quoted response bound to an accepted Attempt, a response that arrives before acceptance
 * stays pending then can bind within the window, past the window it is `USER_RESPONSE_UNBOUND`, and
 * an unknown event type does not make the worker fail
 *
 * The Governance port uses the real `AttemptTouchRepository` (a devDependency of the test) to prove that
 * Channels does not write `cg_*` itself — every Touch goes through the original owner
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { AttemptTouchRepository } from '@d-contact/contact-governance';
import type { RecordCorrelatedTouchInput } from '@d-contact/cxa-contracts';
import {
  createLinePersistenceFixture,
  digest,
  PILOT_CHANNEL_ACCOUNT_ID,
} from './line-persistence-fixture.js';
import { LineWebhookIngress, type LineWebhookBinding } from './line-webhook-ingress.js';
import { EncryptedLineWebhookPayloadVault } from './line-webhook-payload-vault.js';
import { lineSignature } from './line-webhook-signature.js';
import {
  LineWebhookWorker,
  lineSourceFingerprint,
  type LineAcceptedAttempt,
  type LineTouchGovernancePort,
} from './line-webhook-worker.js';

const SECRET = 's2-synthetic-channel-secret';
const DESTINATION = 'U1234567890abcdef1234567890abcdef';
const KEY_REF = 'd-contact.line.webhook-payload/v1';
const PAYLOAD_KEY = randomBytes(32);
const USER_ID = `U${'b'.repeat(32)}`;
const OTHER_USER_ID = `U${'c'.repeat(32)}`;

let sequence = 0;
function event(overrides: Record<string, unknown> = {}) {
  sequence += 1;
  return {
    type: 'message',
    mode: 'active',
    webhookEventId: `01JX${String(sequence).padStart(6, '0')}`,
    deliveryContext: { isRedelivery: false },
    timestamp: Date.parse('2026-09-22T10:05:00.000Z') + sequence,
    source: { type: 'user', userId: USER_ID },
    message: { id: `${500_000_000_000 + sequence}`, type: 'text', text: 'Acknowledged' },
    ...overrides,
  };
}

async function setup(t: TestContext) {
  const fixture = await createLinePersistenceFixture();
  t.after(() => fixture.dispose());

  const binding = (tenantId: string): LineWebhookBinding => ({
    tenantId,
    channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
    destination: DESTINATION,
    channelSecret: SECRET,
    payloadKeyRef: KEY_REF,
    payloadKey: PAYLOAD_KEY,
  });
  const send = async (tenantId: string, events: unknown[]) => {
    const rawBody = Buffer.from(JSON.stringify({ destination: DESTINATION, events }), 'utf8');
    return new LineWebhookIngress(fixture.application, binding(tenantId)).handle({
      rawBody,
      signature: lineSignature(rawBody, SECRET),
      receivedAt: new Date(),
    });
  };

  const attempts = new Map<string, LineAcceptedAttempt>();
  const governanceCalls: RecordCorrelatedTouchInput[] = [];
  const touches = new AttemptTouchRepository(fixture.application);
  const governance: LineTouchGovernancePort = {
    findAcceptedAttemptByMessage: async ({ providerMessageId }) =>
      attempts.get(providerMessageId) ?? null,
    recordCorrelatedTouch: async (input) => {
      governanceCalls.push(input);
      await touches.recordCorrelatedTouch(input);
    },
  };

  const worker = (tenantId: string, now = () => new Date('2026-09-22T10:06:00.000Z')) =>
    new LineWebhookWorker({
      database: fixture.application,
      payloads: new EncryptedLineWebhookPayloadVault(fixture.application, {
        key: (ref) => (ref === KEY_REF ? PAYLOAD_KEY : undefined),
      }),
      governance,
      leaseOwner: `worker-${tenantId.slice(0, 8)}`,
      now,
    });

  /** an accepted delivery + the Attempt Governance wrote, and the message ID the user will quote */
  const seedAccepted = async (tenantId: string, providerMessageId: string, userId = USER_ID) => {
    const delivery = await fixture.seedDelivery(tenantId);
    const attemptId = await fixture.seedAcceptedAttempt(delivery);
    attempts.set(providerMessageId, {
      deliveryId: delivery.deliveryId,
      attemptId,
      reservationId: delivery.reservationId,
      actionKey: delivery.actionKey,
      recipientFingerprint: lineSourceFingerprint(PILOT_CHANNEL_ACCOUNT_ID, userId),
      acceptedAt: new Date('2026-09-22T10:01:00.000Z'),
    });
    return { ...delivery, attemptId };
  };

  return { fixture, send, worker, seedAccepted, governanceCalls, attempts };
}

test('S2-LINE-F04 a quoted response matching an accepted Attempt gets exactly one Touch through Governance', async (t) => {
  const f = await setup(t);
  const sent = '500000000999';
  const accepted = await f.seedAccepted(f.fixture.tenantA, sent);
  await f.send(f.fixture.tenantA, [
    event({ message: { id: '600000000001', type: 'text', text: 'Yes', quotedMessageId: sent } }),
  ]);

  const result = await f.worker(f.fixture.tenantA).runOnce(f.fixture.tenantA);
  assert.deepEqual(
    [result.processed, result.projected, result.touches, result.quarantined],
    [1, 1, 1, 0],
  );

  const touch = await f.fixture.owner.cgTouch.findFirstOrThrow({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.equal(touch.attemptId, accepted.attemptId);
  assert.equal(touch.evidenceKind, 'USER_QUOTED_RESPONSE');
  const correlation = await f.fixture.owner.dlLineTouchCorrelation.findFirstOrThrow({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.deepEqual([correlation.state, correlation.attemptId], ['BOUND', accepted.attemptId]);
  // Channels sends only the binding + evidence ref, no userId/body through the port
  assert.ok(!JSON.stringify(f.governanceCalls).includes(USER_ID));
  const events = await f.fixture.owner.dlLineEventOutboxEntry.findMany({
    where: { tenantId: f.fixture.tenantA, eventType: 'contact.touch.correlated.v1' },
  });
  assert.equal(events.length, 1);
});

test('S2-LINE-ID01 the same message object arriving under different webhookEventIds is projected once', async (t) => {
  const f = await setup(t);
  const providerMessageId = '500000000777';
  const first = event({ message: { id: providerMessageId, type: 'text', text: 'Hello' } });
  const second = event({ message: { id: providerMessageId, type: 'text', text: 'Hello' } });

  await f.send(f.fixture.tenantA, [first]);
  await f.send(f.fixture.tenantA, [second]);
  const result = await f.worker(f.fixture.tenantA).runOnce(f.fixture.tenantA);

  assert.equal(result.processed, 2);
  assert.equal(
    result.projected,
    1,
    'the second layer stops the same message from being projected again',
  );
  const projected = await f.fixture.owner.dlLineInboundMessage.findMany({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.equal(projected.length, 1);
  assert.equal(projected[0]!.providerMessageId, providerMessageId);
  assert.ok(!JSON.stringify(projected).includes(USER_ID));
  // both inbox entries are finished, none stuck
  const inbox = await f.fixture.owner.dlLineWebhookInboxEntry.findMany({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.ok(inbox.every((entry) => entry.state === 'COMPLETED'));
});

test('S2-LINE-RC03 a response arriving before acceptance stays pending then binds once the Attempt commits', async (t) => {
  const f = await setup(t);
  const sent = '500000000555';
  await f.send(f.fixture.tenantA, [
    event({ message: { id: '600000000002', type: 'text', text: 'Yes', quotedMessageId: sent } }),
  ]);

  const early = await f.worker(f.fixture.tenantA).runOnce(f.fixture.tenantA);
  assert.deepEqual([early.touches, early.pending], [0, 1]);
  const pending = await f.fixture.owner.dlLineTouchCorrelation.findFirstOrThrow({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.equal(pending.state, 'PENDING');
  assert.equal(await f.fixture.owner.cgTouch.count({ where: { tenantId: f.fixture.tenantA } }), 0);

  // acceptance commits later — the next worker round binds it itself without the provider resending
  const accepted = await f.seedAccepted(f.fixture.tenantA, sent);
  const resolved = await f.worker(f.fixture.tenantA).resolvePending(f.fixture.tenantA);
  assert.deepEqual([resolved.touches, resolved.quarantined], [1, 0]);
  const touch = await f.fixture.owner.cgTouch.findFirstOrThrow({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.equal(touch.attemptId, accepted.attemptId);
});

test('S2-LINE-RC03 past the window and still unbound, it is quarantined as USER_RESPONSE_UNBOUND', async (t) => {
  const f = await setup(t);
  await f.send(f.fixture.tenantA, [
    event({
      message: { id: '600000000003', type: 'text', text: 'Yes', quotedMessageId: '500000000444' },
    }),
  ]);
  await f.worker(f.fixture.tenantA).runOnce(f.fixture.tenantA);

  const afterWindow = () => new Date('2026-09-23T11:00:00.000Z');
  const resolved = await f.worker(f.fixture.tenantA, afterWindow).resolvePending(f.fixture.tenantA);
  assert.deepEqual([resolved.touches, resolved.quarantined], [0, 1]);
  const correlation = await f.fixture.owner.dlLineTouchCorrelation.findFirstOrThrow({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.deepEqual(
    [correlation.state, correlation.quarantineCode],
    ['QUARANTINED', 'USER_RESPONSE_UNBOUND'],
  );
  assert.equal(await f.fixture.owner.cgTouch.count({ where: { tenantId: f.fixture.tenantA } }), 0);
});

test('S2-LINE-F04 plain/group/a sender not matching the binding creates no Touch and an unknown type is quarantined', async (t) => {
  const f = await setup(t);
  const sent = '500000000333';
  await f.seedAccepted(f.fixture.tenantA, sent);

  await f.send(f.fixture.tenantA, [
    // 1. a plain message with no quote
    event({ message: { id: '600000000004', type: 'text', text: 'Hello' } }),
    // 2. a quote but from a group, not one-to-one
    event({
      source: { type: 'group', groupId: 'Cgroup', userId: USER_ID },
      message: { id: '600000000005', type: 'text', text: 'Yes', quotedMessageId: sent },
    }),
    // 3. a correct quote but the sender is not the recipient of that delivery
    event({
      source: { type: 'user', userId: OTHER_USER_ID },
      message: { id: '600000000006', type: 'text', text: 'Yes', quotedMessageId: sent },
    }),
    // 4. an event type the registry does not support yet
    event({ type: 'videoPlayComplete', message: undefined }),
  ]);

  const result = await f.worker(f.fixture.tenantA).runOnce(f.fixture.tenantA);
  assert.equal(result.processed, 4);
  assert.equal(result.touches, 0);
  assert.equal(await f.fixture.owner.cgTouch.count({ where: { tenantId: f.fixture.tenantA } }), 0);

  const inbox = await f.fixture.owner.dlLineWebhookInboxEntry.findMany({
    where: { tenantId: f.fixture.tenantA },
  });
  const unsupported = inbox.filter((entry) => entry.eventType === 'videoPlayComplete');
  assert.equal(unsupported.length, 1);
  assert.deepEqual(
    [unsupported[0]!.state, unsupported[0]!.outcomeCode],
    ['QUARANTINED', 'WEBHOOK_UNSUPPORTED_EVENT_TYPE'],
  );
  // a sender not matching the binding → the correlation is quarantined, not guessed to be a Touch
  const correlations = await f.fixture.owner.dlLineTouchCorrelation.findMany({
    where: { tenantId: f.fixture.tenantA },
  });
  assert.equal(correlations.length, 1);
  assert.deepEqual(
    [correlations[0]!.state, correlations[0]!.quarantineCode],
    ['QUARANTINED', 'USER_RESPONSE_UNBOUND'],
  );
});

test('S2-LINE-TI01 the worker of one tenant does not touch the inbox of another tenant', async (t) => {
  const f = await setup(t);
  const eventForB = event();
  await f.send(f.fixture.tenantB, [eventForB]);
  await f.send(f.fixture.tenantA, [event()]);

  const result = await f.worker(f.fixture.tenantA).runOnce(f.fixture.tenantA);
  assert.equal(result.processed, 1);

  const inboxB = await f.fixture.owner.dlLineWebhookInboxEntry.findMany({
    where: { tenantId: f.fixture.tenantB },
  });
  assert.equal(inboxB.length, 1);
  assert.equal(
    inboxB[0]!.state,
    'PENDING',
    'tenant B has not been processed by the worker of tenant A',
  );
  assert.equal(
    await f.fixture.owner.dlLineInboundMessage.count({ where: { tenantId: f.fixture.tenantB } }),
    0,
  );
});

test('S2-LINE-ID01 a worker rerun on the same inbox creates no second Touch or projection', async (t) => {
  const f = await setup(t);
  const sent = '500000000222';
  await f.seedAccepted(f.fixture.tenantA, sent);
  await f.send(f.fixture.tenantA, [
    event({ message: { id: '600000000007', type: 'text', text: 'Yes', quotedMessageId: sent } }),
  ]);

  const first = await f.worker(f.fixture.tenantA).runOnce(f.fixture.tenantA);
  assert.equal(first.touches, 1);
  // the lease expired and another worker takes over: the inbox is COMPLETED so it is not claimed again
  const second = await f
    .worker(f.fixture.tenantA, () => new Date('2026-09-22T12:00:00.000Z'))
    .runOnce(f.fixture.tenantA);
  assert.equal(second.processed, 0);

  assert.equal(await f.fixture.owner.cgTouch.count({ where: { tenantId: f.fixture.tenantA } }), 1);
  assert.equal(
    await f.fixture.owner.dlLineInboundMessage.count({ where: { tenantId: f.fixture.tenantA } }),
    1,
  );
  assert.equal(
    await f.fixture.owner.dlLineEventOutboxEntry.count({
      where: { tenantId: f.fixture.tenantA, eventType: 'contact.touch.correlated.v1' },
    }),
    1,
  );
});

test('#567 T4: two workers (loop + await-touch) at once on a single inbox project each message exactly once', async (t) => {
  const f = await setup(t);
  const tenantId = f.fixture.tenantA;
  const events = Array.from({ length: 12 }, (_, index) =>
    event({ message: { id: `${700_000_000_000 + index}`, type: 'text', text: 'concurrent' } }),
  );
  assert.equal((await f.send(tenantId, events)).status, 200);
  const make = (owner: string) =>
    new LineWebhookWorker({
      database: f.fixture.application,
      payloads: new EncryptedLineWebhookPayloadVault(f.fixture.application, {
        key: (ref) => (ref === KEY_REF ? PAYLOAD_KEY : undefined),
      }),
      governance: {
        findAcceptedAttemptByMessage: async () => null,
        recordCorrelatedTouch: async () => undefined,
      },
      leaseOwner: owner,
      batchSize: 3,
      now: () => new Date('2026-09-22T10:06:00.000Z'),
    });
  const loop = make('line-webhook-loop');
  const awaitTouch = make('s2-pilot-await-touch');
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, index) => (index % 2 ? loop : awaitTouch).runOnce(tenantId)),
  );
  assert.equal(
    results.reduce((sum, result) => sum + result.processed, 0),
    12,
  );
  assert.equal(await f.fixture.owner.dlLineInboundMessage.count({ where: { tenantId } }), 12);
});
