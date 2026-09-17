import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  contactId as toContactId,
  customerSnapshotVersion,
  membershipRevision,
  segmentDefinitionVersion,
  segmentEntryId,
  segmentId,
  teamId as toTeamId,
  tenantId as toTenantId,
} from '@d-contact/cxa-contracts';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { createIamCustomerSegmentProjectionConsumer } from './customer-segment-projection-consumer.js';
import { IamTeamContactScopeAuthorizer } from './team-contact-scope-authorizer.js';
import { IamTeamSegmentScopeRepository } from './team-segment-scope-repository.js';

const OWNER_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://dcontact:dcontact@localhost:5433/dcontact?schema=public';
const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function fixture(t: TestContext) {
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_DATABASE_URL } } });
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const contactId = randomUUID();
  t.after(async () => {
    const where = { tenantId };
    await owner.iamScopeConsumerInbox.deleteMany({ where });
    await owner.iamScopeInvalidationOutbox.deleteMany({ where });
    await owner.iamContactSegmentScopeProjection.deleteMany({ where });
    await owner.iamTeamSegmentScopeRevocation.deleteMany({ where });
    await owner.iamTeamSegmentScopeActiveGrant.deleteMany({ where });
    await owner.iamTeamSegmentScopeGrant.deleteMany({ where });
    await owner.iamTeamScopeVersion.deleteMany({ where });
    await owner.contact.deleteMany({ where });
    await owner.team.deleteMany({ where });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'IAM test',
      slug: `iam-${tenantId}`,
      sipDomain: `${tenantId}.iam.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: `IAM ${teamId}` } });
  await owner.contact.create({ data: { id: contactId, tenantId } });
  return {
    owner,
    application,
    tenantId,
    teamId,
    contactId,
    repository: new IamTeamSegmentScopeRepository(application),
  };
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('เงื่อนไขไม่เป็นจริงภายในเวลาที่กำหนด');
}

test('grant/revoke เดิน scope version และเขียน restrictive invalidation append-only', async (t) => {
  const f = await fixture(t);
  const granted = await f.repository.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: 'VIP',
    permission: 'WORK',
    correlationId: 'grant',
  });
  assert.equal(granted.outcome, 'GRANTED');
  const revoked = await f.repository.revoke({
    tenantId: f.tenantId,
    grantId: granted.grant.id,
    reasonCode: 'ADMIN_REVOKE',
    correlationId: 'revoke',
  });
  assert.equal(revoked.outcome, 'REVOKED');
  const regranted = await f.repository.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: 'VIP',
    permission: 'WORK',
    correlationId: 'regrant',
  });
  assert.equal(regranted.outcome, 'GRANTED');
  assert.notEqual(regranted.grant.id, granted.grant.id);
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.iamTeamSegmentScopeGrant.update({
        where: { id: regranted.grant.id },
        data: { grantVersion: 99 },
      }),
    ),
    /permission denied/i,
  );
  const outbox = await f.owner.iamScopeInvalidationOutbox.findMany({
    where: { tenantId: f.tenantId },
    orderBy: { scopeVersion: 'asc' },
  });
  assert.deepEqual(
    outbox.map((row) => [row.kind, row.scopeVersion]),
    [
      ['GRANTED', 1],
      ['REVOKED', 2],
      ['GRANTED', 3],
    ],
  );
  assert.equal(
    await f.owner.iamTeamSegmentScopeRevocation.count({ where: { tenantId: f.tenantId } }),
    1,
  );
});

test('membership projection ไม่ย้อน revision และ dedup event id แบบ durable', async (t) => {
  const f = await fixture(t);
  const payload = {
    contractVersion: 1,
    contactId: toContactId(f.contactId),
    segmentId: segmentId('VIP'),
    membershipRevision: membershipRevision(2),
    changeKind: 'ENTERED',
    entryId: segmentEntryId('entry-2'),
    segmentDefinitionVersion: segmentDefinitionVersion(1),
    snapshotVersion: customerSnapshotVersion(1),
    evaluatedAt: '2099-01-01T00:00:00.000Z',
    stateDigest: 'a'.repeat(64),
  } as const;
  assert.equal(
    (
      await f.repository.applyMembershipChange({
        tenantId: f.tenantId,
        eventId: 'event-2',
        occurredAt: '2099-01-01T00:00:00.000Z',
        consumerGroup: 'iam-test',
        payload,
      })
    ).outcome,
    'APPLIED',
  );
  assert.equal(
    (
      await f.repository.applyMembershipChange({
        tenantId: f.tenantId,
        eventId: 'event-2',
        occurredAt: '2099-01-01T00:00:00.000Z',
        consumerGroup: 'iam-test',
        payload,
      })
    ).outcome,
    'DUPLICATE',
  );
  const projection = await f.owner.iamContactSegmentScopeProjection.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId: f.contactId, segmentId: 'VIP' },
  });
  assert.equal(projection.state, 'IN');
  assert.equal(projection.membershipRevision, 2);
});

test('authorizer จริงอนุญาตเฉพาะ active grant กับ canonical projection ที่สด', async (t) => {
  const f = await fixture(t);
  const authorizer = new IamTeamContactScopeAuthorizer(
    f.application,
    () => new Date('2099-01-01T00:00:00.000Z'),
  );
  const input = {
    tenantId: toTenantId(f.tenantId),
    teamId: toTeamId(f.teamId),
    contactId: toContactId(f.contactId),
    permission: 'WORK' as const,
    at: '2099-01-01T00:00:00.000Z',
  };
  assert.deepEqual(await authorizer.authorize(input), {
    decision: 'DENY',
    reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
    evaluatedAt: input.at,
  });
  await f.repository.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: 'VIP',
    permission: 'WORK',
    correlationId: 'grant',
  });
  assert.deepEqual(await authorizer.authorize(input), {
    decision: 'DEFER',
    reasonCode: 'SCOPE_CONTEXT_STALE',
    evaluatedAt: input.at,
  });
  await f.repository.applyMembershipChange({
    tenantId: f.tenantId,
    eventId: 'event-authorizer',
    occurredAt: input.at,
    consumerGroup: 'iam-test',
    payload: {
      contractVersion: 1,
      contactId: toContactId(f.contactId),
      segmentId: segmentId('VIP'),
      membershipRevision: membershipRevision(1),
      changeKind: 'ENTERED',
      entryId: segmentEntryId('entry-authorizer'),
      segmentDefinitionVersion: segmentDefinitionVersion(1),
      snapshotVersion: customerSnapshotVersion(1),
      evaluatedAt: input.at,
      stateDigest: 'c'.repeat(64),
    },
  });
  assert.deepEqual(await authorizer.authorize(input), {
    decision: 'ALLOW',
    scopeVersion: 1,
    evaluatedAt: input.at,
  });
  await f.repository.applyMembershipChange({
    tenantId: f.tenantId,
    eventId: 'event-authorizer-invalidated',
    occurredAt: input.at,
    consumerGroup: 'iam-test',
    payload: {
      contractVersion: 1,
      contactId: toContactId(f.contactId),
      segmentId: segmentId('VIP'),
      membershipRevision: membershipRevision(2),
      changeKind: 'IDENTITY_INVALIDATED',
      segmentDefinitionVersion: segmentDefinitionVersion(1),
      snapshotVersion: customerSnapshotVersion(1),
      evaluatedAt: input.at,
      stateDigest: 'd'.repeat(64),
    },
  });
  assert.deepEqual(await authorizer.authorize(input), {
    decision: 'DEFER',
    reasonCode: 'SCOPE_CONTEXT_STALE',
    evaluatedAt: input.at,
  });
  const active = await f.owner.iamTeamSegmentScopeActiveGrant.findUniqueOrThrow({
    where: {
      tenantId_teamId_segmentId_permission: {
        tenantId: f.tenantId,
        teamId: f.teamId,
        segmentId: 'VIP',
        permission: 'WORK',
      },
    },
  });
  await f.repository.revoke({
    tenantId: f.tenantId,
    grantId: active.grantId,
    reasonCode: 'ADMIN_REVOKE',
    correlationId: 'revoke',
  });
  assert.deepEqual(await authorizer.authorize(input), {
    decision: 'DENY',
    reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED',
    evaluatedAt: input.at,
  });
});

test(
  'Kafka customer.segment.changed เข้า IAM projection ผ่าน durable inbox',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const suffix = randomUUID();
    const groupId = `iam-projection-${suffix}`;
    const consumer = await createIamCustomerSegmentProjectionConsumer({
      repository: f.repository,
      clientId: groupId,
      groupId,
      brokers: ['localhost:9092'],
    });
    const producer = await createProducer(`${groupId}-producer`, { brokers: ['localhost:9092'] });
    t.after(async () => {
      await producer.disconnect();
      await consumer.disconnect();
    });
    await consumer.ready();
    const eventId = randomUUID();
    await producer.send(KAFKA_TOPICS.CUSTOMER_EVENTS, {
      schemaVersion: 2,
      eventKind: 'CANONICAL',
      eventId,
      type: 'customer.segment.changed',
      tenantId: f.tenantId,
      occurredAt: '2099-01-01T00:00:00.000Z',
      correlationId: eventId,
      orderingKey: `${f.contactId}:VIP`,
      aggregateType: 'customer_segment_membership',
      aggregateId: `${f.contactId}:VIP`,
      aggregateVersion: 1,
      payload: {
        contractVersion: 1,
        contactId: f.contactId,
        segmentId: 'VIP',
        membershipRevision: 1,
        changeKind: 'ENTERED',
        entryId: 'entry-kafka',
        segmentDefinitionVersion: 1,
        snapshotVersion: 1,
        evaluatedAt: '2099-01-01T00:00:00.000Z',
        stateDigest: 'b'.repeat(64),
      },
    });
    await waitFor(async () =>
      Boolean(
        await f.owner.iamContactSegmentScopeProjection.findFirst({
          where: {
            tenantId: f.tenantId,
            contactId: f.contactId,
            segmentId: 'VIP',
            sourceEventId: eventId,
          },
        }),
      ),
    );
    assert.equal(
      await f.owner.iamScopeConsumerInbox.count({
        where: { tenantId: f.tenantId, eventId, consumerGroup: groupId },
      }),
      1,
    );
  },
);
