/** A1.9 (#574): catalog สังเคราะห์สำหรับ UAT เท่านั้น; ไม่สร้าง tenant หรือ PII */
import { PrismaClient } from '@d-contact/db';
import { PlatformCatalog } from '@d-contact/platform-control';
import { canonicalJson } from '@d-contact/shared';

const url = process.env.PLATFORM_DATABASE_URL;
if (!url || !url.includes('/dcontact_uat?')) throw new Error('ต้องใช้ dcontact_uat เท่านั้น');
const database = new PrismaClient({ datasources: { db: { url } } });
const catalog = new PlatformCatalog(database);
const manifest = {
  schemaVersion: 1,
  adminTeam: { name: 'Admin Team' },
  drafts: {
    generalTeam: { name: 'General Team' },
    generalQueue: { name: 'General Queue' },
    businessHours: {
      name: 'Business hours',
      weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00' })),
    },
  },
};
const plans = {
  starter: { agent_seats: 5, queues: 2, recording: false },
  growth: { agent_seats: 25, queues: 10, recording: true },
  enterprise: { agent_seats: 100, queues: 50, recording: true },
};
try {
  const template = await catalog.publishBootstrapTemplate({
    version: 'uat-operational-v1',
    manifest,
  });
  if (template.status !== 'ACTIVE') throw new Error('UAT template ไม่ ACTIVE');
  for (const [planCode, entitlements] of Object.entries(plans)) {
    const existing = await database.pfPlanVersion.findFirst({
      where: { planCode, status: 'ACTIVE' },
      orderBy: { version: 'desc' },
    });
    if (existing) {
      if (canonicalJson(existing.entitlements) !== canonicalJson(entitlements)) {
        throw new Error(`plan ${planCode} มี ACTIVE version เนื้อหาไม่ตรง UAT seed`);
      }
    } else {
      await catalog.publishPlanVersion({ planCode, entitlements });
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      type: 'platform.uat.catalog',
      status: 'PASS',
      templateVersion: template.version,
      templateDigest: template.contentDigest,
      activePlans: Object.keys(plans),
    })}\n`,
  );
} finally {
  await database.$disconnect();
}
