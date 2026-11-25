import assert from 'node:assert/strict';
import test from 'node:test';
import type { FreeSwitchEvent } from './freeswitch-normalizer.js';
import {
  ManagedRecordingTrigger,
  routeManagedOfferLegWithRecording,
} from './managed-voice-recording.js';

const tenantId = '7f6b4b3e-1d0f-4c38-9a8c-9d5b0c6e2a11';
const caller = 'caller-uuid';
const bleg = 'bleg-uuid';
const managedVars = {
  variable_dcontact_tenant_id: tenantId,
  variable_dcontact_node_id: 'node-1',
  variable_dcontact_call_uuid: caller,
  variable_dcontact_offer_id: 'offer-1',
  variable_dcontact_agent_id: 'agent-1',
  variable_dcontact_bleg_uuid: bleg,
};
const numbers = { 'Caller-Caller-ID-Number': '0812345678', 'Caller-Destination-Number': '2000' };
const bridge = (uniqueId: string): FreeSwitchEvent => ({
  'Event-Name': 'CHANNEL_BRIDGE',
  'Unique-ID': uniqueId,
  'Bridge-A-Unique-ID': caller,
  ...numbers,
  ...managedVars,
});
const hangup = (uniqueId: string, extra: FreeSwitchEvent = {}): FreeSwitchEvent => ({
  'Event-Name': 'CHANNEL_HANGUP_COMPLETE',
  'Unique-ID': uniqueId,
  ...numbers,
  ...managedVars,
  ...extra,
});
const trigger = () =>
  new ManagedRecordingTrigger({
    telephonyNodeId: 'node-1',
    eventId: () => 'event-1',
    now: () => '2026-11-22T03:00:00.000Z',
  });

test('a bridge of a managed call produces call.answered for the customer call', () => {
  const event = trigger().decide(bridge(caller), tenantId);
  assert.equal(event?.type, 'call.answered');
  assert.equal(event?.tenantId, tenantId);
  assert.equal(event?.payload.callUuid, caller);
  assert.equal(event?.payload.vendor, 'freeswitch');
});

test('a repeated bridge from both legs does not start recording again, and it can start again after hangup', () => {
  const recording = trigger();
  assert.equal(recording.decide(bridge(caller), tenantId)?.type, 'call.answered');
  assert.equal(recording.decide(bridge(bleg), tenantId), undefined);
  assert.equal(recording.decide(bridge(caller), tenantId), undefined);
  assert.equal(
    recording.decide(hangup(caller, { variable_dcontact_offer_id: undefined }), tenantId)?.type,
    'call.hangup',
  );
  assert.equal(recording.pending, 0);
});

test('a hangup of the customer leg produces call.hangup but the Agent leg does not', () => {
  const recording = trigger();
  const customerLeg = recording.decide(hangup(caller), tenantId);
  assert.equal(customerLeg?.type, 'call.hangup');
  assert.equal(customerLeg?.payload.callUuid, caller);
  assert.equal(recording.decide(hangup(bleg), tenantId), undefined);
});

test('other events of a managed call and a bridge that does not meet all conditions do not start recording', () => {
  const recording = trigger();
  for (const name of ['CHANNEL_CREATE', 'CHANNEL_ANSWER']) {
    assert.equal(recording.decide({ ...bridge(caller), 'Event-Name': name }, tenantId), undefined);
  }
  assert.equal(
    recording.decide({ ...bridge(caller), variable_dcontact_offer_id: undefined }, tenantId),
    undefined,
  );
  assert.equal(
    recording.decide({ ...bridge(caller), 'Bridge-A-Unique-ID': 'other-call' }, tenantId),
    undefined,
  );
  assert.equal(recording.pending, 0);
});

test('a mismatched tenant or node is ignored without throwing', () => {
  const recording = trigger();
  assert.equal(recording.decide(bridge(caller), 'other-tenant'), undefined);
  assert.equal(
    recording.decide({ ...bridge(caller), variable_dcontact_node_id: 'other-node' }, tenantId),
    undefined,
  );
});

test('the offer leg still closes recording when the managed runtime throws, and is not called when the tenant is not a uuid', async () => {
  const recorded: string[] = [];
  const record = async (source: FreeSwitchEvent, tenant: string) => {
    recorded.push(`${source['Event-Name']}:${tenant}`);
  };
  await assert.rejects(
    routeManagedOfferLegWithRecording(
      hangup(caller),
      async () => {
        throw new Error('lock timeout');
      },
      record,
    ),
    /lock timeout/,
  );
  assert.deepEqual(recorded, [`CHANNEL_HANGUP_COMPLETE:${tenantId}`]);
  assert.equal(
    await routeManagedOfferLegWithRecording(
      hangup(caller, { variable_dcontact_tenant_id: 'not-a-uuid' }),
      async () => 'ignored',
      record,
    ),
    'ignored',
  );
  assert.equal(recorded.length, 1);
});

test('the set of calls remembered as already recording has a cap, to avoid leaks when hangup never arrives', () => {
  const subject = trigger();
  for (let index = 0; index < 1_005; index += 1) {
    const uuid = `caller-${index}`;
    subject.decide(
      {
        ...bridge(uuid),
        'Bridge-A-Unique-ID': uuid,
        variable_dcontact_call_uuid: uuid,
      },
      tenantId,
    );
  }
  assert.equal(subject.pending, 1_000);
});
