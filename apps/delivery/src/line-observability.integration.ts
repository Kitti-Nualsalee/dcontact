/**
 * S2.6 (#366) `S2-LINE-OB01`: the LINE observability snapshot read from the real canonical tables with the
 * application role (RLS in effect) — values left in the DB must become PII-free metrics/alerts
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  createLinePersistenceFixture,
  digest,
  PILOT_CHANNEL_ACCOUNT_ID,
} from './line-persistence-fixture.js';
import {
  evaluateLineAlerts,
  lineMetricSamples,
  lineObservabilitySnapshot,
} from './line-observability.js';

test('S2-LINE-OB01: stuck settlement, provider auth/quota, webhook quarantine, run denial and kill are counted from the DB', async (t) => {
  const context = await createLinePersistenceFixture();
  t.after(() => context.dispose());
  const now = new Date();
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const tenantId = context.tenantA;

  // three provider outcomes in the window — different deliveries because a terminal outcome closes that delivery
  const seeded = [];
  for (const [outcomeCode, httpStatus] of [
    ['LINE_AUTH_INVALID', 401],
    ['LINE_MONTHLY_QUOTA_EXHAUSTED', 429],
    ['LINE_UNKNOWN_OUTCOME', undefined],
  ] as const) {
    const delivery = await context.seedDelivery(tenantId, 'LINE_MESSAGING_API', minutesAgo(45));
    seeded.push(delivery);
    await context.attempts.record({
      id: randomUUID(),
      tenantId,
      deliveryId: delivery.deliveryId,
      providerRequestKey: delivery.providerRequestKey,
      attemptNo: 1,
      providerPayloadDigest: digest(`payload-${delivery.deliveryId}`),
      startedAt: minutesAgo(40),
      finishedAt: minutesAgo(40),
      outcomeCode,
      ...(httpStatus ? { httpStatus, rejectionScope: 'OPERATIONAL' as const } : {}),
    });
  }
  // an unknown-outcome row stuck RECONCILING for 40 minutes = beyond two rounds of the maximum backoff
  await context.owner.dlOutboxEntry.update({
    where: {
      id: (
        await context.owner.dlOutboxEntry.findFirstOrThrow({
          where: { tenantId, deliveryId: seeded[2]!.deliveryId },
        })
      ).id,
    },
    data: { state: 'RECONCILING', submittedAt: minutesAgo(40) },
  });

  const event = (webhookEventId: string, payloadHash = digest(webhookEventId)) => ({
    id: randomUUID(),
    webhookEventId,
    payloadHash,
    eventType: 'message',
    deliveryMode: 'active' as const,
    isRedelivery: false,
    providerTimestamp: minutesAgo(10),
    protectedPayloadRef: `prot:webhook:${randomUUID()}`,
  });
  const batch = (events: ReturnType<typeof event>[]) =>
    context.webhooks.acceptBatch({
      tenantId,
      channelAccountId: PILOT_CHANNEL_ACCOUNT_ID,
      receivedAt: minutesAgo(10),
      events,
    });
  await batch([event('01J0OBSPENDING'), event('01J0OBSCONFLICT')]);
  await batch([event('01J0OBSCONFLICT', digest('tampered'))]);

  const gate = await context.control.ensureGate(randomUUID(), context.scope(tenantId));
  await context.owner.dlLineScopeGate.update({
    where: { id: gate.id },
    data: {
      killed: true,
      killReason: 'AUTH_FAILURE',
      killedAt: minutesAgo(39),
      version: gate.version + 1,
    },
  });
  await context.owner.dlLineAuditEvent.create({
    data: {
      tenantId,
      eventId: `obs-denied-${randomUUID()}`,
      category: 'RUN_AUTHORIZATION',
      code: 'RUN_DENIED',
      actorKind: 'SYSTEM',
      actorRef: 'line-outbound-worker',
      occurredAt: minutesAgo(5),
    },
  });

  const snapshot = await lineObservabilitySnapshot(context.application, {
    tenantId,
    now,
    ingress: { signatureInvalid: 2, durabilityUnavailable: 0 },
  });
  assert.equal(snapshot.settlement.reconciling, 1);
  assert.ok((snapshot.settlement.oldestInFlightAgeSeconds ?? 0) >= 40 * 60);
  assert.equal(snapshot.provider.authInvalid, 1);
  assert.equal(snapshot.provider.quotaExhausted, 1);
  assert.equal(snapshot.provider.unavailable, 1);
  assert.equal(snapshot.webhook.quarantined, 1);
  assert.ok(snapshot.webhook.pending >= 1);
  assert.equal(snapshot.control.killedScopes, 1);
  assert.equal(snapshot.control.automaticKills, 1);
  assert.equal(snapshot.control.runDenials, 1);

  const codes = evaluateLineAlerts(snapshot).map(({ code }) => code);
  for (const expected of [
    'LINE_SETTLEMENT_STUCK',
    'LINE_AUTH_FAILURE',
    'LINE_QUOTA_EXHAUSTED',
    'LINE_WEBHOOK_SIGNATURE_INVALID',
    'LINE_WEBHOOK_QUARANTINED',
    'LINE_CAP_OR_RUN_DENIED',
    'LINE_AUTOMATIC_KILL',
  ])
    assert.ok(codes.includes(expected as never), expected);

  const samples = JSON.stringify(lineMetricSamples(snapshot));
  for (const delivery of seeded) assert.ok(!samples.includes(delivery.deliveryId));
  assert.ok(!samples.includes(PILOT_CHANNEL_ACCOUNT_ID));

  // RLS: another tenant sees all zeros and no alert
  const other = await lineObservabilitySnapshot(context.application, {
    tenantId: context.tenantB,
    now,
  });
  assert.deepEqual(evaluateLineAlerts(other), []);
  assert.equal(other.settlement.inFlight + other.webhook.pending + other.control.killedScopes, 0);
});
