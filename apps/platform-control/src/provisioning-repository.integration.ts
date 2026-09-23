/**
 * A1.1 (#406) acceptance: control-plane foundation บน Postgres จริงด้วย role `dcontact_platform`
 *
 * ครอบ: fresh accept + ledger, idempotency replay/conflict แบบ concurrent, slug/domain/email reservation
 * ผู้ชนะเดียว + tombstone 30 วัน, CAS/transition, completion invariant, cross-tenant swap แบบ generic,
 * append-only ledger/audit และ control plane ไม่เห็น tenant business data
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import {
  IDENTITY_RESERVATION_KINDS,
  PLATFORM_ACTION_KINDS,
  PROVISIONING_REQUEST_STATUSES,
  PROVISIONING_STEP_KEYS,
  PlatformProvisioningError,
  TENANT_LIFECYCLE_STATUSES,
  type PlatformProvisioningErrorCode,
} from '@d-contact/shared';
import {
  createPlatformFixture,
  digest,
  OPERATOR,
  SIP_BASE,
  WORKER,
  type PlatformFixture,
} from './platform-fixture.js';
import { provisioningPlaceholder } from './provisioning-repository.js';

async function fixture(t: TestContext): Promise<PlatformFixture> {
  const context = await createPlatformFixture();
  t.after(() => context.dispose());
  return context;
}

async function rejectsWith(work: Promise<unknown>, code: PlatformProvisioningErrorCode) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof PlatformProvisioningError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

const accept = (f: PlatformFixture, input = f.input(), key = `idem-${randomUUID()}`) =>
  f
    .repository()
    .accept({
      idempotencyKey: key,
      input,
      plan: f.plan,
      actor: OPERATOR,
      correlationId: `corr-${key}`,
    })
    .then((result) => (f.track(result.tenantId), result));

/** เดินทุก step ที่เหลือให้ SUCCEEDED ด้วย worker (A1.3 จะเป็นคนทำจริง) */
async function completeSteps(f: PlatformFixture, tenantId: string, requestId: string) {
  for (const stepKey of PROVISIONING_STEP_KEYS.filter((key) => key !== 'TENANT_RECORD')) {
    await f.repository().recordStepOutcome({
      tenantId,
      requestId,
      stepKey,
      attempt: 1,
      outcome: 'SUCCEEDED',
      outputDigest: digest(stepKey),
      externalRef: `ext-${stepKey}`,
      actor: WORKER,
      correlationId: 'corr-steps',
    });
  }
}

test('accept: สร้าง Tenant(PROVISIONING) + request + ledger + reservations ใน transaction เดียว', async (t) => {
  const f = await fixture(t);
  const input = f.input({ primaryDomain: 'Mixed.Case.Example.TEST' });
  const accepted = await accept(f, input);
  assert.deepEqual(
    [accepted.outcome, accepted.status, accepted.revision],
    ['ACCEPTED', 'PENDING', 1],
  );

  const tenant = await f.owner.tenant.findUniqueOrThrow({ where: { id: accepted.tenantId } });
  assert.equal(tenant.lifecycleStatus, 'PROVISIONING');
  // placeholder จนกว่าจะ ACTIVE — slug จริงอยู่ที่ request/reservation
  assert.deepEqual(
    { slug: tenant.slug, sipDomain: tenant.sipDomain, primaryDomain: tenant.primaryDomain },
    { ...provisioningPlaceholder(accepted.tenantId), primaryDomain: null },
  );

  const view = await f.repository().findRequest({ requestId: accepted.requestId });
  assert.ok(view);
  assert.equal(view.tenantId, accepted.tenantId);
  assert.equal(view.slug, input.slug);
  assert.equal(view.primaryDomain, 'mixed.case.example.test');
  assert.equal(view.sipDomain, `${input.slug}.${SIP_BASE}`);
  assert.deepEqual(
    view.steps.map((step) => [step.stepKey, step.state]),
    PROVISIONING_STEP_KEYS.map((key) => [key, key === 'TENANT_RECORD' ? 'SUCCEEDED' : 'PENDING']),
  );
  assert.ok(view.deadlineAt.getTime() - view.acceptedAt.getTime() === 30 * 60_000);

  const reservations = await f.owner.pfIdentityReservation.findMany({
    where: { requestId: accepted.requestId },
    orderBy: { kind: 'asc' },
  });
  assert.deepEqual(
    reservations.map((row) => [row.kind, row.state]),
    [
      ['SLUG', 'HELD'],
      ['PRIMARY_DOMAIN', 'HELD'],
      ['FIRST_ADMIN_EMAIL', 'HELD'],
    ],
  );
  // email เก็บเป็น hash เท่านั้นทั้ง reservation และ Action history
  const history = await f.repository().listActionHistory({ tenantId: accepted.tenantId });
  assert.deepEqual(
    history.map((row) => row.action),
    ['REQUEST_ACCEPTED'],
  );
  const serialized = JSON.stringify({ reservations, history });
  assert.ok(!serialized.includes(input.firstAdmin.email));
});

test('idempotency: key+payload เดิมพร้อมกันห้าคำขอได้ request เดียว ที่เหลือเป็น REPLAYED', async (t) => {
  const f = await fixture(t);
  const input = f.input();
  const key = `idem-${randomUUID()}`;
  const results = await Promise.all(Array.from({ length: 5 }, () => accept(f, input, key)));
  const requestIds = new Set(results.map((result) => result.requestId));
  assert.equal(requestIds.size, 1);
  assert.equal(results.filter((result) => result.outcome === 'ACCEPTED').length, 1);
  assert.equal(new Set(results.map((result) => result.tenantId)).size, 1);

  const [requestId] = [...requestIds];
  assert.equal(await f.owner.pfProvisioningRequest.count({ where: { id: requestId } }), 1);
  const history = await f.repository().listActionHistory({ tenantId: results[0]!.tenantId });
  assert.equal(history.filter((row) => row.action === 'REQUEST_ACCEPTED').length, 1);
  assert.equal(history.filter((row) => row.action === 'COMMAND_REPLAYED').length, 4);
  // ผู้แพ้ race ไม่ทิ้ง tenant กำพร้า
  assert.equal(await f.owner.tenant.count({ where: { name: input.displayName } }), 1);
});

test('idempotency: key เดิมแต่ payload ต่าง = IDEMPOTENCY_KEY_REUSED และไม่สร้าง identity ใหม่', async (t) => {
  const f = await fixture(t);
  const key = `idem-${randomUUID()}`;
  const first = await accept(f, f.input(), key);
  const other = f.input();
  await rejectsWith(accept(f, other, key), 'IDEMPOTENCY_KEY_REUSED');
  assert.equal(await f.owner.tenant.count({ where: { name: other.displayName } }), 0);
  assert.equal(await f.owner.pfCommandReceipt.count({ where: { tenantId: first.tenantId } }), 1);
});

test('reservation: slug/domain/email เดียวกันพร้อมกันมีผู้ชนะเดียว ที่เหลือได้ conflict code ของตัวเอง', async (t) => {
  const f = await fixture(t);
  const base = f.input();
  const cases = [
    ['TENANT_SLUG_CONFLICT', (i: number) => f.input({ slug: base.slug, displayName: `slug ${i}` })],
    [
      'TENANT_DOMAIN_CONFLICT',
      (i: number) => f.input({ primaryDomain: base.primaryDomain, displayName: `domain ${i}` }),
    ],
    [
      'FIRST_ADMIN_EMAIL_CONFLICT',
      (i: number) => f.input({ firstAdmin: base.firstAdmin, displayName: `email ${i}` }),
    ],
  ] as const;
  await accept(f, base);
  for (const [code, make] of cases) {
    const settled = await Promise.allSettled(
      Array.from({ length: 4 }, (_, index) => accept(f, make(index))),
    );
    assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 0, code);
    for (const result of settled) {
      assert.ok(result.status === 'rejected');
      assert.equal((result.reason as PlatformProvisioningError).code, code);
    }
  }

  // ผู้ชนะระหว่างคำขอใหม่หลายใบที่ชนกันเองก็มีได้คนเดียว
  const contested = f.input();
  const race = await Promise.allSettled(
    Array.from({ length: 5 }, (_, index) =>
      accept(f, { ...contested, displayName: `race ${index}` }),
    ),
  );
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
  assert.ok(
    race
      .filter((result) => result.status === 'rejected')
      .every((result) => (result as PromiseRejectedResult).reason.code === 'TENANT_SLUG_CONFLICT'),
  );
});

test('reservation: slug/domain ของ tenant เดิม (legacy ACTIVE) ใช้ไม่ได้', async (t) => {
  const f = await fixture(t);
  const legacy = await f.owner.tenant.create({
    data: {
      name: 'Legacy tenant',
      slug: `legacy-${f.run}`,
      sipDomain: `legacy-${f.run}.sip.local`,
      primaryDomain: `legacy-${f.run}.example.test`,
    },
  });
  f.track(legacy.id);
  await rejectsWith(accept(f, f.input({ slug: legacy.slug })), 'TENANT_SLUG_CONFLICT');
  await rejectsWith(
    accept(f, f.input({ primaryDomain: legacy.primaryDomain! })),
    'TENANT_DOMAIN_CONFLICT',
  );
});

test('tombstone: คำขอที่ CANCELLED กัน slug/domain/email ไว้ 30 วัน หมดแล้วคำขอใหม่รับช่วงได้', async (t) => {
  const f = await fixture(t);
  const input = f.input();
  const first = await accept(f, input);
  await f.repository().transition({
    requestId: first.requestId,
    expectedRevision: 1,
    to: 'CANCELLED',
    actor: OPERATOR,
    correlationId: 'corr-cancel',
    reasonCode: 'OPERATOR_INPUT_ERROR',
  });
  const tombstones = await f.owner.pfIdentityReservation.findMany({
    where: { requestId: first.requestId },
  });
  assert.ok(tombstones.every((row) => row.state === 'TOMBSTONED'));
  for (const row of tombstones) {
    const days = (row.tombstonedUntil!.getTime() - Date.now()) / 86_400_000;
    assert.ok(days > 29.9 && days <= 30, `${row.kind}: ${days}`);
  }

  await rejectsWith(
    accept(f, { ...input, displayName: 'Reuse too early' }),
    'TENANT_SLUG_CONFLICT',
  );

  await f.expireTombstones(first.requestId);
  const reused = await accept(f, { ...input, displayName: 'Reuse after tombstone' });
  assert.equal(reused.outcome, 'ACCEPTED');
  assert.notEqual(reused.tenantId, first.tenantId);
  const heads = await f.owner.pfIdentityReservation.findMany({
    where: { requestId: reused.requestId },
  });
  assert.equal(heads.length, 3);
  assert.ok(heads.every((row) => row.state === 'HELD'));
  // ประวัติของคำขอเดิมยังอยู่ครบ
  const old = await f.repository().listActionHistory({ tenantId: first.tenantId });
  assert.deepEqual(old.map((row) => row.action).sort(), [
    'CANCEL',
    'REQUEST_ACCEPTED',
    'RESERVATION_TOMBSTONED',
  ]);
});

test('transition: CAS revision, transition ต้องห้าม และ SUCCEEDED ก่อน step ครบถูกปฏิเสธ', async (t) => {
  const f = await fixture(t);
  const accepted = await accept(f);
  const repository = f.repository();
  const running = await repository.transition({
    requestId: accepted.requestId,
    expectedRevision: 1,
    to: 'RUNNING',
    actor: WORKER,
    correlationId: 'corr-run',
  });
  assert.deepEqual(running, { status: 'RUNNING', revision: 2 });
  await rejectsWith(
    repository.transition({
      requestId: accepted.requestId,
      expectedRevision: 1,
      to: 'ACTION_REQUIRED',
      actor: WORKER,
      correlationId: 'c',
    }),
    'REVISION_CONFLICT',
  );
  await rejectsWith(
    repository.transition({
      requestId: accepted.requestId,
      expectedRevision: 2,
      to: 'CANCELLED',
      actor: OPERATOR,
      correlationId: 'c',
    }),
    'INVALID_STATE_TRANSITION',
  );
  await rejectsWith(
    repository.transition({
      requestId: accepted.requestId,
      expectedRevision: 2,
      to: 'FAILED_FINAL',
      actor: OPERATOR,
      correlationId: 'c',
    }),
    'INVALID_STATE_TRANSITION',
  );
  // premature ACTIVE: step ยังไม่ครบ → DB ปฏิเสธ และ tenant ยัง PROVISIONING
  await rejectsWith(
    repository.complete({
      requestId: accepted.requestId,
      expectedRevision: 2,
      actor: WORKER,
      correlationId: 'c',
    }),
    'INVALID_STATE_TRANSITION',
  );
  const tenant = await f.owner.tenant.findUniqueOrThrow({ where: { id: accepted.tenantId } });
  assert.equal(tenant.lifecycleStatus, 'PROVISIONING');
});

test('complete: step ครบแล้ว request SUCCEEDED + tenant ACTIVE พร้อม slug/domain จริง + reservation CONSUMED', async (t) => {
  const f = await fixture(t);
  const input = f.input();
  const accepted = await accept(f, input);
  const repository = f.repository();
  await repository.transition({
    requestId: accepted.requestId,
    expectedRevision: 1,
    to: 'RUNNING',
    actor: WORKER,
    correlationId: 'c',
  });
  await completeSteps(f, accepted.tenantId, accepted.requestId);
  const done = await repository.complete({
    requestId: accepted.requestId,
    expectedRevision: 2,
    actor: WORKER,
    correlationId: 'corr-complete',
  });
  assert.deepEqual(done, { status: 'SUCCEEDED', revision: 3 });

  const tenant = await f.owner.tenant.findUniqueOrThrow({ where: { id: accepted.tenantId } });
  assert.deepEqual(
    [tenant.lifecycleStatus, tenant.slug, tenant.sipDomain, tenant.primaryDomain],
    ['ACTIVE', input.slug, `${input.slug}.${SIP_BASE}`, input.primaryDomain],
  );
  const reservations = await f.owner.pfIdentityReservation.findMany({
    where: { requestId: accepted.requestId },
  });
  assert.ok(reservations.every((row) => row.state === 'CONSUMED'));

  // identity ของ tenant ACTIVE ห้าม reuse ตลอดไป — แม้ owner พยายามเปลี่ยน reservation ก็ไม่ได้
  await rejectsWith(accept(f, { ...input, displayName: 'After active' }), 'TENANT_SLUG_CONFLICT');
  await assert.rejects(
    f.owner
      .$executeRaw`UPDATE "pf_identity_reservations" SET "state" = 'TOMBSTONED', "tombstoned_until" = now(), "revision" = "revision" + 1 WHERE "request_id" = ${accepted.requestId}::uuid`,
    /PF_RESERVATION_CONSUMED/,
  );
  // terminal แล้วแก้ไม่ได้
  await assert.rejects(
    f.platform
      .$executeRaw`UPDATE "pf_provisioning_requests" SET "status" = 'RUNNING', "revision" = "revision" + 1, "terminal_at" = NULL WHERE "id" = ${accepted.requestId}::uuid`,
    /PF_REQUEST_TERMINAL/,
  );
});

test('step receipt: replay ของ attempt ที่ SUCCEEDED เป็น no-op และ binding ข้าม tenant ถูกปฏิเสธแบบ generic', async (t) => {
  const f = await fixture(t);
  const a = await accept(f);
  const b = await accept(f);
  const repository = f.repository();
  const step = {
    tenantId: a.tenantId,
    requestId: a.requestId,
    stepKey: 'KEYCLOAK_ORGANIZATION' as const,
    attempt: 1,
    outcome: 'SUCCEEDED' as const,
    externalRef: 'kc-org-1',
    actor: WORKER,
    correlationId: 'corr-step',
  };
  assert.deepEqual(await repository.recordStepOutcome(step), { replayed: false });
  assert.deepEqual(await repository.recordStepOutcome(step), { replayed: true });
  assert.equal(
    await f.owner.pfProvisioningStepReceipt.count({
      where: { requestId: a.requestId, stepKey: 'KEYCLOAK_ORGANIZATION' },
    }),
    1,
  );
  await rejectsWith(
    repository.recordStepOutcome({ ...step, attempt: 2 }),
    'INVALID_STATE_TRANSITION',
  );

  // สลับ tenantId/requestId ข้ามกัน = NOT_FOUND เหมือนไม่มี ไม่เผยว่ามีอยู่
  await rejectsWith(repository.recordStepOutcome({ ...step, tenantId: b.tenantId }), 'NOT_FOUND');
  await rejectsWith(
    repository.recordStepOutcome({ ...step, requestId: b.requestId, stepKey: 'PLAN_BOOTSTRAP' }),
    'NOT_FOUND',
  );
  assert.equal(
    await repository.findRequest({ requestId: a.requestId, tenantId: b.tenantId }),
    null,
  );
  assert.equal(await repository.findRequest({ requestId: randomUUID() }), null);
  assert.equal(await repository.findRequest({ requestId: 'not-a-uuid' }), null);
  // DB เองก็ปฏิเสธ receipt ที่ binding ไม่ตรง (composite FK) แม้เขียนตรงไม่ผ่าน repository
  await assert.rejects(
    f.platform.pfProvisioningStepReceipt.create({
      data: {
        id: randomUUID(),
        tenantId: b.tenantId,
        requestId: a.requestId,
        stepKey: 'READINESS',
        attempt: 1,
        outcome: 'SUCCEEDED',
        recordedAt: new Date(),
      },
    }),
  );
  // ประวัติของ b ไม่มีเหตุการณ์ของ a ปน
  const historyB = await repository.listActionHistory({ tenantId: b.tenantId });
  assert.ok(historyB.every((row) => row.stepKey === null));
});

test('append-only: control-plane role แก้/ลบ ledger, receipt และ audit ไม่ได้ (รวม owner สำหรับ trigger)', async (t) => {
  const f = await fixture(t);
  const accepted = await accept(f);
  for (const table of [
    'pf_action_history',
    'pf_command_receipts',
    'pf_provisioning_step_receipts',
  ]) {
    await assert.rejects(
      f.platform.$executeRawUnsafe(
        `UPDATE "${table}" SET "tenant_id" = "tenant_id" WHERE "tenant_id" = $1::uuid`,
        accepted.tenantId,
      ),
      /permission denied|PF_APPEND_ONLY/,
      table,
    );
    await assert.rejects(
      f.platform.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "tenant_id" = $1::uuid`,
        accepted.tenantId,
      ),
      /permission denied/,
      table,
    );
    await assert.rejects(
      f.owner.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "tenant_id" = $1::uuid`,
        accepted.tenantId,
      ),
      /PF_APPEND_ONLY/,
      table,
    );
  }
  for (const table of [
    'pf_provisioning_requests',
    'pf_provisioning_steps',
    'pf_identity_reservations',
  ]) {
    await assert.rejects(
      f.platform.$executeRawUnsafe(
        `DELETE FROM "${table}" WHERE "tenant_id" = $1::uuid`,
        accepted.tenantId,
      ),
      /permission denied/,
      table,
    );
  }
  // identity/pin ของ request แก้ไม่ได้แม้มีสิทธิ์ UPDATE
  await assert.rejects(
    f.platform
      .$executeRaw`UPDATE "pf_provisioning_requests" SET "slug" = 'hijack', "revision" = "revision" + 1 WHERE "id" = ${accepted.requestId}::uuid`,
    /PF_REQUEST_IDENTITY_IMMUTABLE/,
  );
  // tenant ที่ยัง PROVISIONING จะถูกตั้งเป็น ACTIVE ตรง ๆ ไม่ได้
  await assert.rejects(
    f.platform
      .$executeRaw`UPDATE "tenants" SET "lifecycle_status" = 'ACTIVE' WHERE "id" = ${accepted.tenantId}::uuid`,
    /TENANT_/,
  );
});

test('isolation: control-plane role ไม่มีสิทธิ์บน tenant business data และ tenant app มองไม่เห็น control plane', async (t) => {
  const f = await fixture(t);
  await accept(f);
  for (const table of [
    'contacts',
    'interactions',
    'users',
    'cg_attempts',
    'dl_outbox_entries',
    'recordings',
  ]) {
    await assert.rejects(
      f.platform.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`),
      /permission denied/,
      table,
    );
  }
  for (const table of [
    'pf_provisioning_requests',
    'pf_action_history',
    'pf_identity_reservations',
    'pf_command_receipts',
  ]) {
    await assert.rejects(
      f.application.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`),
      /permission denied/,
      table,
    );
  }
  // tenant ลบไม่ได้ และแก้ค่าอื่นนอกจาก lifecycle/identity ไม่ได้
  await assert.rejects(
    f.platform.$executeRawUnsafe('DELETE FROM "tenants" WHERE false'),
    /permission denied/,
  );
  await assert.rejects(
    f.platform.$executeRawUnsafe(
      'UPDATE "tenants" SET "default_offer_timeout_sec" = 1 WHERE false',
    ),
    /permission denied/,
  );
});

test('contract: vocabulary ใน shared ตรงกับ Postgres enum ของ migration', async (t) => {
  const f = await fixture(t);
  const enumValues = async (type: string) =>
    (
      await f.owner.$queryRaw<Array<{ value: string }>>`
        SELECT value.enumlabel AS value FROM pg_enum AS value
          JOIN pg_type AS type ON type.oid = value.enumtypid
         WHERE type.typname = ${type} ORDER BY value.enumsortorder`
    ).map((row) => row.value);
  assert.deepEqual(await enumValues('TenantLifecycleStatus'), [...TENANT_LIFECYCLE_STATUSES]);
  assert.deepEqual(await enumValues('PfProvisioningStatus'), [...PROVISIONING_REQUEST_STATUSES]);
  assert.deepEqual(await enumValues('PfStepKey'), [...PROVISIONING_STEP_KEYS]);
  assert.deepEqual(await enumValues('PfReservationKind'), [...IDENTITY_RESERVATION_KINDS]);
  assert.deepEqual(await enumValues('PfActionKind'), [...PLATFORM_ACTION_KINDS]);
});

test('template: REVOKED/ไม่มี template = BOOTSTRAP_TEMPLATE_UNAVAILABLE และ manifest แก้ไม่ได้', async (t) => {
  const f = await fixture(t);
  await rejectsWith(
    accept(f, f.input({ bootstrapTemplateVersion: 'missing-v9' })),
    'BOOTSTRAP_TEMPLATE_UNAVAILABLE',
  );
  await assert.rejects(
    f.platform.pfBootstrapTemplate.update({
      where: { version: f.templateVersion },
      data: { manifest: { teams: [] } },
    }),
    /PF_TEMPLATE_IMMUTABLE/,
  );
  await f.platform.pfBootstrapTemplate.update({
    where: { version: f.templateVersion },
    data: { status: 'REVOKED' },
  });
  await rejectsWith(accept(f), 'BOOTSTRAP_TEMPLATE_UNAVAILABLE');
  await assert.rejects(
    f.platform.pfBootstrapTemplate.update({
      where: { version: f.templateVersion },
      data: { status: 'ACTIVE' },
    }),
    /PF_TEMPLATE_TRANSITION/,
  );
});
