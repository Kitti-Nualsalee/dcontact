import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { InboundVoiceRouter } from './inbound-voice-router.js';

test('Router assigns only an AVAILABLE agent whose skills meet every queue minimum', async (t) => {
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
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const skillId = randomUUID();
  const secondSkillId = randomUUID();
  const ineligibleAgentId = '00000000-0000-4000-8000-000000000001';
  const eligibleAgentId = '00000000-0000-4000-8000-000000000002';
  const callUuid = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Routing ${tenantId}`,
      slug: `routing-policy-${tenantId}`,
      sipDomain: `${tenantId}.routing-policy.test`,
    },
  });
  await owner.queue.create({
    data: { id: queueId, tenantId, name: 'Billing', channels: ['VOICE'] },
  });
  await owner.voiceDestination.create({
    data: { tenantId, destination: '2000', queueId },
  });
  await owner.skill.createMany({
    data: [
      { id: skillId, tenantId, name: 'billing' },
      { id: secondSkillId, tenantId, name: 'identity-verification' },
    ],
  });
  await owner.queueSkill.createMany({
    data: [
      { queueId, skillId, minLevel: 2 },
      { queueId, skillId: secondSkillId, minLevel: 1 },
    ],
  });
  await owner.user.createMany({
    data: [
      {
        id: ineligibleAgentId,
        tenantId,
        email: `ineligible-${tenantId}@router.test`,
        passwordHash: 'not-used',
        displayName: 'Below minimum',
        role: 'AGENT',
        extension: '1001',
      },
      {
        id: eligibleAgentId,
        tenantId,
        email: `eligible-${tenantId}@router.test`,
        passwordHash: 'not-used',
        displayName: 'Qualified',
        role: 'AGENT',
        extension: '1002',
      },
    ],
  });
  await owner.agentSkill.createMany({
    data: [
      { userId: ineligibleAgentId, skillId, level: 1 },
      { userId: eligibleAgentId, skillId, level: 2 },
      { userId: eligibleAgentId, skillId: secondSkillId, level: 1 },
    ],
  });
  await owner.agentStateLog.createMany({
    data: [
      { tenantId, userId: ineligibleAgentId, state: 'AVAILABLE' },
      { tenantId, userId: eligibleAgentId, state: 'AVAILABLE' },
    ],
  });
  t.after(async () => {
    await owner.interactionEvent.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.agentStateLog.deleteMany({ where: { tenantId } });
    await owner.agentSkill.deleteMany({ where: { skillId: { in: [skillId, secondSkillId] } } });
    await owner.queueSkill.deleteMany({ where: { queueId } });
    await owner.voiceDestination.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.skill.deleteMany({ where: { id: { in: [skillId, secondSkillId] } } });
    await owner.queue.delete({ where: { id: queueId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const router = new InboundVoiceRouter(application, {
    publish: async () => undefined,
    eventId: randomUUID,
    now: () => '2026-09-04T11:00:00.000Z',
  });
  const result = await router.handle({
    eventId: 'routing-policy-created',
    type: 'call.created',
    tenantId,
    occurredAt: '2026-09-04T11:00:00.000Z',
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
  });

  assert.equal(result.status, 'ASSIGNED');
  assert.equal(result.agentId, eligibleAgentId);
});

test('Router applies each routing strategy with deterministic agent-ID tie breaking', async (t) => {
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
  const tenantId = randomUUID();
  const createdAt = new Date('2026-09-04T08:00:00.000Z');
  const queues = [
    { id: randomUUID(), destination: '2101', strategy: 'LONGEST_AVAILABLE_IDLE' as const },
    { id: randomUUID(), destination: '2102', strategy: 'LONGEST_SINCE_LAST_INTERACTION' as const },
    { id: randomUUID(), destination: '2103', strategy: 'ROUND_ROBIN' as const },
  ];
  const skillIds = queues.map(() => randomUUID());
  const agents = queues.map(() => [randomUUID(), randomUUID()] as const);

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Strategies ${tenantId}`,
      slug: `routing-strategies-${tenantId}`,
      sipDomain: `${tenantId}.routing-strategies.test`,
    },
  });
  await owner.queue.createMany({
    data: queues.map((queue) => ({
      id: queue.id,
      tenantId,
      name: queue.strategy,
      channels: ['VOICE'],
      routingStrategy: queue.strategy,
    })),
  });
  await owner.voiceDestination.createMany({
    data: queues.map((queue) => ({ tenantId, destination: queue.destination, queueId: queue.id })),
  });
  await owner.skill.createMany({
    data: skillIds.map((id, index) => ({ id, tenantId, name: `strategy-${index}` })),
  });
  await owner.queueSkill.createMany({
    data: queues.map((queue, index) => ({
      queueId: queue.id,
      skillId: skillIds[index],
      minLevel: 1,
    })),
  });
  await owner.user.createMany({
    data: agents.flatMap(([first, second], index) => [
      {
        id: first,
        tenantId,
        email: `strategy-${index}-first-${tenantId}@router.test`,
        passwordHash: 'not-used',
        displayName: `Strategy ${index} first`,
        role: 'AGENT',
        extension: `31${index}1`,
      },
      {
        id: second,
        tenantId,
        email: `strategy-${index}-second-${tenantId}@router.test`,
        passwordHash: 'not-used',
        displayName: `Strategy ${index} second`,
        role: 'AGENT',
        extension: `31${index}2`,
      },
    ]),
  });
  await owner.agentStateLog.createMany({
    data: agents.flatMap(([first, second]) => [
      { tenantId, userId: first, state: 'AVAILABLE', startedAt: createdAt },
      { tenantId, userId: second, state: 'AVAILABLE', startedAt: createdAt },
    ]),
  });
  await owner.agentSkill.createMany({
    data: agents.flatMap(([first, second], index) => [
      { userId: first, skillId: skillIds[index], level: 1 },
      { userId: second, skillId: skillIds[index], level: 1 },
    ]),
  });
  await owner.interaction.createMany({
    data: [
      {
        tenantId,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'COMPLETED',
        queueId: queues[1].id,
        agentId: agents[1][0],
        assignedAt: new Date('2026-09-03T07:00:00.000Z'),
        endedAt: new Date('2026-09-03T08:00:00.000Z'),
      },
      {
        tenantId,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'COMPLETED',
        queueId: queues[1].id,
        agentId: agents[1][1],
        assignedAt: new Date('2026-09-01T07:00:00.000Z'),
        endedAt: new Date('2026-09-01T08:00:00.000Z'),
      },
      {
        tenantId,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'COMPLETED',
        queueId: queues[2].id,
        agentId: agents[2][0],
        assignedAt: new Date('2026-09-03T07:00:00.000Z'),
        endedAt: new Date('2026-09-03T08:00:00.000Z'),
      },
      {
        tenantId,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'COMPLETED',
        queueId: queues[2].id,
        agentId: agents[2][1],
        assignedAt: new Date('2026-09-01T07:00:00.000Z'),
        endedAt: new Date('2026-09-01T08:00:00.000Z'),
      },
    ],
  });
  t.after(async () => {
    await owner.interactionEvent.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.agentStateLog.deleteMany({ where: { tenantId } });
    await owner.agentSkill.deleteMany({ where: { skillId: { in: skillIds } } });
    await owner.queueSkill.deleteMany({
      where: { queueId: { in: queues.map((queue) => queue.id) } },
    });
    await owner.voiceDestination.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.skill.deleteMany({ where: { id: { in: skillIds } } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const router = new InboundVoiceRouter(application, {
    publish: async () => undefined,
    eventId: randomUUID,
    now: () => '2026-09-04T11:00:00.000Z',
  });
  const results = await Promise.all(
    queues.map((queue) => {
      const callUuid = randomUUID();
      return router.handle({
        eventId: randomUUID(),
        type: 'call.created',
        tenantId,
        occurredAt: '2026-09-04T11:00:00.000Z',
        correlationId: callUuid,
        orderingKey: callUuid,
        payload: {
          callUuid,
          vendor: 'freeswitch',
          telephonyNodeId: 'fs-bkk-02',
          caller: '1002',
          destination: queue.destination,
        },
      });
    }),
  );

  assert.equal(results[0].agentId, [...agents[0]].sort()[0], 'longest available idle');
  assert.equal(results[1].agentId, agents[1][1], 'longest since last interaction');
  assert.equal(results[2].agentId, agents[2][1], 'round robin');
});

test('Router uses tenant policy defaults and queue-level overrides for offer and maximum wait', async (t) => {
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
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const assignedQueueId = randomUUID();
  const callbackQueueId = randomUUID();
  const waitQueueId = randomUUID();
  let now = '2026-09-04T11:00:00.000Z';

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Policy defaults ${tenantId}`,
      slug: `policy-defaults-${tenantId}`,
      sipDomain: `${tenantId}.policy-defaults.test`,
      defaultOfferTimeoutSec: 31,
      defaultOfferTimeoutAction: 'IMMEDIATE_REQUEUE',
      defaultOfferCooldownSec: 17,
      defaultMaxWaitSec: 5,
      defaultMaxWaitAction: 'CALLBACK',
    },
  });
  await owner.queue.createMany({
    data: [
      { id: assignedQueueId, tenantId, name: 'Default offer', channels: ['VOICE'] },
      { id: callbackQueueId, tenantId, name: 'Default callback', channels: ['VOICE'] },
      {
        id: waitQueueId,
        tenantId,
        name: 'Queue wait override',
        channels: ['VOICE'],
        maxWaitSec: 5,
        maxWaitAction: 'WAIT',
      },
    ],
  });
  await owner.voiceDestination.createMany({
    data: [
      { tenantId, destination: '2201', queueId: assignedQueueId },
      { tenantId, destination: '2202', queueId: callbackQueueId },
      { tenantId, destination: '2203', queueId: waitQueueId },
    ],
  });
  await owner.user.create({
    data: {
      id: agentId,
      tenantId,
      email: `policy-agent-${tenantId}@router.test`,
      passwordHash: 'not-used',
      displayName: 'Policy agent',
      role: 'AGENT',
      extension: '3201',
    },
  });
  await owner.agentStateLog.create({ data: { tenantId, userId: agentId, state: 'AVAILABLE' } });
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

  const router = new InboundVoiceRouter(application, {
    publish: async () => undefined,
    eventId: randomUUID,
    now: () => now,
  });
  const createCall = (destination: string) => {
    const callUuid = randomUUID();
    return router.handle({
      eventId: randomUUID(),
      type: 'call.created',
      tenantId,
      occurredAt: now,
      correlationId: callUuid,
      orderingKey: callUuid,
      payload: {
        callUuid,
        vendor: 'freeswitch',
        telephonyNodeId: 'fs-bkk-02',
        caller: '1002',
        destination,
      },
    });
  };

  const defaultOffer = await createCall('2201');
  assert.equal(defaultOffer.status, 'ASSIGNED');
  const defaultOfferRecord = await owner.interaction.findUniqueOrThrow({
    where: { id: defaultOffer.interactionId },
    select: { offerExpiresAt: true },
  });
  assert.equal(defaultOfferRecord.offerExpiresAt?.toISOString(), '2026-09-04T11:00:31.000Z');

  await owner.agentStateLog.create({ data: { tenantId, userId: agentId, state: 'AVAILABLE' } });
  await owner.queue.update({
    where: { id: assignedQueueId },
    data: { offerTimeoutSec: 11, offerTimeoutAction: 'ABANDON', offerCooldownSec: 3 },
  });
  const overriddenOffer = await createCall('2201');
  assert.equal(overriddenOffer.status, 'ASSIGNED');
  const overriddenOfferRecord = await owner.interaction.findUniqueOrThrow({
    where: { id: overriddenOffer.interactionId },
    select: { offerExpiresAt: true },
  });
  assert.equal(overriddenOfferRecord.offerExpiresAt?.toISOString(), '2026-09-04T11:00:11.000Z');

  const callback = await createCall('2202');
  const wait = await createCall('2203');
  assert.equal(callback.status, 'QUEUED');
  assert.equal(wait.status, 'QUEUED');
  await owner.interaction.updateMany({
    where: { id: { in: [callback.interactionId, wait.interactionId] } },
    data: { queuedAt: new Date('2026-09-04T10:59:54.000Z') },
  });
  now = '2026-09-04T11:00:00.000Z';
  await router.processDue();
  const [callbackRecord, waitRecord] = await Promise.all([
    owner.interaction.findUniqueOrThrow({
      where: { id: callback.interactionId },
      select: { state: true },
    }),
    owner.interaction.findUniqueOrThrow({
      where: { id: wait.interactionId },
      select: { state: true, queuedAt: true, requeueAt: true },
    }),
  ]);
  assert.equal(callbackRecord.state, 'ABANDONED');
  assert.equal(waitRecord.state, 'QUEUED');
  assert.equal(waitRecord.queuedAt.toISOString(), now);
  assert.equal(waitRecord.requeueAt?.toISOString(), now);
  const [callbackEvent, waitEvent] = await Promise.all([
    owner.interactionEvent.findFirstOrThrow({
      where: { interactionId: callback.interactionId, type: 'interaction.abandoned' },
      select: { payload: true },
    }),
    owner.interactionEvent.findFirstOrThrow({
      where: { interactionId: wait.interactionId, type: 'interaction.queued' },
      orderBy: { id: 'desc' },
      select: { payload: true },
    }),
  ]);
  assert.deepEqual(callbackEvent.payload, { reason: 'max_wait_callback' });
  assert.deepEqual(waitEvent.payload, { reason: 'max_wait_wait' });
});
