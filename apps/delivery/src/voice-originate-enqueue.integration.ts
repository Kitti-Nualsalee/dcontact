import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createDeliveryFixture, RESERVED_AT } from './delivery-fixture.js';
import { VoiceOriginateEnqueuer } from './voice-originate-enqueue.js';

const allowRollout = {
  evaluate: async () => ({ status: 'ALLOWED', state: 'SANDBOX', replay: false }) as const,
  authorize: async () => ({ status: 'ALLOWED', state: 'SANDBOX', replay: false }) as const,
};

async function fixture(t: TestContext) {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const reservation = await context.createVoiceReservation('enqueue');
  const enqueuer = new VoiceOriginateEnqueuer(context.application, context.governance, {
    enabled: true,
    now: () => new Date(RESERVED_AT),
    rollout: allowRollout,
  });
  const input = {
    tenantId: context.rawTenantId,
    userId: context.agent.userId,
    leaseId: context.agent.leaseId,
    actionKey: reservation.rawActionKey,
    reservationId: reservation.rawId,
    contactId: context.command.contactId,
    identityId: context.rawPhoneIdentityId,
    correlationId: 'voice-enqueue-test',
  };
  return { context, enqueuer, input, reservation };
}

test('kill switch ปิดเป็นค่าเริ่มต้น: ไม่ claim reservation และไม่สร้าง durable record', async (t) => {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const reservation = await context.createVoiceReservation('disabled');
  const enqueuer = new VoiceOriginateEnqueuer(context.application, context.governance);

  assert.deepEqual(
    await enqueuer.enqueue({
      tenantId: context.rawTenantId,
      userId: context.agent.userId,
      leaseId: context.agent.leaseId,
      actionKey: reservation.rawActionKey,
      reservationId: reservation.rawId,
      contactId: context.command.contactId,
      identityId: context.rawPhoneIdentityId,
      correlationId: 'voice-enqueue-disabled',
    }),
    { status: 'UNAVAILABLE', reasonCode: 'OUTBOUND_VOICE_DISABLED' },
  );
  assert.equal(await context.outboxCount(), 0);
  assert.equal((await context.reservationRow(reservation.rawId))?.settlementStatus, 'UNCLAIMED');
});

test('claim แล้ว commit interaction, generic outbox และ voice extension ก่อนตอบ QUEUED', async (t) => {
  const { context, enqueuer, input, reservation } = await fixture(t);

  assert.equal((await enqueuer.enqueue(input)).status, 'QUEUED');

  const outbox = await context.owner.dlOutboxEntry.findFirstOrThrow({
    where: { tenantId: context.rawTenantId, actionKey: input.actionKey },
  });
  const voice = await context.owner.dlVoiceOriginate.findFirstOrThrow({
    where: { tenantId: context.rawTenantId, deliveryId: outbox.deliveryId },
  });
  const interaction = await context.owner.interaction.findFirstOrThrow({
    where: { tenantId: context.rawTenantId, id: voice.interactionId },
  });
  const events = await context.owner.interactionEvent.findMany({
    where: { tenantId: context.rawTenantId, interactionId: interaction.id },
    orderBy: { id: 'asc' },
  });
  const claimed = await context.reservationRow(reservation.rawId);

  assert.equal(outbox.adapter, 'FREESWITCH_ORIGINATE');
  assert.equal(outbox.channel, 'VOICE');
  assert.equal(voice.workSessionLeaseId, context.agent.leaseId);
  assert.equal(voice.agentUserId, context.agent.userId);
  assert.equal(voice.agentExtension, '1001');
  assert.match(
    voice.originationUuid,
    /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  assert.equal(interaction.direction, 'OUTBOUND');
  assert.equal(interaction.state, 'ASSIGNED');
  assert.equal(interaction.agentId, context.agent.userId);
  assert.equal(interaction.contactId, context.command.contactId);
  assert.deepEqual(
    events.map((event) => event.type),
    ['interaction.created', 'interaction.assigned'],
  );
  assert.equal(claimed?.settlementStatus, 'CLAIMED');
  const persisted = JSON.stringify(
    { outbox, voice, interaction, events },
    (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
  );
  assert.equal(persisted.includes('0812345678'), false);
});

test('actionKey เดิม replay durable voice delivery เดิมโดยไม่สร้าง interaction ซ้ำ', async (t) => {
  const { context, enqueuer, input } = await fixture(t);

  const first = await enqueuer.enqueue(input);
  const replay = await enqueuer.enqueue({ ...input, correlationId: 'voice-enqueue-replay' });
  assert.equal(first.status, 'QUEUED');
  assert.deepEqual(replay, first);

  assert.equal(await context.outboxCount(), 1);
  assert.equal(
    await context.owner.dlVoiceOriginate.count({ where: { tenantId: context.rawTenantId } }),
    1,
  );
  assert.equal(
    await context.owner.interaction.count({ where: { tenantId: context.rawTenantId } }),
    1,
  );
});

test('transaction ล้มเหลวหลัง claim ต้อง rollback interaction/outbox และ release reservation แบบ bound', async (t) => {
  const { context, enqueuer, input, reservation } = await fixture(t);
  await context.owner.agentSipCredential.update({
    where: { workSessionLeaseId: context.agent.leaseId },
    data: { telephonyNodeId: 'invalid node' },
  });

  assert.deepEqual(await enqueuer.enqueue(input), {
    status: 'UNAVAILABLE',
    reasonCode: 'VOICE_DELIVERY_UNAVAILABLE',
    reservationReleased: true,
  });

  assert.equal(await context.outboxCount(), 0);
  assert.equal(
    await context.owner.dlVoiceOriginate.count({ where: { tenantId: context.rawTenantId } }),
    0,
  );
  assert.equal(
    await context.owner.interaction.count({ where: { tenantId: context.rawTenantId } }),
    0,
  );
  const released = await context.reservationRow(reservation.rawId);
  assert.equal(released?.state, 'RELEASED');
  assert.equal(released?.settlementStatus, 'SETTLED');
});
