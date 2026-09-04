import assert from 'node:assert/strict';
import test from 'node:test';
import { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';

test('call.bridge bridges the parked UUID to the assigned softphone extension', async () => {
  const commands: string[] = [];
  const adapter = new FreeSwitchCommandAdapter({
    command: async (value) => {
      commands.push(value);
    },
  });
  await adapter.handle({
    callUuid: 'call-100', vendor: 'freeswitch', type: 'call.bridge', agentExtension: '1000',
  });
  assert.deepEqual(commands, ['api uuid_bridge call-100 user/1000@dcontact.local']);
});
