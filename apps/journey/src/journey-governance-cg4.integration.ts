import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import type { DlqPublisher, KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import {
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  type ContactGovernanceRevalidationPort,
  type RevalidateAuthorizedActionOutcome,
} from '@d-contact/cxa-contracts';
import {
  JourneyGovernanceInvalidationService,
  createJourneyCanonicalRevalidator,
  type JourneyCanonicalRevalidator,
  type JourneyRevalidationDecision,
} from './journey-governance-invalidation.js';
import { publishGovernanceContractRejection } from './journey-governance-consumer.js';

/**
 * CG4.8 (#191): Journey consumer กับ CG4 exception/policy/kill-switch events
 * `CG4-RC02` (duplicate/gap/hash/unsupported/reload), downstream `CG4-ID02/OB01` และ `CG4-REG02`
 * บน Postgres จริงผ่าน application role (RLS) — ไม่มี provider I/O
 */

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';
const NOW = new Date('2026-09-12T09:00:01.000Z');
const EMAIL_SCOPE = 'channel=EMAIL|contactKind=*|purpose=*|sourceType=*';

function digest(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
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
      name: `Journey CG4 ${tenantId}`,
      slug: `journey-cg4-${tenantId}`,
      sipDomain: `${tenantId}.journey-cg4.test`,
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'CG4 synthetic' } });
  await owner.contactIdentity.create({
    data: {
      id: identityId,
      tenantId,
      contactId,
      type: 'EMAIL',
      value: `cg4-${tenantId}@example.test`,
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
  const governance = new ContactGovernanceService(application);
  const authorization = await governance.authorizeAndReserve(tenantId, {
    contactId,
    identityId,
    channel: 'EMAIL',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: enrollmentId,
    actionKey,
    policyVersion: 1,
  });
  assert.equal(authorization.decision, 'ALLOW');
  assert.ok(authorization.reservationId);
  await owner.jrEnrollment.create({
    data: { id: enrollmentId, tenantId, journeyVersion: 1, state: 'AUTHORIZED' },
  });
  const action = await owner.jrAction.create({
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
    await owner.jrRecoveryAudit.deleteMany({ where: { tenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.jrGovernanceEffectOutbox.deleteMany({ where: { tenantId } });
    await owner.jrGovernanceAcknowledgementOutbox.deleteMany({ where: { tenantId } });
    await owner.jrGovernanceConsumerInbox.deleteMany({ where: { tenantId } });
    await owner.jrAction.deleteMany({ where: { tenantId } });
    await owner.jrEnrollment.deleteMany({ where: { tenantId } });
    await owner.cg4ScopeKillSwitch.deleteMany({ where: { tenantId } });
    await owner.cg4PolicyScopeHead.deleteMany({ where: { tenantId } });
    await owner.cg4Policy.deleteMany({ where: { tenantId } });
    await owner.cgReservation.updateMany({
      where: { tenantId },
      data: { authorizationDecisionId: null },
    });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId } });
    await owner.cgContactStateHead.deleteMany({ where: { tenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return {
    owner,
    application,
    governance,
    tenantId,
    contactId,
    identityId,
    actionId: action.id,
    reservationId: authorization.reservationId!,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function envelope(
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
    occurredAt: '2026-09-12T09:00:00.000Z',
    correlationId: 'cg4-correlation',
    orderingKey: `${f.tenantId}:${input.aggregateId}`,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    payload: input.payload,
  };
}

function preferenceEvent(f: Fixture, version: number, stateSeed = `cg3:${version}`) {
  return envelope(f, {
    type: 'preference.changed',
    aggregateType: 'contact_governance_contact',
    aggregateId: f.contactId,
    aggregateVersion: version,
    payload: {
      contractVersion: 1,
      mutationId: randomUUID(),
      subjectVersion: version,
      identityId: f.identityId,
      affectedScope: {
        identityId: f.identityId,
        channel: 'EMAIL',
        purpose: 'MARKETING',
        contactKind: null,
      },
      effectiveAt: '2026-09-12T09:00:00.000Z',
      stateDigest: digest(stateSeed),
    },
  });
}

function cg4Payload(overrides: Record<string, unknown>) {
  return {
    contractVersion: 1,
    mutationId: randomUUID(),
    subjectId: randomUUID(),
    subjectVersion: 1,
    effectiveAt: '2026-09-12T09:00:00.000Z',
    scopeDigest: digest('scope'),
    ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
    policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
    evaluatorVersion: CG4_EVALUATOR_VERSION,
    stateDigest: digest(randomUUID()),
    ...overrides,
  };
}

function exceptionEvent(
  f: Fixture,
  version: number,
  overrides: Record<string, unknown> = {},
): KafkaEventEnvelopeV2<Record<string, unknown>> {
  return envelope(f, {
    type: 'exception.changed',
    aggregateType: 'contact_governance_contact',
    aggregateId: f.contactId,
    aggregateVersion: version,
    payload: cg4Payload({
      transitionKind: 'EXCEPTION_REVOKED',
      state: 'REVOKED',
      restrictiveness: 'TIGHTENING',
      // subjectVersion คือ revision ของ exception series ไม่ใช่ version ของ contact stream
      subjectVersion: 1,
      affectedScope: {
        scopeKey: `contact:${f.contactId}`,
        channel: 'EMAIL',
        purpose: 'MARKETING',
        sourceType: 'JOURNEY',
      },
      ...overrides,
    }),
  });
}

function killSwitchEvent(
  f: Fixture,
  killSwitchId: string,
  state: 'ACTIVE' | 'CLEARED',
  scope: { scopeKey: string; channel?: string } = { scopeKey: EMAIL_SCOPE, channel: 'EMAIL' },
) {
  return envelope(f, {
    type: 'governance.kill-switch.changed',
    aggregateType: 'contact_governance_policy',
    aggregateId: killSwitchId,
    aggregateVersion: state === 'ACTIVE' ? 1 : 2,
    payload: cg4Payload({
      transitionKind: state === 'ACTIVE' ? 'KILL_SWITCH_ACTIVATED' : 'KILL_SWITCH_CLEARED',
      subjectId: killSwitchId,
      subjectVersion: state === 'ACTIVE' ? 1 : 2,
      state,
      restrictiveness: state === 'ACTIVE' ? 'TIGHTENING' : 'RELAXATION',
      affectedScope: scope,
    }),
  });
}

function policyEvent(f: Fixture, policyId: string, headVersion: number, scopeKey: string) {
  return envelope(f, {
    type: 'policy.changed',
    aggregateType: 'contact_governance_policy',
    aggregateId: policyId,
    aggregateVersion: headVersion,
    payload: cg4Payload({
      transitionKind: 'POLICY_ACTIVATED',
      subjectId: policyId,
      subjectVersion: headVersion,
      state: 'ACTIVE',
      restrictiveness: 'TIGHTENING',
      policyVersion: headVersion,
      affectedScope: { scopeKey, channel: 'EMAIL', purpose: 'MARKETING' },
    }),
  });
}

const noSettlement = { async releaseBeforeBarrier() {}, async requestReconcile() {} };

const mustNotReauthorize: JourneyCanonicalRevalidator = {
  async revalidate() {
    throw new Error('event นี้ต้องไม่ขอ re-authorization');
  },
};

function recordingRevalidator(decision: JourneyRevalidationDecision) {
  const calls: Array<Parameters<JourneyCanonicalRevalidator['revalidate']>[0]> = [];
  const revalidator: JourneyCanonicalRevalidator = {
    async revalidate(input) {
      calls.push(input);
      return decision;
    },
  };
  return { calls, revalidator };
}

function service(f: Fixture, revalidator: JourneyCanonicalRevalidator, consumer: string) {
  return new JourneyGovernanceInvalidationService(f.application, revalidator, noSettlement, {
    consumer,
    now: () => NOW,
  });
}

async function actionState(f: Fixture) {
  return (await f.owner.jrAction.findUniqueOrThrow({ where: { id: f.actionId } })).realtimeState;
}

test('CG4-RC02: exception.changed ต่อ version จาก CG3 บน contact stream เดียวกัน และ re-authorize ด้วย contract CG4', async (t) => {
  const f = await fixture(t);
  const allow = recordingRevalidator({ decision: 'ALLOW' });
  const consumer = 'journey-cg4-mixed-stream';
  assert.equal(
    (await service(f, allow.revalidator, consumer).apply(preferenceEvent(f, 1))).state,
    'NO_OP',
  );

  const block = recordingRevalidator({ decision: 'BLOCK', reasonCode: 'QUIET_HOURS' });
  const revoked = exceptionEvent(f, 2);
  const result = await service(f, block.revalidator, consumer).apply(revoked);
  assert.deepEqual(result, { outcome: 'APPLIED', affectedCount: 1, state: 'APPLIED' });
  assert.equal(await actionState(f), 'CANCELLED');
  assert.equal(block.calls.length, 1);
  assert.equal(block.calls[0]!.source.contract, 'CG4');
  assert.equal(block.calls[0]!.source.eventType, 'exception.changed');
  assert.equal(block.calls[0]!.source.aggregateVersion, 2);
  assert.equal(
    await f.owner.jrGovernanceEffectOutbox.count({
      where: { tenantId: f.tenantId, kind: 'RELEASE_BEFORE_BARRIER' },
    }),
    1,
  );
  const ack = await f.owner.jrGovernanceAcknowledgementOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId, appliedVersion: 2 },
  });
  // ack ส่ง applied version พร้อม state digest ของ Governance (#179 §4)
  assert.equal(ack.appliedStateDigest, revoked.payload.stateDigest);
  assert.equal(ack.outcome, 'APPLIED');
});

test('CG4-RC02: relaxation ไม่ re-authorize และไม่ resume งานที่ hold ไว้', async (t) => {
  const f = await fixture(t);
  await f.owner.jrAction.update({ where: { id: f.actionId }, data: { realtimeState: 'HELD' } });
  const approved = exceptionEvent(f, 1, {
    transitionKind: 'EXCEPTION_APPROVED',
    state: 'APPROVED',
    restrictiveness: 'RELAXATION',
  });
  const result = await service(f, mustNotReauthorize, 'journey-cg4-relaxation').apply(approved);
  assert.deepEqual(result, { outcome: 'NO_OP', affectedCount: 0, state: 'NO_OP' });
  assert.equal(await actionState(f), 'HELD');
  assert.equal(
    await f.owner.jrGovernanceEffectOutbox.count({ where: { tenantId: f.tenantId } }),
    0,
  );
  const ack = await f.owner.jrGovernanceAcknowledgementOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(ack.outcome, 'NO_OP');
  assert.equal(ack.appliedStateDigest, approved.payload.stateDigest);
});

test('CG4-RC02: kill switch hold งานใน scope ทันทีโดยไม่ถาม evaluator และ clear ไม่ปลดงาน', async (t) => {
  const f = await fixture(t);
  const killSwitchId = randomUUID();
  const hold = service(f, mustNotReauthorize, 'journey-cg4-kill');
  assert.deepEqual(await hold.apply(killSwitchEvent(f, killSwitchId, 'ACTIVE')), {
    outcome: 'APPLIED',
    affectedCount: 1,
    state: 'APPLIED',
  });
  assert.equal(await actionState(f), 'HELD');
  assert.equal(
    await f.owner.jrGovernanceEffectOutbox.count({
      where: { tenantId: f.tenantId, kind: 'RELEASE_BEFORE_BARRIER' },
    }),
    1,
  );

  assert.deepEqual(await hold.apply(killSwitchEvent(f, killSwitchId, 'CLEARED')), {
    outcome: 'NO_OP',
    affectedCount: 0,
    state: 'NO_OP',
  });
  assert.equal(await actionState(f), 'HELD');
  assert.equal(
    await f.owner.jrGovernanceEffectOutbox.count({ where: { tenantId: f.tenantId } }),
    1,
  );
});

test('CG4-RC02: kill switch ของ channel อื่นไม่แตะงาน EMAIL', async (t) => {
  const f = await fixture(t);
  const result = await service(f, mustNotReauthorize, 'journey-cg4-kill-scope').apply(
    killSwitchEvent(f, randomUUID(), 'ACTIVE', {
      scopeKey: 'channel=VOICE|contactKind=*|purpose=*|sourceType=*',
      channel: 'VOICE',
    }),
  );
  assert.deepEqual(result, { outcome: 'NO_OP', affectedCount: 0, state: 'NO_OP' });
  assert.equal(await actionState(f), 'RESERVED');
});

test('CG4-RC02: contract version ที่ไม่รู้จัก quarantine hold scope ส่ง DLQ และไม่ขยับ cursor', async (t) => {
  const f = await fixture(t);
  const consumer = 'journey-cg4-unsupported';
  const unsupported = exceptionEvent(f, 1, { contractVersion: 2 });
  const result = await service(f, mustNotReauthorize, consumer).apply(unsupported);
  assert.deepEqual(result, {
    outcome: 'QUARANTINED',
    affectedCount: 1,
    state: 'QUARANTINED',
    reasonCode: 'UNSUPPORTED_CONTRACT_VERSION',
  });
  assert.equal(await actionState(f), 'HELD');
  const inbox = await f.owner.jrGovernanceConsumerInbox.findFirstOrThrow({
    where: { tenantId: f.tenantId, eventId: unsupported.eventId },
  });
  assert.equal(inbox.reasonCode, 'UNSUPPORTED_CONTRACT_VERSION');
  assert.equal(
    (
      await f.owner.jrGovernanceAcknowledgementOutbox.findFirstOrThrow({
        where: { tenantId: f.tenantId },
      })
    ).outcome,
    'QUARANTINED',
  );

  // cursor ไม่ขยับ: version ถัดไปจึงเป็น gap จนกว่าจะ canonical reload
  const next = await service(f, mustNotReauthorize, consumer).apply(preferenceEvent(f, 2));
  assert.equal(next.state, 'GAP');

  const published: Parameters<DlqPublisher['publish']>[0][] = [];
  const dlq: DlqPublisher = {
    async publish(message) {
      published.push(message);
    },
  };
  const source = {
    topic: 'dc.contact-governance.events',
    partition: 3,
    offset: '42',
    event: unsupported,
  };
  assert.equal(await publishGovernanceContractRejection(dlq, result.reasonCode, source), true);
  assert.equal(published[0]?.dlqReason, 'UNSUPPORTED_SCHEMA_VERSION');
  assert.equal(published[0]?.partition, 3);
  assert.equal(await publishGovernanceContractRejection(dlq, 'EVENT_HASH_CONFLICT', source), false);
  assert.equal(published.length, 1);
});

test('CG4-ID02: version+digest ซ้ำด้วย eventId ใหม่เป็น DUPLICATE ไม่มี ack ซ้ำ ส่วน digest ต่างถูก quarantine', async (t) => {
  const f = await fixture(t);
  const consumer = 'journey-cg4-duplicate';
  const allow = recordingRevalidator({ decision: 'ALLOW' });
  const first = preferenceEvent(f, 1, 'same-state');
  await service(f, allow.revalidator, consumer).apply(first);

  const republished = { ...first, eventId: randomUUID() };
  assert.deepEqual(await service(f, allow.revalidator, consumer).apply(republished), {
    outcome: 'NO_OP',
    affectedCount: 0,
    state: 'DUPLICATE',
  });
  assert.equal(allow.calls.length, 1);
  assert.equal(
    await f.owner.jrGovernanceAcknowledgementOutbox.count({ where: { tenantId: f.tenantId } }),
    1,
  );

  const conflicting = preferenceEvent(f, 1, 'other-state');
  const conflict = await service(f, allow.revalidator, consumer).apply(conflicting);
  assert.equal(conflict.state, 'QUARANTINED');
  assert.equal(await actionState(f), 'HELD');
  assert.equal(
    (
      await f.owner.jrGovernanceConsumerInbox.findFirstOrThrow({
        where: { tenantId: f.tenantId, eventId: conflicting.eventId },
      })
    ).reasonCode,
    'EVENT_HASH_CONFLICT',
  );
});

test('CG4-RC02: canonical reload หลัง gap ขยับ cursor พร้อม audit/ack แต่ไม่ resume งานที่ hold', async (t) => {
  const f = await fixture(t);
  const consumer = 'journey-cg4-reload';
  const allow = recordingRevalidator({ decision: 'ALLOW' });
  const gapEvent = preferenceEvent(f, 3);
  assert.equal((await service(f, allow.revalidator, consumer).apply(gapEvent)).state, 'GAP');
  assert.equal(await actionState(f), 'HELD');

  const journey = service(f, allow.revalidator, consumer);
  const reload = {
    tenantId: f.tenantId,
    aggregateType: 'CONTACT' as const,
    aggregateId: f.contactId,
    canonicalVersion: 3,
    canonicalStateDigest: digest('cg3:3'),
    // stable subject id แบบ opaque ไม่ใช่ชื่อหรืออีเมลของ operator
    actorId: randomUUID(),
    reasonCode: 'GOVERNANCE_GAP_RELOAD',
  };
  assert.deepEqual(await journey.resumeFromCanonical(reload), {
    cursorVersion: 3,
    reloaded: true,
    heldActions: 1,
  });
  assert.equal(await actionState(f), 'HELD');
  assert.equal(await f.owner.jrRecoveryAudit.count({ where: { tenantId: f.tenantId } }), 1);
  const ack = await f.owner.jrGovernanceAcknowledgementOutbox.findFirstOrThrow({
    where: { tenantId: f.tenantId, appliedVersion: 3 },
  });
  assert.equal(ack.appliedStateDigest, reload.canonicalStateDigest);

  // redelivery ของ event ที่เคยเป็น gap ตรงกับ state digest ของ reload จึงเป็น duplicate
  assert.equal((await journey.apply(gapEvent)).state, 'DUPLICATE');
  assert.equal((await journey.apply(preferenceEvent(f, 4))).state, 'NO_OP');
  assert.equal(allow.calls.length, 0, 'งานที่ HELD ไม่ถูกดึงกลับมาประเมินใหม่');
  assert.equal((await journey.resumeFromCanonical(reload)).reloaded, false);
});

test('CG4-REG02: CG4 events ไม่สร้าง reservation และไม่แตะ J2 internal owner action', async (t) => {
  const f = await fixture(t);
  const ownerAction = await f.owner.jrOwnerAction.create({
    data: {
      tenantId: f.tenantId,
      actionKey: `${randomUUID()}:1:ensure-case`,
      enrollmentId: randomUUID(),
      kind: 'ENSURE_CASE',
      requestHash: digest('ensure-case'),
      correlationId: 'reg02',
    },
  });
  const before = {
    reservations: await f.owner.cgReservation.count({ where: { tenantId: f.tenantId } }),
    decisions: await f.owner.cgDecisionLog.count({ where: { tenantId: f.tenantId } }),
  };
  const consumer = 'journey-cg4-reg02';
  const block = recordingRevalidator({ decision: 'BLOCK', reasonCode: 'CONSENT_REVOKED' });
  await service(f, block.revalidator, consumer).apply(killSwitchEvent(f, randomUUID(), 'ACTIVE'));
  await service(f, block.revalidator, consumer).apply(exceptionEvent(f, 1));

  assert.equal(
    await f.owner.cgReservation.count({ where: { tenantId: f.tenantId } }),
    before.reservations,
  );
  assert.equal(
    await f.owner.cgDecisionLog.count({ where: { tenantId: f.tenantId } }),
    before.decisions,
  );
  const untouched = await f.owner.jrOwnerAction.findUniqueOrThrow({
    where: { id: ownerAction.id },
  });
  assert.equal(untouched.state, ownerAction.state);
  assert.equal(untouched.cancelRequestedAt, null);
});

test('CG4-REG02: Governance จริงไม่ตัดสิน CG4 policy head ว่า stale และ re-authorization เห็น kill switch', async (t) => {
  const f = await fixture(t);
  const outcomes: RevalidateAuthorizedActionOutcome[] = [];
  const port: ContactGovernanceRevalidationPort = {
    async revalidateAuthorizedAction(input) {
      const outcome = await (
        f.governance as unknown as ContactGovernanceRevalidationPort
      ).revalidateAuthorizedAction(input);
      outcomes.push(outcome);
      return outcome;
    },
  };
  const revalidator = createJourneyCanonicalRevalidator(port);
  const scopeKey = 'channel=EMAIL|contactKind=*|purpose=MARKETING|sourceType=*';
  const policyId = randomUUID();
  const policyRow = await f.owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      policyId,
      version: 1,
      scopeKey,
      content: {} as Prisma.InputJsonValue,
      contentDigest: digest('policy-content'),
      registryVersion: CG4_RULE_REGISTRY_VERSION,
      status: 'PUBLISHED',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      makerActorRef: 'policy-maker-synthetic',
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  await f.owner.cg4PolicyScopeHead.create({
    data: {
      tenantId: f.tenantId,
      scopeKey,
      headPolicyId: policyId,
      headPolicyVersion: 1,
      headPolicyRevisionId: policyRow.id,
      headVersion: 1,
      headDigest: digest('head:1'),
    },
  });

  const consumer = 'journey-cg4-real-governance';
  const journey = service(f, revalidator, consumer);
  // เดิมการเทียบ headVersion กับ CG3 policy version ให้ GOVERNANCE_VERSION_STALE แล้ว hold งาน
  assert.equal((await journey.apply(policyEvent(f, policyId, 1, scopeKey))).state, 'NO_OP');
  assert.equal(outcomes.at(-1)?.decision, 'ALLOW');
  assert.equal(await actionState(f), 'RESERVED');

  await f.owner.cg4ScopeKillSwitch.create({
    data: {
      tenantId: f.tenantId,
      scopeKey: EMAIL_SCOPE,
      state: 'ACTIVE',
      reasonCode: 'INCIDENT',
      evidenceRef: 'evidence:synthetic',
      activatedByRef: 'operator-synthetic',
      activatedAt: NOW,
    },
  });
  await f.owner.cg4PolicyScopeHead.update({
    where: { tenantId_scopeKey: { tenantId: f.tenantId, scopeKey } },
    data: { headVersion: 2, headDigest: digest('head:2') },
  });
  const result = await journey.apply(policyEvent(f, policyId, 2, scopeKey));
  assert.equal(result.state, 'APPLIED');
  assert.equal(outcomes.at(-1)?.decision, 'REVIEW');
  assert.equal(outcomes.at(-1)?.reasonCode, 'GOVERNANCE_KILL_SWITCH_ACTIVE');
  assert.equal(await actionState(f), 'HELD');
});
