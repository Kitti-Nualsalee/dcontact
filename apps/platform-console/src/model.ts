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
  { value: 'th-TH', label: 'ไทย (th-TH)' },
  { value: 'en-US', label: 'English (en-US)' },
] as const;

export const TIMEZONES = ['Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'UTC'] as const;

/** ชื่อ field ใน form ↔ key ของ `fieldErrors` จาก API */
export const FIELD_LABELS: Record<keyof TenantDraft, string> = {
  displayName: 'ชื่อลูกค้า / องค์กร',
  slug: 'Slug',
  primaryDomain: 'Primary domain',
  planCode: 'Plan',
  locale: 'Locale',
  timezone: 'Timezone',
  bootstrapTemplateVersion: 'Bootstrap template',
  firstAdminDisplayName: 'ชื่อ First admin',
  firstAdminEmail: 'อีเมล First admin',
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const DOMAIN = /^(?=.{3,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/;

/** ตรวจเบื้องต้นก่อน review — server ตรวจซ้ำทุกค่าและเป็นผู้ตัดสิน */
export function validateDraft(draft: TenantDraft): Partial<Record<keyof TenantDraft, string>> {
  const errors: Partial<Record<keyof TenantDraft, string>> = {};
  const name = draft.displayName.trim();
  if (name.length < 2 || name.length > 120) errors.displayName = 'กรอกชื่อ 2–120 ตัวอักษร';
  const slug = draft.slug.trim().toLowerCase();
  if (!SLUG.test(slug) || slug.includes('--')) {
    errors.slug = 'ใช้ a-z, 0-9 และ - (ไม่ขึ้นต้น/ลงท้ายด้วย - และไม่มี --)';
  }
  if (!DOMAIN.test(draft.primaryDomain.trim().replace(/\.$/, ''))) {
    errors.primaryDomain = 'กรอกโดเมน เช่น example.co.th';
  }
  if (!draft.planCode) errors.planCode = 'เลือก plan';
  if (!draft.bootstrapTemplateVersion)
    errors.bootstrapTemplateVersion = 'ไม่มี bootstrap template ที่ใช้งานได้';
  if (!LOCALES.some((locale) => locale.value === draft.locale)) errors.locale = 'เลือก locale';
  if (!draft.timezone) errors.timezone = 'เลือก timezone';
  const adminName = draft.firstAdminDisplayName.trim();
  if (adminName.length < 1 || adminName.length > 120)
    errors.firstAdminDisplayName = 'กรอกชื่อผู้ดูแลคนแรก';
  if (!EMAIL.test(draft.firstAdminEmail.trim())) errors.firstAdminEmail = 'กรอกอีเมลให้ถูกต้อง';
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
): Partial<Record<keyof TenantDraft, string>> {
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
  const result: Partial<Record<keyof TenantDraft, string>> = {};
  for (const [field, value] of Object.entries(fieldErrors ?? {})) {
    const key = map[field];
    if (key) result[key] = value === 'INVALID' ? 'ระบบตรวจแล้วว่าค่านี้ไม่ถูกต้อง' : value;
  }
  return result;
}

/** key ของ draft แต่ละครั้งที่กด submit (ลองซ้ำหลัง network error = key เดิม → ไม่สร้างซ้ำ) */
export function newIdempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

// ── Presentation ────────────────────────────────────────────────────────────

export const STEP_LABELS: Record<StepKey, { title: string; detail: string }> = {
  TENANT_RECORD: {
    title: 'รับคำขอและ reserve identity',
    detail: 'slug, domain และอีเมลถูกจองแล้ว',
  },
  KEYCLOAK_ORGANIZATION: { title: 'สร้าง Organization', detail: 'ขอบเขต identity ของ tenant' },
  PLAN_BOOTSTRAP: {
    title: 'Bootstrap baseline',
    detail: 'ทีม คิว เวลาทำการ (draft) และ plan ที่ pin',
  },
  FIRST_ADMIN: { title: 'สร้าง First admin', detail: 'identity + สิทธิ์ admin ของ tenant' },
  INVITATION: { title: 'ส่งคำเชิญ', detail: 'ยืนยันอีเมล ตั้งรหัสผ่าน และ TOTP (72 ชั่วโมง)' },
  READINESS: { title: 'Readiness proof', detail: 'ตรวจครบก่อนเปิดใช้งาน' },
};

export const STATUS_LABELS: Record<RequestStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'รอเริ่ม', tone: 'neutral' },
  RUNNING: { label: 'กำลัง provision', tone: 'info' },
  SUCCEEDED: { label: 'พร้อมใช้งาน', tone: 'success' },
  ACTION_REQUIRED: { label: 'ต้องการการตัดสินใจ', tone: 'danger' },
  FAILED_FINAL: { label: 'ยุติแล้ว', tone: 'danger' },
  CANCELLED: { label: 'ยกเลิกแล้ว', tone: 'neutral' },
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
  title: string;
  detail: string;
  recommended: boolean;
  destructive: boolean;
}

/** #391: Reconcile & resume เป็น recommended ก่อน Retry, Safe compensate และ FAILED_FINAL */
export const RECOVERY_OPTIONS: readonly RecoveryOption[] = [
  {
    action: 'RECONCILE',
    path: 'reconcile',
    title: 'Reconcile & resume',
    detail: 'อ่านสถานะจริงจาก dependency แล้ว adopt ของที่สร้างสำเร็จ ลดการสร้างซ้ำ',
    recommended: true,
    destructive: false,
  },
  {
    action: 'RETRY_STEP',
    path: 'retry',
    title: 'Retry current step',
    detail: 'ทำขั้นปัจจุบันใหม่เมื่อยืนยันแล้วว่า resource ไม่มีอยู่จริง',
    recommended: false,
    destructive: false,
  },
  {
    action: 'SAFE_COMPENSATE',
    path: 'safe-compensate',
    title: 'Safe compensate',
    detail: 'ลบเฉพาะ resource ที่พิสูจน์ ownership แล้วและ step รองรับ',
    recommended: false,
    destructive: true,
  },
  {
    action: 'MARK_FAILED_FINAL',
    path: 'mark-failed-final',
    title: 'Mark FAILED_FINAL',
    detail: 'ยุติคำขอ เก็บ ledger และ tombstone slug/domain/email 30 วัน',
    recommended: false,
    destructive: true,
  },
];

export const BLOCKED_REASONS: Record<string, string> = {
  REQUEST_NOT_ACTION_REQUIRED: 'คำขอไม่ได้อยู่ในสถานะที่ต้องตัดสินใจแล้ว',
  NO_ACTION_REQUIRED_STEP: 'ไม่มีขั้นตอนที่หยุดรอ',
  CORRELATION_MISMATCH: 'พบ resource ชื่อเดียวกันของเจ้าของอื่น — ห้ามยึด',
  RESOURCE_MAY_EXIST: 'resource อาจมีอยู่แล้ว ต้อง Reconcile หรือ Safe compensate ก่อน',
  COMPENSATION_UNSUPPORTED: 'ขั้นตอนนี้ชดเชยไม่ได้',
  NOTHING_TO_COMPENSATE: 'ไม่พบ resource ที่ต้องชดเชย',
};

export const ACTOR_LABELS: Record<ActionHistoryItem['actor']['kind'], string> = {
  SYSTEM: 'System',
  PLATFORM_OPERATOR: 'Platform Operator',
  PLATFORM_AUDITOR: 'Platform Auditor',
  FIRST_ADMIN: 'First admin',
};

const ACTION_LABELS: Record<string, string> = {
  REQUEST_ACCEPTED: 'รับคำขอ',
  COMMAND_REPLAYED: 'ส่งคำขอซ้ำ (idempotent)',
  STATE_CHANGED: 'เปลี่ยนสถานะ',
  STEP_STARTED: 'เริ่มขั้นตอน',
  STEP_SUCCEEDED: 'ขั้นตอนสำเร็จ',
  STEP_ACTION_REQUIRED: 'ขั้นตอนหยุดรอ Operator',
  STEP_RETRY_SCHEDULED: 'นัดลองใหม่',
  RECONCILE: 'Reconcile',
  RETRY_STEP: 'Retry step',
  RESEND_INVITATION: 'ส่งคำเชิญซ้ำ',
  SAFE_COMPENSATE: 'Safe compensate',
  MARK_FAILED_FINAL: 'Mark FAILED_FINAL',
  CANCEL: 'ยกเลิก',
  RESERVATION_TOMBSTONED: 'Tombstone identity',
  SECURITY_DENIED: 'ถูกปฏิเสธด้านความปลอดภัย',
  REQUEST_EDITED: 'แก้ข้อมูลคำขอ',
  FIRST_ADMIN_EMAIL_VERIFIED: 'ยืนยันอีเมล',
  FIRST_ADMIN_PASSWORD_SET: 'ตั้งรหัสผ่าน',
  FIRST_ADMIN_TOTP_ENROLLED: 'ลงทะเบียน TOTP',
  FIRST_ADMIN_ACTIVATED: 'เปิดใช้งานบัญชี',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** คำอธิบายสั้นของ timeline entry — มีแค่ code/state ไม่มี PII */
export function describeHistory(item: ActionHistoryItem): string {
  const parts: string[] = [];
  if (item.stepKey) parts.push(STEP_LABELS[item.stepKey]?.title ?? item.stepKey);
  if (item.beforeState || item.afterState)
    parts.push(`${item.beforeState ?? '—'} → ${item.afterState ?? '—'}`);
  if (item.attempt) parts.push(`attempt ${item.attempt}`);
  if (item.errorCode) parts.push(item.errorCode);
  if (item.reasonCode) parts.push(`เหตุผล ${item.reasonCode}`);
  return parts.join(' · ');
}

const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHENTICATED: 'session หมดอายุ กรุณาเข้าสู่ระบบใหม่',
  FORBIDDEN: 'บัญชีนี้ไม่มีสิทธิ์ทำรายการนี้',
  NOT_FOUND: 'ไม่พบรายการ',
  VALIDATION_FAILED: 'ข้อมูลบางช่องไม่ถูกต้อง',
  TENANT_SLUG_CONFLICT: 'slug นี้ถูกใช้หรือถูกจองแล้ว',
  TENANT_DOMAIN_CONFLICT: 'โดเมนนี้ถูกใช้หรือถูกจองแล้ว',
  FIRST_ADMIN_EMAIL_CONFLICT: 'อีเมลผู้ดูแลคนแรกถูกใช้แล้ว',
  IDEMPOTENCY_KEY_REUSED: 'ข้อมูลถูกแก้หลังส่งไปแล้ว กรุณาส่งใหม่เป็นคำขอใหม่',
  REVISION_CONFLICT: 'ข้อมูลถูกเปลี่ยนโดยคนอื่นหรือระบบ กรุณาโหลดใหม่แล้วตรวจอีกครั้ง',
  INVALID_STATE_TRANSITION: 'สถานะปัจจุบันทำรายการนี้ไม่ได้',
  PLAN_UNAVAILABLE: 'plan ที่เลือกไม่พร้อมใช้งานแล้ว',
  BOOTSTRAP_TEMPLATE_UNAVAILABLE: 'bootstrap template ไม่พร้อมใช้งานแล้ว',
  PREVIEW_STALE: 'ผล preview เก่าแล้ว กรุณา preview ใหม่',
  RECOVERY_PRECONDITION_FAILED: 'เงื่อนไขของรายการนี้ไม่ผ่าน',
  COMMAND_IN_PROGRESS: 'มีคำสั่งอื่นของคำขอนี้กำลังทำงาน',
  INVITATION_RESEND_LIMITED: 'ส่งคำเชิญซ้ำเกิน 3 ครั้งต่อชั่วโมงแล้ว',
  SERVICE_UNAVAILABLE: 'ระบบไม่พร้อมชั่วคราว ลองใหม่อีกครั้ง',
  PROVISIONING_DISABLED: 'ระบบปิดการสร้างและแก้ไขชั่วคราว ดูสถานะได้ตามปกติ',
  COMMAND_ATTEMPTS_EXHAUSTED:
    'ตรวจสถานะของระบบภายนอกไม่สำเร็จ ลอง preview ใหม่เมื่อระบบภายนอกพร้อม',
  NETWORK: 'เชื่อมต่อ Platform API ไม่ได้ ลองใหม่อีกครั้ง',
};

export function errorMessage(error: Pick<ErrorEnvelope, 'code' | 'title'>): string {
  return ERROR_MESSAGES[error.code] ?? error.title ?? 'เกิดข้อผิดพลาด';
}

export function canMutate(session: SessionView | null): boolean {
  return session?.capabilities.includes('PROVISIONING_MUTATE') ?? false;
}

export interface ReadOnlyCopy {
  chip: string;
  /** ประกาศทั้งหน้า — เฉพาะ operator ที่ถูกปิดชั่วคราว (auditor อ่านอย่างเดียวเป็นปกติ) */
  banner: string | null;
  create: string;
  decision: string;
}

/** ข้อความเมื่อ session เขียนไม่ได้ — แยก auditor ออกจาก operator ที่ถูก rollout ปิดไว้ */
export function readOnlyCopy(session: SessionView): ReadOnlyCopy {
  if (session.mutations === 'DISABLED') {
    return {
      chip: 'Platform Operator (ปิดการแก้ไขชั่วคราว)',
      banner:
        'ระบบปิดการสร้างและแก้ไข tenant ชั่วคราว — ดูสถานะและประวัติได้ตามปกติ งานที่ค้างอยู่จะทำต่อเมื่อเปิดอีกครั้ง',
      create: 'ขณะนี้ปิดการสร้าง tenant ชั่วคราว',
      decision: 'ปิดการแก้ไขชั่วคราว — ตัดสินใจได้เมื่อระบบเปิดอีกครั้ง',
    };
  }
  if (session.mutations === 'NOT_ALLOWLISTED') {
    return {
      chip: 'Platform Operator (ยังไม่อยู่ในกลุ่ม canary)',
      banner: 'บัญชีนี้ยังไม่อยู่ในกลุ่มผู้ใช้ช่วงเปิดทดลอง (canary) จึงดูได้อย่างเดียว',
      create: 'บัญชีนี้ยังสร้าง tenant ไม่ได้ในช่วง canary',
      decision: 'บัญชีนี้ยังไม่อยู่ในกลุ่ม canary — ต้องให้ operator ในกลุ่มตัดสินใจ',
    };
  }
  return {
    chip: 'Platform Auditor (อ่านอย่างเดียว)',
    banner: null,
    create: 'Platform Auditor สร้าง tenant ไม่ได้',
    decision: 'Platform Auditor ดูได้อย่างเดียว — ต้องให้ Platform Operator ตัดสินใจ',
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

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('th-TH', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'Asia/Bangkok',
  }).format(new Date(iso));
}
