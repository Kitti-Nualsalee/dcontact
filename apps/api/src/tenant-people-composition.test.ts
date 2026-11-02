import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredPeopleRuntime, peopleConfiguration } from './tenant-people-composition.js';

const tenantId = '00000000-0000-4000-8000-000000000709';
const node = {
  telephonyNodeId: 'synthetic-node',
  releaseDigest: 'a'.repeat(64),
  dialplanDigest: 'b'.repeat(64),
  extensions: ['1104'],
};
const binding = {
  tenantId,
  issuer: 'https://identity.example.test/realms/synthetic',
  clientSecretEnv: 'TENANT_PEOPLE_SECRET_SYNTHETIC',
  nodes: [node],
};
const environment = {
  TENANT_PEOPLE_WORKER_DATABASE_URL:
    'postgresql://synthetic:synthetic@127.0.0.1/synthetic?options=-c%20role%3Ddcontact_tenant_people_worker',
  TENANT_PEOPLE_BINDINGS_JSON: JSON.stringify([binding]),
  TENANT_PEOPLE_SECRET_SYNTHETIC: 'synthetic-only',
  SIP_BROWSER_NODES_JSON: JSON.stringify([{ telephonyNodeId: node.telephonyNodeId }]),
};

test('People composition defaults off without opening a database connection', async () => {
  assert.equal(peopleConfiguration({}), null);
  assert.equal(await configuredPeopleRuntime({}).isReady(tenantId), false);
});

test('People binding เปิด backchannel เฉพาะ Keycloak ภายใน realm เดิมโดยคง issuer และ default-off', () => {
  const configuration = peopleConfiguration({
    ...environment,
    TENANT_PEOPLE_BINDINGS_JSON: JSON.stringify([
      { ...binding, backchannelUrl: 'http://keycloak:8080/realms/synthetic' },
    ]),
  });
  assert.equal(configuration?.bindings[0]?.tenantId, tenantId);
  assert.equal(configuration?.invitationsEnabled, false);
  assert.equal(configuration?.disableEnabled, false);
  for (const backchannelUrl of [
    null,
    '',
    'http://foreign:8080/realms/synthetic',
    'http://keycloak:8080/realms/foreign',
  ])
    assert.throws(
      () =>
        peopleConfiguration({
          ...environment,
          TENANT_PEOPLE_BINDINGS_JSON: JSON.stringify([{ ...binding, backchannelUrl }]),
        }),
      /INVALID_PEOPLE_CONFIGURATION/,
    );
});

test('composition ใช้ backchannel เดียวกันกับ provisioning/invitation/disable readiness', async () => {
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  let configuration: ReturnType<typeof peopleConfiguration>;
  try {
    globalThis.fetch = async (input) => {
      calls.push(String(input));
      return Response.json(
        String(input).endsWith('/token')
          ? { access_token: 'synthetic-only' }
          : { version: 1, tenantId, ready: true, invitationReady: true, disableReady: true },
      );
    };
    configuration = peopleConfiguration({
      ...environment,
      TENANT_PEOPLE_BINDINGS_JSON: JSON.stringify([
        { ...binding, backchannelUrl: 'http://keycloak:8080/realms/synthetic' },
      ]),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.ok(configuration);
  const identity = configuration.bindings[0]!.identity;
  assert.equal(await identity.isReady(tenantId), true);
  assert.equal(await identity.invitationPort().isReady(tenantId), true);
  assert.equal(await identity.disablePort().isReady(tenantId), true);
  assert.equal(calls.length, 6);
  assert.ok(calls.every((url) => url.startsWith('http://keycloak:8080/realms/synthetic/')));
  assert.equal(await identity.isReady('00000000-0000-4000-8000-000000000999'), false);
  assert.equal(calls.length, 6);
});

test('disable ต้อง opt in และมี flush port ก่อนประกอบ runtime', () => {
  assert.equal(peopleConfiguration(environment)?.disableEnabled, false);
  assert.throws(() => peopleConfiguration({ TENANT_PEOPLE_DISABLE_ENABLED: 'true' }));
  assert.throws(() =>
    peopleConfiguration({ ...environment, TENANT_PEOPLE_DISABLE_ENABLED: 'yes' }),
  );
  assert.throws(
    () => configuredPeopleRuntime({ ...environment, TENANT_PEOPLE_DISABLE_ENABLED: 'true' }),
    /PEOPLE_DISABLE_FLUSH_REQUIRED/,
  );
});

test('People configuration requires a dedicated worker connection and exact server-owned bindings', () => {
  assert.equal(peopleConfiguration(environment)?.bindings[0]?.tenantId, tenantId);
  assert.equal(peopleConfiguration(environment)?.invitationsEnabled, false);
  assert.equal(
    peopleConfiguration({ ...environment, TENANT_PEOPLE_INVITATIONS_ENABLED: 'true' })
      ?.invitationsEnabled,
    true,
  );
  assert.throws(() => peopleConfiguration({ TENANT_PEOPLE_INVITATIONS_ENABLED: 'true' }));
  for (const override of [
    { TENANT_PEOPLE_INVITATIONS_ENABLED: 'yes' },
    { TENANT_PEOPLE_WORKER_DATABASE_URL: '' },
    { TENANT_PEOPLE_WORKER_DATABASE_URL: 'postgresql://owner:owner@127.0.0.1/synthetic' },
    { TENANT_PEOPLE_SECRET_SYNTHETIC: '' },
    { SIP_BROWSER_NODES_JSON: '[]' },
    { TENANT_PEOPLE_BINDINGS_JSON: JSON.stringify([binding, binding]) },
    { TENANT_PEOPLE_BINDINGS_JSON: JSON.stringify([{ ...binding, role: 'admin' }]) },
    {
      TENANT_PEOPLE_BINDINGS_JSON: JSON.stringify([
        { ...binding, nodes: [{ ...node, dialplanDigest: 'invalid' }] },
      ]),
    },
    {
      TENANT_PEOPLE_BINDINGS_JSON: JSON.stringify([
        { ...binding, nodes: [{ ...node, extensions: ['1104', '1104'] }] },
      ]),
    },
  ])
    assert.throws(() => peopleConfiguration({ ...environment, ...override }));
});
