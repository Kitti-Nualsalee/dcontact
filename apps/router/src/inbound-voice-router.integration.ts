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

  const published: { topic: string; type: string; payload: Record<string, unknown> }[] = [];
  const router = new InboundVoiceRouter(application, {
    publish: async (topic, event) => {
      published.push({ topic, type: event.type, payload: event.payload });
    },
    eventId: () => randomUUID(),
    now: () => '2026-09-04T05:10:00.000Z',
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
});
