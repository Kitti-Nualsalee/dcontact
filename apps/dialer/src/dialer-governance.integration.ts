import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import type { KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import {
  DialerGovernanceInvalidationService,
  type DialerCanonicalRevalidator,
  type DialerRealtimeSettlementPort,
} from './dialer-governance.js';
import { DialerGovernanceEffectRelay } from './dialer-governance-effect-relay.js';

function governanceEvent(tenantId: string, contactId: string, identityId: string) {
  return {
    schemaVersion: 2,
    eventKind: 'CANONICAL',
    eventId: randomUUID(),
    type: 'preference.changed',
    tenantId,
    occurredAt: '2026-09-12T10:00:00.000Z',
    correlationId: 'dialer-cg3-test',
    orderingKey: `${tenantId}:${contactId}`,
    aggregateType: 'contact_governance_contact',
    aggregateId: contactId,
    aggregateVersion: 1,
    payload: {
      contractVersion: 1,
      mutationId: randomUUID(),
      subjectVersion: 1,
      affectedScope: { identityId, channel: 'VOICE', purpose: 'SERVICE', contactKind: null },
      effectiveAt: '2026-09-12T10:00:00.000Z',
      stateDigest: 'a'.repeat(64),
    },
  } satisfies KafkaEventEnvelopeV2<Record<string, unknown>>;
}

async function fixture(
  t: TestContext,
  state: 'QUEUED' | 'RESERVED' | 'POST_BARRIER' | 'IN_PROGRESS' = 'RESERVED',
) {
  const database = new PrismaClient();
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const identityId = randomUUID();
  const actionKey = `dialer:${randomUUID()}`;
  const reservationId = randomUUID();
  await database.tenant.create({
    data: {
      id: tenantId,
      name: 'Dialer CG3 test',
      slug: `dialer-cg3-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await database.contact.create({
    data: { id: contactId, tenantId, displayName: 'Synthetic Contact' },
  });
  await database.contactIdentity.create({
    data: { id: identityId, tenantId, contactId, type: 'PHONE', value: `test-${tenantId}` },
  });
  if (state !== 'QUEUED') {
    await database.cgReservation.create({
      data: {
        id: reservationId,
        tenantId,
        contactId,
        identityId,
        channel: 'VOICE',
        purpose: 'SERVICE',
        source: 'DIALER',
        sourceId: actionKey,
        actionKey,
        inputHash: 'a'.repeat(64),
        expiresAt: new Date('2026-09-12T11:00:00.000Z'),
      },
    });
  }
  const attempt = await database.obAttempt.create({
    data: {
      tenantId,
      actionKey,
      contactId,
      identityId,
      channel: 'VOICE',
      purpose: 'SERVICE',
      ...(state === 'QUEUED' ? {} : { reservationId }),
      realtimeState: state,
      ...(state === 'POST_BARRIER'
        ? { deliveryId: randomUUID(), providerRequestKey: `provider-${randomUUID()}` }
        : {}),
    },
  });
  t.after(async () => {
    await database.obGovernanceEffectOutbox.deleteMany({ where: { tenantId } });
    await database.obGovernanceAcknowledgementOutbox.deleteMany({ where: { tenantId } });
    await database.obGovernanceConsumerInbox.deleteMany({ where: { tenantId } });
    await database.obAttempt.deleteMany({ where: { tenantId } });
    await database.cgReservation.deleteMany({ where: { tenantId } });
    await database.contactIdentity.deleteMany({ where: { tenantId } });
    await database.contact.deleteMany({ where: { tenantId } });
    await database.tenant.deleteMany({ where: { id: tenantId } });
    await database.$disconnect();
  });
  return { database, tenantId, contactId, identityId, actionKey, reservationId, attempt };
}

function blockRevalidator(): DialerCanonicalRevalidator {
  return {
    async revalidate() {
      return { decision: 'BLOCK', reasonCode: 'PREFERENCE_BLOCKED' };
    },
  };
}

test('a CG3 event cancels the Dialer attempt before the barrier idempotently and releases after commit', async (t) => {
  const f = await fixture(t);
  const service = new DialerGovernanceInvalidationService(f.database, blockRevalidator(), {
    consumer: 'dialer-cg3-pre',
    now: () => new Date('2026-09-12T10:00:01.000Z'),
  });
  const event = governanceEvent(f.tenantId, f.contactId, f.identityId);
  assert.deepEqual(await service.apply(event), {
    outcome: 'APPLIED',
    affectedCount: 1,
    state: 'APPLIED',
  });
  const attempt = await f.database.obAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } });
  assert.equal(attempt.realtimeState, 'CANCELLED');
  assert.equal(attempt.nextOutboundBlocked, true);
  assert.equal(
    await f.database.obGovernanceAcknowledgementOutbox.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  assert.equal(
    await f.database.obGovernanceEffectOutbox.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  const released: string[] = [];
  const relay = new DialerGovernanceEffectRelay(
    f.database,
    {
      async releaseBeforeBarrier(input) {
        released.push(input.actionKey);
      },
      async requestReconcile() {
        throw new Error('work before the barrier must not reconcile');
      },
    },
    { now: () => new Date('2026-09-12T10:00:02.000Z') },
  );
  assert.equal(await relay.executeNext(f.tenantId), 'SUCCEEDED');
  assert.deepEqual(released, [f.actionKey]);
  assert.deepEqual(await service.apply(event), {
    outcome: 'APPLIED',
    affectedCount: 0,
    state: 'APPLIED',
  });
  assert.deepEqual(released, [f.actionKey]);
});

test('a CG3 event after the barrier only requests reconcile, without guessing a release or retry', async (t) => {
  const f = await fixture(t, 'POST_BARRIER');
  const service = new DialerGovernanceInvalidationService(f.database, blockRevalidator(), {
    consumer: 'dialer-cg3-post',
  });
  const event = governanceEvent(f.tenantId, f.contactId, f.identityId);
  await service.apply(event);
  const attempt = await f.database.obAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } });
  assert.equal(attempt.realtimeState, 'CANCEL_REQUESTED');
  let released = 0;
  const reconciled: string[] = [];
  const relay = new DialerGovernanceEffectRelay(f.database, {
    async releaseBeforeBarrier() {
      released += 1;
    },
    async requestReconcile(input) {
      reconciled.push(`${input.deliveryId}:${input.providerRequestKey}`);
    },
  });
  assert.equal(await relay.executeNext(f.tenantId), 'SUCCEEDED');
  assert.equal(released, 0);
  assert.deepEqual(reconciled, [`${attempt.deliveryId}:${attempt.providerRequestKey}`]);
});

test('a call in progress is not hard-disconnected but its next outbound action is blocked', async (t) => {
  const f = await fixture(t, 'IN_PROGRESS');
  const service = new DialerGovernanceInvalidationService(f.database, blockRevalidator(), {
    consumer: 'dialer-cg3-active',
  });
  await service.apply(governanceEvent(f.tenantId, f.contactId, f.identityId));
  const attempt = await f.database.obAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } });
  assert.equal(attempt.realtimeState, 'IN_PROGRESS');
  assert.equal(attempt.nextOutboundBlocked, true);
  assert.equal(
    await f.database.obGovernanceEffectOutbox.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('QUEUED work without a reservation is held fail-closed and is not released by guessing', async (t) => {
  const f = await fixture(t, 'QUEUED');
  const service = new DialerGovernanceInvalidationService(
    f.database,
    {
      async revalidate() {
        return { decision: 'REVIEW', reasonCode: 'GOVERNANCE_CONTEXT_UNAVAILABLE' };
      },
    },
    { consumer: 'dialer-cg3-queued' },
  );
  await service.apply(governanceEvent(f.tenantId, f.contactId, f.identityId));
  const attempt = await f.database.obAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } });
  assert.equal(attempt.realtimeState, 'HELD');
  assert.equal(attempt.nextOutboundBlocked, true);
  assert.equal(
    await f.database.obGovernanceEffectOutbox.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('a version gap holds work and does not acknowledge APPLIED until the replay is contiguous', async (t) => {
  const f = await fixture(t);
  const service = new DialerGovernanceInvalidationService(f.database, blockRevalidator(), {
    consumer: 'dialer-cg3-gap',
  });
  const event = governanceEvent(f.tenantId, f.contactId, f.identityId);
  event.aggregateVersion = 2;
  event.payload.subjectVersion = 2;
  assert.deepEqual(await service.apply(event), {
    outcome: 'FAILED',
    affectedCount: 0,
    state: 'GAP',
  });
  const attempt = await f.database.obAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } });
  assert.equal(attempt.realtimeState, 'HELD');
  assert.equal(attempt.nextOutboundBlocked, true);
  assert.equal(
    await f.database.obGovernanceAcknowledgementOutbox.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('an event hash conflict quarantines only the tenant and the tenant guard does not change', async (t) => {
  const f = await fixture(t);
  const guard = await fixture(t);
  const service = new DialerGovernanceInvalidationService(
    f.database,
    {
      async revalidate() {
        return { decision: 'ALLOW' as const };
      },
    },
    { consumer: 'dialer-cg3-conflict' },
  );
  const first = governanceEvent(f.tenantId, f.contactId, f.identityId);
  await service.apply(first);
  const conflict = {
    ...first,
    eventId: randomUUID(),
    payload: { ...first.payload, stateDigest: 'b'.repeat(64) },
  };
  assert.deepEqual(await service.apply(conflict), {
    outcome: 'FAILED',
    affectedCount: 0,
    state: 'QUARANTINED',
  });
  assert.equal(
    (await f.database.obAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).realtimeState,
    'HELD',
  );
  assert.equal(
    (await guard.database.obAttempt.findUniqueOrThrow({ where: { id: guard.attempt.id } }))
      .realtimeState,
    'RESERVED',
  );
});

test('a cross-tenant reservation swap is rejected at the immutable binding without exposing another tenant data', async (t) => {
  const f = await fixture(t);
  const guard = await fixture(t);
  await assert.rejects(
    () =>
      f.database.obAttempt.update({
        where: { id: f.attempt.id },
        data: { reservationId: guard.reservationId },
      }),
    (error: unknown) =>
      typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2003',
  );
  assert.equal(
    (await f.database.obAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } })).reservationId,
    f.reservationId,
  );
});
