import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDeniedAgentDirectOutbound,
  normalizeFreeSwitchEvent,
  parkedCallAsCreated,
} from './freeswitch-normalizer.js';

test('filters agent direct outbound denied by the FreeSWITCH dialplan', () => {
  assert.equal(
    isDeniedAgentDirectOutbound({
      'Caller-Caller-ID-Number': '1000',
      'Caller-Destination-Number': '0812345678',
    }),
    true,
  );
  assert.equal(
    isDeniedAgentDirectOutbound({
      'Caller-Caller-ID-Number': '1000',
      'Caller-Destination-Number': '0812345678',
      variable_dcontact_delivery_id: 'delivery_opaque_1',
    }),
    false,
  );
  assert.equal(
    isDeniedAgentDirectOutbound({
      'Caller-Caller-ID-Number': '1000',
      'Caller-Destination-Number': '1001',
    }),
    false,
  );
});

test('CHANNEL_CREATE becomes a tenant-bound vendor-neutral call.created envelope', () => {
  const normalized = normalizeFreeSwitchEvent(
    {
      'Event-Name': 'CHANNEL_CREATE',
      'Unique-ID': 'call-100',
      'Caller-Caller-ID-Number': '1002',
      'Caller-Destination-Number': '2000',
      variable_domain_name: 'dcontact.local',
    },
    {
      resolveTenantId: (sipDomain) => (sipDomain === 'dcontact.local' ? 'tenant-demo' : undefined),
      telephonyNodeId: 'fs-bkk-02',
      eventId: () => 'event-100',
      now: () => '2026-09-04T05:00:00.000Z',
    },
  );

  assert.deepEqual(normalized, {
    eventId: 'event-100',
    type: 'call.created',
    tenantId: 'tenant-demo',
    occurredAt: '2026-09-04T05:00:00.000Z',
    correlationId: 'call-100',
    orderingKey: 'call-100',
    payload: {
      callUuid: 'call-100',
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-bkk-02',
      caller: '1002',
      destination: '2000',
    },
  });
});

test('CHANNEL_BRIDGE reports media active against the original parked call UUID', () => {
  const normalized = normalizeFreeSwitchEvent(
    {
      'Event-Name': 'CHANNEL_BRIDGE',
      'Unique-ID': 'agent-leg-200',
      'Bridge-A-Unique-ID': 'call-100',
      'Caller-Caller-ID-Number': '1002',
      'Caller-Destination-Number': '2000',
      variable_domain_name: 'dcontact.local',
    },
    {
      resolveTenantId: () => 'tenant-demo',
      telephonyNodeId: 'fs-bkk-02',
      eventId: () => 'event-bridge',
      now: () => '2026-09-04T05:00:01.000Z',
    },
  );
  assert.equal(normalized.type, 'call.answered');
  assert.equal(normalized.payload.callUuid, 'call-100');
  assert.equal(normalized.orderingKey, 'call-100');
});

test('outbound events preserve only opaque delivery correlation metadata', () => {
  const normalized = normalizeFreeSwitchEvent(
    {
      'Event-Name': 'CHANNEL_HANGUP_COMPLETE',
      'Unique-ID': 'call-voice-1',
      'Caller-Caller-ID-Number': '1001',
      'Caller-Destination-Number': 'external',
      variable_domain_name: 'dcontact.local',
      variable_dcontact_delivery_id: 'delivery_opaque_1',
      variable_dcontact_provider_request_key: 'provider_opaque_1',
      'Hangup-Cause': 'NO_ANSWER',
    },
    {
      resolveTenantId: () => 'tenant-demo',
      telephonyNodeId: 'fs-bkk-02',
      eventId: () => 'event-hangup',
      now: () => '2026-09-04T05:00:02.000Z',
    },
  );
  assert.equal(normalized.payload.deliveryId, 'delivery_opaque_1');
  assert.equal(normalized.payload.providerRequestKey, 'provider_opaque_1');
  assert.equal(normalized.payload.hangupCause, 'NO_ANSWER');
});

test('DTMF without channel variables resolves the tenant from its original call UUID', () => {
  const normalized = normalizeFreeSwitchEvent(
    {
      'Event-Name': 'DTMF',
      'Unique-ID': 'call-100',
      'Caller-Caller-ID-Number': '1002',
      'Caller-Destination-Number': '2001',
      'DTMF-Digit': '2',
    },
    {
      resolveTenantId: () => 'tenant-demo',
      resolveTenantIdForCall: (callUuid) => (callUuid === 'call-100' ? 'tenant-demo' : undefined),
      telephonyNodeId: 'fs-bkk-02',
      eventId: () => 'event-dtmf',
      now: () => '2026-09-04T05:00:00.000Z',
    },
  );

  assert.equal(normalized.type, 'call.input');
  assert.deepEqual(normalized.payload, {
    callUuid: 'call-100',
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-02',
    caller: '1002',
    destination: '2001',
    inputMode: 'DTMF',
    inputValue: '2',
  });
});

test('#562: สายจาก trunk ที่ยังไม่รู้ tenant ตอน create ใช้ CHANNEL_PARK เป็น call.created ครั้งเดียว', () => {
  const parked = {
    'Event-Name': 'CHANNEL_PARK',
    'Unique-ID': 'trunk-call-1',
    'Caller-Caller-ID-Number': 'pstn-caller',
    'Caller-Destination-Number': '2000',
    variable_domain_name: 'dcontact.local',
  };
  const created = parkedCallAsCreated(parked, () => false);
  assert.equal(created?.['Event-Name'], 'CHANNEL_CREATE');
  const event = normalizeFreeSwitchEvent(created!, {
    telephonyNodeId: 'node-a',
    resolveTenantId: (domain) => (domain === 'dcontact.local' ? 'tenant-a' : undefined),
    eventId: () => 'event-1',
    now: () => '2026-10-01T00:00:00.000Z',
  });
  assert.equal(event.type, 'call.created');
  assert.equal(event.tenantId, 'tenant-a');
  assert.equal(event.payload.callUuid, 'trunk-call-1');

  // สายที่ออก call.created ไปแล้วตอน create (เช่น ผ่าน directory) ไม่ซ้ำ
  assert.equal(
    parkedCallAsCreated(parked, (uuid) => uuid === 'trunk-call-1'),
    undefined,
  );
  assert.equal(
    parkedCallAsCreated({ ...parked, 'Event-Name': 'CHANNEL_CREATE' }, () => false),
    undefined,
  );
  assert.equal(
    parkedCallAsCreated({ ...parked, 'Unique-ID': ' ' }, () => false),
    undefined,
  );
});
