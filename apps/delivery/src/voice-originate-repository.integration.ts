import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma } from '@d-contact/db';
import { createDeliveryFixture } from './delivery-fixture.js';
import { OutboxEntryAlreadyExistsError } from './outbox-repository.js';
import { VoiceOriginateRepository } from './voice-originate-repository.js';

async function fixture(t: TestContext) {
  const context = await createDeliveryFixture();
  t.after(() => context.dispose());
  const repository = new VoiceOriginateRepository(context.application);
  const input = {
    outbox: {
      id: randomUUID(),
      tenantId: context.rawTenantId,
      actionKey: `voice-${randomUUID()}`,
      reservationId: (await context.createReservation('voice')).rawId,
      deliveryId: `voice-${randomUUID()}`,
      providerRequestKey: `request-${randomUUID()}`,
      channel: 'VOICE' as const,
      contactId: context.command.contactId,
      identityId: context.command.identityId,
      purpose: 'SERVICE',
      source: 'DPHONE_CLICK_TO_CALL',
      senderIdentityId: 'agent-sip',
      contentRef: 'identity:opaque',
      inputHash: 'a'.repeat(64),
      leaseVersion: 1,
      leaseExpiresAt: new Date('2026-09-10T09:10:00.000Z'),
      correlationId: 'voice-test',
    },
    interactionId: randomUUID(),
    workSessionLeaseId: randomUUID(),
    agentUserId: randomUUID(),
    agentExtension: '1001',
    telephonyNodeId: 'fs-local',
    targetIdentityId: context.command.identityId!,
    originationUuid: randomUUID(),
  };
  return { context, repository, input };
}

test('voice extension และ generic outbox ถูก persist เป็น transaction เดียวโดยไม่เก็บ dial target', async (t) => {
  const { context, repository, input } = await fixture(t);
  const voice = await repository.create(input);
  assert.equal(voice.deliveryId, input.outbox.deliveryId);
  assert.equal(voice.adapter, 'FREESWITCH_ORIGINATE');
  assert.equal(voice.state, 'QUEUED');
  const outbox = await context.owner.dlOutboxEntry.findFirstOrThrow({
    where: { tenantId: context.rawTenantId, deliveryId: voice.deliveryId },
  });
  assert.equal(outbox.adapter, 'FREESWITCH_ORIGINATE');
  assert.equal(outbox.channel, 'VOICE');
});

test('actionKey ซ้ำไม่สร้าง voice extension ที่สอง', async (t) => {
  const { context, repository, input } = await fixture(t);
  await repository.create(input);
  await assert.rejects(
    () => repository.create({ ...input, originationUuid: randomUUID() }),
    OutboxEntryAlreadyExistsError,
  );
  assert.equal(
    await context.owner.dlVoiceOriginate.count({ where: { tenantId: context.rawTenantId } }),
    1,
  );
});

test('origination UUID ซ้ำไม่ถูกตีความเป็น actionKey ซ้ำและ rollback outbox ใหม่', async (t) => {
  const { context, repository, input } = await fixture(t);
  await repository.create(input);
  await assert.rejects(
    () =>
      repository.create({
        ...input,
        outbox: {
          ...input.outbox,
          id: randomUUID(),
          actionKey: `voice-${randomUUID()}`,
          deliveryId: `voice-${randomUUID()}`,
          providerRequestKey: `request-${randomUUID()}`,
        },
      }),
    (error: unknown) =>
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002',
  );
  assert.equal(
    await context.owner.dlOutboxEntry.count({ where: { tenantId: context.rawTenantId } }),
    1,
  );
  assert.equal(
    await context.owner.dlVoiceOriginate.count({ where: { tenantId: context.rawTenantId } }),
    1,
  );
});

test('extension ที่ไม่ผ่าน validation rollback generic outbox ไปพร้อมกัน', async (t) => {
  const { context, repository, input } = await fixture(t);
  await assert.rejects(() => repository.create({ ...input, agentExtension: 'invalid extension' }));
  assert.equal(
    await context.owner.dlOutboxEntry.count({ where: { tenantId: context.rawTenantId } }),
    0,
  );
  assert.equal(
    await context.owner.dlVoiceOriginate.count({ where: { tenantId: context.rawTenantId } }),
    0,
  );
});
