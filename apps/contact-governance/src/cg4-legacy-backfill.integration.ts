import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import { Cg4LegacyBackfill, CG4_BACKFILL_KILL_REASONS } from './cg4-legacy-backfill.js';
import { compileCg4Policy } from './cg4-policy-compiler.js';

/**
 * CG4.10 (#193) PR-A: backfill CG3 → CG4 ผ่าน application role (RLS) บน Postgres จริง
 * ครอบ `CG4-MG02` ส่วน backfill/reconcile ambiguity/seed compatibility
 */

const NOW = new Date('2026-09-14T00:00:00.000Z');
const DIGEST = 'a'.repeat(64);
const LINE_MARKETING = 'channel=LINE|contactKind=*|purpose=MARKETING|sourceType=*';
const QUIET_HOURS = [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }];

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
  await owner.tenant.create({
    data: {
      id: tenant,
      name: `CG4.10 ${tenant}`,
      slug: `cg410-${tenant}`,
      sipDomain: `${tenant}.cg410.test`,
    },
  });
  await owner.contact.create({ data: { id: contact, tenantId: tenant, displayName: 'CG4.10' } });

  t.after(async () => {
    await owner.cg4BackfillLedger.deleteMany({ where: { tenantId: tenant } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyApproval.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4PolicyScopeHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Policy.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ScopeKillSwitch.deleteMany({ where: { tenantId: tenant } });
    await owner.cgCallbackRequest.deleteMany({ where: { tenantId: tenant } });
    await owner.cgHolidayCalendarEntry.deleteMany({ where: { tenantId: tenant } });
    await owner.cgPolicy.deleteMany({ where: { tenantId: tenant } });
    await owner.contact.deleteMany({ where: { tenantId: tenant } });
    await owner.tenant.deleteMany({ where: { id: tenant } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const backfill = () =>
    new Cg4LegacyBackfill(application, { now: () => NOW }).run({
      tenantId: tenant,
      operatorRef: 'operator-synthetic-1',
    });
  return { owner, application, tenant, contact, backfill };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function cg3Policy(f: Fixture, overrides: Partial<Prisma.CgPolicyUncheckedCreateInput> = {}) {
  return f.owner.cgPolicy.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenant,
      policyId: randomUUID(),
      version: 1,
      purpose: 'MARKETING',
      channel: 'LINE',
      timezoneFallback: 'Asia/Bangkok',
      quietHours: QUIET_HOURS as unknown as Prisma.InputJsonValue,
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: [] as unknown as Prisma.InputJsonValue,
      status: 'PUBLISHED',
      contentDigest: DIGEST,
      makerActorRef: 'legacy-maker-synthetic',
      checkerActorRef: 'legacy-checker-synthetic',
      approvalRef: 'legacy-approval-synthetic',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    },
  });
}

const countsFor = async (f: Fixture) => ({
  policies: await f.owner.cg4Policy.count({ where: { tenantId: f.tenant } }),
  heads: await f.owner.cg4PolicyScopeHead.count({ where: { tenantId: f.tenant } }),
  approvals: await f.owner.cg4PolicyApproval.count({ where: { tenantId: f.tenant } }),
  kills: await f.owner.cg4ScopeKillSwitch.count({ where: { tenantId: f.tenant } }),
  events: await f.owner.cgEventOutbox.count({ where: { tenantId: f.tenant } }),
  ledger: await f.owner.cg4BackfillLedger.count({ where: { tenantId: f.tenant } }),
});

test('CG4-MG02: CG3 PUBLISHED ที่มีผลเป็น LEGACY_ACTIVE head พร้อม approval LEGACY_MIGRATED และ rerun ไม่มี effect ซ้ำ', async (t) => {
  const f = await fixture(t);
  const policyId = randomUUID();
  await cg3Policy(f, { policyId, version: 1, status: 'SUPERSEDED' });
  const current = await cg3Policy(f, { policyId, version: 2 });
  await f.owner.cgHolidayCalendarEntry.create({
    data: {
      tenantId: f.tenant,
      policyId,
      policyVersion: 2,
      localDate: new Date('2026-12-31T00:00:00.000Z'),
      effect: 'CLOSED',
      entryDigest: DIGEST,
    },
  });

  const report = await f.backfill();
  assert.equal(report.legacyActive.length, 1);
  assert.deepEqual(report.killedScopes, []);
  const mapped = report.legacyActive[0]!;
  assert.equal(mapped.scopeKey, LINE_MARKETING);
  assert.equal(mapped.version, 2);

  const row = await f.owner.cg4Policy.findUniqueOrThrow({ where: { id: mapped.policyRowId } });
  assert.equal(row.origin, 'LEGACY_CG3');
  assert.equal(row.legacySourceRowId, current.id);
  assert.equal(row.status, 'ACTIVE');
  const expected = compileCg4Policy({
    content: {
      timezoneFallback: 'Asia/Bangkok',
      quietHours: QUIET_HOURS,
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: [],
      allowedOperationalRuleCodes: [],
      holidays: [{ localDate: '2026-12-31', effect: 'CLOSED', windows: [] }],
    },
    version: 2,
  });
  assert.equal(row.contentDigest, expected.contentDigest);

  const head = await f.owner.cg4PolicyScopeHead.findUniqueOrThrow({
    where: { tenantId_scopeKey: { tenantId: f.tenant, scopeKey: LINE_MARKETING } },
  });
  assert.equal(head.headVersion, 1);
  assert.equal(head.headPolicyRevisionId, row.id);

  const approval = await f.owner.cg4PolicyApproval.findFirstOrThrow({
    where: { tenantId: f.tenant },
  });
  assert.equal(approval.capabilitySource, 'LEGACY_MIGRATED');
  assert.equal(approval.approverRef, 'legacy-checker-synthetic');

  // backfill ไม่สร้าง historic event ย้อนหลังให้ policy ที่ย้ายมา
  assert.equal(await f.owner.cgEventOutbox.count({ where: { tenantId: f.tenant } }), 0);

  const before = await countsFor(f);
  const rerun = await f.backfill();
  assert.equal(rerun.legacyActive.length, 0);
  assert.equal(rerun.alreadyRecorded, 1);
  assert.deepEqual(await countsFor(f), before);

  // ประวัติ CG3 ไม่ถูกแก้หรือลบ
  assert.equal(await f.owner.cgPolicy.count({ where: { tenantId: f.tenant } }), 2);
});

test('CG4-MG02: scope เดียวกันมีสอง policy series ไม่มีผู้ชนะ จึงเปิด kill switch แทนการสร้าง head', async (t) => {
  const f = await fixture(t);
  const first = await cg3Policy(f, { publishedAt: new Date('2026-02-01T00:00:00.000Z') });
  const second = await cg3Policy(f, { publishedAt: new Date('2026-03-01T00:00:00.000Z') });

  const report = await f.backfill();
  assert.deepEqual(report.legacyActive, []);
  assert.equal(report.killedScopes.length, 1);
  const killed = report.killedScopes[0]!;
  assert.equal(killed.scopeKey, LINE_MARKETING);
  assert.equal(killed.reason, CG4_BACKFILL_KILL_REASONS.AMBIGUOUS_SCOPE);
  assert.deepEqual(killed.sourcePolicyRowIds, [first.id, second.id].sort());
  assert.equal(killed.newlyActivated, true);

  assert.equal(await f.owner.cg4PolicyScopeHead.count({ where: { tenantId: f.tenant } }), 0);
  const event = await f.owner.cgEventOutbox.findFirstOrThrow({ where: { tenantId: f.tenant } });
  assert.equal(event.eventType, 'governance.kill-switch.changed');
  assert.equal(event.aggregateId, killed.killSwitchId);
  assert.equal(event.aggregateVersion, 1);
  const payload = event.payload as {
    affectedScope: Record<string, string>;
    restrictiveness: string;
  };
  assert.equal(payload.affectedScope.channel, 'LINE');
  assert.equal(payload.restrictiveness, 'TIGHTENING');

  const before = await countsFor(f);
  const rerun = await f.backfill();
  assert.equal(rerun.killedScopes[0]?.newlyActivated, false);
  assert.deepEqual(await countsFor(f), before);
});

test('CG4-MG02: equal specificity ที่ request เดียวชนได้ทั้งคู่ ถูก kill ทั้งสอง scope', async (t) => {
  const f = await fixture(t);
  await cg3Policy(f, { purpose: null, channel: 'LINE' });
  await cg3Policy(f, { purpose: 'MARKETING', channel: null });

  const report = await f.backfill();
  assert.deepEqual(report.legacyActive, []);
  assert.deepEqual(report.killedScopes.map((entry) => entry.scopeKey).sort(), [
    'channel=*|contactKind=*|purpose=MARKETING|sourceType=*',
    'channel=LINE|contactKind=*|purpose=*|sourceType=*',
  ]);
  assert.ok(
    report.killedScopes.every(
      (entry) => entry.reason === CG4_BACKFILL_KILL_REASONS.AMBIGUOUS_SCOPE,
    ),
  );
  assert.equal(await f.owner.cg4PolicyScopeHead.count({ where: { tenantId: f.tenant } }), 0);
});

test('CG4-MG02: scope ที่มี CG4 head อยู่แล้วถูก kill แทนการแทนที่ head ของ CG4', async (t) => {
  const f = await fixture(t);
  const policyId = randomUUID();
  const native = await f.owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenant,
      policyId,
      version: 1,
      scopeKey: LINE_MARKETING,
      content: {} as Prisma.InputJsonValue,
      contentDigest: DIGEST,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      status: 'ACTIVE',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      makerActorRef: 'cg4-maker-synthetic',
    },
  });
  const head = await f.owner.cg4PolicyScopeHead.create({
    data: {
      tenantId: f.tenant,
      scopeKey: LINE_MARKETING,
      headPolicyId: policyId,
      headPolicyVersion: 1,
      headPolicyRevisionId: native.id,
      headVersion: 3,
      headDigest: DIGEST,
    },
  });
  await cg3Policy(f);

  const report = await f.backfill();
  assert.equal(report.killedScopes[0]?.reason, CG4_BACKFILL_KILL_REASONS.HEAD_CONFLICT);
  const after = await f.owner.cg4PolicyScopeHead.findUniqueOrThrow({ where: { id: head.id } });
  assert.equal(after.headVersion, 3);
  assert.equal(after.headPolicyRevisionId, native.id);
});

test('CG4-MG02: content ที่ CG4 compile ไม่ได้ถูก kill แบบ fail closed ไม่ปล่อยให้ scope ไม่มี policy', async (t) => {
  const f = await fixture(t);
  await cg3Policy(f, { overridableRules: ['DNC_GLOBAL'] as unknown as Prisma.InputJsonValue });
  const report = await f.backfill();
  assert.equal(report.killedScopes.length, 1);
  assert.equal(report.killedScopes[0]?.reason, CG4_BACKFILL_KILL_REASONS.UNMAPPABLE_POLICY);
  assert.equal(await f.owner.cg4Policy.count({ where: { tenantId: f.tenant } }), 0);
});

test('CG4-MG02: DRAFT ถูก map เป็น CG4 DRAFT, policy ที่ยังไม่มีผลถูกรายงาน และ callback ที่อ้าง exception ไม่มีจริงถูกรายงาน', async (t) => {
  const f = await fixture(t);
  const draft = await cg3Policy(f, {
    status: 'DRAFT',
    channel: 'VOICE',
    purpose: 'SERVICE',
    publishedAt: null,
    checkerActorRef: null,
    approvalRef: null,
  });
  const future = await cg3Policy(f, {
    channel: 'EMAIL',
    effectiveFrom: new Date('2027-01-01T00:00:00.000Z'),
  });
  const callback = await f.owner.cgCallbackRequest.create({
    data: {
      tenantId: f.tenant,
      seriesId: randomUUID(),
      version: 1,
      contactId: f.contact,
      channel: 'LINE',
      purpose: 'MARKETING',
      requestedAt: new Date('2026-09-14T01:00:00.000Z'),
      requestedTimezone: 'Asia/Bangkok',
      expiresAt: new Date('2026-09-15T01:00:00.000Z'),
      sourceKind: 'CUSTOMER',
      oneUseTokenHash: 'b'.repeat(64),
      approvedExceptionId: randomUUID(),
      mutationKind: 'REQUEST',
      evidenceRef: 'callback-evidence-synthetic',
      requestHash: 'c'.repeat(64),
      actorClass: 'CUSTOMER',
    },
  });

  const report = await f.backfill();
  assert.equal(report.drafts.length, 1);
  const mappedDraft = await f.owner.cg4Policy.findUniqueOrThrow({
    where: { id: report.drafts[0]!.policyRowId },
  });
  assert.equal(mappedDraft.status, 'DRAFT');
  assert.equal(mappedDraft.origin, 'LEGACY_CG3');
  assert.equal(mappedDraft.legacySourceRowId, draft.id);
  assert.deepEqual(report.deferred, [
    { legacyRowId: future.id, effectiveFrom: '2027-01-01T00:00:00.000Z' },
  ]);
  assert.deepEqual(report.orphanCallbackRefs, [{ callbackRequestId: callback.id }]);
  assert.equal(await f.owner.cg4PolicyScopeHead.count({ where: { tenantId: f.tenant } }), 0);

  const rerun = await f.backfill();
  assert.deepEqual(rerun.drafts, []);
  assert.deepEqual(rerun.orphanCallbackRefs, []);
  assert.equal(rerun.deferred.length, 1);
});

test('CG4-MG02: DB บังคับว่า origin เปลี่ยนไม่ได้ และ LEGACY_MIGRATED approval ใช้กับ version ของ CG4 ไม่ได้', async (t) => {
  const f = await fixture(t);
  const native = await f.owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenant,
      policyId: randomUUID(),
      version: 1,
      scopeKey: LINE_MARKETING,
      content: {} as Prisma.InputJsonValue,
      contentDigest: DIGEST,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      status: 'DRAFT',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      makerActorRef: 'cg4-maker-synthetic',
    },
  });
  await assert.rejects(
    f.owner.cg4PolicyApproval.create({
      data: {
        tenantId: f.tenant,
        policyId: native.policyId,
        policyVersion: 1,
        decision: 'APPROVED',
        approverRef: 'someone',
        evidenceRef: 'evidence',
        decidedAt: NOW,
        capability: 'cg.legacy.migrated',
        capabilitySource: 'LEGACY_MIGRATED',
        directCompliance: false,
        emergencyAuthority: false,
        authorizationEpoch: 0,
        scopeVersion: 0,
      },
    }),
    /LEGACY_MIGRATED approval requires a LEGACY_CG3 policy version/,
  );
  // capability ของ legacy ใช้กับ source ที่นับ quorum จริง (DIRECT/DELEGATED) ไม่ได้
  await assert.rejects(
    f.owner.cg4PolicyApproval.create({
      data: {
        tenantId: f.tenant,
        policyId: native.policyId,
        policyVersion: 1,
        decision: 'APPROVED',
        approverRef: 'someone',
        evidenceRef: 'evidence',
        decidedAt: NOW,
        capability: 'cg.legacy.migrated',
        capabilitySource: 'DIRECT',
        directCompliance: false,
        emergencyAuthority: false,
        authorizationEpoch: 0,
        scopeVersion: 0,
      },
    }),
    /cg_policy_approval_capability_check/,
  );
  await assert.rejects(
    f.owner.cg4Policy.update({
      where: { id: native.id },
      data: { origin: 'LEGACY_CG3', legacySourceRowId: randomUUID() },
    }),
    /origin is immutable/,
  );
  await assert.rejects(
    f.owner.cg4Policy.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenant,
        policyId: randomUUID(),
        version: 1,
        scopeKey: LINE_MARKETING,
        content: {} as Prisma.InputJsonValue,
        contentDigest: DIGEST,
        registryVersion: 'CG4_RULE_REGISTRY_V1',
        status: 'DRAFT',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        makerActorRef: 'cg4-maker-synthetic',
        origin: 'LEGACY_CG3',
      },
    }),
    /cg_policy_legacy_source_origin_check/,
  );
});
