import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { TelephonyRecordingLifecycle } from './recording-lifecycle.js';

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

test('answered recording is archived once and finalized before QM consumes interaction.ended', async (t) => {
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const interactionId = randomUUID();
  const callUuid = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Recording lifecycle ${tenantId}`,
      slug: `recording-lifecycle-${tenantId}`,
      sipDomain: `${tenantId}.recording-lifecycle.test`,
    },
  });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      name: 'Thai support',
      channels: ['VOICE'],
      recordingEnabled: true,
      recordingAnnouncement: 'สายนี้มีการบันทึกเสียงเพื่อพัฒนาบริการ',
      recordingAnnouncementLanguage: 'th-TH',
      recordingChannelLayout: 'STEREO',
    },
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, external_id, metadata)
      VALUES (
        ${interactionId}::uuid,
        ${tenantId}::uuid,
        'VOICE',
        'INBOUND',
        'ACTIVE',
        ${queueId}::uuid,
        ${callUuid},
        ${JSON.stringify({ vendor: 'freeswitch', telephonyNodeId: 'fs-bkk-02' })}::jsonb
      )`,
  );
  t.after(async () => {
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
  });

  const commands: unknown[] = [];
  const archived: unknown[] = [];
  let archiveAttempts = 0;
  const lifecycle = new TelephonyRecordingLifecycle(
    application,
    { handle: async (command: unknown) => void commands.push(command) },
    {
      prepare: async () => undefined,
      archive: async (input: unknown) => {
        archiveAttempts += 1;
        if (archiveAttempts === 1) throw new Error('temporary object storage failure');
        archived.push(input);
      },
    },
    '/var/lib/freeswitch/recordings',
  );
  const event = (
    type: 'call.answered' | 'call.hangup',
    eventId: string,
    occurredAt: string,
  ): KafkaEventEnvelope<TelephonyCallEvent> => ({
    eventId,
    type,
    tenantId,
    occurredAt,
    correlationId: callUuid,
    orderingKey: callUuid,
    payload: {
      callUuid,
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-bkk-02',
      caller: '1002',
      destination: '2000',
    },
  });

  await lifecycle.startForAnsweredCall(
    event('call.answered', 'recording-answer', '2026-09-05T06:00:00.000Z'),
  );
  await assert.rejects(
    () =>
      lifecycle.finishForHungupCall(
        event('call.hangup', 'recording-hangup', '2026-09-05T06:00:12.900Z'),
      ),
    /temporary object storage failure/,
  );
  await lifecycle.retryPendingArchives('fs-bkk-02');
  await lifecycle.retryPendingArchives('fs-bkk-02');

  assert.equal(commands.length, 2);
  assert.equal(archived.length, 1);
  const recording = await owner.recording.findFirstOrThrow({ where: { tenantId, interactionId } });
  assert.equal(recording.endedAt?.toISOString(), '2026-09-05T06:00:12.900Z');
  assert.ok(recording.archivedAt);
  assert.equal(recording.durationSec, 12);
  assert.equal(recording.storageKey, `recordings/${tenantId}/${interactionId}.wav`);
});

test('recording row is discarded when FreeSWITCH recording cannot start, so archive retry has nothing to chase (#923)', async (t) => {
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const interactionId = randomUUID();
  const callUuid = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Recording start failure ${tenantId}`,
      slug: `recording-start-failure-${tenantId}`,
      sipDomain: `${tenantId}.recording-start-failure.test`,
    },
  });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      name: 'General Support',
      channels: ['VOICE'],
      recordingEnabled: true,
      recordingChannelLayout: 'STEREO',
    },
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, external_id, metadata)
      VALUES (
        ${interactionId}::uuid,
        ${tenantId}::uuid,
        'VOICE',
        'INBOUND',
        'ACTIVE',
        ${queueId}::uuid,
        ${callUuid},
        ${JSON.stringify({ vendor: 'freeswitch', telephonyNodeId: 'fs-start-failure' })}::jsonb
      )`,
  );
  t.after(async () => {
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
  });

  const commands: unknown[] = [];
  let archiveAttempts = 0;
  let prepareFails = true;
  const lifecycle = new TelephonyRecordingLifecycle(
    application,
    { handle: async (command: unknown) => void commands.push(command) },
    {
      prepare: async () => {
        if (prepareFails) {
          throw Object.assign(new Error('EACCES: permission denied, mkdir'), { code: 'EACCES' });
        }
      },
      archive: async () => {
        archiveAttempts += 1;
      },
    },
    '/var/lib/freeswitch/recordings',
  );
  const event = (
    type: 'call.answered' | 'call.hangup',
    occurredAt: string,
  ): KafkaEventEnvelope<TelephonyCallEvent> => ({
    eventId: randomUUID(),
    type,
    tenantId,
    occurredAt,
    correlationId: callUuid,
    orderingKey: callUuid,
    payload: {
      callUuid,
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-start-failure',
      caller: '1002',
      destination: '2000',
    },
  });

  await assert.rejects(
    () => lifecycle.startForAnsweredCall(event('call.answered', '2026-11-20T03:00:00.000Z')),
    /EACCES/,
  );
  assert.equal(commands.length, 0);
  assert.equal(await owner.recording.count({ where: { tenantId } }), 0);

  await lifecycle.finishForHungupCall(event('call.hangup', '2026-11-20T03:00:30.000Z'));
  assert.deepEqual(await lifecycle.retryPendingArchives('fs-start-failure'), []);
  assert.equal(archiveAttempts, 0);

  // ไม่มีแถวค้าง answered ที่มาซ้ำ (เช่น bridge ใหม่หลังแก้ volume) ยังเริ่มบันทึกได้
  prepareFails = false;
  await lifecycle.startForAnsweredCall(event('call.answered', '2026-11-20T03:01:00.000Z'));
  assert.equal(await owner.recording.count({ where: { tenantId } }), 1);
  assert.equal(commands.length, 1);
});

test.after(async () => {
  await Promise.all([owner.$disconnect(), application.$disconnect()]);
});
