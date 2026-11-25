import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  J3_EVENT_TYPES,
  canonicalSegmentMembershipHash,
  customerSegmentMembershipStreamId,
  tenantId as contractTenantId,
  type SegmentMembershipChangePayloadV1,
} from '@d-contact/cxa-contracts';
import { PrismaClient } from '@d-contact/db';
import { createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { createJourneySegmentConsumer } from './journey-segment-consumer.js';

const BROKERS = ['localhost:9092'];

async function fixture(t: TestContext) {
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
  const suffix = tenantId.slice(0, 8);
  const segmentId = `segment-gold-${suffix}`;

  t.after(async () => {
    await owner.jrSegmentOutbox.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRefilterCursor.deleteMany({ where: { tenantId } });
    // an enrollment references an intent by FK so it must be deleted first
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId } });
    await owner.jrSegmentHead.deleteMany({ where: { tenantId } });
    await owner.jrSegmentReceipt.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J3.6 consumer ${suffix}`,
      slug: `j3-6-consumer-${suffix}`,
      sipDomain: `${suffix}.j3-6-consumer.test`,
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId } });

  return { owner, application, tenantId, contactId, segmentId, suffix };
}

function changePayload(
  f: Awaited<ReturnType<typeof fixture>>,
  membershipRevision: number,
  entryId: string,
): SegmentMembershipChangePayloadV1 {
  return {
    contractVersion: 1,
    changeKind: 'ENTERED',
    contactId: f.contactId,
    segmentId: f.segmentId,
    entryId,
    segmentDefinitionVersion: 1,
    membershipRevision,
    snapshotVersion: 1,
    evaluatedAt: '2026-09-15T00:00:00.000Z',
    stateDigest: 'c'.repeat(64),
  } as SegmentMembershipChangePayloadV1;
}

function envelope(
  f: Awaited<ReturnType<typeof fixture>>,
  payload: SegmentMembershipChangePayloadV1,
  eventId: string,
) {
  const streamId = customerSegmentMembershipStreamId(payload.contactId, payload.segmentId);
  return {
    schemaVersion: 2 as const,
    eventKind: 'CANONICAL' as const,
    eventId,
    type: J3_EVENT_TYPES.CUSTOMER_SEGMENT_CHANGED,
    tenantId: f.tenantId,
    occurredAt: '2026-09-15T00:00:00.000Z',
    correlationId: `corr-${f.suffix}`,
    orderingKey: streamId,
    aggregateType: 'customer_segment_membership' as const,
    aggregateId: streamId,
    aggregateVersion: payload.membershipRevision,
    payload,
  };
}

async function waitForReceipts(
  f: Awaited<ReturnType<typeof fixture>>,
  expected: number,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await f.owner.jrSegmentReceipt.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { membershipRevision: 'asc' },
    });
    if (rows.length >= expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`did not find all ${expected} receipts within the allotted time`);
}

test(
  'the consumer receives customer.segment.changed from real Redpanda and creates a receipt idempotently',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const suffix = randomUUID();
    const entryId = `entry-${f.suffix}`;

    const consumer = await createJourneySegmentConsumer({
      database: f.application,
      clientId: `j3-6-consumer-${suffix}`,
      groupId: `j3-6-consumer-${suffix}`,
      brokers: BROKERS,
    });
    const producer = await createProducer(`j3-6-producer-${suffix}`, { brokers: BROKERS });

    try {
      await consumer.ready();

      const payload = changePayload(f, 1, entryId);
      const eventId = randomUUID();
      await producer.send(KAFKA_TOPICS.CUSTOMER_EVENTS, envelope(f, payload, eventId));

      const [receipt] = await waitForReceipts(f, 1);
      assert.ok(receipt);
      assert.equal(
        receipt.state,
        'READY',
        'the first revision of a stream must be ready to apply immediately',
      );
      assert.equal(receipt.source, 'CUSTOMER_360');
      assert.equal(receipt.eventId, eventId);
      assert.equal(receipt.contactId, f.contactId);
      assert.equal(receipt.entryId, entryId);
      assert.equal(receipt.membershipRevision, 1);
      assert.equal(
        receipt.payloadHash,
        canonicalSegmentMembershipHash(contractTenantId(f.tenantId), payload),
        'the hash must be computed from the canonical payload, not the envelope',
      );

      // send the same event again from the broker — a second receipt must not be created
      await producer.send(KAFKA_TOPICS.CUSTOMER_EVENTS, envelope(f, payload, eventId));
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      assert.equal(
        await f.owner.jrSegmentReceipt.count({ where: { tenantId: f.tenantId } }),
        1,
        'redelivery must dedup at the transport identity',
      );

      // the next revision of the same stream must queue up as normal
      const second = changePayload(f, 2, entryId);
      await producer.send(KAFKA_TOPICS.CUSTOMER_EVENTS, envelope(f, second, randomUUID()));
      const rows = await waitForReceipts(f, 2);
      assert.equal(rows[1]?.membershipRevision, 2);
      assert.equal(
        rows[1]?.state,
        'WAITING_FOR_GAP',
        'revision 1 is not applied yet so the head is still at 0',
      );

      // no PII or attribute value leaks into the row at all
      const wire = JSON.stringify(rows);
      for (const forbidden of ['attributes', 'tier', 'phone', 'email', 'displayName']) {
        assert.doesNotMatch(wire, new RegExp(forbidden, 'i'), `${forbidden} must not be persisted`);
      }
    } finally {
      await producer.disconnect();
      await consumer.disconnect();
    }
  },
);

test(
  'an event of another type on the same topic is skipped silently and does not crash the consumer',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const suffix = randomUUID();

    const consumer = await createJourneySegmentConsumer({
      database: f.application,
      clientId: `j3-6-other-${suffix}`,
      groupId: `j3-6-other-${suffix}`,
      brokers: BROKERS,
    });
    const producer = await createProducer(`j3-6-other-producer-${suffix}`, { brokers: BROKERS });

    try {
      await consumer.ready();

      // Customer 360 owns this topic and has the right to announce other events Journey does not care about
      await producer.send(KAFKA_TOPICS.CUSTOMER_EVENTS, {
        schemaVersion: 2,
        eventKind: 'CANONICAL',
        eventId: randomUUID(),
        type: 'customer.profile.updated',
        tenantId: f.tenantId,
        occurredAt: '2026-09-15T00:00:00.000Z',
        correlationId: `corr-${f.suffix}`,
        orderingKey: f.contactId,
        aggregateType: 'customer_profile',
        aggregateId: f.contactId,
        aggregateVersion: 1,
        payload: { contractVersion: 1 },
      });

      // then followed by an event Journey really cares about — it must keep working
      const payload = changePayload(f, 1, `entry-${f.suffix}`);
      await producer.send(KAFKA_TOPICS.CUSTOMER_EVENTS, envelope(f, payload, randomUUID()));

      const rows = await waitForReceipts(f, 1);
      assert.equal(rows.length, 1, 'an event of another type must not create a receipt');
      assert.equal(rows[0]?.changeKind, 'ENTERED');
    } finally {
      await producer.disconnect();
      await consumer.disconnect();
    }
  },
);
