import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  actionKey,
  commandId,
  contactId,
  enrollmentId,
  interactionId,
  journeyId,
  outcomeId,
  teamId,
  tenantId as toTenantId,
  assertOwnerRequestHash,
  withOwnerRequestHash,
  type CancelOwnerActionIntentV1,
  type J2DialerOwnerCommandV1,
  type ScheduleCallbackIntentV1,
  type SupersedeOwnerActionIntentV1,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import {
  DialerCallbackService,
  CallbackCommandHashConflictError,
} from './dialer-callback-service.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const allowAllScope: TeamContactScopeAuthorizer = {
  async authorize(input) {
    return { decision: 'ALLOW', scopeVersion: 1, evaluatedAt: input.at };
  },
};

const HOUR_MS = 60 * 60 * 1_000;

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const rawTenantId = randomUUID();
  const rawSourceTeamId = randomUUID();
  const rawTargetTeamId = randomUUID();
  const rawContactId = randomUUID();
  const rawQueueId = randomUUID();
  const rawAgentId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `J2.6 dialer ${suffix}`,
      slug: `j2-6-dialer-${suffix}`,
      sipDomain: `${suffix}.j2-6-dialer.test`,
    },
  });
  await owner.team.create({
    data: { id: rawSourceTeamId, tenantId: rawTenantId, name: 'Journey' },
  });
  await owner.team.create({ data: { id: rawTargetTeamId, tenantId: rawTenantId, name: 'Dialer' } });
  await owner.contact.create({
    data: { id: rawContactId, tenantId: rawTenantId, displayName: 'J2.6 contact' },
  });
  await owner.queue.create({
    data: { id: rawQueueId, tenantId: rawTenantId, name: 'Collections queue' },
  });
  await owner.user.create({
    data: {
      id: rawAgentId,
      tenantId: rawTenantId,
      email: `agent-${suffix}@example.test`,
      passwordHash: 'x',
      displayName: 'J2.6 agent',
      role: 'AGENT',
    },
  });

  t.after(async () => {
    await owner.obDialerCommandInbox.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.obCallback.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.queue.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.user.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contact.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.team.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  return {
    owner,
    application,
    rawTenantId,
    rawSourceTeamId,
    rawTargetTeamId,
    rawContactId,
    rawQueueId,
    rawAgentId,
  };
}

type ScheduleCommand = Extract<J2DialerOwnerCommandV1, { intent: ScheduleCallbackIntentV1 }>;
type ScheduleCommandDraft = Omit<ScheduleCommand, 'requestHash'>;

function scheduleCommandFor(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Omit<ScheduleCommandDraft, 'intent'>> & {
    intent?: ScheduleCallbackIntentV1;
  } = {},
): ScheduleCommand {
  const enrollment = randomUUID();
  const draft: ScheduleCommandDraft = {
    contractVersion: 1,
    commandId: commandId(randomUUID()),
    actionKey: actionKey(`${enrollment}:1:schedule-callback`),
    journeyId: journeyId('journey-outbound'),
    journeyVersion: 1,
    enrollmentId: enrollmentId(enrollment),
    stepId: 'schedule-callback',
    sourceOutcome: {
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      outcomeId: outcomeId(randomUUID()),
      outcomeVersion: 1,
    },
    interactionId: interactionId(randomUUID()),
    contactId: contactId(f.rawContactId),
    sourceOwnerTeamId: teamId(f.rawSourceTeamId),
    targetOwnerTeamId: teamId(f.rawTargetTeamId),
    commandType: 'SCHEDULE_CALLBACK',
    intent: {
      requestedFor: new Date(Date.now() + 6 * HOUR_MS).toISOString(),
      queueId: f.rawQueueId,
    },
    ...overrides,
  };
  return withOwnerRequestHash(toTenantId(f.rawTenantId), draft) as ScheduleCommand;
}

type CancelCommand = Extract<J2DialerOwnerCommandV1, { intent: CancelOwnerActionIntentV1 }>;
type SupersedeCommand = Extract<J2DialerOwnerCommandV1, { intent: SupersedeOwnerActionIntentV1 }>;

function cancelCommandFor(
  f: Awaited<ReturnType<typeof fixture>>,
  originalActionKey: string,
): CancelCommand {
  const enrollment = randomUUID();
  // ไม่ประกาศ type ของ draft ตรง ๆ — commandType ของ CancelCommand ใน SDK เป็น union
  // ร่วมกับ CANCEL_CAMPAIGN_TARGET การประกาศ type ตรงจะ widen literal 'CANCEL_CALLBACK'
  // จนไม่ match กับ J2OwnerCommandDraftV1 ปล่อยให้ TS infer จาก literal ผ่าน `as const` แทน
  const draft = {
    contractVersion: 1,
    commandId: commandId(randomUUID()),
    // J2.1 contract: cancel/supersede ใช้ actionKey เดิมของ positive effect แต่ commandId ใหม่
    actionKey: actionKey(originalActionKey),
    journeyId: journeyId('journey-outbound'),
    journeyVersion: 1,
    enrollmentId: enrollmentId(enrollment),
    stepId: 'cancel-callback',
    sourceOutcome: {
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      outcomeId: outcomeId(randomUUID()),
      outcomeVersion: 2,
    },
    interactionId: interactionId(randomUUID()),
    contactId: contactId(f.rawContactId),
    sourceOwnerTeamId: teamId(f.rawSourceTeamId),
    targetOwnerTeamId: teamId(f.rawTargetTeamId),
    commandType: 'CANCEL_CALLBACK',
    intent: { originalActionKey: actionKey(originalActionKey), reasonCode: 'OUTCOME_CORRECTED' },
  } as const;
  return assertOwnerRequestHash(
    toTenantId(f.rawTenantId),
    withOwnerRequestHash(toTenantId(f.rawTenantId), draft),
  ) as CancelCommand;
}

function supersedeCommandFor(
  f: Awaited<ReturnType<typeof fixture>>,
  originalActionKey: string,
): SupersedeCommand {
  const enrollment = randomUUID();
  const draft = {
    contractVersion: 1,
    commandId: commandId(randomUUID()),
    // J2.1 contract: cancel/supersede ใช้ actionKey เดิมของ positive effect แต่ commandId ใหม่
    actionKey: actionKey(originalActionKey),
    journeyId: journeyId('journey-outbound'),
    journeyVersion: 1,
    enrollmentId: enrollmentId(enrollment),
    stepId: 'supersede-callback',
    sourceOutcome: {
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      outcomeId: outcomeId(randomUUID()),
      outcomeVersion: 2,
    },
    interactionId: interactionId(randomUUID()),
    contactId: contactId(f.rawContactId),
    sourceOwnerTeamId: teamId(f.rawSourceTeamId),
    targetOwnerTeamId: teamId(f.rawTargetTeamId),
    commandType: 'SUPERSEDE_CALLBACK',
    intent: {
      originalActionKey: actionKey(originalActionKey),
      reasonCode: 'OUTCOME_CORRECTED',
      supersedingOutcome: {
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        outcomeId: outcomeId(randomUUID()),
        outcomeVersion: 3,
      },
    },
  } as const;
  return assertOwnerRequestHash(
    toTenantId(f.rawTenantId),
    withOwnerRequestHash(toTenantId(f.rawTenantId), draft),
  ) as SupersedeCommand;
}

test('ไม่มี callback เดิม: SCHEDULE_CALLBACK สร้าง record ใหม่และตอบ SCHEDULED', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = scheduleCommandFor(f);

  const persisted = await service.persistCommand(tenant, command);
  assert.equal(persisted.status, 'PERSISTED');

  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'SCHEDULED');
  assert.equal(result?.category, 'BUSINESS');
  assert.equal(result?.ownerAggregate?.type, 'callback');

  const stored = await f.owner.obCallback.findUniqueOrThrow({
    where: { id: result!.ownerAggregate!.id },
  });
  assert.equal(stored.state, 'SCHEDULED');
  assert.equal(stored.queueId, f.rawQueueId);
});

test('retry ด้วย actionKey/requestHash เดิมคืนผลเดิมโดยไม่สร้าง callback ซ้ำ', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = scheduleCommandFor(f);

  await service.persistCommand(tenant, command);
  await service.persistCommand(tenant, command);

  assert.equal(await f.owner.obCallback.count({ where: { tenantId: f.rawTenantId } }), 1);
});

test('actionKey เดิมกับ requestHash ต่างถูกปฏิเสธเป็น IDEMPOTENCY_CONFLICT', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = scheduleCommandFor(f);
  await service.persistCommand(tenant, command);

  const conflicting = withOwnerRequestHash(tenant, {
    ...command,
    intent: { ...command.intent, queueId: randomUUID() },
  }) as ScheduleCommand;
  await assert.rejects(
    () => service.persistCommand(tenant, conflicting),
    (error: unknown) => {
      assert.ok(error instanceof CallbackCommandHashConflictError);
      return true;
    },
  );
});

test('contact ที่มี callback pending อยู่แล้ว: SCHEDULE_CALLBACK ใหม่ตอบ ALREADY_SCHEDULED', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);

  const first = scheduleCommandFor(f);
  await service.persistCommand(tenant, first);
  const firstResult = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: first.actionKey,
    requestHash: first.requestHash,
  });

  const second = scheduleCommandFor(f);
  await service.persistCommand(tenant, second);
  const secondResult = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: second.actionKey,
    requestHash: second.requestHash,
  });
  assert.equal(secondResult?.status, 'ALREADY_SCHEDULED');
  assert.equal(secondResult?.ownerAggregate?.id, firstResult?.ownerAggregate?.id);
  assert.equal(await f.owner.obCallback.count({ where: { tenantId: f.rawTenantId } }), 1);
});

test('requestedFor ในอดีตถูกปฏิเสธเป็น OWNER_REJECTED', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = scheduleCommandFor(f, {
    intent: { requestedFor: new Date(Date.now() - HOUR_MS).toISOString(), queueId: f.rawQueueId },
  });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.reasonCode, 'REQUESTED_TIME_INVALID');
});

test('queueId ที่ไม่มีอยู่จริงถูกปฏิเสธเป็น OWNER_REJECTED', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = scheduleCommandFor(f, {
    intent: { requestedFor: new Date(Date.now() + HOUR_MS).toISOString(), queueId: randomUUID() },
  });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.reasonCode, 'QUEUE_NOT_FOUND');
});

test('SCHEDULED callback ยกเลิกได้ผ่าน CANCEL_CALLBACK ด้วย original action linkage', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const schedule = scheduleCommandFor(f);
  await service.persistCommand(tenant, schedule);

  const cancel = cancelCommandFor(f, schedule.actionKey);
  await service.persistCommand(tenant, cancel);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: cancel.actionKey,
    requestHash: cancel.requestHash,
  });
  assert.equal(result?.status, 'CANCELLED');

  const stored = await f.owner.obCallback.findUniqueOrThrow({
    where: { id: result!.ownerAggregate!.id },
  });
  assert.equal(stored.state, 'CANCELLED');
  assert.equal(stored.cancelReasonCode, 'OUTCOME_CORRECTED');
});

test('SCHEDULED callback แทนที่ได้ผ่าน SUPERSEDE_CALLBACK พร้อม superseding outcome linkage', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const schedule = scheduleCommandFor(f);
  await service.persistCommand(tenant, schedule);

  const supersede = supersedeCommandFor(f, schedule.actionKey);
  await service.persistCommand(tenant, supersede);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: supersede.actionKey,
    requestHash: supersede.requestHash,
  });
  assert.equal(result?.status, 'SUPERSEDED');

  const stored = await f.owner.obCallback.findUniqueOrThrow({
    where: { id: result!.ownerAggregate!.id },
  });
  assert.equal(stored.state, 'SUPERSEDED');
  assert.equal(stored.supersedingOutcomeVersion, 3);
});

test('callback ที่ irreversible แล้ว (ACTIVE) ปฏิเสธ cancel เป็น TOO_LATE โดยไม่ย้อน state', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const schedule = scheduleCommandFor(f);
  await service.persistCommand(tenant, schedule);
  const scheduled = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: schedule.actionKey,
    requestHash: schedule.requestHash,
  });
  await f.owner.obCallback.update({
    where: { id: scheduled!.ownerAggregate!.id },
    data: { state: 'ACTIVE' },
  });

  const cancel = cancelCommandFor(f, schedule.actionKey);
  await service.persistCommand(tenant, cancel);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: cancel.actionKey,
    requestHash: cancel.requestHash,
  });
  assert.equal(result?.status, 'TOO_LATE');
  assert.equal(result?.code, 'ACTION_TOO_LATE');

  const stillActive = await f.owner.obCallback.findUniqueOrThrow({
    where: { id: scheduled!.ownerAggregate!.id },
  });
  assert.equal(
    stillActive.state,
    'ACTIVE',
    'ห้าม hard-disconnect หรือย้อน state ของ call ที่ active แล้ว',
  );
});

test('cancel ซ้ำของ callback ที่ cancel ไปแล้วคืนผลเดิมแบบ idempotent', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const schedule = scheduleCommandFor(f);
  await service.persistCommand(tenant, schedule);
  const firstCancel = cancelCommandFor(f, schedule.actionKey);
  await service.persistCommand(tenant, firstCancel);

  const secondCancel = cancelCommandFor(f, schedule.actionKey);
  await service.persistCommand(tenant, secondCancel);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: secondCancel.actionKey,
    requestHash: secondCancel.requestHash,
  });
  assert.equal(result?.status, 'CANCELLED');
  assert.equal(await f.owner.obCallback.count({ where: { tenantId: f.rawTenantId } }), 1);
});

test('originalActionKey ที่ไม่มีอยู่จริงถูกปฏิเสธเป็น OWNER_REJECTED', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const cancel = cancelCommandFor(f, `${randomUUID()}:1:schedule-callback`);

  await service.persistCommand(tenant, cancel);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: cancel.actionKey,
    requestHash: cancel.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.reasonCode, 'ORIGINAL_ACTION_NOT_FOUND');
});

test('contact ข้าม tenant ถูกปฏิเสธโดยไม่เปิดเผย existence', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = scheduleCommandFor(f, { contactId: contactId(other.rawContactId) });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.code, 'CONTACT_NOT_FOUND');
  assert.equal(await f.owner.obCallback.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('team ข้าม tenant ถูกปฏิเสธเป็น TEAM_SEGMENT_NOT_ALLOWED', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = scheduleCommandFor(f, { targetOwnerTeamId: teamId(other.rawTargetTeamId) });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.code, 'TEAM_SEGMENT_NOT_ALLOWED');
});

test('queue ข้าม tenant ถูกปฏิเสธเป็น OWNER_REJECTED โดยไม่เปิดเผย existence', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const command = scheduleCommandFor(f, {
    intent: {
      requestedFor: new Date(Date.now() + HOUR_MS).toISOString(),
      queueId: other.rawQueueId,
    },
  });

  await service.persistCommand(tenant, command);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.reasonCode, 'QUEUE_NOT_FOUND');
});

test('ไม่มี Governance reservation ถูกสร้างจาก SCHEDULE_CALLBACK', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  await service.persistCommand(tenant, scheduleCommandFor(f));

  assert.equal(await f.owner.cgReservation.count({ where: { tenantId: f.rawTenantId } }), 0);
});

test('tenant คนละใบไม่เห็น callback ของกันและกัน', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const service = new DialerCallbackService(a.application, allowAllScope);
  const otherService = new DialerCallbackService(b.application, allowAllScope);
  const command = scheduleCommandFor(a);
  await service.persistCommand(toTenantId(a.rawTenantId), command);

  const otherView = await otherService.queryAction(toTenantId(b.rawTenantId), {
    contractVersion: 1,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
  });
  assert.equal(otherView, undefined);
});

test('cancel ตาม contract (actionKey เดิม) ไม่ชนกับ receipt ของ SCHEDULE และ query แยกด้วย requestHash', async (t) => {
  const f = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const schedule = scheduleCommandFor(f);
  await service.persistCommand(tenant, schedule);
  const cancel = cancelCommandFor(f, schedule.actionKey);
  assert.equal(cancel.actionKey, schedule.actionKey);

  await service.persistCommand(tenant, cancel);
  // retry ของ cancel ใบเดิมเป็น duplicate ไม่ตัดสินใหม่
  await service.persistCommand(tenant, cancel);

  const [scheduled, cancelled] = await Promise.all(
    [schedule, cancel].map((command) =>
      service.queryAction(tenant, {
        contractVersion: 1,
        actionKey: command.actionKey,
        requestHash: command.requestHash,
      }),
    ),
  );
  assert.equal(scheduled?.commandType, 'SCHEDULE_CALLBACK');
  assert.equal(scheduled?.status, 'SCHEDULED');
  assert.equal(cancelled?.commandType, 'CANCEL_CALLBACK');
  assert.equal(cancelled?.status, 'CANCELLED');
  assert.equal(await f.owner.obDialerCommandInbox.count({ where: { tenantId: f.rawTenantId } }), 2);
});

test('scope ที่ถูกถอนไม่ขวาง cancel — การยกเลิกคือทางที่ Journey ใช้ตอน scope ถูกถอน', async (t) => {
  const f = await fixture(t);
  const tenant = toTenantId(f.rawTenantId);
  const schedule = scheduleCommandFor(f);
  await new DialerCallbackService(f.application, allowAllScope).persistCommand(tenant, schedule);

  const denying = new DialerCallbackService(f.application, {
    async authorize() {
      return {
        decision: 'DENY' as const,
        reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED' as const,
        evaluatedAt: new Date().toISOString(),
      };
    },
  });
  const cancel = cancelCommandFor(f, schedule.actionKey);
  await denying.persistCommand(tenant, cancel);
  const result = await denying.queryAction(tenant, {
    contractVersion: 1,
    actionKey: cancel.actionKey,
    requestHash: cancel.requestHash,
  });
  assert.equal(result?.status, 'CANCELLED');
});

test('cancel ที่ contact/team ไม่ตรงกับ callback เดิมถูกปฏิเสธเป็น BINDING_MISMATCH', async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const service = new DialerCallbackService(f.application, allowAllScope);
  const tenant = toTenantId(f.rawTenantId);
  const schedule = scheduleCommandFor(f);
  await service.persistCommand(tenant, schedule);

  const draft = {
    ...cancelCommandFor(f, schedule.actionKey),
    contactId: contactId(other.rawContactId),
  };
  const { requestHash: _stale, ...unhashed } = draft;
  const mismatched = withOwnerRequestHash(tenant, unhashed) as CancelCommand;
  await service.persistCommand(tenant, mismatched);
  const result = await service.queryAction(tenant, {
    contractVersion: 1,
    actionKey: mismatched.actionKey,
    requestHash: mismatched.requestHash,
  });
  assert.equal(result?.status, 'REJECTED');
  assert.equal(result?.code, 'BINDING_MISMATCH');
  const callback = await f.owner.obCallback.findFirstOrThrow({
    where: { tenantId: f.rawTenantId },
  });
  assert.equal(callback.state, 'SCHEDULED');
});
