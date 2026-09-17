/**
 * CG5 wire/domain primitives แบบ additive สำหรับชั้น dashboard, anomaly alert, compliance export
 * และ external read API ของ Contact Governance (สเปก #284, Phase Contract #274)
 *
 * ไฟล์นี้เป็น contract ล้วน ไม่มี I/O และไม่มี state — projection, alert และ export ถูกนิยามเป็น
 * ค่าที่ปิดชุดไว้ เพื่อให้ owner ฝั่ง Governance, API, Console และ acceptance อ้างชุดเดียวกัน
 *
 * ข้อห้ามที่สืบทอดมาจากคำตัดสิน #266–#273 และบังคับผ่าน type/validator ในไฟล์นี้:
 * - projection, alert, manifest และ event ไม่มี PII — การสืบรายบุคคลอ่าน canonical เสมอ
 * - `governance:restrictions:write` ถูกจองชื่อไว้ แต่ยังไม่ผูก route ใดในเฟสนี้
 * - ค่าของ config ราย tenant อยู่ในช่วงที่ระบบกำหนดเท่านั้น ไม่ใช่ค่าอิสระ
 */
import type { ContactMutationId } from './identifiers.js';
import type { ContactChannel, ContactDecision } from './contact-governance.js';
import { canonicalCg4Digest, canonicalCg4Json, type Cg4Digest } from './contact-governance-cg4.js';

export const CG5_CONTRACT_VERSION = 1 as const;
export const CG5_RULE_REGISTRY_VERSION = 'CG5_RULE_REGISTRY_V1' as const;
export const CG5_MANIFEST_SCHEMA_VERSION = 1 as const;

export type Cg5ContractVersion = typeof CG5_CONTRACT_VERSION;
export type Cg5RuleRegistryVersion = typeof CG5_RULE_REGISTRY_VERSION;
export type Cg5ManifestSchemaVersion = typeof CG5_MANIFEST_SCHEMA_VERSION;

// ── Metric และ granularity (#268) ────────────────────────────────────────────

export const CG5_METRIC_KEYS = Object.freeze([
  'cg.decision',
  'cg.restriction',
  'cg.frequency',
  'cg.exception',
  'cg.consent',
  'cg.policy.health',
  'cg.audit',
  'cg.reservation',
] as const);

export type Cg5MetricKey = (typeof CG5_METRIC_KEYS)[number];

/** ทางป้อนของแต่ละ metric ตาม #266: event ผ่าน inbox เดิม หรือการอ่าน canonical เป็นรอบ */
export const CG5_METRIC_FEEDS = Object.freeze({
  'cg.decision': 'INCREMENTAL_READ',
  'cg.restriction': 'EVENT_INBOX',
  'cg.frequency': 'INCREMENTAL_READ',
  'cg.exception': 'EVENT_INBOX',
  'cg.consent': 'EVENT_INBOX',
  'cg.policy.health': 'EVENT_INBOX',
  'cg.audit': 'EVENT_INBOX',
  'cg.reservation': 'INCREMENTAL_READ',
} as const satisfies Readonly<Record<Cg5MetricKey, Cg5MetricFeed>>);

export type Cg5MetricFeed = 'EVENT_INBOX' | 'INCREMENTAL_READ';

export const CG5_GRANULARITIES = Object.freeze(['FIVE_MIN', 'HOUR', 'DAY'] as const);
export type Cg5Granularity = (typeof CG5_GRANULARITIES)[number];

export const CG5_GRANULARITY_SECONDS = Object.freeze({
  FIVE_MIN: 300,
  HOUR: 3_600,
  DAY: 86_400,
} as const satisfies Readonly<Record<Cg5Granularity, number>>);

/**
 * มิติของตารางสรุป — ทุก field เป็น aggregate dimension ไม่ใช่ตัวระบุบุคคล
 * `teamId` อยู่ในมิติหลักเพราะเป็นเงื่อนไขเดียวที่ทำให้ SUPERVISOR เห็น dashboard ของทีมตัวเองได้
 */
export interface Cg5MetricDimensions {
  readonly channel: ContactChannel | null;
  readonly purpose: string | null;
  readonly decision: ContactDecision | null;
  readonly gate: string | null;
  readonly reasonCode: string | null;
  readonly teamId: string | null;
}

export const CG5_EMPTY_DIMENSIONS: Cg5MetricDimensions = Object.freeze({
  channel: null,
  purpose: null,
  decision: null,
  gate: null,
  reasonCode: null,
  teamId: null,
});

/**
 * `dimensionKey` ทำให้ unique constraint ของ bucket ใช้ได้จริง — Postgres ถือว่า NULL ไม่เท่ากับ NULL
 * การ unique บนคอลัมน์ที่เป็น null ได้โดยตรงจึงปล่อยให้เกิดแถวซ้ำแบบเงียบ ๆ
 */
export function cg5DimensionKey(dimensions: Cg5MetricDimensions): Cg4Digest {
  return canonicalCg4Digest({
    channel: dimensions.channel,
    purpose: dimensions.purpose,
    decision: dimensions.decision,
    gate: dimensions.gate,
    reasonCode: dimensions.reasonCode,
    teamId: dimensions.teamId,
  });
}

// ── Anomaly rules (#269, #270) ───────────────────────────────────────────────

export const CG5_ALERT_SEVERITIES = Object.freeze(['WARNING', 'CRITICAL'] as const);
export type Cg5AlertSeverity = (typeof CG5_ALERT_SEVERITIES)[number];

export type Cg5RuleKind = 'FIXED_THRESHOLD' | 'BASELINE_RELATIVE';

export interface Cg5RuleMetadata {
  readonly ruleCode: string;
  readonly kind: Cg5RuleKind;
  readonly defaultSeverity: Cg5AlertSeverity;
  /** metric ที่กฎนี้อ่าน; `null` สำหรับกฎที่ประเมินสุขภาพของ projection เอง */
  readonly metricKey: Cg5MetricKey | null;
  /** กฎเทียบฐานถูกระงับเมื่อข้อมูลไม่ครบ ส่วนกฎค่าคงที่คือผู้รายงานว่าข้อมูลไม่ครบ */
  readonly suppressibleByDataGap: boolean;
  readonly registryVersion: Cg5RuleRegistryVersion;
}

function rule(
  ruleCode: string,
  kind: Cg5RuleKind,
  defaultSeverity: Cg5AlertSeverity,
  metricKey: Cg5MetricKey | null,
): Cg5RuleMetadata {
  return Object.freeze({
    ruleCode,
    kind,
    defaultSeverity,
    metricKey,
    suppressibleByDataGap: kind === 'BASELINE_RELATIVE',
    registryVersion: CG5_RULE_REGISTRY_VERSION,
  });
}

export const CG5_RULE_REGISTRY = Object.freeze({
  CG5_PROJECTION_LAG: rule('CG5_PROJECTION_LAG', 'FIXED_THRESHOLD', 'CRITICAL', null),
  CG5_BASELINE_UNAVAILABLE: rule('CG5_BASELINE_UNAVAILABLE', 'FIXED_THRESHOLD', 'WARNING', null),
  CG5_BLOCK_RATE_SHIFT: rule(
    'CG5_BLOCK_RATE_SHIFT',
    'BASELINE_RELATIVE',
    'CRITICAL',
    'cg.decision',
  ),
  CG5_REASON_MIX_SHIFT: rule('CG5_REASON_MIX_SHIFT', 'BASELINE_RELATIVE', 'WARNING', 'cg.decision'),
  CG5_OPT_OUT_SPIKE: rule('CG5_OPT_OUT_SPIKE', 'BASELINE_RELATIVE', 'WARNING', 'cg.restriction'),
  CG5_POLICY_PUBLISH_IMPACT: rule(
    'CG5_POLICY_PUBLISH_IMPACT',
    'BASELINE_RELATIVE',
    'CRITICAL',
    'cg.policy.health',
  ),
  CG5_EXCEPTION_USAGE_SPIKE: rule(
    'CG5_EXCEPTION_USAGE_SPIKE',
    'BASELINE_RELATIVE',
    'WARNING',
    'cg.exception',
  ),
  CG5_QUOTA_EXHAUSTION: rule(
    'CG5_QUOTA_EXHAUSTION',
    'BASELINE_RELATIVE',
    'WARNING',
    'cg.frequency',
  ),
  CG5_RESERVATION_LEAK: rule(
    'CG5_RESERVATION_LEAK',
    'BASELINE_RELATIVE',
    'WARNING',
    'cg.reservation',
  ),
  CG5_EXPORT_VOLUME_SPIKE: rule(
    'CG5_EXPORT_VOLUME_SPIKE',
    'BASELINE_RELATIVE',
    'WARNING',
    'cg.audit',
  ),
} as const);

export type Cg5RuleCode = keyof typeof CG5_RULE_REGISTRY;
export const CG5_RULE_CODES = Object.freeze(Object.keys(CG5_RULE_REGISTRY) as Cg5RuleCode[]);

export function cg5RuleMetadata(ruleCode: Cg5RuleCode): Cg5RuleMetadata {
  return CG5_RULE_REGISTRY[ruleCode];
}

export function isCg5RuleCode(value: string): value is Cg5RuleCode {
  return Object.hasOwn(CG5_RULE_REGISTRY, value);
}

// ── Alert state (#269) ───────────────────────────────────────────────────────

export const CG5_ALERT_STATES = Object.freeze(['OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED'] as const);
export type Cg5AlertState = (typeof CG5_ALERT_STATES)[number];

/** alert ปิดตัวเองเมื่อค่ากลับสู่ปกติ และ ack ไม่ใช่การปิด — ตาราง transition ปิดชุดไว้ที่นี่ */
const CG5_ALERT_TRANSITIONS: Readonly<Record<Cg5AlertState, readonly Cg5AlertState[]>> =
  Object.freeze({
    OPEN: Object.freeze(['ACKED', 'RESOLVED', 'SUPPRESSED'] as const),
    ACKED: Object.freeze(['OPEN', 'RESOLVED', 'SUPPRESSED'] as const),
    RESOLVED: Object.freeze(['OPEN'] as const),
    SUPPRESSED: Object.freeze(['OPEN', 'RESOLVED'] as const),
  });

export function canCg5AlertTransition(from: Cg5AlertState, to: Cg5AlertState): boolean {
  return CG5_ALERT_TRANSITIONS[from].includes(to);
}

/** scope ของ alert เป็นระดับรวมเสมอ ไม่มี contact/identity ตาม #269 */
export interface Cg5AlertScope {
  readonly channel: ContactChannel | null;
  readonly purpose: string | null;
  readonly teamId: string | null;
}

export function cg5AlertScopeKey(scope: Cg5AlertScope): Cg4Digest {
  return canonicalCg4Digest({
    channel: scope.channel,
    purpose: scope.purpose,
    teamId: scope.teamId,
  });
}

// ── Export (#270) ────────────────────────────────────────────────────────────

export const CG5_EXPORT_DATASETS = Object.freeze([
  'DECISION_TRACE',
  'AUDIT_LOG',
  'RESTRICTION_CONSENT',
  'EXCEPTION_APPROVAL',
] as const);
export type Cg5ExportDataset = (typeof CG5_EXPORT_DATASETS)[number];

export const CG5_EVIDENCE_LEVELS = Object.freeze(['SUMMARY', 'EVIDENCE'] as const);
export type Cg5EvidenceLevel = (typeof CG5_EVIDENCE_LEVELS)[number];

export const CG5_EXPORT_STATES = Object.freeze([
  'QUEUED',
  'RUNNING',
  'READY',
  'FAILED',
  'EXPIRED',
  'REVOKED',
] as const);
export type Cg5ExportState = (typeof CG5_EXPORT_STATES)[number];

/** manifest บันทึกจำนวนแถวและ digest ได้ แต่ห้ามบันทึกเนื้อหาแถว */
export interface Cg5ExportManifestV1 {
  readonly contractVersion: Cg5ContractVersion;
  readonly manifestSchemaVersion: Cg5ManifestSchemaVersion;
  readonly exportId: string;
  readonly datasets: readonly Cg5ExportDataset[];
  readonly evidenceLevel: Cg5EvidenceLevel;
  readonly rangeFrom: string;
  readonly rangeTo: string;
  readonly rowCounts: Readonly<Record<Cg5ExportDataset, number>>;
  readonly fileDigests: Readonly<Record<string, Cg4Digest>>;
  readonly requestedByRef: string;
  readonly generatedAt: string;
  readonly tenantWatermark: string;
}

// ── Event contract (#271) ────────────────────────────────────────────────────

export const CG5_EVENT_TYPES = Object.freeze({
  ALERT_CHANGED: 'governance.alert.changed',
  EXPORT_CHANGED: 'governance.export.changed',
} as const);

export const CG5_EVENT_AGGREGATE_TYPES = Object.freeze({
  ALERT: 'contact_governance_alert',
  EXPORT: 'contact_governance_export',
} as const);

export type Cg5EventType = (typeof CG5_EVENT_TYPES)[keyof typeof CG5_EVENT_TYPES];
export type Cg5EventAggregateType =
  (typeof CG5_EVENT_AGGREGATE_TYPES)[keyof typeof CG5_EVENT_AGGREGATE_TYPES];

interface Cg5ChangePayloadBaseV1 {
  readonly contractVersion: Cg5ContractVersion;
  readonly mutationId: ContactMutationId;
  readonly subjectId: string;
  readonly subjectVersion: number;
  readonly effectiveAt: string;
  readonly stateDigest: Cg4Digest;
}

export interface Cg5AlertChangedPayloadV1 extends Cg5ChangePayloadBaseV1 {
  readonly ruleCode: Cg5RuleCode;
  readonly severity: Cg5AlertSeverity;
  readonly state: Cg5AlertState;
  readonly scopeKey: Cg4Digest;
  readonly registryVersion: Cg5RuleRegistryVersion;
}

export interface Cg5ExportChangedPayloadV1 extends Cg5ChangePayloadBaseV1 {
  readonly state: Cg5ExportState;
  readonly datasets: readonly Cg5ExportDataset[];
  readonly evidenceLevel: Cg5EvidenceLevel;
  readonly manifestDigest?: Cg4Digest;
}

export type Cg5CanonicalChangePayloadV1 = Cg5AlertChangedPayloadV1 | Cg5ExportChangedPayloadV1;

// ── API scope (#267) ─────────────────────────────────────────────────────────

export const CG5_API_SCOPES = Object.freeze({
  READ: 'governance:read',
  EVIDENCE: 'governance:evidence',
  RESTRICTIONS_WRITE: 'governance:restrictions:write',
} as const);

export type Cg5ApiScope = (typeof CG5_API_SCOPES)[keyof typeof CG5_API_SCOPES];

/** scope ที่ผูกกับ route ได้จริงในเฟสนี้ — ชุดเขียนถูกจองชื่อไว้เฉย ๆ */
export const CG5_BOUND_API_SCOPES = Object.freeze([
  CG5_API_SCOPES.READ,
  CG5_API_SCOPES.EVIDENCE,
] as const);

export const CG5_RESERVED_API_SCOPES = Object.freeze([CG5_API_SCOPES.RESTRICTIONS_WRITE] as const);

/** scope ที่ผูกกับ route ได้จริง — แยก type ออกจาก `Cg5ApiScope` ซึ่งรวมชื่อที่จองไว้ด้วย */
export type Cg5BoundApiScope = (typeof CG5_BOUND_API_SCOPES)[number];
export type Cg5ReservedApiScope = (typeof CG5_RESERVED_API_SCOPES)[number];

export function isCg5BoundApiScope(scope: string): scope is Cg5BoundApiScope {
  return (CG5_BOUND_API_SCOPES as readonly string[]).includes(scope);
}

// ── Error codes (#271) ───────────────────────────────────────────────────────

export type Cg5ErrorCode =
  | 'CG5_PROJECTION_NOT_READY'
  | 'CG5_EXPORT_RANGE_TOO_LARGE'
  | 'CG5_EXPORT_RATE_LIMIT'
  | 'CG5_ALERT_VERSION_CONFLICT'
  | 'GOVERNANCE_RATE_LIMITED';

export type Cg5ContractFailureCode =
  | 'UNSUPPORTED_CONTRACT_VERSION'
  | 'UNSUPPORTED_RULE_REGISTRY_VERSION'
  | 'CONFIG_OUT_OF_RANGE'
  | 'CONFIG_FIELD_MISSING'
  | 'PII_FIELD_FORBIDDEN'
  | 'SCOPE_NOT_BOUND';

export class Cg5ContractError extends Error {
  constructor(
    readonly code: Cg5ContractFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'Cg5ContractError';
  }
}

export function assertCg5BoundApiScope(scope: string): asserts scope is Cg5BoundApiScope {
  if (!isCg5BoundApiScope(scope)) {
    throw new Cg5ContractError('SCOPE_NOT_BOUND', `scope ${scope} ยังไม่ผูกกับ route ใดในเฟสนี้`);
  }
}

export interface Cg5SupportedVersions {
  contractVersion: number;
  ruleRegistryVersion: string;
}

export function assertSupportedCg5Versions(versions: Cg5SupportedVersions): void {
  if (versions.contractVersion !== CG5_CONTRACT_VERSION) {
    throw new Cg5ContractError(
      'UNSUPPORTED_CONTRACT_VERSION',
      `รองรับ contractVersion ${CG5_CONTRACT_VERSION} เท่านั้น ได้รับ ${versions.contractVersion}`,
    );
  }
  if (versions.ruleRegistryVersion !== CG5_RULE_REGISTRY_VERSION) {
    throw new Cg5ContractError(
      'UNSUPPORTED_RULE_REGISTRY_VERSION',
      `รองรับ ruleRegistryVersion ${CG5_RULE_REGISTRY_VERSION} เท่านั้น ได้รับ ${versions.ruleRegistryVersion}`,
    );
  }
}

// ── PII guard (#266, #270) ───────────────────────────────────────────────────

/**
 * ชื่อ field ที่ห้ามปรากฏใน projection, alert, manifest และ event ของ CG5
 * ไม่ใช่การตรวจเนื้อหา แต่เป็นการปิดประตูที่ชื่อ field ซึ่งเป็นทางที่ PII หลุดเข้ามาได้ง่ายที่สุด
 */
export const CG5_FORBIDDEN_PAYLOAD_FIELDS = Object.freeze([
  'contactid',
  'identityid',
  'msisdn',
  'phonenumber',
  'email',
  'emailaddress',
  'lineuserid',
  'fullname',
  'firstname',
  'lastname',
  'nationalid',
  'address',
  'rawattributes',
  'evidencebody',
] as const);

export function assertCg5PiiFreePayload(payload: unknown, path = 'payload'): void {
  if (payload === null || typeof payload !== 'object') return;
  if (Array.isArray(payload)) {
    payload.forEach((entry, index) => assertCg5PiiFreePayload(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if ((CG5_FORBIDDEN_PAYLOAD_FIELDS as readonly string[]).includes(key.toLowerCase())) {
      throw new Cg5ContractError(
        'PII_FIELD_FORBIDDEN',
        `${path}.${key} เป็น field ที่ห้ามอยู่ใน payload ของ CG5`,
      );
    }
    assertCg5PiiFreePayload(value, `${path}.${key}`);
  }
}

// ── Tenant config (#266, #268, #269, #270) ───────────────────────────────────

export interface Cg5NumericBound {
  readonly min: number;
  readonly max: number;
  readonly fallback: number;
}

const bound = (min: number, max: number, fallback: number): Cg5NumericBound =>
  Object.freeze({ min, max, fallback });

/**
 * ช่วงค่าที่ระบบยอมให้ tenant ตั้ง — retention ตั้งสั้นกว่าเพดานได้ แต่ยาวเกินเพดานไม่ได้
 * และรอบ refresh อยู่ในระดับนาทีตาม #266
 */
export const CG5_CONFIG_BOUNDS = Object.freeze({
  refreshIntervalSeconds: bound(60, 300, 120),
  lagSloSeconds: bound(60, 900, 300),
  retentionFiveMinuteDays: bound(1, 14, 14),
  retentionHourlyDays: bound(7, 90, 90),
  retentionDailyMonths: bound(1, 13, 13),
  anomalyMinimumVolume: bound(10, 10_000, 50),
  anomalyConsecutiveHitsToOpen: bound(2, 12, 3),
  anomalyConsecutiveHitsToResolve: bound(2, 12, 3),
  anomalyBaselineWeeks: bound(4, 4, 4),
  apiRateLimitPerMinute: bound(10, 6_000, 600),
  exportMaxRangeDays: bound(1, 92, 92),
  exportMaxPerDay: bound(1, 50, 10),
} as const);

export type Cg5ConfigField = keyof typeof CG5_CONFIG_BOUNDS;

export type Cg5TenantConfigValues = Readonly<Record<Cg5ConfigField, number>>;

export interface Cg5TenantConfigV1 extends Cg5TenantConfigValues {
  readonly contractVersion: Cg5ContractVersion;
}

export const CG5_DEFAULT_TENANT_CONFIG: Cg5TenantConfigV1 = Object.freeze({
  contractVersion: CG5_CONTRACT_VERSION,
  ...(Object.fromEntries(
    Object.entries(CG5_CONFIG_BOUNDS).map(([field, range]) => [field, range.fallback]),
  ) as Cg5TenantConfigValues),
});

export interface Cg5ConfigViolation {
  readonly field: Cg5ConfigField;
  readonly reason: 'MISSING' | 'NOT_FINITE' | 'BELOW_MIN' | 'ABOVE_MAX';
  readonly bound: Cg5NumericBound;
}

export function validateCg5TenantConfig(
  config: Partial<Cg5TenantConfigValues>,
): readonly Cg5ConfigViolation[] {
  const violations: Cg5ConfigViolation[] = [];
  for (const [field, range] of Object.entries(CG5_CONFIG_BOUNDS) as Array<
    [Cg5ConfigField, Cg5NumericBound]
  >) {
    const value = config[field];
    if (value === undefined) {
      violations.push({ field, reason: 'MISSING', bound: range });
      continue;
    }
    if (!Number.isFinite(value)) {
      violations.push({ field, reason: 'NOT_FINITE', bound: range });
      continue;
    }
    if (value < range.min) violations.push({ field, reason: 'BELOW_MIN', bound: range });
    else if (value > range.max) violations.push({ field, reason: 'ABOVE_MAX', bound: range });
  }
  return Object.freeze(violations);
}

export function assertCg5TenantConfig(
  config: Partial<Cg5TenantConfigValues>,
): asserts config is Cg5TenantConfigValues {
  const violations = validateCg5TenantConfig(config);
  if (violations.length === 0) return;
  const missing = violations.filter((violation) => violation.reason === 'MISSING');
  const detail = violations.map((violation) => `${violation.field}:${violation.reason}`).join(', ');
  throw new Cg5ContractError(
    missing.length === violations.length ? 'CONFIG_FIELD_MISSING' : 'CONFIG_OUT_OF_RANGE',
    `config ราย tenant ไม่ผ่านการตรวจ: ${detail}`,
  );
}

/** digest ของ config ที่ใช้เทียบว่าค่าที่ worker ถืออยู่ตรงกับที่บันทึกไว้ */
export function cg5ConfigDigest(config: Cg5TenantConfigValues): Cg4Digest {
  return canonicalCg4Digest(
    Object.fromEntries(
      (Object.keys(CG5_CONFIG_BOUNDS) as Cg5ConfigField[]).map((field) => [field, config[field]]),
    ),
  );
}

export { canonicalCg4Json as canonicalCg5Json, canonicalCg4Digest as canonicalCg5Digest };
