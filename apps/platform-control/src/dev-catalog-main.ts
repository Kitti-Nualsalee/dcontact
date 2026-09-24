/**
 * A1 dev/UAT เท่านั้น: publish bootstrap template และ plan ให้ Platform Console เลือกได้ในเครื่อง
 * (`pnpm a1:dev-catalog`)
 *
 * ค่า entitlement ด้านล่างเป็น **ค่าสำหรับทดสอบ** ไม่ใช่การตัดสินใจเชิงผลิตภัณฑ์ของ production —
 * production publish catalog ผ่าน `PlatformCatalog` ตาม decision ของ plan/pricing
 * idempotent: template version เดิมเนื้อหาเดิม = no-op; plan ออก version ใหม่เฉพาะเมื่อยังไม่มี ACTIVE
 */
import { PrismaClient } from '@d-contact/db';
import type { BootstrapManifestV1, PlatformPlanCode } from '@d-contact/shared';
import { PlatformCatalog } from './platform-catalog.js';

const DEV_MANIFEST: BootstrapManifestV1 = {
  schemaVersion: 1,
  adminTeam: { name: 'Admin Team' },
  drafts: {
    generalTeam: { name: 'General Team' },
    generalQueue: { name: 'General Queue' },
    businessHours: {
      name: 'เวลาทำการ',
      weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00' })),
    },
  },
};

const DEV_PLANS: Record<PlatformPlanCode, Record<string, number | boolean>> = {
  starter: { agent_seats: 5, queues: 3, dev_only: true },
  growth: { agent_seats: 25, queues: 10, dev_only: true },
  enterprise: { agent_seats: 200, queues: 50, dev_only: true },
};

const database = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.PLATFORM_DATABASE_URL ??
        'postgresql://dcontact_platform:dcontact_platform@localhost:5433/dcontact?schema=public',
    },
  },
});
try {
  const catalog = new PlatformCatalog(database);
  const template = await catalog.publishBootstrapTemplate({
    version: 'dev-baseline-v1',
    manifest: DEV_MANIFEST,
  });
  const plans: string[] = [];
  for (const [planCode, entitlements] of Object.entries(DEV_PLANS) as [
    PlatformPlanCode,
    Record<string, number | boolean>,
  ][]) {
    const active =
      (await catalog.activePlan(planCode).catch(() => null)) ??
      (await catalog.publishPlanVersion({ planCode, entitlements }));
    plans.push(`${active.planCode}@${active.version}`);
  }
  process.stdout.write(
    `${JSON.stringify({ type: 'a1.dev-catalog', template: template.version, plans })}\n`,
  );
} finally {
  await database.$disconnect();
}
