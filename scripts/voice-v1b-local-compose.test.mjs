import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  LOCAL_RTP_PUBLICATION_SUBNET: '10.240.60.0/29',
  LOCAL_RTP_MEDIA_SUBNET: '10.240.61.0/29',
  LOCAL_RTP_PUBLICATION_GATEWAY: '10.240.60.1',
  LOCAL_RTP_MEDIA_GATEWAY: '10.240.61.1',
  LOCAL_RTP_PUBLICATION_ADDRESS: '10.240.60.2',
  LOCAL_RTP_RELAY_MEDIA_ADDRESS: '10.240.61.2',
  LOCAL_RTP_FREESWITCH_MEDIA_ADDRESS: '10.240.61.3',
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

test('RTP sidecar แยกสอง dedicated networks และ FS ไม่ publish media เอง', () => {
  const relay = configuration.services['local-rtp-relay'];
  assert.ok(relay);
  assert.deepEqual(relay.command, ['node', '/e1-sandbox/dist/local-rtp-relay-main.js']);
  assert.equal(relay.image, environment.API_IMAGE);
  assert.deepEqual(Object.keys(relay.networks).sort(), ['rtp-media', 'rtp-publication']);
  assert.deepEqual(Object.keys(configuration.services.freeswitch.networks).sort(), [
    'internal',
    'rtp-media',
  ]);
  assert.equal(configuration.services.freeswitch.ports, undefined);
  assert.equal(relay.environment.LOCAL_RTP_RELAY_PROJECT, 'dcontact-v1b-local');
  assert.equal(relay.environment.LOCAL_RTP_RELAY_HOST, 'workspace.dcontact.test');
  assert.deepEqual(JSON.parse(relay.environment.LOCAL_RTP_RELAY_CONFIG_JSON), {
    publicationAddress: '10.240.60.2',
    relayMediaAddress: '10.240.61.2',
    freeSwitchMediaAddress: '10.240.61.3',
    publicationSubnet: '10.240.60.0/29',
    mediaSubnet: '10.240.61.0/29',
  });
});

test('local Keycloak healthcheck ใช้ HTTP ภายในโดยไม่เปลี่ยน HTTPS identity', () => {
  const keycloak = configuration.services.keycloak;
  assert.equal(keycloak.environment.KC_HTTP_MANAGEMENT_SCHEME, 'http');
  assert.equal(keycloak.environment.KC_HTTPS_PORT, '443');
  assert.equal(keycloak.ports, undefined);
  assert.deepEqual(keycloak.networks.internal.aliases, [environment.UAT_HOST]);
  assert.match(keycloak.healthcheck.test.join(' '), /127\.0\.0\.1\/9000/);
  assert.equal(configuration.networks.internal.internal, true);
});

test('local wrapper ปฏิเสธ DNS ผิด/หลาย addresses ก่อน render', () => {
  for (const address of [
    '127.0.0.1',
    '0.0.0.0',
    '256.1.1.1',
    '172.20.0.7\n172.20.0.8',
    '172.20.0.7;id',
    '',
  ]) {
    const execution = spawnSync(
      'sh',
      [
        '-c',
        'nslookup() { printf "Server: 127.0.0.11\\nAddress: 127.0.0.11:53\\nName: freeswitch-control\\n"; printf "%s\\n" "$LOCAL_BIND_TEST_IP" | while IFS= read -r address; do printf "Address: %s\\n" "$address"; done; }; awk() { case "$*" in *"/proc/net/fib_trie"*) printf "%s\\n" "172.20.0.7" "10.240.61.3";; *) command awk "$@";; esac; }; . "$1"',
        'local-bind-test',
        resolve(directory, 'e1-freeswitch/local-entrypoint.sh'),
      ],
      {
        env: {
          PATH: process.env.PATH,
          LOCAL_BIND_TEST_IP: address,
          LOCAL_RTP_FREESWITCH_MEDIA_ADDRESS: '10.240.61.3',
          LOCAL_RTP_MEDIA_SUBNET: '10.240.61.0/29',
        },
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
    assert.ok(['proxy', 'local-rtp-relay', 'mailpit-ui'].includes(port.name));
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

test('render helper แยก control listeners/RTP และไม่แก้ source', (context) => {
  const target = mkdtempSync(resolve(tmpdir(), 'local-fs-render-'));
  context.after(() => rmSync(target, { recursive: true, force: true }));
  const source = resolve(directory, 'e1-freeswitch');
  const original = readFileSync(resolve(source, 'conf/sip_profiles/internal.xml'), 'utf8');
  const execution = spawnSync(
    'sh',
    [
      resolve(source, 'render-local.sh'),
      source,
      target,
      '172.23.0.7',
      '10.240.61.3',
      '10.240.61.0/29',
    ],
    {
      input: '127.0.0.1\n172.23.0.7\n10.240.61.3\n',
      encoding: 'utf8',
    },
  );
  assert.equal(execution.status, 0, execution.stderr);
  const profile = readFileSync(resolve(target, 'conf/sip_profiles/internal.xml'), 'utf8');
  for (const [name, value] of Object.entries({
    'sip-ip': '172.23.0.7',
    'rtp-ip': '10.240.61.3',
    'ws-binding': '172.23.0.7:5066',
    'wss-binding': '172.23.0.7:7443',
  })) {
    assert.ok(profile.includes(`<param name="${name}" value="${value}"/>`));
  }
  assert.match(
    readFileSync(resolve(target, 'conf/autoload_configs/event_socket.conf.xml'), 'utf8'),
    /name="listen-ip" value="172\.23\.0\.7"/,
  );
  assert.match(readFileSync(resolve(target, 'conf/vars.xml'), 'utf8'), /local_ip_v4=172\.23\.0\.7/);
  assert.match(
    readFileSync(resolve(target, 'conf/vars.xml'), 'utf8'),
    /external_rtp_ip=127\.0\.0\.1/,
  );
  assert.equal(readFileSync(resolve(target, 'control-ip'), 'utf8'), '172.23.0.7\n');
  assert.equal(readFileSync(resolve(source, 'conf/sip_profiles/internal.xml'), 'utf8'), original);
});

test('render ปฏิเสธ unknown ownership/invalid tuple ก่อน copy', (context) => {
  const target = mkdtempSync(resolve(tmpdir(), 'local-fs-negative-'));
  context.after(() => rmSync(target, { recursive: true, force: true }));
  const source = resolve(directory, 'e1-freeswitch');
  const cases = [
    ['172.23.0.7', '10.240.61.3', '10.240.61.0/29', '172.23.0.7\n'],
    ['172.23.0.7', '10.240.61.3', '10.240.61.0/29', '10.240.61.3\n'],
    ['172.23.0.7\n172.23.0.8', '10.240.61.3', '10.240.61.0/29', '172.23.0.7\n10.240.61.3\n'],
    ['127.0.0.1', '10.240.61.3', '10.240.61.0/29', '127.0.0.1\n10.240.61.3\n'],
    ['172.023.0.7', '10.240.61.3', '10.240.61.0/29', '172.023.0.7\n10.240.61.3\n'],
    ['172.23.0.7', '10.240.61.4', '10.240.61.0/29', '172.23.0.7\n10.240.61.4\n'],
    ['10.240.61.2', '10.240.61.3', '10.240.61.0/29', '10.240.61.2\n10.240.61.3\n'],
    ['172.23.0.7', '10.240.61.3', '10.240.61.1/29', '172.23.0.7\n10.240.61.3\n'],
    ['172.23.0.7', '10.240.61.3', '10.240.61.0/30', '172.23.0.7\n10.240.61.3\n'],
    ['172.23.0.7;id', '10.240.61.3', '10.240.61.0/29', '172.23.0.7\n10.240.61.3\n'],
    ['172.23.0.7', '10.240.61.\\063', '10.240.61.0/29', '172.23.0.7\n10.240.61.3\n'],
  ];
  for (const [control, media, subnet, owned] of cases) {
    const execution = spawnSync(
      'sh',
      [resolve(source, 'render-local.sh'), source, target, control, media, subnet],
      { input: owned, encoding: 'utf8' },
    );
    assert.notEqual(execution.status, 0);
    assert.match(execution.stderr, /LOCAL_FREESWITCH_BIND_IP_INVALID/);
    assert.equal(existsSync(resolve(target, 'conf')), false);
  }
});

test('source listener drift ต้อง fail closed ไม่เขียน readiness address', (context) => {
  const temporary = mkdtempSync(resolve(tmpdir(), 'local-fs-drift-'));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const source = resolve(temporary, 'source');
  const target = resolve(temporary, 'target');
  cpSync(resolve(directory, 'e1-freeswitch'), source, { recursive: true });
  const profile = resolve(source, 'conf/sip_profiles/internal.xml');
  writeFileSync(
    profile,
    readFileSync(profile, 'utf8').replace('name="wss-binding"', 'name="unexpected-binding"'),
  );
  const execution = spawnSync(
    'sh',
    [
      resolve(source, 'render-local.sh'),
      source,
      target,
      '172.23.0.7',
      '10.240.61.3',
      '10.240.61.0/29',
    ],
    { input: '172.23.0.7\n10.240.61.3\n', encoding: 'utf8' },
  );
  assert.notEqual(execution.status, 0);
  assert.equal(existsSync(resolve(target, 'control-ip')), false);
});

test('media wiring มี exact37 loopbackUDP ports/staticIPs และไม่เพิ่ม privileges', () => {
  const relay = configuration.services['local-rtp-relay'];
  const switchService = configuration.services.freeswitch;
  assert.equal(relay.ports.length, 37);
  assert.deepEqual(
    relay.ports.map((port) => [port.host_ip, port.protocol, port.target, String(port.published)]),
    Array.from({ length: 37 }, (_, index) => [
      '127.0.0.1',
      'udp',
      16384 + index,
      String(16384 + index),
    ]),
  );
  assert.deepEqual(switchService.networks.internal.aliases, ['freeswitch-control']);
  assert.equal(switchService.networks['rtp-media'].ipv4_address, '10.240.61.3');
  assert.equal(relay.networks['rtp-publication'].ipv4_address, '10.240.60.2');
  assert.equal(relay.networks['rtp-media'].ipv4_address, '10.240.61.2');
  assert.equal(configuration.networks['rtp-media'].internal, true);
  assert.notEqual(configuration.networks['rtp-publication'].internal, true);
  assert.deepEqual(configuration.networks['rtp-media'].ipam.config, [
    { subnet: '10.240.61.0/29', gateway: '10.240.61.1' },
  ]);
  assert.deepEqual(configuration.networks['rtp-publication'].ipam.config, [
    { subnet: '10.240.60.0/29', gateway: '10.240.60.1' },
  ]);
  assert.equal(relay.read_only, true);
  assert.equal(relay.user, '10001:10001');
  assert.deepEqual(relay.cap_drop, ['ALL']);
  assert.equal(relay.cap_add, undefined);
  assert.equal(relay.privileged, undefined);
  assert.equal(relay.network_mode, undefined);
  assert.equal(relay.volumes, undefined);
  assert.equal(relay.secrets, undefined);
  assert.equal(relay.pids_limit, 32);
  assert.equal(Number(relay.mem_limit), 134217728);
  assert.equal(relay.restart, 'no');
  assert.equal(relay.depends_on.freeswitch.condition, 'service_healthy');
  assert.match(switchService.healthcheck.test[1], /fs_cli -H .*control-ip/);
  for (const [name, service] of Object.entries(configuration.services)) {
    if (name === 'local-rtp-relay' || name === 'freeswitch') continue;
    assert.equal(service.networks?.['rtp-media'], undefined);
    assert.equal(service.networks?.['rtp-publication'], undefined);
  }
});

test('network env ทั้งเจ็ดขาดตัวใด compose ต้องไม่ render', () => {
  for (const variable of Object.keys(environment).filter((name) => name.startsWith('LOCAL_RTP_'))) {
    const missing = { ...environment };
    delete missing[variable];
    const execution = spawnSync(
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
      { cwd: directory, env: missing, encoding: 'utf8' },
    );
    assert.notEqual(execution.status, 0);
    assert.ok(execution.stderr.includes(variable));
  }
});
