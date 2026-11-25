/**
 * Owner: Platform provisioning — bootstrap manifest + plan catalog (A1.5 #410)
 *
 * Authority: #392 (Bootstrap template authority/versioning, Plan binding)
 *
 * - manifests and plan snapshots are immutable once published (enforced by a DB trigger) — a change = issue a new version
 * - the digest is always computed from canonical JSON, so seed/readiness can re-verify that the content matches what was pinned
 * - `DEPRECATED`: an existing request can continue but a new request cannot select it; `REVOKED`: no new step may start
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

/** the digest binds code + version to the entitlement so the same snapshot cannot be swapped between versions */
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
  /** `database` = Prisma with role `dcontact_platform` */
  constructor(private readonly database: PrismaClient) {}

  /** idempotent: same version + same content = returns the existing one; different content in the same version = rejected */
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

  /** issues a new plan version (after the latest version) — concurrent publishes hit the PK and retry */
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

  /** the latest ACTIVE plan version — the value the API passes into `accept` to pin */
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
