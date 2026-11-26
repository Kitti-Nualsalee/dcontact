/**
 * A1.8 (#413) — the database part of the #393 isolation matrix (fast gate)
 *
 * - Tenant Admin A (role `dcontact_app` + `app.tenant_id = A`) cannot switch to reading/editing tenant B's rows in
 *   the A1 baseline tables: SELECT = 0 rows, UPDATE/DELETE = 0 rows, INSERT is rejected by RLS
 * - Platform Operator (role `dcontact_platform`) cannot read tenant business data at all
 *   (the permission is cut at the GRANT level, not just RLS)
 *
 * The API/token part (auditor mutation, tenant/mixed token, generic 404) is in the platform-api
 * integration; a tenant still PROVISIONING cannot enter the tenant apps — see gateway-auth/workspace-session
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import type { PrismaClient } from '@d-contact/db';
import { createPlatformFixture } from './platform-fixture.js';

async function seedTenant(f: Awaited<ReturnType<typeof createPlatformFixture>>, label: string) {
  const tenant = await f.owner.tenant.create({
    data: { name: label, slug: label, sipDomain: `${label}.sip.test` },
  });
  f.track(tenant.id);
  const team = await f.owner.team.create({ data: { tenantId: tenant.id, name: 'Admin Team' } });
  await f.owner.user.create({
    data: {
      tenantId: tenant.id,
      email: `admin@${label}.test`,
      passwordHash: '!keycloak-managed',
      displayName: 'Admin',
      role: 'ADMIN',
      teamId: team.id,
    },
  });
  await f.owner.queue.create({
    data: {
      tenantId: tenant.id,
      name: 'General Queue',
      channels: [],
      teamId: team.id,
      isActive: false,
    },
  });
  const requestId = randomUUID();
  await f.owner.tenantSettings.create({
    data: {
      tenantId: tenant.id,
      locale: 'th-TH',
      timezone: 'Asia/Bangkok',
      bootstrapTemplateVersion: 'baseline',
      bootstrapTemplateDigest: 'a'.repeat(64),
      provisioningRequestId: requestId,
    },
  });
  await f.owner.tenantPlanBinding.create({
    data: {
      tenantId: tenant.id,
      planCode: 'growth',
      planVersion: 1,
      snapshotDigest: 'b'.repeat(64),
      entitlements: { agent_seats: 10 },
      provisioningRequestId: requestId,
    },
  });
  await f.owner.businessHours.create({
    data: {
      id: randomUUID(),
      tenantId: tenant.id,
      name: 'Business hours',
      timezone: 'Asia/Bangkok',
      weekly: [{ day: 1, open: '09:00', close: '18:00' }],
    },
  });
  return { tenantId: tenant.id, teamId: team.id };
}

/** The Tenant Admin of one tenant: the tenant app role + the tenant context from a verified token */
function asTenant<T>(application: PrismaClient, tenantId: string, work: (tx: any) => Promise<T>) {
  return application.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, tenantId);
    return work(transaction);
  });
}

const BASELINE_TABLES = [
  'users',
  'teams',
  'queues',
  'tenant_settings',
  'tenant_plan_bindings',
  'business_hours',
] as const;

async function setup(t: TestContext) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const run = randomUUID().slice(0, 8);
  const a = await seedTenant(f, `iso-a-${run}`);
  const b = await seedTenant(f, `iso-b-${run}`);
  return { f, a, b };
}

test('Tenant Admin A switching to tenant B: SELECT returns 0 rows in every A1 baseline table', async (t) => {
  const { f, a, b } = await setup(t);
  for (const table of BASELINE_TABLES) {
    const [own, foreign] = await asTenant(f.application, a.tenantId, async (tx) => [
      await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "tenant_id" = $1::uuid`,
        a.tenantId,
      ),
      await tx.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM "${table}" WHERE "tenant_id" = $1::uuid`,
        b.tenantId,
      ),
    ]);
    assert.ok((own as { n: number }[])[0]!.n >= 1, `${table}: A must see its own rows`);
    assert.equal((foreign as { n: number }[])[0]!.n, 0, `${table}: A sees B's rows`);
  }
});

test('Tenant Admin A cannot edit/delete B rows through RLS or table grants, and a cross-tenant INSERT is rejected', async (t) => {
  const { f, a, b } = await setup(t);
  // #753: use a column the tenant writer can actually edit so the UPDATE proves RLS;
  // the tenant_id of teams has had its privilege revoked by Core Settings (#727)
  const updateColumns = {
    users: 'display_name',
    teams: 'name',
    queues: 'name',
    tenant_settings: 'locale',
    tenant_plan_bindings: 'plan_code',
    business_hours: 'name',
  } as const;
  for (const table of BASELINE_TABLES) {
    const column = updateColumns[table];
    const updated = await asTenant(f.application, a.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "${table}" SET "${column}" = "${column}" WHERE "tenant_id" = $1::uuid`,
        b.tenantId,
      ),
    );
    assert.equal(updated, 0, `${table}: A could edit B's rows`);
    const removeForeign = () =>
      asTenant(f.application, a.tenantId, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenant_id" = $1::uuid`, b.tenantId),
      );
    // #726/#727 forbid direct DELETE on these two tables for every tenant at the GRANT level
    // must confirm it is rejected exactly per the contract, not hand back the privilege to make the test pass
    if (table === 'teams' || table === 'tenant_settings') {
      await assert.rejects(removeForeign, new RegExp(`permission denied for table ${table}`));
    } else {
      assert.equal(await removeForeign(), 0, `${table}: A could delete B's rows`);
    }
  }
  // Core Settings checks the tenant context before the INSERT policy of teams (#727)
  await assert.rejects(
    asTenant(f.application, a.tenantId, (tx) =>
      tx.team.create({ data: { tenantId: b.tenantId, name: 'Injected' } }),
    ),
    /CORE_ACTIVE_TENANT_CONTEXT_REQUIRED/,
  );
  await assert.rejects(
    asTenant(f.application, a.tenantId, (tx) =>
      tx.businessHours.create({
        data: {
          id: randomUUID(),
          tenantId: b.tenantId,
          name: 'Injected',
          timezone: 'UTC',
          weekly: [],
        },
      }),
    ),
    /row-level security/,
  );
  // B's rows are all still there
  assert.equal(await f.owner.team.count({ where: { tenantId: b.tenantId } }), 1);
  assert.equal(await f.owner.tenantSettings.count({ where: { tenantId: b.tenantId } }), 1);
});

test('no tenant context = sees nothing at all (fail closed)', async (t) => {
  const { f } = await setup(t);
  for (const table of BASELINE_TABLES) {
    const rows = await f.application.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${table}"`,
    );
    assert.equal(rows[0]!.n, 0, `${table}: no app.tenant_id but rows are visible`);
  }
});

test('Platform Operator (dcontact_platform) cannot read tenant business data at the GRANT level', async (t) => {
  const { f } = await setup(t);
  for (const table of [
    ...BASELINE_TABLES,
    'contacts',
    'interactions',
    'conversations',
    'messages',
    'recordings',
    'jr_journey_definitions',
  ]) {
    await assert.rejects(
      f.platform.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`),
      /permission denied/,
      `platform role could read ${table}`,
    );
  }
});
