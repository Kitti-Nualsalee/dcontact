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
