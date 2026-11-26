import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  createCg3AcknowledgementConsumer,
  type AcknowledgementPayloadV1,
} from './cg3-acknowledgement-consumer.js';

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('the condition did not become true within the allotted time');
}

test(
  'the acknowledgement consumer projects an ack event into cg_consumer_acknowledgements idempotently',
  { timeout: 45_000 },
  async (t) => {
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
    const contactId = randomUUID();
    const suffix = randomUUID();

    await owner.tenant.create({
      data: {
        id: tenantId,
        name: `CG3 ack ${tenantId}`,
        slug: `cg3-ack-${tenantId}`,
        sipDomain: `${tenantId}.cg3-ack.test`,
      },
    });

    const producer = await createProducer(`cg3-ack-${suffix}-producer`, {
      brokers: ['localhost:9092'],
    });
    const consumer = await createCg3AcknowledgementConsumer({
      database: application,
      clientId: `cg3-ack-${suffix}-consumer`,
      groupId: `cg3-ack-${suffix}`,
      brokers: ['localhost:9092'],
    });
    await consumer.ready();

    t.after(async () => {
      await producer.disconnect();
      await consumer.disconnect();
      await owner.cgConsumerAcknowledgement.deleteMany({ where: { tenantId } });
      await owner.tenant.deleteMany({ where: { id: tenantId } });
      await Promise.all([owner.$disconnect(), application.$disconnect()]);
    });

    function publishAck(eventId: string, payload: AcknowledgementPayloadV1) {
      return producer.send(KAFKA_TOPICS.CONTACT_GOVERNANCE_ACKNOWLEDGEMENTS, {
        eventId,
        type: 'contact-governance.acknowledged',
        tenantId,
        occurredAt: new Date().toISOString(),
        correlationId: eventId,
        orderingKey: `${tenantId}:${contactId}`,
        schemaVersion: 2,
        eventKind: 'CANONICAL',
        aggregateType: 'contact_governance_contact',
        aggregateId: contactId,
        aggregateVersion: payload.appliedVersion,
        payload: payload as unknown as Record<string, unknown>,
      });
    }

    const firstEventId = randomUUID();
    await publishAck(firstEventId, {
      contractVersion: 1,
      consumer: 'journey',
      aggregateType: 'CONTACT',
      aggregateId: contactId,
      appliedVersion: 1,
      outcome: 'APPLIED',
      affectedCount: 1,
      sourcePayloadHash: 'a'.repeat(64),
    });

    await waitFor(async () => {
      const count = await owner.cgConsumerAcknowledgement.count({ where: { tenantId } });
      return count === 1;
    });
    const applied = await owner.cgConsumerAcknowledgement.findFirstOrThrow({ where: { tenantId } });
    assert.equal(applied.outcome, 'APPLIED');
    assert.equal(applied.consumer, 'journey');
    assert.equal(applied.appliedVersion, 1);

    // the same eventId again -> no new row appears (idempotency boundary)
    await publishAck(firstEventId, {
      contractVersion: 1,
      consumer: 'journey',
      aggregateType: 'CONTACT',
      aggregateId: contactId,
      appliedVersion: 1,
      outcome: 'APPLIED',
      affectedCount: 1,
      sourcePayloadHash: 'a'.repeat(64),
    });
    // confirm with a separate marker event that the consumer has really processed up to this point (the count is seen not to increase)
    const markerEventId = randomUUID();
    await publishAck(markerEventId, {
      contractVersion: 1,
      consumer: 'journey',
      aggregateType: 'CONTACT',
      aggregateId: contactId,
      appliedVersion: 2,
      outcome: 'NO_OP',
      affectedCount: 0,
      sourcePayloadHash: 'b'.repeat(64),
    });
    await waitFor(async () => {
      const count = await owner.cgConsumerAcknowledgement.count({ where: { tenantId } });
      return count === 2;
    });
    assert.equal(await owner.cgConsumerAcknowledgement.count({ where: { tenantId } }), 2);

    // a different hash on the same (consumer, aggregateType, aggregateId, appliedVersion) -> QUARANTINED
    const conflictingEventId = randomUUID();
    await publishAck(conflictingEventId, {
      contractVersion: 1,
      consumer: 'journey',
      aggregateType: 'CONTACT',
      aggregateId: contactId,
      appliedVersion: 1,
      outcome: 'APPLIED',
      affectedCount: 1,
      sourcePayloadHash: 'c'.repeat(64),
    });
    await waitFor(async () => {
      const count = await owner.cgConsumerAcknowledgement.count({ where: { tenantId } });
      return count === 3;
    });
    const quarantined = await owner.cgConsumerAcknowledgement.findFirstOrThrow({
      where: { tenantId, eventId: conflictingEventId },
    });
    assert.equal(quarantined.outcome, 'QUARANTINED');
  },
);
