import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryFixture, RESERVED_AT } from './delivery-fixture.js';
import {
  VoiceOriginateDispatcher,
  type VoiceOriginateCommand,
} from './voice-originate-dispatcher.js';
import { VoiceOriginateEnqueuer } from './voice-originate-enqueue.js';

function enqueueInput(context: Awaited<ReturnType<typeof createDeliveryFixture>>, label: string) {
  return context.createVoiceReservation(label).then((reservation) => ({
    tenantId: context.rawTenantId,
    userId: context.agent.userId,
    leaseId: context.agent.leaseId,
    actionKey: reservation.rawActionKey,
    reservationId: reservation.rawId,
    contactId: context.command.contactId,
    identityId: context.rawPhoneIdentityId,
    correlationId: `corr-${label}`,
  }));
}

const fixtureNow = () => new Date(RESERVED_AT);
const allowRollout = {
  evaluate: async () => ({ status: 'ALLOWED', state: 'SANDBOX', replay: false }) as const,
  authorize: async () => ({ status: 'ALLOWED', state: 'SANDBOX', replay: false }) as const,
};

test('voice dispatcher persist submission barrier ก่อน publish command opaque เพียงครั้งเดียว', async (t) => {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const input = await enqueueInput(context, 'published');
  const enqueuer = new VoiceOriginateEnqueuer(context.application, context.governance, {
    enabled: true,
    now: fixtureNow,
    rollout: allowRollout,
  });
  assert.equal((await enqueuer.enqueue(input)).status, 'QUEUED');
  const outbox = await context.owner.dlOutboxEntry.findFirstOrThrow({
    where: { tenantId: context.rawTenantId, actionKey: input.actionKey },
  });
  const commands: VoiceOriginateCommand[] = [];
  const dispatcher = new VoiceOriginateDispatcher(
    context.application,
    context.governance,
    {
      publish: async ({ command }) => {
        assert.equal(command.type, 'call.originate');
        if (command.type === 'call.originate') commands.push(command);
      },
    },
    { enabled: true, rollout: allowRollout },
  );

  assert.deepEqual(
    await dispatcher.dispatch({
      tenantId: context.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'dispatch-published',
    }),
    { status: 'PUBLISHED' },
  );
  assert.equal(commands.length, 1);
  assert.deepEqual(Object.keys(commands[0]).sort(), [
    'agentExtension',
    'deliveryId',
    'originationUuid',
    'providerRequestKey',
    'targetIdentityId',
    'telephonyNodeId',
    'type',
    'vendor',
  ]);
  assert.equal(commands[0].providerRequestKey, outbox.providerRequestKey);
  assert.equal(JSON.stringify(commands), JSON.stringify(commands).replaceAll('0812345678', ''));
  assert.equal((await context.outboxRow(outbox.deliveryId))?.state, 'SUBMITTING');

  assert.deepEqual(
    await dispatcher.dispatch({
      tenantId: context.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'dispatch-retry',
    }),
    { status: 'RECONCILE_REQUIRED' },
  );
  assert.equal(commands.length, 1);
});

test('voice dispatcher publish ล้มเหลวหลัง barrier แล้วต้อง reconcile โดยไม่ retry', async (t) => {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const input = await enqueueInput(context, 'publish-failure');
  const enqueuer = new VoiceOriginateEnqueuer(context.application, context.governance, {
    enabled: true,
    now: fixtureNow,
    rollout: allowRollout,
  });
  assert.equal((await enqueuer.enqueue(input)).status, 'QUEUED');
  const outbox = await context.owner.dlOutboxEntry.findFirstOrThrow({
    where: { tenantId: context.rawTenantId, actionKey: input.actionKey },
  });
  let attempted = 0;
  const dispatcher = new VoiceOriginateDispatcher(
    context.application,
    context.governance,
    {
      publish: async () => {
        attempted += 1;
        throw new Error('Kafka unavailable');
      },
    },
    { enabled: true, rollout: allowRollout },
  );

  assert.deepEqual(
    await dispatcher.dispatch({
      tenantId: context.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'dispatch-failure',
    }),
    { status: 'RECONCILE_REQUIRED' },
  );
  assert.equal(attempted, 1);
  assert.equal((await context.outboxRow(outbox.deliveryId))?.state, 'RECONCILING');
  assert.equal(
    (
      await context.owner.dlVoiceOriginate.findFirstOrThrow({
        where: { tenantId: context.rawTenantId, deliveryId: outbox.deliveryId },
      })
    ).state,
    'RECONCILING',
  );
  assert.equal(
    (await context.reservationRow(input.reservationId))?.settlementStatus,
    'UNKNOWN_RECONCILING',
  );

  assert.deepEqual(
    await dispatcher.dispatch({
      tenantId: context.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'dispatch-failure-retry',
    }),
    { status: 'RECONCILE_REQUIRED' },
  );
  assert.equal(attempted, 1);
});

test('voice dispatcher default-off ไม่แตะ provider submission หรือ publisher', async (t) => {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const input = await enqueueInput(context, 'disabled');
  const enqueuer = new VoiceOriginateEnqueuer(context.application, context.governance, {
    enabled: true,
    now: fixtureNow,
    rollout: allowRollout,
  });
  assert.equal((await enqueuer.enqueue(input)).status, 'QUEUED');
  const outbox = await context.owner.dlOutboxEntry.findFirstOrThrow({
    where: { tenantId: context.rawTenantId, actionKey: input.actionKey },
  });
  let published = false;
  const dispatcher = new VoiceOriginateDispatcher(context.application, context.governance, {
    publish: async () => {
      published = true;
    },
  });

  assert.deepEqual(
    await dispatcher.dispatch({
      tenantId: context.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'dispatch-disabled',
    }),
    { status: 'BLOCKED', reasonCode: 'OUTBOUND_VOICE_DISABLED' },
  );
  assert.equal(published, false);
  assert.equal((await context.outboxRow(outbox.deliveryId))?.state, 'QUEUED');
  assert.equal((await context.reservationRow(input.reservationId))?.settlementStatus, 'CLAIMED');
});
