/**
 * J2.8 (#136) — proves the receiving leg of results back from the owner through real Kafka
 *
 * Covers what the spec requires: binding at every layer, a result whose binding does not match must not be applied,
 * a repeated result is idempotent and a result arriving late after terminal must not revert the state
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
  throw new Error('condition did not become true within the allotted time');
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
  const quarantined: string[] = [];
  const consumer = await createJourneyOwnerResultConsumer({
    database: application,
    clientId: `j2-8-result-${suffix}-consumer`,
    groupId: `j2-8-result-${suffix}`,
    brokers: ['localhost:9092'],
    dlq: {
      async publish(message) {
        if (message.value?.toString().includes(tenantId)) quarantined.push(message.error.message);
      },
    },
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

  /** creates an action + command that has already been sent out (the same state as after a relay publish) */
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
    // a canonical success uses status as the code/BUSINESS, while REJECTED must use a frozen error
    // code that already binds category/retryDisposition — let the override always win
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

  /** a Dialer action with a real command payload — so a cancel command can be built per the contract */
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
    quarantined,
    repository,
    dispatchedCommand,
    dispatchedDialerCommand,
    resultPayload,
    publishResult,
    publishDialerResult,
  };
}

test(
  'a correctly bound result is applied to the action and the inbox',
  { timeout: 60_000 },
  async (t) => {
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
  },
);

test(
  'a resent result of the same id creates no new row (idempotent)',
  { timeout: 60_000 },
  async (t) => {
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

    // make sure the second one has been processed before counting
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(
      await f.owner.jrOwnerResultInbox.count({ where: { tenantId: f.tenantId, commandId } }),
      1,
    );
  },
);

test(
  'a result whose actionKey does not match the original command must not be applied',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const { actionKey, commandId } = await f.dispatchedCommand();
    const other = await f.dispatchedCommand();

    // the result references the commandId of the first one but the actionKey of the other — broken binding
    await f.publishResult(f.resultPayload(commandId, other.actionKey), commandId);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    assert.equal(
      await f.owner.jrOwnerResultInbox.count({ where: { tenantId: f.tenantId, commandId } }),
      0,
      'a result whose binding does not match must not go into the inbox',
    );
    const untouched = await f.owner.jrOwnerAction.findFirstOrThrow({
      where: { tenantId: f.tenantId, actionKey },
    });
    assert.equal(
      untouched.state,
      'DISPATCHED',
      'the state must not move because of a result whose binding does not match',
    );
  },
);

test(
  'a result whose requestHash does not match must not be applied',
  { timeout: 60_000 },
  async (t) => {
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
  },
);

test(
  'a result arriving late after the action reached terminal does not revert the state',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const { actionKey, commandId } = await f.dispatchedCommand();

    await f.publishResult(
      f.resultPayload(commandId, actionKey, {
        status: 'REJECTED',
        // REJECTED must use a frozen error code that already binds category/retryDisposition
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

    // a new result saying success arrives after terminal
    await f.publishResult(f.resultPayload(commandId, actionKey, { status: 'CREATED' }), commandId);
    await new Promise((resolve) => setTimeout(resolve, 3_000));

    const final = await f.owner.jrOwnerAction.findFirstOrThrow({
      where: { tenantId: f.tenantId, actionKey },
    });
    assert.equal(final.state, 'REJECTED', 'a committed terminal must always win');
  },
);

test(
  'an ADMITTED result of the original command arriving before the CANCELLED result of the cancel command does not make Journey see a different state from the owner',
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

test(
  'a result whose binding does not match or violates the contract is quarantined to the DLQ and does not block the next result in the same partition',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const bad = await f.dispatchedCommand();
    const good = await f.dispatchedCommand();

    // a result referencing a command that is not in the outbox
    await f.publishResult(f.resultPayload(randomUUID(), bad.actionKey), bad.commandId);
    // a result event that violates the contract (success must have ownerAggregate) — must not be skipped silently
    const { ownerAggregate: _missing, ...withoutAggregate } = f.resultPayload(
      bad.commandId,
      bad.actionKey,
    );
    await f.publishResult(withoutAggregate as J2OwnerResultPayloadV1, bad.commandId);
    await f.publishResult(f.resultPayload(good.commandId, good.actionKey), good.commandId);

    await waitFor(async () => {
      const action = await f.owner.jrOwnerAction.findFirstOrThrow({
        where: { tenantId: f.tenantId, actionKey: good.actionKey },
      });
      return action.state === 'ACKNOWLEDGED' && f.quarantined.length === 2;
    });
    assert.deepEqual(f.quarantined, ['OWNER_RESULT_BINDING_CONFLICT', 'PAYLOAD_VALIDATION_FAILED']);
    const untouched = await f.owner.jrOwnerAction.findFirstOrThrow({
      where: { tenantId: f.tenantId, actionKey: bad.actionKey },
    });
    assert.equal(untouched.state, 'DISPATCHED');
  },
);

test(
  'a repeated result whose content conflicts with the one already applied is quarantined as EVENT_HASH_CONFLICT',
  { timeout: 60_000 },
  async (t) => {
    const f = await fixture(t);
    const { actionKey, commandId } = await f.dispatchedCommand();

    await f.publishResult(f.resultPayload(commandId, actionKey), commandId);
    await waitFor(async () => {
      const action = await f.owner.jrOwnerAction.findFirstOrThrow({
        where: { tenantId: f.tenantId, actionKey },
      });
      return action.state === 'ACKNOWLEDGED';
    });
    await f.publishResult(
      f.resultPayload(commandId, actionKey, { status: 'LINKED', code: 'LINKED' } as never),
      commandId,
    );
    await waitFor(() => Promise.resolve(f.quarantined.length === 1));
    assert.deepEqual(f.quarantined, ['EVENT_HASH_CONFLICT']);
  },
);
