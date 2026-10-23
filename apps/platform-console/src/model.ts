import type { MessageKey } from './i18n/messages.js';

/**
 * Owner: Platform Console — logic ล้วนของ Guided onboarding (A1.7 #412)
 *
 * Authority: #391 (baseline A — Guided onboarding), #388 checkpoint 1 (API/error contract), #387
 *
 * - validation ฝั่ง UI เป็นแค่ UX: API เป็น authority ของทุกค่า (field error จาก server ชนะเสมอ)
 * - สถานะ/plan/tenant ที่แสดงมาจาก response ของ API เท่านั้น — UI ไม่สรุปว่าสำเร็จก่อน `ACTIVE`
 * - ไม่มี PII ใน URL: route มีแค่ requestId (opaque UUID); คำค้นหาอยู่ใน memory
 */

// ── API shapes (subset ที่ UI ใช้) ───────────────────────────────────────────

export type RequestStatus =
  'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'ACTION_REQUIRED' | 'FAILED_FINAL' | 'CANCELLED';
export type StepKey =
  | 'TENANT_RECORD'
  | 'KEYCLOAK_ORGANIZATION'
  | 'PLAN_BOOTSTRAP'
  | 'FIRST_ADMIN'
  | 'INVITATION'
  | 'READINESS';
export type StepState = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'ACTION_REQUIRED';
export type Capability = 'CONTROL_PLANE_READ' | 'PROVISIONING_MUTATE';
export type RecoveryAction = 'RECONCILE' | 'RETRY_STEP' | 'SAFE_COMPENSATE' | 'MARK_FAILED_FINAL';

/** A1.8: rollout ของ mutation — API ตัด `PROVISIONING_MUTATE` ออกเองเมื่อไม่ใช่ `ALLOWED` */
export type MutationRollout = 'ALLOWED' | 'DISABLED' | 'NOT_ALLOWLISTED' | 'NOT_GRANTED';

export interface SessionView {
  subject: string;
  roles: string[];
  capabilities: Capability[];
  mutations?: MutationRollout;
  expiresAt: string;
}

export interface CatalogView {
  plans: { code: string; version: number; entitlements: Record<string, number | boolean> }[];
  templates: { version: string; contentDigest: string; publishedAt: string }[];
}

export interface CommandView {
  commandId: string;
  requestId: string;
  kind: 'PREVIEW' | 'EXECUTE';
  action: RecoveryAction | 'RESEND_INVITATION';
  state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'REJECTED';
  errorCode: string | null;
  result: Record<string, unknown> | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface RequestView {
  requestId: string;
  tenantId: string;
  status: RequestStatus;
  revision: number;
  failureCode: string | null;
  displayName: string;
  slug: string;
  primaryDomain: string;
  locale: string;
  timezone: string;
  plan: { code: string; version: number };
  bootstrapTemplateVersion: string;
  firstAdmin: { emailMasked: string; displayName: string };
  acceptedAt: string;
  deadlineAt: string;
  terminalAt: string | null;
  steps: {
    stepKey: StepKey;
    state: StepState;
    attempt: number;
    errorCode: string | null;
    nextAttemptAt: string | null;
    finishedAt: string | null;
  }[];
  invitation: {
    generation: number;
    delivery: 'INTENT' | 'SENT' | 'FAILED' | 'AMBIGUOUS';
    sentAt: string | null;
    expiresAt: string | null;
    expired: boolean;
    resendsInLastHour: number;
  } | null;
  commands: CommandView[];
}

export interface TenantSummary {
  tenantId: string;
  name: string;
  slug: string;
  primaryDomain: string | null;
  lifecycleStatus: 'PROVISIONING' | 'ACTIVE';
  legacy: boolean;
  request: { requestId: string; status: RequestStatus; revision: number; updatedAt: string } | null;
  createdAt: string;
}

export interface ActionHistoryItem {
  id: string;
  requestId: string;
  action: string;
  outcome: string;
  actor: {
    kind: 'SYSTEM' | 'PLATFORM_OPERATOR' | 'PLATFORM_AUDITOR' | 'FIRST_ADMIN';
    subject: string;
    role: string | null;
  };
  stepKey: StepKey | null;
  attempt: number | null;
  beforeState: string | null;
  afterState: string | null;
  reasonCode: string | null;
  comment: string | null;
  errorCode: string | null;
  correlationId: string;
  occurredAt: string;
}

export interface ErrorEnvelope {
  status: number;
  code: string;
  title: string;
  correlationId: string | null;
  requestId?: string;
  retryable: boolean;
  fieldErrors?: Record<string, string>;
}

// ── Draft + validation ──────────────────────────────────────────────────────

export interface TenantDraft {
  displayName: string;
  slug: string;
  primaryDomain: string;
  planCode: string;
  locale: string;
  timezone: string;
  bootstrapTemplateVersion: string;
  firstAdminDisplayName: string;
  firstAdminEmail: string;
}

export const EMPTY_DRAFT: TenantDraft = {
  displayName: '',
  slug: '',
  primaryDomain: '',
  planCode: '',
  locale: 'th-TH',
  timezone: 'Asia/Bangkok',
  bootstrapTemplateVersion: '',
  firstAdminDisplayName: '',
  firstAdminEmail: '',
};

export const LOCALES = [
  { value: 'th-TH', label: 'locales.th' },
  { value: 'en-US', label: 'locales.en' },
] as const;

export const TIMEZONES = ['Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'UTC'] as const;

/** ชื่อ field ใน form ↔ key ของ `fieldErrors` จาก API */
export const FIELD_LABELS: Record<keyof TenantDraft, MessageKey> = {
  displayName: 'fields.displayName',
  slug: 'fields.slug',
  primaryDomain: 'fields.primaryDomain',
  planCode: 'fields.planCode',
  locale: 'fields.locale',
  timezone: 'fields.timezone',
  bootstrapTemplateVersion: 'fields.bootstrapTemplateVersion',
  firstAdminDisplayName: 'fields.firstAdminDisplayName',
  firstAdminEmail: 'fields.firstAdminEmail',
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const DOMAIN = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

/** ตรวจเบื้องต้นก่อน review — server ตรวจซ้ำทุกค่าและเป็นผู้ตัดสิน */
export function validateDraft(draft: TenantDraft): Partial<Record<keyof TenantDraft, MessageKey>> {
  const errors: Partial<Record<keyof TenantDraft, MessageKey>> = {};
  const name = draft.displayName.trim();
  if (name.length < 2 || name.length > 120) errors.displayName = 'validation.displayName';
  const slug = draft.slug.trim().toLowerCase();
  if (!SLUG.test(slug) || slug.includes('--')) {
    errors.slug = 'validation.slug';
  }
  if (!DOMAIN.test(draft.primaryDomain.trim().replace(/\.$/, ''))) {
    errors.primaryDomain = 'validation.primaryDomain';
  }
  if (!draft.planCode) errors.planCode = 'validation.planCode';
  if (!draft.bootstrapTemplateVersion)
    errors.bootstrapTemplateVersion = 'validation.bootstrapTemplateVersion';
  if (!LOCALES.some((locale) => locale.value === draft.locale)) errors.locale = 'validation.locale';
  if (!draft.timezone) errors.timezone = 'validation.timezone';
  const adminName = draft.firstAdminDisplayName.trim();
  if (adminName.length < 1 || adminName.length > 120)
    errors.firstAdminDisplayName = 'validation.firstAdminDisplayName';
  if (!EMAIL.test(draft.firstAdminEmail.trim()))
    errors.firstAdminEmail = 'validation.firstAdminEmail';
  return errors;
}

/** body ของ POST /provisioning-requests — ไม่มี tenantId/status: server เป็นผู้กำหนด */
export function draftToRequestBody(draft: TenantDraft) {
  return {
    displayName: draft.displayName.trim(),
    slug: draft.slug.trim().toLowerCase(),
    primaryDomain: draft.primaryDomain.trim().toLowerCase().replace(/\.$/, ''),
    planCode: draft.planCode,
    locale: draft.locale,
    timezone: draft.timezone,
    bootstrapTemplateVersion: draft.bootstrapTemplateVersion,
    firstAdmin: {
      email: draft.firstAdminEmail.trim(),
      displayName: draft.firstAdminDisplayName.trim(),
    },
  };
}

/** API ใช้ชื่อ field ของตัวเอง — map กลับเข้า form เพื่อโฟกัส/แสดงผลถูกช่อง */
export function fieldErrorsToDraft(
  fieldErrors: Record<string, string> | undefined,
): Partial<Record<keyof TenantDraft, MessageKey>> {
  const map: Record<string, keyof TenantDraft> = {
    displayName: 'displayName',
    slug: 'slug',
    primaryDomain: 'primaryDomain',
    planCode: 'planCode',
    locale: 'locale',
    timezone: 'timezone',
    bootstrapTemplateVersion: 'bootstrapTemplateVersion',
    'firstAdmin.email': 'firstAdminEmail',
    'firstAdmin.displayName': 'firstAdminDisplayName',
  };
  const result: Partial<Record<keyof TenantDraft, MessageKey>> = {};
  for (const [field, value] of Object.entries(fieldErrors ?? {})) {
    const key = Object.hasOwn(map, field) ? map[field] : undefined;
    if (key)
      result[key] = Object.hasOwn(ERROR_MESSAGES, value)
        ? ERROR_MESSAGES[value]
        : 'validation.serverInvalid';
  }
  return result;
}

/** key ของ draft แต่ละครั้งที่กด submit (ลองซ้ำหลัง network error = key เดิม → ไม่สร้างซ้ำ) */
export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// ── Presentation ────────────────────────────────────────────────────────────

export const STEP_LABELS: Record<StepKey, { title: MessageKey; detail: MessageKey }> = {
  TENANT_RECORD: {
    title: 'steps.TENANT_RECORD.title',
    detail: 'steps.TENANT_RECORD.detail',
  },
  KEYCLOAK_ORGANIZATION: {
    title: 'steps.KEYCLOAK_ORGANIZATION.title',
    detail: 'steps.KEYCLOAK_ORGANIZATION.detail',
  },
  PLAN_BOOTSTRAP: {
    title: 'steps.PLAN_BOOTSTRAP.title',
    detail: 'steps.PLAN_BOOTSTRAP.detail',
  },
  FIRST_ADMIN: { title: 'steps.FIRST_ADMIN.title', detail: 'steps.FIRST_ADMIN.detail' },
  INVITATION: { title: 'steps.INVITATION.title', detail: 'steps.INVITATION.detail' },
  READINESS: { title: 'steps.READINESS.title', detail: 'steps.READINESS.detail' },
};

export const STATUS_LABELS: Record<RequestStatus, { label: MessageKey; tone: Tone }> = {
  PENDING: { label: 'statuses.PENDING', tone: 'neutral' },
  RUNNING: { label: 'statuses.RUNNING', tone: 'info' },
  SUCCEEDED: { label: 'statuses.SUCCEEDED', tone: 'success' },
  ACTION_REQUIRED: { label: 'statuses.ACTION_REQUIRED', tone: 'danger' },
  FAILED_FINAL: { label: 'statuses.FAILED_FINAL', tone: 'danger' },
  CANCELLED: { label: 'statuses.CANCELLED', tone: 'neutral' },
};

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/** สถานะที่ยังเปลี่ยนได้เองจาก worker — ต้อง poll */
export function shouldPoll(status: RequestStatus): boolean {
  return status === 'PENDING' || status === 'RUNNING';
}

/** สำเร็จจริงเมื่อ API บอก SUCCEEDED เท่านั้น (tenant ACTIVE ใน transaction เดียวกัน) */
export function isHandoffReady(view: Pick<RequestView, 'status'>): boolean {
  return view.status === 'SUCCEEDED';
}

export function currentStep(
  view: Pick<RequestView, 'steps'>,
): RequestView['steps'][number] | undefined {
  return view.steps.find((step) => step.state !== 'SUCCEEDED');
}

export interface RecoveryOption {
  action: RecoveryAction;
  path: 'reconcile' | 'retry' | 'safe-compensate' | 'mark-failed-final';
  title: MessageKey;
  detail: MessageKey;
  recommended: boolean;
  destructive: boolean;
}

/** #391: Reconcile & resume เป็น recommended ก่อน Retry, Safe compensate และ FAILED_FINAL */
export const RECOVERY_OPTIONS: readonly RecoveryOption[] = [
  {
    action: 'RECONCILE',
    path: 'reconcile',
    title: 'recovery.actions.RECONCILE.title',
    detail: 'recovery.actions.RECONCILE.detail',
    recommended: true,
    destructive: false,
  },
  {
    action: 'RETRY_STEP',
    path: 'retry',
    title: 'recovery.actions.RETRY_STEP.title',
    detail: 'recovery.actions.RETRY_STEP.detail',
    recommended: false,
    destructive: false,
  },
  {
    action: 'SAFE_COMPENSATE',
    path: 'safe-compensate',
    title: 'recovery.actions.SAFE_COMPENSATE.title',
    detail: 'recovery.actions.SAFE_COMPENSATE.detail',
    recommended: false,
    destructive: true,
  },
  {
    action: 'MARK_FAILED_FINAL',
    path: 'mark-failed-final',
    title: 'recovery.actions.MARK_FAILED_FINAL.title',
    detail: 'recovery.actions.MARK_FAILED_FINAL.detail',
    recommended: false,
    destructive: true,
  },
];

export const BLOCKED_REASONS: Record<string, MessageKey> = {
  REQUEST_NOT_ACTION_REQUIRED: 'blocked.REQUEST_NOT_ACTION_REQUIRED',
  NO_ACTION_REQUIRED_STEP: 'blocked.NO_ACTION_REQUIRED_STEP',
  CORRELATION_MISMATCH: 'blocked.CORRELATION_MISMATCH',
  RESOURCE_MAY_EXIST: 'blocked.RESOURCE_MAY_EXIST',
  COMPENSATION_UNSUPPORTED: 'blocked.COMPENSATION_UNSUPPORTED',
  NOTHING_TO_COMPENSATE: 'blocked.NOTHING_TO_COMPENSATE',
};

export const ACTOR_LABELS: Record<ActionHistoryItem['actor']['kind'], MessageKey> = {
  SYSTEM: 'actors.SYSTEM',
  PLATFORM_OPERATOR: 'identity.operator',
  PLATFORM_AUDITOR: 'actors.PLATFORM_AUDITOR',
  FIRST_ADMIN: 'actors.FIRST_ADMIN',
};

const ACTION_LABELS: Record<string, MessageKey> = {
  REQUEST_ACCEPTED: 'actions.REQUEST_ACCEPTED',
  COMMAND_REPLAYED: 'actions.COMMAND_REPLAYED',
  STATE_CHANGED: 'actions.STATE_CHANGED',
  STEP_STARTED: 'actions.STEP_STARTED',
  STEP_SUCCEEDED: 'actions.STEP_SUCCEEDED',
  STEP_ACTION_REQUIRED: 'actions.STEP_ACTION_REQUIRED',
  STEP_RETRY_SCHEDULED: 'actions.STEP_RETRY_SCHEDULED',
  RECONCILE: 'actions.RECONCILE',
  RETRY_STEP: 'actions.RETRY_STEP',
  RESEND_INVITATION: 'actions.RESEND_INVITATION',
  SAFE_COMPENSATE: 'recovery.actions.SAFE_COMPENSATE.title',
  MARK_FAILED_FINAL: 'recovery.actions.MARK_FAILED_FINAL.title',
  CANCEL: 'actions.CANCEL',
  RESERVATION_TOMBSTONED: 'actions.RESERVATION_TOMBSTONED',
  SECURITY_DENIED: 'actions.SECURITY_DENIED',
  REQUEST_EDITED: 'actions.REQUEST_EDITED',
  FIRST_ADMIN_EMAIL_VERIFIED: 'actions.FIRST_ADMIN_EMAIL_VERIFIED',
  FIRST_ADMIN_PASSWORD_SET: 'actions.FIRST_ADMIN_PASSWORD_SET',
  FIRST_ADMIN_TOTP_ENROLLED: 'actions.FIRST_ADMIN_TOTP_ENROLLED',
  FIRST_ADMIN_ACTIVATED: 'actions.FIRST_ADMIN_ACTIVATED',
};

export function actionLabel(action: string | undefined): MessageKey {
  return action && Object.hasOwn(ACTION_LABELS, action) ? ACTION_LABELS[action] : 'actions.unknown';
}

const ERROR_MESSAGES: Record<string, MessageKey> = {
  UNAUTHENTICATED: 'errors.UNAUTHENTICATED',
  FORBIDDEN: 'errors.FORBIDDEN',
  NOT_FOUND: 'errors.NOT_FOUND',
  VALIDATION_FAILED: 'errors.VALIDATION_FAILED',
  TENANT_SLUG_CONFLICT: 'errors.TENANT_SLUG_CONFLICT',
  TENANT_DOMAIN_CONFLICT: 'errors.TENANT_DOMAIN_CONFLICT',
  FIRST_ADMIN_EMAIL_CONFLICT: 'errors.FIRST_ADMIN_EMAIL_CONFLICT',
  IDEMPOTENCY_KEY_REUSED: 'errors.IDEMPOTENCY_KEY_REUSED',
  REVISION_CONFLICT: 'errors.REVISION_CONFLICT',
  INVALID_STATE_TRANSITION: 'errors.INVALID_STATE_TRANSITION',
  PLAN_UNAVAILABLE: 'errors.PLAN_UNAVAILABLE',
  BOOTSTRAP_TEMPLATE_UNAVAILABLE: 'errors.BOOTSTRAP_TEMPLATE_UNAVAILABLE',
  PREVIEW_STALE: 'errors.PREVIEW_STALE',
  RECOVERY_PRECONDITION_FAILED: 'errors.RECOVERY_PRECONDITION_FAILED',
  COMMAND_IN_PROGRESS: 'errors.COMMAND_IN_PROGRESS',
  INVITATION_RESEND_LIMITED: 'errors.INVITATION_RESEND_LIMITED',
  SERVICE_UNAVAILABLE: 'errors.SERVICE_UNAVAILABLE',
  PROVISIONING_DISABLED: 'errors.PROVISIONING_DISABLED',
  COMMAND_ATTEMPTS_EXHAUSTED: 'errors.COMMAND_ATTEMPTS_EXHAUSTED',
  NETWORK: 'errors.NETWORK',
};

export function errorMessageKey(error: { code?: string | null }): MessageKey {
  return error.code && Object.hasOwn(ERROR_MESSAGES, error.code)
    ? ERROR_MESSAGES[error.code]
    : 'errors.generic';
}

export function statusPresentation(status: string | undefined): { label: MessageKey; tone: Tone } {
  return status && Object.hasOwn(STATUS_LABELS, status)
    ? STATUS_LABELS[status as RequestStatus]
    : { label: 'statuses.unknown', tone: 'warning' };
}

export function stepPresentation(step: string | undefined) {
  return step && Object.hasOwn(STEP_LABELS, step)
    ? STEP_LABELS[step as StepKey]
    : { title: 'steps.unknown.title' as const, detail: 'steps.unknown.detail' as const };
}

export function blockedReasonKey(reason: string | null | undefined): MessageKey {
  return reason && Object.hasOwn(BLOCKED_REASONS, reason)
    ? BLOCKED_REASONS[reason]
    : 'blocked.unknown';
}

export function actorLabelKey(actor: string | undefined): MessageKey {
  return actor && Object.hasOwn(ACTOR_LABELS, actor)
    ? ACTOR_LABELS[actor as ActionHistoryItem['actor']['kind']]
    : 'actors.unknown';
}

export function canMutate(session: SessionView | null): boolean {
  return session?.capabilities.includes('PROVISIONING_MUTATE') ?? false;
}

export interface ReadOnlyCopy {
  chip: MessageKey;
  /** ประกาศทั้งหน้า — เฉพาะ operator ที่ถูกปิดชั่วคราว (auditor อ่านอย่างเดียวเป็นปกติ) */
  banner: MessageKey | null;
  create: MessageKey;
  decision: MessageKey;
}

/** ข้อความเมื่อ session เขียนไม่ได้ — แยก auditor ออกจาก operator ที่ถูก rollout ปิดไว้ */
export function readOnlyCopy(session: SessionView): ReadOnlyCopy {
  if (session.mutations === 'DISABLED') {
    return {
      chip: 'identity.disabled',
      banner: 'readOnly.disabledBanner',
      create: 'readOnly.disabledCreate',
      decision: 'readOnly.disabledDecision',
    };
  }
  if (session.mutations === 'NOT_ALLOWLISTED') {
    return {
      chip: 'identity.canary',
      banner: 'readOnly.canaryBanner',
      create: 'readOnly.canaryCreate',
      decision: 'readOnly.canaryDecision',
    };
  }
  return {
    chip: 'identity.auditor',
    banner: null,
    create: 'readOnly.auditorCreate',
    decision: 'readOnly.auditorDecision',
  };
}

/** route ของ Console — มีแค่ id ที่ opaque ไม่มี email/คำค้นหา (#412) */
export type Route = { name: 'list' } | { name: 'new' } | { name: 'request'; requestId: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoute(pathname: string): Route {
  if (pathname === '/new') return { name: 'new' };
  const match = /^\/requests\/([^/]+)$/.exec(pathname);
  if (match && UUID.test(match[1]!)) return { name: 'request', requestId: match[1]! };
  return { name: 'list' };
}

export function routePath(route: Route): string {
  if (route.name === 'new') return '/new';
  if (route.name === 'request') return `/requests/${route.requestId}`;
  return '/';
}

export function deliveryMessageKey(delivery: string | undefined): MessageKey {
  const keys: Record<string, MessageKey> = {
    SENT: 'invitation.delivery.SENT',
    INTENT: 'invitation.delivery.INTENT',
    FAILED: 'invitation.delivery.FAILED',
    AMBIGUOUS: 'invitation.delivery.AMBIGUOUS',
  };
  return delivery && Object.hasOwn(keys, delivery) ? keys[delivery] : 'invitation.delivery.unknown';
}

export function outcomeMessageKey(outcome: string | undefined): MessageKey {
  const keys: Record<string, MessageKey> = {
    REJECTED: 'outcomes.REJECTED',
    QUEUED: 'outcomes.QUEUED',
    RUNNING: 'outcomes.RUNNING',
    SUCCEEDED: 'outcomes.SUCCEEDED',
  };
  return outcome && Object.hasOwn(keys, outcome) ? keys[outcome] : 'outcomes.unknown';
}
