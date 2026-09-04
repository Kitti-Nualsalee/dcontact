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

test('call.collect starts voice recognition before DTMF fallback is requested by Router', async () => {
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
    type: 'call.collect',
    inputMode: 'VOICE',
    prompt: 'Please say sales or support',
    timeoutSec: 5,
  } as never);

  assert.deepEqual(commands, [
    'api uuid_answer call-100',
    'api uuid_broadcast call-100 say:flite.slt:Please_say_sales_or_support aleg',
    'api uuid_broadcast call-100 detect_speech:pocketsphinx aleg',
  ]);
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

test('recording pause and resume preserve the recording path on the owning FreeSWITCH node', async () => {
  const commands: string[] = [];
  const adapter = new FreeSwitchCommandAdapter(
    { command: async (value) => void commands.push(value) },
    'dcontact.local',
    'fs-bkk-02',
  );

  await adapter.handle({
    callUuid: 'call-100',
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-02',
    type: 'recording.pause',
    recordingPath: '/var/recordings/tenant-a/call-100.wav',
  } as never);
  await adapter.handle({
    callUuid: 'call-100',
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-02',
    type: 'recording.resume',
    recordingPath: '/var/recordings/tenant-a/call-100.wav',
  } as never);

  assert.deepEqual(commands, [
    'api uuid_record call-100 pause /var/recordings/tenant-a/call-100.wav',
    'api uuid_record call-100 resume /var/recordings/tenant-a/call-100.wav',
  ]);
});

test('recording announcement is sent before the telephony node starts its stereo recording', async () => {
  const commands: string[] = [];
  const adapter = new FreeSwitchCommandAdapter(
    { command: async (value) => void commands.push(value) },
    'dcontact.local',
    'fs-bkk-02',
  );

  await adapter.handle({
    callUuid: 'call-100',
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-02',
    type: 'recording.announce',
    announcement: 'This call is recorded',
    language: 'en-US',
  } as never);
  await adapter.handle({
    callUuid: 'call-100',
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-02',
    type: 'recording.start',
    recordingPath: '/var/recordings/tenant-a/call-100.wav',
    channelLayout: 'STEREO',
  } as never);

  assert.deepEqual(commands, [
    'api uuid_broadcast call-100 say:flite.slt:This_call_is_recorded aleg',
    'api uuid_record call-100 start /var/recordings/tenant-a/call-100.wav',
  ]);
});
