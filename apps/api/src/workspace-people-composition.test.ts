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

test('Workspace People default-off และไม่เปิด connection จาก process environment แทน input', async () => {
  const runtime = createWorkspacePeopleRuntime({ environment: {} });
  assert.equal(await runtime.isReady(tenantId), false);
});

test('Workspace B7 ต้องมี direct flush port ก่อนประกอบ disable runtime โดยไม่ import Kafka/default API', async () => {
  assert.throws(
    () => createWorkspacePeopleRuntime({ environment }),
    /PEOPLE_DISABLE_FLUSH_REQUIRED/,
  );
  const runtime = createWorkspacePeopleRuntime({
    environment,
    peopleDisableFlush: {
      async flush() {
        assert.fail('ไม่ควรส่ง command ระหว่างประกอบ runtime');
      },
    },
  });
  assert.ok(runtime instanceof TenantPeopleRuntime);
  assert.ok(runtime.disablePortForTenant(tenantId));
  assert.equal(await runtime.canDisable(tenantId), false);
  await runtime.onModuleDestroy();
});
