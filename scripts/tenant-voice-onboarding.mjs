import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * #977: the operator work that must be done before the Admin of a new tenant (created through Platform provisioning) can invite Agents,
 * set up queues and bind destination numbers through the Console - it bundles the steps that previously had to be hand-written SQL/Keycloak per
 * docs/voice/catalog-v1.md, docs/tenant-voice-configuration.md and docs/tenant-people-invitations.md
 *
 * - Keycloak: the user profile attributes the tenant-people extension checks (admin-only, single value) and
 *   the service client `dcontact-tenant-people-<tenantId>` bound to the Organization of the tenant
 * - DB (operator/owner account): the first TenantVoiceProvisioningPolicy revision (PLAN_SNAPSHOT matching the plan binding,
 *   all 4 caps specified explicitly, not guessed from entitlements), the extension pool, a destination number reserved as inactive, and
 *   tenant_people_worker_bindings
 * - does not create queues/skills/users in place of the Admin, does not enable the destination number, and does not write per-person identity bindings
 * - the default is dry-run: it checks and prints the plan only; `--apply` is needed to really write; it can be re-run (items already matching are skipped)
 * - secrets never go to stdout: they are written to the `--env-out` file (mode 600) as the env values the API needs
 *
 * run: DATABASE_URL=<operator> KEYCLOAK_ADMIN_URL=... KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME/PASSWORD=...
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

const usage = `usage: node scripts/tenant-voice-onboarding.mjs --tenant <slug>
  --approval-ref <ref> --operator-subject <subject> --reason <text>
  --accounts <n> --agents <n> --voice-queues <n> --skills <n>
  --node <telephonyNodeId> --release-digest <sha256> --dialplan-digest <sha256>
  --extensions <1000-1009|1000,1001> --destination <number> --worker-principal <role>
  [--create-worker-principal | --rotate-worker-password] [--issuer <url> [--backchannel-url <url>]]
  [--apply --env-out <file>]`;

function integerFlag(value, name) {
  if (!/^\d{1,7}$/.test(value ?? '') || Number(value) > 1_000_000)
    throw new Error(`${name} must be an integer 0–1,000,000`);
  return Number(value);
}

/** Convert `1000-1009` or `1000,1001` into a list of 4-6 digit extensions (no duplicates, in the order given) */
export function parseExtensions(raw) {
  const refs = [];
  for (const part of String(raw ?? '').split(',')) {
    const range = /^(\d{4,6})-(\d{4,6})$/.exec(part.trim());
    if (range) {
      const [from, to] = [Number(range[1]), Number(range[2])];
      if (range[1].length !== range[2].length || to < from || to - from >= 1000)
        throw new Error('invalid extension range');
      for (let value = from; value <= to; value++)
        refs.push(String(value).padStart(range[1].length, '0'));
    } else if (/^\d{4,6}$/.test(part.trim())) refs.push(part.trim());
    else throw new Error('extension must be a 4-6 digit number');
  }
  if (!refs.length || new Set(refs).size !== refs.length)
    throw new Error('extension list is empty or has duplicates');
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
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`--${name} is required\n${usage}`);
    return value.trim();
  };
  const tenant = required('tenant');
  if (!SLUG.test(tenant)) throw new Error('--tenant must be a tenant slug');
  const node = required('node');
  if (!NODE_ID.test(node)) throw new Error('--node is invalid');
  const releaseDigest = required('release-digest');
  const dialplanDigest = required('dialplan-digest');
  if (!DIGEST.test(releaseDigest) || !DIGEST.test(dialplanDigest))
    throw new Error('digest must be 64 lowercase sha256 hex characters');
  const destination = required('destination');
  if (!/^[0-9]{3,15}$/.test(destination))
    throw new Error('--destination must be a 3-15 digit number');
  const workerPrincipal = required('worker-principal');
  if (!PRINCIPAL.test(workerPrincipal))
    throw new Error('--worker-principal is not a usable role name');
  const text = (name, max) => {
    const value = required(name);
    if (value.length > max) throw new Error(`--${name} is longer than ${max} characters`);
    return value;
  };
  const apply = flags.apply === true;
  for (const name of ['issuer', 'backchannel-url', 'env-out'])
    if (name in flags && (typeof flags[name] !== 'string' || !flags[name].trim()))
      throw new Error(`--${name} must have a value`);
  if (flags['backchannel-url'] !== undefined) {
    // must match the form the API accepts (tenant-people-backchannel.ts), otherwise the API will not start after the env has been written
    if (flags.issuer === undefined)
      throw new Error('--backchannel-url must be used together with --issuer');
    const issuer = new URL(flags.issuer);
    const realmPath = issuer.pathname.replace(/\/$/, '');
    if (
      issuer.protocol !== 'https:' ||
      !/^\/(?:auth\/)?realms\/[A-Za-z0-9._-]+$/.test(realmPath) ||
      flags['backchannel-url'] !== `http://keycloak:8080${realmPath}`
    )
      throw new Error(
        '--issuer must be https and --backchannel-url must be http://keycloak:8080<realm path>',
      );
  }
  // secrets (the client secret and the worker password) have only one way out of the script: this file
  if (apply && (typeof flags['env-out'] !== 'string' || !flags['env-out'].trim()))
    throw new Error('--apply must be used together with --env-out to store the secrets');
  if (flags['create-worker-principal'] && flags['rotate-worker-password'])
    throw new Error(
      'choose either --create-worker-principal or --rotate-worker-password, not both',
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
    backchannelUrl: typeof flags['backchannel-url'] === 'string' ? flags['backchannel-url'] : null,
    envOut: flags['env-out'] ?? null,
    apply,
  };
}

/** The pool in the shape the API `extensionPermit` accepts (exactly all 4 keys) */
export function extensionPool(extensions, node) {
  return extensions.map((ref) => ({
    ref,
    telephonyNodeId: node.telephonyNodeId,
    releaseDigest: node.releaseDigest,
    dialplanDigest: node.dialplanDigest,
  }));
}

/** The binding entry of the tenant in TENANT_PEOPLE_BINDINGS_JSON (the secret is in the env named by clientSecretEnv) */
export function peopleBinding({ tenantId, issuer, node, extensions, backchannelUrl = null }) {
  return {
    tenantId,
    issuer,
    // for a deployment whose issuer is an external domain (e.g. Solo), have the API call Keycloak on the internal network (tenant-people-backchannel.ts)
    ...(backchannelUrl ? { backchannelUrl } : {}),
    clientSecretEnv: `TENANT_PEOPLE_SECRET_${tenantId.replaceAll('-', '_').toUpperCase()}`,
    nodes: [{ ...node, extensions }],
  };
}

/** JSON with sorted keys - PostgreSQL jsonb reorders keys, so comparing by the original key order does not work */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

/** An env line that both the shell (`set -a; . file`) and dotenv can read: single quotes, with an inner ' escaped */
export function envLine(name, value) {
  return `${name}='${String(value).replaceAll("'", "'\\''")}'`;
}

/** Compare the existing policy with the desired one - they differ only when caps/pool/source do not match (approval is not compared) */
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

/** An attribute that is not yet single value + admin-only as the tenant-people extension checks (PeopleResource.authorize) */
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

/** Keep the existing displayName/validators/annotations and change only multivalued and permissions */
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

/** The parts of the client that do not match the narrow service client contract (ADR-035) */
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

/** Read-only Keycloak check before touching the database - if it fails here nothing is written */
async function inspectKeycloak(kc, { tenant, tenantId }) {
  const profile = await kc('/users/profile');
  const organizations = [];
  for (const { id } of await kc(
    `/organizations?${new URLSearchParams({ q: `tenant_id:${tenantId}` })}`,
  ))
    organizations.push(await kc(`/organizations/${id}`));
  // the extension looks up the Organization by tenant_id and must get exactly one (PeopleResource.authorize)
  const matches = organizations.filter(
    (organization) => organization.attributes?.tenant_id?.[0] === tenantId,
  );
  if (matches.length !== 1 || !matches[0].enabled || matches[0].alias !== tenant)
    throw new Error(
      'there must be exactly one enabled Organization bound to this tenant_id and its alias must match the slug',
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
    // excess privileges of the service account are not fixed automatically - have the operator check where they came from
    const account = await kc(`/clients/${client.id}/service-account-user`);
    const realmRoles = await kc(`/users/${account.id}/role-mappings/realm/composite`);
    const mappings = await kc(`/users/${account.id}/role-mappings`);
    const forbidden = realmRoles
      .map((role) => role.name)
      .filter((name) => FORBIDDEN_SERVICE_ROLES.test(name));
    if (forbidden.length || mappings.clientMappings?.['realm-management'])
      throw new Error(
        `service account of ${clientId} has excess privileges (${forbidden.join(', ') || 'realm-management'})`,
      );
  }
  return { profile, profileChanges: profileChanges(profile), clientId, client, attributes };
}

async function applyKeycloak(kc, inspected, { apply, log }) {
  const { profile, profileChanges: changes, clientId, attributes } = inspected;
  if (changes.length) {
    log(`keycloak.profile: adding/fixing attributes ${changes.join(', ')}`);
    if (apply)
      await kc('/users/profile', { method: 'PUT', body: withPeopleProfile(profile, changes) });
  } else log('keycloak.profile: already complete');
  let { client } = inspected;
  if (!client) {
    log(`keycloak.client: creating ${clientId}`);
    if (!apply) return { secret: null };
    await kc('/clients', {
      method: 'POST',
      body: { clientId, ...CLIENT_FLAGS, attributes, protocolMappers: [AUDIENCE_MAPPER] },
    });
    [client] = await kc(`/clients?clientId=${encodeURIComponent(clientId)}`);
  } else {
    const drift = clientDrift(client, attributes);
    if (drift.length) {
      log(`keycloak.client: fixing ${clientId} (${drift.join(', ')})`);
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
    } else log(`keycloak.client: ${clientId} already matches`);
  }
  const { value: secret } = await kc(`/clients/${client.id}/client-secret`);
  return { secret };
}

/** Merge the existing and new extensions - do not remove from the pool a number an Agent may be using */
export function mergeExtensionPool(current, desired) {
  const seen = new Set(current.map((entry) => entry.ref));
  return [...current, ...desired.filter((entry) => !seen.has(entry.ref))];
}

/** SCRAM-SHA-256 verifier - passed to PostgreSQL in place of the real password, so there is no plaintext in the server log */
export function scramVerifier(password, salt = randomBytes(16), iterations = 4096) {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (key, text) => createHmac('sha256', key).update(text).digest();
  const storedKey = createHash('sha256').update(hmac(salted, 'Client Key')).digest();
  const serverKey = hmac(salted, 'Server Key');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

/** Use the host/port/database/parameters of the operator URL, changing only the user, password and worker role */
export function workerDatabaseUrl(operatorUrl, principal, password) {
  const url = new URL(operatorUrl);
  url.username = principal;
  url.password = password;
  if (!url.searchParams.has('schema')) url.searchParams.set('schema', 'public');
  url.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
  return url.toString();
}

/** Write the env merged with the existing file (replacing only the keys that are set) and force mode 600 every time */
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
  if (tenants.length !== 1) throw new Error('tenant not found');
  if (tenants[0].status !== 'ACTIVE')
    throw new Error(`tenant is not ACTIVE yet (${tenants[0].status})`);
  return tenants[0];
}

async function prepareDatabase(db, plan, tenant, { log, persistWorkerUrl }) {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenant.id}, true)`;

    // the destination number the operator reserves: inactive, managed v1, pointing at an existing queue (the Admin binds the real queue in the Console)
    let [destination] = await tx.$queryRaw`SELECT id::text AS id, voice_config_version AS version
      FROM voice_destinations WHERE tenant_id = ${tenant.id}::uuid AND destination = ${plan.destination}`;
    if (destination && destination.version !== 1)
      throw new Error(
        'this destination number already exists but is not managed v1 - not overwriting',
      );
    if (!destination) {
      const [placeholder] = await tx.$queryRaw`SELECT id::text AS id FROM queues
        WHERE tenant_id = ${tenant.id}::uuid ORDER BY created_at, id LIMIT 1`;
      if (!placeholder)
        throw new Error(
          'the tenant has no queue from bootstrap to use as the initial binding point',
        );
      log(`db.destination: reserve ${plan.destination} (inactive)`);
      if (plan.apply)
        [destination] = await tx.$queryRaw`INSERT INTO voice_destinations
            (id, tenant_id, destination, entry_mode, queue_id, is_active, voice_config_version,
             config_revision, updated_at)
          VALUES (gen_random_uuid(), ${tenant.id}::uuid, ${plan.destination}, 'DIRECT_QUEUE',
            ${placeholder.id}::uuid, false, 1, 1, now())
          RETURNING id::text AS id`;
      else destination = { id: '<new>' };
    } else log(`db.destination: ${plan.destination} already exists`);

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
      // always keep the existing pool - the operator may reserve several numbers, and an Agent may be using an existing extension
      const others = current.destinationPool.filter(
        (item) => item.destinationId !== destination.id,
      );
      desired.destinationPool = [...others, ...desired.destinationPool];
      desired.extensionPool = mergeExtensionPool(current.extensionPool, desired.extensionPool);
    }
    if (!current || policyDiffers(current, desired)) {
      const revision = (current?.revision ?? 0) + 1;
      log(
        `db.policy: ${current ? 'fixing' : 'creating'} revision ${revision} (${desired.sourceKind})`,
      );
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
    } else log(`db.policy: revision ${current.revision} already matches`);

    // the API can have only one TENANT_PEOPLE_WORKER_DATABASE_URL value, and RLS binds rows to session_user -
    // every tenant in a deployment must use the same principal
    const others = await tx.$queryRaw`SELECT DISTINCT database_principal::text AS principal
      FROM tenant_people_worker_bindings WHERE enabled AND database_principal <> ${plan.workerPrincipal}`;
    if (others.length)
      throw new Error(
        `this deployment already uses worker principal ${others.map((row) => row.principal).join(', ')} - use the same --worker-principal`,
      );
    const [principal] = await tx.$queryRaw`SELECT r.rolcanlogin AS login, r.rolinherit AS inherit,
        r.rolbypassrls AS bypass, r.rolsuper AS super, r.rolcreaterole AS "createRole",
        r.rolcreatedb AS "createDb", r.rolreplication AS replication,
        pg_has_role(r.oid, 'dcontact_tenant_people_worker', 'MEMBER') AS member
      FROM pg_roles r WHERE r.rolname = ${plan.workerPrincipal}`;
    if (!principal) {
      if (!plan.createWorkerPrincipal)
        throw new Error(
          'this worker principal does not exist - pass --create-worker-principal to create it',
        );
      log(`db.worker: creating login role ${plan.workerPrincipal}`);
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
        'the worker principal must be LOGIN NOINHERIT NOBYPASSRLS with no superuser/createrole/createdb/replication privilege and be a member of dcontact_tenant_people_worker',
      );
    else if (plan.rotateWorkerPassword)
      log(`db.worker: changing the password of ${plan.workerPrincipal}`);
    if (plan.apply && (!principal || plan.rotateWorkerPassword)) {
      const password = randomBytes(24).toString('base64url');
      // write the password to the file before commit: if it fails after this the role does not exist yet, and the next round issues a new password
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
      throw new Error('the worker binding was disabled - not re-enabling it automatically');
    if (!binding) {
      log('db.worker: binding the worker principal to the tenant');
      if (plan.apply)
        await tx.$executeRaw`INSERT INTO tenant_people_worker_bindings
            (tenant_id, database_principal, approval_ref)
          VALUES (${tenant.id}::uuid, ${plan.workerPrincipal}, ${plan.approvalRef})`;
    } else log('db.worker: already bound');
    return { destinationId: destination.id };
  });
}

async function main() {
  const plan = parseArguments(process.argv.slice(2));
  const log = (line) => process.stdout.write(`${plan.apply ? '' : '[dry-run] '}${line}\n`);
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL of the operator account must be set');
  const require = createRequire(resolve('apps/api/package.json'));
  const { PrismaClient } = require('@d-contact/db');
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  const header = `# generated by scripts/tenant-voice-onboarding.mjs (#977) - merges TENANT_PEOPLE_BINDING_* into the TENANT_PEOPLE_BINDINGS_JSON array`;
  const persist = (entries) => {
    mergeEnvFile(plan.envOut, entries, header);
    log(`env: writing ${entries.map(([key]) => key).join(', ')} to ${plan.envOut} (mode 600)`);
  };
  try {
    const tenant = await findTenant(db, plan.tenant);
    const keycloakUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
    const kc = await keycloakAdmin(keycloakUrl);
    // make the Keycloak check pass before writing the database - a wrong Organization or a service account with excess privileges stops here
    const inspected = await inspectKeycloak(kc, { tenant: plan.tenant, tenantId: tenant.id });
    await prepareDatabase(db, plan, tenant, {
      log,
      persistWorkerUrl: (url) => persist([['TENANT_PEOPLE_WORKER_DATABASE_URL', url]]),
    });
    const identity = await applyKeycloak(kc, inspected, { apply: plan.apply, log });
    // the People runtime accepts only https or http://127.0.0.1 (tenant-people-keycloak.ts) - dev uses 127.0.0.1
    const issuer =
      plan.issuer ?? `${keycloakUrl.replace('//localhost:', '//127.0.0.1:')}/realms/dcontact`;
    const binding = peopleBinding({
      tenantId: tenant.id,
      issuer,
      node: plan.node,
      extensions: plan.extensions,
      backchannelUrl: plan.backchannelUrl,
    });
    log(`env: adding ${JSON.stringify(binding)} to TENANT_PEOPLE_BINDINGS_JSON`);
    log(`env: set ${binding.clientSecretEnv} and restart the API (the value is read at start)`);
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
