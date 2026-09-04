import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { InboundVoiceRouter } from './inbound-voice-router.js';

test('IVR resolves voice, falls back to DTMF, then uses its default queue after two failed rounds', async (t) => {
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
  const defaultQueueId = randomUUID();
  const salesQueueId = randomUUID();
  const supportQueueId = randomUUID();
  const published: { type: string; payload: Record<string, unknown> }[] = [];
  let now = '2026-09-04T12:00:00.000Z';

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `IVR ${tenantId}`,
      slug: `ivr-${tenantId}`,
      sipDomain: `${tenantId}.ivr.test`,
    },
  });
  await owner.queue.createMany({
    data: [
      { id: defaultQueueId, tenantId, name: 'Default', channels: ['VOICE'] },
      { id: salesQueueId, tenantId, name: 'Sales', channels: ['VOICE'] },
      { id: supportQueueId, tenantId, name: 'Support', channels: ['VOICE'] },
    ],
  });
  await owner.voiceDestination.create({
    data: {
      tenantId,
      destination: '2300',
      queueId: defaultQueueId,
      entryMode: 'IVR',
      ivrConfig: {
        prompt: 'Say sales or support',
        inputTimeoutSec: 5,
        voiceRoutes: { sales: salesQueueId },
        dtmfRoutes: { '2': supportQueueId },
      },
    },
  });
  t.after(async () => {
    await owner.interactionEvent.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.voiceDestination.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const router = new InboundVoiceRouter(application, {
    publish: async (_topic, event) => {
      published.push({ type: event.type, payload: event.payload });
    },
    eventId: randomUUID,
    now: () => now,
  });
  const input = (
    callUuid: string,
    inputMode?: 'VOICE' | 'DTMF' | 'TIMEOUT',
    inputValue?: string,
  ) => ({
    eventId: randomUUID(),
    type: inputMode ? 'call.input' : 'call.created',
    tenantId,
    occurredAt: '2026-09-04T12:00:00.000Z',
    correlationId: callUuid,
    orderingKey: callUuid,
    payload: {
      callUuid,
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-bkk-02',
      caller: '1002',
      destination: '2300',
      ...(inputMode ? { inputMode, inputValue } : {}),
    },
  });

  const voiceCall = randomUUID();
  assert.equal((await router.handle(input(voiceCall) as never)).status, 'QUEUED');
  assert.deepEqual(published.at(-1)?.payload, {
    callUuid: voiceCall,
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-02',
    type: 'call.collect',
    inputMode: 'VOICE',
    prompt: 'Say sales or support',
    timeoutSec: 5,
  });
  await router.handle(input(voiceCall, 'VOICE', 'sales') as never);
  assert.equal(
    (
      await owner.interaction.findFirstOrThrow({
        where: { tenantId, externalId: voiceCall },
        select: { queueId: true, state: true },
      })
    ).queueId,
    salesQueueId,
  );

  const dtmfCall = randomUUID();
  await router.handle(input(dtmfCall) as never);
  await router.handle(input(dtmfCall, 'VOICE', 'unknown') as never);
  assert.equal((published.at(-1)?.payload as { inputMode?: string }).inputMode, 'DTMF');
  await router.handle(input(dtmfCall, 'DTMF', '2') as never);
  assert.equal(
    (
      await owner.interaction.findFirstOrThrow({
        where: { tenantId, externalId: dtmfCall },
        select: { queueId: true },
      })
    ).queueId,
    supportQueueId,
  );

  const earlyDtmfCall = randomUUID();
  await router.handle(input(earlyDtmfCall) as never);
  await router.handle(input(earlyDtmfCall, 'DTMF', '2') as never);
  assert.equal(
    (
      await owner.interaction.findFirstOrThrow({
        where: { tenantId, externalId: earlyDtmfCall },
        select: { queueId: true },
      })
    ).queueId,
    supportQueueId,
  );

  const failedCall = randomUUID();
  await router.handle(input(failedCall) as never);
  await router.handle(input(failedCall, 'VOICE', 'unknown') as never);
  now = '2026-09-04T12:00:06.000Z';
  await router.handle(input(failedCall, 'TIMEOUT') as never);
  const defaulted = await owner.interaction.findFirstOrThrow({
    where: { tenantId, externalId: failedCall },
    select: { queueId: true, ivrAttempts: true, ivrStage: true },
  });
  assert.deepEqual(defaulted, { queueId: defaultQueueId, ivrAttempts: 2, ivrStage: null });
  const defaultEvent = await owner.interactionEvent.findFirstOrThrow({
    where: { interaction: { externalId: failedCall }, type: 'interaction.ivr_resolved' },
    select: { payload: true },
  });
  assert.deepEqual(defaultEvent.payload, { queueId: defaultQueueId, reason: 'ivr_max_attempts' });
});
