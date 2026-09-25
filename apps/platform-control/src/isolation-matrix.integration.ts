/**
 * A1.8 (#413) — isolation matrix ของ #393 ส่วนฐานข้อมูล (fast gate)
 *
 * - Tenant Admin A (role `dcontact_app` + `app.tenant_id = A`) สลับไปอ่าน/แก้แถวของ tenant B ใน
 *   ตาราง baseline ของ A1 ไม่ได้: SELECT = 0 แถว, UPDATE/DELETE = 0 แถว, INSERT ถูก RLS ปฏิเสธ
 * - Platform Operator (role `dcontact_platform`) อ่าน business data ของ tenant ไม่ได้เลย
 *   (สิทธิ์ถูกตัดที่ระดับ GRANT ไม่ใช่แค่ RLS)
 *
 * ส่วน API/token (auditor mutation, tenant/mixed token, generic 404) อยู่ใน platform-api
 * integration; tenant ที่ยัง PROVISIONING เข้า tenant apps ไม่ได้อยู่ใน gateway-auth/workspace-session
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
      name: 'เวลาทำการ',
      timezone: 'Asia/Bangkok',
      weekly: [{ day: 1, open: '09:00', close: '18:00' }],
    },
  });
  return { tenantId: tenant.id, teamId: team.id };
}

/** Tenant Admin ของ tenant หนึ่ง: role ของ tenant app + tenant context จาก token ที่ verify แล้ว */
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

test('Tenant Admin A สลับไป tenant B: SELECT ได้ 0 แถวในทุกตาราง baseline ของ A1', async (t) => {
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
    assert.ok((own as { n: number }[])[0]!.n >= 1, `${table}: A ต้องเห็นแถวของตัวเอง`);
    assert.equal((foreign as { n: number }[])[0]!.n, 0, `${table}: A เห็นแถวของ B`);
  }
});

test('Tenant Admin A แก้/ลบแถวของ B ไม่ได้ และ INSERT โดยอ้าง tenant B ถูก RLS ปฏิเสธ', async (t) => {
  const { f, a, b } = await setup(t);
  for (const table of BASELINE_TABLES) {
    const updated = await asTenant(f.application, a.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE "${table}" SET "tenant_id" = "tenant_id" WHERE "tenant_id" = $1::uuid`,
        b.tenantId,
      ),
    );
    assert.equal(updated, 0, `${table}: A แก้แถวของ B ได้`);
    const deleted = await asTenant(f.application, a.tenantId, (tx) =>
      tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "tenant_id" = $1::uuid`, b.tenantId),
    );
    assert.equal(deleted, 0, `${table}: A ลบแถวของ B ได้`);
  }
  await assert.rejects(
    asTenant(f.application, a.tenantId, (tx) =>
      tx.team.create({ data: { tenantId: b.tenantId, name: 'Injected' } }),
    ),
    /row-level security/,
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
  // แถวของ B ยังอยู่ครบ
  assert.equal(await f.owner.team.count({ where: { tenantId: b.tenantId } }), 1);
  assert.equal(await f.owner.tenantSettings.count({ where: { tenantId: b.tenantId } }), 1);
});

test('ไม่มี tenant context = ไม่เห็นอะไรเลย (fail closed)', async (t) => {
  const { f } = await setup(t);
  for (const table of BASELINE_TABLES) {
    const rows = await f.application.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${table}"`,
    );
    assert.equal(rows[0]!.n, 0, `${table}: ไม่มี app.tenant_id แต่เห็นแถว`);
  }
});

test('Platform Operator (dcontact_platform) อ่าน business data ของ tenant ไม่ได้ที่ระดับ GRANT', async (t) => {
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
      `platform role อ่าน ${table} ได้`,
    );
  }
});
