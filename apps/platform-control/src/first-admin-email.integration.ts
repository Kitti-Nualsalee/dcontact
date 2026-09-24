/**
 * A1.5b (#441) บน Postgres จริง: แก้อีเมล first admin ก่อน identity step สำเร็จ
 *
 * ครอบ acceptance: แก้ได้ก่อน FIRST_ADMIN เริ่ม/เมื่อชน, ล็อกหลังเริ่มจริงหรือสำเร็จ, อีเมลที่ชน
 * reservation อื่นได้ code คงที่, reservation เดิม TOMBSTONED และไม่มี raw email ใน audit/evidence
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PlatformProvisioningError, type PlatformProvisioningErrorCode } from '@d-contact/shared';
import { createPlatformFixture, OPERATOR, SIP_BASE } from './platform-fixture.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { platformIdentityHash } from './provisioning-input.js';
import { ProvisioningRecoveryService } from './provisioning-recovery.js';
import { ProvisioningRequestEditor } from './provisioning-request-editor.js';
import { ProvisioningSagaWorker, type ProvisioningStepPort } from './provisioning-saga.js';

const TAKEN = 'someone-else@example.test';

async function setup(t: TestContext) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const tenants: string[] = [];
  const fakes = createFakeProvisioningPorts();
  // identity ภายนอกที่มีอยู่แล้วของคนอื่น: find บอก MISMATCH ก่อนสร้างอะไร (แบบ FirstAdminPort จริง)
  const firstAdmin: ProvisioningStepPort = {
    find: async (context) =>
      context.request.firstAdminEmail === TAKEN
        ? { status: 'MISMATCH', code: 'FIRST_ADMIN_EMAIL_CONFLICT' }
        : fakes.systems.FIRST_ADMIN.find(context),
    execute: (context, signal) => fakes.systems.FIRST_ADMIN.execute(context, signal),
  };
  const ports = { ...fakes.ports, FIRST_ADMIN: firstAdmin };
  const saga = new ProvisioningSagaWorker(f.platform, ports, {
    workerId: `email-${randomUUID().slice(0, 8)}`,
    sipBaseDomain: SIP_BASE,
    scope: () => ({ tenantId: { in: [...tenants] } }),
    backoffBaseMs: 1,
    backoffMaxMs: 1,
  });
  const recovery = new ProvisioningRecoveryService(f.platform, ports, { sipBaseDomain: SIP_BASE });
  const editor = new ProvisioningRequestEditor(f.platform);
  const accept = async (overrides: Parameters<typeof f.input>[0] = {}) => {
    const input = f.input(overrides);
    const key = `idem-${randomUUID()}`;
    const result = await f.repository().accept({
      idempotencyKey: key,
      input,
      plan: f.plan,
      actor: OPERATOR,
      correlationId: `corr-${key}`,
    });
    f.track(result.tenantId);
    tenants.push(result.tenantId);
    return { ...result, input };
  };
  const request = (requestId: string) =>
    f.owner.pfProvisioningRequest.findUniqueOrThrow({
      where: { id: requestId },
      include: { steps: true },
    });
  const change = async (
    requestId: string,
    email: string,
    overrides: Record<string, unknown> = {},
  ) =>
    editor.edit({
      requestId,
      expectedRevision: (await request(requestId)).revision,
      changes: { firstAdminEmail: email },
      reasonCode: 'CUSTOMER_CORRECTION',
      comment: 'ลูกค้าแจ้งอีเมลผู้ดูแลใหม่',
      actor: OPERATOR,
      correlationId: 'corr-email',
      ...overrides,
    });
  return { f, saga, recovery, editor, accept, request, change };
}

async function rejectsWith(work: Promise<unknown>, code: PlatformProvisioningErrorCode) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof PlatformProvisioningError, String(error));
    assert.equal(error.code, code);
    return true;
  });
}

const hash = (email: string) => platformIdentityHash('first-admin-email', email);

test('ก่อน FIRST_ADMIN เริ่ม: reserve อีเมลใหม่, tombstone อันเดิม, revision + audit ไม่มี raw email', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const next = `new-admin-${randomUUID().slice(0, 8)}@example.test`;
  const result = await s.change(accepted.requestId, next);
  assert.deepEqual(result.changedFields, ['firstAdminEmail']);

  const after = await s.request(accepted.requestId);
  assert.deepEqual([after.firstAdminEmail, after.firstAdminEmailHash], [next, hash(next)]);
  // payload เดิมของ idempotency ไม่เปลี่ยน
  assert.notEqual(after.payloadDigest, result.payloadDigest);
  const reservations = await s.f.owner.pfIdentityReservation.findMany({
    where: { requestId: accepted.requestId, kind: 'FIRST_ADMIN_EMAIL' },
  });
  assert.deepEqual(
    reservations.map((row) => [row.valueKey, row.state]).sort(),
    [
      [hash(accepted.input.firstAdmin.email), 'TOMBSTONED'],
      [hash(next), 'HELD'],
    ].sort(),
  );
  const [revision] = await s.f.owner.pfFirstAdminEmailRevision.findMany({
    where: { requestId: accepted.requestId },
  });
  assert.deepEqual(
    [revision!.previousEmailHash, revision!.emailHash, revision!.requestRevision],
    [hash(accepted.input.firstAdmin.email), hash(next), after.revision],
  );
  const evidence = JSON.stringify([
    revision,
    await s.f.owner.pfActionHistory.findMany({ where: { requestId: accepted.requestId } }),
  ]);
  assert.equal(evidence.includes(next), false);
  assert.equal(evidence.includes(accepted.input.firstAdmin.email), false);

  // อีเมลเดิมยังถูกกันไว้ 30 วัน: คำขอใหม่ใช้ไม่ได้
  await rejectsWith(
    s.accept({ firstAdmin: { email: accepted.input.firstAdmin.email, displayName: 'X' } }),
    'FIRST_ADMIN_EMAIL_CONFLICT',
  );
  await s.saga.drain();
  assert.equal((await s.request(accepted.requestId)).status, 'SUCCEEDED');
});

test('อีเมลที่ request อื่นถือไว้ = FIRST_ADMIN_EMAIL_CONFLICT (audit) และไม่มีอะไรเปลี่ยน', async (t) => {
  const s = await setup(t);
  const owner = await s.accept();
  const accepted = await s.accept();
  const before = await s.request(accepted.requestId);
  await rejectsWith(
    s.change(accepted.requestId, owner.input.firstAdmin.email),
    'FIRST_ADMIN_EMAIL_CONFLICT',
  );
  const after = await s.request(accepted.requestId);
  assert.deepEqual(
    [after.revision, after.firstAdminEmailHash],
    [before.revision, before.firstAdminEmailHash],
  );
  assert.equal(
    await s.f.owner.pfIdentityReservation.count({
      where: { requestId: accepted.requestId, state: 'TOMBSTONED' },
    }),
    0,
  );
  const rejected = await s.f.owner.pfActionHistory.findFirstOrThrow({
    where: { requestId: accepted.requestId, action: 'REQUEST_EDITED', outcome: 'REJECTED' },
  });
  assert.equal(rejected.errorCode, 'FIRST_ADMIN_EMAIL_CONFLICT');
});

test('ชนกับ identity ภายนอก: ACTION_REQUIRED → แก้อีเมล → Retry ผ่าน preview แล้วจบ', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept({ firstAdmin: { email: TAKEN, displayName: 'Taken' } });
  await s.saga.drain();
  const stuck = await s.request(accepted.requestId);
  assert.deepEqual(
    [stuck.status, stuck.failureCode],
    ['ACTION_REQUIRED', 'FIRST_ADMIN_EMAIL_CONFLICT'],
  );
  await s.change(accepted.requestId, `fixed-${randomUUID().slice(0, 8)}@example.test`);

  const preview = await s.recovery.preview({ requestId: accepted.requestId, action: 'RETRY_STEP' });
  assert.deepEqual([preview.allowed, preview.finding], [true, 'NOT_FOUND']);
  await s.recovery.execute({
    requestId: accepted.requestId,
    action: 'RETRY_STEP',
    expectedRevision: preview.revision,
    previewDigest: preview.previewDigest,
    reasonCode: 'OPERATOR_VERIFIED',
    comment: 'แก้อีเมลแล้ว',
    actor: OPERATOR,
    correlationId: 'corr-retry',
  });
  await s.saga.drain();
  assert.equal((await s.request(accepted.requestId)).status, 'SUCCEEDED');
});

test('ล็อก: หลัง FIRST_ADMIN เริ่มจริงหรือสำเร็จ, แก้ร่วมกับ field อื่น, อีเมลเดิม และ guard ของ DB', async (t) => {
  const s = await setup(t);
  const done = await s.accept();
  await s.saga.drain();
  // request ที่จบแล้ว = state ไม่อนุญาต; ตรวจล็อกของ step ด้วย request ที่ FIRST_ADMIN สำเร็จแต่ยังไม่จบ
  await rejectsWith(s.change(done.requestId, 'late@example.test'), 'INVALID_STATE_TRANSITION');

  const accepted = await s.accept();
  const request = await s.request(accepted.requestId);
  await rejectsWith(
    s.editor.edit({
      requestId: accepted.requestId,
      expectedRevision: request.revision,
      changes: { firstAdminEmail: 'x@example.test', displayName: 'Other' },
      reasonCode: 'CUSTOMER_CORRECTION',
      comment: 'แก้หลายช่อง',
      actor: OPERATOR,
      correlationId: 'corr-multi',
    }),
    'VALIDATION_FAILED',
  );
  await rejectsWith(
    s.change(accepted.requestId, accepted.input.firstAdmin.email),
    'VALIDATION_FAILED',
  );

  // FIRST_ADMIN เคยเริ่มแล้ว (attempt > 0) และหยุดด้วยเหตุผลอื่น = อาจมี identity ภายนอกแล้ว → ล็อก
  await s.f.owner.pfProvisioningStep.update({
    where: { requestId_stepKey: { requestId: accepted.requestId, stepKey: 'FIRST_ADMIN' } },
    data: {
      state: 'ACTION_REQUIRED',
      attempt: 1,
      errorCode: 'DEPENDENCY_REJECTED',
      revision: { increment: 1 },
    },
  });
  await rejectsWith(s.change(accepted.requestId, 'another@example.test'), 'FIELD_LOCKED');

  // guard ใน DB บังคับซ้ำแม้เรียกตรงด้วย role ของ platform
  await assert.rejects(
    s.f.platform.pfProvisioningRequest.update({
      where: { id: accepted.requestId },
      data: { firstAdminEmailHash: hash('bypass@example.test'), revision: { increment: 1 } },
    }),
    /PF_FIRST_ADMIN_EMAIL_LOCKED/,
  );
  const fresh = await s.accept();
  await assert.rejects(
    s.f.platform.pfProvisioningRequest.update({
      where: { id: fresh.requestId },
      data: { firstAdminEmailHash: hash('unreserved@example.test'), revision: { increment: 1 } },
    }),
    /PF_FIRST_ADMIN_EMAIL_UNRESERVED/,
  );
});
