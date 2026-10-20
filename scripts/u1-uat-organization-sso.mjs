import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createKeycloakAdmin } from './u1-uat-keycloak-users.mjs';

const BASE = '/admin/realms/dcontact';
const ALIAS = 'uat browser password otp';
const FLOW = `${BASE}/authentication/flows/${encodeURIComponent(ALIAS)}`;
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => {
  throw new Error(code);
};
const requireThat = (ok, code) => {
  if (!ok) fail(code);
};
const executionFields = [
  'id',
  'providerId',
  'displayName',
  'requirement',
  'level',
  'index',
  'priority',
  'flowId',
];
const select = (value, keys) => Object.fromEntries(keys.map((key) => [key, value[key] ?? null]));

async function snapshot(admin) {
  const realm = await admin.call(BASE);
  requireThat(realm.browserFlow === ALIAS && realm.organizationsEnabled, 'UAT_SSO_REALM_DRIFT');
  const flows = await admin.call(`${BASE}/authentication/flows`);
  const flow = flows.find((item) => item.alias === ALIAS);
  requireThat(
    flow?.topLevel && !flow.builtIn && flow.providerId === 'basic-flow',
    'UAT_SSO_FLOW_DRIFT',
  );
  requireThat(
    (await admin.call(`${BASE}/identity-provider/instances`)).length === 0,
    'UAT_SSO_BROKER_PRESENT',
  );
  const orgs = await admin.call(`${BASE}/organizations?first=0&max=250`);
  requireThat(orgs.length < 250, 'UAT_SSO_ORGANIZATION_LIMIT');
  for (const org of orgs) {
    requireThat(
      (await admin.call(`${BASE}/organizations/${org.id}/identity-providers`)).length === 0,
      'UAT_SSO_BROKER_PRESENT',
    );
  }
  const clients = await admin.call(`${BASE}/clients?clientId=dcontact-uat-console`);
  requireThat(
    clients.length === 1 &&
      Object.keys(clients[0].authenticationFlowBindingOverrides ?? {}).length === 0,
    'UAT_SSO_CLIENT_FLOW_DRIFT',
  );
  const rows = (await admin.call(`${FLOW}/executions`)).map((row) => select(row, executionFields));
  const protectedRows = rows.filter((row) => row.providerId !== 'organization');
  const expected = [
    ['auth-cookie', 0, 'ALTERNATIVE'],
    [null, 0, 'ALTERNATIVE'],
    ['auth-username-password-form', 1, 'REQUIRED'],
    ['auth-otp-form', 1, 'REQUIRED'],
  ];
  requireThat(
    protectedRows.length === expected.length &&
      protectedRows.every(
        (row, index) =>
          row.providerId === expected[index][0] &&
          row.level === expected[index][1] &&
          row.requirement === expected[index][2],
      ),
    'UAT_SSO_MFA_FLOW_DRIFT',
  );
  requireThat(protectedRows[1].displayName === `${ALIAS} forms`, 'UAT_SSO_FORMS_DRIFT');
  requireThat(
    rows.filter((row) => row.providerId === 'organization').length <= 1,
    'UAT_SSO_ORGANIZATION_DRIFT',
  );
  return {
    realm: select(realm, [
      'realm',
      'browserFlow',
      'organizationsEnabled',
      'ssoSessionIdleTimeout',
      'ssoSessionMaxLifespan',
      'otpPolicyType',
      'otpPolicyAlgorithm',
      'otpPolicyDigits',
      'otpPolicyPeriod',
      'otpPolicyLookAheadWindow',
      'otpPolicyCodeReusable',
      'passwordPolicy',
    ]),
    flow: select(flow, ['id', 'alias', 'providerId', 'topLevel', 'builtIn']),
    orgs: orgs
      .map((org) => select(org, ['id', 'alias', 'enabled']))
      .sort((a, b) => a.id.localeCompare(b.id)),
    rows,
  };
}
const protectedDigest = (value) =>
  digest({
    ...value,
    rows: value.rows
      .filter((row) => row.providerId !== 'organization')
      .map(({ index: _index, ...row }) => row),
  });
function organizationStep(value) {
  return value.rows.find((row) => row.providerId === 'organization');
}
function completeStep(row) {
  return row?.level === 0 && row.index === 1 && row.requirement === 'ALTERNATIVE';
}

export async function planOrganizationSso(admin) {
  const before = await snapshot(admin);
  const existing = organizationStep(before);
  requireThat(!existing || completeStep(existing), 'UAT_SSO_ORGANIZATION_DRIFT');
  const cookie = before.rows.find((row) => row.providerId === 'auth-cookie');
  const forms = before.rows.find((row) => row.providerId === null);
  requireThat(
    Number.isSafeInteger(cookie.priority) &&
      Number.isSafeInteger(forms.priority) &&
      forms.priority - cookie.priority > 1,
    'UAT_SSO_PRIORITY_GAP_REQUIRED',
  );
  return { action: existing ? 'NOOP' : 'ADD_ORGANIZATION', digest: digest(before), before };
}

export async function applyOrganizationSso(
  admin,
  { expectedDigest, beforeMutation = async () => {}, progress = async () => {} },
) {
  const plan = await planOrganizationSso(admin);
  requireThat(plan.digest === expectedDigest, 'UAT_SSO_PREIMAGE_CONFLICT');
  if (plan.action === 'NOOP')
    return {
      status: 'NOOP',
      before: plan.before,
      after: plan.before,
      beforeDigest: plan.digest,
      afterDigest: plan.digest,
      createdExecutionId: null,
    };
  await beforeMutation(plan);
  requireThat(
    (await planOrganizationSso(admin)).digest === expectedDigest,
    'UAT_SSO_PREIMAGE_CONFLICT',
  );
  await admin.call(`${FLOW}/executions/execution`, {
    method: 'POST',
    body: { provider: 'organization' },
  });
  let current = await snapshot(admin);
  let added = organizationStep(current);
  requireThat(
    added?.level === 0 && added.requirement === 'DISABLED' && added.index === 2,
    'UAT_SSO_CREATED_EXECUTION_DRIFT',
  );
  const createdExecutionId = added.id;
  await progress({ createdExecutionId, status: 'CREATED_DISABLED' });
  const checkProtected = (value) =>
    requireThat(
      protectedDigest(value) === protectedDigest(plan.before),
      'UAT_SSO_PROTECTED_CONFIG_DRIFT',
    );
  checkProtected(current);
  const cookie = plan.before.rows[0];
  const forms = plan.before.rows[1];
  requireThat(
    Number.isSafeInteger(cookie.priority) &&
      Number.isSafeInteger(forms.priority) &&
      forms.priority - cookie.priority > 1,
    'UAT_SSO_PRIORITY_GAP_REQUIRED',
  );
  const priority = cookie.priority + Math.floor((forms.priority - cookie.priority) / 2);
  await admin.call(`${FLOW}/executions`, {
    method: 'PUT',
    body: { id: added.id, priority, requirement: 'DISABLED' },
  });
  current = await snapshot(admin);
  added = organizationStep(current);
  checkProtected(current);
  requireThat(
    added?.id === createdExecutionId &&
      added.level === 0 &&
      added.index === 1 &&
      added.requirement === 'DISABLED',
    'UAT_SSO_CREATED_EXECUTION_DRIFT',
  );
  await progress({ createdExecutionId, status: 'POSITIONED_DISABLED' });
  // Enable เป็นคำสั่งสุดท้าย หลังตรวจว่า password/OTP และ broker guards ยังตรง preimage
  await admin.call(`${FLOW}/executions`, {
    method: 'PUT',
    body: { id: added.id, priority: added.priority, requirement: 'ALTERNATIVE' },
  });
  const after = await planOrganizationSso(admin);
  checkProtected(after.before);
  requireThat(
    organizationStep(after.before)?.id === createdExecutionId,
    'UAT_SSO_CREATED_EXECUTION_DRIFT',
  );
  return {
    status: 'APPLIED',
    before: plan.before,
    after: after.before,
    beforeDigest: plan.digest,
    afterDigest: after.digest,
    createdExecutionId,
  };
}

export async function rollbackOrganizationSso(admin, record) {
  const partial = ['CREATED_DISABLED', 'POSITIONED_DISABLED'].includes(record.status);
  requireThat(
    (record.status === 'APPLIED' || partial) && record.createdExecutionId,
    'UAT_SSO_ROLLBACK_NOT_APPLIED',
  );
  requireThat(
    record.beforeDigest === digest(record.before) && !organizationStep(record.before),
    'UAT_SSO_ROLLBACK_CONFLICT',
  );
  const current = await snapshot(admin);
  const added = organizationStep(current);
  requireThat(
    added?.id === record.createdExecutionId &&
      protectedDigest(current) === protectedDigest(record.before),
    'UAT_SSO_ROLLBACK_CONFLICT',
  );
  if (partial) {
    requireThat(
      added.requirement === 'DISABLED' &&
        added.level === 0 &&
        added.index === (record.status === 'CREATED_DISABLED' ? 2 : 1),
      'UAT_SSO_ROLLBACK_CONFLICT',
    );
  } else {
    requireThat(
      digest(current) === record.afterDigest && completeStep(added),
      'UAT_SSO_ROLLBACK_CONFLICT',
    );
    await admin.call(`${FLOW}/executions`, {
      method: 'PUT',
      body: { id: added.id, priority: added.priority, requirement: 'DISABLED' },
    });
    const disabled = await snapshot(admin);
    requireThat(
      organizationStep(disabled)?.id === record.createdExecutionId &&
        organizationStep(disabled)?.requirement === 'DISABLED' &&
        protectedDigest(disabled) === protectedDigest(record.before),
      'UAT_SSO_ROLLBACK_CONFLICT',
    );
  }
  await admin.call(`${BASE}/authentication/executions/${record.createdExecutionId}`, {
    method: 'DELETE',
  });
  const restored = await planOrganizationSso(admin);
  requireThat(restored.digest === record.beforeDigest, 'UAT_SSO_ROLLBACK_CONFLICT');
  return { status: 'ROLLED_BACK', digest: restored.digest };
}

function writeRecord(path, value, first = false) {
  requireThat(isAbsolute(path), 'UAT_SSO_RECORD_PATH_REQUIRED');
  if (first)
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  else {
    writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
}
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0];
  const arg = (name) => args[args.indexOf(name) + 1];
  requireThat(['--plan', '--apply', '--rollback'].includes(mode), 'UAT_SSO_MODE_REQUIRED');
  const url = new URL(process.env.KEYCLOAK_ADMIN_URL);
  requireThat(
    ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      ['/', '/auth', '/auth/'].includes(url.pathname) &&
      /^(127\.0\.0\.1|localhost|keycloak|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/.test(
        url.hostname,
      ),
    'UAT_SSO_INTERNAL_ADMIN_REQUIRED',
  );
  const admin = createKeycloakAdmin({
    baseUrl: url.toString().replace(/\/$/, ''),
    username: process.env.KEYCLOAK_ADMIN_USERNAME,
    password: process.env.KEYCLOAK_ADMIN_PASSWORD,
  });
  await admin.login();
  if (mode === '--plan') {
    const plan = await planOrganizationSso(admin);
    if (args.includes('--record')) writeRecord(arg('--record'), plan, true);
    console.log(JSON.stringify({ action: plan.action, digest: plan.digest }));
    return;
  }
  requireThat(
    args.includes('--record') && /^[a-f0-9]{40}$/.test(process.env.SOURCE_SHA ?? ''),
    'UAT_SSO_RECORD_SOURCE_REQUIRED',
  );
  const path = arg('--record');
  if (mode === '--rollback') {
    const record = JSON.parse(readFileSync(path, 'utf8'));
    const result = await rollbackOrganizationSso(admin, record);
    writeRecord(path, { ...record, rollback: { ...result, at: new Date().toISOString() } });
    console.log(JSON.stringify(result));
    return;
  }
  requireThat(
    args.includes('--expected-digest') && /^[a-f0-9]{64}$/.test(arg('--expected-digest') ?? ''),
    'UAT_SSO_EXPECTED_DIGEST_REQUIRED',
  );
  let record = {
    schema: 'UatOrganizationSsoPatchV1',
    sourceSha: process.env.SOURCE_SHA,
    startedAt: new Date().toISOString(),
    status: 'INTENT',
    expectedDigest: arg('--expected-digest'),
  };
  writeRecord(path, record, true);
  const result = await applyOrganizationSso(admin, {
    expectedDigest: record.expectedDigest,
    beforeMutation: async (plan) => {
      record = { ...record, before: plan.before, beforeDigest: plan.digest };
      writeRecord(path, record);
    },
    progress: async (state) => {
      record = { ...record, ...state };
      writeRecord(path, record);
    },
  });
  record = { ...record, ...result, completedAt: new Date().toISOString() };
  writeRecord(path, record);
  console.log(
    JSON.stringify({
      status: result.status,
      beforeDigest: result.beforeDigest,
      afterDigest: result.afterDigest,
    }),
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(
      JSON.stringify({
        status: 'FAILED',
        code: /^UAT_SSO_/.test(error.message) ? error.message : 'UAT_SSO_OPERATION_FAILED',
      }),
    );
    process.exitCode = 1;
  });
