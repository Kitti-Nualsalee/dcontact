import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { localRtpRelayConfiguration } from './local-rtp-relay-main.js';

const configuration = {
  publicationAddress: '172.30.250.2',
  relayMediaAddress: '172.30.250.10',
  freeSwitchMediaAddress: '172.30.250.11',
  publicationSubnet: '172.30.250.0/29',
  mediaSubnet: '172.30.250.8/29',
};
const environment = {
  LOCAL_RTP_RELAY_PROJECT: 'dcontact-v1b-local',
  LOCAL_RTP_RELAY_HOST: 'workspace.dcontact.test',
  LOCAL_RTP_RELAY_CONFIG_JSON: JSON.stringify(configuration),
};

test('local relay CLI ออกจาก process แม้ shutdown ล้มและมี handle ค้าง', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--require',
      'tsx/cjs',
      '--eval',
      `
    const os = require('node:os');
    os.networkInterfaces = () => ({ fixture: [
      {family:'IPv4',internal:false,address:'172.30.250.2'},
      {family:'IPv4',internal:false,address:'172.30.250.10'}
    ] });
    const adapter = require('./src/local-rtp-relay.ts');
    adapter.startLocalRtpRelay = async () => ({
      snapshot: () => ({ready:false,failureCode:'FRONT_SOCKET_FAILED'}),
      close: async () => { throw new Error('synthetic shutdown timeout'); }
    });
    setInterval(() => {}, 10000);
    require('./src/local-rtp-relay-main.ts').runLocalRtpRelayCli();
  `,
    ],
    { env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 3000 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /LOCAL_RTP_RELAY_FAILED/);
  assert.doesNotMatch(result.stderr, /synthetic shutdown timeout/);
});

test('local relay CLI configuration ต้อง opt-in project และ host ตรงกัน', () => {
  assert.deepEqual(localRtpRelayConfiguration(environment), configuration);
  for (const patch of [
    { LOCAL_RTP_RELAY_PROJECT: undefined },
    { LOCAL_RTP_RELAY_PROJECT: 'dev-db' },
    { LOCAL_RTP_RELAY_HOST: 'workspace.example.com' },
  ])
    assert.throws(
      () => localRtpRelayConfiguration({ ...environment, ...patch }),
      /LOCAL_RTP_SCOPE_REFUSED/,
    );
});

test('local relay CLI configuration ไม่รับ arbitrary fields หรือ malformed input', () => {
  for (const value of [
    '',
    '{',
    'null',
    '[]',
    '{}',
    JSON.stringify({ ...configuration, target: 'postgres' }),
    JSON.stringify({ ...configuration, relayMediaAddress: 42 }),
  ]) {
    assert.throws(
      () => localRtpRelayConfiguration({ ...environment, LOCAL_RTP_RELAY_CONFIG_JSON: value }),
      /INVALID_LOCAL_RTP_CONFIGURATION/,
    );
  }
});
