import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkspacePeopleRuntime } from './workspace-uat-api.js';
import { TenantPeopleRuntime } from './tenant-people-runtime.js';

const tenantId = '00000000-0000-4000-8000-000000000714';
const environment = {
  TENANT_PEOPLE_WORKER_DATABASE_URL:
    'postgresql://synthetic:synthetic@127.0.0.1/synthetic?options=-c%20role%3Ddcontact_tenant_people_worker',
  TENANT_PEOPLE_BINDINGS_JSON: JSON.stringify([
    {
      tenantId,
      issuer: 'https://identity.example.test/realms/synthetic',
      clientSecretEnv: 'TENANT_PEOPLE_SECRET_SYNTHETIC',
      nodes: [],
    },
  ]),
  TENANT_PEOPLE_SECRET_SYNTHETIC: 'synthetic-only',
  TENANT_PEOPLE_DISABLE_ENABLED: 'true',
};

test('Workspace People is default-off and does not open a connection from the process environment instead of the input', async () => {
  const runtime = createWorkspacePeopleRuntime({ environment: {} });
  assert.equal(await runtime.isReady(tenantId), false);
});

test('Workspace B7 needs a direct flush port before composing the disable runtime, without importing Kafka/the default API', async () => {
  assert.throws(
    () => createWorkspacePeopleRuntime({ environment }),
    /PEOPLE_DISABLE_FLUSH_REQUIRED/,
  );
  const runtime = createWorkspacePeopleRuntime({
    environment,
    peopleDisableFlush: {
      async flush() {
        assert.fail('must not send a command while composing the runtime');
      },
    },
  });
  assert.ok(runtime instanceof TenantPeopleRuntime);
  assert.ok(runtime.disablePortForTenant(tenantId));
  assert.equal(await runtime.canDisable(tenantId), false);
  await runtime.onModuleDestroy();
});
