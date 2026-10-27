import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { renderRealm } from './u1-uat-keycloak-users.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, 'infra/uat');
const files = [
  'docker-compose.uat.yml',
  'docker-compose.uat.e1.yml',
  'docker-compose.uat.workspace.yml',
  'docker-compose.uat.workspace-local.yml',
];
const environment = { PATH: process.env.PATH, HOME: process.env.HOME };
for (const filename of files) {
  const source = readFileSync(resolve(directory, filename), 'utf8');
  for (const match of source.matchAll(/\$\{([A-Z][A-Z0-9_]*):\?/g)) {
    environment[match[1]] = 'local-fixture-only';
  }
}
Object.assign(environment, {
  UAT_HOST: 'console.dcontact.test',
  UAT_WORKSPACE_HOST: 'workspace.dcontact.test',
  UAT_TLS_CERT_FILE: '/tmp/voice-v1b-local-fixture.crt',
  UAT_TLS_KEY_FILE: '/tmp/voice-v1b-local-fixture.key',
  UAT_ALLOWED_CIDRS: '127.0.0.1/32',
  SOURCE_SHA: '1'.repeat(40),
  UAT_TENANT_ID: '11111111-1111-4111-8111-111111111111',
});
for (const image of ['API_IMAGE', 'OPS_IMAGE', 'CONSOLE_IMAGE', 'KEYCLOAK_IMAGE']) {
  environment[image] = `example.invalid/local-fixture@sha256:${'1'.repeat(64)}`;
}
const result = spawnSync(
  'docker',
  [
    'compose',
    '--project-name',
    'dcontact-v1b-local',
    ...files.flatMap((filename) => ['-f', resolve(directory, filename)]),
    'config',
    '--format',
    'json',
  ],
  { cwd: directory, env: environment, encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr || result.error?.message);
const configuration = JSON.parse(result.stdout);

test('local Keycloak healthcheck ใช้ HTTP ภายในโดยไม่เปลี่ยน HTTPS identity', () => {
  const keycloak = configuration.services.keycloak;
  assert.equal(keycloak.environment.KC_HTTP_MANAGEMENT_SCHEME, 'http');
  assert.equal(keycloak.environment.KC_HTTPS_PORT, '443');
  assert.equal(keycloak.ports, undefined);
  assert.deepEqual(keycloak.networks.internal.aliases, [environment.UAT_HOST]);
  assert.match(keycloak.healthcheck.test.join(' '), /127\.0\.0\.1\/9000/);
  assert.equal(configuration.networks.internal.internal, true);
});

test('local bind entrypoint ปฏิเสธ loopback/multiple IP/ข้อมูลแทรกก่อนเขียน config', () => {
  for (const address of [
    '127.0.0.1',
    '0.0.0.0',
    '256.1.1.1',
    '172.20.0.7 172.21.0.7',
    '172.20.0.7\n127.0.0.1',
    '172.20.0.7\n172.20.0.8',
    '172.20.0.7;id',
    '',
  ]) {
    const execution = spawnSync(
      'sh',
      [
        '-c',
        'hostname() { printf "%s\\n" "$LOCAL_BIND_TEST_IP"; }; . "$1"',
        'local-bind-test',
        resolve(directory, 'e1-freeswitch/local-entrypoint.sh'),
      ],
      {
        env: { PATH: process.env.PATH, LOCAL_BIND_TEST_IP: address },
        encoding: 'utf8',
      },
    );
    assert.notEqual(execution.status, 0);
    assert.match(execution.stderr, /LOCAL_FREESWITCH_BIND_IP_INVALID/);
  }
});

test('local hostnames ผ่าน Keycloak realm renderer เดียวกับ bootstrap จริง', () => {
  const template = JSON.parse(
    readFileSync(resolve(root, 'infra/keycloak/realm-dcontact.uat.json'), 'utf8'),
  );
  const realm = renderRealm(template, environment);
  const workspace = realm.clients.find((client) => client.clientId === 'dcontact-uat-workspace');
  assert.deepEqual(workspace.webOrigins, [`https://${environment.UAT_WORKSPACE_HOST}`]);
});

test('local composition แยก project และไม่เชื่อม DB relay ของ VM', () => {
  assert.equal(configuration.name, 'dcontact-v1b-local');
  assert.equal(configuration.services['db-relay'], undefined);
  for (const name of ['api', 'e1-sandbox']) {
    assert.match(
      configuration.services[name].environment.DATABASE_URL,
      /@postgres:5432\/dcontact\?schema=public$/,
    );
  }
  for (const volume of Object.values(configuration.volumes)) {
    assert.match(volume.name, /^dcontact-v1b-local_/);
    assert.notEqual(volume.external, true);
  }
});

test('local worker ใช้ canonical identity HTTPS และเพิ่ม CA เฉพาะ API ไม่ปิด TLS verification', () => {
  const api = configuration.services.api;
  const identity = configuration.services.keycloak;
  assert.equal(api.environment.NODE_EXTRA_CA_CERTS, '/run/local-identity-ca.crt');
  assert.equal(api.environment.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.ok(
    api.volumes.some(
      (volume) =>
        volume.target === '/run/local-identity-ca.crt' &&
        volume.source === environment.UAT_TLS_CERT_FILE &&
        volume.read_only,
    ),
  );
  assert.ok(!api.volumes.some((volume) => volume.source === environment.UAT_TLS_KEY_FILE));
  assert.equal(identity.environment.KC_HTTPS_PORT, '443');
  assert.equal(identity.environment.KC_HOSTNAME, `https://${environment.UAT_HOST}/auth`);
  assert.deepEqual(identity.networks, { internal: { aliases: [environment.UAT_HOST] } });
  assert.equal(identity.ports, undefined);
  assert.ok(
    identity.volumes.some(
      (volume) =>
        volume.target === '/run/local-identity.crt' &&
        volume.source === environment.UAT_TLS_CERT_FILE &&
        volume.read_only,
    ),
  );
  assert.ok(
    identity.volumes.some(
      (volume) =>
        volume.target === '/run/local-identity.key' &&
        volume.source === environment.UAT_TLS_KEY_FILE &&
        volume.read_only,
    ),
  );
});

test('local ports เป็น loopback เท่านั้น ไม่มี SIP/ESL หรือ SMTP ออก host', () => {
  const published = Object.entries(configuration.services).flatMap(([name, service]) =>
    (service.ports ?? []).map((port) => ({ name, ...port })),
  );
  assert.ok(published.length > 0);
  for (const port of published) {
    assert.equal(port.host_ip, '127.0.0.1');
    assert.ok(['proxy', 'freeswitch', 'mailpit-ui'].includes(port.name));
    assert.ok(![1025, 5060, 5066, 7443, 8021].includes(port.target));
  }
  assert.deepEqual(configuration.services.mailpit.networks, { internal: null });
  assert.equal(configuration.networks.internal.internal, true);
  assert.equal(configuration.services.mailpit.environment, undefined);
  assert.equal(configuration.services.mailpit.ports, undefined);
  assert.deepEqual(configuration.services['mailpit-ui'].networks, { edge: null, internal: null });
  const mailboxProxy = readFileSync(resolve(directory, 'Caddyfile.mailpit-local'), 'utf8');
  assert.match(mailboxProxy, /reverse_proxy mailpit:8025/);
});

test('local ใช้ Workspace/direct sandbox และ switches default-off', () => {
  const api = configuration.services.api;
  assert.deepEqual(api.command, ['node', 'dist/workspace-uat-main.js']);
  assert.equal(api.environment.DCONTACT_API_PROFILE, 'uat-workspace');
  assert.equal(api.environment.TENANT_PEOPLE_INVITATIONS_ENABLED, 'false');
  assert.equal(api.environment.TENANT_PEOPLE_DISABLE_ENABLED, 'false');
  assert.equal(api.environment.OUTBOUND_VOICE_DELIVERY_ENABLED, 'false');
  assert.equal(api.environment.TENANT_PEOPLE_BINDINGS_JSON, '');
  assert.ok(configuration.services['e1-sandbox']);
  assert.ok(!Object.keys(configuration.services).some((name) => /kafka|line/.test(name)));
});

test('local proxy/media overrides ไม่ใช้ config หรือ IP ของ VM', () => {
  const proxy = configuration.services.proxy;
  assert.ok(
    proxy.volumes.some(
      (volume) =>
        volume.source === resolve(directory, 'Caddyfile.workspace-local') && volume.read_only,
    ),
  );
  assert.ok(
    configuration.services.freeswitch.volumes.some(
      (volume) =>
        volume.source === resolve(directory, 'e1-freeswitch') &&
        volume.target === '/e1-local-source' &&
        volume.read_only,
    ),
  );
  const caddy = readFileSync(resolve(directory, 'Caddyfile.workspace-local'), 'utf8');
  const variables = readFileSync(resolve(directory, 'e1-freeswitch/vars.local.xml'), 'utf8');
  assert.match(caddy, /host \{\$UAT_WORKSPACE_HOST\}/);
  assert.match(caddy, /reverse_proxy https:\/\/freeswitch:7443/);
  assert.match(caddy, /respond @keycloakAdmin 404/);
  assert.match(variables, /external_rtp_ip=127\.0\.0\.1/);
  assert.deepEqual(configuration.services.freeswitch.entrypoint, [
    '/bin/sh',
    '/e1-local-source/local-entrypoint.sh',
  ]);
  assert.doesNotMatch(caddy + variables + result.stdout, /192\.168\.102\./);
});
