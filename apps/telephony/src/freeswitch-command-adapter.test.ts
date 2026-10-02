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

test('sip.registration.flush removes only the revoked lease registration', async () => {
  const commands: string[] = [];
  const adapter = new FreeSwitchCommandAdapter(
    { command: async (value) => void commands.push(value) },
    'dcontact.local',
    'fs-bkk-02',
  );

  await adapter.handle({
    type: 'sip.registration.flush',
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-02',
    extension: '1000',
    sipDomain: 'tenant-a.voice.example',
    workSessionLeaseId: '5f39f3a4-3454-42a4-b5a0-d50f295912de',
  });

  assert.deepEqual(commands, [
    'api sofia profile internal flush_inbound_reg 1000@tenant-a.voice.example',
  ]);
});

test('call.originate ปิดเป็นค่าเริ่มต้นและไม่ resolve target หรือแตะ ESL', async () => {
  const commands: string[] = [];
  const adapter = new FreeSwitchCommandAdapter({
    command: async (value) => void commands.push(value),
  });
  await adapter.handle(
    {
      type: 'call.originate',
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-local',
      deliveryId: 'dlv_opaque',
      providerRequestKey: 'prv_opaque',
      originationUuid: '6e9a4adf-1120-4a63-9e5b-89aecbf88b16',
      agentExtension: '1000',
      targetIdentityId: 'opaque-target',
    },
    '4a9f93f5-d25c-4c58-9ec7-b8ee811c7160',
  );
  assert.deepEqual(commands, []);
});

test('call.originate resolve ได้เฉพาะ internal extension และส่ง opaque correlation ไป ESL', async () => {
  const commands: string[] = [];
  const adapter = new FreeSwitchCommandAdapter(
    { command: async (value) => void commands.push(value) },
    'dcontact.local',
    'fs-bkk-02',
    undefined,
    {
      enabled: true,
      resolver: { resolve: async () => ({ extension: '1001' }) },
    },
  );
  await adapter.handle(
    {
      type: 'call.originate',
      vendor: 'freeswitch',
      telephonyNodeId: 'fs-bkk-02',
      deliveryId: 'dlv_opaque',
      providerRequestKey: 'prv_opaque',
      originationUuid: '6e9a4adf-1120-4a63-9e5b-89aecbf88b16',
      agentExtension: '1000',
      targetIdentityId: 'opaque-target',
    },
    '4a9f93f5-d25c-4c58-9ec7-b8ee811c7160',
  );
  assert.deepEqual(commands, [
    'bgapi originate {origination_uuid=6e9a4adf-1120-4a63-9e5b-89aecbf88b16,dcontact_tenant_id=4a9f93f5-d25c-4c58-9ec7-b8ee811c7160,dcontact_delivery_id=dlv_opaque,dcontact_provider_request_key=prv_opaque}user/1000@dcontact.local &bridge(user/1001@dcontact.local)',
  ]);
});

test('call.cancel ฆ่าเฉพาะ deterministic origination UUID เมื่อ voice gate เปิด', async () => {
  const commands: string[] = [];
  const adapter = new FreeSwitchCommandAdapter(
    { command: async (value) => void commands.push(value) },
    'dcontact.local',
    'fs-bkk-02',
    undefined,
    { enabled: true },
  );
  await adapter.handle({
    type: 'call.cancel',
    vendor: 'freeswitch',
    telephonyNodeId: 'fs-bkk-02',
    callUuid: '6e9a4adf-1120-4a63-9e5b-89aecbf88b16',
    deliveryId: 'dlv_opaque',
    providerRequestKey: 'prv_opaque',
  });
  assert.deepEqual(commands, [
    'api uuid_kill 6e9a4adf-1120-4a63-9e5b-89aecbf88b16 ORIGINATOR_CANCEL',
  ]);
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
