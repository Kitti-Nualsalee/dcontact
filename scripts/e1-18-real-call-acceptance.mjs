import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { stopChild } from './child-process-lifecycle.mjs';

const compose = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];
const database = process.env.E1_18_DATABASE ?? 'dcontact_e1_18';
if (!/^dcontact_[a-z0-9_]+$/.test(database) || database === 'dcontact') {
  throw new Error('E1_18_DATABASE ต้องเป็นฐานแยก dcontact_<ชื่อ>');
}
const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const nodeId = 'fs-local';
const telephonyGroupId = `dcontact-telephony-command-e1-18-${process.pid}`;
const routerGroupId = `dcontact-router-e1-18-${process.pid}`;
const targetContainer = `dcontact-e1-18-target-${process.pid}`;
const sippImage =
  'ctaloi/sipp@sha256:c459f2340443ddcc159227efc798217dbdaad0dbe88b76b78b1a876aa271986a';
const children = [];
let cleaningUp = false;

function dotenv(path) {
  try {
    const values = {};
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) values[match[1]] = match[2].replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1');
    }
    return values;
  } catch {
    return {};
  }
}

const ownerUrl = `postgresql://dcontact:dcontact@localhost:5433/${database}?schema=public`;
const environment = {
  ...dotenv(resolve('.env')),
  ...process.env,
  DATABASE_URL: ownerUrl,
  APPLICATION_DATABASE_URL: `postgresql://dcontact_app:dcontact_app@localhost:5433/${database}?schema=public`,
  PLATFORM_DATABASE_URL: `postgresql://dcontact_platform:dcontact_platform@localhost:5433/${database}?schema=public`,
  TELEPHONY_NODE_ID: nodeId,
  TELEPHONY_COMMAND_GROUP_ID: telephonyGroupId,
  ROUTER_INBOUND_VOICE_GROUP_ID: routerGroupId,
  SIP_BROWSER_NODES_JSON: JSON.stringify([
    { telephonyNodeId: nodeId, wssUrl: 'ws://localhost:5066' },
  ]),
  SIP_BROWSER_FIXED_PASSWORD: 'E1-18-acceptance-only-password',
  WORKSPACE_ORIGIN: 'http://localhost:5173',
  VITE_KC_ISSUER: `${keycloakBaseUrl}/realms/dcontact`,
  VITE_KC_CLIENT_ID: 'agent-desktop',
  VITE_API_BASE_URL: 'http://localhost:3000',
  DPHONE_EMBED_SCRIPT_URL: 'http://localhost:5173/src/embed/main.ts',
  DPHONE_EMBED_CONNECT_SRC: 'http://localhost:5173,ws://localhost:5066',
  OUTBOUND_VOICE_DELIVERY_ENABLED: 'true',
  FREESWITCH_VOICE_TARGET_DIAL_TEMPLATE: `sofia/internal/{extension}@${targetContainer}:5060`,
  FREESWITCH_VOICE_CODEC_STRING: 'PCMU',
  LINE_WEBHOOK_SECRET_SOURCE: 'disabled',
  LINE_WEBHOOK_CHANNEL_ACCOUNT_ID: 'e1-18-disabled',
  LINE_WEBHOOK_DESTINATION: 'e1-18-disabled',
  LINE_WEBHOOK_PAYLOAD_KEY_REF: 'e1-18-disabled',
  PORT: '3000',
  NODE_ENV: 'development',
};
delete environment.FREESWITCH_AGENT_DIAL_TEMPLATE;
delete environment.DCONTACT_API_PROFILE;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: environment,
    encoding: 'utf8',
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} ล้มเหลว\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result.stdout ?? '';
}

function runInteractive(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: environment,
      stdio: 'inherit',
      ...options,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolveRun({ code, signal }));
  });
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
    output = (output + chunk.toString()).slice(-30_000);
    if (process.env.E1_18_VERBOSE) process.stderr.write(`[${label}] ${chunk}`);
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
    if (child?.exitCode !== null && child)
      throw new Error(`${label} หยุดก่อนพร้อม\n${child.tail()}`);
    try {
      await fetch(url);
      return;
    } catch {
      await wait(500);
    }
  }
  throw new Error(`${label} ไม่ตอบที่ ${url}${child ? `\n${child.tail()}` : ''}`);
}

async function waitForConsumerGroup(groupId) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const result = spawnSync(
      'docker',
      [...compose, 'exec', '-T', 'redpanda', 'rpk', 'group', 'describe', groupId],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    if (result.status === 0 && /STATE\s+Stable/.test(result.stdout)) return;
    await wait(500);
  }
  throw new Error(`consumer group ยังไม่พร้อม: ${groupId}`);
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
    `${keycloakBaseUrl}/admin/realms/dcontact/users?exact=true&username=agent1000%40demo.local`,
    { headers: { authorization: `Bearer ${token.access_token}` } },
  ).then((response) => response.json());
  const tenantId = users[0]?.attributes?.tenant_id?.[0];
  const userId = users[0]?.attributes?.dc_user_id?.[0];
  if (!/^[0-9a-f-]{36}$/i.test(tenantId ?? '') || !/^[0-9a-f-]{36}$/i.test(userId ?? '')) {
    throw new Error('agent1000 ใน Keycloak ไม่มี tenant_id/dc_user_id');
  }
  return { tenantId, userId, keycloakId: users[0].id };
}

async function prepareDatabase() {
  const claims = await keycloakAgentClaims();
  run('pnpm', ['--filter', '@d-contact/delivery', 'build']);
  psql(
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${database}' AND pid<>pg_backend_pid();`,
    'postgres',
  );
  psql(`DROP DATABASE IF EXISTS ${database};`, 'postgres');
  psql(`CREATE DATABASE ${database};`, 'postgres');
  run('pnpm', ['db:migrate']);
  run('pnpm', ['db:rls']);
  psql(`INSERT INTO tenants (id,name,slug,sip_domain) VALUES ('${claims.tenantId}','Demo Company','demo','dcontact.local');
    INSERT INTO users (id,keycloak_id,tenant_id,email,password_hash,display_name,role,extension)
    VALUES ('${claims.userId}','${claims.keycloakId}','${claims.tenantId}','agent1000@demo.local','-','Agent 1000','AGENT','1000');`);
  run('pnpm', ['db:seed']);
  run('pnpm', [
    'd1:shell-flag',
    '--',
    '--tenant',
    'demo',
    '--on',
    '--reason',
    'E1.18 outbound real-call acceptance',
    '--actor',
    'e1-18-harness',
    '--ack-voice-pilot',
  ]);
  const values = psql(`WITH actor AS (
      SELECT id AS actor_id FROM users WHERE tenant_id='${claims.tenantId}' AND role='ADMIN' LIMIT 1
    ), allow_contact AS (
      INSERT INTO contacts (id,tenant_id,display_name,created_at)
      VALUES (gen_random_uuid(),'${claims.tenantId}','E1.18 allow',NOW()) RETURNING id
    ), allow_identity AS (
      INSERT INTO contact_identities (id,tenant_id,contact_id,type,value)
      SELECT gen_random_uuid(),'${claims.tenantId}',id,'PHONE','1001' FROM allow_contact RETURNING id,contact_id
    ), block_contact AS (
      INSERT INTO contacts (id,tenant_id,display_name,created_at)
      VALUES (gen_random_uuid(),'${claims.tenantId}','E1.18 block',NOW()) RETURNING id
    ), block_identity AS (
      INSERT INTO contact_identities (id,tenant_id,contact_id,type,value)
      SELECT gen_random_uuid(),'${claims.tenantId}',id,'PHONE','1002' FROM block_contact RETURNING id,contact_id
    ), consent_allow AS (
      INSERT INTO cg_consents (id,tenant_id,contact_id,identity_id,purpose,channel,status,lawful_basis,evidence,granted_at,created_at,updated_at)
      SELECT gen_random_uuid(),'${claims.tenantId}',contact_id,id,'SERVICE','VOICE','GRANTED','CONSENT','{"source":"e1-18"}'::jsonb,NOW(),NOW(),NOW() FROM allow_identity
    ), consent_block AS (
      INSERT INTO cg_consents (id,tenant_id,contact_id,identity_id,purpose,channel,status,lawful_basis,evidence,revoked_at,created_at,updated_at)
      SELECT gen_random_uuid(),'${claims.tenantId}',contact_id,id,'SERVICE','VOICE','REVOKED','CONSENT','{"source":"e1-18"}'::jsonb,NOW(),NOW(),NOW() FROM block_identity
    ), origin AS (
      INSERT INTO tenant_embed_origins (id,tenant_id,origin,label,enabled,created_by,created_at,updated_at,revision,screen_pop_level)
      SELECT gen_random_uuid(),'${claims.tenantId}','http://localhost:4173','E1.18 host',true,actor_id,NOW(),NOW(),1,'ids' FROM actor
    ), embed_flag AS (
      INSERT INTO tenant_ui_flags (tenant_id,flag_key,enabled,reason,updated_by_actor,updated_at)
      VALUES ('${claims.tenantId}','dphone.embed.enabled',true,'E1.18 acceptance','e1-18-harness',NOW())
    ), gate AS (
      INSERT INTO dl_voice_scope_gates (id,tenant_id,telephony_node_id,business_state,technical_switch_on,killed,cap_per_minute,cap_per_day,agent_cap_per_minute,agent_cap_per_day,version,created_at,updated_at)
      VALUES (gen_random_uuid(),'${claims.tenantId}','${nodeId}','SANDBOX',true,false,2,10,2,10,2,NOW(),NOW()) RETURNING id
    ), allowed AS (
      INSERT INTO dl_voice_allowlist_entries (id,tenant_id,gate_id,agent_user_id,target_identity_id,valid_from,valid_until,created_at)
      SELECT gen_random_uuid(),'${claims.tenantId}',gate.id,'${claims.userId}',allow_identity.id,NOW()-interval '1 minute',NOW()+interval '1 hour',NOW()
      FROM gate,allow_identity
    )
    SELECT allow_identity.id::text FROM allow_identity;`);
  return { ...claims, targetIdentityId: values };
}

function hostServer() {
  const html = readFileSync(resolve('examples/dphone-host/index.html'), 'utf8')
    .replaceAll('DPHONE_ORIGIN', 'http://localhost:3000')
    .replaceAll('TENANT', 'demo');
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(4173, '127.0.0.1', () => resolveListen(server));
  });
}

async function cleanup(server) {
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
  spawnSync('docker', ['rm', '-f', targetContainer], { stdio: 'ignore' });
  if (server) await new Promise((done) => server.close(done));
  await wait(1_000);
}

let server;
process.once('SIGINT', () => void cleanup(server).finally(() => process.exit(130)));
process.once('SIGTERM', () => void cleanup(server).finally(() => process.exit(143)));

try {
  run('docker', [...compose, 'ps', '--status', 'running']);
  for (const port of [3000, 4173, 5173]) {
    const used = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    if (used.stdout.trim()) throw new Error(`port ${port} ถูกใช้อยู่`);
  }
  const claims = await prepareDatabase();
  environment.E1_18_DATABASE = database;
  environment.E1_18_TENANT_ID = claims.tenantId;
  environment.E1_18_NODE_ID = nodeId;
  environment.E1_18_TARGET_IDENTITY_ID = claims.targetIdentityId;
  environment.LINE_WEBHOOK_TENANT_ID = claims.tenantId;

  run('docker', [...compose, 'exec', '-T', 'freeswitch', 'fs_cli', '-x', 'reloadxml']);
  start('target', 'docker', [
    'run',
    '--rm',
    '--name',
    targetContainer,
    '--network',
    'd-contact-dev_default',
    '--entrypoint',
    'sh',
    sippImage,
    '-c',
    'exec sipp -sn uas -i $(hostname -i) -p 5060 -nostdin -trace_err',
  ]);
  server = await hostServer();
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
    waitForHttp('http://localhost:3000/api/v1/me/navigation', 'API', api),
    waitForHttp('http://localhost:5173', 'Workspace', workspace),
    waitForConsumerGroup(routerGroupId),
    waitForConsumerGroup(telephonyGroupId),
  ]);
  const playwright = await runInteractive(
    'pnpm',
    [
      '--filter',
      '@d-contact/workspace',
      'exec',
      'playwright',
      'test',
      '--config',
      'playwright.outbound-real-call.config.ts',
    ],
    { cwd: process.cwd(), env: environment },
  );
  if (playwright.code !== 0) {
    for (const child of [api, router, telephony, workspace]) {
      process.stderr.write(`\n--- ${child.label} ---\n${child.tail().slice(-6_000)}\n`);
    }
    process.exitCode = playwright.code ?? 1;
  } else {
    process.stdout.write('OUTBOUND_DELIVERY_VOICE_SANDBOX_READY\n');
  }
} finally {
  await cleanup(server);
}
