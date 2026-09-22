/**
 * J5.1 (#339): error และ diagnostic registry ของ Journey authoring/template (Phase Contract #334 §10,
 * Phase Spec #337 §5)
 *
 * contract ล้วน ไม่มี I/O — ทุก code เป็นชุดปิด เพื่อให้ validator, API, Console และ acceptance
 * อ้างชุดเดียวกัน API ไม่ใช้ข้อความภาษาใด ๆ เป็น contract: ส่งเพียง `code`, `messageKey` และ
 * `safeParams` ที่ไม่มี PII/ค่า parameter ของ template
 */

/** code เดิมของ J1–J3 ที่ต้องคงความหมายเดิมทุกตัว (#329 §9) */
export const JOURNEY_LEGACY_ERROR_CODES = Object.freeze([
  'DEFINITION_INVALID',
  'IDEMPOTENCY_CONFLICT',
  'NON_SEQUENTIAL_VERSION',
  'VERSION_NOT_FOUND',
  'DRAFT_VERSION_CONFLICT',
  'PUBLISHED_HEAD_CONFLICT',
  'JOURNEY_LIFECYCLE_CONFLICT',
] as const);

/** missing/foreign/hidden ใช้ generic not-found ชุดเดียว เพื่อไม่เผยว่ามี resource ใน tenant อื่น */
export const JOURNEY_AUTHORING_NOT_FOUND_CODES = Object.freeze([
  'JOURNEY_NOT_FOUND',
  'TEMPLATE_NOT_FOUND',
] as const);

export const JOURNEY_AUTHORING_GRAPH_ERROR_CODES = Object.freeze([
  'AUTHORING_SCHEMA_INVALID',
  'NODE_TYPE_UNSUPPORTED',
  'NODE_FIELD_UNKNOWN',
  'PORT_INVALID',
  'PORT_CARDINALITY_INVALID',
  'EDGE_REFERENCE_INVALID',
  'GRAPH_CYCLE_UNSUPPORTED',
  'GRAPH_LIMIT_EXCEEDED',
  'CONTEXT_PATH_UNSUPPORTED',
] as const);

export const JOURNEY_AUTHORING_COMPILE_ERROR_CODES = Object.freeze([
  'REFERENCE_UNTRUSTED',
  'RUNTIME_CAPABILITY_UNAVAILABLE',
  'COMPILER_VERSION_UNSUPPORTED',
  'COMPILE_ARTIFACT_STALE',
  'COMPILE_DIGEST_MISMATCH',
  'PREVIEW_FIXTURE_INVALID',
  'SIMULATION_LIMIT_EXCEEDED',
] as const);

export const JOURNEY_AUTHORING_AUTH_ERROR_CODES = Object.freeze([
  'CAPABILITY_REQUIRED',
  'AUTHORIZATION_STALE',
  'TEAM_SCOPE_STALE',
  'OWNER_TEAM_INACTIVE',
  'OWNERSHIP_TRANSFER_FORBIDDEN',
  'DELEGATION_INVALID',
  'DELEGATION_EXPIRED',
  'REVIEW_CANDIDATE_STALE',
  'APPROVAL_REQUIRED',
  'APPROVAL_SELF_FORBIDDEN',
  'APPROVAL_STALE',
  'STRONG_AUTH_REQUIRED',
  'EDIT_SESSION_RECOVERY_REQUIRED',
] as const);

export const JOURNEY_TEMPLATE_ERROR_CODES = Object.freeze([
  'TEMPLATE_VERSION_NOT_FOUND',
  'TEMPLATE_VERSION_CONFLICT',
  'TEMPLATE_DIGEST_MISMATCH',
  'TEMPLATE_DEPRECATED',
  'TEMPLATE_PARAMETER_INVALID',
  'TEMPLATE_PARAMETER_REQUIRED',
  'TEMPLATE_BIND_TARGET_INVALID',
  'TEMPLATE_REFERENCE_UNTRUSTED',
  'TEMPLATE_CAPABILITY_UNAVAILABLE',
  'TEMPLATE_PROVENANCE_INVALID',
  'TEMPLATE_UPGRADE_STALE',
  'TEMPLATE_UPGRADE_CONFLICT',
  'TEMPLATE_PACKAGE_UNTRUSTED',
] as const);

/**
 * code ระดับ transport ที่ Phase Spec §5 ต้องใช้ตอบ HTTP แต่ไม่ใช่ diagnostic ของ graph:
 * publish ที่ยังไม่รู้ผล, dependency ล่ม, request ผิดรูป และ side-effect barrier ของ simulator
 */
export const JOURNEY_AUTHORING_TRANSPORT_ERROR_CODES = Object.freeze([
  'PUBLISH_OUTCOME_UNKNOWN',
  'DEPENDENCY_UNAVAILABLE',
  'REQUEST_MALFORMED',
  'SIMULATION_SIDE_EFFECT_BLOCKED',
] as const);

export const JOURNEY_AUTHORING_ERROR_CODES = Object.freeze([
  ...JOURNEY_LEGACY_ERROR_CODES,
  ...JOURNEY_AUTHORING_NOT_FOUND_CODES,
  ...JOURNEY_AUTHORING_GRAPH_ERROR_CODES,
  ...JOURNEY_AUTHORING_COMPILE_ERROR_CODES,
  ...JOURNEY_AUTHORING_AUTH_ERROR_CODES,
  ...JOURNEY_TEMPLATE_ERROR_CODES,
  ...JOURNEY_AUTHORING_TRANSPORT_ERROR_CODES,
] as const);

export type JourneyAuthoringErrorCode = (typeof JOURNEY_AUTHORING_ERROR_CODES)[number];

const ERROR_CODE_SET: ReadonlySet<string> = new Set(JOURNEY_AUTHORING_ERROR_CODES);

export function isJourneyAuthoringErrorCode(value: unknown): value is JourneyAuthoringErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value);
}

/**
 * HTTP mapping ตาม Phase Spec §5: validation/diagnostics `422`; auth `403`; generic not found
 * `404`; stale/CAS/lifecycle/review/idempotency conflict `409`; publish ที่ยังไม่รู้ผล `202`;
 * dependency ล่ม `503`; body/header ผิดรูป `400`
 */
export const JOURNEY_AUTHORING_HTTP_STATUS = Object.freeze({
  DEFINITION_INVALID: 422,
  IDEMPOTENCY_CONFLICT: 409,
  NON_SEQUENTIAL_VERSION: 409,
  VERSION_NOT_FOUND: 404,
  DRAFT_VERSION_CONFLICT: 409,
  PUBLISHED_HEAD_CONFLICT: 409,
  JOURNEY_LIFECYCLE_CONFLICT: 409,

  JOURNEY_NOT_FOUND: 404,
  TEMPLATE_NOT_FOUND: 404,

  AUTHORING_SCHEMA_INVALID: 422,
  NODE_TYPE_UNSUPPORTED: 422,
  NODE_FIELD_UNKNOWN: 422,
  PORT_INVALID: 422,
  PORT_CARDINALITY_INVALID: 422,
  EDGE_REFERENCE_INVALID: 422,
  GRAPH_CYCLE_UNSUPPORTED: 422,
  GRAPH_LIMIT_EXCEEDED: 422,
  CONTEXT_PATH_UNSUPPORTED: 422,

  REFERENCE_UNTRUSTED: 422,
  RUNTIME_CAPABILITY_UNAVAILABLE: 422,
  COMPILER_VERSION_UNSUPPORTED: 422,
  COMPILE_ARTIFACT_STALE: 409,
  COMPILE_DIGEST_MISMATCH: 409,
  PREVIEW_FIXTURE_INVALID: 422,
  SIMULATION_LIMIT_EXCEEDED: 422,

  CAPABILITY_REQUIRED: 403,
  AUTHORIZATION_STALE: 409,
  TEAM_SCOPE_STALE: 409,
  OWNER_TEAM_INACTIVE: 422,
  OWNERSHIP_TRANSFER_FORBIDDEN: 403,
  DELEGATION_INVALID: 403,
  DELEGATION_EXPIRED: 403,
  REVIEW_CANDIDATE_STALE: 409,
  APPROVAL_REQUIRED: 409,
  APPROVAL_SELF_FORBIDDEN: 403,
  APPROVAL_STALE: 409,
  STRONG_AUTH_REQUIRED: 403,
  EDIT_SESSION_RECOVERY_REQUIRED: 409,

  TEMPLATE_VERSION_NOT_FOUND: 404,
  TEMPLATE_VERSION_CONFLICT: 409,
  TEMPLATE_DIGEST_MISMATCH: 409,
  TEMPLATE_DEPRECATED: 409,
  TEMPLATE_PARAMETER_INVALID: 422,
  TEMPLATE_PARAMETER_REQUIRED: 422,
  TEMPLATE_BIND_TARGET_INVALID: 422,
  TEMPLATE_REFERENCE_UNTRUSTED: 422,
  TEMPLATE_CAPABILITY_UNAVAILABLE: 422,
  TEMPLATE_PROVENANCE_INVALID: 422,
  TEMPLATE_UPGRADE_STALE: 409,
  TEMPLATE_UPGRADE_CONFLICT: 409,
  TEMPLATE_PACKAGE_UNTRUSTED: 422,

  PUBLISH_OUTCOME_UNKNOWN: 202,
  DEPENDENCY_UNAVAILABLE: 503,
  REQUEST_MALFORMED: 400,
  SIMULATION_SIDE_EFFECT_BLOCKED: 422,
} as const satisfies Readonly<
  Record<JourneyAuthoringErrorCode, 202 | 400 | 403 | 404 | 409 | 422 | 503>
>);

// ── Diagnostics (#329 §9, Phase Contract §10) ──────────────────────────────────

export const JOURNEY_DIAGNOSTIC_SEVERITIES = Object.freeze(['ERROR', 'WARNING'] as const);
export type JourneyDiagnosticSeverity = (typeof JOURNEY_DIAGNOSTIC_SEVERITIES)[number];

/** ลำดับของ stage คือลำดับของ pipeline — ใช้ตัดสินลำดับ diagnostic ด้วย */
export const JOURNEY_DIAGNOSTIC_STAGES = Object.freeze([
  'AUTHORING',
  'COMPILE',
  'PREFLIGHT',
  'PREVIEW',
  'PUBLISH',
] as const);
export type JourneyDiagnosticStage = (typeof JOURNEY_DIAGNOSTIC_STAGES)[number];

export interface JourneyDiagnosticPathV1 {
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly portId?: string;
  readonly field?: string;
  readonly parameterKey?: string;
  readonly templateNodeKey?: string;
}

/** ค่าใน safeParams เป็น scalar ที่ไม่ใช่ค่าจากลูกค้าหรือ parameter value ของ template เท่านั้น */
export type JourneySafeParams = Readonly<Record<string, string | number | boolean>>;

export interface JourneyDiagnosticV1 {
  readonly code: JourneyAuthoringErrorCode;
  readonly severity: JourneyDiagnosticSeverity;
  readonly stage: JourneyDiagnosticStage;
  readonly path?: JourneyDiagnosticPathV1;
  readonly messageKey: string;
  readonly safeParams?: JourneySafeParams;
  /** reason code เดิมของ J1–J3 เมื่อ diagnostic นี้มาจาก runtime validator เดิม */
  readonly legacyReasonCode?: string;
}

export interface JourneyAuthoringErrorEnvelopeV1 {
  readonly code: JourneyAuthoringErrorCode;
  readonly correlationId: string;
  readonly safeParams?: JourneySafeParams;
  readonly diagnostics?: readonly JourneyDiagnosticV1[];
}

const rank = <T extends string>(order: readonly T[], value: T) => order.indexOf(value);
const text = (value: string | undefined) => value ?? '';

/**
 * ลำดับตาม Phase Spec §4: severity → stage → nodeId → edgeId → portId → field → code
 * ค่าที่ไม่มีเรียงก่อนค่าที่มี เพื่อให้ diagnostic ระดับเอกสารขึ้นก่อนระดับ node
 */
export function compareJourneyDiagnostics(
  left: JourneyDiagnosticV1,
  right: JourneyDiagnosticV1,
): number {
  const keys: Array<[number | string, number | string]> = [
    [
      rank(JOURNEY_DIAGNOSTIC_SEVERITIES, left.severity),
      rank(JOURNEY_DIAGNOSTIC_SEVERITIES, right.severity),
    ],
    [rank(JOURNEY_DIAGNOSTIC_STAGES, left.stage), rank(JOURNEY_DIAGNOSTIC_STAGES, right.stage)],
    [text(left.path?.nodeId), text(right.path?.nodeId)],
    [text(left.path?.edgeId), text(right.path?.edgeId)],
    [text(left.path?.portId), text(right.path?.portId)],
    [text(left.path?.field), text(right.path?.field)],
    [left.code, right.code],
  ];
  for (const [a, b] of keys) {
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

export function sortJourneyDiagnostics(
  diagnostics: readonly JourneyDiagnosticV1[],
): JourneyDiagnosticV1[] {
  return [...diagnostics].sort(compareJourneyDiagnostics);
}

/** publish ถูก block เมื่อมี ERROR อย่างน้อยหนึ่งรายการเท่านั้น (Phase Contract §10) */
export function journeyDiagnosticsBlockPublish(diagnostics: readonly JourneyDiagnosticV1[]) {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'ERROR');
}
