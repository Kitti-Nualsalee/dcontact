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
 * CG4.11 (#194): `CG4-OB01` metrics/alerts and the `CG4-OB02` negative scan on a real Postgres through the
 * application role, creating state from the real owner paths (backfill, lifecycle, rollout, authorize)
 * and simulating only the downstream consumer side (inbox/pause/ack) that belongs to another owner
 */

/**
 * T0 must always be later than real time, not a date near when the test was written
 *
 * most state is backdated directly from T0 (quorum 7200s, activation 3600s, pause 1800s) but the rows
 * in cgEventOutbox are created by the real owner path, so createdAt is the database clock, not T0
 * oldestPendingOutboxAgeSeconds is T0 minus createdAt: once real time passes T0, this value goes negative and
 * GOVERNANCE_OUTBOX_LAG never fires again
 *
 * It was originally set to 2026-09-15T05:00Z, which blew up exactly at 05:00Z that day, making CG4-OB01 fail on every run
 * ever since (at first it looked flaky because runs before that time still passed)
 */
const T0 = new Date('2099-09-15T05:00:00.000Z'); // 12:00 Asia/Bangkok
const LINE_MARKETING = buildCg4PolicyScopeKey({ channel: 'LINE', purpose: 'MARKETING' });
const VOICE_SERVICE = buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'SERVICE' });
const NIGHT = { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' };
const ZONE = 'Asia/Bangkok';
/** values that must not leak into an event/decision trace/metric/alert/ack view */
const IDENTITY_VALUE = 'line-user-synthetic-0812345678';
const DISPLAY_NAME = 'Synthetic Customer Name';
const FREE_TEXT_EVIDENCE = 'synthetic checker free-text evidence';
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

  // backfill -> scheduled tightening on LINE (real event) -> a policy waiting for quorum on VOICE
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

  // the worker does not activate on time -> shadow sees CG4 fail closed while CG3 allows
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

  // the downstream consumer side (another owner): quarantine, scope pause and a failing ack
  const policyEvent = await owner.cgEventOutbox.findFirstOrThrow({
    where: { tenantId: tenant, eventType: 'policy.changed' },
    orderBy: { createdAt: 'asc' },
  });
  // cg_event_outbox.created_at is Postgres's own @default(now()): it is not tied to this fixture's fake clock
  // at all, so it must be backdated manually so the age is compared against a fixed T0, otherwise GOVERNANCE_OUTBOX_LAG
  // would be flaky depending on the real day the test runs (the age would become a negative value clamped to 0 once real time passes T0)
  await owner.cgEventOutbox.updateMany({
    where: { tenantId: tenant, publishedAt: null },
    data: { createdAt: new Date(T0.getTime() - 600_000) },
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

test('CG4-OB01: snapshot/metrics/alerts from canonical state cover quorum age, activation lag, kill, DLQ, ack and migration mismatch', async (t) => {
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

  // an additive ack query: sees only its own tenant, and returns the applied state digest
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

test('CG4-OB02: a negative scan of event/decision trace/shadow evidence/metric/alert/ack finds no PII, actor, free-text evidence or credential', async (t) => {
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
  assert.ok(outbox.length >= 2, 'there must be events from the real owner path to scan');
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
    // A Thai phone number starts with 0/+66 followed by an area/network code 2-9: the original pattern (\d{8,9} with no \b
    // in front) matched coincidentally adjacent digits in the middle of a random UUID that is serialized into every surface too
    // (measured at ~1 in 410 UUIDs), so the test went red occasionally with no real PII leak. This pattern still catches both mobile
    // and landline numbers, but matched no UUID at all in 2,000,000 samples
    /\b(?:\+?66|0)[2-9]\d{7,8}\b/,
    /(?:postgres(?:ql)?|redis|https?):\/\/[^:\s/@]+:[^@\s/]+@/i,
  ];
  for (const [surface, value] of Object.entries(surfaces)) {
    const serialized = JSON.stringify(value);
    for (const needle of forbidden) {
      assert.equal(serialized.includes(needle), false, `${surface} contains ${needle}`);
    }
    for (const pattern of patterns) {
      assert.equal(pattern.test(serialized), false, `${surface} match ${pattern}`);
    }
  }
  // a metric/alert/snapshot must not carry a customer identifier even as an opaque UUID (high cardinality label)
  for (const surface of ['metrics', 'alerts', 'snapshot'] as const) {
    assert.equal(JSON.stringify(surfaces[surface]).includes(f.contact), false, surface);
  }
});
