import assert from 'node:assert/strict';
import test from 'node:test';
import {
  planOrganizationSso,
  applyOrganizationSso,
  rollbackOrganizationSso,
} from './u1-uat-organization-sso.mjs';

function keycloak() {
  const state = {
    realm: {
      realm: 'dcontact',
      browserFlow: 'uat browser password otp',
      organizationsEnabled: true,
    },
    broker: [],
    orgBroker: [],
    org: null,
    orgIndex: 2,
    otp: 'REQUIRED',
    writes: [],
  };
  const admin = {
    async call(path, { method = 'GET', body } = {}) {
      const flowPath = '/admin/realms/dcontact/authentication/flows/uat%20browser%20password%20otp';
      if (method !== 'GET') state.writes.push({ path, method, body });
      if (path === '/admin/realms/dcontact') return structuredClone(state.realm);
      if (path.endsWith('/authentication/flows'))
        return [
          {
            id: 'flow',
            alias: state.realm.browserFlow,
            topLevel: true,
            builtIn: false,
            providerId: 'basic-flow',
          },
        ];
      if (path.endsWith('/identity-provider/instances')) return state.broker;
      if (path.includes('/organizations?')) return [{ id: 'org', alias: 'uat', enabled: true }];
      if (path.endsWith('/organizations/org/identity-providers')) return state.orgBroker;
      if (path.includes('/clients?')) return [{ authenticationFlowBindingOverrides: {} }];
      if (path === `${flowPath}/executions/execution`) {
        state.org = {
          id: 'created',
          providerId: 'organization',
          level: 0,
          requirement: 'DISABLED',
          priority: 21,
        };
        return;
      }
      if (path.endsWith('/created/raise-priority')) {
        state.orgIndex = 1;
        state.onRaise?.();
        return;
      }
      if (path.endsWith('/authentication/executions/created') && method === 'DELETE') {
        state.org = null;
        return;
      }
      if (path === `${flowPath}/executions` && method === 'PUT') {
        if (state.failEnable && body.requirement === 'ALTERNATIVE')
          throw new Error('API_UNAVAILABLE');
        state.org.requirement = body.requirement;
        state.org.priority = body.priority;
        if (body.priority === 15) {
          state.orgIndex = 1;
          if (body.requirement === 'DISABLED') state.onRaise?.();
        }
        return;
      }
      if (path === `${flowPath}/executions`) {
        const cookie = {
          id: 'cookie',
          priority: 10,
          providerId: 'auth-cookie',
          level: 0,
          index: 0,
          requirement: 'ALTERNATIVE',
        };
        const forms = {
          id: 'forms',
          priority: state.formsPriority ?? 20,
          providerId: null,
          displayName: 'uat browser password otp forms',
          flowId: 'forms-flow',
          level: 0,
          index: state.org && state.orgIndex === 1 ? 2 : 1,
          requirement: 'ALTERNATIVE',
        };
        const nested = [
          {
            id: 'password',
            providerId: 'auth-username-password-form',
            level: 1,
            index: 0,
            requirement: 'REQUIRED',
          },
          { id: 'otp', providerId: 'auth-otp-form', level: 1, index: 1, requirement: state.otp },
        ];
        const org = state.org ? { ...state.org, index: state.orgIndex } : null;
        return structuredClone(
          org && state.orgIndex === 1
            ? [cookie, org, forms, ...nested]
            : [cookie, forms, ...nested, ...(org ? [org] : [])],
        );
      }
      throw new Error(`unexpected endpoint ${method} ${path}`);
    },
  };
  return { state, admin };
}

test('Admin boundary: apply keeps the preimage before the mutation, enables after positioning, and repeating is a no-op', async () => {
  const { state, admin } = keycloak();
  const plan = await planOrganizationSso(admin);
  const record = await applyOrganizationSso(admin, {
    expectedDigest: plan.digest,
    beforeMutation: async () => assert.equal(state.writes.length, 0),
  });
  assert.equal(record.status, 'APPLIED');
  assert.equal(state.org.requirement, 'ALTERNATIVE');
  assert.equal(state.writes.at(-1).body.requirement, 'ALTERNATIVE');
  const writes = state.writes.length;
  assert.equal(
    (await applyOrganizationSso(admin, { expectedDigest: record.afterDigest })).status,
    'NOOP',
  );
  assert.equal(state.writes.length, writes);
  assert.equal((await rollbackOrganizationSso(admin, record)).status, 'ROLLED_BACK');
  assert.equal((await planOrganizationSso(admin)).digest, plan.digest);
});

test('Admin boundary: a stale preimage and drift before the mutation do not write config', async () => {
  const { state, admin } = keycloak();
  const plan = await planOrganizationSso(admin);
  await assert.rejects(
    applyOrganizationSso(admin, { expectedDigest: 'stale' }),
    /PREIMAGE_CONFLICT/,
  );
  await assert.rejects(
    applyOrganizationSso(admin, {
      expectedDigest: plan.digest,
      beforeMutation: async () => {
        state.realm.ssoSessionIdleTimeout = 1;
      },
    }),
    /PREIMAGE_CONFLICT/,
  );
  assert.equal(state.writes.length, 0);
});

for (const field of ['broker', 'orgBroker'])
  test(`Admin boundary: ${field} must fail closed`, async () => {
    const { state, admin } = keycloak();
    state[field] = [{ alias: 'external' }];
    await assert.rejects(planOrganizationSso(admin), /BROKER_PRESENT/);
    assert.equal(state.writes.length, 0);
  });

test('Admin boundary: a modified OTP requirement must not be reconciled over', async () => {
  const { state, admin } = keycloak();
  state.otp = 'ALTERNATIVE';
  await assert.rejects(planOrganizationSso(admin), /MFA_FLOW_DRIFT/);
  assert.equal(state.writes.length, 0);
});

test('Admin boundary: drift during positioning stops before enabling the Organization', async () => {
  const { state, admin } = keycloak();
  const plan = await planOrganizationSso(admin);
  state.onRaise = () => {
    state.otp = 'ALTERNATIVE';
  };
  await assert.rejects(
    applyOrganizationSso(admin, { expectedDigest: plan.digest }),
    /MFA_FLOW_DRIFT/,
  );
  assert.equal(state.org.requirement, 'DISABLED');
});

test('Admin boundary: rollback rejects a config that is not the postimage of this job', async () => {
  const { state, admin } = keycloak();
  const plan = await planOrganizationSso(admin);
  const record = await applyOrganizationSso(admin, { expectedDigest: plan.digest });
  state.realm.ssoSessionIdleTimeout = 99;
  const writes = state.writes.length;
  await assert.rejects(rollbackOrganizationSso(admin, record), /ROLLBACK_CONFLICT/);
  assert.equal(state.writes.length, writes);
});

test('Admin boundary: when enable fails, rollback reverts only an execution that is still disabled', async () => {
  const { state, admin } = keycloak();
  const plan = await planOrganizationSso(admin);
  let record = { before: plan.before, beforeDigest: plan.digest };
  state.failEnable = true;
  await assert.rejects(
    applyOrganizationSso(admin, {
      expectedDigest: plan.digest,
      progress: async (value) => {
        record = { ...record, ...value };
      },
    }),
    /API_UNAVAILABLE/,
  );
  assert.equal(record.status, 'POSITIONED_DISABLED');
  assert.equal((await rollbackOrganizationSso(admin, record)).status, 'ROLLED_BACK');
  assert.equal((await planOrganizationSso(admin)).digest, plan.digest);
});

test('Admin boundary: a priority with no slot for a new execution must not create anything', async () => {
  const { state, admin } = keycloak();
  state.formsPriority = 11;
  await assert.rejects(planOrganizationSso(admin), /PRIORITY_GAP_REQUIRED/);
  assert.equal(state.writes.length, 0);
});
