import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import type { KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import {
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
} from '@d-contact/cxa-contracts';
import {
  DialerGovernanceInvalidationService,
  type DialerCanonicalRevalidator,
} from './dialer-governance.js';

/**
 * CG4.8 (#191): Dialer เป็นผู้ hold/cancel attempt ของ Campaign/Callback เมื่อ CG4 เปลี่ยน
 * โดยไม่ตัดสายที่กำลังคุยและไม่ resume attempt เมื่อมี relaxation
 */

function digest(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

type AttemptState = 'RESERVED' | 'IN_PROGRESS' | 'HELD';

async function fixture(t: TestContext, state: AttemptState = 'RESERVED') {
  const database = new PrismaClient();
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const identityId = randomUUID();
  const actionKey = `dialer:${randomUUID()}`;
  const reservationId = randomUUID();
  await database.tenant.create({
    data: {
      id: tenantId,
      name: 'Dialer CG4 test',
      slug: `dialer-cg4-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await database.contact.create({ data: { id: contactId, tenantId, displayName: 'Synthetic' } });
  await database.contactIdentity.create({
    data: { id: identityId, tenantId, contactId, type: 'PHONE', value: `test-${tenantId}` },
  });
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
  const attempt = await database.obAttempt.create({
    data: {
      tenantId,
      actionKey,
      contactId,
      identityId,
      channel: 'VOICE',
      purpose: 'SERVICE',
      reservationId,
      realtimeState: state,
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
  return { database, tenantId, contactId, attempt };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function cg4Event(
  f: Fixture,
  input: {
    type: string;
    aggregateType: 'contact_governance_contact' | 'contact_governance_policy';
    aggregateId: string;
    aggregateVersion: number;
    payload: Record<string, unknown>;
  },
): KafkaEventEnvelopeV2<Record<string, unknown>> {
  return {
    schemaVersion: 2,
    eventKind: 'CANONICAL',
    eventId: randomUUID(),
    type: input.type,
    tenantId: f.tenantId,
    occurredAt: '2026-09-12T10:00:00.000Z',
    correlationId: 'dialer-cg4-test',
    orderingKey: `${f.tenantId}:${input.aggregateId}`,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    payload: {
      contractVersion: 1,
      mutationId: randomUUID(),
      subjectId: randomUUID(),
      subjectVersion: 1,
      effectiveAt: '2026-09-12T10:00:00.000Z',
      scopeDigest: digest('scope'),
      ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
      policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
      evaluatorVersion: CG4_EVALUATOR_VERSION,
      stateDigest: digest(randomUUID()),
      ...input.payload,
    },
  };
}

function killSwitch(f: Fixture, id: string, state: 'ACTIVE' | 'CLEARED') {
  return cg4Event(f, {
    type: 'governance.kill-switch.changed',
    aggregateType: 'contact_governance_policy',
    aggregateId: id,
    aggregateVersion: state === 'ACTIVE' ? 1 : 2,
    payload: {
      transitionKind: state === 'ACTIVE' ? 'KILL_SWITCH_ACTIVATED' : 'KILL_SWITCH_CLEARED',
      state,
      restrictiveness: state === 'ACTIVE' ? 'TIGHTENING' : 'RELAXATION',
      affectedScope: {
        scopeKey: 'channel=VOICE|contactKind=*|purpose=*|sourceType=*',
        channel: 'VOICE',
      },
    },
  });
}

const mustNotReauthorize: DialerCanonicalRevalidator = {
  async revalidate() {
    throw new Error('event นี้ต้องไม่ขอ re-authorization');
  },
};

test('CG4-RC02: kill switch hold attempt ก่อน barrier และสายที่กำลังคุยถูก block outbound ถัดไปเท่านั้น', async (t) => {
  const reserved = await fixture(t, 'RESERVED');
  const active = await fixture(t, 'IN_PROGRESS');
  for (const f of [reserved, active]) {
    const service = new DialerGovernanceInvalidationService(f.database, mustNotReauthorize, {
      consumer: 'dialer-cg4-kill',
    });
    const result = await service.apply(killSwitch(f, randomUUID(), 'ACTIVE'));
    assert.equal(result.outcome, 'APPLIED');
    assert.equal(result.affectedCount, 1);
  }
  const held = await reserved.database.obAttempt.findUniqueOrThrow({
    where: { id: reserved.attempt.id },
  });
  assert.equal(held.realtimeState, 'HELD');
  assert.equal(held.nextOutboundBlocked, true);
  assert.equal(
    await reserved.database.obGovernanceEffectOutbox.count({
      where: { tenantId: reserved.tenantId, kind: 'RELEASE_BEFORE_BARRIER' },
    }),
    1,
  );
  const inCall = await active.database.obAttempt.findUniqueOrThrow({
    where: { id: active.attempt.id },
  });
  assert.equal(inCall.realtimeState, 'IN_PROGRESS');
  assert.equal(inCall.nextOutboundBlocked, true);
  assert.equal(
    await active.database.obGovernanceEffectOutbox.count({ where: { tenantId: active.tenantId } }),
    0,
  );
});

test('CG4-RC02: clear kill switch และ exception ที่ approve ไม่ resume attempt ที่ HELD', async (t) => {
  const f = await fixture(t, 'HELD');
  await f.database.obAttempt.update({
    where: { id: f.attempt.id },
    data: { nextOutboundBlocked: true },
  });
  const service = new DialerGovernanceInvalidationService(f.database, mustNotReauthorize, {
    consumer: 'dialer-cg4-relaxation',
  });
  const killSwitchId = randomUUID();
  await service.apply(killSwitch(f, killSwitchId, 'ACTIVE'));
  assert.deepEqual(await service.apply(killSwitch(f, killSwitchId, 'CLEARED')), {
    outcome: 'NO_OP',
    affectedCount: 0,
    state: 'NO_OP',
  });
  const approved = cg4Event(f, {
    type: 'exception.changed',
    aggregateType: 'contact_governance_contact',
    aggregateId: f.contactId,
    aggregateVersion: 1,
    payload: {
      transitionKind: 'EXCEPTION_APPROVED',
      state: 'APPROVED',
      restrictiveness: 'RELAXATION',
      affectedScope: { scopeKey: `contact:${f.contactId}`, channel: 'VOICE', purpose: 'SERVICE' },
    },
  });
  assert.equal((await service.apply(approved)).state, 'NO_OP');
  const attempt = await f.database.obAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } });
  assert.equal(attempt.realtimeState, 'HELD');
  assert.equal(attempt.nextOutboundBlocked, true);
  assert.equal(
    await f.database.obGovernanceEffectOutbox.count({ where: { tenantId: f.tenantId } }),
    0,
  );
});

test('CG4-RC02: evaluator version ที่ไม่รู้จัก quarantine และ hold attempt ของ contact แบบ fail closed', async (t) => {
  const f = await fixture(t);
  const service = new DialerGovernanceInvalidationService(f.database, mustNotReauthorize, {
    consumer: 'dialer-cg4-unsupported',
  });
  const unsupported = cg4Event(f, {
    type: 'exception.changed',
    aggregateType: 'contact_governance_contact',
    aggregateId: f.contactId,
    aggregateVersion: 1,
    payload: {
      evaluatorVersion: 'CG4_EVALUATOR_V9',
      transitionKind: 'EXCEPTION_REVOKED',
      state: 'REVOKED',
      restrictiveness: 'TIGHTENING',
      affectedScope: { scopeKey: `contact:${f.contactId}` },
    },
  });
  assert.deepEqual(await service.apply(unsupported), {
    outcome: 'FAILED',
    affectedCount: 1,
    state: 'QUARANTINED',
    reasonCode: 'UNSUPPORTED_EVALUATOR_VERSION',
  });
  const attempt = await f.database.obAttempt.findUniqueOrThrow({ where: { id: f.attempt.id } });
  assert.equal(attempt.realtimeState, 'HELD');
  assert.equal(attempt.nextOutboundBlocked, true);
  // redelivery ของ eventId เดิมไม่ประเมินซ้ำ แต่ยังคืน reason ให้ consumer ส่ง DLQ ได้สม่ำเสมอ
  assert.equal((await service.apply(unsupported)).reasonCode, 'UNSUPPORTED_EVALUATOR_VERSION');
});
