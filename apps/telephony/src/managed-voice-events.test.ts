import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeManagedVoiceEvent } from './managed-voice-events.js';

test('answer keeps the exact offer/agent/B-leg and caller correlation', () => {
  const source = {
    'Event-Name': 'CHANNEL_ANSWER',
    'Unique-ID': 'bleg',
    variable_dcontact_tenant_id: 'tenant',
    variable_dcontact_node_id: 'node',
    variable_dcontact_call_uuid: 'caller',
    variable_dcontact_offer_id: 'old-offer',
    variable_dcontact_agent_id: 'agent',
    variable_dcontact_bleg_uuid: 'bleg',
  };
  assert.deepEqual(normalizeManagedVoiceEvent(source, 'tenant', 'node'), {
    tenantId: 'tenant',
    telephonyNodeId: 'node',
    callUuid: 'caller',
    type: 'call.answered',
    offerId: 'old-offer',
    agentId: 'agent',
    blegUuid: 'bleg',
  });
  assert.equal(
    normalizeManagedVoiceEvent(
      { ...source, variable_dcontact_offer_id: undefined },
      'tenant',
      'node',
    ),
    undefined,
  );
  assert.equal(
    normalizeManagedVoiceEvent({ ...source, 'Event-Name': 'CHANNEL_CREATE' }, 'tenant', 'node'),
    undefined,
  );
  assert.throws(() => normalizeManagedVoiceEvent(source, 'foreign', 'node'), /TENANT_MISMATCH/);
  assert.throws(() => normalizeManagedVoiceEvent(source, 'tenant', 'foreign'), /NODE_MISMATCH/);
  assert.deepEqual(
    normalizeManagedVoiceEvent(
      { ...source, 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': 'caller' },
      'tenant',
      'node',
    ),
    { tenantId: 'tenant', telephonyNodeId: 'node', callUuid: 'caller', type: 'call.hangup' },
  );
});

test('hangup initiator follows the SIP disposition of the leg, so both legs agree on who hung up', () => {
  const caller = {
    'Event-Name': 'CHANNEL_HANGUP_COMPLETE',
    'Unique-ID': 'caller',
    variable_dcontact_tenant_id: 'tenant',
    variable_dcontact_node_id: 'node',
    variable_dcontact_call_uuid: 'caller',
  };
  const agent = {
    ...caller,
    'Unique-ID': 'bleg',
    variable_dcontact_offer_id: 'offer',
    variable_dcontact_agent_id: 'agent',
    variable_dcontact_bleg_uuid: 'bleg',
  };
  const initiator = (
    source: Record<string, unknown>,
    disposition?: string,
    cause = 'NORMAL_CLEARING',
  ) =>
    normalizeManagedVoiceEvent(
      { ...source, variable_sip_hangup_disposition: disposition, 'Hangup-Cause': cause },
      'tenant',
      'node',
    )?.hangupInitiator;
  // The customer hangs up: the caller leg received BYE, the Agent leg was sent BYE
  assert.equal(initiator(caller, 'recv_bye'), 'caller');
  assert.equal(initiator(agent, 'send_bye'), 'caller');
  // The Agent hangs up: the Agent leg received BYE, the caller leg was sent BYE
  assert.equal(initiator(agent, 'recv_bye'), 'agent');
  assert.equal(initiator(caller, 'send_bye'), 'agent');
  assert.equal(initiator(caller, 'recv_cancel'), 'caller');
  // A switch-side end (media timeout, kill) sends BYE on both legs: no initiator rather than a guess
  assert.equal(initiator(caller, 'send_bye', 'MEDIA_TIMEOUT'), undefined);
  assert.equal(initiator(agent, 'send_bye', 'MEDIA_TIMEOUT'), undefined);
  assert.equal(initiator(agent, 'send_bye', 'SYSTEM_SHUTDOWN'), undefined);
  // A BYE received from the far end is trusted whatever the cause
  assert.equal(initiator(caller, 'recv_bye', 'MEDIA_TIMEOUT'), 'caller');
  // Unknown or missing disposition: no initiator, the runtime keeps its previous reason
  assert.equal(initiator(caller), undefined);
  assert.equal(initiator(caller, 'other'), undefined);
  // Only hangups carry an initiator
  assert.equal(
    normalizeManagedVoiceEvent(
      { ...agent, 'Event-Name': 'CHANNEL_ANSWER', variable_sip_hangup_disposition: 'recv_bye' },
      'tenant',
      'node',
    )?.hangupInitiator,
    undefined,
  );
});
