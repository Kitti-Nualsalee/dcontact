/**
 * Owner: Platform provisioning — bootstrap manifest + plan catalog (A1.5 #410)
 *
 * Authority: #392 (Bootstrap template authority/versioning, Plan binding)
 *
 * - manifest และ plan snapshot immutable เมื่อ publish แล้ว (DB trigger บังคับ) — แก้ = ออก version ใหม่
 * - digest คำนวณจาก canonical JSON เสมอ จึงตรวจซ้ำตอน seed/readiness ได้ว่าเนื้อหาตรงกับที่ pin
 * - `DEPRECATED`: request เดิมทำต่อได้ แต่ request ใหม่เลือกไม่ได้; `REVOKED`: ห้ามเริ่ม step ใหม่
 */
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  bootstrapManifestErrors,
  canonicalJson,
  planEntitlementErrors,
  PlatformProvisioningError,
  type BootstrapManifestV1,
  type BootstrapTemplateStatus,
  type PlanEntitlements,
  type PlatformPlanCode,
} from '@d-contact/shared';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

export function bootstrapManifestDigest(manifest: BootstrapManifestV1): string {
  return sha256(canonicalJson(manifest));
}

/** digest ผูก code + version เข้ากับ entitlement เพื่อไม่ให้ snapshot เดียวกันสลับ version ได้ */
export function planSnapshotDigest(
  planCode: string,
  version: number,
  entitlements: PlanEntitlements,
): string {
  return sha256(canonicalJson({ planCode, version, entitlements }));
}

export interface PublishedPlan {
  planCode: PlatformPlanCode;
  version: number;
  snapshotDigest: string;
  entitlements: PlanEntitlements;
}

export class PlatformCatalog {
  /** `database` = Prisma ของ role `dcontact_platform` */
  constructor(private readonly database: PrismaClient) {}

  /** idempotent: version เดิม + เนื้อหาเดิม = คืนค่าเดิม; เนื้อหาต่างใน version เดิม = ปฏิเสธ */
  async publishBootstrapTemplate(input: { version: string; manifest: BootstrapManifestV1 }) {
    const errors = bootstrapManifestErrors(input.manifest);
    if (!/^[a-z0-9][a-z0-9._-]{1,63}$/.test(input.version)) errors.push('version');
    if (errors.length > 0) {
      throw new PlatformProvisioningError(
        'VALIDATION_FAILED',
        Object.fromEntries(errors.map((field) => [field, 'INVALID'])),
      );
    }
    const contentDigest = bootstrapManifestDigest(input.manifest);
    const existing = await this.database.pfBootstrapTemplate.findUnique({
      where: { version: input.version },
    });
    if (existing) {
      if (existing.contentDigest !== contentDigest) {
        throw new PlatformProvisioningError('VALIDATION_FAILED', { version: 'IMMUTABLE' });
      }
      return { version: existing.version, contentDigest, status: existing.status };
    }
    await this.database.pfBootstrapTemplate.create({
      data: {
        version: input.version,
        contentDigest,
        manifest: input.manifest as unknown as Prisma.InputJsonValue,
      },
    });
    return { version: input.version, contentDigest, status: 'ACTIVE' as const };
  }

  async setTemplateStatus(version: string, status: Exclude<BootstrapTemplateStatus, 'ACTIVE'>) {
    await this.database.pfBootstrapTemplate.update({ where: { version }, data: { status } });
  }

  /** ออก version ใหม่ของ plan (ต่อจาก version ล่าสุด) — publish พร้อมกันชน PK แล้วลองใหม่ */
  async publishPlanVersion(input: {
    planCode: PlatformPlanCode;
    entitlements: PlanEntitlements;
  }): Promise<PublishedPlan> {
    const errors = planEntitlementErrors(input.entitlements);
    if (errors.length > 0) {
      throw new PlatformProvisioningError(
        'VALIDATION_FAILED',
        Object.fromEntries(errors.map((field) => [field, 'INVALID'])),
      );
    }
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const latest = await this.database.pfPlanVersion.findFirst({
        where: { planCode: input.planCode },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;
      const snapshotDigest = planSnapshotDigest(input.planCode, version, input.entitlements);
      try {
        await this.database.pfPlanVersion.create({
          data: {
            planCode: input.planCode,
            version,
            snapshotDigest,
            entitlements: input.entitlements as Prisma.InputJsonValue,
          },
        });
        return {
          planCode: input.planCode,
          version,
          snapshotDigest,
          entitlements: input.entitlements,
        };
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          continue;
        throw error;
      }
    }
    throw new PlatformProvisioningError('REVISION_CONFLICT');
  }

  async setPlanStatus(
    planCode: PlatformPlanCode,
    version: number,
    status: Exclude<BootstrapTemplateStatus, 'ACTIVE'>,
  ) {
    await this.database.pfPlanVersion.update({
      where: { planCode_version: { planCode, version } },
      data: { status },
    });
  }

  /** plan version ล่าสุดที่ ACTIVE — ค่าที่ API ส่งเข้า `accept` เพื่อ pin */
  async activePlan(planCode: PlatformPlanCode): Promise<PublishedPlan> {
    const plan = await this.database.pfPlanVersion.findFirst({
      where: { planCode, status: 'ACTIVE' },
      orderBy: { version: 'desc' },
    });
    if (!plan) throw new PlatformProvisioningError('PLAN_UNAVAILABLE');
    return {
      planCode,
      version: plan.version,
      snapshotDigest: plan.snapshotDigest,
      entitlements: plan.entitlements as PlanEntitlements,
    };
  }
}
