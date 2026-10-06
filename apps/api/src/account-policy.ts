/**
 * Owner: IAM — นโยบายบัญชีของ tenant (AC1 #594, Phase Contract #589, ADR-033)
 *
 * - การแก้ email ของผู้ใช้: `VERIFY` (ค่าเริ่มต้น) | `IMMEDIATE` | `ADMIN_ONLY`; บังคับ 2FA: ค่าเริ่มต้นปิด
 * - ไม่มีแถว = ค่าเริ่มต้น และ `revision` = 0 — แถวแรกถูกสร้างตอน admin แก้ครั้งแรก
 * - ทุกการเปลี่ยนต้องมีเหตุผล 3–500 ตัวอักษร และเขียน audit ค่าก่อน/หลังใน transaction เดียวกัน
 * - เปลี่ยน `mfaRequired` ต้อง sync ไป Organization ของ Keycloak (`dc_mfa_required`) ผ่าน port ของ AC2
 *   ภายใน transaction — sync ล้ม = ไม่บันทึก; ยังไม่มี port = ปฏิเสธ (`MFA_ENFORCEMENT_UNAVAILABLE`)
 *   แทนการบันทึกค่าที่ระบบ identity ยังไม่บังคับจริง
 * - บังคับ 2FA มีผลตอน login ครั้งถัดไป ไม่ตัด session ที่ใช้อยู่ (#589 D10, ADR-026)
 */
import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export const EMAIL_CHANGE_POLICIES = ['VERIFY', 'IMMEDIATE', 'ADMIN_ONLY'] as const;
export type EmailChangePolicy = (typeof EMAIL_CHANGE_POLICIES)[number];

export interface AccountPolicy {
  emailChange: EmailChangePolicy;
  mfaRequired: boolean;
}

export const DEFAULT_ACCOUNT_POLICY: Readonly<AccountPolicy> = Object.freeze({
  emailChange: 'VERIFY',
  mfaRequired: false,
});

export interface AccountPolicyView extends AccountPolicy {
  /** 0 = ยังไม่เคยตั้ง (ใช้ค่าเริ่มต้น) */
  revision: number;
  updatedAt: string | null;
}

export type AccountPolicyErrorCode =
  'VALIDATION_FAILED' | 'REVISION_CONFLICT' | 'MFA_ENFORCEMENT_UNAVAILABLE';

export class AccountPolicyError extends Error {
  constructor(
    readonly code: AccountPolicyErrorCode,
    readonly field?: { field: string; reason: 'REQUIRED' | 'INVALID' },
  ) {
    super(code);
    this.name = 'AccountPolicyError';
  }
}

/**
 * sync การบังคับ 2FA ไป Organization ของ tenant ใน Keycloak — implement ใน AC2 (#595)
 * ต้อง idempotent: เรียกซ้ำด้วยค่าเดิมได้ผลเดิม
 */
export interface OrganizationMfaPort {
  setMfaRequired(tenantId: string, required: boolean): Promise<void>;
}

export interface AccountPolicyActor {
  tenantId: string;
  userId: string;
}

export interface AccountPolicyOptions {
  now?: () => Date;
  mfa?: OrganizationMfaPort;
}

type Tx = Prisma.TransactionClient;

/** อ่านนโยบายภายใน transaction ของ tenant — ใช้ร่วมกับ self-service API (AC4) */
export async function readAccountPolicy(tx: Tx, tenantId: string): Promise<AccountPolicyView> {
  const row = await tx.tenantAccountPolicy.findUnique({ where: { tenantId } });
  if (!row) return { ...DEFAULT_ACCOUNT_POLICY, revision: 0, updatedAt: null };
  return {
    emailChange: emailChangeOf(row.emailChangePolicy),
    mfaRequired: row.mfaRequired,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AccountPolicyService {
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly options: AccountPolicyOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  get(actor: AccountPolicyActor): Promise<AccountPolicyView> {
    return withTenantDatabaseTransaction(this.database, actor.tenantId, (tx) =>
      readAccountPolicy(tx, actor.tenantId),
    );
  }

  async update(
    actor: AccountPolicyActor,
    input: {
      emailChange?: unknown;
      mfaRequired?: unknown;
      reason?: unknown;
      expectedRevision?: unknown;
    },
    correlationId: string,
  ): Promise<AccountPolicyView> {
    const expectedRevision = revisionOf(input.expectedRevision);
    const reason = reasonOf(input.reason);
    if (input.emailChange === undefined && input.mfaRequired === undefined) {
      throw new AccountPolicyError('VALIDATION_FAILED', { field: 'body', reason: 'REQUIRED' });
    }
    const emailChange =
      input.emailChange === undefined ? undefined : requiredEmailChange(input.emailChange);
    if (input.mfaRequired !== undefined && typeof input.mfaRequired !== 'boolean') {
      throw new AccountPolicyError('VALIDATION_FAILED', {
        field: 'mfaRequired',
        reason: 'INVALID',
      });
    }
    const mfaRequired = input.mfaRequired as boolean | undefined;

    return withTenantDatabaseTransaction(this.database, actor.tenantId, async (tx) => {
      // แถวแรกยังไม่มีให้ lock — ล็อกต่อ tenant แทน (สอง admin แก้พร้อมกัน = คนหลังได้ REVISION_CONFLICT)
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${`tenant_account_policies:${actor.tenantId}`}))`,
      );
      const before = await readAccountPolicy(tx, actor.tenantId);
      if (before.revision !== expectedRevision) throw new AccountPolicyError('REVISION_CONFLICT');

      const next: AccountPolicy = {
        emailChange: emailChange ?? before.emailChange,
        mfaRequired: mfaRequired ?? before.mfaRequired,
      };
      // ไม่มีอะไรเปลี่ยน = ไม่เขียนแถวหรือ audit และไม่เพิ่ม revision (ส่งซ้ำได้ผลเดิม)
      if (next.emailChange === before.emailChange && next.mfaRequired === before.mfaRequired) {
        return before;
      }

      const now = this.now();
      const row = await tx.tenantAccountPolicy.upsert({
        where: { tenantId: actor.tenantId },
        create: {
          tenantId: actor.tenantId,
          emailChangePolicy: next.emailChange,
          mfaRequired: next.mfaRequired,
          revision: 1,
          updatedBy: actor.userId,
          updatedAt: now,
        },
        update: {
          emailChangePolicy: next.emailChange,
          mfaRequired: next.mfaRequired,
          revision: { increment: 1 },
          updatedBy: actor.userId,
          updatedAt: now,
        },
      });
      await tx.tenantAccountPolicyAuditEvent.create({
        data: {
          id: randomUUID(),
          tenantId: actor.tenantId,
          before: { emailChange: before.emailChange, mfaRequired: before.mfaRequired },
          after: { ...next },
          actorUserId: actor.userId,
          reason,
          correlationId,
          occurredAt: now,
        },
      });
      // sync เป็นขั้นสุดท้ายก่อน commit — ล้มแล้ว transaction ถูกยกเลิก ไม่มีนโยบายที่บังคับไม่ได้จริงค้างอยู่
      if (next.mfaRequired !== before.mfaRequired) {
        if (!this.options.mfa) throw new AccountPolicyError('MFA_ENFORCEMENT_UNAVAILABLE');
        await this.options.mfa.setMfaRequired(actor.tenantId, next.mfaRequired);
      }
      return {
        ...next,
        revision: row.revision,
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }
}

function emailChangeOf(value: string): EmailChangePolicy {
  return (EMAIL_CHANGE_POLICIES as readonly string[]).includes(value)
    ? (value as EmailChangePolicy)
    : DEFAULT_ACCOUNT_POLICY.emailChange;
}

function requiredEmailChange(value: unknown): EmailChangePolicy {
  if (typeof value === 'string' && (EMAIL_CHANGE_POLICIES as readonly string[]).includes(value)) {
    return value as EmailChangePolicy;
  }
  throw new AccountPolicyError('VALIDATION_FAILED', { field: 'emailChange', reason: 'INVALID' });
}

function reasonOf(value: unknown): string {
  if (value === undefined || value === null || value === '') {
    throw new AccountPolicyError('VALIDATION_FAILED', { field: 'reason', reason: 'REQUIRED' });
  }
  if (typeof value !== 'string') {
    throw new AccountPolicyError('VALIDATION_FAILED', { field: 'reason', reason: 'INVALID' });
  }
  const reason = value.trim();
  if (reason.length < 3 || reason.length > 500) {
    throw new AccountPolicyError('VALIDATION_FAILED', { field: 'reason', reason: 'INVALID' });
  }
  return reason;
}

function revisionOf(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return value;
  throw new AccountPolicyError('VALIDATION_FAILED', {
    field: 'expectedRevision',
    reason: value === undefined ? 'REQUIRED' : 'INVALID',
  });
}
