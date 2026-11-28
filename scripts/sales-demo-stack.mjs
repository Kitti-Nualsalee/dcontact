/**
 * A stack for the Demo to the sales team: API + Router + Telephony + Workspace (5173) + Console (5174) on the dev compose
 *
 * - uses a separate DB `dcontact_demo` (does not touch `dcontact`); data persists between rehearsals; `--reset` recreates the whole database
 * - does not edit users in Keycloak: the demo tenant, admin and agent use the ids Keycloak already issues in its claims
 *   (`pnpm infra:identity:link` must have been run before), adding only the Console redirect on the `agent-desktop` client
 * - the Admin can create/import customers once the platform operator grants `CONTACT_CREATE` (Cus360 E1 D); this stack creates
 *   the realm role `platform-operator` and the user `operator@demo.local` in the dev Keycloak (a password randomized every run,
 *   never displayed) and then grants the permission through the real operator API, never writing the grant table directly
 * - the Owner approved on 19 Nov 2026: seed the `Customer Care` team and the identity binding of the demo users directly into this database
 *   (see `seedDemoAccess`), so the results of this stack are not acceptance evidence of identity/authorization
 * - `pnpm infra:up` must be run first, and ports 3000/5173/5174 must be free
 *
 * run: node scripts/sales-demo-stack.mjs [--reset]   stop with Ctrl-C
 * env: SALES_DEMO_DATABASE (default `dcontact_demo`) uses another database for a trial that must not share data,
 *      DCONTACT_DEV_POSTGRES_PORT (default 5433) when the dev PostgreSQL is published on another host port
 * Journey (#1067): JOURNEY=on starts the Journey and Cases workers, turns on the outcome events of the API and the
 *      authoring flags, and seeds the authoring permissions of the demo users (see `seedJourneyTrial`)
 * D-Phone: set SALES_DEMO_DPHONE_EXTENSION_ID to use the Chrome extension instead of the built-in browser phone
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { stopChild } from './child-process-lifecycle.mjs';

const compose = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];
const database = process.env.SALES_DEMO_DATABASE ?? 'dcontact_demo';
// the name is written into SQL statements below, so it must be a plain identifier
if (!/^[a-z][a-z0-9_]{0,62}$/.test(database))
  throw new Error('SALES_DEMO_DATABASE must be a lowercase identifier');
const databasePort = process.env.DCONTACT_DEV_POSTGRES_PORT ?? '5433';
if (!/^[0-9]{2,5}$/.test(databasePort))
  throw new Error('DCONTACT_DEV_POSTGRES_PORT must be a port number');
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
  DATABASE_URL: `postgresql://dcontact:dcontact@localhost:${databasePort}/${database}?schema=public`,
  APPLICATION_DATABASE_URL: `postgresql://dcontact_app:dcontact_app@localhost:${databasePort}/${database}?schema=public`,
  PLATFORM_DATABASE_URL: `postgresql://dcontact_platform:dcontact_platform@localhost:${databasePort}/${database}?schema=public`,
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
  // #1054 LINE chat on the dev stack talks to the LINE simulator, never to LINE; the channel secrets
  // are sealed with a dev-only key unless one is given
  ...(process.env.LINE_CHAT === 'on'
    ? {
        LINE_API_BASE_URL: process.env.LINE_API_BASE_URL ?? 'http://127.0.0.1:8890',
        ACCOUNT_SECRET_KEY:
          process.env.ACCOUNT_SECRET_KEY ?? Buffer.alloc(32, 7).toString('base64'),
      }
    : {}),
  ...(extensionId
    ? { VITE_SOFTPHONE_CONTROL: 'chrome-extension', VITE_D_PHONE_EXTENSION_ID: extensionId }
    : {}),
  // #1067 Journey trial: the API emits outcome facts and serves authoring; the workers use their own consumer groups
  // so they never share offsets with another stack on the same broker
  ...(process.env.JOURNEY === 'on'
    ? {
        INTERACTION_OUTCOME_EVENTS: 'on',
        J5_CANVAS_WRITE_ENABLED: 'true',
        J5_PUBLISH_UI_ENABLED: 'true',
        JOURNEY_CONSUMER_GROUP_ID: 'dcontact-journey-events-sales-demo',
        JOURNEY_OUTCOME_CONSUMER_GROUP_ID: 'dcontact-journey-outcomes-sales-demo',
        JOURNEY_OWNER_RESULT_CONSUMER_GROUP_ID: 'dcontact-journey-owner-results-sales-demo',
        JOURNEY_GOVERNANCE_CONSUMER_GROUP_ID: 'dcontact-journey-cg3-sales-demo',
        CASES_OWNER_COMMAND_CONSUMER_GROUP_ID: 'dcontact-cases-owner-commands-sales-demo',
      }
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
      `${command} ${args.join(' ')} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`,
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
      throw new Error(
        `${label} stopped before becoming ready (exit ${child.exitCode})\n${child.tail()}`,
      );
    }
    try {
      await fetch(url);
      return;
    } catch {
      await wait(500);
    }
  }
  throw new Error(`${label} did not respond at ${url}\n${child.tail()}`);
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
  throw new Error(`consumer group is not ready: ${groupId}`);
}

function assertPortsFree() {
  for (const port of [3000, 5173, 5174]) {
    const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
    });
    if (result.stdout.trim()) {
      throw new Error(
        `port ${port} is in use - close the existing dev server before starting the Demo stack`,
      );
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
    if (!response.ok) throw new Error(`Keycloak admin token failed (${response.status})`);
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
    if (!response.ok) throw new Error(`Keycloak ${path} failed (${response.status})`);
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
        `${user.username} in Keycloak has no tenant_id/dc_user_id yet - run pnpm infra:identity:link first`,
      );
    }
    claims.push({ ...user, tenantId, userId, keycloakId: found[0].id });
  }
  if (new Set(claims.map((claim) => claim.tenantId)).size !== 1) {
    throw new Error('the demo users in Keycloak are not in the same tenant');
  }
  return claims;
}

/** The dev Console is at 5174 but the dev realm allows only 5173 - add it additively and idempotently */
async function allowConsoleRedirect(admin) {
  const [client] = await admin('/clients?clientId=agent-desktop');
  if (!client) throw new Error('client agent-desktop not found in realm dcontact');
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
  // the after-call note can be used only on a queue set to VOICE_NOTE_V1 (the seed default is LEGACY)
  psql(
    `UPDATE queues SET voice_wrapup_policy = 'VOICE_NOTE_V1' WHERE tenant_id = '${tenantId}';
     INSERT INTO agent_state_logs (tenant_id, user_id, state, reason)
     SELECT tenant_id, id, 'OFFLINE', 'sales-demo' FROM users
     WHERE tenant_id = '${tenantId}' AND role = 'AGENT';`,
  );
  // the D1 shell only for the demo tenant in this separate database - does not affect the #77 tenant
  run('pnpm', [
    'd1:shell-flag',
    '--',
    '--tenant',
    'demo',
    '--on',
    '--reason',
    'Sales demo (separate DB dcontact_demo)',
    '--actor',
    'sales-demo-stack',
    '--ack-voice-pilot',
  ]);
  return true;
}

/**
 * the Agent can search/link/edit customers during a call when the API has a confidential client for introspection
 * (`KEYCLOAK_C360_CLIENT_ID/SECRET`); the standard dev values come from the realm and `.env.example` (#916, #918)
 * the realm import skips a realm that already exists, so an older dev Keycloak may lack the client/mapper - create them to match the realm file
 * and set the secret to the same value as `.env.example` (not rotated) so an API run per `.env.example` works at the same time
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
    // a client left from an earlier version of the script uses a rotated secret - set it back to the standard value only, change nothing else
    const current = await admin(`/clients/${client.id}/client-secret`);
    if (current?.value !== clientSecret) {
      await admin(`/clients/${client.id}`, {
        method: 'PUT',
        body: JSON.stringify({ ...client, secret: clientSecret }),
      });
    }
  }
  // Keycloak answers introspection as inactive if the client asking is not in the aud of the token -
  // the mapper name matches the realm file of #918 so it is not created twice
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
  if (!organization) throw new Error('Organization demo not found in Keycloak');
  return organization.id;
}

/**
 * The Owner approved on 19 Nov 2026 seeding directly into the Demo database: the tenant from `db:seed` has no team or identity binding
 * that the real flows (Platform provisioning, Tenant People, Core Settings) create, so fill in only the `dcontact_demo` database
 * not acceptance evidence of identity/authorization, and never use it on another database - idempotent
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
 * the Agent can search customers during a call when the team has WORK on a segment (#911), but the API/Console can grant only VIEW,
 * so grant WORK and VIEW on `system:all-customers` through the real IAM repository (with the version bump and
 * the invalidation complete) - part of the seed the owner approved, idempotent (a repeat gives the result DUPLICATE)
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

/**
 * #1067 Journey trial on this stack only (not acceptance evidence of authorization):
 * - turns on the authoring rollout of the demo tenant
 * - the Admin authors and publishes; Agent 1001 is the independent reviewer (maker-checker needs two people)
 * - the case type and routing references an ENSURE_CASE step points at: both are named `follow-up`
 * Authoring authorization state is managed outside the application role, so it is written with the owner role here.
 */
function seedJourneyTrial(claims) {
  const tenantId = claims[0].tenantId;
  const maker = claims.find((claim) => claim.role === 'ADMIN');
  const reviewer = claims.find((claim) => claim.username === 'agent1001@demo.local');
  const grants = [
    ...['journey.read', 'journey.edit', 'journey.publish', 'journey.lifecycle'].map(
      (capability) => [maker.userId, capability],
    ),
    ...['journey.read', 'journey.review'].map((capability) => [reviewer.userId, capability]),
  ];
  psql(
    `BEGIN;
     INSERT INTO jr_authoring_rollout_state
       (id, tenant_id, stage, canvas_write_enabled, publish_ui_enabled, updated_by_ref, evidence_ref, updated_at)
     VALUES (gen_random_uuid(), '${tenantId}', 'INTERNAL_SYNTHETIC', true, true, 'sales-demo-seed', 'sales-demo-seed', now())
     ON CONFLICT (tenant_id) DO UPDATE SET canvas_write_enabled = true, publish_ui_enabled = true, updated_at = now(),
       version = jr_authoring_rollout_state.version + 1
     -- the rollout guard requires each update to bump version by one; a rerun on enabled flags changes nothing
     WHERE NOT (jr_authoring_rollout_state.canvas_write_enabled AND jr_authoring_rollout_state.publish_ui_enabled);
     INSERT INTO iam_authoring_subjects (id, tenant_id, subject_id, authentication_strength, updated_at)
     VALUES ${[maker, reviewer]
       .map((claim) => `(gen_random_uuid(), '${tenantId}', '${claim.userId}', 'STANDARD', now())`)
       .join(', ')}
     ON CONFLICT (tenant_id, subject_id) DO NOTHING;
     INSERT INTO iam_authoring_capability_grants
       (id, tenant_id, subject_id, capability, scope_kind, scope_id, granted_by_ref)
     VALUES ${grants
       .map(
         ([subjectId, capability]) =>
           `(gen_random_uuid(), '${tenantId}', '${subjectId}', '${capability}', 'TENANT', '${tenantId}', 'sales-demo-seed')`,
       )
       .join(', ')}
     ON CONFLICT (tenant_id, subject_id, capability, scope_kind, scope_id) DO NOTHING;
     INSERT INTO cs_case_type_policies (id, tenant_id, policy_ref, case_type_key, reopen_allowed)
     VALUES (gen_random_uuid(), '${tenantId}', 'follow-up', 'FOLLOW_UP', false)
     ON CONFLICT (tenant_id, policy_ref) DO NOTHING;
     INSERT INTO cs_routing_policies (id, tenant_id, policy_ref, queue_ref)
     VALUES (gen_random_uuid(), '${tenantId}', 'follow-up', 'follow-up')
     ON CONFLICT (tenant_id, policy_ref) DO NOTHING;
     COMMIT;`,
  );
}

/** Cus360 E1 D: grant CONTACT_CREATE to the Admin through the real operator command (dry-run first) - idempotent */
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
  // the gateway needs dc_user_id in the token; the operator has no User row in the tenant (always different from the grantee)
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
  // the gateway accepts only tokens of accounts that are active in the tenant (local account admission) - so the operator must have a User row
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
  if (!token.access_token) throw new Error(`cannot issue an operator token (${token.error})`);

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
    `# Keycloak: Console redirect ${added ? 'added' : 'already present'} (${consoleOrigin})\n`,
  );
  const organizationId = await demoOrganizationId(admin);
  const introspection = await c360IntrospectionClient(admin);
  environment.KEYCLOAK_C360_CLIENT_ID = introspection.clientId;
  environment.KEYCLOAK_C360_CLIENT_SECRET = introspection.clientSecret;
  const created = prepareDatabase(claims);
  seedDemoAccess(claims, organizationId);
  seedDemoScope(claims);
  const journeyTrial = process.env.JOURNEY === 'on';
  if (journeyTrial) seedJourneyTrial(claims);
  environment.LINE_WEBHOOK_TENANT_ID = claims[0].tenantId;
  process.stdout.write(
    `# DB ${database} ${created ? 'recreated' : 'kept existing data'} (tenant ${claims[0].tenantId})\n`,
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
  // the API allows CORS only for the Workspace origin - so the Console calls /api through the proxy of its own Vite
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
  const lineSimulator =
    process.env.LINE_CHAT === 'on' && !process.env.LINE_API_BASE_URL
      ? start('line-sim', 'node', [resolve('scripts/line-simulator.mjs'), '--port', '8890'])
      : null;
  // the workers connect with the application role, as on Solo, so RLS applies to them
  const workerEnv = { env: { ...environment, DATABASE_URL: environment.APPLICATION_DATABASE_URL } };
  if (journeyTrial) {
    start('journey', 'pnpm', ['--filter', '@d-contact/journey', 'dev'], workerEnv);
    start('cases', 'pnpm', ['--filter', '@d-contact/cases', 'dev'], workerEnv);
  }
  await Promise.all([
    ...(journeyTrial
      ? [
          waitForConsumerGroup(environment.JOURNEY_OUTCOME_CONSUMER_GROUP_ID),
          waitForConsumerGroup(environment.CASES_OWNER_COMMAND_CONSUMER_GROUP_ID),
        ]
      : []),
    ...(lineSimulator
      ? [waitForHttp('http://127.0.0.1:8890/sim/config', 'LINE simulator', lineSimulator)]
      : []),
    waitForHttp(`${apiOrigin}/api/v1/me/navigation`, 'API', api),
    waitForHttp(workspaceOrigin, 'Workspace', workspace),
    waitForHttp(consoleOrigin, 'Console', consoleApp),
    waitForConsumerGroup(routerGroupId),
    waitForConsumerGroup(`dcontact-telephony-command-${nodeId}-v1`),
  ]);
  // a failed grant should not take the whole stack down: the call-receiving part can still be rehearsed, but the Admin cannot import a CSV
  try {
    const capability = await grantCustomerCreate(await keycloakAdmin(), claims);
    process.stdout.write(
      `# CONTACT_CREATE for the Admin ${capability ? 'granted through the operator API' : 'already present'}\n`,
    );
  } catch (error) {
    process.stdout.write(
      `# WARN: granting CONTACT_CREATE failed - ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  process.stdout.write(
    [
      'SALES_DEMO_STACK_READY',
      `Workspace  ${workspaceOrigin}/?tenant=demo   (agent1000@demo.local)`,
      `Console    ${consoleOrigin}/?tenant=demo   (admin@demo.local)`,
      `phone        ${extensionId ? 'D-Phone Chrome extension' : 'the built-in Workspace browser phone'}`,
      ...(lineSimulator ? ['LINE sim   http://127.0.0.1:8890/   (write as a LINE user)'] : []),
      ...(journeyTrial
        ? [
            `Journey    ${consoleOrigin}/?tenant=demo&view=journeys   (admin authors, agent1001 reviews; case refs: follow-up)`,
          ]
        : []),
      'stop with Ctrl-C',
      '',
    ].join('\n'),
  );

  await new Promise((done, fail) => {
    for (const child of children) {
      child.once('exit', (code) =>
        cleaningUp
          ? done()
          : fail(new Error(`${child.label} stopped (exit ${code})\n${child.tail().slice(-4_000)}`)),
      );
    }
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
