import assert from 'node:assert/strict';
import test from 'node:test';
import { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';

test('call.bridge bridges the parked UUID to the assigned softphone extension', async () => {
  const commands: string[] = [];
  const adapter = new FreeSwitchCommandAdapter(
    {
      command: async (value) => {
        commands.push(value);
      },
    },
    'dcontact.local',
    'fs-bkk-02',
  );
  await adapter.handle({
    callUuid: 'call-100',
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-02',
    type: 'call.bridge',
    agentExtension: '1000',
  });
  assert.deepEqual(commands, ['api uuid_transfer call-100 bridge:user/1000@dcontact.local inline']);
});

test('a command for another FreeSWITCH node is ignored', async () => {
  const commands: string[] = [];
  const adapter = new FreeSwitchCommandAdapter(
    {
      command: async (value) => {
        commands.push(value);
      },
    },
    'dcontact.local',
    'fs-bkk-02',
  );
  await adapter.handle({
    callUuid: 'call-100',
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-03',
    type: 'call.bridge',
    agentExtension: '1000',
  });
  assert.deepEqual(commands, []);
});
