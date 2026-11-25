/**
 * Owner: Platform control plane — contracts for tenant provisioning (A1.1 #406)
 *
 * Authority: Phase Contract #388, lifecycle #389, saga #390, bootstrap #392, acceptance #393
 * and the decision on #406 (sipDomain derived from slug, `tenants.primary_domain`)
 *
 * This file is a pure contract: no I/O, no secrets and no tenant business data, and it does not import
 * `node:*`/DOM because this package can be bundled into the browser — normalization/hash/digest live in
 * `@d-contact/platform-control`, which is the sole authority on canonical input
 * control flow uses only the values in these unions — the same values must match the Postgres enum in the migration
 * `20260924090000_add_a1_platform_control_plane` (checked by the `@d-contact/platform-control` test)
 */
// ── Lifecycle (#389) ─────────────────────────────────────────────────────────

/** A1 tenant runtime status — no suspend/delete in this phase; all existing tenants are ACTIVE */
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
 * allowed transitions (#389): `CANCELLED` only before side effects start (`PENDING`) and
 * `ACTION_REQUIRED → RUNNING` only by an explicit operator action, no blind retry
 * a timeout does not make it `FAILED_FINAL` — it must always pass through `ACTION_REQUIRED` + an operator first
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

/** fixed step order — the next step may start once the previous step's receipt has committed */
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

/** saga constants (#390) — A1.1 keeps them in one place for A1.3 to use; not freely adjustable config */
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
 * `HELD` = a request not yet finished, `CONSUMED` = tenant `ACTIVE` (never reusable in A1),
 * `TOMBSTONED` = a `CANCELLED/FAILED_FINAL` request held for 30 days before a new request may use it
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

/** Keycloak execute-actions the first admin must complete before entering the tenant — D-Contact does not set the password */
export const FIRST_ADMIN_REQUIRED_ACTIONS = Object.freeze([
  'VERIFY_EMAIL',
  'UPDATE_PASSWORD',
  'CONFIGURE_TOTP',
] as const);

export const INVITATION_LIMITS = Object.freeze({
  /** action link valid for 72 hours — the DB CHECK enforces the same value */
  lifespanSeconds: 72 * 3600,
  resendPerHour: 3,
});

/**
 * `INTENT` = recorded before sending, `SENT` = the email provider accepted it (not user activated),
 * `FAILED` = proven not sent (can resend), `AMBIGUOUS` = outcome unknown, must reconcile, never fire again
 */
export const INVITATION_STATES = ['INTENT', 'SENT', 'FAILED', 'AMBIGUOUS'] as const;
export type InvitationState = (typeof INVITATION_STATES)[number];

// ── Bootstrap manifest + plan catalog (A1.5 #410, #392) ─────────────────────

/**
 * Operational baseline a new tenant receives — Admin Team ready to use, the rest are inactive drafts that the
 * Tenant Admin must review/activate themselves (#392 never takes traffic automatically)
 */
export interface BootstrapManifestV1 {
  schemaVersion: 1;
  adminTeam: { name: string };
  drafts: {
    generalTeam: { name: string };
    generalQueue: { name: string };
    /** Monday=1 … Sunday=7, time `HH:MM` in the tenant's timezone */
    businessHours: { name: string; weekly: { day: number; open: string; close: string }[] };
  };
}

/** entitlement/quota snapshot of a plan version — values are numbers or flags only */
export type PlanEntitlements = Readonly<Record<string, number | boolean>>;

/**
 * canonical JSON (sorted keys, no whitespace) — the manifest/plan digest is always computed from this
 * so readiness can re-check that the content used to seed matches what was pinned
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonicalJson: numbers must be finite');
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

/** Returns the list of invalid fields (empty = pass) — used at both publish and seed time */
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

/** fields editable after submit and the steps that must not have succeeded yet (#392 Correcting non-identity input) */
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
  /** A1.3: previewDigest does not match the current state — must preview again before executing recovery */
  'PREVIEW_STALE',
  /** A1.3: the recovery action's precondition failed (e.g. Retry while the resource already exists) */
  'RECOVERY_PRECONDITION_FAILED',
  /** A1.4: resend more than 3 times per hour (the DB trigger enforces this race-safely) */
  'INVITATION_RESEND_LIMITED',
  /** A1.5: plan version is not in the catalog or not ACTIVE */
  'PLAN_UNAVAILABLE',
  /** A1.5: this field can no longer be edited (identity, or the owning step already succeeded) */
  'FIELD_LOCKED',
  /** A1.6: an unfinished execute command exists for this request — a concurrent command is rejected deterministically */
  'COMMAND_IN_PROGRESS',
  /** A1.6: the control plane cannot commit/read (not an external dependency after the request was accepted) */
  'SERVICE_UNAVAILABLE',
  /** A1.8: `platformProvisioning.enabled` is off (rollback) — status/history readable, but no mutation */
  'PROVISIONING_DISABLED',
  /** missing, or a resource of another tenant/request — answer identically so existence is not revealed */
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
  /** A1.5: the operator edits a non-identity field before the field's owning step succeeds */
  'REQUEST_EDITED',
  /** A1.8: First admin onboarding event reconciled from Keycloak (actor `FIRST_ADMIN`) */
  'FIRST_ADMIN_EMAIL_VERIFIED',
  'FIRST_ADMIN_PASSWORD_SET',
  'FIRST_ADMIN_TOTP_ENROLLED',
  'FIRST_ADMIN_ACTIVATED',
] as const;
export type PlatformActionKind = (typeof PLATFORM_ACTION_KINDS)[number];

/** operator recovery when a request is `ACTION_REQUIRED` (#390) — every one must preview before execute */
export const PROVISIONING_RECOVERY_ACTIONS = [
  'RECONCILE',
  'RETRY_STEP',
  'SAFE_COMPENSATE',
  'MARK_FAILED_FINAL',
] as const;
export type ProvisioningRecoveryAction = (typeof PROVISIONING_RECOVERY_ACTIONS)[number];

export const PLATFORM_ACTOR_KINDS = [
  'PLATFORM_OPERATOR',
  'PLATFORM_AUDITOR',
  'SYSTEM',
  /** A1.8: subject = the first admin's Keycloak user id (opaque) */
  'FIRST_ADMIN',
] as const;
export type PlatformActorKind = (typeof PLATFORM_ACTOR_KINDS)[number];

// ── Operational input (canonicalization lives in `@d-contact/platform-control`) ───

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
