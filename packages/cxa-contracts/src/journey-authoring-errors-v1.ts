/**
 * J5.1 (#339): error and diagnostic registry for Journey authoring/template (Phase Contract #334 §10,
 * Phase Spec #337 §5)
 *
 * a pure contract with no I/O: every code is a closed set so the validator, API, Console and acceptance
 * reference the same one. The API does not use text in any language as a contract: it sends only `code`, `messageKey` and
 * `safeParams`, which carry no PII/template parameter values
 */

/** the original J1-J3 codes, each of which must keep its original meaning (#329 §9) */
export const JOURNEY_LEGACY_ERROR_CODES = Object.freeze([
  'DEFINITION_INVALID',
  'IDEMPOTENCY_CONFLICT',
  'NON_SEQUENTIAL_VERSION',
  'VERSION_NOT_FOUND',
  'DRAFT_VERSION_CONFLICT',
  'PUBLISHED_HEAD_CONFLICT',
  'JOURNEY_LIFECYCLE_CONFLICT',
] as const);

/** missing/foreign/hidden use a single generic not-found, so as not to reveal that a resource exists in another tenant */
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
 * transport-level codes that Phase Spec §5 needs for HTTP responses but that are not graph diagnostics:
 * a publish with unknown result, a dependency outage, a malformed request and the simulator's side-effect barrier
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
 * HTTP mapping per Phase Spec §5: validation/diagnostics `422`; auth `403`; generic not found
 * `404`; stale/CAS/lifecycle/review/idempotency conflict `409`; a publish with unknown result `202`;
 * dependency outage `503`; malformed body/header `400`
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

/** the stage order is the pipeline order: also used to decide the diagnostic order */
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

/** values in safeParams are scalars only, and are not customer values or template parameter values */
export type JourneySafeParams = Readonly<Record<string, string | number | boolean>>;

export interface JourneyDiagnosticV1 {
  readonly code: JourneyAuthoringErrorCode;
  readonly severity: JourneyDiagnosticSeverity;
  readonly stage: JourneyDiagnosticStage;
  readonly path?: JourneyDiagnosticPathV1;
  readonly messageKey: string;
  readonly safeParams?: JourneySafeParams;
  /** the original J1-J3 reason code when this diagnostic comes from the original runtime validator */
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
 * order per Phase Spec §4: severity -> stage -> nodeId -> edgeId -> portId -> field -> code
 * a missing value sorts before a present one, so document-level diagnostics come before node-level ones
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

/** a publish is blocked only when there is at least one ERROR (Phase Contract §10) */
export function journeyDiagnosticsBlockPublish(diagnostics: readonly JourneyDiagnosticV1[]) {
  return diagnostics.some((diagnostic) => diagnostic.severity === 'ERROR');
}
