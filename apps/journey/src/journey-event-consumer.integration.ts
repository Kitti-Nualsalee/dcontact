import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { createDurableJourneyIdempotencyStore } from './journey-event-consumer.js';

async function createFixture(t: TestContext) {
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

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Journey idempotency ${tenantId}`,
      slug: `journey-idempotency-${tenantId}`,
      sipDomain: `${tenantId}.journey-idempotency.test`,
    },
  });
  t.after(async () => {
    await owner.jrEventInbox.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  async function createInbox(): Promise<string> {
    const eventId = randomUUID();
    await owner.jrEventInbox.create({
      data: {
        id: eventId,
        tenantId,
        source: 'journey-idempotency-integration',
        eventId,
        eventType: 'journey.business_event.received',
        occurredAt: new Date('2026-09-09T00:00:00.000Z'),
        payload: {},
        payloadHash: 'integration-fixture',
        state: 'PUBLISHED',
      },
    });
    return eventId;
  }

  return { application, createInbox, tenantId };
}

function key(tenantId: string, eventId: string) {
  return { consumerGroup: 'journey-idempotency-integration', tenantId, eventId };
}

test('Journey durable idempotency claim/complete ป้องกัน concurrent, retry และ restart', async (t) => {
  const { application, createInbox, tenantId } = await createFixture(t);
  const store = createDurableJourneyIdempotencyStore(application);

  const concurrentEventId = await createInbox();
  let concurrentHandlerCount = 0;
  const concurrent = await Promise.all([
    store.execute(key(tenantId, concurrentEventId), async (transaction) => {
      concurrentHandlerCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await transaction.jrEventInbox.update({
        where: { id: concurrentEventId },
        data: { state: 'PROCESSED', processedAt: new Date() },
      });
    }),
    store.execute(key(tenantId, concurrentEventId), async () => {
      concurrentHandlerCount += 1;
    }),
  ]);
  assert.deepEqual([...concurrent].sort(), ['duplicate', 'processed']);
  assert.equal(concurrentHandlerCount, 1);

  const beforeCommitEventId = await createInbox();
  await assert.rejects(
    () =>
      store.execute(key(tenantId, beforeCommitEventId), async () => {
        throw new Error('จำลอง crash ก่อน complete commit');
      }),
    /crash ก่อน complete commit/,
  );
  assert.equal(
    await store.execute(key(tenantId, beforeCommitEventId), async (transaction) => {
      await transaction.jrEventInbox.update({
        where: { id: beforeCommitEventId },
        data: { state: 'PROCESSED', processedAt: new Date() },
      });
    }),
    'processed',
  );

  const afterCommitEventId = await createInbox();
  assert.equal(
    await store.execute(key(tenantId, afterCommitEventId), async (transaction) => {
      await transaction.jrEventInbox.update({
        where: { id: afterCommitEventId },
        data: { state: 'PROCESSED', processedAt: new Date() },
      });
    }),
    'processed',
  );
  const restartedStore = createDurableJourneyIdempotencyStore(application);
  let restartedHandlerCalled = false;
  assert.equal(
    await restartedStore.execute(key(tenantId, afterCommitEventId), async () => {
      restartedHandlerCalled = true;
    }),
    'duplicate',
  );
  assert.equal(restartedHandlerCalled, false);
});
