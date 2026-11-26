/**
 * A1 dev/UAT only: publish bootstrap templates and plans so the Platform Console can select them locally
 * (`pnpm a1:dev-catalog`)
 *
 * The entitlement values below are **test values**, not a production product decision —
 * production publishes the catalog through `PlatformCatalog` per the plan/pricing decision
 * idempotent: same template version with the same content = no-op; a plan gets a new version only when none is ACTIVE
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
      name: 'เวลาทำการ', // allow-thai: persisted default business hours name written to every tenant
      weekly: [1, 2, 3, 4, 5].map((day) => ({ day, open: '09:00', close: '18:00' })),
    },
  },
};

// D1.12 (#451): module keys the Navigation API uses to filter apps (ADR-025 journey, ADR-027 contact governance)
// enabled on every dev plan only — deciding which module a real package gets is L1 work (ADR-009)
const DEV_MODULES = { module_journey: true, module_contact_governance: true };
const DEV_PLANS: Record<PlatformPlanCode, Record<string, number | boolean>> = {
  starter: { agent_seats: 5, queues: 3, dev_only: true, ...DEV_MODULES },
  growth: { agent_seats: 25, queues: 10, dev_only: true, ...DEV_MODULES },
  enterprise: { agent_seats: 200, queues: 50, dev_only: true, ...DEV_MODULES },
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
