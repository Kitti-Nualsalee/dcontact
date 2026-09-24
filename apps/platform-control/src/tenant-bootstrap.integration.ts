/**
 * A1.5 (#410) acceptance บน Postgres จริง (fast gate — ไม่ต้องใช้ Keycloak)
 *
 * PLAN_BOOTSTRAP และ READINESS เป็นตัวจริง; KEYCLOAK_ORGANIZATION เป็น fake และ FIRST_ADMIN/INVITATION
 * เป็น test port ที่เขียน DB แบบเดียวกับ adapter จริงของ A1.4 (users row + invitation SENT)
 *
 * ครอบ: manifest/plan pin + version ใหม่, REVOKED/DEPRECATED, duplicate/restart/concurrent bootstrap,
 * stale revision/identity field edit, readiness fail (plan/manifest digest, missing receipt,
 * cross-tenant binding) และ baseline ที่ inactive
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PlatformProvisioningError, type PlatformProvisioningErrorCode } from '@d-contact/shared';
import { createPlatformFixture, FIXTURE_MANIFEST, OPERATOR, SIP_BASE } from './platform-fixture.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { bootstrapRowIds, deterministicUuid, firstAdminUserId } from './provisioning-ids.js';
import { ProvisioningRequestEditor } from './provisioning-request-editor.js';
import {
  ProvisioningSagaWorker,
  provisioningStepContext,
  type ProvisioningStepPort,
} from './provisioning-saga.js';
import { TenantBootstrapPort, TenantReadinessPort } from './tenant-bootstrap.js';

async function setup(t: TestContext) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const tenants: string[] = [];
  const keycloakId = (requestId: string) => deterministicUuid('test:keycloak-user', requestId);

  /** เขียน users row แบบ adapter จริง (Admin Team + keycloak_id) ผ่าน provisioner */
  const firstAdmin: ProvisioningStepPort = {
    async find(context) {
      const row = await f.provisioner.user.findUnique({
        where: { id: firstAdminUserId(context.requestId) },
      });
      return row?.keycloakId
        ? { status: 'FOUND', externalRef: row.keycloakId }
        : { status: 'NOT_FOUND' };
    },
    async execute(context) {
      await f.provisioner.user.createMany({
        data: [
          {
            id: firstAdminUserId(context.requestId),
            tenantId: context.tenantId,
            email: context.request.firstAdminEmail,
            passwordHash: '!keycloak-managed',
            displayName: context.request.firstAdminDisplayName,
            role: 'ADMIN',
            teamId: bootstrapRowIds(context.requestId).adminTeamId,
            keycloakId: keycloakId(context.requestId),
          },
        ],
        skipDuplicates: true,
      });
      return { externalRef: keycloakId(context.requestId) };
    },
  };
  /** invitation ที่ส่งแล้วหนึ่ง generation แบบ outbox จริง (intent → SENT) */
  const invitation: ProvisioningStepPort = {
    async find(context) {
      const row = await f.platform.pfInvitation.findFirst({
        where: { requestId: context.requestId, state: 'SENT' },
      });
      return row ? { status: 'FOUND', externalRef: row.id } : { status: 'NOT_FOUND' };
    },
    async execute(context) {
      const sentAt = new Date();
      const row = await f.platform.pfInvitation.create({
        data: {
          id: randomUUID(),
          requestId: context.requestId,
          tenantId: context.tenantId,
          generation: 1,
          keycloakUserId: keycloakId(context.requestId),
          recipientHash: 'a'.repeat(64),
          lifespanSeconds: 259200,
          requestedByKind: 'SYSTEM',
          requestedBy: 'test',
          createdAt: sentAt,
        },
      });
      await f.platform.pfInvitation.update({
        where: { id: row.id },
        data: {
          state: 'SENT',
          sentAt,
          expiresAt: new Date(sentAt.getTime() + 259200_000),
          revision: { increment: 1 },
        },
      });
      return { externalRef: row.id };
    },
  };

  const bootstrap = new TenantBootstrapPort(f.platform, f.provisioner);
  const readiness = new TenantReadinessPort(f.platform, f.provisioner);
  /** `only` จำกัดให้ worker เห็นเฉพาะ tenant เดียว — กันไม่ให้หยิบ request ของเคสอื่นในเทสต์เดียวกัน */
  const worker = (only?: string, workerId = `bootstrap-${randomUUID().slice(0, 8)}`) =>
    new ProvisioningSagaWorker(
      f.platform,
      {
        ...createFakeProvisioningPorts().ports,
        PLAN_BOOTSTRAP: bootstrap,
        FIRST_ADMIN: firstAdmin,
        INVITATION: invitation,
        READINESS: readiness,
      },
      {
        workerId,
        sipBaseDomain: SIP_BASE,
        scope: () => ({ tenantId: only ?? { in: [...tenants] } }),
        backoffBaseMs: 1,
        backoffMaxMs: 1,
      },
    );
  const accept = async (overrides: Parameters<typeof f.input>[0] = {}, plan = f.plan) => {
    const key = `idem-${randomUUID()}`;
    const result = await f.repository().accept({
      idempotencyKey: key,
      input: f.input(overrides),
      plan,
      actor: OPERATOR,
      correlationId: `corr-${key}`,
    });
    f.track(result.tenantId);
    tenants.push(result.tenantId);
    return result;
  };
  const request = (requestId: string) =>
    f.owner.pfProvisioningRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { steps: { orderBy: { ordinal: 'asc' } }, tenant: true },
    });
  const editor = new ProvisioningRequestEditor(f.platform);
  return { f, bootstrap, readiness, worker, accept, request, editor };
}

async function rejectsWith(work: Promise<unknown>, code: PlatformProvisioningErrorCode) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof PlatformProvisioningError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

test('happy path: baseline ครบ, drafts inactive, plan/manifest ตาม pin แล้ว ACTIVE หลัง readiness', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  await s.worker().drain();
  const final = await s.request(accepted.requestId);
  assert.deepEqual([final.status, final.tenant.lifecycleStatus], ['SUCCEEDED', 'ACTIVE']);

  const ids = bootstrapRowIds(accepted.requestId);
  const tenantId = accepted.tenantId;
  const teams = await s.f.owner.team.findMany({ where: { tenantId }, orderBy: { name: 'asc' } });
  assert.deepEqual(
    teams.map((team) => [team.id, team.name, team.isActive]),
    [
      [ids.adminTeamId, 'Admin Team', true],
      [ids.generalTeamId, 'General Team', false],
    ],
  );
  const [queue, ...moreQueues] = await s.f.owner.queue.findMany({ where: { tenantId } });
  assert.equal(moreQueues.length, 0);
  // ไม่มี traffic อัตโนมัติ: queue inactive, ไม่มี channel
  assert.deepEqual(
    [queue!.id, queue!.isActive, queue!.channels, queue!.teamId],
    [ids.generalQueueId, false, [], ids.generalTeamId],
  );
  const [hours] = await s.f.owner.businessHours.findMany({ where: { tenantId } });
  assert.deepEqual([hours!.status, hours!.timezone], ['DRAFT', 'Asia/Bangkok']);
  assert.deepEqual(hours!.weekly, FIXTURE_MANIFEST.drafts.businessHours.weekly);
  const settings = await s.f.owner.tenantSettings.findUniqueOrThrow({ where: { tenantId } });
  assert.deepEqual(
    [settings.locale, settings.timezone, settings.bootstrapTemplateDigest],
    ['th-TH', 'Asia/Bangkok', s.f.template.contentDigest],
  );
  const binding = await s.f.owner.tenantPlanBinding.findUniqueOrThrow({ where: { tenantId } });
  assert.deepEqual(
    [binding.planVersion, binding.snapshotDigest, binding.entitlements],
    [s.f.publishedPlan.version, s.f.publishedPlan.snapshotDigest, s.f.publishedPlan.entitlements],
  );
  const admin = await s.f.owner.user.findUniqueOrThrow({
    where: { id: firstAdminUserId(accepted.requestId) },
  });
  assert.equal(admin.teamId, ids.adminTeamId);
  const receipt = await s.f.owner.pfProvisioningStepReceipt.findFirstOrThrow({
    where: { requestId: accepted.requestId, stepKey: 'READINESS', outcome: 'SUCCEEDED' },
  });
  assert.match(receipt.outputDigest ?? '', /^[a-f0-9]{64}$/);
  // หลัง ACTIVE แล้ว provisioner มองไม่เห็นและเขียน baseline ของ tenant นี้ไม่ได้อีก
  assert.equal(await s.f.provisioner.team.count({ where: { tenantId } }), 0);
});

test('duplicate/restart/concurrent bootstrap ไม่สร้าง metadata ซ้ำ แล้ว saga adopt', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const request = await s.request(accepted.requestId);
  const context = provisioningStepContext(request, 'PLAN_BOOTSTRAP', 1);
  await Promise.all([1, 2, 3].map(() => s.bootstrap.execute(context)));
  await s.bootstrap.execute(context);
  await s.worker().drain();
  const tenantId = accepted.tenantId;
  const counts = await Promise.all([
    s.f.owner.team.count({ where: { tenantId } }),
    s.f.owner.queue.count({ where: { tenantId } }),
    s.f.owner.businessHours.count({ where: { tenantId } }),
    s.f.owner.tenantSettings.count({ where: { tenantId } }),
    s.f.owner.tenantPlanBinding.count({ where: { tenantId } }),
  ]);
  assert.deepEqual(counts, [2, 1, 1, 1, 1]);
  assert.equal((await s.request(accepted.requestId)).status, 'SUCCEEDED');
  const adopted = await s.f.owner.pfActionHistory.findMany({
    where: { requestId: accepted.requestId, reasonCode: 'VERIFIED_ADOPTION' },
  });
  assert.ok(adopted.some((row) => row.stepKey === 'PLAN_BOOTSTRAP'));
});

test('manifest: version ใหม่ไม่เปลี่ยน request เดิม; DEPRECATED เริ่มใหม่ไม่ได้; REVOKED หยุด in-flight', async (t) => {
  const s = await setup(t);
  const pinned = await s.accept();
  // ออก version ใหม่แล้วเลิกใช้ version เดิม — request ที่ pin ไว้ยังทำต่อด้วย manifest เดิม
  const next = await s.f.catalog.publishBootstrapTemplate({
    version: `${s.f.templateVersion}-next`,
    manifest: { ...FIXTURE_MANIFEST, adminTeam: { name: 'Administrators' } },
  });
  t.after(() =>
    s.f.owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await transaction.$executeRawUnsafe(
        'DELETE FROM "pf_bootstrap_templates" WHERE "version" = $1',
        next.version,
      );
    }),
  );
  await s.f.catalog.setTemplateStatus(s.f.templateVersion, 'DEPRECATED');
  await rejectsWith(s.accept(), 'BOOTSTRAP_TEMPLATE_UNAVAILABLE');
  await s.worker().drain();
  const replayed = await s.request(pinned.requestId);
  assert.equal(replayed.status, 'SUCCEEDED');
  const adminTeam = await s.f.owner.team.findUniqueOrThrow({
    where: { id: bootstrapRowIds(pinned.requestId).adminTeamId },
  });
  assert.equal(adminTeam.name, 'Admin Team');

  // REVOKED: request ที่ยังไม่จบเข้า ACTION_REQUIRED ก่อนเริ่ม step ใหม่
  const inFlight = await s.accept({ bootstrapTemplateVersion: next.version });
  await s.f.catalog.setTemplateStatus(next.version, 'REVOKED');
  await s.worker().drain();
  const stopped = await s.request(inFlight.requestId);
  assert.deepEqual(
    [stopped.status, stopped.failureCode],
    ['ACTION_REQUIRED', 'BOOTSTRAP_TEMPLATE_REVOKED'],
  );
  assert.equal(await s.f.owner.team.count({ where: { tenantId: inFlight.tenantId } }), 0);
  await rejectsWith(
    s.accept({ bootstrapTemplateVersion: next.version }),
    'BOOTSTRAP_TEMPLATE_UNAVAILABLE',
  );
});

test('plan: pin snapshot ตอนรับคำขอ — version ใหม่/เลิกใช้ไม่เปลี่ยน request เดิม; digest ไม่ตรงหรือเลิกใช้ = PLAN_UNAVAILABLE', async (t) => {
  const s = await setup(t);
  const pinned = await s.accept();
  const newer = await s.f.catalog.publishPlanVersion({
    planCode: 'growth',
    entitlements: { agent_seats: 999, queues: 99, recording: false },
  });
  t.after(() =>
    s.f.owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await transaction.$executeRawUnsafe(
        `DELETE FROM "pf_plan_versions" WHERE "plan_code" = 'growth' AND "version" = $1`,
        newer.version,
      );
    }),
  );
  await s.f.catalog.setPlanStatus('growth', s.f.publishedPlan.version, 'DEPRECATED');
  await rejectsWith(s.accept(), 'PLAN_UNAVAILABLE');
  await rejectsWith(
    s.accept({}, { version: newer.version, snapshotDigest: 'b'.repeat(64) }),
    'PLAN_UNAVAILABLE',
  );
  assert.deepEqual(
    await s.f.catalog.activePlan('growth').then((plan) => plan.version),
    newer.version,
  );
  await s.worker().drain();
  const binding = await s.f.owner.tenantPlanBinding.findUniqueOrThrow({
    where: { tenantId: pinned.tenantId },
  });
  assert.deepEqual(
    [binding.planVersion, binding.entitlements],
    [s.f.publishedPlan.version, s.f.publishedPlan.entitlements],
  );
  // snapshot แก้ย้อนหลังไม่ได้
  await assert.rejects(
    s.f.platform.pfPlanVersion.update({
      where: { planCode_version: { planCode: 'growth', version: newer.version } },
      data: { entitlements: { agent_seats: 1 } },
    }),
    /PF_PLAN_IMMUTABLE/,
  );
});

test('edit: CAS บน revision, identity field ล็อก, field ล็อกหลัง step เจ้าของสำเร็จ และ audit ทุกผล', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const base = {
    requestId: accepted.requestId,
    reasonCode: 'CUSTOMER_CORRECTION',
    comment: 'ลูกค้าแจ้งแก้ข้อมูล',
    actor: OPERATOR,
    correlationId: 'corr-edit',
  };
  const revision = (await s.request(accepted.requestId)).revision;
  await rejectsWith(
    s.editor.edit({ ...base, expectedRevision: revision - 1, changes: { timezone: 'Asia/Tokyo' } }),
    'REVISION_CONFLICT',
  );
  await rejectsWith(
    s.editor.edit({ ...base, expectedRevision: revision, changes: { slug: 'other-slug' } }),
    'FIELD_LOCKED',
  );
  await rejectsWith(
    s.editor.edit({
      ...base,
      expectedRevision: revision,
      changes: { firstAdminEmail: 'x@example.test' },
    }),
    'FIELD_LOCKED',
  );
  const edited = await s.editor.edit({
    ...base,
    expectedRevision: revision,
    changes: { timezone: 'Asia/Tokyo', displayName: 'Renamed Customer' },
  });
  assert.equal(edited.revision, revision + 1);
  assert.deepEqual(edited.changedFields, ['displayName', 'timezone']);
  const afterEdit = await s.request(accepted.requestId);
  assert.deepEqual([afterEdit.timezone, afterEdit.tenant.name], ['Asia/Tokyo', 'Renamed Customer']);
  // payload เดิม (idempotency binding) ไม่เปลี่ยน; digest ใหม่อยู่ใน payload revision
  const [payloadRevision] = await s.f.owner.pfRequestPayloadRevision.findMany({
    where: { requestId: accepted.requestId },
  });
  assert.equal(payloadRevision!.payloadDigest, edited.payloadDigest);
  assert.notEqual(payloadRevision!.payloadDigest, afterEdit.payloadDigest);

  // หยุดก่อน FIRST_ADMIN: รัน saga จน bootstrap สำเร็จ แล้วแก้ locale ไม่ได้ แต่ชื่อ first-admin ยังแก้ได้
  const worker = s.worker(accepted.tenantId);
  while (
    (await s.request(accepted.requestId)).steps.find((step) => step.stepKey === 'PLAN_BOOTSTRAP')!
      .state !== 'SUCCEEDED'
  ) {
    await worker.runOnce();
  }
  const settings = await s.f.owner.tenantSettings.findUniqueOrThrow({
    where: { tenantId: accepted.tenantId },
  });
  assert.equal(settings.timezone, 'Asia/Tokyo');
  const current = (await s.request(accepted.requestId)).revision;
  await rejectsWith(
    s.editor.edit({ ...base, expectedRevision: current, changes: { locale: 'en-US' } }),
    'FIELD_LOCKED',
  );
  const renamed = await s.editor.edit({
    ...base,
    expectedRevision: current,
    changes: { firstAdminDisplayName: 'Khun Admin' },
  });
  assert.deepEqual(renamed.changedFields, ['firstAdminDisplayName']);

  const audits = await s.f.owner.pfActionHistory.findMany({
    where: { requestId: accepted.requestId, action: 'REQUEST_EDITED' },
    orderBy: { occurredAt: 'asc' },
  });
  assert.deepEqual(
    audits.map((row) => [row.outcome, row.errorCode]),
    [
      ['REJECTED', 'REVISION_CONFLICT'],
      ['REJECTED', 'FIELD_LOCKED'],
      ['REJECTED', 'FIELD_LOCKED'],
      ['SUCCEEDED', null],
      ['REJECTED', 'FIELD_LOCKED'],
      ['SUCCEEDED', null],
    ],
  );
  await s.worker().drain();
  assert.equal((await s.request(accepted.requestId)).status, 'SUCCEEDED');
});

test('readiness fail: missing receipt, plan/manifest digest mismatch และ cross-tenant binding', async (t) => {
  const s = await setup(t);
  // ยังไม่ได้ทำอะไร: receipt/baseline/admin/invitation ขาด
  const fresh = await s.accept();
  const empty = await s.readiness.evaluate(
    provisioningStepContext(await s.request(fresh.requestId), 'READINESS', 1),
  );
  assert.equal(empty.passed, false);
  for (const check of [
    'RECEIPTS',
    'BASELINE',
    'ADMIN',
    'INVITATION',
    'SETTINGS',
    'PLAN',
  ] as const) {
    assert.ok(empty.failed.includes(check), check);
  }
  assert.equal(JSON.stringify(empty.evidence).includes('@'), false);

  // ทำจนถึงก่อน READINESS แล้วแก้ข้อมูลเบื้องหลังเพื่อพิสูจน์ว่า readiness จับได้
  const tampered = async (mutate: (tenantId: string, requestId: string) => Promise<unknown>) => {
    const accepted = await s.accept();
    const worker = s.worker(accepted.tenantId);
    // เดินจน INVITATION สำเร็จ (step ก่อน READINESS) แล้วค่อยแก้ข้อมูลเบื้องหลัง
    for (let round = 0; round < 20; round += 1) {
      const result = await worker.runOnce();
      if (result.kind === 'STEP_SUCCEEDED' && result.stepKey === 'INVITATION') break;
    }
    await mutate(accepted.tenantId, accepted.requestId);
    await worker.drain();
    return s.request(accepted.requestId);
  };

  const planTampered = await tampered((tenantId) =>
    s.f.owner.tenantPlanBinding.update({
      where: { tenantId },
      data: { entitlements: { agent_seats: 9999 } },
    }),
  );
  assert.deepEqual(
    [planTampered.status, planTampered.failureCode],
    ['ACTION_REQUIRED', 'READINESS_PLAN_FAILED'],
  );
  assert.equal(planTampered.tenant.lifecycleStatus, 'PROVISIONING');

  const crossTenant = await tampered(async (tenantId, requestId) => {
    const other = await s.f.owner.team.findFirstOrThrow({
      where: { tenantId: { not: tenantId } },
      select: { id: true },
    });
    await s.f.owner.queue.update({
      where: { id: bootstrapRowIds(requestId).generalQueueId },
      data: { teamId: other.id },
    });
  });
  assert.equal(crossTenant.status, 'ACTION_REQUIRED');
  const crossReport = await s.readiness.evaluate(
    provisioningStepContext(crossTenant, 'READINESS', 9),
  );
  assert.ok(crossReport.failed.includes('ISOLATION'));

  const manifestTampered = await tampered(() =>
    s.f.owner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
      await transaction.$executeRawUnsafe(
        `UPDATE "pf_bootstrap_templates" SET "manifest" = jsonb_set("manifest", '{adminTeam,name}', '"Hijacked"') WHERE "version" = $1`,
        s.f.templateVersion,
      );
    }),
  );
  assert.deepEqual(
    [manifestTampered.status, manifestTampered.failureCode],
    ['ACTION_REQUIRED', 'READINESS_MANIFEST_FAILED'],
  );
});
