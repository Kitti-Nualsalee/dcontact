/**
 * Owner: Platform provisioning + Tenant metadata — step PLAN_BOOTSTRAP และ READINESS (A1.5 #410)
 *
 * Authority: #392 (Bootstrap scope, Plan binding, Readiness evidence), #390 (verified adoption),
 * #388 decision "Tenant bootstrap write boundary"
 *
 * PLAN_BOOTSTRAP
 * - ใช้ manifest/plan snapshot ที่ request pin ไว้เท่านั้น และคำนวณ digest ซ้ำก่อน seed ทุกครั้ง
 *   (pinned catalog แก้ไม่ได้อยู่แล้ว แต่ digest ไม่ตรง = หยุด ไม่ใช่ seed จากค่าที่ไม่รู้ที่มา)
 * - seed ผ่าน `dcontact_provisioner` (RLS ยอมเฉพาะ tenant ที่ยัง PROVISIONING) ด้วย id ที่ deterministic
 *   ต่อ request: replay/worker ซ้ำ = `skipDuplicates` ไม่สร้างซ้ำ; แถวชื่อชนแต่ไม่ใช่ของเรา = MISMATCH
 * - Admin Team พร้อมใช้; General Team/Queue inactive และ business hours เป็น DRAFT — ไม่มี traffic
 *
 * READINESS
 * - พิสูจน์ก่อน ACTIVE: receipt ครบ, manifest/plan digest ตรง pin, settings ตรง request, baseline ครบ
 *   และ inactive, first-admin เป็นสมาชิก Admin Team และมี invitation ที่ส่งแล้ว, ไม่มี cross-tenant binding
 * - evidence ไม่มี email/ชื่อคน — digest ของ evidence ลง receipt เป็น `outputDigest`
 */
import { createHash } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  bootstrapManifestErrors,
  canonicalJson,
  PROVISIONING_STEP_KEYS,
  type BootstrapManifestV1,
  type PlanEntitlements,
} from '@d-contact/shared';
import { bootstrapManifestDigest, planSnapshotDigest } from './platform-catalog.js';
import { bootstrapRowIds, firstAdminUserId } from './provisioning-ids.js';
import {
  ProvisioningStepError,
  type ProvisioningAdoption,
  type ProvisioningStepContext,
  type ProvisioningStepPort,
} from './provisioning-saga.js';

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/** อ่าน manifest/plan ที่ pin แล้วตรวจ digest ซ้ำ — ใช้ร่วมกันระหว่าง seed และ readiness */
async function loadPinned(platform: PrismaClient, context: ProvisioningStepContext) {
  const { request } = context;
  const template = await platform.pfBootstrapTemplate.findUnique({
    where: { version: request.bootstrapTemplateVersion },
  });
  const manifest = template?.manifest as unknown as BootstrapManifestV1 | undefined;
  const manifestOk =
    template !== null &&
    manifest !== undefined &&
    template.contentDigest === request.bootstrapTemplateDigest &&
    bootstrapManifestErrors(manifest).length === 0 &&
    bootstrapManifestDigest(manifest) === template.contentDigest;
  const plan = await platform.pfPlanVersion.findUnique({
    where: { planCode_version: { planCode: request.planCode, version: request.planVersion } },
  });
  const entitlements = plan?.entitlements as PlanEntitlements | undefined;
  const planOk =
    plan !== null &&
    entitlements !== undefined &&
    plan.snapshotDigest === request.planSnapshotDigest &&
    planSnapshotDigest(plan.planCode, plan.version, entitlements) === plan.snapshotDigest;
  return {
    manifest: manifestOk ? manifest! : null,
    templateStatus: template?.status ?? null,
    entitlements: planOk ? entitlements! : null,
  };
}

// ── PLAN_BOOTSTRAP ──────────────────────────────────────────────────────────

export class TenantBootstrapPort implements ProvisioningStepPort {
  constructor(
    /** Prisma ของ `dcontact_platform` — อ่าน catalog */
    private readonly platform: PrismaClient,
    /** Prisma ของ `dcontact_provisioner` — seed tenant rows */
    private readonly provisioner: PrismaClient,
  ) {}

  async find(context: ProvisioningStepContext): Promise<ProvisioningAdoption> {
    const ids = bootstrapRowIds(context.requestId);
    const settings = await this.provisioner.tenantSettings.findUnique({
      where: { tenantId: context.tenantId },
    });
    if (settings && settings.provisioningRequestId !== context.requestId) {
      return { status: 'MISMATCH', code: 'BOOTSTRAP_CORRELATION_MISMATCH' };
    }
    const [teams, queues, hours, binding] = await Promise.all([
      this.provisioner.team.findMany({ where: { tenantId: context.tenantId } }),
      this.provisioner.queue.findMany({ where: { tenantId: context.tenantId } }),
      this.provisioner.businessHours.findMany({ where: { tenantId: context.tenantId } }),
      this.provisioner.tenantPlanBinding.findUnique({ where: { tenantId: context.tenantId } }),
    ]);
    const ours = new Set(Object.values(ids));
    // แถวใน tenant นี้ที่ไม่ได้มาจาก request นี้ = มีคนเขียนก่อน — ห้าม adopt
    if ([...teams, ...queues, ...hours].some((row) => !ours.has(row.id))) {
      return { status: 'MISMATCH', code: 'BOOTSTRAP_CORRELATION_MISMATCH' };
    }
    if (binding && binding.provisioningRequestId !== context.requestId) {
      return { status: 'MISMATCH', code: 'BOOTSTRAP_CORRELATION_MISMATCH' };
    }
    const complete =
      settings !== null &&
      binding !== null &&
      teams.length === 2 &&
      queues.length === 1 &&
      hours.length === 1;
    if (!complete) return { status: 'NOT_FOUND' };
    return {
      status: 'FOUND',
      externalRef: `bootstrap:${context.requestId}`,
      outputDigest: sha256(
        canonicalJson({
          template: settings.bootstrapTemplateDigest,
          plan: binding.snapshotDigest,
          rows: Object.values(ids).sort(),
        }),
      ),
    };
  }

  async execute(context: ProvisioningStepContext) {
    const { request } = context;
    const pinned = await loadPinned(this.platform, context);
    if (pinned.templateStatus === 'REVOKED') {
      throw new ProvisioningStepError('PERMANENT', 'BOOTSTRAP_TEMPLATE_REVOKED');
    }
    if (!pinned.manifest) {
      throw new ProvisioningStepError('PERMANENT', 'BOOTSTRAP_MANIFEST_DIGEST_MISMATCH');
    }
    if (!pinned.entitlements)
      throw new ProvisioningStepError('PERMANENT', 'PLAN_SNAPSHOT_MISMATCH');
    const { manifest, entitlements } = pinned;
    const ids = bootstrapRowIds(context.requestId);
    const tenantId = context.tenantId;

    await this.provisioner.$transaction(async (transaction) => {
      await transaction.team.createMany({
        data: [
          { id: ids.adminTeamId, tenantId, name: manifest.adminTeam.name, isActive: true },
          {
            id: ids.generalTeamId,
            tenantId,
            name: manifest.drafts.generalTeam.name,
            isActive: false,
          },
        ],
        skipDuplicates: true,
      });
      await transaction.queue.createMany({
        data: [
          {
            id: ids.generalQueueId,
            tenantId,
            name: manifest.drafts.generalQueue.name,
            channels: [],
            teamId: ids.generalTeamId,
            isActive: false,
          },
        ],
        skipDuplicates: true,
      });
      await transaction.businessHours.createMany({
        data: [
          {
            id: ids.businessHoursId,
            tenantId,
            name: manifest.drafts.businessHours.name,
            timezone: request.timezone,
            weekly: manifest.drafts.businessHours.weekly as unknown as Prisma.InputJsonValue,
            status: 'DRAFT',
          },
        ],
        skipDuplicates: true,
      });
      await transaction.tenantSettings.createMany({
        data: [
          {
            tenantId,
            locale: request.locale,
            timezone: request.timezone,
            bootstrapTemplateVersion: request.bootstrapTemplateVersion,
            bootstrapTemplateDigest: request.bootstrapTemplateDigest,
            provisioningRequestId: context.requestId,
          },
        ],
        skipDuplicates: true,
      });
      await transaction.tenantPlanBinding.createMany({
        data: [
          {
            tenantId,
            planCode: request.planCode,
            planVersion: request.planVersion,
            snapshotDigest: request.planSnapshotDigest,
            entitlements: entitlements as Prisma.InputJsonValue,
            provisioningRequestId: context.requestId,
          },
        ],
        skipDuplicates: true,
      });
    });

    const adoption = await this.find(context);
    if (adoption.status === 'FOUND') {
      return {
        externalRef: adoption.externalRef,
        ...(adoption.outputDigest ? { outputDigest: adoption.outputDigest } : {}),
      };
    }
    throw new ProvisioningStepError(
      adoption.status === 'MISMATCH' ? 'PERMANENT' : 'AMBIGUOUS',
      adoption.status === 'MISMATCH' ? adoption.code : 'BOOTSTRAP_READ_BACK_FAILED',
    );
  }
}

// ── READINESS ───────────────────────────────────────────────────────────────

export const READINESS_CHECKS = [
  'RECEIPTS',
  'MANIFEST',
  'PLAN',
  'SETTINGS',
  'BASELINE',
  'ADMIN',
  'INVITATION',
  'ISOLATION',
  'IDENTITY',
] as const;
export type ReadinessCheck = (typeof READINESS_CHECKS)[number];

export interface ReadinessReport {
  passed: boolean;
  failed: ReadinessCheck[];
  /** ไม่มี email/ชื่อคน — id เป็น UUID และ digest เท่านั้น */
  evidence: Record<string, unknown>;
  evidenceDigest: string;
}

export class TenantReadinessPort implements ProvisioningStepPort {
  constructor(
    private readonly platform: PrismaClient,
    private readonly provisioner: PrismaClient,
    /** ตรวจ identity ภายนอก (Keycloak) ว่ายังตรง correlation — ไม่ส่งมา = ข้ามการตรวจภายนอก */
    private readonly identity?: (context: ProvisioningStepContext) => Promise<boolean>,
  ) {}

  /** readiness ไม่มี resource ภายนอกให้ adopt — ประเมินใหม่ทุก attempt */
  async find(): Promise<ProvisioningAdoption> {
    return { status: 'NOT_FOUND' };
  }

  async execute(context: ProvisioningStepContext) {
    const report = await this.evaluate(context);
    if (!report.passed) {
      throw new ProvisioningStepError('PERMANENT', `READINESS_${report.failed[0]}_FAILED`);
    }
    return { externalRef: `readiness:${context.requestId}`, outputDigest: report.evidenceDigest };
  }

  async evaluate(context: ProvisioningStepContext): Promise<ReadinessReport> {
    const { request, tenantId, requestId } = context;
    const ids = bootstrapRowIds(requestId);
    const adminUserId = firstAdminUserId(requestId);
    const failed = new Set<ReadinessCheck>();
    const check = (name: ReadinessCheck, ok: boolean) => {
      if (!ok) failed.add(name);
    };

    // 1) step ก่อนหน้าสำเร็จครบและมี receipt SUCCEEDED
    const readinessOrdinal = PROVISIONING_STEP_KEYS.indexOf('READINESS');
    const prior = PROVISIONING_STEP_KEYS.slice(0, readinessOrdinal);
    const [steps, receipts] = await Promise.all([
      this.platform.pfProvisioningStep.findMany({ where: { requestId } }),
      this.platform.pfProvisioningStepReceipt.findMany({
        where: { requestId, outcome: 'SUCCEEDED' },
        select: { stepKey: true },
      }),
    ]);
    const succeeded = new Set(
      steps.filter((step) => step.state === 'SUCCEEDED').map((s) => s.stepKey),
    );
    const receipted = new Set(receipts.map((receipt) => receipt.stepKey));
    // TENANT_RECORD สำเร็จใน transaction ของ accept จึงไม่มี receipt ของ worker
    check(
      'RECEIPTS',
      prior.every((key) => succeeded.has(key) && (key === 'TENANT_RECORD' || receipted.has(key))),
    );

    // 2–3) manifest/plan ตรง pin และ digest คำนวณซ้ำได้
    const pinned = await loadPinned(this.platform, context);
    check('MANIFEST', pinned.manifest !== null && pinned.templateStatus !== 'REVOKED');
    const binding = await this.provisioner.tenantPlanBinding.findUnique({ where: { tenantId } });
    check(
      'PLAN',
      pinned.entitlements !== null &&
        binding !== null &&
        binding.provisioningRequestId === requestId &&
        binding.planCode === request.planCode &&
        binding.planVersion === request.planVersion &&
        binding.snapshotDigest === request.planSnapshotDigest &&
        planSnapshotDigest(
          binding.planCode,
          binding.planVersion,
          binding.entitlements as PlanEntitlements,
        ) === request.planSnapshotDigest,
    );

    // 4) settings ตรงกับ request ปัจจุบัน (รวมค่าที่ operator แก้ก่อน bootstrap)
    const settings = await this.provisioner.tenantSettings.findUnique({ where: { tenantId } });
    check(
      'SETTINGS',
      settings !== null &&
        settings.provisioningRequestId === requestId &&
        settings.locale === request.locale &&
        settings.timezone === request.timezone &&
        settings.bootstrapTemplateVersion === request.bootstrapTemplateVersion &&
        settings.bootstrapTemplateDigest === request.bootstrapTemplateDigest,
    );

    // 5) baseline ครบ ไม่เกิน และทุกอย่างนอก Admin Team ยัง inactive (ไม่มี traffic อัตโนมัติ)
    const [teams, queues, hours, users] = await Promise.all([
      this.provisioner.team.findMany({ where: { tenantId } }),
      this.provisioner.queue.findMany({ where: { tenantId } }),
      this.provisioner.businessHours.findMany({ where: { tenantId } }),
      this.provisioner.user.findMany({
        where: { tenantId },
        select: {
          id: true,
          tenantId: true,
          role: true,
          keycloakId: true,
          teamId: true,
          isActive: true,
        },
      }),
    ]);
    const team = (id: string) => teams.find((row) => row.id === id);
    const manifest = pinned.manifest;
    check(
      'BASELINE',
      manifest !== null &&
        teams.length === 2 &&
        team(ids.adminTeamId)?.isActive === true &&
        team(ids.adminTeamId)?.name === manifest.adminTeam.name &&
        team(ids.generalTeamId)?.isActive === false &&
        team(ids.generalTeamId)?.name === manifest.drafts.generalTeam.name &&
        queues.length === 1 &&
        queues[0]!.id === ids.generalQueueId &&
        queues[0]!.isActive === false &&
        queues[0]!.teamId === ids.generalTeamId &&
        queues[0]!.channels.length === 0 &&
        hours.length === 1 &&
        hours[0]!.id === ids.businessHoursId &&
        hours[0]!.status === 'DRAFT' &&
        hours[0]!.timezone === request.timezone &&
        canonicalJson(hours[0]!.weekly) === canonicalJson(manifest.drafts.businessHours.weekly),
    );

    // 6) first-admin คนเดียว เป็น ADMIN ของ Admin Team และผูก Keycloak identity แล้ว
    const admin = users.find((user) => user.id === adminUserId);
    check(
      'ADMIN',
      users.length === 1 &&
        admin !== undefined &&
        admin.role === 'ADMIN' &&
        admin.isActive &&
        admin.keycloakId !== null &&
        admin.teamId === ids.adminTeamId,
    );

    // 7) invitation intent ล่าสุดถูกส่งแล้ว (delivery accepted) ถึง identity เดียวกัน
    const invitation = await this.platform.pfInvitation.findFirst({
      where: { requestId },
      orderBy: { generation: 'desc' },
    });
    check(
      'INVITATION',
      invitation !== null &&
        invitation.state === 'SENT' &&
        invitation.supersededAt === null &&
        invitation.keycloakUserId === admin?.keycloakId,
    );

    // 8) ไม่มี binding ข้าม tenant: ทุก reference ชี้แถวของ tenant นี้ และ Keycloak identity
    //    ไม่ถูกผูกกับ users ของ tenant อื่นที่ provisioner มองเห็น
    const teamIds = new Set(teams.map((row) => row.id));
    const sharedIdentity = admin?.keycloakId
      ? await this.provisioner.user.count({
          where: { keycloakId: admin.keycloakId, tenantId: { not: tenantId } },
        })
      : 0;
    check(
      'ISOLATION',
      [...teams, ...queues, ...hours, ...users].every((row) => row.tenantId === tenantId) &&
        queues.every((row) => row.teamId === null || teamIds.has(row.teamId)) &&
        users.every((row) => row.teamId === null || teamIds.has(row.teamId)) &&
        settings?.tenantId === tenantId &&
        binding?.tenantId === tenantId &&
        sharedIdentity === 0,
    );

    // 9) identity ภายนอกยังตรง correlation (เช่น Keycloak Organization membership)
    if (this.identity) check('IDENTITY', await this.identity(context).catch(() => false));

    const evidence = {
      requestId,
      tenantId,
      templateDigest: request.bootstrapTemplateDigest,
      planSnapshotDigest: request.planSnapshotDigest,
      counts: {
        teams: teams.length,
        queues: queues.length,
        businessHours: hours.length,
        users: users.length,
      },
      inactiveDrafts: {
        generalTeam: team(ids.generalTeamId)?.isActive === false,
        generalQueue: queues[0]?.isActive === false,
        businessHours: hours[0]?.status === 'DRAFT',
      },
      invitationGeneration: invitation?.generation ?? null,
      identityChecked: this.identity !== undefined,
      failed: [...failed],
    };
    return {
      passed: failed.size === 0,
      failed: READINESS_CHECKS.filter((name) => failed.has(name)),
      evidence,
      evidenceDigest: sha256(canonicalJson(evidence)),
    };
  }
}
