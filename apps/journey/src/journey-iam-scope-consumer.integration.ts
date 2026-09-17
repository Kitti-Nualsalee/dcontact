import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { createJourneyIamScopeConsumer } from './journey-iam-scope-consumer.js';
import { JourneyIamScopeInvalidationService } from './journey-iam-scope-invalidation.js';

const BROKERS = ['localhost:9092'];
const HASH = 'a'.repeat(64);

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
  const teamId = randomUUID();
  const contactId = randomUUID();
  const journeyId = randomUUID();
  const receiptId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  const segmentId = `iam-scope-${suffix}`;

  t.after(async () => {
    await owner.jrIamScopeInvalidationInbox.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRefilterCursor.deleteMany({ where: { tenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.jrSegmentEnrollmentIntent.deleteMany({ where: { tenantId } });
    await owner.jrSegmentReceipt.deleteMany({ where: { tenantId } });
    await owner.jrJourneyDefinition.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J3.9 IAM consumer ${suffix}`,
      slug: `j3-9-iam-consumer-${suffix}`,
      sipDomain: `${suffix}.j3-9-iam-consumer.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Lifecycle' } });
  await owner.contact.create({ data: { id: contactId, tenantId } });
  await owner.jrJourneyDefinition.create({
    data: {
      tenantId,
      journeyId,
      version: 1,
      name: 'IAM scope test',
      ownerTeamId: teamId,
      purpose: 'MARKETING',
      senderIdentityId: 'test-sender',
      status: 'PUBLISHED',
      trigger: { kind: 'SEGMENT_ENTRY', segmentId },
      graph: { entryStepId: 'exit', steps: [{ id: 'exit', type: 'EXIT' }] },
      goal: { kind: 'EVENT', eventType: 'test' },
      exitRules: [{ kind: 'GOAL' }],
      maxDurationDays: 1,
      inputHash: HASH,
      correlationId: `setup-${suffix}`,
      publishedAt: new Date('2099-01-01T00:00:00.000Z'),
    },
  });
  await owner.jrSegmentReceipt.create({
    data: {
      id: receiptId,
      tenantId,
      source: 'CUSTOMER_360',
      eventId: `receipt-${suffix}`,
      contactId,
      segmentId,
      membershipRevision: 1,
      changeKind: 'ENTERED',
      entryId: `entry-${suffix}`,
      segmentDefinitionVersion: 1,
      payloadHash: HASH,
      correlationId: `setup-${suffix}`,
    },
  });
  await owner.jrSegmentEnrollmentIntent.create({
    data: {
      tenantId,
      journeyId,
      journeyVersion: 1,
      contactId,
      segmentId,
      entryId: `entry-${suffix}`,
      receiptId,
      reasonMembershipRevision: 1,
      reasonDefinitionVersion: 1,
      reasonDigest: HASH,
      correlationId: `setup-${suffix}`,
    },
  });
  return { owner, application, tenantId, teamId, receiptId, suffix };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('ไม่พบ IAM invalidation inbox ภายในเวลาที่กำหนด');
}

function scopeEvent(
  f: Awaited<ReturnType<typeof fixture>>,
  kind: 'GRANTED' | 'TEAM_DEACTIVATED' | 'DELEGATION_REVOKED',
  scopeVersion: number,
) {
  return {
    schemaVersion: 2 as const,
    eventKind: 'CANONICAL' as const,
    eventId: `iam-${kind.toLowerCase()}:${randomUUID()}`,
    type: 'team.segment-scope.changed' as const,
    tenantId: f.tenantId,
    occurredAt: '2099-01-01T00:00:00.000Z',
    correlationId: `iam-${kind.toLowerCase()}-${f.suffix}`,
    orderingKey: f.teamId,
    aggregateType: 'iam_team_scope' as const,
    aggregateId: f.teamId,
    aggregateVersion: scopeVersion,
    payload: {
      contractVersion: 1 as const,
      teamId: f.teamId,
      grantId: randomUUID(),
      scopeVersion,
      kind,
    },
  };
}

test('GRANTED ไม่ revive งานเดิม ส่วน team/delegation revoke ถูกบันทึกแบบ fail closed', async (t) => {
  const f = await fixture(t);
  const service = new JourneyIamScopeInvalidationService();
  const consumer = 'journey-iam-scope-contract-test';
  const apply = (event: ReturnType<typeof scopeEvent>) =>
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      service.apply(event, consumer, transaction),
    );

  const deactivated = await apply(scopeEvent(f, 'TEAM_DEACTIVATED', 2));
  assert.deepEqual(deactivated, { state: 'RECORDED', scheduledCursorCount: 1 });
  const granted = await apply(scopeEvent(f, 'GRANTED', 3));
  assert.deepEqual(granted, { state: 'RECORDED', scheduledCursorCount: 0 });
  const delegationRevoked = await apply(scopeEvent(f, 'DELEGATION_REVOKED', 4));
  assert.deepEqual(delegationRevoked, { state: 'RECORDED', scheduledCursorCount: 0 });

  const cursor = await f.owner.jrSegmentRefilterCursor.findFirstOrThrow({
    where: { tenantId: f.tenantId, scopeTeamId: f.teamId },
  });
  assert.equal(cursor.reasonCode, 'IAM_SCOPE_TEAM_DEACTIVATED');
  assert.equal(
    await f.owner.jrIamScopeInvalidationInbox.count({
      where: { tenantId: f.tenantId, consumer },
    }),
    3,
    'relaxation และ restrictive event ทุกใบต้องมี audit/dedup record แม้ cursor เดิมมีอยู่แล้ว',
  );
  assert.equal(
    await f.owner.jrEnrollment.count({ where: { tenantId: f.tenantId } }),
    0,
    'GRANTED ห้ามสร้างหรือ revive enrollment จาก intent เก่า',
  );
});

test(
  'consumer รับ IAM revoke จาก Redpanda แล้ว commit inbox/cursor แบบ durable',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const groupId = `j3-9-iam-${randomUUID()}`;
    const eventId = `iam-revoke:${randomUUID()}`;
    const consumer = await createJourneyIamScopeConsumer({
      database: f.application,
      service: new JourneyIamScopeInvalidationService(),
      clientId: groupId,
      groupId,
      brokers: BROKERS,
    });
    const producer = await createProducer(`${groupId}-producer`, { brokers: BROKERS });
    t.after(async () => {
      await producer.disconnect();
      await consumer.disconnect();
    });
    const event = {
      schemaVersion: 2 as const,
      eventKind: 'CANONICAL' as const,
      eventId,
      type: 'team.segment-scope.changed' as const,
      tenantId: f.tenantId,
      occurredAt: '2099-01-01T00:00:00.000Z',
      correlationId: `iam-revoke-${f.suffix}`,
      orderingKey: f.teamId,
      aggregateType: 'iam_team_scope' as const,
      aggregateId: f.teamId,
      aggregateVersion: 2,
      payload: {
        contractVersion: 1 as const,
        teamId: f.teamId,
        grantId: randomUUID(),
        scopeVersion: 2,
        kind: 'REVOKED' as const,
      },
    };

    await consumer.ready();
    await producer.send(KAFKA_TOPICS.ADMIN_EVENTS, event);
    await waitFor(async () =>
      Boolean(
        await f.owner.jrIamScopeInvalidationInbox.findFirst({
          where: { consumer: groupId, tenantId: f.tenantId, eventId },
        }),
      ),
    );
    assert.equal(
      await f.owner.jrIamScopeInvalidationInbox.count({
        where: { consumer: groupId, tenantId: f.tenantId, eventId },
      }),
      1,
    );
    const cursor = await f.owner.jrSegmentRefilterCursor.findFirstOrThrow({
      where: { tenantId: f.tenantId, scopeTeamId: f.teamId },
    });
    assert.equal(cursor.receiptId, f.receiptId);
    assert.equal(cursor.reasonCode, 'IAM_SCOPE_REVOKED');
    assert.equal(
      await f.owner.jrSegmentRefilterCursor.count({
        where: { tenantId: f.tenantId, scopeTeamId: f.teamId },
      }),
      1,
    );
  },
);
