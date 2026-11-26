/**
 * J2.8 (#136) — proves that owner commands really travel out through Kafka, not just that it compiles
 *
 * Covers the three points the spec states: really publishes to `dc.case.commands`/`dc.dialer.commands`,
 * marks dispatch after the broker ack (not before), and the ordering key is bound to actionKey
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
  assertOwnerActionQueryEnvelope,
  assertOwnerCommandEnvelope,
  withOwnerRequestHash,
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
  throw new Error('condition did not become true within the allotted time');
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

/** the same shape that JourneyOutcomeTriggerProcessor really builds, not trimmed to make the test pass easily */
function ensureCaseCommand(
  tenantId: string,
  enrollmentId: string,
  actionKey: string,
  commandId: string,
): J2CaseOwnerCommandV1 {
  return withOwnerRequestHash(toTenantId(tenantId), {
    contractVersion: 1,
    commandId: toCommandId(commandId),
    actionKey: toActionKey(actionKey),
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
  }) as J2CaseOwnerCommandV1;
}

test(
  'persistCommand really publishes to dc.case.commands and returns PERSISTED after the broker ack',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const suffix = randomUUID();
    const received: Array<Record<string, unknown>> = [];

    const consumer = await createConsumer({
      clientId: `j2-8-kafka-${suffix}-consumer`,
      groupId: `j2-8-kafka-${suffix}`,
      brokers: ['localhost:9092'],
      topics: [KAFKA_TOPICS.CASE_COMMANDS],
      idempotency: createInMemoryIdempotencyStore(),
      handler: (message) => {
        received.push(message.event as unknown as Record<string, unknown>);
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
      ensureCaseCommand(f.tenantId, f.enrollmentId, actionKey, commandId),
    );

    assert.equal(persisted.status, 'PERSISTED');
    assert.equal(persisted.commandId, commandId);
    assert.equal(persisted.actionKey, actionKey);

    await waitFor(() => received.length === 1);
    // the owner must check the received envelope with the same contract — the ordering key is bound to actionKey
    // (cancel/supersede use the same actionKey so they land in the same partition) and eventId = commandId
    const envelope = assertOwnerCommandEnvelope(received[0]);
    assert.equal(envelope.orderingKey, actionKey);
    assert.equal(envelope.eventId, commandId);
    assert.equal(envelope.type, 'case.ensure_requested');
    assert.equal(envelope.payload.commandType, 'ENSURE_CASE');
  },
);

test(
  'the relay marks a command SENT only when the publish succeeds — a broker outage must keep it PENDING',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const repository = new JourneyOwnerActionRepository(f.application);
    const actionKey = `kafka-relay-${randomUUID()}`;
    const commandId = randomUUID();

    const command = ensureCaseCommand(f.tenantId, f.enrollmentId, actionKey, commandId);
    await repository.ensureAction({
      tenantId: f.tenantId,
      actionKey,
      enrollmentId: f.enrollmentId,
      kind: 'ENSURE_CASE',
      requestHash: command.requestHash,
      correlationId: commandId,
      commandId,
      commandPayload: command,
    });

    // a port whose publish fails = broker down — the relay must not mark SENT
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
      // retry immediately so the assertions can continue in a single test without waiting for the real 30 second backoff
      { retryDelayMs: 0 },
    );

    assert.equal(await failingRelay.executeNext(f.tenantId), 'RETRY');
    const afterFailure = await f.owner.jrOwnerCommandOutbox.findFirstOrThrow({
      where: { tenantId: f.tenantId, commandId },
    });
    assert.equal(afterFailure.state, 'PENDING', 'a failed publish must not be marked SENT');
    assert.equal(afterFailure.sentAt, null);

    // this time the publish really succeeds through Kafka
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

test('a payload that violates the contract is rejected before publish and does not leak onto the topic', async (t) => {
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
      // missing the requestHash/commandType the contract requires
    } as never),
  );
  assert.deepEqual(sent, [], 'a payload that violates the contract must not be published');
});

test('queryAction asks the owner through the topic with a contract query envelope and does not make up a result', async (t) => {
  const f = await fixture(t);
  const sent: Array<{ topic: unknown; event: unknown }> = [];
  const port = createKafkaOwnerCommandPort({
    topic: KAFKA_TOPICS.DIALER_COMMANDS,
    producer: {
      async send(topic: unknown, event: unknown) {
        sent.push({ topic, event });
      },
      async disconnect() {},
    } as never,
  });
  const actionKey = `query-action-${randomUUID()}`;
  const requestHash = 'd'.repeat(64);

  const answer = await port.queryAction(toTenantId(f.tenantId), {
    contractVersion: 1,
    actionKey: toActionKey(actionKey),
    requestHash,
  });

  assert.equal(
    answer,
    undefined,
    'the real result must come back only through the result consumer',
  );
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.topic, KAFKA_TOPICS.DIALER_COMMANDS);
  const envelope = assertOwnerActionQueryEnvelope(sent[0]!.event);
  assert.equal(envelope.tenantId, f.tenantId);
  assert.equal(envelope.orderingKey, actionKey);
  assert.deepEqual(envelope.payload, { contractVersion: 1, actionKey, requestHash });
});
