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

test('bridge ของสาย managed สร้าง call.answered ของสายลูกค้า', () => {
  const event = trigger().decide(bridge(caller), tenantId);
  assert.equal(event?.type, 'call.answered');
  assert.equal(event?.tenantId, tenantId);
  assert.equal(event?.payload.callUuid, caller);
  assert.equal(event?.payload.vendor, 'freeswitch');
});

test('bridge ซ้ำจากสองขาไม่เริ่มบันทึกซ้ำ และเริ่มใหม่ได้หลัง hangup', () => {
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

test('hangup ของขาลูกค้าสร้าง call.hangup แต่ขา Agent ไม่สร้าง', () => {
  const recording = trigger();
  const customerLeg = recording.decide(hangup(caller), tenantId);
  assert.equal(customerLeg?.type, 'call.hangup');
  assert.equal(customerLeg?.payload.callUuid, caller);
  assert.equal(recording.decide(hangup(bleg), tenantId), undefined);
});

test('event อื่นของสาย managed และ bridge ที่ไม่ครบเงื่อนไขไม่เริ่มบันทึก', () => {
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

test('tenant หรือ node ไม่ตรงถูกเมินโดยไม่ throw', () => {
  const recording = trigger();
  assert.equal(recording.decide(bridge(caller), 'other-tenant'), undefined);
  assert.equal(
    recording.decide({ ...bridge(caller), variable_dcontact_node_id: 'other-node' }, tenantId),
    undefined,
  );
});

test('ขา offer ยังปิดบันทึกเมื่อ managed runtime throw และไม่เรียกเมื่อ tenant ไม่ใช่ uuid', async () => {
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

test('สายที่จำว่าเริ่มบันทึกแล้วมีเพดาน กันค้างเมื่อ hangup ไม่มา', () => {
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
