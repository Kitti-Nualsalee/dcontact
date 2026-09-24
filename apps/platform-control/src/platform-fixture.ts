/**
 * Test support ของ A1.1 (#406) เท่านั้น — production path ไม่ import ไฟล์นี้
 *
 * repository ใช้ role `dcontact_platform` จริง (สิทธิ์ตาม migration) ส่วน owner ใช้ seed template,
 * จำลองเวลาผ่านไปของ tombstone และ cleanup เท่านั้น ค่าทั้งหมดสังเคราะห์และ unique ต่อ run
 */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@d-contact/db';
import type { BootstrapManifestV1, ProvisioningRequestInput } from '@d-contact/shared';
import { PlatformCatalog } from './platform-catalog.js';
import { ProvisioningControlRepository, type PlatformActor } from './provisioning-repository.js';

const PLATFORM_DATABASE_URL =
  process.env.PLATFORM_DATABASE_URL ??
  'postgresql://dcontact_platform:dcontact_platform@localhost:5433/dcontact?schema=public';
const PROVISIONER_DATABASE_URL =
  process.env.PROVISIONER_DATABASE_URL ??
  'postgresql://dcontact_provisioner:dcontact_provisioner@localhost:5433/dcontact?schema=public';
const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

export const OPERATOR: PlatformActor = {
  kind: 'PLATFORM_OPERATOR',
  subject: 'platform-operator-fixture',
  role: 'platform_operator',
  sessionRef: 'session-fixture',
};
export const WORKER: PlatformActor = { kind: 'SYSTEM', subject: 'provisioning-worker' };
export const SIP_BASE = 'sip.dcontact.test';

/** manifest v1 ของเทสต์ — ชื่อ/เวลาเป็นค่าสังเคราะห์ ไม่ใช่ baseline จริงของ production */
export const FIXTURE_MANIFEST: BootstrapManifestV1 = {
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

/** ตัวเลขที่ต่างกันต่อ run เพื่อให้ snapshot ของแต่ละ run ไม่ซ้ำกัน */
function sequenceSeed(run: string): number {
  return parseInt(run.slice(0, 6), 16);
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export type PlatformFixture = Awaited<ReturnType<typeof createPlatformFixture>>;

export async function createPlatformFixture() {
  const owner = new PrismaClient();
  const platform = new PrismaClient({ datasources: { db: { url: PLATFORM_DATABASE_URL } } });
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  /** A1.4: role ที่ saga worker ใช้เขียนข้อมูลตั้งต้นของ tenant (#388 decision) */
  const provisioner = new PrismaClient({ datasources: { db: { url: PROVISIONER_DATABASE_URL } } });
  const run = randomUUID().slice(0, 8);
  const templateVersion = `baseline-${run}`;
  const catalog = new PlatformCatalog(platform);
  const template = await catalog.publishBootstrapTemplate({
    version: templateVersion,
    manifest: FIXTURE_MANIFEST,
  });
  // plan version เป็น global ต่อ code — แต่ละ run ออก version ของตัวเองแล้วลบตอน dispose
  const publishedPlan = await catalog.publishPlanVersion({
    planCode: 'growth',
    entitlements: { agent_seats: 25, queues: 10, recording: true, run_marker: sequenceSeed(run) },
  });

  let sequence = 0;
  /** input ที่ slug/domain/email ไม่ซ้ำกับ run อื่น — override เพื่อทดสอบ conflict */
  const input = (overrides: Partial<ProvisioningRequestInput> = {}): ProvisioningRequestInput => {
    sequence += 1;
    const label = `a1-${run}-${sequence}`;
    return {
      displayName: `Fixture Customer ${sequence}`,
      slug: label,
      primaryDomain: `${label}.example.test`,
      locale: 'th-TH',
      timezone: 'Asia/Bangkok',
      planCode: 'growth',
      bootstrapTemplateVersion: templateVersion,
      firstAdmin: { email: `admin+${label}@example.test`, displayName: 'First Admin' },
      ...overrides,
    };
  };

  const repository = (now?: () => Date) =>
    new ProvisioningControlRepository(platform, {
      sipBaseDomain: SIP_BASE,
      ...(now ? { now } : {}),
    });

  const tenantIds = new Set<string>();

  return {
    owner,
    platform,
    application,
    provisioner,
    run,
    templateVersion,
    input,
    repository,
    catalog,
    template,
    publishedPlan,
    plan: { version: publishedPlan.version, snapshotDigest: publishedPlan.snapshotDigest },
    track(tenantId: string) {
      tenantIds.add(tenantId);
      return tenantId;
    },
    /** จำลองว่า tombstone หมดอายุแล้ว (DB ใช้ now() ของตัวเองเทียบ) */
    async expireTombstones(requestId: string) {
      await owner.$executeRaw`
        UPDATE "pf_identity_reservations"
           SET "tombstoned_until" = now() - interval '1 second', "revision" = "revision" + 1
         WHERE "request_id" = ${requestId}::uuid AND "state" = 'TOMBSTONED'`;
    },
    async dispose() {
      const ids = [...tenantIds];
      // ledger/audit ถูกห้ามลบด้วย trigger ทุก role — cleanup ของเทสต์ปิด trigger ด้วย superuser เท่านั้น
      await owner.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        for (const table of [
          'pf_operator_commands',
          'pf_first_admin_email_revisions',
          'pf_invitations',
          'pf_request_payload_revisions',
          'business_hours',
          'tenant_plan_bindings',
          'tenant_settings',
          'users',
          'queues',
          'teams',
          'pf_action_history',
          'pf_command_receipts',
          'pf_identity_reservations',
          'pf_provisioning_step_receipts',
          'pf_provisioning_steps',
          'pf_provisioning_requests',
        ]) {
          await transaction.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE "tenant_id" = ANY($1::uuid[])`,
            ids,
          );
        }
        await transaction.$executeRawUnsafe(
          `DELETE FROM "tenants" WHERE "id" = ANY($1::uuid[])`,
          ids,
        );
        await transaction.$executeRawUnsafe(
          `DELETE FROM "pf_bootstrap_templates" WHERE "version" = $1`,
          templateVersion,
        );
        await transaction.$executeRawUnsafe(
          `DELETE FROM "pf_plan_versions" WHERE "plan_code" = 'growth' AND "version" = $1`,
          publishedPlan.version,
        );
      });
      await Promise.all([
        owner.$disconnect(),
        platform.$disconnect(),
        application.$disconnect(),
        provisioner.$disconnect(),
      ]);
    },
  };
}
