import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import type { InboundBusinessEvent } from '@d-contact/shared';
import { EventIdempotencyConflictError, EventInboxService } from './event-inbox.js';

async function createTenantFixture(t: TestContext) {
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

  t.after(async () => {
    await owner.jrEventInbox.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Journey ${tenantId}`,
      slug: `journey-${tenantId}`,
      sipDomain: `${tenantId}.journey.test`,
    },
  });

  return { owner, application, tenantId };
}

test('event inbox returns one durable receipt for canonical duplicate payloads', async (t) => {
  const { owner, application, tenantId } = await createTenantFixture(t);
  const receiptId = randomUUID();
  const now = new Date('2026-09-07T10:00:00.000Z');

  const service = new EventInboxService(application, {
    now: () => now,
    id: () => receiptId,
  });
  const original: InboundBusinessEvent = {
    source: 'billing',
    eventId: 'payment-failed-001',
    type: 'payment.failed',
    occurredAt: '2026-09-07T09:59:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'CRM_ID', value: 'crm-001' },
    payload: { z: 3, nested: { b: 2, a: 1 } },
  };
  const reordered: InboundBusinessEvent = {
    ...original,
    payload: { nested: { a: 1, b: 2 }, z: 3 },
  };

  const accepted = await service.accept(tenantId, original);
  const retried = await service.accept(tenantId, reordered);

  assert.deepEqual(retried, accepted);
  assert.deepEqual(accepted, {
    receiptId,
    source: 'billing',
    eventId: 'payment-failed-001',
    state: 'PENDING',
    acceptedAt: '2026-09-07T10:00:00.000Z',
  });
  assert.equal(await owner.jrEventInbox.count({ where: { tenantId } }), 1);

  await assert.rejects(
    () => service.accept(tenantId, { ...original, payload: { amount: 999 } }),
    (error: unknown) => {
      assert.ok(error instanceof EventIdempotencyConflictError);
      assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    },
  );
});

test('failed publisher keeps durable inbox state and recovery publishes one logical event', async (t) => {
  const { owner, application, tenantId } = await createTenantFixture(t);
  const receiptId = randomUUID();
  const service = new EventInboxService(application, {
    now: () => new Date('2026-09-07T11:00:00.000Z'),
    id: () => receiptId,
  });
  const event: InboundBusinessEvent = {
    source: 'billing',
    eventId: 'payment-recovered-001',
    type: 'payment.recovered',
    occurredAt: '2026-09-07T10:59:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'EMAIL', value: 'customer@example.test' },
    payload: { invoiceId: 'invoice-001' },
  };
  await service.accept(tenantId, event);

  let fail = true;
  const published: unknown[] = [];
  const publisher = {
    publish: async (message: unknown) => {
      if (fail) throw new Error('simulated Kafka outage');
      published.push(message);
    },
  };

  const failed = await service.publishNext(tenantId, publisher);
  assert.deepEqual(failed, {
    receiptId,
    state: 'FAILED',
    attempts: 1,
  });
  assert.equal(
    (await owner.jrEventInbox.findUniqueOrThrow({ where: { id: receiptId } })).state,
    'FAILED',
  );

  fail = false;
  const recovered = await service.publishNext(tenantId, publisher);
  const empty = await service.publishNext(tenantId, publisher);

  assert.deepEqual(recovered, {
    receiptId,
    state: 'PUBLISHED',
    attempts: 2,
  });
  assert.equal(empty, undefined);
  assert.deepEqual(published, [{ tenantId, receiptId, event }]);
});
