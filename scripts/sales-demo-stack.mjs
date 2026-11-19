/**
 * Stack สำหรับ Demo ให้ทีมขาย: API + Router + Telephony + Workspace (5173) + Console (5174) บน dev compose
 *
 * - ใช้ DB แยก `dcontact_demo` (ไม่แตะ `dcontact`) ข้อมูลคงอยู่ระหว่างรอบซ้อม; `--reset` สร้างใหม่ทั้งฐาน
 * - ไม่แก้ user ใน Keycloak: tenant demo, admin และ agent ใช้ id ที่ Keycloak ออก claim ให้อยู่แล้ว
 *   (ต้องเคยรัน `pnpm infra:identity:link`) เพิ่มเฉพาะ redirect ของ Console ที่ client `agent-desktop`
 * - Admin สร้าง/นำเข้าลูกค้าได้เมื่อ platform operator ให้ `CONTACT_CREATE` (Cus360 E1 D) stack นี้สร้าง
 *   realm role `platform-operator` และผู้ใช้ `operator@demo.local` ใน Keycloak dev (รหัสผ่านสุ่มใหม่ทุกรอบ
 *   ไม่แสดงผล) แล้วให้สิทธิ์ผ่าน operator API จริง ไม่เขียนตาราง grant ตรง
 * - Owner อนุมัติ 19 พ.ย. 2569: seed ทีม `Customer Care` และ identity binding ของผู้ใช้ demo ลงฐานนี้โดยตรง
 *   (ดู `seedDemoAccess`) ผลจาก stack นี้จึงไม่ใช่หลักฐาน acceptance ของ identity/authorization
 * - ต้องรัน `pnpm infra:up` ก่อน และ port 3000/5173/5174 ต้องว่าง
 *
 * รัน: node scripts/sales-demo-stack.mjs [--reset]   หยุดด้วย Ctrl-C
 * D-Phone: ตั้ง SALES_DEMO_DPHONE_EXTENSION_ID เพื่อใช้ Chrome extension แทน browser phone ในตัว
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stopChild } from './child-process-lifecycle.mjs';

const compose = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];
const database = 'dcontact_demo';
const reset = process.argv.includes('--reset');
const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const nodeId = 'fs-local';
const routerGroupId = 'dcontact-router-sales-demo';
const workspaceOrigin = 'http://localhost:5173';
const consoleOrigin = 'http://localhost:5174';
const apiOrigin = 'http://localhost:3000';
const demoUsers = [
  { username: 'admin@demo.local', displayName: 'Demo Admin', role: 'ADMIN', extension: null },
  { username: 'agent1000@demo.local', displayName: 'Agent 1000', role: 'AGENT', extension: '1000' },
  { username: 'agent1001@demo.local', displayName: 'Agent 1001', role: 'AGENT', extension: '1001' },
];
const demoTeamId = '7d3f1c1e-2b7a-4c55-9a40-5a1e5de00001';
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

const extensionId = process.env.SALES_DEMO_DPHONE_EXTENSION_ID;
const environment = {
  ...dotenv(resolve('.env')),
  ...process.env,
  DATABASE_URL: `postgresql://dcontact:dcontact@localhost:5433/${database}?schema=public`,
  APPLICATION_DATABASE_URL: `postgresql://dcontact_app:dcontact_app@localhost:5433/${database}?schema=public`,
  PLATFORM_DATABASE_URL: `postgresql://dcontact_platform:dcontact_platform@localhost:5433/${database}?schema=public`,
  TELEPHONY_NODE_ID: nodeId,
  ROUTER_INBOUND_VOICE_GROUP_ID: routerGroupId,
  IAM_SEGMENT_PROJECTION_GROUP_ID: 'dcontact-iam-segment-sales-demo',
  SIP_BROWSER_NODES_JSON: JSON.stringify([
    { telephonyNodeId: nodeId, wssUrl: 'ws://localhost:5066' },
  ]),
  SIP_BROWSER_FIXED_PASSWORD: 'sales-demo-local-only-password',
  WORKSPACE_ORIGIN: workspaceOrigin,
  VITE_KC_ISSUER: `${keycloakBaseUrl}/realms/dcontact`,
  VITE_KC_CLIENT_ID: 'agent-desktop',
  VITE_API_BASE_URL: apiOrigin,
  VITE_WORKSPACE_URL: workspaceOrigin,
  VITE_CONSOLE_URL: consoleOrigin,
  LINE_WEBHOOK_SECRET_SOURCE: 'disabled',
  LINE_WEBHOOK_CHANNEL_ACCOUNT_ID: 'sales-demo-disabled',
  LINE_WEBHOOK_DESTINATION: 'sales-demo-disabled',
  LINE_WEBHOOK_PAYLOAD_KEY_REF: 'sales-demo-disabled',
  PORT: '3000',
  ...(extensionId
    ? { VITE_SOFTPHONE_CONTROL: 'chrome-extension', VITE_D_PHONE_EXTENSION_ID: extensionId }
    : {}),
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
    if (process.env.SALES_DEMO_VERBOSE) process.stderr.write(`[${label}] ${chunk}`);
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
  for (let attempt = 0; attempt < 240; attempt += 1) {
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
  for (let attempt = 0; attempt < 120; attempt += 1) {
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
  for (const port of [3000, 5173, 5174]) {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    if (result.stdout.trim()) {
      throw new Error(`port ${port} ถูกใช้อยู่ — ปิด dev server เดิมก่อนเปิด stack ของ Demo`);
    }
  }
}

async function keycloakAdmin() {
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
  return async (path, init = {}) => {
    const response = await fetch(`${keycloakBaseUrl}/admin/realms/dcontact${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token.access_token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!response.ok) throw new Error(`Keycloak ${path} ล้มเหลว (${response.status})`);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
}

async function keycloakClaims(admin) {
  const uuid = /^[0-9a-f-]{36}$/i;
  const claims = [];
  for (const user of demoUsers) {
    const found = await admin(`/users?exact=true&username=${encodeURIComponent(user.username)}`);
    const attributes = found[0]?.attributes ?? {};
    const tenantId = attributes.tenant_id?.[0];
    const userId = attributes.dc_user_id?.[0];
    if (!uuid.test(tenantId ?? '') || !uuid.test(userId ?? '') || !uuid.test(found[0]?.id ?? '')) {
      throw new Error(
        `${user.username} ใน Keycloak ยังไม่มี tenant_id/dc_user_id — รัน pnpm infra:identity:link ก่อน`,
      );
    }
    claims.push({ ...user, tenantId, userId, keycloakId: found[0].id });
  }
  if (new Set(claims.map((claim) => claim.tenantId)).size !== 1) {
    throw new Error('ผู้ใช้ demo ใน Keycloak ไม่ได้อยู่ tenant เดียวกัน');
  }
  return claims;
}

/** Console dev อยู่ที่ 5174 แต่ realm dev อนุญาตเฉพาะ 5173 — เพิ่มแบบ additive และ idempotent */
async function allowConsoleRedirect(admin) {
  const [client] = await admin('/clients?clientId=agent-desktop');
  if (!client) throw new Error('ไม่พบ client agent-desktop ใน realm dcontact');
  const redirectUris = new Set(client.redirectUris ?? []);
  const webOrigins = new Set(client.webOrigins ?? []);
  if (redirectUris.has(`${consoleOrigin}/*`) && webOrigins.has(consoleOrigin)) return false;
  redirectUris.add(`${consoleOrigin}/*`);
  webOrigins.add(consoleOrigin);
  await admin(`/clients/${client.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...client,
      redirectUris: [...redirectUris],
      webOrigins: [...webOrigins],
    }),
  });
  return true;
}

function databaseExists() {
  return psql(`SELECT 1 FROM pg_database WHERE datname = '${database}';`, 'postgres') === '1';
}

function prepareDatabase(claims) {
  const exists = databaseExists();
  if (exists && reset) {
    psql(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${database}' AND pid <> pg_backend_pid();`,
      'postgres',
    );
    psql(`DROP DATABASE ${database};`, 'postgres');
  }
  const create = !exists || reset;
  if (create) psql(`CREATE DATABASE ${database};`, 'postgres');
  run('pnpm', ['db:migrate']);
  run('pnpm', ['db:rls']);
  if (!create) return false;

  const tenantId = claims[0].tenantId;
  const quote = (value) => (value === null ? 'NULL' : `'${value}'`);
  psql(
    `INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'Demo Company', 'demo', 'dcontact.local');
     ${claims
       .map(
         (claim) =>
           `INSERT INTO users (id, keycloak_id, tenant_id, email, password_hash, display_name, role, extension)
            VALUES ('${claim.userId}', '${claim.keycloakId}', '${tenantId}', '${claim.username}', '-', '${claim.displayName}', '${claim.role}', ${quote(claim.extension)});`,
       )
       .join('\n')}`,
  );
  run('pnpm', ['db:seed']);
  // โน้ตหลังจบสายใช้ได้เฉพาะคิวที่ตั้ง VOICE_NOTE_V1 (ค่าเริ่มต้นของ seed คือ LEGACY)
  psql(
    `UPDATE queues SET voice_wrapup_policy = 'VOICE_NOTE_V1' WHERE tenant_id = '${tenantId}';
     INSERT INTO agent_state_logs (tenant_id, user_id, state, reason)
     SELECT tenant_id, id, 'OFFLINE', 'sales-demo' FROM users
     WHERE tenant_id = '${tenantId}' AND role = 'AGENT';`,
  );
  // shell รุ่น D1 เฉพาะ tenant demo ในฐานแยกนี้ — ไม่กระทบ tenant ของ #77
  run('pnpm', [
    'd1:shell-flag',
    '--',
    '--tenant',
    'demo',
    '--on',
    '--reason',
    'Sales demo (DB แยก dcontact_demo)',
    '--actor',
    'sales-demo-stack',
    '--ack-voice-pilot',
  ]);
  return true;
}

/**
 * Agent ค้น/เชื่อม/แก้ลูกค้าระหว่างสายได้เมื่อ API มี confidential client สำหรับ introspection
 * (`KEYCLOAK_C360_CLIENT_ID/SECRET`) ค่ามาตรฐานของ dev มาจาก realm และ `.env.example` (#916, #918)
 * realm import ข้าม realm ที่มีอยู่แล้ว Keycloak dev เดิมจึงอาจยังไม่มี client/mapper — สร้างให้ตรง realm file
 * และตั้ง secret เป็นค่าเดียวกับ `.env.example` (ไม่หมุน) เพื่อให้ API ที่รันตาม `.env.example` ใช้ได้พร้อมกัน
 */
const C360_INTROSPECTION_CLIENT = 'dcontact-c360-introspection-dev';
const C360_INTROSPECTION_SECRET = 'dcontact-c360-introspection-dev-secret';

async function c360IntrospectionClient(admin) {
  const clientId = environment.KEYCLOAK_C360_CLIENT_ID ?? C360_INTROSPECTION_CLIENT;
  const clientSecret = environment.KEYCLOAK_C360_CLIENT_SECRET ?? C360_INTROSPECTION_SECRET;
  let [client] = await admin(`/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!client) {
    await admin('/clients', {
      method: 'POST',
      body: JSON.stringify({
        clientId,
        name: 'D-Contact Cus360 introspection (development only)',
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        clientAuthenticatorType: 'client-secret',
        secret: clientSecret,
        standardFlowEnabled: false,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        fullScopeAllowed: false,
        attributes: { 'standard.token.exchange.enabled': 'false' },
      }),
    });
    [client] = await admin(`/clients?clientId=${encodeURIComponent(clientId)}`);
  } else {
    // client เดิมจากสคริปต์รุ่นก่อนใช้ secret ที่หมุนไว้ — ตั้งกลับเป็นค่ามาตรฐานเท่านั้น ไม่แก้ค่าอื่น
    const current = await admin(`/clients/${client.id}/client-secret`);
    if (current?.value !== clientSecret) {
      await admin(`/clients/${client.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...client, secret: clientSecret }),
      });
    }
  }
  // Keycloak ตอบ introspection ว่า inactive ถ้า client ที่ถามไม่อยู่ใน aud ของ token —
  // ชื่อ mapper ตรงกับ realm file ของ #918 จึงไม่สร้างซ้ำ
  const [desktop] = await admin('/clients?clientId=agent-desktop');
  const mapperName = 'c360 introspection audience (development only)';
  const mappers = await admin(`/clients/${desktop.id}/protocol-mappers/models`);
  if (!mappers.some((mapper) => mapper.name === mapperName)) {
    await admin(`/clients/${desktop.id}/protocol-mappers/models`, {
      method: 'POST',
      body: JSON.stringify({
        name: mapperName,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.client.audience': clientId,
          'access.token.claim': 'true',
          'id.token.claim': 'false',
          'introspection.token.claim': 'true',
        },
      }),
    });
  }
  return { clientId, clientSecret };
}

async function demoOrganizationId(admin) {
  const organizations = await admin('/organizations?max=200');
  const organization = organizations.find((item) => item.alias === 'demo');
  if (!organization) throw new Error('ไม่พบ Organization demo ใน Keycloak');
  return organization.id;
}

/**
 * Owner อนุมัติ 19 พ.ย. 2569 ให้ seed ลงฐาน Demo โดยตรง: tenant จาก `db:seed` ไม่มีทีมและ identity binding
 * ที่ flow จริง (Platform provisioning, Tenant People, Core Settings) สร้างให้ จึงเติมเฉพาะฐาน `dcontact_demo`
 * ไม่ใช่หลักฐาน acceptance ของ identity/authorization และห้ามใช้กับฐานอื่น — idempotent
 */
function seedDemoAccess(claims, organizationId) {
  const tenantId = claims[0].tenantId;
  const teamId = demoTeamId;
  const emails = claims.map((claim) => `'${claim.username}'`).join(', ');
  psql(
    `BEGIN;
     INSERT INTO teams (id, tenant_id, name)
     SELECT '${teamId}', '${tenantId}', 'Customer Care'
     WHERE NOT EXISTS (SELECT 1 FROM teams WHERE tenant_id = '${tenantId}' AND id = '${teamId}');
     UPDATE users SET team_id = '${teamId}'
     WHERE tenant_id = '${tenantId}' AND role = 'AGENT' AND team_id IS NULL;
     INSERT INTO tenant_voice_identity_bindings
       (tenant_id, user_id, issuer, subject_id, client_id, tenant_slug, organization_id, identity_class,
        source_kind, evidence_ref, evidence_digest, verified_by_operator_subject, verified_at, revision, is_active)
     SELECT u.tenant_id, u.id, '${keycloakBaseUrl}/realms/dcontact', u.keycloak_id::text, 'agent-desktop', 'demo',
       '${organizationId}'::uuid, 'TENANT_USER', 'VERIFIED_ENROLLMENT', 'sales-demo-seed',
       repeat('d', 64), 'sales-demo-seed', now(), 1, true
     FROM users u
     WHERE u.tenant_id = '${tenantId}' AND u.email IN (${emails})
       AND NOT EXISTS (
         SELECT 1 FROM tenant_voice_identity_bindings b
         WHERE b.tenant_id = u.tenant_id AND b.user_id = u.id
       );
     COMMIT;`,
  );
}

/**
 * Agent ค้นลูกค้าในสายได้เมื่อทีมมี WORK บน segment (#911) แต่ API/Console ให้ได้เฉพาะ VIEW
 * จึงให้ WORK และ VIEW บน `system:all-customers` ผ่าน repository ของ IAM ตัวจริง (เพิ่ม version และ
 * invalidation ครบ) — ส่วนหนึ่งของ seed ที่ owner อนุมัติ, idempotent (ซ้ำได้ผล DUPLICATE)
 */
function seedDemoScope(claims) {
  const code = `
    import { PrismaClient } from '@d-contact/db';
    import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
    void (async () => {
      const db = new PrismaClient();
      const repository = new IamTeamSegmentScopeRepository(db);
      for (const permission of ['WORK', 'VIEW'] as const) {
        await repository.grant({
          tenantId: '${claims[0].tenantId}',
          teamId: '${demoTeamId}',
          segmentId: 'system:all-customers',
          permission,
          correlationId: 'sales-demo-seed',
        });
      }
      await db.$disconnect();
    })();`;
  run('node', ['node_modules/tsx/dist/cli.mjs', '--eval', code], { cwd: resolve('apps/api') });
}

/** Cus360 E1 D: ให้ CONTACT_CREATE แก่ Admin ผ่าน operator command จริง (dry-run ก่อน) — idempotent */
async function grantCustomerCreate(admin, claims) {
  const adminClaim = claims.find((claim) => claim.role === 'ADMIN');
  const tenantId = adminClaim.tenantId;
  const granted = psql(
    `SELECT 1 FROM c360_actor_capability_grants g
     WHERE g.tenant_id = '${tenantId}' AND g.grantee_user_id = '${adminClaim.userId}'
       AND g.capability = 'CONTACT_CREATE'
       AND NOT EXISTS (SELECT 1 FROM c360_actor_capability_revocations r WHERE r.grant_id = g.id)
     LIMIT 1;`,
  );
  if (granted === '1') return false;

  const operatorRole = 'platform-operator';
  const operatorUsername = 'operator@demo.local';
  const roles = await admin('/roles');
  if (!roles.some((role) => role.name === operatorRole)) {
    await admin('/roles', {
      method: 'POST',
      body: JSON.stringify({
        name: operatorRole,
        description: 'D-Contact platform operator (development only)',
      }),
    });
  }
  const role = await admin(`/roles/${operatorRole}`);
  const password = randomBytes(24).toString('base64url');
  const representation = {
    username: operatorUsername,
    email: operatorUsername,
    emailVerified: true,
    enabled: true,
    firstName: 'Demo',
    lastName: 'Operator',
    attributes: { tenant_id: [tenantId], tenant_slug: ['demo'] },
    requiredActions: [],
  };
  let [user] = await admin(`/users?exact=true&username=${encodeURIComponent(operatorUsername)}`);
  // gateway ต้องการ dc_user_id ใน token; operator ไม่มี User row ใน tenant (ต่างจาก grantee เสมอ)
  const operatorUserId = user?.attributes?.dc_user_id?.[0] ?? randomUUID();
  representation.attributes.dc_user_id = [operatorUserId];
  if (!user) {
    await admin('/users', { method: 'POST', body: JSON.stringify(representation) });
    [user] = await admin(`/users?exact=true&username=${encodeURIComponent(operatorUsername)}`);
  } else {
    await admin(`/users/${user.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...user, ...representation }),
    });
  }
  await admin(`/users/${user.id}/reset-password`, {
    method: 'PUT',
    body: JSON.stringify({ type: 'password', value: password, temporary: false }),
  });
  await admin(`/users/${user.id}/role-mappings/realm`, {
    method: 'POST',
    body: JSON.stringify([{ id: role.id, name: role.name }]),
  });
  // gateway รับเฉพาะ token ของบัญชีที่ active ใน tenant (local account admission) — operator จึงต้องมี User row
  psql(
    `INSERT INTO users (id, keycloak_id, tenant_id, email, password_hash, display_name, role)
     VALUES ('${operatorUserId}', '${user.id}', '${tenantId}', '${operatorUsername}', '-', 'Demo Operator', 'SUPERVISOR')
     ON CONFLICT (id) DO NOTHING;`,
  );
  const organizationId = await demoOrganizationId(admin);
  const members = await admin(`/organizations/${organizationId}/members?max=200`);
  if (!members.some((member) => member.id === user.id)) {
    await admin(`/organizations/${organizationId}/members`, {
      method: 'POST',
      body: JSON.stringify(user.id),
    });
  }

  const token = await fetch(`${keycloakBaseUrl}/realms/dcontact/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'dcontact-dev-readiness',
      username: operatorUsername,
      password,
      scope: 'openid organization:demo',
    }),
  }).then((response) => response.json());
  if (!token.access_token) throw new Error(`ออก token ของ operator ไม่ได้ (${token.error})`);

  const request = {
    commandId: randomUUID(),
    evidenceRef: 'ticket:SALES-DEMO',
    reasonCode: 'SALES_DEMO_SETUP',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: adminClaim.userId,
      capability: 'CONTACT_CREATE',
    },
  };
  for (const dryRun of [true, false]) {
    const response = await fetch(`${apiOrigin}/api/v1/customer-360/operator/commands`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token.access_token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...request, dryRun }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `operator CAPABILITY_GRANT${dryRun ? ' (dry-run)' : ''} ${response.status}: ${text}`,
      );
    }
  }
  return true;
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
  const admin = await keycloakAdmin();
  const claims = await keycloakClaims(admin);
  const added = await allowConsoleRedirect(admin);
  process.stdout.write(
    `# Keycloak: redirect ของ Console ${added ? 'เพิ่มแล้ว' : 'มีอยู่แล้ว'} (${consoleOrigin})\n`,
  );
  const organizationId = await demoOrganizationId(admin);
  const introspection = await c360IntrospectionClient(admin);
  environment.KEYCLOAK_C360_CLIENT_ID = introspection.clientId;
  environment.KEYCLOAK_C360_CLIENT_SECRET = introspection.clientSecret;
  const created = prepareDatabase(claims);
  seedDemoAccess(claims, organizationId);
  seedDemoScope(claims);
  environment.LINE_WEBHOOK_TENANT_ID = claims[0].tenantId;
  process.stdout.write(
    `# DB ${database} ${created ? 'สร้างใหม่' : 'ใช้ข้อมูลเดิม'} (tenant ${claims[0].tenantId})\n`,
  );

  const api = start('api', 'node', ['node_modules/tsx/dist/cli.mjs', 'src/main.ts'], {
    cwd: resolve('apps/api'),
  });
  const router = start('router', 'pnpm', ['--filter', '@d-contact/router', 'dev']);
  const telephony = start('telephony', 'pnpm', ['--filter', '@d-contact/telephony', 'dev']);
  const vite = (filter, port) => [
    '--filter',
    filter,
    'exec',
    'vite',
    '--host',
    'localhost',
    '--port',
    String(port),
    '--strictPort',
  ];
  const workspace = start('workspace', 'pnpm', vite('@d-contact/workspace', 5173));
  // API อนุญาต CORS เฉพาะ origin ของ Workspace — Console จึงเรียก /api ผ่าน proxy ของ Vite ตัวเอง
  const consoleApp = start(
    'console',
    'pnpm',
    [
      ...vite('@d-contact/console', 5174),
      '--config',
      resolve('scripts/sales-demo-console.vite.config.mjs'),
    ],
    { env: { ...environment, VITE_API_BASE_URL: consoleOrigin } },
  );
  await Promise.all([
    waitForHttp(`${apiOrigin}/api/v1/me/navigation`, 'API', api),
    waitForHttp(workspaceOrigin, 'Workspace', workspace),
    waitForHttp(consoleOrigin, 'Console', consoleApp),
    waitForConsumerGroup(routerGroupId),
    waitForConsumerGroup(`dcontact-telephony-command-${nodeId}-v1`),
  ]);
  // ให้สิทธิ์ไม่สำเร็จไม่ควรล้ม stack ทั้งชุด: ส่วนรับสายยังซ้อมได้ แต่ Admin จะนำเข้า CSV ไม่ได้
  try {
    const capability = await grantCustomerCreate(await keycloakAdmin(), claims);
    process.stdout.write(
      `# CONTACT_CREATE ของ Admin ${capability ? 'ให้ผ่าน operator API แล้ว' : 'มีอยู่แล้ว'}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `# WARN: ให้ CONTACT_CREATE ไม่สำเร็จ — ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.stdout.write(
    [
      'SALES_DEMO_STACK_READY',
      `Workspace  ${workspaceOrigin}/?tenant=demo   (agent1000@demo.local)`,
      `Console    ${consoleOrigin}/?tenant=demo   (admin@demo.local)`,
      `โทรศัพท์    ${extensionId ? 'D-Phone Chrome extension' : 'browser phone ในตัว Workspace'}`,
      'หยุดด้วย Ctrl-C',
      '',
    ].join('\n'),
  );

  await new Promise((done, fail) => {
    for (const child of children) {
      child.once('exit', (code) =>
        cleaningUp
          ? done()
          : fail(
              new Error(`${child.label} หยุดทำงาน (exit ${code})\n${child.tail().slice(-4_000)}`),
            ),
      );
    }
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
