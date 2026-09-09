import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import {
  ContactGovernanceService,
  type AuthorizationOutcome,
  type AuthorizeAndReserveInput,
} from '@d-contact/contact-governance';
import type { InboundBusinessEvent } from '@d-contact/shared';
import { createDurableJourneyIdempotencyStore } from './journey-event-consumer.js';
import { JourneyProcessor } from './journey-processor.js';

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
    await owner.jrAction.deleteMany({ where: { tenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId } });
    await owner.jrKafkaConsumerInbox.deleteMany({ where: { tenantId } });
    await owner.jrEventInbox.deleteMany({ where: { tenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
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

function createJourneyIdempotencyKey(tenantId: string, eventId: string) {
  return { consumerGroup: 'journey-idempotency-integration', tenantId, eventId };
}

test('Journey durable idempotency claim/complete ป้องกัน concurrent, retry และ restart', async (t) => {
  const { application, createInbox, tenantId } = await createFixture(t);
  const store = createDurableJourneyIdempotencyStore(application);

  const concurrentEventId = await createInbox();
  let concurrentHandlerCount = 0;
  const concurrent = await Promise.all([
    store.execute(createJourneyIdempotencyKey(tenantId, concurrentEventId), async (transaction) => {
      concurrentHandlerCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 30));
      await transaction.jrEventInbox.update({
        where: { id: concurrentEventId },
        data: { state: 'PROCESSED', processedAt: new Date() },
      });
    }),
    store.execute(createJourneyIdempotencyKey(tenantId, concurrentEventId), async (transaction) => {
      concurrentHandlerCount += 1;
      await transaction.jrEventInbox.update({
        where: { id: concurrentEventId },
        data: { state: 'PROCESSED', processedAt: new Date() },
      });
    }),
  ]);
  assert.deepEqual([...concurrent].sort(), ['duplicate', 'processed']);
  assert.equal(concurrentHandlerCount, 1);

  const beforeCommitEventId = await createInbox();
  await assert.rejects(
    () =>
      store.execute(createJourneyIdempotencyKey(tenantId, beforeCommitEventId), async () => {
        throw new Error('จำลอง crash ก่อน complete commit');
      }),
    /crash ก่อน complete commit/,
  );
  assert.equal(
    await store.execute(
      createJourneyIdempotencyKey(tenantId, beforeCommitEventId),
      async (transaction) => {
        await transaction.jrEventInbox.update({
          where: { id: beforeCommitEventId },
          data: { state: 'PROCESSED', processedAt: new Date() },
        });
      },
    ),
    'processed',
  );

  const afterCommitEventId = await createInbox();
  assert.equal(
    await store.execute(
      createJourneyIdempotencyKey(tenantId, afterCommitEventId),
      async (transaction) => {
        await transaction.jrEventInbox.update({
          where: { id: afterCommitEventId },
          data: { state: 'PROCESSED', processedAt: new Date() },
        });
      },
    ),
    'processed',
  );
  const restartedStore = createDurableJourneyIdempotencyStore(application);
  let restartedHandlerCalled = false;
  assert.equal(
    await restartedStore.execute(
      createJourneyIdempotencyKey(tenantId, afterCommitEventId),
      async () => {
        restartedHandlerCalled = true;
      },
    ),
    'duplicate',
  );
  assert.equal(restartedHandlerCalled, false);
});

test('crash หลัง Governance reserve rollback handler ทั้งชุดก่อน retry', async (t) => {
  const { application, tenantId } = await createFixture(t);
  const contactId = randomUUID();
  const identityId = randomUUID();
  const receiptId = randomUUID();
  const event: InboundBusinessEvent = {
    source: 'fault-injection',
    eventId: receiptId,
    type: 'payment.failed',
    occurredAt: '2026-09-09T00:00:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'EMAIL', value: 'fault-injection@example.test' },
    payload: {},
  };
  const owner = new PrismaClient();
  await owner.contact.create({
    data: {
      id: contactId,
      tenantId,
      identities: {
        create: { id: identityId, tenantId, type: 'EMAIL', value: event.contactRef.value },
      },
      cgConsents: {
        create: {
          tenantId,
          identityId,
          purpose: 'MARKETING',
          channel: 'EMAIL',
          status: 'GRANTED',
          lawfulBasis: 'CONSENT',
          evidence: {},
        },
      },
    },
  });
  await owner.jrEventInbox.create({
    data: {
      id: receiptId,
      tenantId,
      source: event.source,
      eventId: receiptId,
      eventType: event.type,
      occurredAt: new Date(event.occurredAt),
      payload: event as unknown as Prisma.InputJsonValue,
      payloadHash: 'fault-injection',
      state: 'PUBLISHED',
    },
  });
  await owner.$disconnect();

  class CrashAfterReserve extends ContactGovernanceService {
    override async authorizeAndReserve(
      crashTenantId: string,
      authorizationInput: AuthorizeAndReserveInput,
      transaction?: Prisma.TransactionClient,
    ): Promise<AuthorizationOutcome> {
      await super.authorizeAndReserve(crashTenantId, authorizationInput, transaction);
      throw new Error('จำลอง crash หลัง reserve');
    }
  }
  const input = {
    receiptId,
    journeyVersion: 1,
    stepId: 'fault',
    channel: 'EMAIL' as const,
    purpose: 'MARKETING',
    policyVersion: 1,
  };
  const store = createDurableJourneyIdempotencyStore(application);
  await assert.rejects(
    () =>
      store.execute(createJourneyIdempotencyKey(tenantId, receiptId), async (tx) => {
        await new JourneyProcessor(application, new CrashAfterReserve(application)).processEvent(
          tenantId,
          input,
          tx,
        );
      }),
    /crash หลัง reserve/,
  );
  const verify = new PrismaClient();
  assert.equal(await verify.cgReservation.count({ where: { tenantId } }), 0);
  assert.equal(await verify.cgDecisionLog.count({ where: { tenantId } }), 0);
  assert.equal(await verify.jrEnrollment.count({ where: { tenantId } }), 0);
  assert.equal(
    await store.execute(createJourneyIdempotencyKey(tenantId, receiptId), async (tx) => {
      await new JourneyProcessor(
        application,
        new ContactGovernanceService(application),
      ).processEvent(tenantId, input, tx);
    }),
    'processed',
  );
  assert.equal(await verify.cgReservation.count({ where: { tenantId } }), 1);
  assert.equal(await verify.cgDecisionLog.count({ where: { tenantId } }), 1);
  assert.equal(await verify.jrEnrollment.count({ where: { tenantId } }), 1);
  assert.equal(await verify.jrAction.count({ where: { tenantId } }), 1);
  assert.equal(await verify.jrKafkaConsumerInbox.count({ where: { tenantId } }), 1);
  await verify.$disconnect();
});
