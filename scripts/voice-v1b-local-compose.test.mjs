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

test('local ports เป็น loopback เท่านั้น ไม่มี SIP/ESL หรือ SMTP ออก host', () => {
  const published = Object.entries(configuration.services).flatMap(([name, service]) =>
    (service.ports ?? []).map((port) => ({ name, ...port })),
  );
  assert.ok(published.length > 0);
  for (const port of published) {
    assert.equal(port.host_ip, '127.0.0.1');
    assert.ok(['proxy', 'freeswitch', 'mailpit'].includes(port.name));
    assert.ok(![1025, 5060, 5066, 7443, 8021].includes(port.target));
  }
  assert.deepEqual(configuration.services.mailpit.networks, { internal: null });
  assert.equal(configuration.networks.internal.internal, true);
  assert.equal(configuration.services.mailpit.environment, undefined);
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
        volume.source === resolve(directory, 'e1-freeswitch/vars.local.xml') && volume.read_only,
    ),
  );
  const caddy = readFileSync(resolve(directory, 'Caddyfile.workspace-local'), 'utf8');
  const variables = readFileSync(resolve(directory, 'e1-freeswitch/vars.local.xml'), 'utf8');
  assert.match(caddy, /host \{\$UAT_WORKSPACE_HOST\}/);
  assert.match(caddy, /reverse_proxy https:\/\/freeswitch:7443/);
  assert.match(caddy, /respond @keycloakAdmin 404/);
  assert.match(variables, /external_rtp_ip=127\.0\.0\.1/);
  assert.doesNotMatch(caddy + variables + result.stdout, /192\.168\.102\./);
});
