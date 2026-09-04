import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFreeSwitchEvent } from './freeswitch-normalizer.js';

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
