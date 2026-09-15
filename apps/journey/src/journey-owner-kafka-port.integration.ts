/**
 * J2.8 (#136) — พิสูจน์ว่า owner command เดินทางออก Kafka จริง ไม่ใช่แค่ compile ผ่าน
 *
 * ครอบสามข้อที่สเปคระบุ: publish ลง `dc.case.commands`/`dc.dialer.commands` จริง,
 * mark dispatch หลัง broker ack (ไม่ใช่ก่อน) และ ordering key ผูกกับ actionKey
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { createConsumer, createInMemoryIdempotencyStore, createProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  actionKey as toActionKey,
  commandId as toCommandId,
  contactId as toContactId,
  enrollmentId as toEnrollmentId,
  interactionId as toInteractionId,
  journeyId as toJourneyId,
  outcomeId as toOutcomeId,
  teamId as toTeamId,
  tenantId as toTenantId,
  type J2CaseOwnerCommandV1,
} from '@d-contact/cxa-contracts';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneyOwnerCommandRelay } from './journey-owner-command-relay.js';
import { createKafkaOwnerCommandPort } from './journey-owner-kafka-port.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function waitFor(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('เงื่อนไขไม่เป็นจริงภายในเวลาที่กำหนด');
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const enrollmentId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.8 kafka ${suffix}`,
      slug: `j2-8-kafka-${suffix}`,
      sipDomain: `${suffix}.j2-8-kafka.test`,
    },
  });

  t.after(async () => {
    await owner.jrOwnerResultInbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerCommandOutbox.deleteMany({ where: { tenantId } });
    await owner.jrOwnerAction.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  return { owner, application, tenantId, enrollmentId };
}

/** shape เดียวกับที่ JourneyOutcomeTriggerProcessor สร้างจริง ไม่ได้ย่อให้ test ผ่านง่าย */
function ensureCaseCommand(
  enrollmentId: string,
  actionKey: string,
  commandId: string,
): J2CaseOwnerCommandV1 {
  return {
    contractVersion: 1,
    commandId: toCommandId(commandId),
    actionKey: toActionKey(actionKey),
    requestHash: 'b'.repeat(64),
    journeyId: toJourneyId(randomUUID()),
    journeyVersion: 1,
    enrollmentId: toEnrollmentId(enrollmentId),
    stepId: 'step-1',
    sourceOutcome: {
      outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
      outcomeId: toOutcomeId(randomUUID()),
      outcomeVersion: 1,
    },
    interactionId: toInteractionId(randomUUID()),
    contactId: toContactId(randomUUID()),
    sourceOwnerTeamId: toTeamId(randomUUID()),
    targetOwnerTeamId: toTeamId(randomUUID()),
    commandType: 'ENSURE_CASE',
    intent: { caseTypePolicyRef: 'support', routingPolicyRef: 'default' },
  };
}

test(
  'persistCommand publish ลง dc.case.commands จริงและคืน PERSISTED หลัง broker ack',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const suffix = randomUUID();
    const received: Array<{ orderingKey: string; payload: Record<string, unknown> }> = [];

    const consumer = await createConsumer({
      clientId: `j2-8-kafka-${suffix}-consumer`,
      groupId: `j2-8-kafka-${suffix}`,
      brokers: ['localhost:9092'],
      topics: [KAFKA_TOPICS.CASE_COMMANDS],
      idempotency: createInMemoryIdempotencyStore(),
      handler: (message) => {
        received.push({
          orderingKey: message.event.orderingKey,
          payload: message.event.payload as Record<string, unknown>,
        });
      },
    });
    await consumer.ready();

    const producer = await createProducer(`j2-8-kafka-${suffix}-producer`, {
      brokers: ['localhost:9092'],
    });
    t.after(async () => {
      await producer.disconnect();
      await consumer.disconnect();
    });

    const port = createKafkaOwnerCommandPort({
      topic: KAFKA_TOPICS.CASE_COMMANDS,
      producer,
    });

    const actionKey = `kafka-action-${suffix}`;
    const commandId = randomUUID();
    const persisted = await port.persistCommand(
      toTenantId(f.tenantId),
      ensureCaseCommand(f.enrollmentId, actionKey, commandId),
    );

    assert.equal(persisted.status, 'PERSISTED');
    assert.equal(persisted.commandId, commandId);
    assert.equal(persisted.actionKey, actionKey);

    await waitFor(() => received.length === 1);
    // ordering key ผูก actionKey — command ของ action เดียวกันอยู่ partition เดียวกันเสมอ
    assert.equal(received[0]!.orderingKey, `${f.tenantId}:${actionKey}`);
    assert.equal(received[0]!.payload.actionKey, actionKey);
    assert.equal(received[0]!.payload.commandType, 'ENSURE_CASE');
  },
);

test(
  'relay mark command เป็น SENT ต่อเมื่อ publish สำเร็จ — broker ล่มแล้วต้องคง PENDING',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const repository = new JourneyOwnerActionRepository(f.application);
    const actionKey = `kafka-relay-${randomUUID()}`;
    const commandId = randomUUID();

    await repository.ensureAction({
      tenantId: f.tenantId,
      actionKey,
      enrollmentId: f.enrollmentId,
      kind: 'ENSURE_CASE',
      requestHash: 'b'.repeat(64),
      correlationId: commandId,
      commandId,
      commandPayload: ensureCaseCommand(f.enrollmentId, actionKey, commandId),
    });

    // port ที่ publish ไม่สำเร็จ = broker ล่ม — relay ต้องไม่ mark SENT
    const failingPort = {
      async persistCommand(): Promise<never> {
        throw new Error('broker unavailable');
      },
      async queryAction() {
        return undefined;
      },
    };
    const failingRelay = new JourneyOwnerCommandRelay(
      f.application,
      failingPort as never,
      failingPort as never,
      // retry ทันทีเพื่อให้ assert ต่อได้ในเทสเดียว ไม่ต้องรอ backoff จริง 30 วินาที
      { retryDelayMs: 0 },
    );

    assert.equal(await failingRelay.executeNext(f.tenantId), 'RETRY');
    const afterFailure = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
      where: { tenantId: f.tenantId, commandId },
    });
    assert.equal(afterFailure.state, 'PENDING', 'publish ไม่สำเร็จต้องไม่ถูก mark SENT');
    assert.equal(afterFailure.sentAt, null);

    // ครั้งนี้ publish สำเร็จจริงผ่าน Kafka
    const producer = await createProducer(`j2-8-relay-${randomUUID()}-producer`, {
      brokers: ['localhost:9092'],
    });
    t.after(() => producer.disconnect());
    const port = createKafkaOwnerCommandPort({
      topic: KAFKA_TOPICS.CASE_COMMANDS,
      producer,
    });
    const relay = new JourneyOwnerCommandRelay(f.application, port as never, port as never, {
      retryDelayMs: 0,
    });

    assert.equal(await relay.executeNext(f.tenantId), 'SENT');
    const afterSuccess = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
      where: { tenantId: f.tenantId, commandId },
    });
    assert.equal(afterSuccess.state, 'SENT');
    assert.notEqual(afterSuccess.sentAt, null);
  },
);

test('payload ที่ผิด contract ถูกปฏิเสธก่อน publish ไม่หลุดลง topic', async (t) => {
  const f = await fixture(t);
  const sent: unknown[] = [];
  const port = createKafkaOwnerCommandPort({
    topic: KAFKA_TOPICS.CASE_COMMANDS,
    producer: {
      async send(_topic: unknown, event: unknown) {
        sent.push(event);
      },
      async disconnect() {},
    } as never,
  });

  await assert.rejects(() =>
    port.persistCommand(toTenantId(f.tenantId), {
      contractVersion: 1,
      commandId: randomUUID(),
      actionKey: 'broken',
      // ขาด requestHash/commandType ที่ contract บังคับ
    } as never),
  );
  assert.deepEqual(sent, [], 'payload ที่ผิด contract ต้องไม่ถูก publish');
});
