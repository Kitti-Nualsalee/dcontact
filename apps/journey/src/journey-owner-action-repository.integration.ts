import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  JourneyOwnerActionRepository,
  OwnerActionHashConflictError,
  OwnerActionNotFoundError,
  type EnsureOwnerActionInput,
} from './journey-owner-action-repository.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.3 owner action ${suffix}`,
      slug: `j2-3-owner-action-${suffix}`,
      sipDomain: `${suffix}.j2-3-owner-action.test`,
    },
  });
  t.after(async () => {
    await owner.jrOwnerResultInbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return { owner, application, tenantId };
}

function ensureInput(
  tenantId: string,
  overrides: Partial<EnsureOwnerActionInput> = {},
): EnsureOwnerActionInput {
  const enrollmentId = randomUUID();
  return {
    tenantId,
    actionKey: `${enrollmentId}:1:ensure-case`,
    enrollmentId,
    kind: 'ENSURE_CASE',
    requestHash: 'a'.repeat(64),
    correlationId: 'corr-1',
    commandId: randomUUID(),
    ...overrides,
  };
}

test('ensureAction สร้าง PENDING action พร้อม command แรก และ retry ด้วย hash เดิมไม่สร้างซ้ำ', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = ensureInput(f.tenantId);

  const first = await repository.ensureAction(input);
  assert.equal(first.isNew, true);
  assert.equal(first.action.state, 'PENDING');
  assert.equal(await f.owner.jrOwnerCommandOutbox.count({ where: { tenantId: f.tenantId } }), 1);

  const retry = await repository.ensureAction(input);
  assert.equal(retry.isNew, false);
  assert.equal(retry.action.id, first.action.id);
  assert.equal(await f.owner.jrOwnerAction.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.jrOwnerCommandOutbox.count({ where: { tenantId: f.tenantId } }), 1);
});

test('actionKey เดิมกับ requestHash ต่างถูกปฏิเสธเป็น IDEMPOTENCY_CONFLICT', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = ensureInput(f.tenantId);
  await repository.ensureAction(input);

  await assert.rejects(
    () =>
      repository.ensureAction({ ...input, requestHash: 'b'.repeat(64), commandId: randomUUID() }),
    (error: unknown) => {
      assert.ok(error instanceof OwnerActionHashConflictError);
      return true;
    },
  );
});

test('markCommandDispatched เลื่อน command เป็น SENT และ action เป็น DISPATCHED', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = ensureInput(f.tenantId);
  await repository.ensureAction(input);

  const command = await repository.markCommandDispatched(f.tenantId, input.commandId);
  assert.equal(command.state, 'SENT');
  const action = await repository.getAction(f.tenantId, input.actionKey);
  assert.equal(action?.state, 'DISPATCHED');
});

test('applyResult ACKNOWLEDGED เปลี่ยน action จาก DISPATCHED และ retry เดิมเป็น DUPLICATE', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = ensureInput(f.tenantId);
  await repository.ensureAction(input);
  await repository.markCommandDispatched(f.tenantId, input.commandId);

  const resultInput = {
    tenantId: f.tenantId,
    commandId: input.commandId,
    actionKey: input.actionKey,
    resultKind: 'ACKNOWLEDGED' as const,
    resultHash: 'r'.repeat(64),
    correlationId: 'corr-result',
    ownerAggregateRef: 'case-123',
    ownerAggregateVersion: 1,
  };
  const applied = await repository.applyResult(resultInput);
  assert.equal(applied.outcome, 'APPLIED');
  assert.equal(applied.action.state, 'ACKNOWLEDGED');
  assert.ok(applied.action.acknowledgedAt);
  assert.equal(applied.action.ownerAggregateRef, 'case-123');

  const duplicate = await repository.applyResult(resultInput);
  assert.equal(duplicate.outcome, 'DUPLICATE');
  assert.equal(duplicate.action.state, 'ACKNOWLEDGED');
});

test('applyResult เดิมกับ resultHash ต่างคืน CONFLICT โดยไม่ย้อน state', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = ensureInput(f.tenantId);
  await repository.ensureAction(input);
  await repository.markCommandDispatched(f.tenantId, input.commandId);

  const base = {
    tenantId: f.tenantId,
    commandId: input.commandId,
    actionKey: input.actionKey,
    correlationId: 'corr-result',
  };
  await repository.applyResult({ ...base, resultKind: 'ACKNOWLEDGED', resultHash: 'r'.repeat(64) });
  const conflicted = await repository.applyResult({
    ...base,
    resultKind: 'REJECTED',
    resultHash: 'x'.repeat(64),
  });
  assert.equal(conflicted.outcome, 'CONFLICT');
  assert.equal(conflicted.action.state, 'ACKNOWLEDGED', 'terminal ที่ commit แล้วต้องไม่ถูกย้อน');
});

test('ผลที่มาช้าหลัง action เข้า terminal แล้วถูกเพิกเฉยและไม่ย้อน state', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = ensureInput(f.tenantId);
  await repository.ensureAction(input);
  await repository.markCommandDispatched(f.tenantId, input.commandId);
  await repository.applyResult({
    tenantId: f.tenantId,
    commandId: input.commandId,
    actionKey: input.actionKey,
    resultKind: 'ACKNOWLEDGED',
    resultHash: 'r'.repeat(64),
    correlationId: 'corr-result',
  });

  // duplicate command ใบใหม่ (เช่น dispatch ซ้ำที่หลุดมา) รายงานผลต่างมาทีหลัง
  const lateCommandId = randomUUID();
  const late = await repository.applyResult({
    tenantId: f.tenantId,
    commandId: lateCommandId,
    actionKey: input.actionKey,
    resultKind: 'REJECTED',
    resultHash: 'z'.repeat(64),
    correlationId: 'corr-late',
  });
  assert.equal(late.outcome, 'TERMINAL_IGNORED');
  assert.equal(late.action.state, 'ACKNOWLEDGED');
});

test('requestCancellation ขอ cancel ได้เฉพาะ state ที่ยัง reversible และ idempotent ต่อ state เดิม', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = ensureInput(f.tenantId);
  await repository.ensureAction(input);
  await repository.markCommandDispatched(f.tenantId, input.commandId);

  const cancelCommandId = randomUUID();
  const cancelled = await repository.requestCancellation({
    tenantId: f.tenantId,
    actionKey: input.actionKey,
    cancelCommandId,
    correlationId: 'corr-cancel',
  });
  assert.equal(cancelled.state, 'CANCEL_REQUESTED');
  assert.ok(cancelled.cancelRequestedAt);
  assert.equal(
    await f.owner.jrOwnerCommandOutbox.count({
      where: { tenantId: f.tenantId, commandId: cancelCommandId },
    }),
    1,
  );

  // เรียกซ้ำ (retry) ต้อง idempotent — ไม่ throw ไม่สร้าง command ซ้ำ
  const repeated = await repository.requestCancellation({
    tenantId: f.tenantId,
    actionKey: input.actionKey,
    cancelCommandId: randomUUID(),
    correlationId: 'corr-cancel-2',
  });
  assert.equal(repeated.state, 'CANCEL_REQUESTED');
  assert.equal(await f.owner.jrOwnerCommandOutbox.count({ where: { tenantId: f.tenantId } }), 2);
});

test('CANCEL_REQUESTED ที่ owner ตอบ TOO_LATE บันทึกผลจริงและหยุด future action', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = ensureInput(f.tenantId, { kind: 'ADMIT_CAMPAIGN_TARGET' });
  await repository.ensureAction(input);
  await repository.markCommandDispatched(f.tenantId, input.commandId);
  await repository.requestCancellation({
    tenantId: f.tenantId,
    actionKey: input.actionKey,
    cancelCommandId: randomUUID(),
    correlationId: 'corr-cancel',
  });

  const tooLateCommandId = randomUUID();
  const result = await repository.applyResult({
    tenantId: f.tenantId,
    commandId: tooLateCommandId,
    actionKey: input.actionKey,
    resultKind: 'TOO_LATE',
    resultHash: 't'.repeat(64),
    correlationId: 'corr-too-late',
    ownerAggregateRef: 'record-999',
  });
  assert.equal(result.outcome, 'APPLIED');
  assert.equal(result.action.state, 'TOO_LATE');
  assert.equal(result.action.ownerAggregateRef, 'record-999');
});

test('ownerActionที่ไม่มีอยู่จริงถูกปฏิเสธเป็น ACTION_NOT_FOUND', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);

  await assert.rejects(
    () =>
      repository.applyResult({
        tenantId: f.tenantId,
        commandId: randomUUID(),
        actionKey: 'ไม่มีจริง',
        resultKind: 'ACKNOWLEDGED',
        resultHash: 'a'.repeat(64),
        correlationId: 'corr-missing',
      }),
    (error: unknown) => {
      assert.ok(error instanceof OwnerActionNotFoundError);
      return true;
    },
  );
});

test('tenant คนละใบไม่เห็น owner action ของกันและกัน', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const repository = new JourneyOwnerActionRepository(a.application);
  const otherRepository = new JourneyOwnerActionRepository(b.application);
  const input = ensureInput(a.tenantId);
  await repository.ensureAction(input);

  const otherView = await otherRepository.getAction(b.tenantId, input.actionKey);
  assert.equal(otherView, null);
});
