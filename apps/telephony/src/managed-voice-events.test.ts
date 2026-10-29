import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeManagedVoiceEvent } from './managed-voice-events.js';

test('answer เก็บ exact offer/agent/B-leg และ caller correlation', () => {
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
