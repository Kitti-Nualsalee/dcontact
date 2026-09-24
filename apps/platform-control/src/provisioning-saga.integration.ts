/**
 * A1.3 (#408) acceptance: provisioning saga + recovery บน Postgres จริง (role `dcontact_platform`)
 * กับ deterministic fake ports — fault matrix ของ #393 §4: crash ก่อน/หลัง side effect, lost response,
 * duplicate worker, lease expiry, timeout, restart, out-of-order/stale worker, attempt/deadline
 * exhaustion, readiness failure และ recovery ทุกชนิดพร้อม audit
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PlatformProvisioningError, type PlatformProvisioningErrorCode } from '@d-contact/shared';
import {
  createPlatformFixture,
  OPERATOR,
  SIP_BASE,
  type PlatformFixture,
} from './platform-fixture.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { ProvisioningRecoveryService, type RecoveryCommand } from './provisioning-recovery.js';
import { ProvisioningSagaWorker, type ProvisioningSagaOptions } from './provisioning-saga.js';

const T0 = new Date('2026-09-24T02:00:00.000Z');

async function setup(t: TestContext) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const fakes = createFakeProvisioningPorts();
  let clock = new Date(T0);
  const now = () => new Date(clock);
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const tenants: string[] = [];
  const worker = (workerId = 'worker-a', options: Partial<ProvisioningSagaOptions> = {}) =>
    new ProvisioningSagaWorker(f.platform, fakes.ports, {
      workerId,
      sipBaseDomain: SIP_BASE,
      // เห็นเฉพาะ request ของเทสต์นี้ แม้ DB dev จะมีแถวค้างจาก run อื่น
      scope: () => ({ tenantId: { in: [...tenants] } }),
      now,
      random: () => 0.5,
      timeoutMs: 200,
      heartbeatMs: 10_000,
      ...options,
    });
  const recovery = new ProvisioningRecoveryService(f.platform, fakes.ports, {
    sipBaseDomain: SIP_BASE,
    now,
  });
  /** รับคำขอด้วยนาฬิกาเดียวกับ worker เพื่อให้ deadline เทียบกันได้ */
  const accept = async (input = f.input()) => {
    const key = `idem-${randomUUID()}`;
    const result = await f.repository(now).accept({
      idempotencyKey: key,
      input,
      plan: f.plan,
      actor: OPERATOR,
      correlationId: `corr-${key}`,
    });
    f.track(result.tenantId);
    tenants.push(result.tenantId);
    return result;
  };
  return { f, fakes, now, advance, worker, recovery, accept };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function state(s: Setup, requestId: string) {
  const request = await s.f.owner.pfProvisioningRequest.findUniqueOrThrow({
    where: { id: requestId },
    include: { steps: { orderBy: { ordinal: 'asc' } }, tenant: true },
  });
  return {
    status: request.status,
    revision: request.revision,
    lifecycle: request.tenant.lifecycleStatus,
    steps: Object.fromEntries(request.steps.map((step) => [step.stepKey, step.state])),
    step: (key: string) => request.steps.find((step) => step.stepKey === key)!,
    request,
  };
}

async function rejectsWith(work: Promise<unknown>, code: PlatformProvisioningErrorCode) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof PlatformProvisioningError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

/** preview แล้ว execute ด้วย digest ที่ได้ — ทางเดียวที่ operator ทำ recovery ได้ */
async function recover(
  s: Setup,
  requestId: string,
  action: RecoveryCommand['action'],
  overrides: Partial<RecoveryCommand> = {},
) {
  const preview = await s.recovery.preview({ requestId, action });
  return s.recovery.execute({
    requestId,
    action,
    expectedRevision: preview.revision,
    previewDigest: preview.previewDigest,
    reasonCode: 'OPERATOR_VERIFIED',
    comment: 'ตรวจสอบแล้ว',
    actor: OPERATOR,
    correlationId: `corr-${action}`,
    ...overrides,
  });
}

test('happy path: ทุก step ตามลำดับแล้ว SUCCEEDED + ACTIVE atomic; tenant ได้ slug/domain จริง', async (t) => {
  const s = await setup(t);
  const input = s.f.input();
  const accepted = await s.accept(input);
  const results = await s.worker().drain();
  assert.deepEqual(
    results.map((result) => (result.kind === 'STEP_SUCCEEDED' ? result.stepKey : result.kind)),
    [
      'KEYCLOAK_ORGANIZATION',
      'PLAN_BOOTSTRAP',
      'FIRST_ADMIN',
      'INVITATION',
      'READINESS',
      'COMPLETED',
    ],
  );
  const final = await state(s, accepted.requestId);
  assert.deepEqual([final.status, final.lifecycle], ['SUCCEEDED', 'ACTIVE']);
  assert.equal(final.request.tenant.slug, input.slug);
  for (const system of Object.values(s.fakes.systems)) {
    if ('created' in system) assert.equal(system.created, 1, system.stepKey);
  }
  const receipts = await s.f.owner.pfProvisioningStepReceipt.count({
    where: { requestId: accepted.requestId },
  });
  assert.equal(receipts, 6);
});

test('lost response หลัง side effect: attempt ถัดไป adopt resource เดิม ไม่สร้างซ้ำ', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.fakes.systems.KEYCLOAK_ORGANIZATION.fail('lostResponse');
  s.fakes.systems.FIRST_ADMIN.fail('lostResponse');
  const worker = s.worker();

  const first = await worker.runOnce();
  assert.equal(first.kind, 'RETRY_SCHEDULED');
  s.advance(60_000);
  const adopted = await worker.runOnce();
  assert.deepEqual(adopted, {
    kind: 'STEP_SUCCEEDED',
    requestId: accepted.requestId,
    stepKey: 'KEYCLOAK_ORGANIZATION',
    adopted: true,
  });
  for (let index = 0; index < 10; index += 1) {
    s.advance(60_000);
    await worker.drain();
  }
  const final = await state(s, accepted.requestId);
  assert.deepEqual([final.status, final.lifecycle], ['SUCCEEDED', 'ACTIVE']);
  assert.equal(s.fakes.systems.KEYCLOAK_ORGANIZATION.created, 1);
  assert.equal(s.fakes.systems.FIRST_ADMIN.created, 1);
  const history = await s.f
    .repository()
    .listActionHistory({ tenantId: accepted.tenantId, limit: 200 });
  assert.equal(history.filter((row) => row.reasonCode === 'VERIFIED_ADOPTION').length, 2);
  assert.equal(history.filter((row) => row.action === 'STEP_RETRY_SCHEDULED').length, 2);
});

test('transient failure: backoff + jitter แล้ว worker ไม่ claim ก่อนเวลา', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.fakes.systems.KEYCLOAK_ORGANIZATION.fail('transient', 'transient');
  const worker = s.worker('worker-a', { backoffBaseMs: 10_000 });
  const first = await worker.runOnce();
  assert.equal(first.kind, 'RETRY_SCHEDULED');
  // attempt 1 ในงบ: ceiling 10s → jitter 0.5 = 7.5s
  assert.equal(
    first.kind === 'RETRY_SCHEDULED' && first.nextAttemptAt.getTime() - T0.getTime(),
    7_500,
  );
  assert.equal((await worker.runOnce()).kind, 'IDLE', 'ยังไม่ถึงเวลา');
  s.advance(7_500);
  const second = await worker.runOnce();
  assert.equal(second.kind, 'RETRY_SCHEDULED');
  // attempt 2: ceiling 20s → 15s
  assert.equal(
    second.kind === 'RETRY_SCHEDULED' && second.nextAttemptAt.getTime() - (T0.getTime() + 7_500),
    15_000,
  );
  s.advance(15_000);
  assert.equal((await worker.runOnce()).kind, 'STEP_SUCCEEDED');
  assert.equal(s.fakes.systems.KEYCLOAK_ORGANIZATION.created, 1);
  assert.equal((await state(s, accepted.requestId)).step('KEYCLOAK_ORGANIZATION').attempt, 3);
});

test('timeout: execute ที่ค้างถูก abort เป็น ambiguous แล้วรอบหน้าถาม find ก่อน', async (t) => {
  const s = await setup(t);
  await s.accept();
  s.fakes.systems.KEYCLOAK_ORGANIZATION.fail('hang');
  const worker = s.worker('worker-a', { timeoutMs: 50 });
  const first = await worker.runOnce();
  assert.equal(first.kind, 'RETRY_SCHEDULED');
  s.advance(60_000);
  const second = await worker.runOnce();
  assert.equal(second.kind, 'STEP_SUCCEEDED');
  assert.equal(s.fakes.systems.KEYCLOAK_ORGANIZATION.created, 1);
  assert.ok(s.fakes.systems.KEYCLOAK_ORGANIZATION.findCalls >= 2);
});

test('duplicate worker: หลาย worker แย่งกันพร้อมกันทุกรอบ แต่ละ step ถูก execute ครั้งเดียวและจบครบ', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const workers = Array.from({ length: 4 }, (_, index) => s.worker(`worker-${index}`));
  for (let round = 0; round < 8; round += 1) {
    const results = await Promise.all(workers.map((worker) => worker.runOnce()));
    // ผู้แพ้ CAS ไม่ทำอะไรเลย — ไม่มี LEASE_LOST/ACTION_REQUIRED จากการแย่งกันเอง
    assert.ok(
      results.every((result) => ['STEP_SUCCEEDED', 'COMPLETED', 'IDLE'].includes(result.kind)),
      JSON.stringify(results),
    );
  }
  for (const system of Object.values(s.fakes.systems)) assert.equal(system.executeCalls, 1);
  const history = await s.f
    .repository()
    .listActionHistory({ tenantId: accepted.tenantId, limit: 200 });
  const started = history.filter((row) => row.action === 'STEP_STARTED').map((row) => row.stepKey);
  assert.equal(new Set(started).size, started.length, 'แต่ละ step ถูก claim ครั้งเดียว');
  const final = await state(s, accepted.requestId);
  assert.deepEqual([final.status, final.lifecycle], ['SUCCEEDED', 'ACTIVE']);
});

test('crash + lease expiry: worker ใหม่รับช่วงหลัง lease หมด และ worker เดิมที่กลับมาเขียนทับไม่ได้', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  // worker A claim แล้ว "ตาย" ระหว่าง execute (ไม่มีผลกลับมา) — จำลองด้วย lease ที่ถือค้างใน DB
  const stale = s.worker('worker-a', { leaseMs: 120_000 });
  const claimedStep = (await state(s, accepted.requestId)).step('KEYCLOAK_ORGANIZATION');
  await s.f.owner.pfProvisioningStep.update({
    where: {
      requestId_stepKey: { requestId: accepted.requestId, stepKey: 'KEYCLOAK_ORGANIZATION' },
    },
    data: {
      state: 'RUNNING',
      attempt: claimedStep.attempt + 1,
      leaseOwner: 'worker-a',
      leaseExpiresAt: new Date(T0.getTime() + 120_000),
      revision: { increment: 1 },
    },
  });
  // side effect ของ A สำเร็จก่อนตาย
  await s.fakes.systems.KEYCLOAK_ORGANIZATION.execute(
    {
      tenantId: accepted.tenantId,
      requestId: accepted.requestId,
      stepKey: 'KEYCLOAK_ORGANIZATION',
      attempt: 1,
      operationKey: `${accepted.requestId}:KEYCLOAK_ORGANIZATION`,
      request: {} as never,
    },
    new AbortController().signal,
  );

  const b = s.worker('worker-b');
  assert.equal((await b.runOnce()).kind, 'IDLE', 'lease ของ A ยังไม่หมด');
  s.advance(120_001);
  const taken = await b.runOnce();
  assert.deepEqual(taken, {
    kind: 'STEP_SUCCEEDED',
    requestId: accepted.requestId,
    stepKey: 'KEYCLOAK_ORGANIZATION',
    adopted: true,
  });
  assert.equal(s.fakes.systems.KEYCLOAK_ORGANIZATION.created, 1);

  // A กลับมาเขียนผลด้วย lease/revision เก่า — CAS เดียวกับที่ worker ใช้ต้องไม่โดนแถวใดเลย
  const lateWrite = await s.f.platform.pfProvisioningStep.updateMany({
    where: {
      requestId: accepted.requestId,
      stepKey: 'KEYCLOAK_ORGANIZATION',
      leaseOwner: 'worker-a',
      revision: claimedStep.revision + 1,
    },
    data: { state: 'SUCCEEDED', finishedAt: s.now(), revision: { increment: 1 } },
  });
  assert.equal(lateWrite.count, 0);
  assert.equal(
    await s.f.owner.pfProvisioningStepReceipt.count({
      where: { requestId: accepted.requestId, stepKey: 'KEYCLOAK_ORGANIZATION' },
    }),
    1,
  );
  // A ที่รันต่อทำ step ถัดไปตามปกติ ไม่ย้อนไป step ที่จบแล้ว
  const next = await stale.runOnce();
  assert.equal(next.kind === 'STEP_SUCCEEDED' && next.stepKey, 'PLAN_BOOTSTRAP');
});

test('restart ระหว่าง readiness กับ final transaction: worker ถัดไป finalize ต่อได้ครั้งเดียว', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const worker = s.worker();
  for (let index = 0; index < 5; index += 1)
    assert.equal((await worker.runOnce()).kind, 'STEP_SUCCEEDED');
  // "crash" หลัง READINESS receipt ก่อน final transaction: request ยัง RUNNING ทุก step SUCCEEDED
  const between = await state(s, accepted.requestId);
  assert.deepEqual([between.status, between.lifecycle], ['RUNNING', 'PROVISIONING']);
  const results = await Promise.all([
    s.worker('worker-b').runOnce(),
    s.worker('worker-c').runOnce(),
  ]);
  assert.equal(results.filter((result) => result.kind === 'COMPLETED').length, 1);
  const final = await state(s, accepted.requestId);
  assert.deepEqual([final.status, final.lifecycle], ['SUCCEEDED', 'ACTIVE']);
});

test('attempt exhaustion: 5 attempts ใน budget แล้ว ACTION_REQUIRED ไม่ใช่ FAILED_FINAL', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.fakes.systems.KEYCLOAK_ORGANIZATION.fail(
    'transient',
    'transient',
    'transient',
    'transient',
    'transient',
  );
  const worker = s.worker();
  const kinds: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    kinds.push((await worker.runOnce()).kind);
    // พ้น backoff ทุกรอบแต่รวมแล้วยังไม่ถึง deadline 30 นาที
    s.advance(3 * 60_000);
  }
  assert.deepEqual(kinds, [
    'RETRY_SCHEDULED',
    'RETRY_SCHEDULED',
    'RETRY_SCHEDULED',
    'RETRY_SCHEDULED',
    'ACTION_REQUIRED',
  ]);
  const escalated = await state(s, accepted.requestId);
  assert.deepEqual([escalated.status, escalated.lifecycle], ['ACTION_REQUIRED', 'PROVISIONING']);
  assert.equal(escalated.request.failureCode, 'ATTEMPTS_EXHAUSTED');
  assert.equal((await worker.runOnce()).kind, 'IDLE', 'ACTION_REQUIRED ไม่ถูก retry เอง');
});

test('deadline 30 นาที: เกินแล้ว ACTION_REQUIRED ก่อนแตะระบบภายนอก', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.advance(31 * 60_000);
  const result = await s.worker().runOnce();
  assert.deepEqual(result, {
    kind: 'ACTION_REQUIRED',
    requestId: accepted.requestId,
    stepKey: 'KEYCLOAK_ORGANIZATION',
    code: 'DEADLINE_EXCEEDED',
  });
  assert.equal(s.fakes.systems.KEYCLOAK_ORGANIZATION.executeCalls, 0);
});

test('correlation mismatch: resource ชื่อเดียวกันของคนอื่นไม่ถูกยึด → ACTION_REQUIRED; Reconcile ถูกปฏิเสธพร้อม audit', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.fakes.systems.KEYCLOAK_ORGANIZATION.foreign({
    operationKey: `${accepted.requestId}:KEYCLOAK_ORGANIZATION`,
  });
  const result = await s.worker().runOnce();
  assert.equal(result.kind === 'ACTION_REQUIRED' && result.code, 'CORRELATION_MISMATCH');
  assert.equal(s.fakes.systems.KEYCLOAK_ORGANIZATION.executeCalls, 0);
  await rejectsWith(recover(s, accepted.requestId, 'RECONCILE'), 'RECOVERY_PRECONDITION_FAILED');
  await rejectsWith(recover(s, accepted.requestId, 'RETRY_STEP'), 'RECOVERY_PRECONDITION_FAILED');
  const history = await s.f.repository().listActionHistory({ tenantId: accepted.tenantId });
  assert.deepEqual(
    // นาฬิกาของเทสต์คงที่ จึงเทียบเป็นชุดไม่ขึ้นกับลำดับ
    history
      .filter((row) => row.outcome === 'REJECTED')
      .map((row) => `${row.action}:${row.errorCode}`)
      .sort(),
    ['RECONCILE:CORRELATION_MISMATCH', 'RETRY_STEP:RESOURCE_MAY_EXIST'],
  );
});

test('readiness failure: tenant ไม่เป็น ACTIVE และ request รอ operator', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.fakes.systems.READINESS.result = 'FAIL';
  const results = await s.worker().drain();
  const last = results.at(-1);
  assert.ok(last?.kind === 'ACTION_REQUIRED' && last.stepKey === 'READINESS', JSON.stringify(last));
  const final = await state(s, accepted.requestId);
  assert.deepEqual([final.status, final.lifecycle], ['ACTION_REQUIRED', 'PROVISIONING']);
});

test('recovery Reconcile: resource ที่มีจริงถูก adopt แล้ว saga เดินต่อจนจบ', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.fakes.systems.KEYCLOAK_ORGANIZATION.fail(
    'lostResponse',
    'transient',
    'transient',
    'transient',
    'transient',
  );
  const worker = s.worker('worker-a', { maxAttempts: 1 });
  assert.equal((await worker.runOnce()).kind, 'ACTION_REQUIRED');

  const preview = await s.recovery.preview({ requestId: accepted.requestId, action: 'RECONCILE' });
  assert.deepEqual(
    [preview.allowed, preview.finding, preview.stepKey],
    [true, 'FOUND', 'KEYCLOAK_ORGANIZATION'],
  );
  const reconciled = await recover(s, accepted.requestId, 'RECONCILE');
  assert.equal(reconciled.status, 'RUNNING');
  await s.worker().drain();
  const final = await state(s, accepted.requestId);
  assert.deepEqual([final.status, final.lifecycle], ['SUCCEEDED', 'ACTIVE']);
  assert.equal(s.fakes.systems.KEYCLOAK_ORGANIZATION.created, 1);
  const actions = (
    await s.f.repository().listActionHistory({ tenantId: accepted.tenantId, limit: 200 })
  ).filter((row) => row.action === 'RECONCILE');
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.reasonCode, 'OPERATOR_VERIFIED');
  assert.equal(actions[0]!.actorSubject, OPERATOR.subject);
});

test('recovery Retry: เฉพาะเมื่อ resource ไม่มีจริง เปิดงบ attempt/deadline ใหม่ และไม่ข้าม step', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.fakes.systems.KEYCLOAK_ORGANIZATION.fail('permanent');
  assert.equal((await s.worker().runOnce()).kind, 'ACTION_REQUIRED');
  const before = await state(s, accepted.requestId);
  s.advance(40 * 60_000);

  // Reconcile ตอนไม่มี resource = ไม่เปลี่ยนสถานะ
  const nothing = await recover(s, accepted.requestId, 'RECONCILE');
  assert.equal(nothing.status, 'ACTION_REQUIRED');

  const retried = await recover(s, accepted.requestId, 'RETRY_STEP');
  assert.deepEqual(retried, {
    action: 'RETRY_STEP',
    status: 'RUNNING',
    revision: before.revision + 1,
  });
  const after = await state(s, accepted.requestId);
  assert.equal(
    after.step('KEYCLOAK_ORGANIZATION').attemptFloor,
    before.step('KEYCLOAK_ORGANIZATION').attempt,
  );
  assert.ok(after.request.deadlineAt.getTime() > s.now().getTime(), 'deadline ใหม่');
  // step ถัดไปยังไม่ถูกแตะ
  assert.equal(after.steps.PLAN_BOOTSTRAP, 'PENDING');
  await s.worker().drain();
  assert.deepEqual((await state(s, accepted.requestId)).status, 'SUCCEEDED');
});

test('recovery Safe compensate: เฉพาะ resource ที่พิสูจน์ ownership และ step ที่รองรับ; ไม่มีก็ถูกปฏิเสธ', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.fakes.systems.KEYCLOAK_ORGANIZATION.fail('lostResponse');
  assert.equal((await s.worker('worker-a', { maxAttempts: 1 }).runOnce()).kind, 'ACTION_REQUIRED');

  const compensated = await recover(s, accepted.requestId, 'SAFE_COMPENSATE');
  assert.equal(compensated.status, 'ACTION_REQUIRED');
  assert.deepEqual(s.fakes.systems.KEYCLOAK_ORGANIZATION.compensated, ['keycloak_organization-1']);
  // resource หายแล้ว → Retry ทำได้
  await recover(s, accepted.requestId, 'RETRY_STEP');
  await s.worker().drain();
  assert.equal((await state(s, accepted.requestId)).status, 'SUCCEEDED');
  assert.equal(s.fakes.systems.KEYCLOAK_ORGANIZATION.created, 2);

  // invitation ชดเชยไม่ได้ — ต้องไม่มีทาง destructive
  const other = await s.accept();
  s.fakes.systems.INVITATION.fail('lostResponse');
  await s.worker('worker-z', { maxAttempts: 1 }).drain();
  const preview = await s.recovery.preview({
    requestId: other.requestId,
    action: 'SAFE_COMPENSATE',
  });
  assert.deepEqual(
    [preview.stepKey, preview.allowed, preview.blockedBy],
    ['INVITATION', false, 'COMPENSATION_UNSUPPORTED'],
  );
});

test('recovery guards: preview เก่า, revision เก่า, ไม่มี reason/comment และ request ที่ไม่ใช่ ACTION_REQUIRED ถูกปฏิเสธ', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  // ยังไม่ ACTION_REQUIRED
  await rejectsWith(
    recover(s, accepted.requestId, 'MARK_FAILED_FINAL'),
    'INVALID_STATE_TRANSITION',
  );

  s.fakes.systems.KEYCLOAK_ORGANIZATION.fail('permanent');
  await s.worker().runOnce();
  const preview = await s.recovery.preview({ requestId: accepted.requestId, action: 'RETRY_STEP' });
  await rejectsWith(
    recover(s, accepted.requestId, 'RETRY_STEP', { reasonCode: 'bad reason' }),
    'VALIDATION_FAILED',
  );
  await rejectsWith(
    recover(s, accepted.requestId, 'RETRY_STEP', { comment: '  ' }),
    'VALIDATION_FAILED',
  );
  await rejectsWith(
    recover(s, accepted.requestId, 'RETRY_STEP', { expectedRevision: preview.revision - 1 }),
    'REVISION_CONFLICT',
  );
  // สถานะภายนอกเปลี่ยนหลัง preview → digest ไม่ตรง
  s.fakes.systems.KEYCLOAK_ORGANIZATION.resources.set(
    `${accepted.requestId}:KEYCLOAK_ORGANIZATION`,
    {
      externalRef: 'appeared-later',
      tenantId: accepted.tenantId,
      requestId: accepted.requestId,
    },
  );
  await rejectsWith(
    s.recovery.execute({
      requestId: accepted.requestId,
      action: 'RETRY_STEP',
      expectedRevision: preview.revision,
      previewDigest: preview.previewDigest,
      reasonCode: 'OPERATOR_VERIFIED',
      comment: 'x',
      actor: OPERATOR,
      correlationId: 'c',
    }),
    'PREVIEW_STALE',
  );
  await rejectsWith(recover(s, randomUUID(), 'RETRY_STEP'), 'NOT_FOUND');
});

test('recovery Mark FAILED_FINAL: ต้องมี reason; เก็บ ledger และ tombstone reservation', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  s.fakes.systems.KEYCLOAK_ORGANIZATION.fail('permanent');
  await s.worker().runOnce();
  const failed = await recover(s, accepted.requestId, 'MARK_FAILED_FINAL', {
    reasonCode: 'CUSTOMER_WITHDREW',
  });
  assert.equal(failed.status, 'FAILED_FINAL');
  const final = await state(s, accepted.requestId);
  assert.deepEqual(
    [final.status, final.lifecycle, final.request.failureCode],
    ['FAILED_FINAL', 'PROVISIONING', 'CUSTOMER_WITHDREW'],
  );
  const reservations = await s.f.owner.pfIdentityReservation.findMany({
    where: { requestId: accepted.requestId },
  });
  assert.ok(reservations.every((row) => row.state === 'TOMBSTONED'));
  assert.equal((await s.worker().runOnce()).kind, 'IDLE');
});
