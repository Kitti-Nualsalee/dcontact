import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryFixture, RESERVED_AT } from './delivery-fixture.js';
import { VoiceOriginateDispatcher } from './voice-originate-dispatcher.js';
import { VoiceOriginateEnqueuer } from './voice-originate-enqueue.js';
import { VoiceOriginateOutcomeProcessor } from './voice-originate-outcome.js';

test('voice outcome: acceptance แล้ว terminal outcome แรกชนะและ settle durable เพียงครั้งเดียว', async (t) => {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const reservation = await context.createVoiceReservation('outcome');
  const input = {
    tenantId: context.rawTenantId,
    userId: context.agent.userId,
    leaseId: context.agent.leaseId,
    actionKey: reservation.rawActionKey,
    reservationId: reservation.rawId,
    contactId: context.command.contactId,
    identityId: context.rawPhoneIdentityId,
    correlationId: 'outcome-enqueue',
  };
  const enqueuer = new VoiceOriginateEnqueuer(context.application, context.governance, {
    enabled: true,
    now: () => new Date(RESERVED_AT),
    rollout: {
      evaluate: async () => ({ status: 'ALLOWED', state: 'SANDBOX', replay: false }),
      authorize: async () => ({ status: 'ALLOWED', state: 'SANDBOX', replay: false }),
    },
  });
  assert.equal((await enqueuer.enqueue(input)).status, 'QUEUED');
  const outbox = await context.owner.dlOutboxEntry.findFirstOrThrow({
    where: { tenantId: context.rawTenantId, actionKey: input.actionKey },
  });
  const dispatcher = new VoiceOriginateDispatcher(
    context.application,
    context.governance,
    { publish: async () => undefined },
    {
      enabled: true,
      rollout: {
        evaluate: async () => ({ status: 'ALLOWED', state: 'SANDBOX', replay: false }),
        authorize: async () => ({ status: 'ALLOWED', state: 'SANDBOX', replay: false }),
      },
    },
  );
  assert.deepEqual(
    await dispatcher.dispatch({
      tenantId: context.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'outcome-dispatch',
    }),
    { status: 'PUBLISHED' },
  );
  const processor = new VoiceOriginateOutcomeProcessor(context.application, context.governance);
  assert.equal(
    await processor.record({
      tenantId: context.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'outcome-accepted',
      outcomeRef: 'fs-accepted-001',
      outcome: 'PROVIDER_ACCEPTED',
      occurredAt: RESERVED_AT,
    }),
    'APPLIED',
  );
  assert.equal((await context.outboxRow(outbox.deliveryId))?.state, 'SUBMITTED');
  assert.equal(
    await processor.record({
      tenantId: context.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'outcome-delivered',
      outcomeRef: 'fs-answer-001',
      outcome: 'DELIVERED',
      occurredAt: RESERVED_AT,
    }),
    'APPLIED',
  );
  assert.equal(
    await processor.record({
      tenantId: context.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'outcome-late-failure',
      outcomeRef: 'fs-hangup-001',
      outcome: 'DELIVERY_FAILED',
      occurredAt: RESERVED_AT,
    }),
    'REPLAY',
  );
  assert.equal((await context.outboxRow(outbox.deliveryId))?.state, 'SETTLED');
  assert.equal(
    (
      await context.owner.dlVoiceOriginate.findFirstOrThrow({
        where: { tenantId: context.rawTenantId, deliveryId: outbox.deliveryId },
      })
    ).state,
    'SETTLED',
  );
});
