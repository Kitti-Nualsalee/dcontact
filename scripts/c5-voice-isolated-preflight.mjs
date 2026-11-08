/**
 * #795: ตรวจเฉพาะโครงสร้าง Voice แบบ disposable; ไม่ใช่ C5 หรือ audio acceptance
 * รัน node scripts/c5-voice-isolated-preflight.mjs จาก repo root
 * สร้าง compose project และ volume ใหม่เท่านั้น; ไม่อ่าน .env หรือใช้ dev compose
 */
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { createServer } from 'node:net';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const project = `c5isolated${randomBytes(8).toString('hex')}`;
const temp = mkdtempSync(join(tmpdir(), `${project}-`));
const composeFile = join(temp, 'compose.json');
const password = randomBytes(24).toString('hex');
const tenantId = randomUUID();
const agentId = randomUUID();
const children = [];
let owned = false;

function run(args, { quiet = false, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 180_000 });
  if (result.status !== 0 && !allowFailure) {
    throw new Error(
      `docker ${args.slice(0, 3).join(' ')} failed: ${(result.stderr || result.stdout).slice(-2000)}`,
    );
  }
  if (!quiet && result.stdout) process.stdout.write(result.stdout);
  return result;
}
const compose = (...args) =>
  run(['compose', '-p', project, '-f', composeFile, ...args], { quiet: true });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
async function waitUntil(label, fn, timeout = 150_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch {
      /* ยังไม่พร้อม */
    }
    await wait(1000);
  }
  throw new Error(`${label} ไม่พร้อมภายในเวลาที่กำหนด`);
}
async function tcpPort() {
  return new Promise((done, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      children.push(server);
      done(port);
    });
  });
}
async function udpRange() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const start = 20000 + Math.floor(Math.random() * 16000);
    const sockets = [];
    try {
      for (let port = start; port < start + 12; port++) {
        const socket = createSocket('udp4');
        sockets.push(socket);
        await new Promise((done, reject) => {
          socket.once('error', reject);
          socket.bind(port, '127.0.0.1', done);
        });
      }
      children.push(...sockets);
      return [start, start + 11];
    } catch {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch {}
      }
    }
  }
  throw new Error('หา UDP range ว่างไม่พบ');
}
function edit(path, from, to) {
  const value = readFileSync(path, 'utf8');
  if (!value.includes(from)) throw new Error(`รูปแบบ config เปลี่ยน: ${path}`);
  writeFileSync(path, value.replace(from, to));
}
function assertUnused() {
  for (const kind of ['container', 'network', 'volume']) {
    const result = run(
      [kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`],
      { quiet: true },
    );
    if (result.stdout.trim()) throw new Error(`project collision: ${project}`);
  }
}
function cleanup() {
  for (const child of children) {
    try {
      child.close();
    } catch {}
  }
  if (owned) {
    const result = run(
      ['compose', '-p', project, '-f', composeFile, 'down', '--volumes', '--remove-orphans'],
      { quiet: true, allowFailure: true },
    );
    if (result.status !== 0) {
      process.stderr.write(`cleanup ไม่สำเร็จ: เก็บ ${temp} ไว้สำหรับ project ${project}\n`);
      return false;
    }
    owned = false;
  }
  rmSync(temp, { recursive: true, force: true });
  return true;
}
for (const [signal, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
]) {
  process.once(signal, () => {
    cleanup();
    process.exit(code);
  });
}
function serviceExec(service, ...args) {
  const result = run(
    ['compose', '-p', project, '-f', composeFile, 'exec', '-T', service, ...args],
    { quiet: true, allowFailure: true },
  );
  return result.status === 0 ? result.stdout : '';
}

try {
  assertUnused();
  const [pg, redis, kafka, kc, ws, esl, api, workspace] = await Promise.all(
    Array.from({ length: 8 }, tcpPort),
  );
  const [rtpStart, rtpEnd] = await udpRange();
  const fsConf = join(temp, 'freeswitch');
  const realmDir = join(temp, 'realm');
  cpSync(resolve(root, 'infra/freeswitch/conf'), fsConf, { recursive: true });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(realmDir);
  edit(join(fsConf, 'autoload_configs/switch.conf.xml'), 'value="16384"', `value="${rtpStart}"`);
  edit(join(fsConf, 'autoload_configs/switch.conf.xml'), 'value="16420"', `value="${rtpEnd}"`);
  edit(
    join(fsConf, 'autoload_configs/xml_curl.conf.xml'),
    'host.docker.internal:3000',
    `host.docker.internal:${api}`,
  );
  const realm = JSON.parse(
    readFileSync(resolve(root, 'infra/keycloak/realm-dcontact.dev.json'), 'utf8'),
  );
  realm.loginTheme = realm.accountTheme = realm.emailTheme = 'keycloak';
  const desktop = realm.clients.find((client) => client.clientId === 'agent-desktop');
  if (!desktop) throw new Error('ไม่พบ agent-desktop ใน realm');
  desktop.redirectUris = [`http://localhost:${workspace}/*`];
  desktop.webOrigins = [`http://localhost:${workspace}`];
  const agent = realm.users.find((user) => user.username === 'agent1000@demo.local');
  if (!agent) throw new Error('ไม่พบ agent fixture ใน realm');
  agent.id = randomUUID();
  agent.attributes = { tenant_id: [tenantId], tenant_slug: ['demo'], dc_user_id: [agentId] };
  realm.clients.push({
    clientId: 'c5-isolated-introspection',
    enabled: true,
    protocol: 'openid-connect',
    publicClient: false,
    secret: password,
    standardFlowEnabled: false,
    serviceAccountsEnabled: true,
  });
  writeFileSync(join(realmDir, 'realm.json'), JSON.stringify(realm), { mode: 0o600 });
  const port = (host, container, proto = 'tcp') => `127.0.0.1:${host}:${container}/${proto}`;
  const definition = {
    services: {
      postgres: {
        image: 'postgres:16-alpine',
        environment: {
          POSTGRES_USER: 'dcontact',
          POSTGRES_PASSWORD: password,
          POSTGRES_DB: 'dcontact_c5',
        },
        ports: [port(pg, 5432)],
        volumes: ['pg:/var/lib/postgresql/data'],
      },
      redis: { image: 'redis:7-alpine', ports: [port(redis, 6379)], volumes: ['redis:/data'] },
      redpanda: {
        image: 'redpandadata/redpanda:v24.2.7',
        command: [
          'redpanda',
          'start',
          '--smp',
          '1',
          '--memory',
          '1G',
          '--mode',
          'dev-container',
          '--kafka-addr',
          'internal://0.0.0.0:29092,external://0.0.0.0:9092',
          '--advertise-kafka-addr',
          `internal://redpanda:29092,external://localhost:${kafka}`,
        ],
        ports: [port(kafka, 9092)],
        volumes: ['redpanda:/var/lib/redpanda/data'],
      },
      keycloak: {
        image:
          'docker.io/keycloak/keycloak:26.7.5@sha256:37dbaf6f0722c9ec246335f36e1ef8b2e6cb960f7c27e0d8c615121a3d475a85',
        command: ['start-dev', '--import-realm', '--features=organization'],
        environment: {
          KC_BOOTSTRAP_ADMIN_USERNAME: 'admin',
          KC_BOOTSTRAP_ADMIN_PASSWORD: password,
        },
        ports: [port(kc, 8080)],
        volumes: ['keycloak:/opt/keycloak/data', `${realmDir}:/opt/keycloak/data/import:ro`],
      },
      freeswitch: {
        image: 'safarov/freeswitch:latest',
        ports: [
          port(ws, 5066),
          port(esl, 8021),
          `127.0.0.1:${rtpStart}-${rtpEnd}:${rtpStart}-${rtpEnd}/udp`,
        ],
        volumes: [`${fsConf}:/etc/freeswitch`, 'recordings:/var/lib/freeswitch/recordings'],
        extra_hosts: ['host.docker.internal:host-gateway'],
      },
    },
    volumes: { pg: {}, redis: {}, redpanda: {}, keycloak: {}, recordings: {} },
  };
  writeFileSync(composeFile, JSON.stringify(definition), { mode: 0o600 });
  // ปล่อย reservation ก่อน Docker bind; bind ล้มเหลวทันทีหาก port ถูกใช้แทรก
  for (const child of children) await new Promise((done) => child.close(done));
  children.length = 0;
  owned = true;
  compose('up', '-d');
  await waitUntil('PostgreSQL', () =>
    serviceExec('postgres', 'pg_isready', '-U', 'dcontact', '-d', 'dcontact_c5'),
  );
  await waitUntil('Redis', () => serviceExec('redis', 'redis-cli', 'ping'));
  await waitUntil('Redpanda', () =>
    /Healthy:\s+true/i.test(serviceExec('redpanda', 'rpk', 'cluster', 'health')),
  );
  await waitUntil('FreeSWITCH', () =>
    /UP \d/i.test(serviceExec('freeswitch', 'fs_cli', '-x', 'status')),
  );
  await waitUntil(
    'Keycloak realm',
    async () =>
      (await fetch(`http://localhost:${kc}/realms/dcontact/.well-known/openid-configuration`)).ok,
  );
  const metadata = await fetch(
    `http://localhost:${kc}/realms/dcontact/.well-known/openid-configuration`,
  ).then((r) => r.json());
  if (metadata.issuer !== `http://localhost:${kc}/realms/dcontact`)
    throw new Error('issuer ไม่ตรงกับ realm แยก');
  process.stdout.write(
    `C5_ISOLATED_INFRA_PREFLIGHT_PASS project=${project} postgres=${pg} redis=${redis} kafka=${kafka} keycloak=${kc} sipWs=${ws} esl=${esl} rtp=${rtpStart}-${rtpEnd} apiCandidate=${api} workspaceCandidate=${workspace}\n`,
  );
  process.stdout.write(
    'ตรวจเฉพาะ readiness; ยังไม่ได้ migrate DB, เปิด API/Router หรือทดสอบ C5/SIP/RTP/audio\n',
  );
} finally {
  if (!cleanup()) process.exitCode = 1;
}
