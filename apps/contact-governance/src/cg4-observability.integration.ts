import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import {
  cg4SubjectId,
  tenantId as tenantIdBrand,
  type Cg4AuthorizationSubject,
  type Cg4Capability,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceService } from './contact-governance-service.js';
import { Cg4ApprovalRepository } from './cg4-approval-repository.js';
import { Cg4LegacyBackfill } from './cg4-legacy-backfill.js';
import {
  cg4DownstreamAcknowledgements,
  cg4MetricSamples,
  cg4ObservabilitySnapshot,
  evaluateCg4Alerts,
} from './cg4-observability.js';
import { buildCg4PolicyScopeKey } from './cg4-policy-compiler.js';
import type { Cg4PolicyFixturePack } from './cg4-policy-fixtures.js';
import { Cg4PolicyLifecycleRepository } from './cg4-policy-lifecycle.js';
import { Cg4RolloutRepository } from './cg4-rollout.js';

/**
 * CG4.11 (#194): `CG4-OB01` metrics/alerts และ `CG4-OB02` negative scan บน Postgres จริงผ่าน
 * application role โดยสร้าง state จาก owner path จริง (backfill, lifecycle, rollout, authorize)
 * แล้วจำลองเฉพาะฝั่ง downstream consumer (inbox/pause/ack) ที่เป็นของ owner อื่น
 */

/**
 * T0 ต้องอยู่หลังเวลาจริงเสมอ ไม่ใช่วันที่ใกล้ ๆ ตอนเขียนเทส
 *
 * state ส่วนใหญ่ถูก backdate จาก T0 ตรง ๆ (quorum 7200s, activation 3600s, pause 1800s) แต่แถว
 * ใน cgEventOutbox ถูกสร้างโดย owner path จริง createdAt จึงเป็นนาฬิกาของฐานข้อมูล ไม่ใช่ T0
 * oldestPendingOutboxAgeSeconds คือ T0 ลบ createdAt พอเวลาจริงเดินผ่าน T0 ไป ค่านี้ติดลบ แล้ว
 * GOVERNANCE_OUTBOX_LAG ก็ไม่ยิงอีกเลย
 *
 * เดิมตั้งไว้ 2026-09-15T05:00Z ซึ่งระเบิดตอน 05:00Z ของวันนั้นพอดี ทำให้ CG4-OB01 ล้มทุก run
 * ตั้งแต่นั้นมา (ตอนแรกดูเหมือน flaky เพราะ run ก่อนหน้าเวลานั้นยังผ่าน)
 */
const T0 = new Date('2099-09-15T05:00:00.000Z'); // 12:00 Asia/Bangkok
const LINE_MARKETING = buildCg4PolicyScopeKey({ channel: 'LINE', purpose: 'MARKETING' });
const VOICE_SERVICE = buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'SERVICE' });
const NIGHT = { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' };
const ZONE = 'Asia/Bangkok';
/** ค่าที่ห้ามหลุดไปอยู่ใน event/decision trace/metric/alert/ack view */
const IDENTITY_VALUE = 'line-user-synthetic-0812345678';
const DISPLAY_NAME = 'Synthetic Customer Name';
const FREE_TEXT_EVIDENCE = 'หลักฐานข้อความอิสระของ checker synthetic';
const SOURCE_ID = 'journey-cg411-source';
const MAKER = 'maker-cg411-person';
const CHECKER = 'checker-cg411-person';

const TENANT_PACK: Cg4PolicyFixturePack = {
  packId: 'TENANT_SYNTHETIC',
  suiteVersion: 'TENANT_SYNTHETIC_V1',
  checks: [
    {
      id: 'tenant:quiet-hours-local-clock',
      kind: 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK',
      timezone: ZONE,
      fromInstant: '2026-09-14T00:00:00.000Z',
      probeHours: 24,
      stepMinutes: 60,
    },
  ],
};

const content = (extra?: { startLocal: string; endLocal: string }) => ({
  timezoneFallback: ZONE,
  quietHours: [NIGHT, ...(extra ? [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], ...extra }] : [])],
  callbackMode: 'SCOPED_OVERRIDE',
  overridableRules: [],
  allowedOperationalRuleCodes: [],
  holidays: [],
});

async function observedTenant(t: TestContext) {
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
  const tenant = randomUUID();
  const contact = randomUUID();
  const identity = randomUUID();
  let clock = T0;
  const now = () => clock;

  t.after(async () => {
    await owner.cgConsumerAcknowledgement.deleteMany({ where: { tenantId: tenant } });
    await owner.cgScopePause.deleteMany({ where: { tenantId: tenant } });
    await owner.cgConsumerInbox.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ShadowMismatch.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4RolloutTransition.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4RolloutState.deleteMany({ where: { tenantId: tenant } });
    await owner.cgReservation.updateMany({
      where: { tenantId: tenant },
      data: { authorizationDecisionId: null },
    });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cgReservation.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4BackfillLedger.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyApproval.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyTestArtifact.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyActivationJob.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyScopeHead.deleteMany({ where: { tenantId: tenant } });
    for (;;) {
      const rows = await owner.cg4Policy.findMany({
        where: { tenantId: tenant },
        select: { id: true, supersedesId: true, rollbackOfId: true },
      });
      if (rows.length === 0) break;
      const referenced = new Set(
        rows
          .flatMap((row) => [row.supersedesId, row.rollbackOfId])
          .filter((id): id is string => id !== null),
      );
      const leaves = rows.filter((row) => !referenced.has(row.id)).map((row) => row.id);
      if (leaves.length === 0) break;
      await owner.cg4Policy.deleteMany({ where: { id: { in: leaves } } });
    }
    await owner.cg4ScopeKillSwitch.deleteMany({ where: { tenantId: tenant } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId: tenant } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId: tenant } });
    await owner.cgContactStateHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cgPolicy.deleteMany({ where: { tenantId: tenant } });
    await owner.cgConsent.deleteMany({ where: { tenantId: tenant } });
    await owner.contactIdentity.deleteMany({ where: { tenantId: tenant } });
    await owner.contact.deleteMany({ where: { tenantId: tenant } });
    await owner.tenant.deleteMany({ where: { id: tenant } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenant,
      name: `CG4.11 ${tenant}`,
      slug: `cg411-${tenant}`,
      sipDomain: `${tenant}.cg411.test`,
    },
  });
  await owner.contact.create({
    data: { id: contact, tenantId: tenant, displayName: DISPLAY_NAME },
  });
  await owner.contactIdentity.create({
    data: {
      id: identity,
      tenantId: tenant,
      contactId: contact,
      type: 'LINE',
      value: IDENTITY_VALUE,
    },
  });
  await owner.cgConsent.create({
    data: {
      tenantId: tenant,
      contactId: contact,
      purpose: 'MARKETING',
      channel: 'LINE',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: FREE_TEXT_EVIDENCE },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  await owner.cgPolicy.create({
    data: {
      id: randomUUID(),
      tenantId: tenant,
      policyId: randomUUID(),
      version: 1,
      purpose: 'MARKETING',
      channel: 'LINE',
      timezoneFallback: ZONE,
      quietHours: [NIGHT] as unknown as Prisma.InputJsonValue,
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: [] as unknown as Prisma.InputJsonValue,
      status: 'PUBLISHED',
      contentDigest: 'a'.repeat(64),
      makerActorRef: MAKER,
      checkerActorRef: CHECKER,
      approvalRef: FREE_TEXT_EVIDENCE,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });

  const subject = (
    id: string,
    capabilities: Cg4Capability[],
    scopeKey = LINE_MARKETING,
  ): Cg4AuthorizationSubject => ({
    subjectId: cg4SubjectId(id),
    tenantId: tenantIdBrand('00000000-0000-0000-0000-000000000000'),
    authenticationStrength: 'STANDARD',
    capabilities: capabilities.map((capability) => ({
      capability,
      scopeKey,
      source: 'DIRECT' as const,
    })),
    directComplianceAuthority: true,
    emergencyAuthority: false,
    authorizationEpoch: 1,
    scopeVersion: 1,
    evaluatedAt: clock.toISOString(),
  });
  const lifecycle = new Cg4PolicyLifecycleRepository(application, { now });
  const approvals = new Cg4ApprovalRepository(application, { now });
  const rollout = new Cg4RolloutRepository(application, { now });
  const service = new ContactGovernanceService(application, { now });
  const command = (actor: Cg4AuthorizationSubject) => ({
    actor,
    evidenceRef: FREE_TEXT_EVIDENCE,
    occurredAt: clock.toISOString(),
    idempotencyKey: randomUUID(),
  });

  const draftAndTest = async (input: {
    policyId?: string;
    scopeKey: string;
    window: { startLocal: string; endLocal: string };
  }) => {
    const maker = subject(MAKER, ['cg.policy.draft'], input.scopeKey);
    const draft = await lifecycle.createDraft({
      tenantId: tenant,
      ...(input.policyId ? { policyId: input.policyId } : {}),
      scopeKey: input.scopeKey,
      content: content(input.window),
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      ...command(maker),
    });
    const tested = await lifecycle.runTests({
      tenantId: tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: '2026-09-14T00:00:00.000Z',
      pinnedTimezone: ZONE,
      ...command(maker),
    });
    await lifecycle.submit({
      tenantId: tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedDraftRevision: draft.draftRevision,
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: tested.preview.artifactDigest,
      ...command(maker),
    });
    return { draft, tested };
  };

  // backfill → scheduled tightening บน LINE (event จริง) → policy รอ quorum บน VOICE
  await new Cg4LegacyBackfill(application, { now }).run({
    tenantId: tenant,
    operatorRef: 'operator-cg411',
  });
  const legacy = await owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: tenant, origin: 'LEGACY_CG3' },
  });
  const { draft, tested } = await draftAndTest({
    policyId: legacy.policyId,
    scopeKey: LINE_MARKETING,
    window: { startLocal: '11:00', endLocal: '14:00' },
  });
  await approvals.recordPolicyApproval({
    tenantId: tenant,
    policyId: draft.policyId,
    expectedVersion: draft.version,
    expectedContentDigest: draft.contentDigest,
    diffClass: tested.preview.diffClass,
    decision: 'APPROVE',
    evidenceRef: FREE_TEXT_EVIDENCE,
    makerSubjectId: MAKER,
    scopeKey: LINE_MARKETING,
    checker: subject(CHECKER, ['cg.policy.publish']),
    idempotencyKey: randomUUID(),
  });
  const head = await lifecycle.preview({
    tenantId: tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedContentDigest: draft.contentDigest,
    tenantPack: TENANT_PACK,
    pinnedEvaluationTime: '2026-09-14T00:00:00.000Z',
    pinnedTimezone: ZONE,
  });
  await lifecycle.finalizeApproval({
    tenantId: tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedContentDigest: draft.contentDigest,
    expectedTestArtifactDigest: tested.preview.artifactDigest,
    expectedDiffClass: tested.preview.diffClass,
    expectedScopeHeadVersion: head.baseHeadVersion,
    expectedScopeHeadDigest: head.baseHeadDigest,
    activateAt: new Date(T0.getTime() + 3_600_000).toISOString(),
    ...command(subject('finalizer-cg411', ['cg.policy.draft'])),
  });
  const row = await owner.cg4Policy.findFirstOrThrow({
    where: { tenantId: tenant, policyId: draft.policyId, version: draft.version },
  });
  await lifecycle.publish({
    tenantId: tenant,
    policyId: draft.policyId,
    version: draft.version,
    expectedContentDigest: draft.contentDigest,
    expectedTestArtifactDigest: tested.preview.artifactDigest,
    expectedApprovalDigest: row.approvalDigest as string,
    expectedScopeHeadVersion: head.baseHeadVersion,
    expectedScopeHeadDigest: head.baseHeadDigest,
    ...command(subject('publisher-cg411', ['cg.policy.publish'])),
  });
  await draftAndTest({
    scopeKey: VOICE_SERVICE,
    window: { startLocal: '12:00', endLocal: '13:00' },
  });

  // worker ไม่ activate ตามเวลา → shadow เห็นว่า CG4 fail closed ขณะที่ CG3 อนุญาต
  clock = new Date(T0.getTime() + 2 * 3_600_000);
  await rollout.transition({
    tenantId: tenant,
    expectedVersion: 0,
    toStage: 'SHADOW_EVALUATION',
    syntheticScopeKeys: [LINE_MARKETING],
    actorRef: 'operator-cg411',
    evidenceRef: 'evidence:rollout',
    reasonCode: 'CG4_11_OBSERVABILITY',
  });
  const decision = await service.authorizeAndReserve(tenant, {
    contactId: contact,
    identityId: identity,
    channel: 'LINE',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: SOURCE_ID,
    actionKey: `cg411:${tenant}:1`,
    policyVersion: 1,
  } as never);
  await lifecycle.killSwitch({
    tenantId: tenant,
    scopeKey: LINE_MARKETING,
    action: 'ACTIVATE',
    reasonCode: 'CG4_READER_BROKEN',
    actor: subject('operator-kill-cg411', ['cg.policy.publish']),
    evidenceRef: FREE_TEXT_EVIDENCE,
    occurredAt: clock.toISOString(),
    idempotencyKey: randomUUID(),
  });
  await rollout.setFrozen({
    tenantId: tenant,
    expectedVersion: 1,
    frozen: true,
    actorRef: 'operator-cg411',
    evidenceRef: 'evidence:freeze',
    reasonCode: 'CG4_READER_BROKEN',
  });

  // ฝั่ง downstream consumer (owner อื่น): quarantine, scope pause และ ack ที่ล้ม
  const policyEvent = await owner.cgEventOutbox.findFirstOrThrow({
    where: { tenantId: tenant, eventType: 'policy.changed' },
    orderBy: { createdAt: 'asc' },
  });
  await owner.cgConsumerInbox.create({
    data: {
      tenantId: tenant,
      consumerGroup: 'journey-governance-cg4',
      eventId: randomUUID(),
      aggregateType: policyEvent.aggregateType,
      aggregateId: policyEvent.aggregateId,
      aggregateVersion: policyEvent.aggregateVersion,
      eventType: policyEvent.eventType,
      payloadHash: 'd'.repeat(64),
      state: 'QUARANTINED',
      detail: 'HASH_CONFLICT',
      receivedAt: clock,
    },
  });
  await owner.cgScopePause.create({
    data: {
      tenantId: tenant,
      consumerGroup: 'journey-governance-cg4',
      scopeKind: 'POLICY_SCOPE',
      scopeRef: LINE_MARKETING,
      reason: 'HASH_CONFLICT',
      pausedAt: new Date(clock.getTime() - 30 * 60_000),
    },
  });
  await owner.cgConsumerAcknowledgement.createMany({
    data: [
      {
        tenantId: tenant,
        eventId: randomUUID(),
        consumer: 'dialer-governance-cg4',
        aggregateType: policyEvent.aggregateType,
        aggregateId: policyEvent.aggregateId,
        appliedVersion: policyEvent.aggregateVersion,
        outcome: 'FAILED',
        payloadHash: 'e'.repeat(64),
        appliedAt: clock,
      },
      {
        tenantId: tenant,
        eventId: randomUUID(),
        consumer: 'journey-governance-cg4',
        aggregateType: policyEvent.aggregateType,
        aggregateId: policyEvent.aggregateId,
        appliedVersion: policyEvent.aggregateVersion,
        outcome: 'APPLIED',
        affectedCount: 2,
        payloadHash: 'f'.repeat(64),
        appliedStateDigest: '1'.repeat(64),
        appliedAt: clock,
      },
    ],
  });

  return { owner, application, tenant, contact, decision, policyEvent, now };
}

test('CG4-OB01: snapshot/metrics/alerts จาก canonical state ครอบ quorum age, activation lag, kill, DLQ, ack และ migration mismatch', async (t) => {
  const f = await observedTenant(t);
  const snapshot = await cg4ObservabilitySnapshot(f.application, {
    tenantId: f.tenant,
    now: f.now(),
    cache: { canonicalFallback: 1 },
  });

  assert.equal(snapshot.rollout.stage, 'SHADOW_EVALUATION');
  assert.equal(snapshot.rollout.mutationFrozen, true);
  assert.equal(snapshot.rollout.shadowMismatchesInWindow, 1);
  assert.equal(snapshot.quorum.policiesInReview, 1);
  assert.equal(snapshot.quorum.oldestPolicyInReviewAgeSeconds, 7_200);
  assert.equal(snapshot.activation.dueBacklog, 1);
  assert.equal(snapshot.activation.oldestDueLagSeconds, 3_600);
  assert.equal(snapshot.killSwitches.active, 1);
  assert.equal(snapshot.consumers.quarantined, 1);
  assert.equal(snapshot.consumers.activeScopePauses, 1);
  assert.equal(snapshot.consumers.oldestActivePauseAgeSeconds, 1_800);
  assert.equal(snapshot.acknowledgements.failed, 1);
  assert.ok(snapshot.events.pendingOutbox >= 2);

  const codes = evaluateCg4Alerts(snapshot).map((alert) => alert.code);
  for (const code of [
    'GOVERNANCE_ACTIVATION_LAG',
    'GOVERNANCE_KILL_SWITCH_ACTIVE',
    'GOVERNANCE_MIGRATION_MISMATCH',
    'GOVERNANCE_MUTATION_FROZEN',
    'GOVERNANCE_CONSUMER_GAP_OR_DLQ',
    'GOVERNANCE_SCOPE_PAUSE_AGE',
    'GOVERNANCE_ACK_FAILED',
    'GOVERNANCE_OUTBOX_LAG',
  ]) {
    assert.ok(codes.includes(code as never), code);
  }
  assert.ok(
    cg4MetricSamples(snapshot).some(
      (sample) => sample.name === 'cg4_policy_activation_lag_seconds' && sample.value === 3_600,
    ),
  );

  // ack query แบบ additive: เห็นเฉพาะ tenant ตัวเอง และคืน applied state digest
  const acks = await cg4DownstreamAcknowledgements(
    f.application,
    { tenantId: f.tenant, level: 'SUMMARY' },
    {
      aggregateType: f.policyEvent.aggregateType as 'POLICY',
      aggregateId: f.policyEvent.aggregateId,
    },
  );
  assert.deepEqual(acks.map((ack) => [ack.consumer, ack.outcome]).sort(), [
    ['dialer-governance-cg4', 'FAILED'],
    ['journey-governance-cg4', 'APPLIED'],
  ]);
  assert.equal(acks.find((ack) => ack.outcome === 'APPLIED')?.appliedStateDigest, '1'.repeat(64));
  const crossTenant = await cg4DownstreamAcknowledgements(
    f.application,
    { tenantId: randomUUID(), level: 'SUMMARY' },
    {
      aggregateType: f.policyEvent.aggregateType as 'POLICY',
      aggregateId: f.policyEvent.aggregateId,
    },
  );
  assert.deepEqual(crossTenant, []);
});

test('CG4-OB02: negative scan ของ event/decision trace/shadow evidence/metric/alert/ack ไม่พบ PII, actor, free-text evidence หรือ credential', async (t) => {
  const f = await observedTenant(t);
  const snapshot = await cg4ObservabilitySnapshot(f.application, {
    tenantId: f.tenant,
    now: f.now(),
  });
  const [outbox, decisions, mismatches, acks] = await Promise.all([
    f.owner.cgEventOutbox.findMany({
      where: { tenantId: f.tenant },
      select: { eventType: true, orderingKey: true, payload: true },
    }),
    f.owner.cgDecisionLog.findMany({
      where: { tenantId: f.tenant },
      select: {
        trace: true,
        cg4: true,
        reasonCode: true,
        matchedScope: true,
        matchedWindowRef: true,
        exceptionRef: true,
      },
    }),
    f.owner.cg4ShadowMismatch.findMany({ where: { tenantId: f.tenant } }),
    cg4DownstreamAcknowledgements(
      f.application,
      { tenantId: f.tenant, level: 'SUMMARY' },
      {
        aggregateType: f.policyEvent.aggregateType as 'POLICY',
        aggregateId: f.policyEvent.aggregateId,
      },
    ),
  ]);
  assert.ok(outbox.length >= 2, 'ต้องมี event จาก owner path จริงให้ scan');
  assert.equal(decisions.length, 1);
  assert.equal(mismatches.length, 1);

  const surfaces = {
    events: outbox,
    decisionTraces: decisions,
    shadowEvidence: mismatches,
    metrics: cg4MetricSamples(snapshot),
    alerts: evaluateCg4Alerts(snapshot),
    snapshot,
    acknowledgements: acks,
  };
  const forbidden = [
    IDENTITY_VALUE,
    DISPLAY_NAME,
    FREE_TEXT_EVIDENCE,
    SOURCE_ID,
    MAKER,
    CHECKER,
    'publisher-cg411',
    'operator-kill-cg411',
  ];
  const patterns = [
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    /(?:\+?66|0)\d{8,9}\b/,
    /(?:postgres(?:ql)?|redis|https?):\/\/[^:\s/@]+:[^@\s/]+@/i,
  ];
  for (const [surface, value] of Object.entries(surfaces)) {
    const serialized = JSON.stringify(value);
    for (const needle of forbidden) {
      assert.equal(serialized.includes(needle), false, `${surface} มี ${needle}`);
    }
    for (const pattern of patterns) {
      assert.equal(pattern.test(serialized), false, `${surface} match ${pattern}`);
    }
  }
  // metric/alert/snapshot ห้ามมี customer identifier แม้เป็น opaque UUID (high cardinality label)
  for (const surface of ['metrics', 'alerts', 'snapshot'] as const) {
    assert.equal(JSON.stringify(surfaces[surface]).includes(f.contact), false, surface);
  }
});
