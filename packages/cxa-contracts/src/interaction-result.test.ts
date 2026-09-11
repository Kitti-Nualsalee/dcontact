import assert from 'node:assert/strict';
import test from 'node:test';
import {
  J2_ERROR_CONTRACT,
  J2_COMMAND_EVENT_TYPE,
  J2_EVENT_TYPES,
  J2_RESULT_EVENT_TYPE,
  J2PayloadContractError,
  actionKey,
  assertInteractionOutcomeEnvelope,
  assertOwnerCommandCausation,
  assertOwnerCommandEnvelope,
  assertOwnerRequestHash,
  assertOwnerResultBinding,
  assertOwnerResultEnvelope,
  assertOwnerResultQueryBinding,
  campaignId,
  canonicalInteractionOutcomeHash,
  canonicalOwnerRequestHash,
  commandId,
  contactId,
  enrollmentId,
  interactionId,
  journeyId,
  outcomeId,
  teamId,
  tenantId,
  validateInteractionOutcomePayload,
  validateOwnerActionQuery,
  validateOwnerCommandPayload,
  validateOwnerResultPayload,
  withOwnerRequestHash,
  type InteractionOutcomePayloadV1,
  type J2KafkaEnvelopeV2,
  type J2OwnerCommandDraftV1,
  type J2OwnerResultPayloadV1,
} from './index.js';

const tenant = tenantId('tenant-a');

const outcome: InteractionOutcomePayloadV1 = {
  contractVersion: 1,
  outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
  outcomeId: outcomeId('outcome-a'),
  outcomeVersion: 2,
  interactionId: interactionId('interaction-a'),
  contactId: contactId('contact-a'),
  outcomeCode: 'CALLBACK_REQUESTED',
  effectiveAt: '2026-09-11T10:00:00.000Z',
  supersedesVersion: 1,
};

const commandDraft: J2OwnerCommandDraftV1 = {
  contractVersion: 1,
  commandId: commandId('command-a'),
  actionKey: actionKey('enrollment-a:1:campaign-a'),
  journeyId: journeyId('journey-a'),
  journeyVersion: 1,
  enrollmentId: enrollmentId('enrollment-a'),
  stepId: 'campaign-a',
  sourceOutcome: {
    outcomeType: outcome.outcomeType,
    outcomeId: outcome.outcomeId,
    outcomeVersion: outcome.outcomeVersion,
  },
  interactionId: outcome.interactionId,
  contactId: outcome.contactId!,
  sourceOwnerTeamId: teamId('team-source'),
  targetOwnerTeamId: teamId('team-target'),
  commandType: 'ADMIT_CAMPAIGN_TARGET',
  intent: { campaignId: campaignId('campaign-a') },
};

test('validates the closed outcome allowlist and canonical correction lineage', () => {
  assert.deepEqual(validateInteractionOutcomePayload(outcome), outcome);
  assert.throws(
    () => validateInteractionOutcomePayload({ ...outcome, contractVersion: 2 }),
    (error: unknown) =>
      error instanceof J2PayloadContractError && error.code === 'UNSUPPORTED_CONTRACT_VERSION',
  );
  assert.throws(
    () => validateInteractionOutcomePayload({ ...outcome, transcript: 'customer text' }),
    (error: unknown) =>
      error instanceof J2PayloadContractError && error.code === 'PAYLOAD_VALIDATION_FAILED',
  );
  assert.throws(() =>
    validateInteractionOutcomePayload({
      ...outcome,
      outcomeType: 'INTERACTION_ABANDONED',
      outcomeCode: 'CALLBACK_REQUESTED',
    }),
  );
  assert.throws(() =>
    validateInteractionOutcomePayload({ ...outcome, outcomeCode: 'UNREVIEWED_CODE' }),
  );
});

test('hashes normalized semantic outcome fields deterministically', () => {
  const reordered = {
    effectiveAt: outcome.effectiveAt,
    outcomeCode: outcome.outcomeCode,
    interactionId: outcome.interactionId,
    outcomeVersion: outcome.outcomeVersion,
    contactId: outcome.contactId,
    outcomeId: outcome.outcomeId,
    supersedesVersion: outcome.supersedesVersion,
    outcomeType: outcome.outcomeType,
    contractVersion: outcome.contractVersion,
  };
  assert.equal(
    canonicalInteractionOutcomeHash(reordered),
    canonicalInteractionOutcomeHash(outcome),
  );
  assert.notEqual(
    canonicalInteractionOutcomeHash({ ...outcome, effectiveAt: '2026-09-11T10:01:00.000Z' }),
    canonicalInteractionOutcomeHash(outcome),
  );
});

test('binds owner request hash to tenant, action, target and normalized intent', () => {
  const command = withOwnerRequestHash(tenant, commandDraft);
  assert.deepEqual(assertOwnerRequestHash(tenant, command), command);
  assert.equal(command.requestHash, canonicalOwnerRequestHash(tenant, commandDraft));
  assert.equal(
    command.requestHash,
    canonicalOwnerRequestHash(tenant, { ...commandDraft, commandId: commandId('command-retry') }),
  );
  assert.throws(() => assertOwnerRequestHash(tenantId('tenant-b'), command));
  assert.throws(() =>
    assertOwnerRequestHash(tenant, {
      ...command,
      intent: { campaignId: campaignId('campaign-b') },
    }),
  );
});

test('rejects free-form, PII-shaped and mismatched transition command fields', () => {
  const command = withOwnerRequestHash(tenant, commandDraft);
  assert.throws(() => validateOwnerCommandPayload({ ...command, note: 'free text' }));
  assert.throws(() =>
    validateOwnerCommandPayload({
      ...command,
      contactId: 'customer@example.com',
    }),
  );
  assert.throws(() =>
    validateOwnerCommandPayload({
      ...command,
      contactId: '081-234-5678',
    }),
  );

  const cancelDraft: J2OwnerCommandDraftV1 = {
    ...commandDraft,
    commandId: commandId('command-cancel'),
    commandType: 'CANCEL_CAMPAIGN_TARGET',
    intent: {
      originalActionKey: actionKey('another-action'),
      reasonCode: 'OUTCOME_CORRECTED',
    },
  };
  assert.throws(() => validateOwnerCommandPayload(withOwnerRequestHash(tenant, cancelDraft)));
});

test('validates command-specific owner result status and failure semantics', () => {
  const command = withOwnerRequestHash(tenant, commandDraft);
  const result: J2OwnerResultPayloadV1 = {
    contractVersion: 1,
    commandId: command.commandId,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
    commandType: command.commandType,
    status: 'ADMITTED',
    code: 'ADMITTED',
    category: 'BUSINESS',
    reasonCode: 'CAMPAIGN_TARGET_ADMITTED',
    failureClass: 'NONE',
    retryDisposition: 'NONE',
    observedAt: '2026-09-11T10:00:01.000Z',
    ownerAggregate: { type: 'campaign_target', id: 'record-a', version: 1 },
    auditRef: 'audit-a',
  };
  assert.deepEqual(validateOwnerResultPayload(result), result);
  assert.throws(() => validateOwnerResultPayload({ ...result, status: 'CREATED' }));
  assert.throws(() =>
    validateOwnerResultPayload({
      ...result,
      ownerAggregate: { type: 'callback', id: 'callback-a', version: 1 },
    }),
  );
  assert.throws(() => validateOwnerResultPayload({ ...result, ownerAggregate: undefined }));
  assert.throws(() =>
    validateOwnerResultPayload({
      ...result,
      status: 'REJECTED',
      code: 'OWNER_REJECTED',
      category: 'TERMINAL',
      failureClass: 'NONE',
      retryDisposition: 'DO_NOT_RETRY',
      ownerAggregate: undefined,
    }),
  );
});

test('binds J2 V2 outcome, command and result envelopes to their canonical lineage', () => {
  const command = withOwnerRequestHash(tenant, commandDraft);
  const result: J2OwnerResultPayloadV1 = {
    contractVersion: 1,
    commandId: command.commandId,
    actionKey: command.actionKey,
    requestHash: command.requestHash,
    commandType: command.commandType,
    status: 'ADMITTED',
    code: 'ADMITTED',
    category: 'BUSINESS',
    reasonCode: 'CAMPAIGN_TARGET_ADMITTED',
    failureClass: 'NONE',
    retryDisposition: 'NONE',
    observedAt: '2026-09-11T10:00:01.000Z',
    ownerAggregate: { type: 'campaign_target', id: 'record-a', version: 1 },
  };
  const outcomeEvent: J2KafkaEnvelopeV2<InteractionOutcomePayloadV1> = {
    schemaVersion: 2,
    eventKind: 'CANONICAL',
    eventId: 'event-outcome-a',
    type: J2_EVENT_TYPES.INTERACTION_OUTCOME_RECORDED,
    tenantId: tenant,
    occurredAt: outcome.effectiveAt,
    correlationId: 'correlation-a',
    orderingKey: outcome.interactionId,
    aggregateType: 'interaction_outcome',
    aggregateId: outcome.outcomeId,
    aggregateVersion: outcome.outcomeVersion,
    payload: outcome,
  };
  const commandEvent: J2KafkaEnvelopeV2<typeof command> = {
    schemaVersion: 2,
    eventKind: 'COMMAND',
    eventId: command.commandId,
    type: J2_COMMAND_EVENT_TYPE[command.commandType],
    tenantId: tenant,
    occurredAt: '2026-09-11T10:00:00.500Z',
    correlationId: outcomeEvent.correlationId,
    causationId: outcomeEvent.eventId,
    orderingKey: command.actionKey,
    aggregateType: 'journey_action',
    aggregateId: command.actionKey,
    aggregateVersion: 0,
    payload: command,
  };
  const resultEvent: J2KafkaEnvelopeV2<J2OwnerResultPayloadV1> = {
    schemaVersion: 2,
    eventKind: 'CANONICAL',
    eventId: 'event-result-a',
    type: J2_RESULT_EVENT_TYPE[result.commandType],
    tenantId: tenant,
    occurredAt: result.observedAt,
    correlationId: outcomeEvent.correlationId,
    causationId: commandEvent.eventId,
    orderingKey: result.actionKey,
    aggregateType: 'dialer_command_receipt',
    aggregateId: result.commandId,
    aggregateVersion: 1,
    payload: result,
  };

  assert.deepEqual(assertInteractionOutcomeEnvelope(outcomeEvent), outcomeEvent);
  assert.deepEqual(assertOwnerCommandEnvelope(commandEvent), commandEvent);
  assert.deepEqual(assertOwnerResultEnvelope(resultEvent), resultEvent);
  assert.doesNotThrow(() => assertOwnerCommandCausation(outcomeEvent, commandEvent));
  assert.doesNotThrow(() => assertOwnerResultBinding(commandEvent, resultEvent));
  assert.doesNotThrow(() =>
    assertOwnerResultQueryBinding(
      { contractVersion: 1, actionKey: command.actionKey, requestHash: command.requestHash },
      result,
    ),
  );

  assert.throws(() =>
    assertInteractionOutcomeEnvelope({ ...outcomeEvent, orderingKey: 'wrong-interaction' }),
  );
  assert.throws(() =>
    assertOwnerCommandCausation(outcomeEvent, { ...commandEvent, causationId: 'wrong-event' }),
  );
  assert.throws(() =>
    assertOwnerCommandCausation(outcomeEvent, {
      ...commandEvent,
      payload: {
        ...command,
        sourceOutcome: { ...command.sourceOutcome, outcomeId: outcomeId('outcome-other') },
      },
    }),
  );
  assert.throws(() =>
    assertOwnerResultBinding(commandEvent, {
      ...resultEvent,
      payload: { ...result, requestHash: 'a'.repeat(64) },
    }),
  );
  assert.throws(() =>
    assertOwnerResultEnvelope({ ...resultEvent, aggregateType: 'unknown_command_receipt' }),
  );
  assert.throws(() =>
    assertOwnerResultQueryBinding(
      { contractVersion: 1, actionKey: command.actionKey, requestHash: 'b'.repeat(64) },
      result,
    ),
  );
});

test('validates sanitized owner action query and freezes every error mapping', () => {
  const command = withOwnerRequestHash(tenant, commandDraft);
  assert.deepEqual(
    validateOwnerActionQuery({
      contractVersion: 1,
      actionKey: command.actionKey,
      requestHash: command.requestHash,
    }),
    {
      contractVersion: 1,
      actionKey: command.actionKey,
      requestHash: command.requestHash,
    },
  );
  assert.equal(J2_ERROR_CONTRACT.OWNER_ACK_UNKNOWN.retryDisposition, 'RECONCILE');
  assert.equal(J2_ERROR_CONTRACT.OWNER_UNAVAILABLE.retryDisposition, 'RETRY_SAME_IDENTITY');
  assert.equal(J2_ERROR_CONTRACT.ACTION_TOO_LATE.retryDisposition, 'DO_NOT_RETRY');
  assert.equal(
    J2_COMMAND_EVENT_TYPE.ADMIT_CAMPAIGN_TARGET,
    J2_EVENT_TYPES.CAMPAIGN_TARGET_ADMISSION_REQUESTED,
  );
  assert.equal(
    J2_RESULT_EVENT_TYPE.ADMIT_CAMPAIGN_TARGET,
    J2_EVENT_TYPES.CAMPAIGN_TARGET_ADMISSION_COMPLETED,
  );
});
