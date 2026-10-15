import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeliveryFixture, RESERVED_AT } from './delivery-fixture.js';
import { DatabaseE1VoiceCommandAuthority } from './e1-voice-command-authority.js';
import { VoiceOriginateEnqueuer } from './voice-originate-enqueue.js';
import {
  VoiceOriginateDispatcher,
  type VoiceOriginateCommandPublisher,
} from './voice-originate-dispatcher.js';
import { VoiceRolloutControlPlane } from './voice-rollout-control.js';
import { VoiceOriginateOutcomeProcessor } from './voice-originate-outcome.js';
import { VoiceOriginateDeliveryService } from './voice-originate-delivery.js';

type CommandInput = Parameters<VoiceOriginateCommandPublisher['publish']>[0];
const now = () => new Date(RESERVED_AT);

async function createGatewayFixture(context: { after(callback: () => Promise<void>): void }) {
  const fixture = await createDeliveryFixture();
  context.after(() => fixture.dispose());
  await fixture.owner.contactIdentity.update({
    where: { id: fixture.rawPhoneIdentityId },
    data: { value: '1102' },
  });
  const rollout = new VoiceRolloutControlPlane(fixture.application);
  const scope = { tenantId: fixture.rawTenantId, telephonyNodeId: 'fs-local' };
  await rollout.ensureScope(scope);
  await rollout.advanceState(scope, 'DRY_RUN', 'test:e1-gateway', now());
  await rollout.advanceState(scope, 'SANDBOX', 'test:e1-gateway', now());
  await rollout.setTechnicalSwitch(scope, true, 'test:e1-gateway', now());
  await rollout.allow({
    ...scope,
    agentUserId: fixture.agent.userId,
    targetIdentityId: fixture.rawPhoneIdentityId,
    validFrom: now(),
    validUntil: new Date(now().getTime() + 60_000),
    actorRef: 'test:e1-gateway',
  });
  const reservation = await fixture.createVoiceReservation('e1-gateway');
  const enqueuer = new VoiceOriginateEnqueuer(fixture.application, fixture.governance, {
    enabled: true,
    rollout,
    now,
  });
  assert.equal(
    (
      await enqueuer.enqueue({
        tenantId: fixture.rawTenantId,
        userId: fixture.agent.userId,
        leaseId: fixture.agent.leaseId,
        actionKey: reservation.rawActionKey,
        reservationId: reservation.rawId,
        contactId: fixture.command.contactId,
        identityId: fixture.rawPhoneIdentityId,
        correlationId: 'e1-gateway',
      })
    ).status,
    'QUEUED',
  );
  const outbox = await fixture.owner.dlOutboxEntry.findFirstOrThrow({
    where: {
      tenantId: fixture.rawTenantId,
      actionKey: reservation.rawActionKey,
    },
  });
  let command: CommandInput | undefined;
  const dispatch = () =>
    new VoiceOriginateDispatcher(
      fixture.application,
      fixture.governance,
      {
        publish: async (input) => {
          command = input;
        },
      },
      { enabled: true, rollout, now },
    ).dispatch({
      tenantId: fixture.rawTenantId,
      deliveryId: outbox.deliveryId,
      correlationId: 'e1-gateway',
    });
  return {
    ...fixture,
    rollout,
    scope,
    outbox,
    dispatch,
    input: () => {
      assert.ok(command);
      return command;
    },
    authority: () => new DatabaseE1VoiceCommandAuthority(fixture.application, now),
  };
}

test('E1 gateway claim ต้องผ่าน submission barrier/cap แล้ว durable เพียงครั้งเดียวแม้ restart/concurrent', async (context) => {
  const fixture = await createGatewayFixture(context);
  const voice = await fixture.owner.dlVoiceOriginate.findFirstOrThrow({
    where: {
      tenantId: fixture.rawTenantId,
      deliveryId: fixture.outbox.deliveryId,
    },
  });
  assert.equal(
    await fixture.authority().claim({
      tenantId: fixture.rawTenantId,
      command: {
        type: 'call.originate',
        vendor: 'freeswitch',
        telephonyNodeId: voice.telephonyNodeId,
        deliveryId: voice.deliveryId,
        providerRequestKey: fixture.outbox.providerRequestKey,
        originationUuid: voice.originationUuid,
        agentExtension: voice.agentExtension,
        targetIdentityId: voice.targetIdentityId,
      },
    }),
    false,
  );
  assert.equal((await fixture.dispatch()).status, 'PUBLISHED');
  const input = fixture.input();
  const tampered = { ...input, command: { ...input.command, providerRequestKey: 'other-request' } };
  assert.equal(await fixture.authority().claim(tampered), false);
  assert.equal(
    await fixture.authority().claim({ ...input, tenantId: fixture.otherTenantId }),
    false,
  );
  const claims = await Promise.all([
    fixture.authority().claim(input),
    fixture.authority().claim(input),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(await fixture.authority().claim(input), false);
  const processor = new VoiceOriginateOutcomeProcessor(
    fixture.application,
    fixture.governance,
    now,
  );
  await processor.record({
    tenantId: input.tenantId,
    deliveryId: input.command.deliveryId,
    correlationId: 'e1-gateway',
    outcomeRef: 'e1-provider-accepted',
    occurredAt: RESERVED_AT,
    outcome: 'PROVIDER_ACCEPTED',
  });
  await processor.record({
    tenantId: input.tenantId,
    deliveryId: input.command.deliveryId,
    correlationId: 'e1-gateway',
    outcomeRef: 'e1-provider-delivered',
    occurredAt: RESERVED_AT,
    outcome: 'DELIVERED',
  });
  assert.equal((await fixture.outboxRow(input.command.deliveryId))?.state, 'SETTLED');
  assert.equal(await fixture.authority().claim(input), false);
});

test('E1 gateway ปฏิเสธ external target และ technical switch ที่ปิดหลัง dispatch', async (context) => {
  const fixture = await createGatewayFixture(context);
  assert.equal((await fixture.dispatch()).status, 'PUBLISHED');
  await fixture.owner.contactIdentity.update({
    where: { id: fixture.rawPhoneIdentityId },
    data: { value: '0812345678' },
  });
  assert.equal(await fixture.authority().claim(fixture.input()), false);
  await fixture.owner.contactIdentity.update({
    where: { id: fixture.rawPhoneIdentityId },
    data: { value: '1102' },
  });
  await fixture.rollout.setTechnicalSwitch(fixture.scope, false, 'test:e1-gateway', now());
  assert.equal(await fixture.authority().claim(fixture.input()), false);
  await fixture.rollout.setTechnicalSwitch(fixture.scope, true, 'test:e1-gateway', now());
  await fixture.owner.cgReservation.update({
    where: { id: fixture.outbox.reservationId },
    data: { submissionStartedAt: null },
  });
  assert.equal(await fixture.authority().claim(fixture.input()), false);
});

test('E1 gateway cancel ต้องมี durable CANCEL_REQUESTED และ binding ตรง; ใช้ได้เมื่อปิด switch แล้ว', async (context) => {
  const fixture = await createGatewayFixture(context);
  assert.equal((await fixture.dispatch()).status, 'PUBLISHED');
  const originate = fixture.input();
  assert.equal(await fixture.authority().claim(originate), true);
  let cancel: CommandInput | undefined;
  const delivery = new VoiceOriginateDeliveryService(
    fixture.application,
    fixture.governance,
    {
      publish: async (input) => {
        cancel = input;
      },
    },
    { enabled: true, rollout: fixture.rollout, now },
  );
  await fixture.rollout.setTechnicalSwitch(fixture.scope, false, 'test:e1-gateway', now());
  assert.equal(
    (
      await delivery.cancel({
        tenantId: fixture.rawTenantId,
        userId: fixture.agent.userId,
        leaseId: fixture.agent.leaseId,
        actionKey: fixture.outbox.actionKey,
        correlationId: 'cancel-e1-gateway',
      })
    ).status,
    'RECONCILING',
  );
  assert.ok(cancel);
  assert.equal(cancel.command.type, 'call.cancel');
  if (cancel.command.type !== 'call.cancel') throw new Error('expected cancel');
  assert.equal(
    await fixture.authority().claim({
      ...cancel,
      command: { ...cancel.command, callUuid: '00000000-0000-4000-8000-000000000009' },
    }),
    false,
  );
  assert.equal(await fixture.authority().claim(cancel), true);
  assert.equal(await fixture.authority().claim(cancel), false);
});
