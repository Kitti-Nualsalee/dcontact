import {
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  canonicalCg4Digest,
  type Cg4Digest,
  type Cg4PolicyScope,
  type Cg4SourceType,
  type ContactChannel,
} from '@d-contact/cxa-contracts';
import { normalizeLocalTimeWindows, type LocalTimeWindow } from './cg3-persistence.js';
import type {
  Cg3CallbackMode,
  Cg3HolidayEntry,
  Cg3PolicyFacts,
  ContactConsentWaiver,
} from './cg3-policy-evaluator.js';
import { resolveCg4RuleMetadata } from './cg4-rule-registry.js';

/**
 * CG4.5 (#188): the single policy compiler. Preview, tests and runtime all go through
 * `compileCg4Policy` — #176 §2 forbids an alternate preview evaluator, so the compiled
 * artifact this returns is literally the `Cg3PolicyFacts` the runtime evaluator consumes.
 *
 * Normalization is what makes `contentDigest` meaningful: two authoring payloads that
 * differ only in key order, window order or duplicate rule codes compile to the same
 * canonical content and therefore to the same digest.
 */

export class Cg4PolicyValidationError extends Error {
  constructor(
    readonly code:
      | 'VALIDATION_FAILED'
      | 'SCOPE_INVALID'
      | 'RULE_NOT_REGISTERED'
      | 'NON_OVERRIDABLE_RULE'
      | 'POLICY_VERSION_UNSUPPORTED',
    message: string,
  ) {
    super(message);
    this.name = 'Cg4PolicyValidationError';
  }
}

// ── Scope key ────────────────────────────────────────────────────────────────

/** Fixed order; a scope key is only canonical if every dimension appears exactly once. */
export const CG4_POLICY_SCOPE_DIMENSIONS = Object.freeze([
  'channel',
  'contactKind',
  'purpose',
  'sourceType',
] as const);

export type Cg4PolicyScopeDimension = (typeof CG4_POLICY_SCOPE_DIMENSIONS)[number];

export type Cg4PolicyScopeDimensions = Readonly<Partial<Record<Cg4PolicyScopeDimension, string>>>;

const UNBOUND = '*';

function scopeValue(dimension: Cg4PolicyScopeDimension, value: string | undefined): string {
  if (value === undefined) return UNBOUND;
  const normalized = value.trim();
  if (!normalized || normalized === UNBOUND || /[|=]/.test(normalized)) {
    throw new Cg4PolicyValidationError(
      'SCOPE_INVALID',
      `scope dimension ${dimension} has a non-canonical value`,
    );
  }
  return normalized;
}

export function buildCg4PolicyScopeKey(dimensions: Cg4PolicyScopeDimensions): string {
  return CG4_POLICY_SCOPE_DIMENSIONS.map(
    (dimension) => `${dimension}=${scopeValue(dimension, dimensions[dimension])}`,
  ).join('|');
}

export function parseCg4PolicyScopeKey(scopeKey: string): Cg4PolicyScopeDimensions {
  const parts = scopeKey.split('|');
  if (parts.length !== CG4_POLICY_SCOPE_DIMENSIONS.length) {
    throw new Cg4PolicyValidationError('SCOPE_INVALID', 'scopeKey is not in canonical form');
  }
  const dimensions: Partial<Record<Cg4PolicyScopeDimension, string>> = {};
  parts.forEach((part, index) => {
    const expected = CG4_POLICY_SCOPE_DIMENSIONS[index] as Cg4PolicyScopeDimension;
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator) !== expected) {
      throw new Cg4PolicyValidationError('SCOPE_INVALID', 'scopeKey is not in canonical form');
    }
    const value = part.slice(separator + 1);
    if (!value)
      throw new Cg4PolicyValidationError('SCOPE_INVALID', 'scopeKey is not in canonical form');
    if (value !== UNBOUND) dimensions[expected] = value;
  });
  return dimensions;
}

/**
 * CG4.8 (#191): the dimensions put in the `affectedScope` of an event so a downstream can match its own work
 * without parsing the scopeKey itself. A scopeKey that is not in canonical form (e.g. `contact:<id>`)
 * sends only the scopeKey, which the downstream must treat as the broadest, failing closed
 */
export function cg4EventScopeDimensions(scopeKey: string): Cg4PolicyScopeDimensions {
  try {
    return parseCg4PolicyScopeKey(scopeKey);
  } catch {
    return {};
  }
}

export function cg4PolicyScopeSpecificity(scopeKey: string): number {
  return Object.keys(parseCg4PolicyScopeKey(scopeKey)).length;
}

/**
 * #176 §1: two distinct scopes of equal specificity that some single request can match
 * at once are ambiguous, and there is no publish-time tie-break. That happens exactly
 * when they bind different dimension sets and agree wherever they both bind.
 */
export function cg4PolicyScopesAmbiguous(left: string, right: string): boolean {
  if (left === right) return false;
  if (cg4PolicyScopeSpecificity(left) !== cg4PolicyScopeSpecificity(right)) return false;
  const a = parseCg4PolicyScopeKey(left);
  const b = parseCg4PolicyScopeKey(right);
  return CG4_POLICY_SCOPE_DIMENSIONS.every((dimension) => {
    const leftValue = a[dimension];
    const rightValue = b[dimension];
    return leftValue === undefined || rightValue === undefined || leftValue === rightValue;
  });
}

export function cg4PolicyScopeKeyFor(scope: Cg4PolicyScope): string {
  return buildCg4PolicyScopeKey({
    ...(scope.channel ? { channel: scope.channel } : {}),
    ...(scope.contactKind ? { contactKind: scope.contactKind } : {}),
    ...(scope.purpose ? { purpose: scope.purpose } : {}),
    ...(scope.sourceType ? { sourceType: scope.sourceType } : {}),
  });
}

/** True when a request's dimensions fall inside the scope (unbound dimension = wildcard). */
export function cg4PolicyScopeMatches(
  scopeKey: string,
  request: {
    channel?: ContactChannel;
    contactKind?: string;
    purpose?: string;
    sourceType?: Cg4SourceType;
  },
): boolean {
  const dimensions = parseCg4PolicyScopeKey(scopeKey);
  return CG4_POLICY_SCOPE_DIMENSIONS.every((dimension) => {
    const bound = dimensions[dimension];
    return bound === undefined || bound === request[dimension];
  });
}

// ── Content ──────────────────────────────────────────────────────────────────

const CALLBACK_MODES: readonly Cg3CallbackMode[] = Object.freeze([
  'NO_OVERRIDE',
  'SCOPED_OVERRIDE',
  'TIME_POLICY_OVERRIDE',
]);

export interface Cg4PolicyContentV1 {
  timezoneFallback: string | null;
  quietHours: LocalTimeWindow[];
  callbackMode: Cg3CallbackMode;
  /** CG3 temporal rules a customer callback may override. */
  overridableRules: string[];
  /** CG4 rules an Approved exception may lift under this policy version. */
  allowedOperationalRuleCodes: string[];
  holidays: Cg3HolidayEntry[];
  /**
   * #1065: present only when consent is not required. Omitted for `REQUIRED` so content written before
   * this field keeps its digest.
   */
  consent?: ContactConsentWaiver;
}

/**
 * #1065: lawful bases other than consent (PDPA section 24). `CONSENT` is not one: a policy that relies on
 * consent simply requires it.
 */
export const CG4_CONSENT_WAIVER_LAWFUL_BASES = Object.freeze([
  'CONTRACT',
  'LEGITIMATE_INTEREST',
  'LEGAL_OBLIGATION',
  'VITAL_INTEREST',
  'PUBLIC_TASK',
] as const);

/** #1065: purposes that always need consent, whatever a policy says */
export const CG4_CONSENT_ALWAYS_REQUIRED_PURPOSES = Object.freeze(['MARKETING'] as const);

function consentRequirement(value: unknown): ContactConsentWaiver | undefined {
  if (value === undefined || value === null) return undefined;
  const consent = record(value, 'consent');
  const unknown = Object.keys(consent).filter(
    (key) => key !== 'requirement' && key !== 'lawfulBasis',
  );
  if (unknown.length > 0) {
    throw new Cg4PolicyValidationError(
      'VALIDATION_FAILED',
      `consent has an unknown field: ${unknown.sort().join(', ')}`,
    );
  }
  if (consent.requirement === 'REQUIRED') {
    if (consent.lawfulBasis !== undefined && consent.lawfulBasis !== null) {
      throw new Cg4PolicyValidationError(
        'VALIDATION_FAILED',
        'consent.lawfulBasis applies only when consent.requirement is NOT_REQUIRED',
      );
    }
    return undefined;
  }
  if (consent.requirement !== 'NOT_REQUIRED') {
    throw new Cg4PolicyValidationError(
      'VALIDATION_FAILED',
      'consent.requirement must be REQUIRED | NOT_REQUIRED',
    );
  }
  const lawfulBasis = typeof consent.lawfulBasis === 'string' ? consent.lawfulBasis.trim() : '';
  if (!(CG4_CONSENT_WAIVER_LAWFUL_BASES as readonly string[]).includes(lawfulBasis)) {
    throw new Cg4PolicyValidationError(
      'VALIDATION_FAILED',
      `consent.lawfulBasis must be ${CG4_CONSENT_WAIVER_LAWFUL_BASES.join(' | ')}`,
    );
  }
  return { requirement: 'NOT_REQUIRED', lawfulBasis };
}

/**
 * #1065: a policy may stop requiring consent only for one named purpose on one named channel, and never
 * for a purpose that always needs consent. A wider scope could waive consent for work the author did not
 * mean (a wildcard purpose would cover marketing).
 */
export function cg4ConsentWaiverScopeProblem(scopeKey: string): string | undefined {
  let dimensions: Cg4PolicyScopeDimensions;
  try {
    dimensions = parseCg4PolicyScopeKey(scopeKey);
  } catch {
    return 'the scope is not in canonical form';
  }
  if (!dimensions.purpose || !dimensions.channel) {
    return 'a policy that does not require consent must name both a purpose and a channel';
  }
  if ((CG4_CONSENT_ALWAYS_REQUIRED_PURPOSES as readonly string[]).includes(dimensions.purpose)) {
    return `purpose ${dimensions.purpose} always requires consent`;
  }
  return undefined;
}

export function assertCg4ConsentScope(scopeKey: string, content: Cg4PolicyContentV1): void {
  if (!content.consent) return;
  const problem = cg4ConsentWaiverScopeProblem(scopeKey);
  if (problem) throw new Cg4PolicyValidationError('SCOPE_INVALID', problem);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Cg4PolicyValidationError('VALIDATION_FAILED', `${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function ruleCodeList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Cg4PolicyValidationError(
      'VALIDATION_FAILED',
      `${field} must be an array of rule codes`,
    );
  }
  const codes = value.map((entry, index) => {
    if (typeof entry !== 'string' || !entry.trim()) {
      throw new Cg4PolicyValidationError(
        'VALIDATION_FAILED',
        `${field}[${index}] must be a string`,
      );
    }
    return entry.trim();
  });
  // Sorted + de-duplicated so authoring order can never change the content digest.
  return [...new Set(codes)].sort();
}

function timezone(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.trim()) {
    throw new Cg4PolicyValidationError(
      'VALIDATION_FAILED',
      'timezoneFallback must be an IANA zone',
    );
  }
  const normalized = value.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: normalized });
  } catch {
    throw new Cg4PolicyValidationError(
      'VALIDATION_FAILED',
      `timezoneFallback ${normalized} is not a known IANA zone`,
    );
  }
  return normalized;
}

function windowKey(window: LocalTimeWindow): string {
  return `${window.daysOfWeek.join(',')}|${window.startLocal}|${window.endLocal}`;
}

function sortWindows(windows: LocalTimeWindow[]): LocalTimeWindow[] {
  return [...windows].sort((left, right) => (windowKey(left) < windowKey(right) ? -1 : 1));
}

function holidays(value: unknown): Cg3HolidayEntry[] {
  if (!Array.isArray(value)) {
    throw new Cg4PolicyValidationError('VALIDATION_FAILED', 'holidays must be an array');
  }
  const entries = value.map((raw, index) => {
    const entry = record(raw, `holidays[${index}]`);
    const localDate = entry.localDate;
    if (typeof localDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
      throw new Cg4PolicyValidationError(
        'VALIDATION_FAILED',
        `holidays[${index}].localDate must be YYYY-MM-DD`,
      );
    }
    if (entry.effect !== 'CLOSED' && entry.effect !== 'WINDOWS') {
      throw new Cg4PolicyValidationError(
        'VALIDATION_FAILED',
        `holidays[${index}].effect must be CLOSED or WINDOWS`,
      );
    }
    const windows =
      entry.effect === 'CLOSED'
        ? []
        : sortWindows(normalizeLocalTimeWindows((entry.windows ?? []) as LocalTimeWindow[]));
    if (entry.effect === 'WINDOWS' && windows.length === 0) {
      throw new Cg4PolicyValidationError(
        'VALIDATION_FAILED',
        `holidays[${index}] of kind WINDOWS must have at least one window`,
      );
    }
    return { localDate, effect: entry.effect, windows } satisfies Cg3HolidayEntry;
  });
  const dates = new Set(entries.map((entry) => entry.localDate));
  if (dates.size !== entries.length) {
    throw new Cg4PolicyValidationError(
      'VALIDATION_FAILED',
      'holidays must have unique localDate values',
    );
  }
  return entries.sort((left, right) => (left.localDate < right.localDate ? -1 : 1));
}

/**
 * Canonicalizes authoring input into the exact content that gets digested and stored.
 * Unknown keys are rejected rather than dropped: silently ignoring a field the author
 * believed was enforced is the fail-open direction.
 */
export function normalizeCg4PolicyContent(raw: unknown): Cg4PolicyContentV1 {
  const content = record(raw, 'content');
  const allowed = new Set([
    'timezoneFallback',
    'quietHours',
    'callbackMode',
    'overridableRules',
    'allowedOperationalRuleCodes',
    'holidays',
    'consent',
  ]);
  const unknown = Object.keys(content).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Cg4PolicyValidationError(
      'VALIDATION_FAILED',
      `content has a field that schema v${CG4_POLICY_SCHEMA_VERSION} does not recognize: ${unknown.sort().join(', ')}`,
    );
  }
  if (!CALLBACK_MODES.includes(content.callbackMode as Cg3CallbackMode)) {
    throw new Cg4PolicyValidationError(
      'VALIDATION_FAILED',
      `callbackMode must be ${CALLBACK_MODES.join(' | ')}`,
    );
  }
  const consent = consentRequirement(content.consent);
  return {
    timezoneFallback: timezone(content.timezoneFallback),
    quietHours: sortWindows(
      normalizeLocalTimeWindows((content.quietHours ?? []) as LocalTimeWindow[]),
    ),
    callbackMode: content.callbackMode as Cg3CallbackMode,
    overridableRules: ruleCodeList(content.overridableRules ?? [], 'overridableRules'),
    allowedOperationalRuleCodes: ruleCodeList(
      content.allowedOperationalRuleCodes ?? [],
      'allowedOperationalRuleCodes',
    ),
    holidays: holidays(content.holidays ?? []),
    ...(consent ? { consent } : {}),
  };
}

/**
 * #174/#176: a policy may only ever widen what an *overridable* rule allows. Listing an
 * unknown rule code, or a `NON_OVERRIDABLE` one, is rejected at authoring time so the
 * evaluator never has to decide whether a hard gate was meant to be bypassable.
 */
export function assertCg4PolicyRegistryConsistent(content: Cg4PolicyContentV1): void {
  for (const [field, codes] of [
    ['overridableRules', content.overridableRules],
    ['allowedOperationalRuleCodes', content.allowedOperationalRuleCodes],
  ] as const) {
    for (const ruleCode of codes) {
      const resolution = resolveCg4RuleMetadata(ruleCode);
      if (!resolution.known) {
        throw new Cg4PolicyValidationError(
          'RULE_NOT_REGISTERED',
          `${field} references rule ${ruleCode}, which is not in ${CG4_RULE_REGISTRY_VERSION}`,
        );
      }
      if (!resolution.metadata.overridable) {
        throw new Cg4PolicyValidationError(
          'NON_OVERRIDABLE_RULE',
          `${field} references rule ${ruleCode}, which cannot be overridden`,
        );
      }
      const mechanism = field === 'overridableRules' ? 'CUSTOMER_CALLBACK' : 'APPROVED_EXCEPTION';
      if (!resolution.metadata.allowedOverrideMechanisms.includes(mechanism)) {
        throw new Cg4PolicyValidationError(
          'NON_OVERRIDABLE_RULE',
          `rule ${ruleCode} does not support mechanism ${mechanism}`,
        );
      }
    }
  }
}

export interface Cg4CompiledPolicy {
  schemaVersion: typeof CG4_POLICY_SCHEMA_VERSION;
  registryVersion: typeof CG4_RULE_REGISTRY_VERSION;
  evaluatorVersion: typeof CG4_EVALUATOR_VERSION;
  content: Cg4PolicyContentV1;
  contentDigest: Cg4Digest;
  /** Exactly what the runtime evaluator consumes — no preview-only projection. */
  facts: Cg3PolicyFacts;
}

export interface CompileCg4PolicyInput {
  content: unknown;
  version: number;
  schemaVersion?: number;
  registryVersion?: string;
  evaluatorVersion?: string;
}

export function compileCg4Policy(input: CompileCg4PolicyInput): Cg4CompiledPolicy {
  if (!Number.isInteger(input.version) || input.version <= 0) {
    throw new Cg4PolicyValidationError('VALIDATION_FAILED', 'version must be an integer > 0');
  }
  if ((input.schemaVersion ?? CG4_POLICY_SCHEMA_VERSION) !== CG4_POLICY_SCHEMA_VERSION) {
    throw new Cg4PolicyValidationError(
      'POLICY_VERSION_UNSUPPORTED',
      'this policy schema version is not supported',
    );
  }
  if ((input.registryVersion ?? CG4_RULE_REGISTRY_VERSION) !== CG4_RULE_REGISTRY_VERSION) {
    throw new Cg4PolicyValidationError(
      'POLICY_VERSION_UNSUPPORTED',
      'this rule registry version is not supported',
    );
  }
  if ((input.evaluatorVersion ?? CG4_EVALUATOR_VERSION) !== CG4_EVALUATOR_VERSION) {
    throw new Cg4PolicyValidationError(
      'POLICY_VERSION_UNSUPPORTED',
      'this evaluator version is not supported',
    );
  }
  const content = normalizeCg4PolicyContent(input.content);
  assertCg4PolicyRegistryConsistent(content);
  return {
    schemaVersion: CG4_POLICY_SCHEMA_VERSION,
    registryVersion: CG4_RULE_REGISTRY_VERSION,
    evaluatorVersion: CG4_EVALUATOR_VERSION,
    content,
    contentDigest: canonicalCg4Digest({
      schemaVersion: CG4_POLICY_SCHEMA_VERSION,
      registryVersion: CG4_RULE_REGISTRY_VERSION,
      evaluatorVersion: CG4_EVALUATOR_VERSION,
      content,
    }),
    facts: {
      version: input.version,
      timezoneFallback: content.timezoneFallback,
      quietHours: content.quietHours,
      callbackMode: content.callbackMode,
      overridableRules: content.overridableRules,
      holidays: content.holidays,
      ...(content.consent ? { consent: content.consent } : {}),
    },
  };
}
