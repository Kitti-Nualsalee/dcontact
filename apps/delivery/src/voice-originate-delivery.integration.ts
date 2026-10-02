import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createDeliveryFixture, RESERVED_AT } from './delivery-fixture.js';
import { VoiceOriginateDeliveryService } from './voice-originate-delivery.js';
import { VoiceOriginateEnqueuer } from './voice-originate-enqueue.js';
import { VoiceOriginateOutcomeProcessor } from './voice-originate-outcome.js';
import { VoiceRolloutControlPlane } from './voice-rollout-control.js';
import { VoiceTelephonyOutcomeHandler } from './voice-telephony-outcome.js';

async function setup(t: TestContext) {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const at = new Date(RESERVED_AT);
  const rollout = new VoiceRolloutControlPlane(context.application);
  const scope = { tenantId: context.rawTenantId, telephonyNodeId: 'fs-local' };
  await rollout.ensureScope(scope);
  await rollout.advanceState(scope, 'DRY_RUN', 'operator-1', at);
  await rollout.advanceState(scope, 'SANDBOX', 'operator-1', at);
  await rollout.setTechnicalSwitch(scope, true, 'operator-1', at);
  await rollout.allow({
    ...scope,
    agentUserId: context.agent.userId,
    targetIdentityId: context.rawPhoneIdentityId,
    validFrom: at,
    validUntil: new Date(at.getTime() + 60_000),
    actorRef: 'operator-1',
  });
  const reservation = await context.createVoiceReservation('delivery-service');
  const input = {
    tenantId: context.rawTenantId,
    userId: context.agent.userId,
    leaseId: context.agent.leaseId,
    actionKey: reservation.rawActionKey,
    reservationId: reservation.rawId,
    contactId: context.command.contactId,
    identityId: context.rawPhoneIdentityId,
    correlationId: 'delivery-service',
  };
  return { context, at, rollout, reservation, input };
}

test('voice delivery service ครบ enqueue → publish → telephony outcomes → settle', async (t) => {
  const fixture = await setup(t);
  const commands: Array<Record<string, unknown>> = [];
  const service = new VoiceOriginateDeliveryService(
    fixture.context.application,
    fixture.context.governance,
    { publish: async ({ command }) => void commands.push(command) },
    { enabled: true, now: () => fixture.at, rollout: fixture.rollout },
  );
  assert.deepEqual(await service.enqueue(fixture.input), { status: 'QUEUED' });
  assert.equal(commands.length, 1);
  const command = commands[0]!;
  const handler = new VoiceTelephonyOutcomeHandler(
    new VoiceOriginateOutcomeProcessor(fixture.context.application, fixture.context.governance),
  );
  for (const type of ['call.created', 'call.answered'] as const) {
    assert.equal(
      await handler.handle({
        eventId: `event-${type}`,
        type,
        tenantId: fixture.context.rawTenantId,
        occurredAt: RESERVED_AT,
        correlationId: 'call-1',
        payload: {
          deliveryId: String(command.deliveryId),
          providerRequestKey: String(command.providerRequestKey),
        },
      }),
      'APPLIED',
    );
  }
  assert.equal((await fixture.context.outboxRow(String(command.deliveryId)))?.state, 'SETTLED');
  assert.equal(
    (await fixture.context.reservationRow(fixture.reservation.rawId))?.settlementStatus,
    'SETTLED',
  );
});

test('publish failure หลัง barrier คง UNKNOWN_RECONCILING และไม่ release reservation', async (t) => {
  const fixture = await setup(t);
  const service = new VoiceOriginateDeliveryService(
    fixture.context.application,
    fixture.context.governance,
    { publish: async () => Promise.reject(new Error('Kafka unavailable')) },
    { enabled: true, now: () => fixture.at, rollout: fixture.rollout },
  );
  assert.deepEqual(await service.enqueue(fixture.input), {
    status: 'UNAVAILABLE',
    reasonCode: 'VOICE_DELIVERY_RECONCILING',
    reservationFinalized: true,
  });
  const reservation = await fixture.context.reservationRow(fixture.reservation.rawId);
  assert.equal(reservation?.state, 'RESERVED');
  assert.equal(reservation?.settlementStatus, 'UNKNOWN_RECONCILING');
});

test('cancel หลัง barrier บันทึก reconcile ก่อนส่ง call.cancel และ replay ไม่ส่งซ้ำ', async (t) => {
  const fixture = await setup(t);
  const commands: Array<Record<string, unknown>> = [];
  const service = new VoiceOriginateDeliveryService(
    fixture.context.application,
    fixture.context.governance,
    { publish: async ({ command }) => void commands.push(command) },
    { enabled: true, now: () => fixture.at, rollout: fixture.rollout },
  );
  assert.deepEqual(await service.enqueue(fixture.input), { status: 'QUEUED' });
  const cancel = {
    tenantId: fixture.context.rawTenantId,
    userId: fixture.context.agent.userId,
    leaseId: fixture.context.agent.leaseId,
    actionKey: fixture.input.actionKey,
    correlationId: 'cancel-after-barrier',
  };
  assert.deepEqual(await service.cancel(cancel), { status: 'RECONCILING' });
  assert.deepEqual(await service.cancel(cancel), { status: 'RECONCILING' });
  assert.deepEqual(
    commands.map((command) => command.type),
    ['call.originate', 'call.cancel'],
  );
  const delivery = await fixture.context.owner.dlVoiceOriginate.findFirstOrThrow({
    where: { tenantId: fixture.context.rawTenantId },
  });
  assert.equal(delivery.state, 'CANCEL_REQUESTED');
  assert.equal(
    (await fixture.context.reservationRow(fixture.reservation.rawId))?.settlementStatus,
    'UNKNOWN_RECONCILING',
  );
});

test('cancel ก่อน barrier release reservation และไม่ publish provider command', async (t) => {
  const fixture = await setup(t);
  const enqueuer = new VoiceOriginateEnqueuer(
    fixture.context.application,
    fixture.context.governance,
    { enabled: true, now: () => fixture.at, rollout: fixture.rollout },
  );
  assert.equal((await enqueuer.enqueue(fixture.input)).status, 'QUEUED');
  let publishCount = 0;
  const service = new VoiceOriginateDeliveryService(
    fixture.context.application,
    fixture.context.governance,
    { publish: async () => void (publishCount += 1) },
    { enabled: true, now: () => fixture.at, rollout: fixture.rollout },
  );
  assert.deepEqual(
    await service.cancel({
      tenantId: fixture.context.rawTenantId,
      userId: fixture.context.agent.userId,
      leaseId: fixture.context.agent.leaseId,
      actionKey: fixture.input.actionKey,
      correlationId: 'cancel-before-barrier',
    }),
    { status: 'CANCELLED' },
  );
  assert.equal(publishCount, 0);
  assert.equal(
    (await fixture.context.reservationRow(fixture.reservation.rawId))?.state,
    'RELEASED',
  );
});
