import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
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
  [--create-worker-principal] [--env-out <ไฟล์>] [--apply]`;

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
    if (['apply', 'create-worker-principal'].includes(name)) flags[name] = true;
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
    issuer: typeof flags.issuer === 'string' ? flags.issuer : null,
    envOut: flags['env-out'] ?? null,
    apply: flags.apply === true,
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

async function prepareKeycloak(kc, { tenant, tenantId, apply, log }) {
  const profile = await kc('/users/profile');
  const missing = PEOPLE_PROFILE_ATTRIBUTES.filter((name) => {
    const field = profile.attributes.find((attribute) => attribute.name === name);
    return (
      !field ||
      field.multivalued ||
      JSON.stringify(field.permissions?.view) !== '["admin"]' ||
      JSON.stringify(field.permissions?.edit) !== '["admin"]'
    );
  });
  if (missing.length) {
    log(`keycloak.profile: เพิ่ม/แก้ attribute ${missing.join(', ')}`);
    if (apply) {
      profile.attributes = profile.attributes.filter(
        (attribute) => !missing.includes(attribute.name),
      );
      for (const name of missing)
        profile.attributes.push({
          name,
          multivalued: false,
          permissions: { view: ['admin'], edit: ['admin'] },
        });
      await kc('/users/profile', { method: 'PUT', body: profile });
    }
  } else log('keycloak.profile: ครบแล้ว');

  const organizations = await kc(`/organizations?search=${encodeURIComponent(tenant)}&exact=true`);
  const candidates = [];
  for (const organization of organizations)
    candidates.push(await kc(`/organizations/${organization.id}`));
  const organization = candidates.filter(
    (candidate) => candidate.alias === tenant && candidate.attributes?.tenant_id?.[0] === tenantId,
  );
  if (organization.length !== 1 || !organization[0].enabled)
    throw new Error('ไม่พบ Organization ที่ enabled และผูก tenant_id นี้แบบเดียว');

  const clientId = `dcontact-tenant-people-${tenantId}`;
  const attributes = {
    dc_service_purpose: 'TENANT_PEOPLE_V1',
    tenant_id: tenantId,
    tenant_slug: tenant,
    dc_organization_id: organization[0].id,
    dc_allowed_roles: 'AGENT,SUPERVISOR,ADMIN',
  };
  let [client] = await kc(`/clients?clientId=${encodeURIComponent(clientId)}`);
  if (!client) {
    log(`keycloak.client: สร้าง ${clientId}`);
    if (!apply) return { clientId, secret: null };
    await kc('/clients', {
      method: 'POST',
      body: {
        clientId,
        enabled: true,
        publicClient: false,
        serviceAccountsEnabled: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: false,
        implicitFlowEnabled: false,
        fullScopeAllowed: false,
        attributes,
        protocolMappers: [
          {
            name: 'people-audience',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-audience-mapper',
            config: {
              'included.custom.audience': 'dc-tenant-people',
              'access.token.claim': 'true',
              'id.token.claim': 'false',
            },
          },
        ],
      },
    });
    [client] = await kc(`/clients?clientId=${encodeURIComponent(clientId)}`);
  } else {
    const drift = Object.entries(attributes).filter(
      ([key, value]) => client.attributes?.[key] !== value,
    );
    if (
      drift.length ||
      client.publicClient ||
      !client.serviceAccountsEnabled ||
      client.fullScopeAllowed
    ) {
      log(`keycloak.client: แก้ ${clientId} (${drift.map(([key]) => key).join(', ') || 'flags'})`);
      if (apply)
        await kc(`/clients/${client.id}`, {
          method: 'PUT',
          body: {
            ...client,
            publicClient: false,
            serviceAccountsEnabled: true,
            fullScopeAllowed: false,
            attributes: { ...client.attributes, ...attributes },
          },
        });
    } else log(`keycloak.client: ${clientId} ตรงแล้ว`);
  }
  const { value: secret } = await kc(`/clients/${client.id}/client-secret`);
  return { clientId, secret };
}

async function prepareDatabase(db, plan, log) {
  return db.$transaction(async (tx) => {
    const tenants = await tx.$queryRaw`SELECT t.id::text AS id, t.lifecycle_status::text AS status,
        b.snapshot_digest AS "planDigest"
      FROM tenants t LEFT JOIN tenant_plan_bindings b ON b.tenant_id = t.id
      WHERE t.slug = ${plan.tenant}`;
    if (tenants.length !== 1) throw new Error('ไม่พบ tenant');
    const [tenant] = tenants;
    if (tenant.status !== 'ACTIVE') throw new Error(`tenant ยังไม่ ACTIVE (${tenant.status})`);
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
      // เก็บ destination อื่นใน pool เดิมไว้ — operator อาจ reserve ไว้หลายเบอร์
      const others = current.destinationPool.filter(
        (item) => item.destinationId !== destination.id,
      );
      desired.destinationPool = [...others, ...desired.destinationPool];
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

    const [principal] = await tx.$queryRaw`SELECT r.rolcanlogin AS login, r.rolinherit AS inherit,
        r.rolbypassrls AS bypass, r.rolsuper AS super,
        pg_has_role(r.oid, 'dcontact_tenant_people_worker', 'MEMBER') AS member
      FROM pg_roles r WHERE r.rolname = ${plan.workerPrincipal}`;
    let workerPassword = null;
    if (!principal) {
      if (!plan.createWorkerPrincipal)
        throw new Error('ไม่มี worker principal นี้ — ใส่ --create-worker-principal เพื่อสร้าง');
      log(`db.worker: สร้าง login role ${plan.workerPrincipal}`);
      if (plan.apply) {
        workerPassword = randomBytes(24).toString('base64url');
        await tx.$executeRawUnsafe(
          `CREATE ROLE "${plan.workerPrincipal}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${workerPassword}'`,
        );
        await tx.$executeRawUnsafe(
          `GRANT dcontact_tenant_people_worker TO "${plan.workerPrincipal}"`,
        );
      }
    } else if (
      !principal.login ||
      principal.inherit ||
      principal.bypass ||
      principal.super ||
      !principal.member
    )
      throw new Error(
        'worker principal ต้องเป็น LOGIN NOINHERIT NOBYPASSRLS ที่เป็นสมาชิก dcontact_tenant_people_worker',
      );
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
    return { tenantId: tenant.id, destinationId: destination.id, workerPassword };
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
  try {
    const database = await prepareDatabase(db, plan, log);
    const keycloakUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
    // People runtime รับเฉพาะ https หรือ http://127.0.0.1 (tenant-people-keycloak.ts) — dev ใช้ 127.0.0.1
    const issuer =
      plan.issuer ?? `${keycloakUrl.replace('//localhost:', '//127.0.0.1:')}/realms/dcontact`;
    const identity = await prepareKeycloak(await keycloakAdmin(keycloakUrl), {
      tenant: plan.tenant,
      tenantId: database.tenantId,
      apply: plan.apply,
      log,
    });
    const binding = peopleBinding({
      tenantId: database.tenantId,
      issuer,
      node: plan.node,
      extensions: plan.extensions,
    });
    log(`env: เพิ่ม ${JSON.stringify(binding)} ใน TENANT_PEOPLE_BINDINGS_JSON`);
    log(`env: ตั้ง ${binding.clientSecretEnv} และ restart API (ค่าอ่านตอน start)`);
    if (plan.apply && plan.envOut) {
      const workerUrl = database.workerPassword
        ? (() => {
            const url = new URL(databaseUrl);
            url.username = plan.workerPrincipal;
            url.password = database.workerPassword;
            url.search = '';
            url.searchParams.set('schema', 'public');
            url.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
            return url.toString();
          })()
        : null;
      const lines = [
        `# tenant ${plan.tenant} — สร้างโดย scripts/tenant-voice-onboarding.mjs (#977)`,
        `# รวมค่า binding เข้า array ของ TENANT_PEOPLE_BINDINGS_JSON (หนึ่งรายการต่อ tenant)`,
        envLine(
          `TENANT_PEOPLE_BINDING_${plan.tenant.replaceAll('-', '_').toUpperCase()}`,
          JSON.stringify(binding),
        ),
        ...(identity.secret ? [envLine(binding.clientSecretEnv, identity.secret)] : []),
        ...(workerUrl ? [envLine('TENANT_PEOPLE_WORKER_DATABASE_URL', workerUrl)] : []),
        '',
      ];
      writeFileSync(plan.envOut, lines.join('\n'), { mode: 0o600 });
      log(`env: เขียน secret ลง ${plan.envOut} (mode 600)`);
    }
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
