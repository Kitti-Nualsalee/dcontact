import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  assertOwnerRequestHash,
  campaignId,
  commandId as toCommandId,
  contactId,
  enrollmentId as toEnrollmentId,
  interactionId,
  journeyId,
  outcomeId,
  teamId,
  tenantId as toTenantId,
  validateOwnerCommandPayload,
  withOwnerRequestHash,
} from '@d-contact/cxa-contracts';
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

/** action ที่มี command payload จริงตาม contract — cancel ต้องสร้างจาก payload ต้นฉบับนี้ */
function dialerActionInput(tenantId: string): EnsureOwnerActionInput {
  const enrollment = randomUUID();
  const rawActionKey = `${enrollment}:1:admit-campaign`;
  const command = withOwnerRequestHash(toTenantId(tenantId), {
    contractVersion: 1,
    commandId: toCommandId(randomUUID()),
    actionKey: toActionKey(rawActionKey),
    journeyId: journeyId(randomUUID()),
    journeyVersion: 1,
    enrollmentId: toEnrollmentId(enrollment),
    stepId: 'admit-campaign',
    sourceOutcome: {
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      outcomeId: outcomeId(randomUUID()),
      outcomeVersion: 1,
    },
    interactionId: interactionId(randomUUID()),
    contactId: contactId(randomUUID()),
    sourceOwnerTeamId: teamId(randomUUID()),
    targetOwnerTeamId: teamId(randomUUID()),
    commandType: 'ADMIT_CAMPAIGN_TARGET',
    intent: { campaignId: campaignId('campaign-collections') },
  });
  return {
    tenantId,
    actionKey: rawActionKey,
    enrollmentId: enrollment,
    kind: 'ADMIT_CAMPAIGN_TARGET',
    requestHash: command.requestHash,
    correlationId: 'corr-1',
    commandId: command.commandId,
    commandPayload: command,
  };
}

async function cancelCommandOf(
  f: Awaited<ReturnType<typeof fixture>>,
  input: EnsureOwnerActionInput,
) {
  const rows = await f.owner.jrOwnerCommandOutbox.findMany({
    where: {
      tenantId: f.tenantId,
      actionKey: input.actionKey,
      NOT: { commandId: input.commandId },
    },
  });
  assert.equal(rows.length, 1);
  return rows[0]!;
}

test('cancel ก่อน command ออกจาก Journey ยกเลิกในบ้านทันที ไม่ส่ง cancel ไปรบกวน owner', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = dialerActionInput(f.tenantId);
  await repository.ensureAction(input);

  const cancelled = await repository.requestCancellation({
    tenantId: f.tenantId,
    actionKey: input.actionKey,
    cancelRequestKey: 'exit-rule',
    correlationId: 'corr-cancel',
  });
  assert.equal(cancelled.state, 'CANCELLED');
  const commands = await f.owner.jrOwnerCommandOutbox.findMany({
    where: { tenantId: f.tenantId },
  });
  assert.deepEqual(
    commands.map(({ state }) => state),
    ['CANCELLED'],
    'command เดิมต้องไม่ถูก dispatch และไม่มี cancel command เกิดขึ้น',
  );
  assert.equal((await repository.findPendingCommands(f.tenantId)).length, 0);
});

test('cancel หลัง dispatch stage CANCEL_x ตาม contract และคำขอซ้ำได้ command ใบเดิม', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = dialerActionInput(f.tenantId);
  await repository.ensureAction(input);
  await repository.markCommandDispatched(f.tenantId, input.commandId);

  const cancelled = await repository.requestCancellation({
    tenantId: f.tenantId,
    actionKey: input.actionKey,
    cancelRequestKey: 'outcome-corrected',
    reasonCode: 'OUTCOME_CORRECTED',
    correlationId: 'corr-cancel',
  });
  assert.equal(cancelled.state, 'CANCEL_REQUESTED');
  assert.ok(cancelled.cancelRequestedAt);

  const staged = await cancelCommandOf(f, input);
  const payload = assertOwnerRequestHash(toTenantId(f.tenantId), staged.payload);
  assert.equal(payload.commandType, 'CANCEL_CAMPAIGN_TARGET');
  assert.equal(payload.actionKey, input.actionKey);
  assert.equal(payload.commandId, staged.commandId);
  assert.equal(staged.requestHash, payload.requestHash);
  assert.notEqual(staged.requestHash, input.requestHash);

  // retry ของคำขอเดิมหรือคำขอใหม่หลัง CANCEL_REQUESTED ไม่สร้าง command เพิ่ม
  for (const key of ['outcome-corrected', 'another-request']) {
    const repeated = await repository.requestCancellation({
      tenantId: f.tenantId,
      actionKey: input.actionKey,
      cancelRequestKey: key,
      correlationId: 'corr-cancel-2',
    });
    assert.equal(repeated.state, 'CANCEL_REQUESTED');
  }
  assert.equal(await f.owner.jrOwnerCommandOutbox.count({ where: { tenantId: f.tenantId } }), 2);
});

test('supersede stage SUPERSEDE_x พร้อม superseding outcome linkage', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = dialerActionInput(f.tenantId);
  await repository.ensureAction(input);
  await repository.markCommandDispatched(f.tenantId, input.commandId);
  const supersedingOutcome = {
    outcomeType: 'INTERACTION_DISPOSITION_RECORDED' as const,
    outcomeId: outcomeId(randomUUID()),
    outcomeVersion: 2,
  };

  await repository.requestCancellation({
    tenantId: f.tenantId,
    actionKey: input.actionKey,
    cancelRequestKey: 'superseded',
    reasonCode: 'OUTCOME_CORRECTED',
    supersedingOutcome,
    correlationId: 'corr-supersede',
  });
  const payload = validateOwnerCommandPayload((await cancelCommandOf(f, input)).payload);
  assert.equal(payload.commandType, 'SUPERSEDE_CAMPAIGN_TARGET');
  assert.deepEqual(
    (payload.intent as { supersedingOutcome: unknown }).supersedingOutcome,
    supersedingOutcome,
  );
});

test('ENSURE_CASE ที่ออกไปแล้วไม่มี cancel contract — Case ที่ owner อาจ commit แล้วต้องคงอยู่', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = ensureInput(f.tenantId);
  await repository.ensureAction(input);
  await repository.markCommandDispatched(f.tenantId, input.commandId);

  const unchanged = await repository.requestCancellation({
    tenantId: f.tenantId,
    actionKey: input.actionKey,
    cancelRequestKey: 'exit',
    correlationId: 'corr-cancel',
  });
  assert.equal(unchanged.state, 'DISPATCHED');
  assert.equal(await f.owner.jrOwnerCommandOutbox.count({ where: { tenantId: f.tenantId } }), 1);
});

test('ผลสำเร็จของ command เดิมที่มาระหว่าง CANCEL_REQUESTED ไม่ปิด action ก่อนผลของ cancel', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);
  const input = dialerActionInput(f.tenantId);
  await repository.ensureAction(input);
  await repository.markCommandDispatched(f.tenantId, input.commandId);
  await repository.requestCancellation({
    tenantId: f.tenantId,
    actionKey: input.actionKey,
    cancelRequestKey: 'corrected',
    correlationId: 'corr-cancel',
  });
  const cancel = await cancelCommandOf(f, input);

  const admitted = await repository.applyResult({
    tenantId: f.tenantId,
    commandId: input.commandId,
    actionKey: input.actionKey,
    resultKind: 'ACKNOWLEDGED',
    resultHash: 'a'.repeat(64),
    correlationId: 'corr-admitted',
    ownerAggregateRef: 'target-1',
    ownerAggregateVersion: 1,
  });
  assert.equal(admitted.outcome, 'APPLIED');
  assert.equal(admitted.action.state, 'CANCEL_REQUESTED');
  assert.equal(admitted.action.ownerAggregateRef, 'target-1');

  const cancelled = await repository.applyResult({
    tenantId: f.tenantId,
    commandId: cancel.commandId,
    actionKey: input.actionKey,
    resultKind: 'CANCELLED',
    resultHash: 'c'.repeat(64),
    correlationId: 'corr-cancelled',
    ownerAggregateRef: 'target-1',
    ownerAggregateVersion: 2,
  });
  assert.equal(cancelled.outcome, 'APPLIED');
  assert.equal(cancelled.action.state, 'CANCELLED');
  assert.equal(cancelled.action.ownerAggregateVersion, 2);
});

test('owner ตอบ TOO_LATE ต่อ cancel บันทึกผลจริง ส่วน cancel ที่ถูกปฏิเสธเข้า RECONCILING', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOwnerActionRepository(f.application);

  for (const [resultKind, expected] of [
    ['TOO_LATE', 'TOO_LATE'],
    ['REJECTED', 'RECONCILING'],
  ] as const) {
    const input = dialerActionInput(f.tenantId);
    await repository.ensureAction(input);
    await repository.markCommandDispatched(f.tenantId, input.commandId);
    await repository.requestCancellation({
      tenantId: f.tenantId,
      actionKey: input.actionKey,
      cancelRequestKey: 'corrected',
      correlationId: 'corr-cancel',
    });
    const cancel = await cancelCommandOf(f, input);

    const result = await repository.applyResult({
      tenantId: f.tenantId,
      commandId: cancel.commandId,
      actionKey: input.actionKey,
      resultKind,
      resultHash: 't'.repeat(64),
      correlationId: 'corr-result',
      ownerAggregateRef: 'record-999',
    });
    assert.equal(result.outcome, 'APPLIED');
    assert.equal(result.action.state, expected, `${resultKind} ของ cancel command`);
  }
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
