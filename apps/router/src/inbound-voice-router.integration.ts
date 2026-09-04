import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { KAFKA_TOPICS, type TelephonyCallEvent } from '@d-contact/shared';
import { InboundVoiceRouter } from './inbound-voice-router.js';

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});

test('call.created assigns one available tenant agent and duplicate input has no second effect', async (t) => {
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const userId = randomUUID();
  const callUuid = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Router ${tenantId}`,
      slug: `router-${tenantId}`,
      sipDomain: `${tenantId}.router.test`,
    },
  });
  await owner.queue.create({
    data: { id: queueId, tenantId, name: 'Voice queue', channels: ['VOICE'] },
  });
  await owner.voiceDestination.create({
    data: { tenantId, destination: '2000', queueId },
  });
  await owner.user.create({
    data: {
      id: userId,
      tenantId,
      email: `agent-${tenantId}@router.test`,
      passwordHash: 'not-used-by-router',
      displayName: 'Available agent',
      role: 'AGENT',
      extension: '1000',
    },
  });
  await owner.agentStateLog.create({ data: { tenantId, userId, state: 'AVAILABLE' } });
  t.after(async () => {
    await owner.interactionEvent.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.agentStateLog.deleteMany({ where: { tenantId } });
    await owner.voiceDestination.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  let now = '2026-09-04T05:10:00.000Z';
  const published: { topic: string; type: string; payload: Record<string, unknown> }[] = [];
  const router = new InboundVoiceRouter(application, {
    publish: async (topic, event) => {
      published.push({ topic, type: event.type, payload: event.payload });
    },
    eventId: () => randomUUID(),
    now: () => now,
  });
  const event = {
    eventId: 'telephony-event-1',
    type: 'call.created',
    tenantId,
    occurredAt: '2026-09-04T05:10:00.000Z',
    correlationId: callUuid,
    orderingKey: callUuid,
    payload: {
      callUuid,
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-bkk-02',
      caller: '1002',
      destination: '2000',
    },
  } satisfies {
    eventId: string;
    type: 'call.created';
    tenantId: string;
    occurredAt: string;
    correlationId: string;
    orderingKey: string;
    payload: TelephonyCallEvent;
  };

  const first = await router.handle(event);
  const second = await router.handle(event);

  assert.equal(first.status, 'ASSIGNED');
  assert.equal(first.agentId, userId);
  assert.equal(second.interactionId, first.interactionId);
  assert.equal(
    published.filter((message) => message.topic === KAFKA_TOPICS.INTERACTION_EVENTS).length,
    3,
  );
  assert.equal(published.filter((message) => message.type === 'routing.offered').length, 1);
  assert.deepEqual(
    published.find((message) => message.topic === KAFKA_TOPICS.TELEPHONY_COMMANDS)?.payload,
    {
      callUuid,
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-bkk-02',
      type: 'call.bridge',
      agentExtension: '1000',
    },
  );

  const answered = await router.handle({
    ...event,
    eventId: 'telephony-event-2',
    type: 'call.answered',
  });
  await router.handle({
    ...event,
    eventId: 'telephony-event-3',
    type: 'call.answered',
  });
  assert.equal(answered.status, 'ACTIVE');
  const interaction = await owner.interaction.findFirstOrThrow({
    where: { tenantId, id: first.interactionId },
    select: { state: true, answeredAt: true },
  });
  assert.equal(interaction.state, 'ACTIVE');
  assert.ok(interaction.answeredAt);
  assert.equal(published.filter((message) => message.type === 'interaction.answered').length, 1);

  const wrapup = await router.handle({
    ...event,
    eventId: 'telephony-event-4',
    type: 'call.hangup',
  });
  assert.equal(wrapup.status, 'WRAPUP');
  await assert.rejects(
    () =>
      router.completeWrapUp({
        tenantId,
        interactionId: first.interactionId,
        agentId: userId,
        code: ' ',
      }),
    /wrap-up code is required/,
  );
  const completed = await router.completeWrapUp({
    tenantId,
    interactionId: first.interactionId,
    agentId: userId,
    code: 'RESOLVED',
  });
  assert.equal(completed.status, 'COMPLETED');
  const closedInteraction = await owner.interaction.findFirstOrThrow({
    where: { tenantId, id: first.interactionId },
    select: { state: true, wrapUpCode: true },
  });
  assert.deepEqual(closedInteraction, { state: 'COMPLETED', wrapUpCode: 'RESOLVED' });
  const agentState = await owner.agentStateLog.findFirstOrThrow({
    where: { tenantId, userId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { state: true },
  });
  assert.equal(agentState.state, 'AVAILABLE');
  assert.equal(published.filter((message) => message.type === 'interaction.ended').length, 1);
  assert.equal(
    published.filter((message) => message.type === 'interaction.wrapup_completed').length,
    1,
  );

  await owner.queue.update({
    where: { id: queueId },
    data: {
      offerTimeoutSec: 10,
      offerTimeoutAction: 'IMMEDIATE_REQUEUE',
    },
  });
  const timeoutCallUuid = randomUUID();
  const timedOffer = await router.handle({
    ...event,
    eventId: 'telephony-event-timeout-1',
    correlationId: timeoutCallUuid,
    orderingKey: timeoutCallUuid,
    payload: { ...event.payload, callUuid: timeoutCallUuid },
  });
  assert.equal(timedOffer.status, 'ASSIGNED');
  now = '2026-09-04T05:10:11.000Z';
  await router.processDue();
  const requeuedInteraction = await owner.interaction.findFirstOrThrow({
    where: { tenantId, id: timedOffer.interactionId },
    select: { state: true, agentId: true },
  });
  assert.deepEqual(requeuedInteraction, { state: 'ASSIGNED', agentId: userId });
  assert.equal(
    published.filter((message) => message.type === 'interaction.offer_timed_out').length,
    1,
  );

  await router.handle({
    ...event,
    eventId: 'telephony-event-timeout-2',
    correlationId: timeoutCallUuid,
    orderingKey: timeoutCallUuid,
    type: 'call.answered',
    payload: { ...event.payload, callUuid: timeoutCallUuid },
  });
  await router.handle({
    ...event,
    eventId: 'telephony-event-timeout-3',
    correlationId: timeoutCallUuid,
    orderingKey: timeoutCallUuid,
    type: 'call.hangup',
    payload: { ...event.payload, callUuid: timeoutCallUuid },
  });
  await router.completeWrapUp({
    tenantId,
    interactionId: timedOffer.interactionId,
    agentId: userId,
    code: 'REQUEUED_RESOLVED',
  });

  await owner.queue.update({
    where: { id: queueId },
    data: {
      offerTimeoutAction: 'COOLDOWN_REQUEUE',
      offerCooldownSec: 60,
    },
  });
  const cooldownCallUuid = randomUUID();
  const cooldownOffer = await router.handle({
    ...event,
    eventId: 'telephony-event-cooldown-1',
    correlationId: cooldownCallUuid,
    orderingKey: cooldownCallUuid,
    payload: { ...event.payload, callUuid: cooldownCallUuid },
  });
  assert.equal(cooldownOffer.status, 'ASSIGNED');
  now = '2026-09-04T05:10:22.000Z';
  await router.processDue();
  const coolingInteraction = await owner.interaction.findFirstOrThrow({
    where: { tenantId, id: cooldownOffer.interactionId },
    select: { state: true, agentId: true, requeueAt: true },
  });
  assert.equal(coolingInteraction.state, 'QUEUED');
  assert.equal(coolingInteraction.agentId, null);
  assert.equal(coolingInteraction.requeueAt?.toISOString(), '2026-09-04T05:11:22.000Z');
  now = '2026-09-04T05:11:23.000Z';
  await router.processDue();
  const cooledRequeue = await owner.interaction.findFirstOrThrow({
    where: { tenantId, id: cooldownOffer.interactionId },
    select: { state: true, agentId: true, requeueAt: true },
  });
  assert.deepEqual(cooledRequeue, { state: 'ASSIGNED', agentId: userId, requeueAt: null });

  await router.handle({
    ...event,
    eventId: 'telephony-event-cooldown-2',
    correlationId: cooldownCallUuid,
    orderingKey: cooldownCallUuid,
    type: 'call.answered',
    payload: { ...event.payload, callUuid: cooldownCallUuid },
  });
  await router.handle({
    ...event,
    eventId: 'telephony-event-cooldown-3',
    correlationId: cooldownCallUuid,
    orderingKey: cooldownCallUuid,
    type: 'call.hangup',
    payload: { ...event.payload, callUuid: cooldownCallUuid },
  });
  await router.completeWrapUp({
    tenantId,
    interactionId: cooldownOffer.interactionId,
    agentId: userId,
    code: 'COOLDOWN_RESOLVED',
  });

  const disconnectCallUuid = randomUUID();
  const disconnectOffer = await router.handle({
    ...event,
    eventId: 'telephony-event-disconnect-1',
    correlationId: disconnectCallUuid,
    orderingKey: disconnectCallUuid,
    payload: { ...event.payload, callUuid: disconnectCallUuid },
  });
  assert.equal(disconnectOffer.status, 'ASSIGNED');
  const disconnected = await router.handle({
    ...event,
    eventId: 'telephony-event-disconnect-2',
    correlationId: disconnectCallUuid,
    orderingKey: disconnectCallUuid,
    type: 'call.hangup',
    payload: { ...event.payload, callUuid: disconnectCallUuid },
  });
  assert.equal(disconnected.status, 'ABANDONED');
  const abandonedInteraction = await owner.interaction.findFirstOrThrow({
    where: { tenantId, id: disconnectOffer.interactionId },
    select: { state: true, agentId: true, endedAt: true },
  });
  assert.equal(abandonedInteraction.state, 'ABANDONED');
  assert.equal(abandonedInteraction.agentId, userId);
  assert.ok(abandonedInteraction.endedAt);
  const availableAfterDisconnect = await owner.agentStateLog.findFirstOrThrow({
    where: { tenantId, userId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { state: true },
  });
  assert.equal(availableAfterDisconnect.state, 'AVAILABLE');

  const declinedCallUuid = randomUUID();
  const declinedOffer = await router.handle({
    ...event,
    eventId: 'telephony-event-decline-1',
    correlationId: declinedCallUuid,
    orderingKey: declinedCallUuid,
    payload: { ...event.payload, callUuid: declinedCallUuid },
  });
  const declined = await router.declineOffer({
    tenantId,
    interactionId: declinedOffer.interactionId,
    agentId: userId,
  });
  const declinedAgain = await router.declineOffer({
    tenantId,
    interactionId: declinedOffer.interactionId,
    agentId: userId,
  });
  assert.equal(declined.status, 'QUEUED');
  assert.equal(declinedAgain.status, 'QUEUED');
  const declinedInteraction = await owner.interaction.findFirstOrThrow({
    where: { tenantId, id: declinedOffer.interactionId },
    select: { state: true, agentId: true, requeueAt: true },
  });
  assert.deepEqual(declinedInteraction, {
    state: 'QUEUED',
    agentId: null,
    requeueAt: new Date('2026-09-04T05:12:23.000Z'),
  });
  assert.equal(
    await owner.interactionEvent.count({
      where: {
        tenantId,
        interactionId: declinedOffer.interactionId,
        type: 'interaction.offer_declined',
      },
    }),
    1,
  );

  await owner.agentStateLog.create({ data: { tenantId, userId, state: 'OFFLINE' } });
  await owner.queue.update({
    where: { id: queueId },
    data: { maxWaitSec: 5, maxWaitAction: 'VOICEMAIL' },
  });
  now = '2026-09-04T05:13:00.000Z';
  const maxWaitCallUuid = randomUUID();
  const maxWaitOffer = await router.handle({
    ...event,
    eventId: 'telephony-event-max-wait-1',
    correlationId: maxWaitCallUuid,
    orderingKey: maxWaitCallUuid,
    payload: { ...event.payload, callUuid: maxWaitCallUuid },
  });
  assert.equal(maxWaitOffer.status, 'QUEUED');
  await owner.interaction.updateMany({
    where: { tenantId, id: maxWaitOffer.interactionId },
    data: { queuedAt: new Date('2026-09-04T05:13:00.000Z') },
  });
  now = '2026-09-04T05:13:06.000Z';
  await router.processDue();
  const maxWaitInteraction = await owner.interaction.findFirstOrThrow({
    where: { tenantId, id: maxWaitOffer.interactionId },
    select: { state: true, endedAt: true },
  });
  assert.equal(maxWaitInteraction.state, 'ABANDONED');
  assert.ok(maxWaitInteraction.endedAt);
  const maxWaitEvent = await owner.interactionEvent.findFirstOrThrow({
    where: { tenantId, interactionId: maxWaitOffer.interactionId, type: 'interaction.abandoned' },
    select: { payload: true },
  });
  assert.deepEqual(maxWaitEvent.payload, { reason: 'max_wait_voicemail' });

  await owner.agentStateLog.create({ data: { tenantId, userId, state: 'AVAILABLE' } });
  await owner.queue.update({
    where: { id: queueId },
    data: {
      maxWaitSec: null,
      offerTimeoutSec: 1,
      offerTimeoutAction: 'ABANDON',
    },
  });
  now = '2026-09-04T05:14:00.000Z';
  const racedCallUuid = randomUUID();
  const racedOffer = await router.handle({
    ...event,
    eventId: 'telephony-event-race-1',
    correlationId: racedCallUuid,
    orderingKey: racedCallUuid,
    payload: { ...event.payload, callUuid: racedCallUuid },
  });
  assert.equal(racedOffer.status, 'ASSIGNED');
  now = '2026-09-04T05:14:02.000Z';
  await Promise.all([
    router.handle({
      ...event,
      eventId: 'telephony-event-race-2',
      correlationId: racedCallUuid,
      orderingKey: racedCallUuid,
      type: 'call.answered',
      payload: { ...event.payload, callUuid: racedCallUuid },
    }),
    router.processDue(),
  ]);
  const racedInteraction = await owner.interaction.findFirstOrThrow({
    where: { tenantId, id: racedOffer.interactionId },
    select: { state: true, agentId: true },
  });
  assert.deepEqual(racedInteraction, { state: 'ABANDONED', agentId: userId });
  assert.equal(
    await owner.interactionEvent.count({
      where: {
        tenantId,
        interactionId: racedOffer.interactionId,
        type: { in: ['interaction.answered', 'interaction.offer_timed_out'] },
      },
    }),
    1,
  );
});
