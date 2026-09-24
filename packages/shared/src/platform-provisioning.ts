/**
 * Owner: Platform control plane — contracts ของ tenant provisioning (A1.1 #406)
 *
 * Authority: Phase Contract #388, lifecycle #389, saga #390, bootstrap #392, acceptance #393
 * และ decision บน #406 (sipDomain derive จาก slug, `tenants.primary_domain`)
 *
 * ไฟล์นี้เป็นสัญญาล้วน: ไม่มี I/O, ไม่มี secret และไม่มี business data ของ tenant และไม่ import
 * `node:*`/DOM เพราะ package นี้ถูก bundle เข้า browser ได้ — normalization/hash/digest อยู่ฝั่ง
 * `@d-contact/platform-control` ซึ่งเป็น authority เดียวของ canonical input
 * control flow ใช้ค่าใน union เหล่านี้เท่านั้น — ค่าเดียวกันต้องตรงกับ Postgres enum ใน migration
 * `20260924090000_add_a1_platform_control_plane` (test ของ `@d-contact/platform-control` ตรวจให้)
 */
// ── Lifecycle (#389) ─────────────────────────────────────────────────────────

/** tenant runtime status ของ A1 — ไม่มี suspend/delete ในเฟสนี้; tenant เดิมทั้งหมดเป็น ACTIVE */
export const TENANT_LIFECYCLE_STATUSES = ['PROVISIONING', 'ACTIVE'] as const;
export type TenantLifecycleStatus = (typeof TENANT_LIFECYCLE_STATUSES)[number];

export const PROVISIONING_REQUEST_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'ACTION_REQUIRED',
  'FAILED_FINAL',
  'CANCELLED',
] as const;
export type ProvisioningRequestStatus = (typeof PROVISIONING_REQUEST_STATUSES)[number];

export const TERMINAL_PROVISIONING_STATUSES: readonly ProvisioningRequestStatus[] = Object.freeze([
  'SUCCEEDED',
  'FAILED_FINAL',
  'CANCELLED',
]);

/**
 * transition ที่อนุญาต (#389): `CANCELLED` ได้เฉพาะก่อนเริ่ม side effect (`PENDING`) และ
 * `ACTION_REQUIRED → RUNNING` ได้ด้วย explicit operator action เท่านั้น ไม่มี blind retry
 * timeout ไม่ทำให้เป็น `FAILED_FINAL` — ต้องผ่าน `ACTION_REQUIRED` + operator ก่อนเสมอ
 */
export const PROVISIONING_REQUEST_TRANSITIONS: Readonly<
  Record<ProvisioningRequestStatus, readonly ProvisioningRequestStatus[]>
> = Object.freeze({
  PENDING: ['RUNNING', 'CANCELLED'],
  RUNNING: ['SUCCEEDED', 'ACTION_REQUIRED'],
  ACTION_REQUIRED: ['RUNNING', 'FAILED_FINAL'],
  SUCCEEDED: [],
  FAILED_FINAL: [],
  CANCELLED: [],
});

export function isAllowedProvisioningTransition(
  from: ProvisioningRequestStatus,
  to: ProvisioningRequestStatus,
): boolean {
  return PROVISIONING_REQUEST_TRANSITIONS[from].includes(to);
}

// ── Saga steps (#390) ────────────────────────────────────────────────────────

/** ลำดับ step คงที่ — step ถัดไปเริ่มได้เมื่อ receipt ของ step ก่อนหน้า commit แล้ว */
export const PROVISIONING_STEP_KEYS = [
  'TENANT_RECORD',
  'KEYCLOAK_ORGANIZATION',
  'PLAN_BOOTSTRAP',
  'FIRST_ADMIN',
  'INVITATION',
  'READINESS',
] as const;
export type ProvisioningStepKey = (typeof PROVISIONING_STEP_KEYS)[number];

export const PROVISIONING_STEP_STATES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'ACTION_REQUIRED',
] as const;
export type ProvisioningStepState = (typeof PROVISIONING_STEP_STATES)[number];

/** ค่าคงที่ของ saga (#390) — A1.1 เก็บไว้ที่เดียวให้ A1.3 ใช้ ไม่ใช่ config ที่ปรับได้ตามใจ */
export const PROVISIONING_SAGA_LIMITS = Object.freeze({
  leaseSeconds: 120,
  heartbeatSeconds: 30,
  externalTimeoutSeconds: 60,
  maxAttempts: 5,
  requestDeadlineMinutes: 30,
});

// ── Identity reservation (#389) ──────────────────────────────────────────────

export const IDENTITY_RESERVATION_KINDS = ['SLUG', 'PRIMARY_DOMAIN', 'FIRST_ADMIN_EMAIL'] as const;
export type IdentityReservationKind = (typeof IDENTITY_RESERVATION_KINDS)[number];

/**
 * `HELD` = คำขอที่ยังไม่จบ, `CONSUMED` = tenant `ACTIVE` (ห้าม reuse ตลอดไปใน A1),
 * `TOMBSTONED` = คำขอ `CANCELLED/FAILED_FINAL` ถือไว้ 30 วันก่อนให้คำขอใหม่ใช้
 */
export const IDENTITY_RESERVATION_STATES = ['HELD', 'CONSUMED', 'TOMBSTONED'] as const;
export type IdentityReservationState = (typeof IDENTITY_RESERVATION_STATES)[number];

export const IDENTITY_TOMBSTONE_DAYS = 30;

// ── Bootstrap / plan (#392) ──────────────────────────────────────────────────

export const PLATFORM_PLAN_CODES = ['starter', 'growth', 'enterprise'] as const;
export type PlatformPlanCode = (typeof PLATFORM_PLAN_CODES)[number];

export const BOOTSTRAP_TEMPLATE_STATUSES = ['ACTIVE', 'DEPRECATED', 'REVOKED'] as const;
export type BootstrapTemplateStatus = (typeof BOOTSTRAP_TEMPLATE_STATUSES)[number];

// ── First Tenant Admin invitation (#392 Invitation contract) ─────────────────

/** Keycloak execute-actions ที่ first-admin ต้องทำก่อนเข้า tenant ได้ — D-Contact ไม่ตั้งรหัสผ่านให้ */
export const FIRST_ADMIN_REQUIRED_ACTIONS = Object.freeze([
  'VERIFY_EMAIL',
  'UPDATE_PASSWORD',
  'CONFIGURE_TOTP',
] as const);

export const INVITATION_LIMITS = Object.freeze({
  /** action link 72 ชั่วโมง — DB CHECK บังคับค่าเดียวกัน */
  lifespanSeconds: 72 * 3600,
  resendPerHour: 3,
});

/**
 * `INTENT` = บันทึกก่อนส่ง, `SENT` = email provider รับแล้ว (ไม่ใช่ user activated),
 * `FAILED` = พิสูจน์ได้ว่าไม่ได้ส่ง (ส่งใหม่ได้), `AMBIGUOUS` = ไม่รู้ผล ต้อง reconcile ห้ามยิงซ้ำ
 */
export const INVITATION_STATES = ['INTENT', 'SENT', 'FAILED', 'AMBIGUOUS'] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

// ── Bootstrap manifest + plan catalog (A1.5 #410, #392) ─────────────────────

/**
 * Operational baseline ที่ tenant ใหม่ได้รับ — Admin Team พร้อมใช้, ที่เหลือเป็น inactive draft ที่
 * Tenant Admin ต้อง review/activate เอง (#392 ห้ามรับ traffic อัตโนมัติ)
 */
export interface BootstrapManifestV1 {
  schemaVersion: 1;
  adminTeam: { name: string };
  drafts: {
    generalTeam: { name: string };
    generalQueue: { name: string };
    /** จันทร์=1 … อาทิตย์=7, เวลา `HH:MM` ตาม timezone ของ tenant */
    businessHours: { name: string; weekly: { day: number; open: string; close: string }[] };
  };
}

/** entitlement/quota snapshot ของ plan version — ค่าเป็นตัวเลขหรือ flag เท่านั้น */
export type PlanEntitlements = Readonly<Record<string, number | boolean>>;

/**
 * JSON แบบ canonical (key เรียง, ไม่มีช่องว่าง) — digest ของ manifest/plan คำนวณจากค่านี้เสมอ
 * จึงตรวจซ้ำตอน readiness ได้ว่าเนื้อหาที่ใช้ seed ตรงกับที่ pin ไว้
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonicalJson: ตัวเลขต้อง finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(',')}}`;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME = (value: unknown) =>
  typeof value === 'string' && value.trim() === value && value.length >= 1 && value.length <= 80;

/** คืนรายการ field ที่ผิด (ว่าง = ผ่าน) — ใช้ทั้งตอน publish และตอน seed */
export function bootstrapManifestErrors(value: unknown): string[] {
  const errors: string[] = [];
  const manifest = value as Partial<BootstrapManifestV1> | null;
  if (!manifest || typeof manifest !== 'object') return ['manifest'];
  if (manifest.schemaVersion !== 1) errors.push('schemaVersion');
  if (!NAME(manifest.adminTeam?.name)) errors.push('adminTeam.name');
  const drafts = manifest.drafts;
  if (!NAME(drafts?.generalTeam?.name)) errors.push('drafts.generalTeam.name');
  if (!NAME(drafts?.generalQueue?.name)) errors.push('drafts.generalQueue.name');
  if (!NAME(drafts?.businessHours?.name)) errors.push('drafts.businessHours.name');
  if (drafts?.generalTeam?.name === manifest.adminTeam?.name)
    errors.push('drafts.generalTeam.name');
  const weekly = drafts?.businessHours?.weekly;
  if (
    !Array.isArray(weekly) ||
    weekly.length > 7 ||
    new Set(weekly.map((slot) => slot?.day)).size !== weekly.length ||
    !weekly.every(
      (slot) =>
        Number.isInteger(slot?.day) &&
        slot.day >= 1 &&
        slot.day <= 7 &&
        TIME.test(slot.open) &&
        TIME.test(slot.close) &&
        slot.open < slot.close,
    )
  ) {
    errors.push('drafts.businessHours.weekly');
  }
  return errors;
}

export function planEntitlementErrors(value: unknown): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['entitlements'];
  return Object.entries(value)
    .filter(
      ([key, entry]) =>
        !/^[a-z][a-z0-9_]{1,63}$/.test(key) ||
        !(
          typeof entry === 'boolean' ||
          (typeof entry === 'number' && Number.isInteger(entry) && entry >= 0)
        ),
    )
    .map(([key]) => `entitlements.${key}`);
}

/** field ที่แก้ได้หลัง submit และ step ที่ต้องยังไม่สำเร็จ (#392 Correcting non-identity input) */
export const EDITABLE_REQUEST_FIELDS = Object.freeze({
  displayName: 'PLAN_BOOTSTRAP',
  locale: 'PLAN_BOOTSTRAP',
  timezone: 'PLAN_BOOTSTRAP',
  firstAdminDisplayName: 'FIRST_ADMIN',
} as const satisfies Record<string, ProvisioningStepKey>);
export type EditableRequestField = keyof typeof EDITABLE_REQUEST_FIELDS;

// ── Errors (#388 checkpoint 1) ───────────────────────────────────────────────

export const PLATFORM_PROVISIONING_ERROR_CODES = [
  'VALIDATION_FAILED',
  'TENANT_SLUG_CONFLICT',
  'TENANT_DOMAIN_CONFLICT',
  'FIRST_ADMIN_EMAIL_CONFLICT',
  'IDEMPOTENCY_KEY_REUSED',
  'REVISION_CONFLICT',
  'INVALID_STATE_TRANSITION',
  'BOOTSTRAP_TEMPLATE_UNAVAILABLE',
  /** A1.3: previewDigest ไม่ตรงสถานะปัจจุบัน — ต้อง preview ใหม่ก่อน execute recovery */
  'PREVIEW_STALE',
  /** A1.3: เงื่อนไขของ recovery action ไม่ผ่าน (เช่น Retry ขณะ resource มีอยู่แล้ว) */
  'RECOVERY_PRECONDITION_FAILED',
  /** A1.4: resend เกิน 3 ครั้งต่อชั่วโมง (DB trigger บังคับแบบ race-safe) */
  'INVITATION_RESEND_LIMITED',
  /** A1.5: plan version ไม่อยู่ใน catalog หรือไม่ ACTIVE */
  'PLAN_UNAVAILABLE',
  /** A1.5: field นี้แก้ไม่ได้แล้ว (identity หรือ step เจ้าของสำเร็จไปแล้ว) */
  'FIELD_LOCKED',
  /** missing หรือ resource ของ tenant/request อื่น — ตอบเหมือนกันเพื่อไม่เผย existence */
  'NOT_FOUND',
] as const;
export type PlatformProvisioningErrorCode = (typeof PLATFORM_PROVISIONING_ERROR_CODES)[number];

export class PlatformProvisioningError extends Error {
  constructor(
    readonly code: PlatformProvisioningErrorCode,
    readonly fieldErrors?: Readonly<Record<string, string>>,
  ) {
    super(`platform provisioning: ${code}`);
    this.name = 'PlatformProvisioningError';
  }
}

// ── Action history (#393 §5) ─────────────────────────────────────────────────

export const PLATFORM_ACTION_KINDS = [
  'REQUEST_ACCEPTED',
  'COMMAND_REPLAYED',
  'STATE_CHANGED',
  'STEP_STARTED',
  'STEP_SUCCEEDED',
  'STEP_ACTION_REQUIRED',
  'STEP_RETRY_SCHEDULED',
  'RECONCILE',
  'RETRY_STEP',
  'RESEND_INVITATION',
  'SAFE_COMPENSATE',
  'MARK_FAILED_FINAL',
  'CANCEL',
  'RESERVATION_TOMBSTONED',
  'SECURITY_DENIED',
  /** A1.5: operator แก้ field ที่ไม่ใช่ identity ก่อน step เจ้าของ field สำเร็จ */
  'REQUEST_EDITED',
] as const;
export type PlatformActionKind = (typeof PLATFORM_ACTION_KINDS)[number];

/** recovery ของ operator เมื่อ request `ACTION_REQUIRED` (#390) — ทุกตัวต้อง preview ก่อน execute */
export const PROVISIONING_RECOVERY_ACTIONS = [
  'RECONCILE',
  'RETRY_STEP',
  'SAFE_COMPENSATE',
  'MARK_FAILED_FINAL',
] as const;
export type ProvisioningRecoveryAction = (typeof PROVISIONING_RECOVERY_ACTIONS)[number];

export const PLATFORM_ACTOR_KINDS = ['PLATFORM_OPERATOR', 'PLATFORM_AUDITOR', 'SYSTEM'] as const;
export type PlatformActorKind = (typeof PLATFORM_ACTOR_KINDS)[number];

// ── Operational input (canonicalization อยู่ฝั่ง `@d-contact/platform-control`) ───

export interface ProvisioningRequestInput {
  displayName: string;
  slug: string;
  primaryDomain: string;
  locale: string;
  timezone: string;
  planCode: PlatformPlanCode;
  bootstrapTemplateVersion: string;
  firstAdmin: { email: string; displayName: string };
}

export interface CanonicalProvisioningRequest {
  displayName: string;
  slug: string;
  primaryDomain: string;
  locale: string;
  timezone: string;
  planCode: PlatformPlanCode;
  bootstrapTemplateVersion: string;
  firstAdminEmail: string;
  firstAdminDisplayName: string;
}
