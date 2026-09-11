import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { createConsumer, createInMemoryIdempotencyStore, createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { Redis } from 'ioredis';
import { Cg3PreferenceRepository } from './cg3-persistence.js';
import { Cg3Cache } from './cg3-cache.js';
import { Cg3EventRelay } from './cg3-event-relay.js';

test(
  'event relay เผยแพร่ cg_event_outbox ไป Kafka จริงและ invalidate head cache',
  { timeout: 30_000 },
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
    const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    const cache = new Cg3Cache(redis);

    await owner.tenant.create({
      data: {
        id: tenantId,
        name: `CG3 relay ${tenantId}`,
        slug: `cg3-relay-${tenantId}`,
        sipDomain: `${tenantId}.cg3-relay.test`,
      },
    });
    await owner.contact.create({
      data: { id: contactId, tenantId, displayName: 'CG3 relay contact' },
    });
    await cache.setContactSnapshot(tenantId, contactId, 0, { placeholder: true });
    await redis.set(`cg:contact:${tenantId}:${contactId}:head`, '0');

    const received: unknown[] = [];
    let resolveReceived!: () => void;
    const eventObserved = new Promise<void>((resolve) => {
      resolveReceived = resolve;
    });
    const consumer = await createConsumer({
      clientId: `cg3-relay-${suffix}-consumer`,
      groupId: `cg3-relay-${suffix}`,
      topics: [KAFKA_TOPICS.CONTACT_GOVERNANCE_EVENTS],
      brokers: ['localhost:9092'],
      idempotency: createInMemoryIdempotencyStore(),
      handler: (message) => {
        if (message.event.tenantId !== tenantId) return;
        received.push(message.event);
        resolveReceived();
      },
    });
    const producer = await createProducer(`cg3-relay-${suffix}-producer`, {
      brokers: ['localhost:9092'],
    });
    const relay = new Cg3EventRelay(application, producer, { cache });

    t.after(async () => {
      await producer.disconnect();
      await consumer.disconnect();
      await redis.quit();
      await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
      await owner.cgAuditLog.deleteMany({ where: { tenantId } });
      await owner.cgCommandReceipt.deleteMany({ where: { tenantId } });
      await owner.cgPreference.deleteMany({ where: { tenantId } });
      await owner.cgContactStateHead.deleteMany({ where: { tenantId } });
      await owner.contact.deleteMany({ where: { tenantId } });
      await owner.tenant.deleteMany({ where: { id: tenantId } });
      await Promise.all([owner.$disconnect(), application.$disconnect()]);
    });

    const preferences = new Cg3PreferenceRepository(application);
    const mutation = await preferences.append({
      tenantId,
      contactId,
      channel: 'LINE',
      purpose: 'MARKETING',
      decision: 'BLOCK',
      preferredWindows: [],
      sourceKind: 'CUSTOMER',
      occurredAt: '2026-09-11T00:00:00.000Z',
      effectiveFrom: '2026-09-11T00:00:00.000Z',
      evidenceRef: 'relay-test-evidence',
      actorClass: 'CUSTOMER',
      actorRef: 'customer-1',
      idempotencyKey: randomUUID(),
      expectedVersion: 0,
      correlationId: randomUUID(),
    });

    const attempt = await relay.publishNext(tenantId);
    assert.equal(attempt?.state, 'PUBLISHED');

    let timeout: NodeJS.Timeout | undefined;
    await Promise.race([
      eventObserved,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('ไม่พบ CG3 event จาก Redpanda ภายในเวลา')),
          10_000,
        );
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    assert.equal(received.length, 1);
    const event = received[0] as Record<string, unknown>;
    assert.equal(event.type, 'preference.changed');
    assert.equal(event.aggregateType, 'contact_governance_contact');
    assert.equal(event.aggregateId, contactId);
    assert.equal(event.aggregateVersion, mutation.aggregateVersion);
    assert.equal(event.eventKind, 'CANONICAL');
    assert.equal(event.schemaVersion, 2);

    const persisted = await owner.cgEventOutbox.findFirstOrThrow({ where: { tenantId } });
    assert.equal(persisted.state, 'PUBLISHED');
    assert.ok(persisted.publishedAt);

    const headAfter = await redis.get(`cg:contact:${tenantId}:${contactId}:head`);
    assert.equal(headAfter, null);
  },
);
