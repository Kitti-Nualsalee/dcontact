import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  cg4SubjectId,
  tenantId as tenantIdBrand,
  type Cg4AuthorizationSubject,
  type Cg4Capability,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceService } from './contact-governance-service.js';
import { Cg4ApprovalRepository } from './cg4-approval-repository.js';
import { Cg4LegacyBackfill } from './cg4-legacy-backfill.js';
import { buildCg4PolicyScopeKey } from './cg4-policy-compiler.js';
import type { Cg4PolicyFixturePack } from './cg4-policy-fixtures.js';
import { Cg4PolicyLifecycleRepository } from './cg4-policy-lifecycle.js';
import {
  Cg4RolloutError,
  Cg4RolloutRepository,
  GOVERNANCE_MUTATION_FROZEN,
  GOVERNANCE_SHADOW_MISMATCH,
  type Cg4RolloutStage,
} from './cg4-rollout.js';

/**
 * CG4.10 (#193) PR-B: `CG4-MG02` ส่วน shadow → seed compatibility → switch → enforce และ
 * forward-fix drill บน Postgres จริงผ่าน application role (RLS + grant + trigger)
 *
 * เวลาเริ่ม 12:00 Asia/Bangkok: CG3 (quiet hours 21:00–08:00) อนุญาต แต่ policy version 2 ของ CG4
 * เพิ่ม quiet window 11:00–14:00 ทำให้ผลของสอง reader ต่างกันโดยตั้งใจ
 */

const T0 = new Date('2026-09-15T05:00:00.000Z');
const LINE_MARKETING = buildCg4PolicyScopeKey({ channel: 'LINE', purpose: 'MARKETING' });
const VOICE_SERVICE = buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'SERVICE' });
const NIGHT = { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' };
const PINNED_ZONE = 'Asia/Bangkok';

const TENANT_PACK: Cg4PolicyFixturePack = {
  packId: 'TENANT_SYNTHETIC',
  suiteVersion: 'TENANT_SYNTHETIC_V1',
  checks: [
    {
      id: 'tenant:quiet-hours-local-clock',
      kind: 'QUIET_HOURS_FOLLOW_LOCAL_CLOCK',
      timezone: PINNED_ZONE,
      fromInstant: '2026-09-14T00:00:00.000Z',
      probeHours: 24,
      stepMinutes: 60,
    },
  ],
};

function contentWith(extraWindow?: { startLocal: string; endLocal: string }) {
  return {
    timezoneFallback: PINNED_ZONE,
    quietHours: [
      NIGHT,
      ...(extraWindow ? [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], ...extraWindow }] : []),
    ],
    callbackMode: 'SCOPED_OVERRIDE',
    overridableRules: [],
    allowedOperationalRuleCodes: [],
    holidays: [],
  };
}

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
  const tenant = randomUUID();
  const contact = randomUUID();
  const identity = randomUUID();
  let clock = T0;
  const now = () => clock;

  t.after(async () => {
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
    await owner.cgCallbackRequest.deleteMany({ where: { tenantId: tenant } });
    await owner.cgHolidayCalendarEntry.deleteMany({ where: { tenantId: tenant } });
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
      name: `CG4.10B ${tenant}`,
      slug: `cg410b-${tenant}`,
      sipDomain: `${tenant}.cg410b.test`,
    },
  });
  await owner.contact.create({ data: { id: contact, tenantId: tenant, displayName: 'CG4.10B' } });
  await owner.contactIdentity.create({
    data: {
      id: identity,
      tenantId: tenant,
      contactId: contact,
      type: 'LINE',
      value: `line-${tenant.slice(0, 8)}`,
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
      evidence: { source: 'cg4-10-synthetic' },
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
      timezoneFallback: PINNED_ZONE,
      quietHours: [NIGHT] as unknown as Prisma.InputJsonValue,
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: [] as unknown as Prisma.InputJsonValue,
      status: 'PUBLISHED',
      contentDigest: 'a'.repeat(64),
      makerActorRef: 'legacy-maker-synthetic',
      checkerActorRef: 'legacy-checker-synthetic',
      approvalRef: 'legacy-approval-synthetic',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });

  const subject = (id: string, capabilities: Cg4Capability[]): Cg4AuthorizationSubject => ({
    subjectId: cg4SubjectId(id),
    tenantId: tenantIdBrand('00000000-0000-0000-0000-000000000000'),
    authenticationStrength: 'STANDARD',
    capabilities: capabilities.map((capability) => ({
      capability,
      scopeKey: LINE_MARKETING,
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
    evidenceRef: 'evidence:cg410b',
    occurredAt: clock.toISOString(),
    idempotencyKey: randomUUID(),
  });

  /** draft → test → submit → approve → publish บน series ของ legacy policy ที่ backfill ไว้ */
  const publishVersion = async (options: {
    window: { startLocal: string; endLocal: string };
    activateAt?: Date;
  }) => {
    const legacy = await owner.cg4Policy.findFirstOrThrow({
      where: { tenantId: tenant, origin: 'LEGACY_CG3' },
    });
    const maker = subject('maker-cg410b', ['cg.policy.draft']);
    const draft = await lifecycle.createDraft({
      tenantId: tenant,
      policyId: legacy.policyId,
      scopeKey: LINE_MARKETING,
      content: contentWith(options.window),
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
      pinnedTimezone: PINNED_ZONE,
      ...command(maker),
    });
    assert.equal(tested.preview.tests.outcome, 'PASS');
    assert.equal(tested.preview.diffClass, 'TIGHTENING');
    await lifecycle.submit({
      tenantId: tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedDraftRevision: draft.draftRevision,
      expectedContentDigest: draft.contentDigest,
      expectedTestArtifactDigest: tested.preview.artifactDigest,
      ...command(maker),
    });
    await approvals.recordPolicyApproval({
      tenantId: tenant,
      policyId: draft.policyId,
      expectedVersion: draft.version,
      expectedContentDigest: draft.contentDigest,
      diffClass: tested.preview.diffClass,
      decision: 'APPROVE',
      evidenceRef: 'evidence:approval',
      makerSubjectId: 'maker-cg410b',
      scopeKey: LINE_MARKETING,
      checker: subject('checker-cg410b', ['cg.policy.publish']),
      idempotencyKey: randomUUID(),
    });
    const head = await lifecycle.preview({
      tenantId: tenant,
      policyId: draft.policyId,
      version: draft.version,
      expectedContentDigest: draft.contentDigest,
      tenantPack: TENANT_PACK,
      pinnedEvaluationTime: '2026-09-14T00:00:00.000Z',
      pinnedTimezone: PINNED_ZONE,
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
      activateAt: (options.activateAt ?? clock).toISOString(),
      ...command(subject('finalizer-cg410b', ['cg.policy.draft'])),
    });
    const row = await owner.cg4Policy.findFirstOrThrow({
      where: { tenantId: tenant, policyId: draft.policyId, version: draft.version },
    });
    return () =>
      lifecycle.publish({
        tenantId: tenant,
        policyId: draft.policyId,
        version: draft.version,
        expectedContentDigest: draft.contentDigest,
        expectedTestArtifactDigest: tested.preview.artifactDigest,
        expectedApprovalDigest: row.approvalDigest as string,
        expectedScopeHeadVersion: head.baseHeadVersion,
        expectedScopeHeadDigest: head.baseHeadDigest,
        ...command(subject('publisher-cg410b', ['cg.policy.publish'])),
      });
  };

  let actions = 0;
  const authorize = () =>
    service.authorizeAndReserve(tenant, {
      contactId: contact,
      identityId: identity,
      channel: 'LINE',
      purpose: 'MARKETING',
      source: 'JOURNEY',
      sourceId: 'journey-cg410b',
      actionKey: `cg410b:${tenant}:${++actions}`,
      policyVersion: 1,
    } as never);

  const move = async (toStage: Cg4RolloutStage, syntheticScopeKeys?: string[]) => {
    const current = await rollout.current(tenant);
    return rollout.transition({
      tenantId: tenant,
      expectedVersion: current.version,
      toStage,
      ...(syntheticScopeKeys ? { syntheticScopeKeys } : {}),
      actorRef: 'operator-cg410b',
      evidenceRef: 'evidence:rollout',
      reasonCode: 'CG4_10_DRILL',
    });
  };

  const backfill = () =>
    new Cg4LegacyBackfill(application, { now }).run({
      tenantId: tenant,
      operatorRef: 'operator-cg410b',
    });

  return {
    owner,
    application,
    tenant,
    contact,
    rollout,
    lifecycle,
    subject,
    publishVersion,
    authorize,
    move,
    backfill,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    now,
  };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof Cg4RolloutError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

test('CG4-MG02 DISABLED: CG3 ยังเป็น reader แม้ CG4 writer publish policy ที่เข้มกว่าแบบ dark', async (t) => {
  const f = await fixture(t);
  await f.backfill();
  await (
    await f.publishVersion({ window: { startLocal: '11:00', endLocal: '14:00' } })
  )();

  const decision = await f.authorize();
  assert.equal(decision.decision, 'ALLOW');
  assert.equal(decision.cg4, undefined);
  assert.equal((await f.rollout.current(f.tenant)).version, 0);
  assert.equal(await f.owner.cg4ShadowMismatch.count({ where: { tenantId: f.tenant } }), 0);
});

test('CG4-MG02 shadow → switch: mismatch PII-safe, pilot fail closed, window ใหม่ก่อน switch แล้วอ่าน head ของ CG4', async (t) => {
  const f = await fixture(t);
  await rejectsWith(f.move('SHADOW_EVALUATION', [LINE_MARKETING]), 'ROLLOUT_BACKFILL_REQUIRED');
  await f.backfill();
  await (
    await f.publishVersion({ window: { startLocal: '11:00', endLocal: '14:00' } })
  )();

  // shadow นอก pilot: CG3 ยังตัดสิน แต่หลักฐาน mismatch ถูกบันทึก
  await f.move('SHADOW_EVALUATION', [VOICE_SERVICE]);
  const outside = await f.authorize();
  assert.equal(outside.decision, 'ALLOW');
  const [mismatch] = await f.owner.cg4ShadowMismatch.findMany({ where: { tenantId: f.tenant } });
  assert.ok(mismatch);
  assert.equal(mismatch.pilot, false);
  assert.equal(mismatch.cg4Outcome, 'RESOLVED');
  assert.equal(mismatch.decisionId, outside.decisionId);
  assert.notEqual(mismatch.cg3Digest, mismatch.cg4Digest);
  // PII-safe: ไม่มี contact/identity/sourceId ใดอยู่ในแถวหลักฐาน
  const serialized = JSON.stringify(mismatch);
  assert.equal(serialized.includes(f.contact), false);
  assert.equal(serialized.includes('journey-cg410b'), false);

  // pre-mutation disable path: ถอยกลับ DISABLED แล้วเริ่ม shadow บน pilot scope จริง
  await f.move('DISABLED');
  f.advance(60_000);
  await f.move('SHADOW_EVALUATION', [LINE_MARKETING]);
  const pilot = await f.authorize();
  assert.equal(pilot.decision, 'REVIEW');
  assert.equal(pilot.reasonCode, GOVERNANCE_SHADOW_MISMATCH);
  assert.equal(pilot.reservationId, undefined);
  assert.equal(pilot.trace.at(-1)?.gate, 'MIGRATION_SHADOW');

  // mismatch ห้ามถูก ignore: switch ไม่ได้จนกว่าจะเริ่ม shadow window ที่สะอาด
  await rejectsWith(f.move('SCOPED_SYNTHETIC'), 'ROLLOUT_SHADOW_MISMATCH_UNRESOLVED');
  await f.move('DISABLED');
  f.advance(60_000);
  await f.move('SHADOW_EVALUATION', [LINE_MARKETING]);
  const switched = await f.move('SCOPED_SYNTHETIC');
  assert.equal(switched.stage, 'SCOPED_SYNTHETIC');
  assert.ok(switched.switchedAt);

  const governed = await f.authorize();
  assert.equal(governed.decision, 'DEFER');
  assert.equal(governed.reasonCode, 'QUIET_HOURS');
  assert.equal(governed.cg4?.policy.policyVersion, 2);
  assert.equal(
    governed.trace.some((entry) => entry.gate === 'MIGRATION_SHADOW'),
    false,
  );

  const history = await f.owner.cg4RolloutTransition.findMany({
    where: { tenantId: f.tenant },
    orderBy: { toVersion: 'asc' },
  });
  assert.deepEqual(
    history.map((row) => row.toStage),
    [
      'SHADOW_EVALUATION',
      'DISABLED',
      'SHADOW_EVALUATION',
      'DISABLED',
      'SHADOW_EVALUATION',
      'SCOPED_SYNTHETIC',
    ],
  );
});

test('CG4-MG02 seed compatibility: callback ที่อ้าง exception ที่ไม่ใช่ canonical บล็อก switch', async (t) => {
  const f = await fixture(t);
  await f.backfill();
  await f.move('SHADOW_EVALUATION', [LINE_MARKETING]);
  await f.owner.cgCallbackRequest.create({
    data: {
      tenantId: f.tenant,
      seriesId: randomUUID(),
      version: 1,
      contactId: f.contact,
      channel: 'LINE',
      purpose: 'MARKETING',
      requestedAt: T0,
      requestedTimezone: PINNED_ZONE,
      expiresAt: new Date(T0.getTime() + 86_400_000),
      sourceKind: 'CUSTOMER',
      oneUseTokenHash: 'b'.repeat(64),
      approvedExceptionId: randomUUID(),
      mutationKind: 'REQUEST',
      evidenceRef: 'callback-evidence-synthetic',
      requestHash: 'c'.repeat(64),
      actorClass: 'CUSTOMER',
    },
  });
  await rejectsWith(f.move('SCOPED_SYNTHETIC'), 'ROLLOUT_CALLBACK_REF_NONCANONICAL');
  assert.equal((await f.rollout.current(f.tenant)).stage, 'SHADOW_EVALUATION');
});

test('CG4-MG02 enforce: หลัง switch ย้อน reader ไม่ได้ทั้งที่ application และ DB, และ CG3 writer ปิด', async (t) => {
  const f = await fixture(t);
  await f.backfill();
  await f.move('SHADOW_EVALUATION', [LINE_MARKETING]);
  await f.move('SCOPED_SYNTHETIC');

  await rejectsWith(f.move('SHADOW_EVALUATION', [LINE_MARKETING]), 'ROLLOUT_SWITCH_IRREVERSIBLE');
  await assert.rejects(
    f.owner.$executeRawUnsafe(
      `UPDATE cg4_rollout_state SET stage = 'SHADOW_EVALUATION', switched_at = switched_at, version = version + 1 WHERE tenant_id = '${f.tenant}'`,
    ),
    /cannot return below SCOPED_SYNTHETIC|cg4_rollout_state_switch_check/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenant, (transaction) =>
      transaction.cgPolicy.updateMany({
        where: { tenantId: f.tenant },
        data: { approvalRef: 'bypass' },
      }),
    ),
    /legacy cg_policies writer is closed/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.application, f.tenant, (transaction) =>
      transaction.cg4RolloutTransition.deleteMany({ where: { tenantId: f.tenant } }),
    ),
    /permission denied/,
  );

  const enabled = await f.move('INTERNAL_ENABLED');
  assert.equal(enabled.stage, 'INTERNAL_ENABLED');
  const back = await f.move('SCOPED_SYNTHETIC');
  assert.equal(back.stage, 'SCOPED_SYNTHETIC');
  assert.equal(back.switchedAt?.getTime(), enabled.switchedAt?.getTime());
});

test('CG4-RC01 migration switch boundary: fault ก่อน commit ไม่ทิ้ง state หรือประวัติครึ่งทาง', async (t) => {
  const f = await fixture(t);
  await f.backfill();
  const faulty = new Cg4RolloutRepository(f.application, {
    now: f.now,
    beforeCommit: () => {
      throw new Error('fault injected before commit');
    },
  });
  await assert.rejects(
    faulty.transition({
      tenantId: f.tenant,
      expectedVersion: 0,
      toStage: 'SHADOW_EVALUATION',
      syntheticScopeKeys: [LINE_MARKETING],
      actorRef: 'operator-cg410b',
      evidenceRef: 'evidence:fault',
      reasonCode: 'CG4_10_FAULT',
    }),
    /fault injected before commit/,
  );
  assert.equal((await f.rollout.current(f.tenant)).version, 0);
  assert.equal(await f.owner.cg4RolloutTransition.count({ where: { tenantId: f.tenant } }), 0);

  // retry หลัง restart ด้วย expected version เดิมสำเร็จครั้งเดียว และ version เก่าชน CAS
  const retried = await f.move('SHADOW_EVALUATION', [LINE_MARKETING]);
  assert.equal(retried.version, 1);
  await rejectsWith(
    f.rollout.transition({
      tenantId: f.tenant,
      expectedVersion: 0,
      toStage: 'DISABLED',
      actorRef: 'operator-cg410b',
      evidenceRef: 'evidence:stale',
      reasonCode: 'CG4_10_STALE',
    }),
    'ROLLOUT_VERSION_CONFLICT',
  );
});

test('CG4-MG02 forward-fix drill: reader เสียหลัง CG4 mutation → freeze/kill/reconcile/forward-fix โดยไม่ down-migrate', async (t) => {
  const f = await fixture(t);
  await f.backfill();
  await f.move('SHADOW_EVALUATION', [LINE_MARKETING]);
  await f.move('SCOPED_SYNTHETIC');

  // CG4 mutation หลัง switch: scheduled tightening ที่ activate ในอีก 1 ชั่วโมง
  const scheduled = await (
    await f.publishVersion({
      window: { startLocal: '11:00', endLocal: '14:00' },
      activateAt: new Date(T0.getTime() + 3_600_000),
    })
  )();
  assert.equal(scheduled.lifecycleState, 'SCHEDULED');

  // activation worker ล้ม: schedule ถึงเวลาแต่ไม่ activate → reader ต้อง fail closed ไม่ใช่อ่าน v1 ต่อ
  f.advance(2 * 3_600_000); // 14:00 Asia/Bangkok
  const broken = await f.authorize();
  assert.equal(broken.decision, 'REVIEW');
  assert.equal(broken.reasonCode, 'POLICY_ACTIVATION_PENDING');
  assert.equal(broken.reservationId, undefined);
  assert.equal(broken.trace.at(-1)?.gate, 'POLICY_HEAD');

  // ห้ามย้อนกลับไปอ่าน CG3
  await rejectsWith(f.move('SHADOW_EVALUATION', [LINE_MARKETING]), 'ROLLOUT_SWITCH_IRREVERSIBLE');

  // freeze mutation ระหว่าง reconcile: publish ถูกหยุด แต่ kill switch (เข้มขึ้นเท่านั้น) ยังเปิดได้
  const frozen = await f.rollout.setFrozen({
    tenantId: f.tenant,
    expectedVersion: (await f.rollout.current(f.tenant)).version,
    frozen: true,
    actorRef: 'operator-cg410b',
    evidenceRef: 'evidence:freeze',
    reasonCode: 'CG4_READER_BROKEN',
  });
  assert.equal(frozen.mutationFrozen, true);
  const forwardFix = await f.publishVersion({ window: { startLocal: '13:30', endLocal: '15:00' } });
  await rejectsWith(forwardFix(), GOVERNANCE_MUTATION_FROZEN);

  const killed = await f.lifecycle.killSwitch({
    tenantId: f.tenant,
    scopeKey: LINE_MARKETING,
    action: 'ACTIVATE',
    reasonCode: 'CG4_READER_BROKEN',
    actor: f.subject('operator-kill', ['cg.policy.publish']),
    evidenceRef: 'evidence:kill',
    occurredAt: f.now().toISOString(),
    idempotencyKey: randomUUID(),
  });
  assert.equal(killed.state, 'ACTIVE');
  const held = await f.authorize();
  assert.equal(held.decision, 'REVIEW');
  assert.equal(held.trace.at(-1)?.gate, 'KILL_SWITCH');

  // canonical reconcile + forward-fix: unfreeze แล้ว publish version ใหม่ทันที (ไม่ใช่ pointer flip)
  await f.rollout.setFrozen({
    tenantId: f.tenant,
    expectedVersion: frozen.version,
    frozen: false,
    actorRef: 'operator-cg410b',
    evidenceRef: 'evidence:unfreeze',
    reasonCode: 'CG4_FORWARD_FIX',
  });
  const fixed = await forwardFix();
  assert.equal(fixed.lifecycleState, 'ACTIVE');
  assert.equal(fixed.version, 3);

  await f.lifecycle.killSwitch({
    tenantId: f.tenant,
    scopeKey: LINE_MARKETING,
    action: 'CLEAR',
    reasonCode: 'CG4_FORWARD_FIX',
    clearApprovalRef: 'approval:clear-kill',
    actor: f.subject('operator-clear', ['cg.policy.publish.relaxation']),
    evidenceRef: 'evidence:clear',
    occurredAt: f.now().toISOString(),
    idempotencyKey: randomUUID(),
  });

  const recovered = await f.authorize();
  assert.equal(recovered.decision, 'DEFER');
  assert.equal(recovered.reasonCode, 'QUIET_HOURS');
  assert.equal(recovered.cg4?.policy.policyVersion, 3);

  // ไม่มี history drop: legacy v1, scheduled v2 และ forward-fix v3 ยังอยู่ครบ; CG3 row ไม่ถูกแก้
  const versions = await f.owner.cg4Policy.findMany({
    where: { tenantId: f.tenant },
    orderBy: { version: 'asc' },
    select: { version: true, origin: true },
  });
  assert.deepEqual(
    versions.map((row) => [row.version, row.origin]),
    [
      [1, 'LEGACY_CG3'],
      [2, 'CG4'],
      [3, 'CG4'],
    ],
  );
  assert.equal(
    await f.owner.cgPolicy.count({ where: { tenantId: f.tenant, status: 'PUBLISHED' } }),
    1,
  );
  const rolledBack = await f.owner.$queryRawUnsafe<Array<{ count: bigint }>>(
    `SELECT count(*) AS count FROM "_prisma_migrations" WHERE rolled_back_at IS NOT NULL AND migration_name LIKE '%cg4%'`,
  );
  assert.equal(Number(rolledBack[0]!.count), 0);
});
