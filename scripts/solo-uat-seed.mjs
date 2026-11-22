/**
 * #923: seed ข้อมูลทดสอบของ UAT Solo แบบเดียวกับ Demo ทีมขาย (scripts/sales-demo-stack.mjs)
 *
 * owner อนุมัติ 19 พ.ย. 2569 ให้ seed ตรงลงฐาน `dcontact` ของ UAT Solo: tenant `demo` จาก `db:seed`
 * ยังไม่มีทีม, identity binding, scope และ CONTACT_CREATE ที่ flow จริง (Platform provisioning,
 * Tenant People, Core Settings) สร้างให้ — ไม่ใช่หลักฐาน acceptance ของ identity/authorization
 *
 * รันใน container ops ของ Solo หลัง `db:migrate`, `db:rls`, `db:seed` และ `infra:identity:link`
 * (infra/solo/bin/solo-uat.sh เรียกให้) ทุกขั้น idempotent รันซ้ำได้
 *
 * เพิ่ม `supervisor@demo.local` (SUPERVISOR ของทีม Customer Care) ให้ทดสอบงานของ Supervisor ได้
 * เช่น ฟังเสียงของทีม (#967) และประเมินคุณภาพ (#971) — `db:seed` ไม่มีผู้ใช้นี้ จึงสร้างที่นี่
 * แล้วเชื่อม Keycloak ด้วยสคริปต์ link ตัวเดิม (รหัสผ่านเดียวกับ Agent: `DCONTACT_LINK_AGENT_PASSWORD`)
 *
 * env:
 *   DATABASE_URL                       owner ของฐานแอป
 *   KEYCLOAK_ADMIN_URL                 เช่น http://keycloak:8080/auth
 *   KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME / KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD
 *   KEYCLOAK_ISSUER                    issuer ใน token ของผู้ใช้ (https://<console host>/auth/realms/dcontact)
 *   KEYCLOAK_C360_CLIENT_ID / KEYCLOAK_C360_CLIENT_SECRET
 *   SOLO_API_ORIGIN                    เช่น http://api:3000
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const databaseUrl = required('DATABASE_URL');
const keycloakBaseUrl = required('KEYCLOAK_ADMIN_URL').replace(/\/$/, '');
const issuer = required('KEYCLOAK_ISSUER');
const apiOrigin = required('SOLO_API_ORIGIN').replace(/\/$/, '');
const c360ClientId = required('KEYCLOAK_C360_CLIENT_ID');
const c360ClientSecret = required('KEYCLOAK_C360_CLIENT_SECRET');
const teamId = '7d3f1c1e-2b7a-4c55-9a40-5a1e5de00001';
const supervisorId = '7d3f1c1e-2b7a-4c55-9a40-5a1e5de00002';
const supervisorEmail = 'supervisor@demo.local';
const demoUsers = [
  'admin@demo.local',
  'agent1000@demo.local',
  'agent1001@demo.local',
  supervisorEmail,
];
const uuid = /^[0-9a-f-]{36}$/i;

/** ส่งการเชื่อมต่อผ่าน PG* env ไม่ใส่ URL ใน argv — ข้อความ error ของ execFileSync จะไม่มีรหัสผ่าน */
const postgres = (() => {
  const parsed = new URL(databaseUrl);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: parsed.pathname.replace(/^\//, ''),
  };
})();

function psql(sql) {
  return execFileSync('psql', ['-X', '-v', 'ON_ERROR_STOP=1', '-Atc', sql], {
    encoding: 'utf8',
    env: postgres,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

async function keycloakAdmin() {
  const response = await fetch(`${keycloakBaseUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: required('KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME'),
      password: required('KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD'),
    }),
  });
  if (!response.ok) throw new Error(`Keycloak admin token ล้มเหลว (${response.status})`);
  const token = await response.json();
  return async (path, init = {}) => {
    const result = await fetch(`${keycloakBaseUrl}/admin/realms/dcontact${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token.access_token}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
    });
    if (!result.ok) throw new Error(`Keycloak ${path} ล้มเหลว (${result.status})`);
    const text = await result.text();
    return text ? JSON.parse(text) : null;
  };
}

async function claimsOf(admin) {
  const claims = [];
  for (const username of demoUsers) {
    const [user] = await admin(`/users?exact=true&username=${encodeURIComponent(username)}`);
    const tenantId = user?.attributes?.tenant_id?.[0];
    const userId = user?.attributes?.dc_user_id?.[0];
    if (!uuid.test(tenantId ?? '') || !uuid.test(userId ?? '') || !uuid.test(user?.id ?? '')) {
      throw new Error(`${username} ยังไม่มี tenant_id/dc_user_id — รัน infra:identity:link ก่อน`);
    }
    claims.push({ username, tenantId, userId, keycloakId: user.id });
  }
  if (new Set(claims.map((claim) => claim.tenantId)).size !== 1) {
    throw new Error('ผู้ใช้ demo ใน Keycloak ไม่ได้อยู่ tenant เดียวกัน');
  }
  return claims;
}

async function organizationId(admin) {
  const organizations = await admin('/organizations?max=200');
  const organization = organizations.find((item) => item.alias === 'demo');
  if (!organization) throw new Error('ไม่พบ Organization demo ใน Keycloak');
  return organization.id;
}

/**
 * คิวใช้โน้ตหลังจบสายแบบ VOICE_NOTE_V1 และ Agent เริ่มจาก OFFLINE เหมือน Demo
 * `db:seed` ตั้ง Agent เป็น AVAILABLE ไว้ก่อน ถ้าค้างไว้ Router จะเสนอสายให้ Agent ที่ยังไม่ login
 * แล้ว FreeSWITCH วางสายด้วย SUBSCRIBER_ABSENT จึงใส่ OFFLINE เมื่อสถานะล่าสุดไม่ใช่ OFFLINE
 * และไม่มี work session ค้าง (รันซ้ำได้โดยไม่ไล่ Agent ที่กำลังทำงาน)
 *
 * ปิดบันทึกเสียงทุกคิว: Solo ไม่มีการบันทึกเสียงที่ใช้งานได้ (FreeSWITCH อยู่คนละ VM กับ Telephony)
 * แต่ `db:seed` เปิดไว้ ถ้าค้างไว้ Telephony เริ่มบันทึกไม่ได้แล้วไม่ส่ง `call.answered`
 * Router จึงนับว่า offer หมดเวลาและตั้ง Agent เป็น BREAK ระหว่างที่ยังคุยอยู่
 */
function seedVoiceDefaults(tenantId) {
  psql(
    `UPDATE queues SET voice_wrapup_policy = 'VOICE_NOTE_V1'
     WHERE tenant_id = '${tenantId}' AND voice_wrapup_policy <> 'VOICE_NOTE_V1';
     UPDATE queues SET recording_enabled = false WHERE recording_enabled;
     INSERT INTO agent_state_logs (tenant_id, user_id, state, reason)
     SELECT u.tenant_id, u.id, 'OFFLINE', 'solo-uat-seed' FROM users u
     WHERE u.tenant_id = '${tenantId}' AND u.role = 'AGENT'
       AND COALESCE((SELECT l.state::text FROM agent_state_logs l
                     WHERE l.tenant_id = u.tenant_id AND l.user_id = u.id
                     ORDER BY l.started_at DESC, l.id DESC LIMIT 1), '') <> 'OFFLINE'
       AND NOT EXISTS (SELECT 1 FROM agent_work_session_leases w
                       WHERE w.tenant_id = u.tenant_id AND w.user_id = u.id AND w.released_at IS NULL);`,
  );
}

/**
 * ทีม Customer Care และ Supervisor ของทีม — ต้องมีก่อนอ่าน claims เพราะ Supervisor ต้องเชื่อม Keycloak ก่อน
 * เชื่อมด้วยสคริปต์ link ตัวเดิมเฉพาะเมื่อยังไม่มี keycloak_id (รอบแรก) ไม่ไปตั้งรหัสผ่านคนอื่นซ้ำทุกรอบ
 */
function seedSupervisor() {
  const tenantId = psql(`SELECT id FROM tenants WHERE slug = 'demo';`);
  if (!uuid.test(tenantId)) throw new Error('ไม่พบ tenant demo — รัน db:seed ก่อน');
  const linked = psql(
    `BEGIN;
     INSERT INTO teams (id, tenant_id, name)
     SELECT '${teamId}', '${tenantId}', 'Customer Care'
     WHERE NOT EXISTS (SELECT 1 FROM teams WHERE tenant_id = '${tenantId}' AND id = '${teamId}');
     INSERT INTO users (id, tenant_id, email, password_hash, display_name, role, team_id)
     VALUES ('${supervisorId}', '${tenantId}', '${supervisorEmail}', '-', 'Demo Supervisor', 'SUPERVISOR', '${teamId}')
     ON CONFLICT (id) DO UPDATE SET role = 'SUPERVISOR', team_id = EXCLUDED.team_id, is_active = true;
     COMMIT;
     SELECT keycloak_id IS NOT NULL FROM users WHERE id = '${supervisorId}';`,
  );
  if (!linked.endsWith('t')) run('node', ['scripts/link-keycloak-dev-identity.mjs']);
}

function seedAccess(claims, organization) {
  const tenantId = claims[0].tenantId;
  const emails = claims.map((claim) => `'${claim.username}'`).join(', ');
  psql(
    `BEGIN;
     UPDATE users SET team_id = '${teamId}'
     WHERE tenant_id = '${tenantId}' AND role = 'AGENT' AND team_id IS NULL;
     INSERT INTO tenant_voice_identity_bindings
       (tenant_id, user_id, issuer, subject_id, client_id, tenant_slug, organization_id, identity_class,
        source_kind, evidence_ref, evidence_digest, verified_by_operator_subject, verified_at, revision, is_active)
     SELECT u.tenant_id, u.id, '${issuer}', u.keycloak_id::text, 'agent-desktop', 'demo',
       '${organization}'::uuid, 'TENANT_USER', 'VERIFIED_ENROLLMENT', 'solo-uat-seed',
       repeat('d', 64), 'solo-uat-seed', now(), 1, true
     FROM users u
     WHERE u.tenant_id = '${tenantId}' AND u.email IN (${emails})
       AND NOT EXISTS (
         SELECT 1 FROM tenant_voice_identity_bindings b
         WHERE b.tenant_id = u.tenant_id AND b.user_id = u.id
       );
     COMMIT;`,
  );
}

/** ทีมได้ WORK และ VIEW บน `system:all-customers` ผ่าน repository ของ IAM ตัวจริง (ซ้ำได้ผล DUPLICATE) */
function seedScope(tenantId) {
  const code = `
    import { PrismaClient } from '@d-contact/db';
    import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
    void (async () => {
      const db = new PrismaClient();
      const repository = new IamTeamSegmentScopeRepository(db);
      for (const permission of ['WORK', 'VIEW'] as const) {
        await repository.grant({
          tenantId: '${tenantId}',
          teamId: '${teamId}',
          segmentId: 'system:all-customers',
          permission,
          correlationId: 'solo-uat-seed',
        });
      }
      await db.$disconnect();
    })();`;
  run('node', ['node_modules/tsx/dist/cli.mjs', '--eval', code], { cwd: resolve('apps/api') });
}

/** client introspection ของ Cus360 ใช้ secret ของ Solo (ไม่ใช่ค่า dev) และ audience mapper ที่ agent-desktop */
async function c360IntrospectionClient(admin) {
  let [client] = await admin(`/clients?clientId=${encodeURIComponent(c360ClientId)}`);
  const representation = {
    clientId: c360ClientId,
    name: 'D-Contact Cus360 introspection (UAT Solo)',
    enabled: true,
    protocol: 'openid-connect',
    publicClient: false,
    clientAuthenticatorType: 'client-secret',
    secret: c360ClientSecret,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    fullScopeAllowed: false,
    attributes: { 'standard.token.exchange.enabled': 'false' },
  };
  if (!client) {
    await admin('/clients', { method: 'POST', body: JSON.stringify(representation) });
    [client] = await admin(`/clients?clientId=${encodeURIComponent(c360ClientId)}`);
  } else {
    const current = await admin(`/clients/${client.id}/client-secret`);
    if (current?.value !== c360ClientSecret) {
      await admin(`/clients/${client.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...client, secret: c360ClientSecret }),
      });
    }
  }
  const [desktop] = await admin('/clients?clientId=agent-desktop');
  const mappers = await admin(`/clients/${desktop.id}/protocol-mappers/models`);
  const audience = mappers.find(
    (mapper) =>
      mapper.protocolMapper === 'oidc-audience-mapper' &&
      mapper.config?.['included.client.audience'] === c360ClientId,
  );
  if (!audience) {
    await admin(`/clients/${desktop.id}/protocol-mappers/models`, {
      method: 'POST',
      body: JSON.stringify({
        name: 'c360 introspection audience (UAT Solo)',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.client.audience': c360ClientId,
          'access.token.claim': 'true',
          'id.token.claim': 'false',
          'introspection.token.claim': 'true',
        },
      }),
    });
  }
}

/** CONTACT_CREATE ของ Admin ผ่าน operator command จริงของ API (dry-run ก่อน) */
async function grantCustomerCreate(admin, claims, organization) {
  const adminClaim = claims.find((claim) => claim.username === 'admin@demo.local');
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
        description: 'D-Contact platform operator (UAT Solo)',
      }),
    });
  }
  const role = await admin(`/roles/${operatorRole}`);
  const password = randomBytes(24).toString('base64url');
  let [user] = await admin(`/users?exact=true&username=${encodeURIComponent(operatorUsername)}`);
  const operatorUserId = user?.attributes?.dc_user_id?.[0] ?? randomUUID();
  const representation = {
    username: operatorUsername,
    email: operatorUsername,
    emailVerified: true,
    enabled: true,
    firstName: 'Solo',
    lastName: 'Operator',
    attributes: { tenant_id: [tenantId], tenant_slug: ['demo'], dc_user_id: [operatorUserId] },
    requiredActions: [],
  };
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
  psql(
    `INSERT INTO users (id, keycloak_id, tenant_id, email, password_hash, display_name, role)
     VALUES ('${operatorUserId}', '${user.id}', '${tenantId}', '${operatorUsername}', '-', 'Solo Operator', 'SUPERVISOR')
     ON CONFLICT (id) DO NOTHING;`,
  );
  const members = await admin(`/organizations/${organization}/members?max=200`);
  if (!members.some((member) => member.id === user.id)) {
    await admin(`/organizations/${organization}/members`, {
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
    evidenceRef: 'ticket:923',
    reasonCode: 'SOLO_UAT_SETUP',
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
    if (!response.ok) {
      throw new Error(
        `operator CAPABILITY_GRANT${dryRun ? ' (dry-run)' : ''} ${response.status}: ${await response.text()}`,
      );
    }
  }
  return true;
}

async function main() {
  seedSupervisor();
  const admin = await keycloakAdmin();
  const claims = await claimsOf(admin);
  const tenantId = claims[0].tenantId;
  const organization = await organizationId(admin);

  seedVoiceDefaults(tenantId);
  seedAccess(claims, organization);
  seedScope(tenantId);
  await c360IntrospectionClient(admin);
  run('pnpm', [
    'd1:shell-flag',
    '--',
    '--tenant',
    'demo',
    '--on',
    '--reason',
    'UAT Solo (#923)',
    '--actor',
    'solo-uat-seed',
    '--ack-voice-pilot',
  ]);
  const granted = await grantCustomerCreate(admin, claims, organization);
  console.log(
    `SOLO_UAT_SEED_OK tenant=${tenantId} contactCreate=${granted ? 'granted' : 'already'}`,
  );
}

main().catch((error) => {
  console.error(`solo-uat-seed ล้มเหลว: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
