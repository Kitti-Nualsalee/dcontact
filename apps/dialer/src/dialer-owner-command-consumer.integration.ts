/**
 * J2.8 (#136) — พิสูจน์ขารับ owner command ของ Dialer ผ่าน Kafka จริง: command ที่ Journey relay ส่ง
 * ต้องได้ผลกลับทาง `dc.dialer.events` ที่ผ่าน result contract, redelivery ไม่สร้าง effect ซ้ำ และ
 * command ที่ผิด contract ถูกกักเข้า DLQ แทนการ block partition
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  J2_COMMAND_EVENT_TYPE,
  actionKey,
  assertOwnerResultEnvelope,
  campaignId,
  commandId,
  contactId,
  enrollmentId,
  interactionId,
  journeyId,
  outcomeId,
  teamId,
  tenantId as toTenantId,
  withOwnerRequestHash,
  type J2DialerOwnerCommandV1,
  type J2KafkaEnvelopeV2,
  type J2OwnerResultPayloadV1,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import {
  createConsumer,
  createInMemoryIdempotencyStore,
  createProducer,
  type DlqPublisher,
} from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { CampaignFixtures } from './campaign-fixtures.js';
import { createDialerOwnerCommandConsumer } from './dialer-owner-command-consumer.js';
import { DialerOwnerCommandService } from './dialer-owner-command-service.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';
const BROKERS = ['localhost:9092'];

const allowAllScope: TeamContactScopeAuthorizer = {
  async authorize(input) {
    return { decision: 'ALLOW', scopeVersion: 1, evaluatedAt: input.at };
  },
};

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 25_000) {
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
  const sourceTeamId = randomUUID();
  const targetTeamId = randomUUID();
  const rawContactId = randomUUID();
  const activeCampaignId = randomUUID();
  const suffix = randomUUID();

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.8 dialer consumer ${tenantId.slice(0, 8)}`,
      slug: `j2-8-dialer-consumer-${tenantId.slice(0, 8)}`,
      sipDomain: `${tenantId.slice(0, 8)}.j2-8-dialer-consumer.test`,
    },
  });
  await owner.team.create({ data: { id: sourceTeamId, tenantId, name: 'Journey' } });
  await owner.team.create({ data: { id: targetTeamId, tenantId, name: 'Dialer' } });
  await owner.contact.create({ data: { id: rawContactId, tenantId } });
  const campaigns = new CampaignFixtures(application);
  await campaigns.upsertCampaign({
    tenantId,
    id: activeCampaignId,
    key: 'active-campaign',
    status: 'ACTIVE',
  });
  await campaigns.upsertAdmissionPolicy({ tenantId, campaignId: activeCampaignId });

  const results: Array<J2KafkaEnvelopeV2<J2OwnerResultPayloadV1>> = [];
  const duplicateResults: Array<J2KafkaEnvelopeV2<J2OwnerResultPayloadV1>> = [];
  const quarantined: Array<{ dlqReason: string; reason: string }> = [];
  const dlq: DlqPublisher = {
    async publish(message) {
      quarantined.push({ dlqReason: message.dlqReason, reason: message.error.message });
    },
  };

  const resultReader = await createConsumer({
    clientId: `j2-8-dialer-results-${suffix}`,
    groupId: `j2-8-dialer-results-${suffix}`,
    brokers: BROKERS,
    topics: [KAFKA_TOPICS.DIALER_EVENTS],
    idempotency: createInMemoryIdempotencyStore(),
    handler: ({ event }) => {
      if (event.tenantId === tenantId) results.push(assertOwnerResultEnvelope(event));
    },
    // ผลที่ publish ซ้ำหลัง redelivery ต้องเป็น eventId เดิม — ฝั่งผู้อ่านจึงเห็นเป็น duplicate
    onDuplicate: ({ event }) => {
      if (event.tenantId === tenantId) duplicateResults.push(assertOwnerResultEnvelope(event));
    },
  });
  const producer = await createProducer(`j2-8-dialer-owner-${suffix}`, { brokers: BROKERS });
  const consumer = await createDialerOwnerCommandConsumer({
    owner: new DialerOwnerCommandService(application, allowAllScope),
    producer,
    clientId: `j2-8-dialer-owner-${suffix}`,
    groupId: `j2-8-dialer-owner-${suffix}`,
    brokers: BROKERS,
    dlq,
  });
  await Promise.all([resultReader.ready(), consumer.ready()]);

  t.after(async () => {
    await Promise.all([consumer.disconnect(), resultReader.disconnect(), producer.disconnect()]);
    await owner.obDialerCommandInbox.deleteMany({ where: { tenantId } });
    await owner.obCampaignTarget.deleteMany({ where: { tenantId } });
    await owner.obCampaignAdmissionPolicy.deleteMany({ where: { tenantId } });
    await owner.obCampaign.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.team.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  function admitCommand(): J2DialerOwnerCommandV1 {
    const enrollment = randomUUID();
    return withOwnerRequestHash(toTenantId(tenantId), {
      contractVersion: 1,
      commandId: commandId(randomUUID()),
      actionKey: actionKey(`${enrollment}:1:admit-campaign`),
      journeyId: journeyId(randomUUID()),
      journeyVersion: 1,
      enrollmentId: enrollmentId(enrollment),
      stepId: 'admit-campaign',
      sourceOutcome: {
        outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
        outcomeId: outcomeId(randomUUID()),
        outcomeVersion: 1,
      },
      interactionId: interactionId(randomUUID()),
      contactId: contactId(rawContactId),
      sourceOwnerTeamId: teamId(sourceTeamId),
      targetOwnerTeamId: teamId(targetTeamId),
      commandType: 'ADMIT_CAMPAIGN_TARGET',
      intent: { campaignId: campaignId(activeCampaignId) },
    }) as J2DialerOwnerCommandV1;
  }

  function cancelCommandFor(admit: J2DialerOwnerCommandV1): J2DialerOwnerCommandV1 {
    const { requestHash: _hash, commandType: _type, intent: _intent, ...common } = admit;
    return withOwnerRequestHash(toTenantId(tenantId), {
      ...common,
      commandId: commandId(randomUUID()),
      commandType: 'CANCEL_CAMPAIGN_TARGET',
      intent: { originalActionKey: admit.actionKey, reasonCode: 'OUTCOME_CORRECTED' },
    }) as J2DialerOwnerCommandV1;
  }

  /** envelope เดียวกับที่ Journey Kafka owner command port publish (ตรวจด้วย contract เดียวกัน) */
  function publishCommand(
    command: J2DialerOwnerCommandV1,
    overrides: Record<string, unknown> = {},
  ) {
    return producer.send(KAFKA_TOPICS.DIALER_COMMANDS, {
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
      ...overrides,
    } as Parameters<typeof producer.send>[1]);
  }

  return {
    owner,
    tenantId,
    results,
    duplicateResults,
    quarantined,
    admitCommand,
    cancelCommandFor,
    publishCommand,
    publishRaw: (event: Parameters<typeof producer.send>[1]) =>
      producer.send(KAFKA_TOPICS.DIALER_COMMANDS, event),
  };
}

test(
  'ADMIT_CAMPAIGN_TARGET จาก Kafka สร้าง target และ publish ผลที่ bind กับ command กลับ dc.dialer.events',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const admit = f.admitCommand();

    await f.publishCommand(admit);
    await waitFor(() => f.results.length === 1);

    const [result] = f.results;
    assert.equal(result!.payload.commandId, admit.commandId);
    assert.equal(result!.payload.requestHash, admit.requestHash);
    assert.equal(result!.payload.status, 'ADMITTED');
    assert.equal(result!.causationId, admit.commandId);
    assert.equal(result!.correlationId, `corr-${admit.commandId}`);
    const target = await f.owner.obCampaignTarget.findUniqueOrThrow({
      where: { id: result!.payload.ownerAggregate!.id },
    });
    assert.equal(target.state, 'ADMITTED');
  },
);

test(
  'redelivery ของ command เดิม publish ผลเดิมซ้ำโดยไม่สร้าง target/receipt ใหม่',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const admit = f.admitCommand();

    await f.publishCommand(admit);
    await waitFor(() => f.results.length === 1);
    await f.publishCommand(admit);
    await waitFor(() => f.duplicateResults.length === 1);

    assert.equal(
      f.duplicateResults[0]!.eventId,
      f.results[0]!.eventId,
      'ผลของ receipt เดิมเป็น event เดิม',
    );
    assert.deepEqual(f.duplicateResults[0]!.payload, f.results[0]!.payload);
    assert.equal(await f.owner.obCampaignTarget.count({ where: { tenantId: f.tenantId } }), 1);
    assert.equal(await f.owner.obDialerCommandInbox.count({ where: { tenantId: f.tenantId } }), 1);
  },
);

test(
  'CANCEL_CAMPAIGN_TARGET ตาม contract (actionKey เดิม) ผ่าน Kafka ยกเลิก target และตอบ CANCELLED',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const admit = f.admitCommand();
    const cancel = f.cancelCommandFor(admit);

    await f.publishCommand(admit);
    await f.publishCommand(cancel);
    await waitFor(() => f.results.length === 2);

    assert.deepEqual(
      f.results.map(({ payload }) => [payload.commandType, payload.status]),
      [
        ['ADMIT_CAMPAIGN_TARGET', 'ADMITTED'],
        ['CANCEL_CAMPAIGN_TARGET', 'CANCELLED'],
      ],
    );
    assert.equal(f.results[1]!.orderingKey, admit.actionKey);
    const target = await f.owner.obCampaignTarget.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    assert.equal(target.state, 'CANCELLED');
  },
);

test(
  'command ที่ผิด contract หรือชน IDEMPOTENCY_CONFLICT ถูกกักเข้า DLQ และไม่ block command ถัดไป',
  { timeout: 90_000 },
  async (t) => {
    const f = await fixture(t);
    const admit = f.admitCommand();

    // requestHash ถูกแก้หลังคำนวณ — ผ่าน Kafka envelope แต่ละเมิด J2 contract
    await f.publishCommand({ ...admit, requestHash: 'f'.repeat(64) });
    // event ชนิดอื่นบน topic เดียวกันต้องถูกข้ามเงียบ ไม่ใช่ quarantine
    await f.publishRaw({
      schemaVersion: 2,
      eventKind: 'COMMAND',
      eventId: `dialer-reconcile:${randomUUID()}`,
      type: 'dialer.reconcile_requested',
      tenantId: f.tenantId,
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-reconcile',
      orderingKey: 'reconcile',
      aggregateType: 'dialer_attempt',
      aggregateId: 'reconcile',
      aggregateVersion: 0,
      payload: { contractVersion: 1 },
    });
    await f.publishCommand(admit);
    // commandId เดิมแต่เนื้อหาต่าง (campaign อื่น) — owner ต้องไม่ตัดสินทับ receipt เดิม
    const { requestHash: _hash, ...draft } = {
      ...admit,
      intent: { campaignId: campaignId(randomUUID()) },
    };
    await f.publishCommand(
      withOwnerRequestHash(toTenantId(f.tenantId), draft as never) as J2DialerOwnerCommandV1,
    );
    const next = f.admitCommand();
    await f.publishCommand(next);

    await waitFor(() => f.results.length === 2 && f.quarantined.length === 2);
    assert.deepEqual(
      f.results.map(({ payload }) => payload.commandId),
      [admit.commandId, next.commandId],
    );
    assert.deepEqual(
      f.quarantined.map(({ reason }) => reason),
      ['PAYLOAD_VALIDATION_FAILED', 'IDEMPOTENCY_CONFLICT'],
    );
    assert.equal(await f.owner.obDialerCommandInbox.count({ where: { tenantId: f.tenantId } }), 2);
  },
);
