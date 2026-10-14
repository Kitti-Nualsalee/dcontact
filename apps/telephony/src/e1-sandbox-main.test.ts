import assert from 'node:assert/strict';
import test from 'node:test';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { createE1SandboxPublisher, e1CallSource } from './e1-sandbox-main.js';
import { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';

test('#667: synthetic inbound ส่ง bridge ครั้งเดียวหลัง park ทั้ง event เร็วและซ้ำ', async () => {
  const knownCalls = new Set<string>();
  const commands: { receivedAt: string; command: string }[] = [];
  let receivedAt = '';
  const adapter = new FreeSwitchCommandAdapter(
    { command: async (command) => void commands.push({ receivedAt, command }) },
    'dcontact-uat.sip.internal',
    'e1-uat-sandbox',
  );
  const fixture = {
    'Unique-ID': 'synthetic-call',
    'Call-Direction': 'inbound',
    'Caller-Caller-ID-Number': '1102',
    'Caller-Destination-Number': '1101',
    variable_domain_name: 'dcontact-uat.sip.internal',
  };
  for (const eventName of ['CHANNEL_CREATE', 'CHANNEL_PARK', 'CHANNEL_CREATE', 'CHANNEL_PARK']) {
    receivedAt = eventName;
    const source = e1CallSource({ ...fixture, 'Event-Name': eventName }, (uuid) =>
      knownCalls.has(uuid),
    );
    if (source?.['Event-Name'] !== 'CHANNEL_CREATE') continue;
    await adapter.handle({
      type: 'call.bridge',
      vendor: 'freeswitch',
      telephonyNodeId: 'e1-uat-sandbox',
      callUuid: fixture['Unique-ID'],
      agentExtension: '1101',
    });
    knownCalls.add(fixture['Unique-ID']);
  }
  assert.deepEqual(commands, [
    {
      receivedAt: 'CHANNEL_PARK',
      command: 'api uuid_transfer synthetic-call bridge:user/1101@dcontact-uat.sip.internal inline',
    },
  ]);
});

test('#667: defer เฉพาะคู่สังเคราะห์ inbound ไม่กระทบ event อื่นหรือ outbound Delivery', () => {
  const fixture = {
    'Event-Name': 'CHANNEL_CREATE',
    'Call-Direction': 'inbound',
    'Caller-Caller-ID-Number': '1102',
    'Caller-Destination-Number': '1101',
  };
  for (const changes of [
    { 'Caller-Caller-ID-Number': '1103' },
    { 'Caller-Destination-Number': '1103' },
    { 'Call-Direction': 'outbound' },
    { variable_dcontact_delivery_id: 'delivery-1' },
    { 'Event-Name': 'CHANNEL_BRIDGE' },
    { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE' },
  ]) {
    const event = { ...fixture, ...changes };
    assert.equal(
      e1CallSource(event, () => false),
      event,
    );
  }
});

test('E1 sandbox ส่งต่อเฉพาะ telephony command ไปยัง FreeSWITCH', async () => {
  const commands: string[] = [];
  const publisher = createE1SandboxPublisher(
    new FreeSwitchCommandAdapter(
      { command: async (command) => void commands.push(command) },
      'dcontact-uat.sip.internal',
      'e1-uat-sandbox',
    ),
  );

  const envelope = {
    eventId: 'event-1',
    type: 'command',
    tenantId: 'tenant-1',
    occurredAt: '2026-10-08T00:00:00.000Z',
    correlationId: 'correlation-1',
    orderingKey: 'call-1',
    payload: {
      type: 'call.bridge' as const,
      vendor: 'freeswitch' as const,
      telephonyNodeId: 'e1-uat-sandbox',
      callUuid: 'call-1',
      agentExtension: '1101',
    },
  };

  await publisher(KAFKA_TOPICS.AGENT_EVENTS, envelope);
  await publisher(KAFKA_TOPICS.TELEPHONY_COMMANDS, envelope);

  assert.deepEqual(commands, [
    'api uuid_transfer call-1 bridge:user/1101@dcontact-uat.sip.internal inline',
  ]);
});
