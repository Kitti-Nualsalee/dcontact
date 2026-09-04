import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { QmInteractionEndedPayload } from '@d-contact/shared';
import { QmTranscriptionWorkflow } from './qm-transcription-workflow.js';

const owner = new PrismaClient();

test('interaction.ended creates one pending transcription job outside the call path', async (t) => {
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const agentId = randomUUID();
  const interactionId = randomUUID();
  const recordingId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `QM tenant ${tenantId}`,
      slug: `qm-${tenantId}`,
      sipDomain: `${tenantId}.qm.test`,
    },
  });
  await owner.user.create({
    data: {
      id: agentId,
      tenantId,
      email: `agent-${tenantId}@test.local`,
      passwordHash: 'test',
      displayName: 'Agent',
      role: 'AGENT',
    },
  });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      name: `QM queue ${tenantId}`,
      channels: ['VOICE'],
      transcriptionMode: 'AUTOMATIC',
      transcriptionLanguage: 'th-TH',
      transcriptionMaxAttempts: 3,
      autoQmEnabled: true,
    },
  });
  await owner.$executeRaw(
    Prisma.sql`INSERT INTO interactions
      (id, tenant_id, channel, direction, state, queue_id, agent_id, ended_at)
      VALUES (
        ${interactionId}::uuid,
        ${tenantId}::uuid,
        'VOICE',
        'INBOUND',
        'WRAPUP',
        ${queueId}::uuid,
        ${agentId}::uuid,
        ${new Date('2026-09-05T03:00:00.000Z')}
      )`,
  );
  await owner.recording.create({
    data: {
      id: recordingId,
      tenantId,
      interactionId,
      storageKey: `recordings/${tenantId}/${recordingId}.wav`,
      telephonyPath: `/var/recordings/${tenantId}/${recordingId}.wav`,
      channelLayout: 'STEREO',
      durationSec: 62,
      startedAt: new Date('2026-09-05T02:58:58.000Z'),
      endedAt: new Date('2026-09-05T03:00:00.000Z'),
    },
  });
  t.after(async () => {
    await owner.qmAuditEvent.deleteMany({ where: { tenantId } });
    await owner.qmTranscriptionJob.deleteMany({ where: { tenantId } });
    await owner.recording.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await owner.$disconnect();
  });

  const published: unknown[] = [];
  const workflow = new QmTranscriptionWorkflow(owner, {
    publish: async (job) => void published.push(job),
  });
  const event: KafkaEventEnvelope<QmInteractionEndedPayload> = {
    eventId: randomUUID(),
    type: 'interaction.ended',
    tenantId,
    occurredAt: '2026-09-05T03:00:00.000Z',
    correlationId: interactionId,
    orderingKey: interactionId,
    payload: {
      interactionId,
      channel: 'VOICE',
      state: 'WRAPUP',
      queueId,
      agentId,
    },
  };

  const created = await workflow.handleInteractionEnded(event);
  const duplicate = await workflow.handleInteractionEnded({ ...event, eventId: randomUUID() });

  assert.ok(created);
  assert.deepEqual(duplicate, created);
  assert.equal(created.status, 'PENDING');
  assert.equal(created.trigger, 'AUTOMATIC');
  assert.equal(published.length, 1);
  assert.deepEqual(await workflow.getJob(tenantId, created.jobId), created);
});
