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

test('People configuration requires a dedicated worker connection and exact server-owned bindings', () => {
  assert.equal(peopleConfiguration(environment)?.bindings[0]?.tenantId, tenantId);
  for (const override of [
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
