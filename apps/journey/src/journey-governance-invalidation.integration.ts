import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import type { DcProducer, KafkaEventEnvelope, KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import type { KafkaTopic } from '@d-contact/shared';
import {
  JourneyGovernanceInvalidationService,
  createJourneyCanonicalRevalidator,
  type JourneyCanonicalRevalidator,
  type JourneyRealtimeSettlementPort,
} from './journey-governance-invalidation.js';
import { JourneyGovernanceAcknowledgementRelay } from './journey-governance-ack-relay.js';
import { JourneyGovernanceEffectRelay } from './journey-governance-effect-relay.js';
import { JourneyActionLifecycleInboxService } from './journey-action-lifecycle-inbox.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

function preferenceEvent(tenantId: string, contactId: string, identityId: string) {
  return {
    schemaVersion: 2,
    eventKind: 'CANONICAL',
    eventId: randomUUID(),
    type: 'preference.changed',
    tenantId,
    occurredAt: '2026-09-12T09:00:00.000Z',
    correlationId: 'cg3-correlation',
    orderingKey: `${tenantId}:${contactId}`,
    aggregateType: 'contact_governance_contact',
    aggregateId: contactId,
    aggregateVersion: 1,
    payload: {
      contractVersion: 1,
      mutationId: randomUUID(),
      subjectVersion: 1,
      identityId,
      affectedScope: { identityId, channel: 'EMAIL', purpose: 'MARKETING', contactKind: null },
      effectiveAt: '2026-09-12T09:00:00.000Z',
      stateDigest: 'a'.repeat(64),
    },
  } satisfies KafkaEventEnvelopeV2<Record<string, unknown>>;
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const identityId = randomUUID();
  const enrollmentId = randomUUID();
  const actionKey = `${enrollmentId}:0`;
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Journey CG3 ${tenantId}`,
      slug: `journey-cg3-${tenantId}`,
      sipDomain: `${tenantId}.journey-cg3.test`,
    },
  });
  await owner.contact.create({
    data: { id: contactId, tenantId, displayName: 'CG3 test contact' },
  });
  await owner.contactIdentity.create({
    data: {
      id: identityId,
      tenantId,
      contactId,
      type: 'EMAIL',
      value: `cg3-${tenantId}@example.test`,
    },
  });
  await owner.cgConsent.create({
    data: {
      tenantId,
      contactId,
      identityId,
      purpose: 'MARKETING',
      channel: 'EMAIL',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: {},
    },
  });
  const authorization = await new ContactGovernanceService(application).authorizeAndReserve(
    tenantId,
    {
      contactId,
      identityId,
      channel: 'EMAIL',
      purpose: 'MARKETING',
      source: 'JOURNEY',
      sourceId: enrollmentId,
      actionKey,
      policyVersion: 1,
    },
  );
  assert.equal(authorization.decision, 'ALLOW');
  assert.ok(authorization.reservationId);
  await owner.jrEnrollment.create({
    data: { id: enrollmentId, tenantId, journeyVersion: 1, state: 'AUTHORIZED' },
  });
  await owner.jrAction.create({
    data: {
      tenantId,
      enrollmentId,
      actionKey,
      contactId,
      identityId,
      channel: 'EMAIL',
      purpose: 'MARKETING',
      decisionId: authorization.decisionId,
      reservationId: authorization.reservationId!,
    },
  });
  t.after(async () => {
    await owner.jrActionLifecycleInbox.deleteMany({ where: { tenantId } });
    await owner.jrGovernanceEffectOutbox.deleteMany({ where: { tenantId } });
    await owner.jrGovernanceAcknowledgementOutbox.deleteMany({ where: { tenantId } });
    await owner.jrGovernanceConsumerInbox.deleteMany({ where: { tenantId } });
    await owner.jrAction.deleteMany({ where: { tenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.cgReservation.updateMany({
      where: { tenantId },
      data: { authorizationDecisionId: null },
    });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return { owner, application, tenantId, contactId, identityId, actionKey };
}

test('CG3 restrictive event cancel งาน Journey ก่อน barrier แบบ idempotent และเขียน acknowledgement outbox', async (t) => {
  const f = await fixture(t);
  let revalidated = 0;
  const revalidator: JourneyCanonicalRevalidator = {
    async revalidate() {
      revalidated += 1;
      return { decision: 'BLOCK', reasonCode: 'PREFERENCE_BLOCKED' };
    },
  };
  const releases: string[] = [];
  const settlement: JourneyRealtimeSettlementPort = {
    async releaseBeforeBarrier(input) {
      releases.push(input.actionKey);
    },
    async requestReconcile() {
      throw new Error('งานก่อน barrier ต้องไม่ reconcile');
    },
  };
  const service = new JourneyGovernanceInvalidationService(f.application, revalidator, settlement, {
    consumer: 'journey-cg3-test',
    now: () => new Date('2026-09-12T09:00:01.000Z'),
  });
  const event = preferenceEvent(f.tenantId, f.contactId, f.identityId);
  const applied = await service.apply(event);
  assert.deepEqual(applied, { outcome: 'APPLIED', affectedCount: 1, state: 'APPLIED' });
  assert.deepEqual(releases, []);
  assert.equal(revalidated, 1);

  const action = await f.owner.jrAction.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(action.realtimeState, 'CANCELLED');
  assert.equal(action.appliedAggregateVersion, 1);
  assert.equal(
    await f.owner.jrGovernanceConsumerInbox.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  const acknowledgement = await f.owner.jrGovernanceAcknowledgementOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(acknowledgement.outcome, 'APPLIED');
  assert.equal(acknowledgement.affectedCount, 1);
  assert.equal(
    await f.owner.jrGovernanceEffectOutbox.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  const effectRelay = new JourneyGovernanceEffectRelay(f.application, settlement, {
    now: () => new Date('2026-09-12T09:00:01.500Z'),
  });
  assert.equal(await effectRelay.executeNext(f.tenantId), 'SUCCEEDED');
  assert.deepEqual(releases, [f.actionKey]);

  const published: Array<{ topic: KafkaTopic; event: KafkaEventEnvelope }> = [];
  const producer: DcProducer = {
    async send(topic, message) {
      published.push({ topic, event: message });
    },
    async disconnect() {},
  };
  const relay = new JourneyGovernanceAcknowledgementRelay(f.application, producer, {
    now: () => new Date('2026-09-12T09:00:02.000Z'),
  });
  assert.equal((await relay.publishNext(f.tenantId))?.state, 'PUBLISHED');
  assert.equal(published.length, 1);
  assert.equal(published[0]?.event.eventId, event.eventId);
  assert.equal(
    (
      await f.owner.jrGovernanceAcknowledgementOutbox.findFirstOrThrow({
        where: { tenantId: f.tenantId },
      })
    ).state,
    'PUBLISHED',
  );

  const duplicate = await service.apply(event);
  assert.deepEqual(duplicate, { outcome: 'APPLIED', affectedCount: 0, state: 'APPLIED' });
  assert.deepEqual(releases, [f.actionKey]);
  assert.equal(revalidated, 1);
});

test('CG3 restrictive event หลัง barrier เปลี่ยน Journey action เป็น CANCEL_REQUESTED และ reconcile เท่านั้น', async (t) => {
  const f = await fixture(t);
  const deliveryId = randomUUID();
  const providerRequestKey = `provider-${randomUUID()}`;
  await f.owner.jrAction.updateMany({
    where: { tenantId: f.tenantId },
    data: { realtimeState: 'POST_BARRIER', deliveryId, providerRequestKey },
  });
  const revalidator: JourneyCanonicalRevalidator = {
    async revalidate() {
      return { decision: 'BLOCK', reasonCode: 'PREFERENCE_BLOCKED' };
    },
  };
  let releases = 0;
  const reconciles: string[] = [];
  const settlement: JourneyRealtimeSettlementPort = {
    async releaseBeforeBarrier() {
      releases += 1;
    },
    async requestReconcile(input) {
      reconciles.push(`${input.deliveryId}:${input.providerRequestKey}`);
    },
  };
  const service = new JourneyGovernanceInvalidationService(f.application, revalidator, settlement, {
    consumer: 'journey-cg3-post-barrier',
    now: () => new Date('2026-09-12T09:01:00.000Z'),
  });
  const event = preferenceEvent(f.tenantId, f.contactId, f.identityId);
  await service.apply(event);
  assert.equal(releases, 0);
  assert.deepEqual(reconciles, []);
  const action = await f.owner.jrAction.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(action.realtimeState, 'CANCEL_REQUESTED');
  assert.ok(action.cancelRequestedAt);
  const effectRelay = new JourneyGovernanceEffectRelay(f.application, settlement, {
    now: () => new Date('2026-09-12T09:01:01.000Z'),
  });
  assert.equal(await effectRelay.executeNext(f.tenantId), 'SUCCEEDED');
  assert.deepEqual(reconciles, [`${deliveryId}:${providerRequestKey}`]);
});

test('Journey adapter ส่ง binding ที่ immutable ไปยัง canonical re-evaluation และแปลง DEFER ที่มีเวลา', async () => {
  let received: Record<string, unknown> | undefined;
  const revalidator = createJourneyCanonicalRevalidator({
    async revalidateAuthorizedAction(input) {
      received = input as unknown as Record<string, unknown>;
      return {
        decision: 'DEFER',
        reasonCode: 'PREFERENCE_WINDOW_CLOSED',
        observedAggregateVersion: 4,
        observedPolicyVersion: 2,
        nextEligibleAt: '2026-09-12T12:00:00.000Z',
        decisionDigest: 'a'.repeat(64),
      };
    },
  });
  const outcome = await revalidator.revalidate({
    tenantId: randomUUID(),
    action: {
      id: randomUUID(),
      tenantId: randomUUID(),
      actionKey: 'journey:0',
      contactId: randomUUID(),
      identityId: randomUUID(),
      channel: 'EMAIL',
      purpose: 'MARKETING',
      reservationId: randomUUID(),
      realtimeState: 'RESERVED',
    },
    event: {
      contractVersion: 1,
      mutationId: randomUUID(),
      subjectVersion: 4,
      affectedScope: { identityId: null, channel: null, purpose: null, contactKind: 'LEAD' },
      effectiveAt: '2026-09-12T09:00:00.000Z',
      stateDigest: 'b'.repeat(64),
    },
    source: {
      aggregateType: 'CONTACT',
      aggregateId: 'contact-aggregate',
      aggregateVersion: 4,
      correlationId: 'correlation',
    },
  });
  assert.deepEqual(outcome, {
    decision: 'DEFER',
    reasonCode: 'PREFERENCE_WINDOW_CLOSED',
    nextEligibleAt: '2026-09-12T12:00:00.000Z',
  });
  assert.equal(received?.sourceAggregateType, 'CONTACT');
  assert.equal(received?.contactKind, 'LEAD');
});

test('Delivery lifecycle ต้องเข้า Journey inbox ตามลำดับ และ eventId ซ้ำที่ binding เปลี่ยนถูกปฏิเสธ', async (t) => {
  const f = await fixture(t);
  const lifecycle = new JourneyActionLifecycleInboxService(f.application);
  const action = await f.owner.jrAction.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  const deliveryId = randomUUID();
  const providerRequestKey = `provider-${randomUUID()}`;
  const eventId = randomUUID();
  const pre = {
    tenantId: f.tenantId as never,
    actionKey: f.actionKey as never,
    reservationId: action.reservationId as never,
    deliveryId: deliveryId as never,
    providerRequestKey: providerRequestKey as never,
    state: 'PRE_BARRIER' as const,
    eventId,
    occurredAt: '2026-09-12T09:00:00.000Z',
    correlationId: 'delivery-lifecycle',
  };
  await lifecycle.record(pre);
  await lifecycle.record(pre);
  assert.equal(await f.owner.jrActionLifecycleInbox.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(
    (await f.owner.jrAction.findFirstOrThrow({ where: { id: action.id } })).realtimeState,
    'PRE_BARRIER',
  );
  await assert.rejects(
    () => lifecycle.record({ ...pre, state: 'POST_BARRIER' }),
    /immutable binding ที่ขัดแย้งกัน/,
  );
  await lifecycle.record({ ...pre, eventId: randomUUID(), state: 'POST_BARRIER' });
  await lifecycle.record({ ...pre, eventId: randomUUID(), state: 'ACCEPTED' });
  assert.equal(
    (await f.owner.jrAction.findFirstOrThrow({ where: { id: action.id } })).realtimeState,
    'ACCEPTED',
  );
});

test('CG3 version gap ครั้งแรก fail closed โดย hold action และไม่ส่ง acknowledgement APPLIED', async (t) => {
  const f = await fixture(t);
  const service = new JourneyGovernanceInvalidationService(
    f.application,
    {
      async revalidate() {
        return { decision: 'ALLOW' as const };
      },
    },
    {
      async releaseBeforeBarrier() {},
      async requestReconcile() {},
    },
    { consumer: 'journey-cg3-gap', now: () => new Date('2026-09-12T09:00:01.000Z') },
  );
  const event = preferenceEvent(f.tenantId, f.contactId, f.identityId);
  event.aggregateVersion = 2;
  event.payload.subjectVersion = 2;
  const result = await service.apply(event);
  assert.deepEqual(result, { outcome: 'FAILED', affectedCount: 0, state: 'GAP' });
  assert.equal(
    (await f.owner.jrAction.findFirstOrThrow({ where: { tenantId: f.tenantId } })).realtimeState,
    'HELD',
  );
  assert.equal(
    (await f.owner.jrGovernanceConsumerInbox.findFirstOrThrow({ where: { tenantId: f.tenantId } }))
      .state,
    'GAP',
  );
  assert.equal(
    await f.owner.jrGovernanceAcknowledgementOutbox.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('release ที่แพ้ barrier เปลี่ยนเป็น CANCEL_REQUESTED แล้วส่ง reconcile command', async (t) => {
  const f = await fixture(t);
  const releaseError = Object.assign(new Error('barrier won'), {
    code: 'DELIVERY_RECONCILIATION_REQUIRED',
  });
  const settlement: JourneyRealtimeSettlementPort = {
    async releaseBeforeBarrier() {
      throw releaseError;
    },
    async requestReconcile() {},
  };
  const service = new JourneyGovernanceInvalidationService(
    f.application,
    {
      async revalidate() {
        return { decision: 'BLOCK' as const, reasonCode: 'DNC' };
      },
    },
    settlement,
    { consumer: 'journey-cg3-race', now: () => new Date('2026-09-12T09:00:01.000Z') },
  );
  const event = preferenceEvent(f.tenantId, f.contactId, f.identityId);
  await service.apply(event);
  const deliveryId = randomUUID();
  const providerRequestKey = `provider-${randomUUID()}`;
  await f.owner.jrAction.updateMany({
    where: { tenantId: f.tenantId },
    data: { realtimeState: 'POST_BARRIER', deliveryId, providerRequestKey },
  });
  const relay = new JourneyGovernanceEffectRelay(f.application, settlement, {
    now: () => new Date('2026-09-12T09:00:02.000Z'),
  });
  assert.equal(await relay.executeNext(f.tenantId), 'SUCCEEDED');
  const action = await f.owner.jrAction.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(action.realtimeState, 'CANCEL_REQUESTED');
  assert.equal(
    await f.owner.jrGovernanceEffectOutbox.count({
      where: { tenantId: f.tenantId, kind: 'REQUEST_RECONCILE', state: 'PENDING' },
    }),
    1,
  );
});

test('post-barrier ที่ไม่มี immutable binding ถูก HOLD และ acknowledgement เป็น FAILED', async (t) => {
  const f = await fixture(t);
  await f.owner.jrAction.updateMany({
    where: { tenantId: f.tenantId },
    data: { realtimeState: 'POST_BARRIER' },
  });
  const service = new JourneyGovernanceInvalidationService(
    f.application,
    {
      async revalidate() {
        return { decision: 'BLOCK' as const, reasonCode: 'DNC' };
      },
    },
    { async releaseBeforeBarrier() {}, async requestReconcile() {} },
    { consumer: 'journey-cg3-binding-missing', now: () => new Date('2026-09-12T09:00:01.000Z') },
  );
  const result = await service.apply(preferenceEvent(f.tenantId, f.contactId, f.identityId));
  assert.equal(result.outcome, 'FAILED');
  assert.equal(
    (await f.owner.jrAction.findFirstOrThrow({ where: { tenantId: f.tenantId } })).realtimeState,
    'HELD',
  );
  assert.equal(
    (
      await f.owner.jrGovernanceAcknowledgementOutbox.findFirstOrThrow({
        where: { tenantId: f.tenantId },
      })
    ).outcome,
    'FAILED',
  );
});
