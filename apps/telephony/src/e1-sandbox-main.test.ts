import assert from 'node:assert/strict';
import test from 'node:test';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { createE1SandboxPublisher } from './e1-sandbox-main.js';
import { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';

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
