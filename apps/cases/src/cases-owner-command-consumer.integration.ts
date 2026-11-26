/**
 * J2.8 (#136) — proves the Cases ENSURE_CASE receive path over real Kafka: the result goes back to `dc.case.events` via the
 * result contract, redelivery does not create a duplicate Case, and a command violating the contract is quarantined to the DLQ
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  J2_COMMAND_EVENT_TYPE,
  actionKey,
  assertOwnerResultEnvelope,
  commandId,
  contactId,
  enrollmentId,
  interactionId,
  journeyId,
  outcomeId,
  teamId,
  tenantId as toTenantId,
  withOwnerRequestHash,
  type J2CaseOwnerCommandV1,
  type J2KafkaEnvelopeV2,
  type J2OwnerResultPayloadV1,
} from '@d-contact/cxa-contracts';
import {
  createConsumer,
  createInMemoryIdempotencyStore,
  createProducer,
  type DlqPublisher,
} from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { CasePolicyFixtures } from './case-policy-fixtures.js';
import { CasesEnsureCaseService } from './cases-ensure-case-service.js';
import { createCasesOwnerCommandConsumer } from './cases-owner-command-consumer.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';
const BROKERS = ['localhost:9092'];

async function waitFor(check: () => boolean, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('condition did not become true within the allotted time');
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const rawTeamId = randomUUID();
  const rawContactId = randomUUID();
  const suffix = randomUUID();

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.8 cases consumer ${tenantId.slice(0, 8)}`,
      slug: `j2-8-cases-consumer-${tenantId.slice(0, 8)}`,
      sipDomain: `${tenantId.slice(0, 8)}.j2-8-cases-consumer.test`,
    },
  });
  await owner.team.create({ data: { id: rawTeamId, tenantId, name: 'Collections' } });
  await owner.contact.create({ data: { id: rawContactId, tenantId } });
  const policies = new CasePolicyFixtures(application);
  await policies.upsertCaseTypePolicy({
    tenantId,
    policyRef: 'policy-collections',
    caseTypeKey: 'COLLECTIONS',
    reopenAllowed: false,
  });
  await policies.upsertRoutingPolicy({
    tenantId,
    policyRef: 'routing-collections',
    queueRef: 'queue-collections',
  });

  const results: Array<J2KafkaEnvelopeV2<J2OwnerResultPayloadV1>> = [];
  const duplicateResults: Array<J2KafkaEnvelopeV2<J2OwnerResultPayloadV1>> = [];
  const quarantined: string[] = [];
  const dlq: DlqPublisher = {
    async publish(message) {
      quarantined.push(message.error.message);
    },
  };

  const resultReader = await createConsumer({
    clientId: `j2-8-case-results-${suffix}`,
    groupId: `j2-8-case-results-${suffix}`,
    brokers: BROKERS,
    topics: [KAFKA_TOPICS.CASE_EVENTS],
    idempotency: createInMemoryIdempotencyStore(),
    handler: ({ event }) => {
      if (event.tenantId === tenantId) results.push(assertOwnerResultEnvelope(event));
    },
    onDuplicate: ({ event }) => {
      if (event.tenantId === tenantId) duplicateResults.push(assertOwnerResultEnvelope(event));
    },
  });
  const producer = await createProducer(`j2-8-case-owner-${suffix}`, { brokers: BROKERS });
  const consumer = await createCasesOwnerCommandConsumer({
    owner: new CasesEnsureCaseService(application),
    producer,
    clientId: `j2-8-case-owner-${suffix}`,
    groupId: `j2-8-case-owner-${suffix}`,
    brokers: BROKERS,
    dlq,
  });
  await Promise.all([resultReader.ready(), consumer.ready()]);

  t.after(async () => {
    await Promise.all([consumer.disconnect(), resultReader.disconnect(), producer.disconnect()]);
    await owner.csCommandInbox.deleteMany({ where: { tenantId } });
    await owner.csCaseActivity.deleteMany({ where: { tenantId } });
    await owner.csCaseLink.deleteMany({ where: { tenantId } });
    await owner.csCase.deleteMany({ where: { tenantId } });
    await owner.csRoutingPolicy.deleteMany({ where: { tenantId } });
    await owner.csCaseTypePolicy.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  function ensureCaseCommand(): J2CaseOwnerCommandV1 {
    const enrollment = randomUUID();
    return withOwnerRequestHash(toTenantId(tenantId), {
      contractVersion: 1,
      commandId: commandId(randomUUID()),
      actionKey: actionKey(`${enrollment}:1:ensure-case`),
      journeyId: journeyId(randomUUID()),
      journeyVersion: 1,
      enrollmentId: enrollmentId(enrollment),
      stepId: 'ensure-case',
      sourceOutcome: {
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        outcomeId: outcomeId(randomUUID()),
        outcomeVersion: 1,
      },
      interactionId: interactionId(randomUUID()),
      contactId: contactId(rawContactId),
      sourceOwnerTeamId: teamId(rawTeamId),
      targetOwnerTeamId: teamId(rawTeamId),
      commandType: 'ENSURE_CASE',
      intent: {
        caseTypePolicyRef: 'policy-collections',
        routingPolicyRef: 'routing-collections',
      },
    }) as J2CaseOwnerCommandV1;
  }

  function publishCommand(command: J2CaseOwnerCommandV1) {
    return producer.send(KAFKA_TOPICS.CASE_COMMANDS, {
      schemaVersion: 2,
      eventKind: 'COMMAND',
      eventId: command.commandId,
      type: J2_COMMAND_EVENT_TYPE[command.commandType],
      tenantId,
      occurredAt: new Date().toISOString(),
      correlationId: `corr-${command.commandId}`,
      orderingKey: command.actionKey,
      aggregateType: 'journey_action',
      aggregateId: command.actionKey,
      aggregateVersion: 0,
      payload: command as unknown as Record<string, unknown>,
    });
  }

  return {
    owner,
    tenantId,
    results,
    duplicateResults,
    quarantined,
    ensureCaseCommand,
    publishCommand,
  };
}

test(
  'ENSURE_CASE from Kafka creates a Case once, and redelivery publishes the same result with the same eventId',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const command = f.ensureCaseCommand();

    await f.publishCommand(command);
    await waitFor(() => f.results.length === 1);
    await f.publishCommand(command);
    await waitFor(() => f.duplicateResults.length === 1);

    const [result] = f.results;
    assert.equal(result!.payload.status, 'CREATED');
    assert.equal(result!.aggregateType, 'case_command_receipt');
    assert.equal(result!.causationId, command.commandId);
    assert.equal(f.duplicateResults[0]!.eventId, result!.eventId);
    assert.equal(await f.owner.csCase.count({ where: { tenantId: f.tenantId } }), 1);
    assert.equal(await f.owner.csCommandInbox.count({ where: { tenantId: f.tenantId } }), 1);
  },
);

test(
  'an ENSURE_CASE violating the contract is quarantined to the DLQ without creating a Case and without blocking the next command',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const broken = f.ensureCaseCommand();
    const next = f.ensureCaseCommand();

    await f.publishCommand({ ...broken, requestHash: 'e'.repeat(64) });
    await f.publishCommand(next);
    await waitFor(() => f.results.length === 1 && f.quarantined.length === 1);

    assert.equal(f.results[0]!.payload.commandId, next.commandId);
    assert.deepEqual(f.quarantined, ['PAYLOAD_VALIDATION_FAILED']);
    assert.equal(await f.owner.csCase.count({ where: { tenantId: f.tenantId } }), 1);
  },
);
