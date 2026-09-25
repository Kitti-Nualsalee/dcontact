/**
 * D1.16 (#455): Playwright บนสายจริงใน dev stack — acceptance ที่ห้าม waive ของ D1 (Phase Contract #428)
 *
 * "ไม่ reload และไม่ตัดสาย/WS ระหว่างสลับภาษาและเปลี่ยนขนาด dphone": browser เป็นเอเจนต์จริง
 * (Keycloak PKCE → fake media → SIP.js ลงทะเบียนผ่าน WS กับ FreeSWITCH) SIPp โทรเข้าคิว Router ส่งสายให้
 * แล้ว spec วัด SIP session ID, WS connection ID และ `performance.navigation` ทุกขั้น
 *
 * - ใช้ DB แยก (`D1_REAL_CALL_DATABASE`, default `dcontact_d1_16`) ที่ migrate ถึง HEAD + RLS + seed ใหม่ทุกรอบ
 *   ไม่แตะ DB `dcontact` และไม่แก้ user attribute ใน Keycloak: tenant demo และ agent1000 ถูกสร้างด้วย id ที่
 *   Keycloak ออก claim ให้อยู่แล้ว (`tenant_id`, `dc_user_id`) ก่อน seed จะ upsert ส่วนที่เหลือ
 * - เปิด `ui.shell.v2` เฉพาะ tenant demo ใน DB แยกนี้ — ไม่กระทบ #77 voice pilot
 * - Workspace ต้องอยู่ที่ http://localhost:5173 ตาม redirect URI ของ client `agent-desktop`
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stopChild } from './child-process-lifecycle.mjs';

const compose = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];
const database = process.env.D1_REAL_CALL_DATABASE ?? 'dcontact_d1_16';
if (!/^dcontact_[a-z0-9_]+$/.test(database) || database === 'dcontact') {
  throw new Error('D1_REAL_CALL_DATABASE ต้องเป็น DB แยก (dcontact_<ชื่อ>) ไม่ใช่ dcontact');
}
const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const agentUsername = 'agent1000@demo.local';
const nodeId = `fs-d1-16-${process.pid}`;
const routerGroupId = `dcontact-router-d1-16-${process.pid}`;
const workspaceOrigin = 'http://localhost:5173';
const apiOrigin = 'http://localhost:3000';
const children = [];
let cleaningUp = false;

function dotenv(path) {
  if (!existsSync(path)) return {};
  const values = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
  }
  return values;
}

const ownerUrl = `postgresql://dcontact:dcontact@localhost:5433/${database}?schema=public`;
const environment = {
  ...dotenv(resolve('.env')),
  ...process.env,
  DATABASE_URL: ownerUrl,
  APPLICATION_DATABASE_URL: `postgresql://dcontact_app:dcontact_app@localhost:5433/${database}?schema=public`,
  PLATFORM_DATABASE_URL: `postgresql://dcontact_platform:dcontact_platform@localhost:5433/${database}?schema=public`,
  TELEPHONY_NODE_ID: nodeId,
  ROUTER_INBOUND_VOICE_GROUP_ID: routerGroupId,
  SIP_BROWSER_NODES_JSON: JSON.stringify([
    { telephonyNodeId: nodeId, wssUrl: 'ws://localhost:5066' },
  ]),
  WORKSPACE_ORIGIN: workspaceOrigin,
  VITE_KC_ISSUER: `${keycloakBaseUrl}/realms/dcontact`,
  VITE_KC_CLIENT_ID: 'agent-desktop',
  VITE_API_BASE_URL: apiOrigin,
  PORT: '3000',
};
delete environment.FREESWITCH_AGENT_DIAL_TEMPLATE;
delete environment.DCONTACT_API_PROFILE;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: environment,
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} ล้มเหลว\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

function psql(sql, databaseName = database) {
  return run('docker', [
    ...compose,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'dcontact',
    '-d',
    databaseName,
    '-v',
    'ON_ERROR_STOP=1',
    '-Atc',
    sql,
  ]).trim();
}

function start(label, command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    ...options,
  });
  let output = '';
  const capture = (chunk) => {
    output = (output + chunk.toString()).slice(-20_000);
    if (process.env.D1_REAL_CALL_VERBOSE) process.stderr.write(`[${label}] ${chunk}`);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.label = label;
  child.tail = () => output;
  children.push(child);
  return child;
}

const wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));

async function waitForHttp(url, label, child) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${label} หยุดก่อนพร้อม (exit ${child.exitCode})\n${child.tail()}`);
    }
    try {
      await fetch(url);
      return;
    } catch {
      await wait(500);
    }
  }
  throw new Error(`${label} ไม่ตอบที่ ${url}\n${child.tail()}`);
}

async function waitForConsumerGroup(groupId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      'docker',
      [...compose, 'exec', '-T', 'redpanda', 'rpk', 'group', 'describe', groupId],
      { encoding: 'utf8' },
    );
    if (result.status === 0 && /STATE\s+Stable/.test(result.stdout)) return;
    await wait(500);
  }
  throw new Error(`consumer group ยังไม่พร้อม: ${groupId}`);
}

function assertPortsFree() {
  for (const port of [3000, 5173]) {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    if (result.stdout.trim()) {
      throw new Error(`port ${port} ถูกใช้อยู่ — ปิด API/Workspace dev server เดิมก่อนรัน harness`);
    }
  }
}

async function keycloakAgentClaims() {
  const token = await fetch(`${keycloakBaseUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: environment.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin',
      password: environment.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin',
    }),
  }).then((response) => {
    if (!response.ok) throw new Error(`Keycloak admin token ล้มเหลว (${response.status})`);
    return response.json();
  });
  const users = await fetch(
    `${keycloakBaseUrl}/admin/realms/dcontact/users?exact=true&username=${encodeURIComponent(agentUsername)}`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
  ).then((response) => response.json());
  const attributes = users[0]?.attributes ?? {};
  const tenantId = attributes.tenant_id?.[0];
  const userId = attributes.dc_user_id?.[0];
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(tenantId ?? '') || !uuid.test(userId ?? '') || !uuid.test(users[0]?.id ?? '')) {
    throw new Error(
      `${agentUsername} ใน Keycloak ยังไม่มี tenant_id/dc_user_id — รัน pnpm infra:identity:link ก่อน`,
    );
  }
  return { tenantId, userId, keycloakId: users[0].id };
}

async function prepareDatabase() {
  const claims = await keycloakAgentClaims();
  psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();`,
    'postgres',
  );
  psql(`DROP DATABASE IF EXISTS ${database};`, 'postgres');
  psql(`CREATE DATABASE ${database};`, 'postgres');
  run('pnpm', ['db:migrate']);
  run('pnpm', ['db:rls']);
  // id ต้องตรงกับ claim ที่ Keycloak ออกให้ agent1000 — seed จะ upsert ตาม slug/email และใช้แถวนี้ต่อ
  psql(
    `INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${claims.tenantId}', 'Demo Company', 'demo', 'dcontact.local');
     INSERT INTO users (id, keycloak_id, tenant_id, email, password_hash, display_name, role, extension, sip_password)
     VALUES ('${claims.userId}', '${claims.keycloakId}', '${claims.tenantId}', '${agentUsername}', '-', 'Agent 1000', 'AGENT', '1000', 'DContactDev1');`,
  );
  run('pnpm', ['db:seed']);
  // ให้ Router เลือกได้แค่ agent1000 ที่ browser ลงทะเบียนอยู่
  psql(
    `INSERT INTO agent_state_logs (tenant_id, user_id, state, reason)
     SELECT tenant_id, id, 'OFFLINE', 'd1-16-real-call' FROM users
     WHERE tenant_id = '${claims.tenantId}' AND role = 'AGENT' AND id <> '${claims.userId}';`,
  );
  run('pnpm', [
    'd1:shell-flag',
    '--',
    '--tenant',
    'demo',
    '--on',
    '--reason',
    'D1.16 real-call acceptance (DB แยก)',
    '--actor',
    'd1-16-harness',
    '--ack-voice-pilot',
  ]);
  return claims;
}

async function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  for (const child of children) {
    child.stdout?.destroy();
    child.stderr?.destroy();
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      stopChild(child);
    }
  }
  await wait(1_000);
}

process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)));
process.once('SIGTERM', () => void cleanup().finally(() => process.exit(143)));

try {
  run('docker', [...compose, 'ps', '--status', 'running']);
  assertPortsFree();
  const claims = await prepareDatabase();
  process.stdout.write(`# DB ${database} พร้อม (tenant ${claims.tenantId})\n`);

  const api = start('api', 'node', ['node_modules/tsx/dist/cli.mjs', 'src/main.ts'], {
    cwd: resolve('apps/api'),
  });
  const router = start('router', 'pnpm', ['--filter', '@d-contact/router', 'dev']);
  const telephony = start('telephony', 'pnpm', ['--filter', '@d-contact/telephony', 'dev']);
  const workspace = start('workspace', 'pnpm', [
    '--filter',
    '@d-contact/workspace',
    'exec',
    'vite',
    '--host',
    'localhost',
    '--port',
    '5173',
    '--strictPort',
  ]);
  await Promise.all([
    waitForHttp(`${apiOrigin}/api/v1/me/navigation`, 'API', api),
    waitForHttp(workspaceOrigin, 'Workspace', workspace),
    waitForConsumerGroup(routerGroupId),
    waitForConsumerGroup(`dcontact-telephony-command-${nodeId}-v1`),
  ]);
  for (const child of [router, telephony]) {
    if (child.exitCode !== null) throw new Error(`${child.label} หยุดทำงาน\n${child.tail()}`);
  }
  process.stdout.write('# API, Router, Telephony และ Workspace พร้อม — เริ่ม Playwright\n');

  const playwright = spawnSync(
    'pnpm',
    [
      '--filter',
      '@d-contact/workspace',
      'exec',
      'playwright',
      'test',
      '--config',
      'playwright.real-call.config.ts',
    ],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
      env: {
        ...environment,
        D1_REAL_CALL_TENANT_ID: claims.tenantId,
        D1_REAL_CALL_NODE_ID: nodeId,
      },
    },
  );
  if (playwright.status !== 0) {
    for (const child of [api, router, telephony]) {
      process.stderr.write(`\n--- ${child.label} (ท้าย log) ---\n${child.tail().slice(-4_000)}\n`);
    }
    process.exitCode = playwright.status ?? 1;
  } else {
    process.stdout.write('D1_REAL_CALL_ACCEPTANCE_PASS\n');
  }
} finally {
  await cleanup();
}
