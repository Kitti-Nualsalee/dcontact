import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * #977: งานของ operator ที่ต้องทำก่อน Admin ของ tenant ใหม่ (ที่สร้างผ่าน Platform provisioning) จะเชิญ Agent
 * ตั้งคิว และผูกเบอร์ปลายทางผ่าน Console ได้ — รวมขั้นที่เดิมต้องเขียน SQL/Keycloak เองตาม
 * docs/voice/catalog-v1.md, docs/tenant-voice-configuration.md และ docs/tenant-people-invitations.md
 *
 * - Keycloak: attribute ของ user profile ที่ extension tenant-people ตรวจ (admin-only, single value) และ
 *   service client `dcontact-tenant-people-<tenantId>` ที่ผูก Organization ของ tenant
 * - DB (บัญชี operator/owner): TenantVoiceProvisioningPolicy revision แรก (PLAN_SNAPSHOT ตรง plan binding,
 *   caps ระบุเองทั้ง 4 ค่า ไม่เดาจาก entitlements), extension pool, เบอร์ปลายทางที่ reserve แบบ inactive และ
 *   tenant_people_worker_bindings
 * - ไม่สร้างคิว/skill/ผู้ใช้แทน Admin ไม่เปิดเบอร์ปลายทาง และไม่เขียน identity binding รายคน
 * - ค่าเริ่มต้นเป็น dry-run: ตรวจและพิมพ์แผนเท่านั้น ต้องใส่ `--apply` จึงเขียนจริง รันซ้ำได้ (ของที่ตรงแล้วข้าม)
 * - secret ไม่ออก stdout: เขียนลงไฟล์ `--env-out` (mode 600) เป็นค่า env ที่ API ต้องใช้
 *
 * รัน: DATABASE_URL=<operator> KEYCLOAK_ADMIN_URL=... KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME/PASSWORD=...
 *      node scripts/tenant-voice-onboarding.mjs --tenant <slug> ... [--apply]
 */

export const PEOPLE_PROFILE_ATTRIBUTES = Object.freeze([
  'dc_identity_class',
  'tenant_id',
  'tenant_slug',
  'dc_user_id',
  'dc_tenant_people_operation_id',
  'dc_invitation_not_before',
]);
const DIGEST = /^[a-f0-9]{64}$/;
const NODE_ID = /^[A-Za-z0-9_.-]{1,128}$/;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const PRINCIPAL = /^[a-z_][a-z0-9_]{0,62}$/;

const usage = `ใช้: node scripts/tenant-voice-onboarding.mjs --tenant <slug>
  --approval-ref <ref> --operator-subject <subject> --reason <ข้อความ>
  --accounts <n> --agents <n> --voice-queues <n> --skills <n>
  --node <telephonyNodeId> --release-digest <sha256> --dialplan-digest <sha256>
  --extensions <1000-1009|1000,1001> --destination <เบอร์> --worker-principal <role>
  [--create-worker-principal | --rotate-worker-password] [--issuer <url>]
  [--apply --env-out <ไฟล์>]`;

function integerFlag(value, name) {
  if (!/^\d{1,7}$/.test(value ?? '') || Number(value) > 1_000_000)
    throw new Error(`${name} ต้องเป็นจำนวนเต็ม 0–1,000,000`);
  return Number(value);
}

/** แปลง `1000-1009` หรือ `1000,1001` เป็นรายการ extension 4–6 หลัก (ไม่ซ้ำ เรียงตามที่ระบุ) */
export function parseExtensions(raw) {
  const refs = [];
  for (const part of String(raw ?? '').split(',')) {
    const range = /^(\d{4,6})-(\d{4,6})$/.exec(part.trim());
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (range[1].length !== range[2].length || to < from || to - from >= 1000)
        throw new Error('ช่วง extension ไม่ถูกต้อง');
      for (let value = from; value <= to; value++)
        refs.push(String(value).padStart(range[1].length, '0'));
    } else if (/^\d{4,6}$/.test(part.trim())) refs.push(part.trim());
    else throw new Error('extension ต้องเป็นตัวเลข 4–6 หลัก');
  }
  if (!refs.length || new Set(refs).size !== refs.length) throw new Error('extension ว่างหรือซ้ำ');
  return refs;
}

export function parseArguments(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!key.startsWith('--')) throw new Error(usage);
    const name = key.slice(2);
    if (['apply', 'create-worker-principal', 'rotate-worker-password'].includes(name))
      flags[name] = true;
    else flags[name] = argv[++index];
  }
  const required = (name) => {
    const value = flags[name];
    if (typeof value !== 'string' || !value.trim()) throw new Error(`ต้องระบุ --${name}\n${usage}`);
    return value.trim();
  };
  const tenant = required('tenant');
  if (!SLUG.test(tenant)) throw new Error('--tenant ต้องเป็น slug ของ tenant');
  const node = required('node');
  if (!NODE_ID.test(node)) throw new Error('--node ไม่ถูกต้อง');
  const releaseDigest = required('release-digest');
  const dialplanDigest = required('dialplan-digest');
  if (!DIGEST.test(releaseDigest) || !DIGEST.test(dialplanDigest))
    throw new Error('digest ต้องเป็น sha256 hex ตัวเล็ก 64 ตัว');
  const destination = required('destination');
  if (!/^[0-9]{3,15}$/.test(destination)) throw new Error('--destination ต้องเป็นตัวเลข 3–15 หลัก');
  const workerPrincipal = required('worker-principal');
  if (!PRINCIPAL.test(workerPrincipal))
    throw new Error('--worker-principal ไม่ใช่ชื่อ role ที่ใช้ได้');
  const text = (name, max) => {
    const value = required(name);
    if (value.length > max) throw new Error(`--${name} ยาวเกิน ${max} ตัวอักษร`);
    return value;
  };
  const apply = flags.apply === true;
  // secret (client secret และรหัสผ่าน worker) มีทางเดียวที่จะออกจากสคริปต์ คือไฟล์นี้
  if (apply && (typeof flags['env-out'] !== 'string' || !flags['env-out'].trim()))
    throw new Error('--apply ต้องใช้คู่กับ --env-out เพื่อเก็บ secret');
  if (flags['create-worker-principal'] && flags['rotate-worker-password'])
    throw new Error(
      'เลือก --create-worker-principal หรือ --rotate-worker-password อย่างใดอย่างหนึ่ง',
    );
  return {
    tenant,
    approvalRef: text('approval-ref', 200),
    operatorSubject: text('operator-subject', 200),
    reason: text('reason', 500),
    caps: {
      accounts: integerFlag(flags.accounts, '--accounts'),
      agents: integerFlag(flags.agents, '--agents'),
      voiceQueues: integerFlag(flags['voice-queues'], '--voice-queues'),
      skills: integerFlag(flags.skills, '--skills'),
    },
    node: { telephonyNodeId: node, releaseDigest, dialplanDigest },
    extensions: parseExtensions(required('extensions')),
    destination,
    workerPrincipal,
    createWorkerPrincipal: flags['create-worker-principal'] === true,
    rotateWorkerPassword: flags['rotate-worker-password'] === true,
    issuer: typeof flags.issuer === 'string' ? flags.issuer : null,
    envOut: flags['env-out'] ?? null,
    apply,
  };
}

/** pool ตามรูปที่ `extensionPermit` ของ API ยอมรับ (key ครบ 4 ตัวพอดี) */
export function extensionPool(extensions, node) {
  return extensions.map((ref) => ({
    ref,
    telephonyNodeId: node.telephonyNodeId,
    releaseDigest: node.releaseDigest,
    dialplanDigest: node.dialplanDigest,
  }));
}

/** รายการ binding ของ tenant ใน TENANT_PEOPLE_BINDINGS_JSON (secret อยู่ใน env ชื่อ clientSecretEnv) */
export function peopleBinding({ tenantId, issuer, node, extensions }) {
  return {
    tenantId,
    issuer,
    clientSecretEnv: `TENANT_PEOPLE_SECRET_${tenantId.replaceAll('-', '_').toUpperCase()}`,
    nodes: [{ ...node, extensions }],
  };
}

/** JSON ที่เรียง key — jsonb ของ PostgreSQL เรียง key ใหม่ จึงเทียบด้วยลำดับ key เดิมไม่ได้ */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** บรรทัด env ที่ทั้ง shell (`set -a; . file`) และ dotenv อ่านได้: single quote และ escape ' ภายใน */
export function envLine(name, value) {
  return `${name}='${String(value).replaceAll("'", "'\\''")}'`;
}

/** เทียบ policy เดิมกับที่ต้องการ — ต่างเฉพาะเมื่อ caps/pool/source ไม่ตรง (ไม่เทียบ approval) */
export function policyDiffers(current, desired) {
  const same = (left, right) => canonical(left) === canonical(right);
  return !(
    current.sourceKind === desired.sourceKind &&
    current.sourcePlanDigest === desired.sourcePlanDigest &&
    current.accountsLimit === desired.caps.accounts &&
    current.agentsLimit === desired.caps.agents &&
    current.voiceQueuesLimit === desired.caps.voiceQueues &&
    current.skillsLimit === desired.caps.skills &&
    same(current.extensionPool, desired.extensionPool) &&
    same(
      [...current.destinationPool].sort((a, b) => a.destinationId.localeCompare(b.destinationId)),
      [...desired.destinationPool].sort((a, b) => a.destinationId.localeCompare(b.destinationId)),
    )
  );
}

async function keycloakAdmin(baseUrl) {
  const response = await fetch(`${baseUrl}/realms/master/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? '',
      password: process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? '',
    }),
  });
  if (!response.ok) throw new Error(`Keycloak admin login ${response.status}`);
  const { access_token: token } = await response.json();
  return async (path, { method = 'GET', body } = {}) => {
    const result = await fetch(`${baseUrl}/admin/realms/dcontact${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!result.ok) throw new Error(`Keycloak ${method} ${path.split('?')[0]} ${result.status}`);
    return result.status === 204 || result.status === 201 ? null : result.json();
  };
}

const FORBIDDEN_SERVICE_ROLES = /^(?:admin|supervisor|agent|create-realm|platform_.*)$/;
const AUDIENCE_MAPPER = {
  name: 'people-audience',
  protocol: 'openid-connect',
  protocolMapper: 'oidc-audience-mapper',
  config: {
    'included.custom.audience': 'dc-tenant-people',
    'access.token.claim': 'true',
    'id.token.claim': 'false',
  },
};
const CLIENT_FLAGS = {
  enabled: true,
  publicClient: false,
  serviceAccountsEnabled: true,
  standardFlowEnabled: false,
  directAccessGrantsEnabled: false,
  implicitFlowEnabled: false,
  fullScopeAllowed: false,
};

/** attribute ที่ยังไม่เป็น single value + admin-only ตามที่ extension tenant-people ตรวจ (PeopleResource.authorize) */
export function profileChanges(profile) {
  return PEOPLE_PROFILE_ATTRIBUTES.filter((name) => {
    const field = profile.attributes.find((attribute) => attribute.name === name);
    return (
      !field ||
      field.multivalued ||
      JSON.stringify(field.permissions?.view) !== '["admin"]' ||
      JSON.stringify(field.permissions?.edit) !== '["admin"]'
    );
  });
}

/** คง displayName/validators/annotations เดิม แก้เฉพาะ multivalued และ permissions */
export function withPeopleProfile(profile, names) {
  const attributes = profile.attributes.map((attribute) =>
    names.includes(attribute.name)
      ? { ...attribute, multivalued: false, permissions: { view: ['admin'], edit: ['admin'] } }
      : attribute,
  );
  for (const name of names)
    if (!attributes.some((attribute) => attribute.name === name))
      attributes.push({
        name,
        multivalued: false,
        permissions: { view: ['admin'], edit: ['admin'] },
      });
  return { ...profile, attributes };
}

/** ส่วนของ client ที่ไม่ตรงสัญญา narrow service client (ADR-035) */
export function clientDrift(client, attributes) {
  const drift = Object.entries(attributes)
    .filter(([key, value]) => client.attributes?.[key] !== value)
    .map(([key]) => key);
  for (const [key, value] of Object.entries(CLIENT_FLAGS))
    if (client[key] !== value) drift.push(key);
  const audience = (client.protocolMappers ?? []).some(
    (mapper) =>
      mapper.protocolMapper === AUDIENCE_MAPPER.protocolMapper &&
      mapper.config?.['included.custom.audience'] === 'dc-tenant-people' &&
      mapper.config?.['access.token.claim'] === 'true',
  );
  if (!audience) drift.push('people-audience');
  return drift;
}

/** ตรวจ Keycloak แบบอ่านอย่างเดียวก่อนแตะฐานข้อมูล — ล้มที่นี่จะไม่มีอะไรถูกเขียน */
async function inspectKeycloak(kc, { tenant, tenantId }) {
  const profile = await kc('/users/profile');
  const organizations = [];
  for (const { id } of await kc(
    `/organizations?${new URLSearchParams({ q: `tenant_id:${tenantId}` })}`,
  ))
    organizations.push(await kc(`/organizations/${id}`));
  // extension ค้น Organization ด้วย tenant_id และต้องได้รายการเดียว (PeopleResource.authorize)
  const matches = organizations.filter(
    (organization) => organization.attributes?.tenant_id?.[0] === tenantId,
  );
  if (matches.length !== 1 || !matches[0].enabled || matches[0].alias !== tenant)
    throw new Error(
      'ต้องมี Organization ที่ enabled ผูก tenant_id นี้เพียงรายการเดียวและ alias ตรง slug',
    );
  const clientId = `dcontact-tenant-people-${tenantId}`;
  const attributes = {
    dc_service_purpose: 'TENANT_PEOPLE_V1',
    tenant_id: tenantId,
    tenant_slug: tenant,
    dc_organization_id: matches[0].id,
    dc_allowed_roles: 'AGENT,SUPERVISOR,ADMIN',
  };
  const [client] = await kc(`/clients?clientId=${encodeURIComponent(clientId)}`);
  if (client) {
    // สิทธิ์เกินของ service account ไม่แก้อัตโนมัติ — ให้ operator ตรวจที่มาก่อน
    const account = await kc(`/clients/${client.id}/service-account-user`);
    const realmRoles = await kc(`/users/${account.id}/role-mappings/realm/composite`);
    const mappings = await kc(`/users/${account.id}/role-mappings`);
    const forbidden = realmRoles
      .map((role) => role.name)
      .filter((name) => FORBIDDEN_SERVICE_ROLES.test(name));
    if (forbidden.length || mappings.clientMappings?.['realm-management'])
      throw new Error(
        `service account ของ ${clientId} มีสิทธิ์เกิน (${forbidden.join(', ') || 'realm-management'})`,
      );
  }
  return { profile, profileChanges: profileChanges(profile), clientId, client, attributes };
}

async function applyKeycloak(kc, inspected, { apply, log }) {
  const { profile, profileChanges: changes, clientId, attributes } = inspected;
  if (changes.length) {
    log(`keycloak.profile: เพิ่ม/แก้ attribute ${changes.join(', ')}`);
    if (apply)
      await kc('/users/profile', { method: 'PUT', body: withPeopleProfile(profile, changes) });
  } else log('keycloak.profile: ครบแล้ว');
  let { client } = inspected;
  if (!client) {
    log(`keycloak.client: สร้าง ${clientId}`);
    if (!apply) return { secret: null };
    await kc('/clients', {
      method: 'POST',
      body: { clientId, ...CLIENT_FLAGS, attributes, protocolMappers: [AUDIENCE_MAPPER] },
    });
    [client] = await kc(`/clients?clientId=${encodeURIComponent(clientId)}`);
  } else {
    const drift = clientDrift(client, attributes);
    if (drift.length) {
      log(`keycloak.client: แก้ ${clientId} (${drift.join(', ')})`);
      if (apply) {
        await kc(`/clients/${client.id}`, {
          method: 'PUT',
          body: { ...client, ...CLIENT_FLAGS, attributes: { ...client.attributes, ...attributes } },
        });
        if (drift.includes('people-audience'))
          await kc(`/clients/${client.id}/protocol-mappers/models`, {
            method: 'POST',
            body: AUDIENCE_MAPPER,
          });
      }
    } else log(`keycloak.client: ${clientId} ตรงแล้ว`);
  }
  const { value: secret } = await kc(`/clients/${client.id}/client-secret`);
  return { secret };
}

/** รวม extension เดิมกับใหม่ — ไม่เอาหมายเลขที่ Agent อาจใช้อยู่ออกจาก pool */
export function mergeExtensionPool(current, desired) {
  const seen = new Set(current.map((entry) => entry.ref));
  return [...current, ...desired.filter((entry) => !seen.has(entry.ref))];
}

/** SCRAM-SHA-256 verifier — ส่งให้ PostgreSQL แทนรหัสผ่านจริง จึงไม่มี plaintext ใน server log */
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** ใช้ host/port/database/parameter ของ URL operator เปลี่ยนเฉพาะผู้ใช้ รหัสผ่าน และ role ของ worker */
export function workerDatabaseUrl(operatorUrl, principal, password) {
  const url = new URL(operatorUrl);
  url.username = principal;
  url.password = password;
  if (!url.searchParams.has('schema')) url.searchParams.set('schema', 'public');
  url.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
  return url.toString();
}

/** เขียน env แบบรวมกับไฟล์เดิม (แทนเฉพาะ key ที่ตั้ง) และบังคับ mode 600 ทุกครั้ง */
export function mergeEnvFile(path, entries, header) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8').split('\n') : [header];
  const pending = new Map(entries);
  const lines = existing
    .filter((line, index, all) => line !== '' || index < all.length - 1)
    .map((line) => {
      const key = /^([A-Z0-9_]+)=/.exec(line)?.[1];
      if (!key || !pending.has(key)) return line;
      const value = pending.get(key);
      pending.delete(key);
      return envLine(key, value);
    });
  for (const [key, value] of pending) lines.push(envLine(key, value));
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

async function findTenant(db, slug) {
  const tenants = await db.$queryRaw`SELECT t.id::text AS id, t.lifecycle_status::text AS status,
      b.snapshot_digest AS "planDigest"
    FROM tenants t LEFT JOIN tenant_plan_bindings b ON b.tenant_id = t.id
    WHERE t.slug = ${slug}`;
  if (tenants.length !== 1) throw new Error('ไม่พบ tenant');
  if (tenants[0].status !== 'ACTIVE')
    throw new Error(`tenant ยังไม่ ACTIVE (${tenants[0].status})`);
  return tenants[0];
}

async function prepareDatabase(db, plan, tenant, { log, persistWorkerUrl }) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

    // เบอร์ปลายทางที่ operator reserve: inactive, managed v1, ชี้คิวที่มีอยู่แล้ว (Admin ผูกคิวจริงเองใน Console)
    let [destination] = await tx.$queryRaw`SELECT id::text AS id, voice_config_version AS version
      FROM voice_destinations WHERE tenant_id = ${tenant.id}::uuid AND destination = ${plan.destination}`;
    if (destination && destination.version !== 1)
      throw new Error('เบอร์ปลายทางนี้มีอยู่แล้วแต่ไม่ใช่ managed v1 — ไม่แก้ทับ');
    if (!destination) {
      const [placeholder] = await tx.$queryRaw`SELECT id::text AS id FROM queues
        WHERE tenant_id = ${tenant.id}::uuid ORDER BY created_at, id LIMIT 1`;
      if (!placeholder) throw new Error('tenant ยังไม่มีคิวจาก bootstrap ให้ใช้เป็นจุดผูกเริ่มต้น');
      log(`db.destination: reserve ${plan.destination} (inactive)`);
      if (plan.apply)
        [destination] = await tx.$queryRaw`INSERT INTO voice_destinations
            (id, tenant_id, destination, entry_mode, queue_id, is_active, voice_config_version,
             config_revision, updated_at)
          VALUES (gen_random_uuid(), ${tenant.id}::uuid, ${plan.destination}, 'DIRECT_QUEUE',
            ${placeholder.id}::uuid, false, 1, 1, now())
          RETURNING id::text AS id`;
      else destination = { id: '<ใหม่>' };
    } else log(`db.destination: ${plan.destination} มีอยู่แล้ว`);

    const desired = {
      sourceKind: tenant.planDigest ? 'PLAN_SNAPSHOT' : 'UAT_EXPLICIT',
      sourcePlanDigest: tenant.planDigest ?? null,
      caps: plan.caps,
      extensionPool: extensionPool(plan.extensions, plan.node),
      destinationPool: [
        { destinationId: destination.id, telephonyNodeId: plan.node.telephonyNodeId },
      ],
    };
    const [current] = await tx.$queryRaw`SELECT revision, source_kind AS "sourceKind",
        source_plan_digest AS "sourcePlanDigest", accounts_limit AS "accountsLimit",
        agents_limit AS "agentsLimit", voice_queues_limit AS "voiceQueuesLimit",
        skills_limit AS "skillsLimit", extension_pool AS "extensionPool",
        destination_pool AS "destinationPool"
      FROM tenant_voice_provisioning_policies WHERE tenant_id = ${tenant.id}::uuid`;
    if (current) {
      // pool เดิมคงไว้เสมอ — operator อาจ reserve หลายเบอร์ และ Agent อาจใช้ extension เดิมอยู่
      const others = current.destinationPool.filter(
        (item) => item.destinationId !== destination.id,
      );
      desired.destinationPool = [...others, ...desired.destinationPool];
      desired.extensionPool = mergeExtensionPool(current.extensionPool, desired.extensionPool);
    }
    if (!current || policyDiffers(current, desired)) {
      const revision = (current?.revision ?? 0) + 1;
      log(`db.policy: ${current ? 'แก้' : 'สร้าง'} revision ${revision} (${desired.sourceKind})`);
      if (plan.apply) {
        const values = [
          desired.sourceKind,
          desired.sourcePlanDigest,
          plan.caps.accounts,
          plan.caps.agents,
          plan.caps.voiceQueues,
          plan.caps.skills,
          plan.operatorSubject,
          plan.approvalRef,
          plan.reason,
          JSON.stringify(desired.extensionPool),
          JSON.stringify(desired.destinationPool),
        ];
        if (current)
          await tx.$executeRawUnsafe(
            `UPDATE tenant_voice_provisioning_policies SET revision = $12, source_kind = $1,
               source_plan_digest = $2, accounts_limit = $3, agents_limit = $4,
               voice_queues_limit = $5, skills_limit = $6, approved_by_operator_subject = $7,
               approved_at = now(), approval_ref = $8, reason = $9, extension_pool = $10::jsonb,
               destination_pool = $11::jsonb
             WHERE tenant_id = $13::uuid`,
            ...values,
            revision,
            tenant.id,
          );
        else
          await tx.$executeRawUnsafe(
            `INSERT INTO tenant_voice_provisioning_policies (tenant_id, revision, source_kind,
               source_plan_digest, accounts_limit, agents_limit, voice_queues_limit, skills_limit,
               approved_by_operator_subject, approved_at, approval_ref, reason, extension_pool,
               destination_pool)
             VALUES ($12::uuid, 1, $1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10::jsonb, $11::jsonb)`,
            ...values,
            tenant.id,
          );
      }
    } else log(`db.policy: revision ${current.revision} ตรงแล้ว`);

    // API มี TENANT_PEOPLE_WORKER_DATABASE_URL ได้ค่าเดียว และ RLS ผูกแถวกับ session_user —
    // ทุก tenant ใน deployment ต้องใช้ principal เดียวกัน
    const others = await tx.$queryRaw`SELECT DISTINCT database_principal::text AS principal
      FROM tenant_people_worker_bindings WHERE enabled AND database_principal <> ${plan.workerPrincipal}`;
    if (others.length)
      throw new Error(
        `deployment นี้ใช้ worker principal ${others.map((row) => row.principal).join(', ')} อยู่แล้ว — ใช้ --worker-principal เดิม`,
      );
    const [principal] = await tx.$queryRaw`SELECT r.rolcanlogin AS login, r.rolinherit AS inherit,
        r.rolbypassrls AS bypass, r.rolsuper AS super, r.rolcreaterole AS "createRole",
        r.rolcreatedb AS "createDb", r.rolreplication AS replication,
        pg_has_role(r.oid, 'dcontact_tenant_people_worker', 'MEMBER') AS member
      FROM pg_roles r WHERE r.rolname = ${plan.workerPrincipal}`;
    if (!principal) {
      if (!plan.createWorkerPrincipal)
        throw new Error('ไม่มี worker principal นี้ — ใส่ --create-worker-principal เพื่อสร้าง');
      log(`db.worker: สร้าง login role ${plan.workerPrincipal}`);
    } else if (
      !principal.login ||
      principal.inherit ||
      principal.bypass ||
      principal.super ||
      principal.createRole ||
      principal.createDb ||
      principal.replication ||
      !principal.member
    )
      throw new Error(
        'worker principal ต้องเป็น LOGIN NOINHERIT NOBYPASSRLS ที่ไม่มีสิทธิ์ superuser/createrole/createdb/replication และเป็นสมาชิก dcontact_tenant_people_worker',
      );
    else if (plan.rotateWorkerPassword)
      log(`db.worker: เปลี่ยนรหัสผ่านของ ${plan.workerPrincipal}`);
    if (plan.apply && (!principal || plan.rotateWorkerPassword)) {
      const password = randomBytes(24).toString('base64url');
      // เก็บรหัสผ่านลงไฟล์ก่อน commit: ถ้าล้มหลังจากนี้ role ยังไม่เกิด และรอบถัดไปออกรหัสใหม่
      persistWorkerUrl(workerDatabaseUrl(process.env.DATABASE_URL, plan.workerPrincipal, password));
      const verifier = scramVerifier(password);
      await tx.$executeRawUnsafe(
        principal
          ? `ALTER ROLE "${plan.workerPrincipal}" PASSWORD '${verifier}'`
          : `CREATE ROLE "${plan.workerPrincipal}" LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}'`,
      );
      if (!principal)
        await tx.$executeRawUnsafe(
          `GRANT dcontact_tenant_people_worker TO "${plan.workerPrincipal}"`,
        );
    }
    const [binding] = await tx.$queryRaw`SELECT enabled FROM tenant_people_worker_bindings
      WHERE tenant_id = ${tenant.id}::uuid AND database_principal = ${plan.workerPrincipal}`;
    if (binding && !binding.enabled)
      throw new Error('worker binding ถูกปิดไว้ — ไม่เปิดคืนอัตโนมัติ');
    if (!binding) {
      log('db.worker: ผูก worker principal กับ tenant');
      if (plan.apply)
        await tx.$executeRaw`INSERT INTO tenant_people_worker_bindings
            (tenant_id, database_principal, approval_ref)
          VALUES (${tenant.id}::uuid, ${plan.workerPrincipal}, ${plan.approvalRef})`;
    } else log('db.worker: ผูกแล้ว');
    return { destinationId: destination.id };
  });
}

async function main() {
  const plan = parseArguments(process.argv.slice(2));
  const log = (line) => process.stdout.write(`${plan.apply ? '' : '[dry-run] '}${line}\n`);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('ต้องตั้ง DATABASE_URL ของบัญชี operator');
  const require = createRequire(resolve('apps/api/package.json'));
  const { PrismaClient } = require('@d-contact/db');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const header = `# สร้างโดย scripts/tenant-voice-onboarding.mjs (#977) — รวม TENANT_PEOPLE_BINDING_* เข้า array ของ TENANT_PEOPLE_BINDINGS_JSON`;
  const persist = (entries) => {
    mergeEnvFile(plan.envOut, entries, header);
    log(`env: เขียน ${entries.map(([key]) => key).join(', ')} ลง ${plan.envOut} (mode 600)`);
  };
  try {
    const tenant = await findTenant(db, plan.tenant);
    const keycloakUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
    const kc = await keycloakAdmin(keycloakUrl);
    // ตรวจ Keycloak ให้ผ่านก่อนเขียนฐาน — Organization ผิดตัวหรือ service account สิทธิ์เกินจะหยุดที่นี่
    const inspected = await inspectKeycloak(kc, { tenant: plan.tenant, tenantId: tenant.id });
    await prepareDatabase(db, plan, tenant, {
      log,
      persistWorkerUrl: (url) => persist([['TENANT_PEOPLE_WORKER_DATABASE_URL', url]]),
    });
    const identity = await applyKeycloak(kc, inspected, { apply: plan.apply, log });
    // People runtime รับเฉพาะ https หรือ http://127.0.0.1 (tenant-people-keycloak.ts) — dev ใช้ 127.0.0.1
    const issuer =
      plan.issuer ?? `${keycloakUrl.replace('//localhost:', '//127.0.0.1:')}/realms/dcontact`;
    const binding = peopleBinding({
      tenantId: tenant.id,
      issuer,
      node: plan.node,
      extensions: plan.extensions,
    });
    log(`env: เพิ่ม ${JSON.stringify(binding)} ใน TENANT_PEOPLE_BINDINGS_JSON`);
    log(`env: ตั้ง ${binding.clientSecretEnv} และ restart API (ค่าอ่านตอน start)`);
    if (plan.apply)
      persist([
        [
          `TENANT_PEOPLE_BINDING_${plan.tenant.replaceAll('-', '_').toUpperCase()}`,
          JSON.stringify(binding),
        ],
        ...(identity.secret ? [[binding.clientSecretEnv, identity.secret]] : []),
      ]);
    log(plan.apply ? 'TENANT_VOICE_ONBOARDING_APPLIED' : 'TENANT_VOICE_ONBOARDING_PLAN_ONLY');
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
