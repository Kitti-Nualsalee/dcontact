/**
 * J2.8 (#136) — พิสูจน์ขารับผลกลับจาก owner ผ่าน Kafka จริง
 *
 * ครอบสิ่งที่สเปคบังคับ: binding ครบทุกชั้น, ผลที่ bind ไม่ตรงต้องไม่ถูก apply,
 * ผลซ้ำเป็น idempotent และผลที่มาช้าหลัง terminal แล้วต้องไม่ย้อน state
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { createProducer } from '@d-contact/kafka';
import {
  J2_EVENT_TYPES,
  J2_RESULT_EVENT_TYPE,
  actionKey as toActionKey,
  campaignId,
  commandId as toCommandId,
  contactId,
  enrollmentId as toEnrollmentId,
  interactionId,
  journeyId,
  outcomeId,
  teamId,
  tenantId as toTenantId,
  withOwnerRequestHash,
  type J2OwnerResultPayloadV1,
} from '@d-contact/cxa-contracts';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { createJourneyOwnerResultConsumer } from './journey-owner-result-consumer.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const REQUEST_HASH = 'c'.repeat(64);

async function waitFor(check: () => Promise<boolean>, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('เงื่อนไขไม่เป็นจริงภายในเวลาที่กำหนด');
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const enrollmentId = randomUUID();
  const suffix = randomUUID();

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.8 result ${tenantId.slice(0, 8)}`,
      slug: `j2-8-result-${tenantId.slice(0, 8)}`,
      sipDomain: `${tenantId.slice(0, 8)}.j2-8-result.test`,
    },
  });

  const repository = new JourneyOwnerActionRepository(application);
  const consumer = await createJourneyOwnerResultConsumer({
    database: application,
    clientId: `j2-8-result-${suffix}-consumer`,
    groupId: `j2-8-result-${suffix}`,
    brokers: ['localhost:9092'],
  });
  await consumer.ready();
  const producer = await createProducer(`j2-8-result-${suffix}-producer`, {
    brokers: ['localhost:9092'],
  });

  t.after(async () => {
    await producer.disconnect();
    await consumer.disconnect();
    await owner.jrOwnerResultInbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  /** สร้าง action + command ที่ถูกส่งออกไปแล้ว (สถานะเดียวกับหลัง relay publish) */
  async function dispatchedCommand() {
    const actionKey = `result-action-${randomUUID()}`;
    const commandId = randomUUID();
    await repository.ensureAction({
      tenantId,
      actionKey,
      enrollmentId,
      kind: 'ENSURE_CASE',
      requestHash: REQUEST_HASH,
      correlationId: commandId,
      commandId,
      commandPayload: { placeholder: true },
    });
    await repository.markCommandDispatched(tenantId, commandId);
    return { actionKey, commandId };
  }

  function resultPayload(
    commandId: string,
    actionKey: string,
    overrides: Partial<J2OwnerResultPayloadV1> = {},
  ): J2OwnerResultPayloadV1 {
    const base = {
      contractVersion: 1,
      commandId,
      actionKey,
      requestHash: REQUEST_HASH,
      commandType: 'ENSURE_CASE',
      status: 'CREATED',
      failureClass: 'NONE',
      retryDisposition: 'NONE',
      observedAt: new Date().toISOString(),
      ownerAggregate: { type: 'case', id: randomUUID(), version: 1 },
      ...overrides,
    };
    // canonical success ใช้ status เป็น code/BUSINESS ส่วน REJECTED ต้องใช้ frozen error
    // code ที่ผูก category/retryDisposition ไว้แล้ว — ให้ override ชนะเสมอ
    return {
      code: base.status,
      category: 'BUSINESS',
      reasonCode: base.status,
      ...base,
    } as J2OwnerResultPayloadV1;
  }

  function publishResult(payload: J2OwnerResultPayloadV1, correlationId: string) {
    return producer.send(KAFKA_TOPICS.CASE_EVENTS, {
      schemaVersion: 2,
      eventKind: 'CANONICAL',
      eventId: randomUUID(),
      type: J2_EVENT_TYPES.CASE_ENSURE_COMPLETED,
      tenantId,
      occurredAt: new Date().toISOString(),
      correlationId,
      orderingKey: payload.actionKey,
      aggregateType: 'case_command_receipt',
      aggregateId: payload.commandId,
      aggregateVersion: 1,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  /** action ของ Dialer ที่มี command payload จริง — cancel command จึงถูกสร้างตาม contract ได้ */
  async function dispatchedDialerCommand() {
    const enrollment = randomUUID();
    const actionKey = `${enrollment}:1:admit-campaign`;
    const command = withOwnerRequestHash(toTenantId(tenantId), {
      contractVersion: 1,
      commandId: toCommandId(randomUUID()),
      actionKey: toActionKey(actionKey),
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
    await repository.ensureAction({
      tenantId,
      actionKey,
      enrollmentId: enrollment,
      kind: 'ADMIT_CAMPAIGN_TARGET',
      requestHash: command.requestHash,
      correlationId: command.commandId,
      commandId: command.commandId,
      commandPayload: command,
    });
    await repository.markCommandDispatched(tenantId, command.commandId);
    return { actionKey, command };
  }

  function publishDialerResult(payload: J2OwnerResultPayloadV1, correlationId: string) {
    return producer.send(KAFKA_TOPICS.DIALER_EVENTS, {
      schemaVersion: 2,
      eventKind: 'CANONICAL',
      eventId: randomUUID(),
      type: J2_RESULT_EVENT_TYPE[payload.commandType],
      tenantId,
      occurredAt: new Date().toISOString(),
      correlationId,
      orderingKey: payload.actionKey,
      aggregateType: 'dialer_command_receipt',
      aggregateId: payload.commandId,
      aggregateVersion: 1,
      payload: payload as unknown as Record<string, unknown>,
    });
  }

  return {
    owner,
    tenantId,
    repository,
    dispatchedCommand,
    dispatchedDialerCommand,
    resultPayload,
    publishResult,
    publishDialerResult,
  };
}

test('result ที่ bind ถูกต้องถูก apply ลง action และ inbox', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const { actionKey, commandId } = await f.dispatchedCommand();

  await f.publishResult(f.resultPayload(commandId, actionKey), commandId);

  await waitFor(async () => {
    const action = await f.owner.jrOwnerAction.findFirstOrThrow({
      where: { tenantId: f.tenantId, actionKey },
    });
    return action.state === 'ACKNOWLEDGED';
  });

  const inbox = await f.owner.jrOwnerResultInbox.findFirstOrThrow({
    where: { tenantId: f.tenantId, commandId },
  });
  assert.equal(inbox.resultKind, 'ACKNOWLEDGED');
  assert.notEqual(inbox.ownerAggregateRef, null);
});

test('result ใบเดิมที่ส่งซ้ำไม่สร้าง row ใหม่ (idempotent)', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const { actionKey, commandId } = await f.dispatchedCommand();
  const payload = f.resultPayload(commandId, actionKey);

  await f.publishResult(payload, commandId);
  await waitFor(async () => {
    const action = await f.owner.jrOwnerAction.findFirstOrThrow({
      where: { tenantId: f.tenantId, actionKey },
    });
    return action.state === 'ACKNOWLEDGED';
  });
  await f.publishResult(payload, commandId);

  // รอให้ใบที่สองถูกประมวลผลแน่ ๆ ก่อนนับ
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  assert.equal(
    await f.owner.jrOwnerResultInbox.count({ where: { tenantId: f.tenantId, commandId } }),
    1,
  );
});

test(
  'result ที่อ้าง actionKey ไม่ตรงกับ command ต้นเรื่องต้องไม่ถูก apply',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const { actionKey, commandId } = await f.dispatchedCommand();
    const other = await f.dispatchedCommand();

    // ผลอ้าง commandId ของใบแรก แต่ actionKey ของอีกใบ — binding พัง
    await f.publishResult(f.resultPayload(commandId, other.actionKey), commandId);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    assert.equal(
      await f.owner.jrOwnerResultInbox.count({ where: { tenantId: f.tenantId, commandId } }),
      0,
      'result ที่ bind ไม่ตรงต้องไม่ลง inbox',
    );
    const untouched = await f.owner.jrOwnerAction.findFirstOrThrow({
      where: { tenantId: f.tenantId, actionKey },
    });
    assert.equal(untouched.state, 'DISPATCHED', 'state ต้องไม่ขยับจากผลที่ bind ไม่ตรง');
  },
);

test('result ที่อ้าง requestHash ไม่ตรงต้องไม่ถูก apply', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const { actionKey, commandId } = await f.dispatchedCommand();

  await f.publishResult(
    f.resultPayload(commandId, actionKey, { requestHash: 'd'.repeat(64) }),
    commandId,
  );
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  assert.equal(
    await f.owner.jrOwnerResultInbox.count({ where: { tenantId: f.tenantId, commandId } }),
    0,
  );
});

test('ผลที่มาช้าหลัง action เข้า terminal แล้วไม่ย้อน state', { timeout: 60_000 }, async (t) => {
  const f = await fixture(t);
  const { actionKey, commandId } = await f.dispatchedCommand();

  await f.publishResult(
    f.resultPayload(commandId, actionKey, {
      status: 'REJECTED',
      // REJECTED ต้องใช้ frozen error code ที่ผูก category/retryDisposition ไว้แล้ว
      code: 'BINDING_MISMATCH',
      category: 'CONFLICT',
      retryDisposition: 'QUARANTINE',
      failureClass: 'BUSINESS',
      reasonCode: 'BINDING_MISMATCH',
    }),
    commandId,
  );
  await waitFor(async () => {
    const action = await f.owner.jrOwnerAction.findFirstOrThrow({
      where: { tenantId: f.tenantId, actionKey },
    });
    return action.state === 'REJECTED';
  });

  // ผลใบใหม่ที่บอกว่าสำเร็จ มาถึงหลัง terminal แล้ว
  await f.publishResult(f.resultPayload(commandId, actionKey, { status: 'CREATED' }), commandId);
  await new Promise((resolve) => setTimeout(resolve, 3_000));

  const final = await f.owner.jrOwnerAction.findFirstOrThrow({
    where: { tenantId: f.tenantId, actionKey },
  });
  assert.equal(final.state, 'REJECTED', 'terminal ที่ commit แล้วต้องชนะเสมอ');
});

test(
  'ผล ADMITTED ของ command เดิมที่มาก่อนผล CANCELLED ของ cancel command ไม่ทำให้ Journey เห็น state ต่างจาก owner',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const { actionKey, command } = await f.dispatchedDialerCommand();
    await f.repository.requestCancellation({
      tenantId: f.tenantId,
      actionKey,
      cancelRequestKey: 'outcome-corrected',
      reasonCode: 'OUTCOME_CORRECTED',
      correlationId: 'corr-cancel',
    });
    const cancel = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
      where: { tenantId: f.tenantId, actionKey, NOT: { commandId: command.commandId } },
    });
    const targetId = randomUUID();

    await f.publishDialerResult(
      f.resultPayload(command.commandId, actionKey, {
        requestHash: command.requestHash,
        commandType: 'ADMIT_CAMPAIGN_TARGET',
        status: 'ADMITTED',
        ownerAggregate: { type: 'campaign_target', id: targetId, version: 1 },
      }),
      command.commandId,
    );
    await f.publishDialerResult(
      f.resultPayload(cancel.commandId, actionKey, {
        requestHash: cancel.requestHash,
        commandType: 'CANCEL_CAMPAIGN_TARGET',
        status: 'CANCELLED',
        ownerAggregate: { type: 'campaign_target', id: targetId, version: 2 },
      }),
      cancel.commandId,
    );

    await waitFor(async () => {
      const action = await f.owner.jrOwnerAction.findFirstOrThrow({
        where: { tenantId: f.tenantId, actionKey },
      });
      return action.state === 'CANCELLED';
    });
    const results = await f.owner.jrOwnerResultInbox.findMany({
      where: { tenantId: f.tenantId, actionKey },
      orderBy: { receivedAt: 'asc' },
    });
    assert.deepEqual(
      results.map(({ resultKind, outcome }) => [resultKind, outcome]),
      [
        ['ACKNOWLEDGED', 'APPLIED'],
        ['CANCELLED', 'APPLIED'],
      ],
    );
  },
);
