/**
 * CG4.8 (#191): reading `dc.contact-governance.events` on the downstream owner side
 *
 * Journey, Dialer and Workspace do not evaluate policy or exceptions themselves (#174 §1). All they need to know
 * from an event is: which stream and which version it belongs to, what to do with pending work (ask for canonical
 * re-authorization, hold the scope, or do nothing) and the affected scope. The actual decision always comes from
 * Contact Governance through the revalidation port only.
 *
 * It lives in contracts so every consumer interprets the events with one set of rules, without having to
 * import the Contact Governance app.
 */
import { createHash } from 'node:crypto';
import type { ContactChannel } from './contact-governance.js';
import {
  CG4_CONTRACT_VERSION,
  CG4_EVALUATOR_VERSION,
  CG4_EVENT_AGGREGATE_TYPES,
  CG4_EVENT_TYPES,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  type Cg4Restrictiveness,
  type Cg4TransitionKind,
} from './contact-governance-cg4.js';

export const CG3_CONTACT_EVENT_TYPES = Object.freeze([
  'restriction.changed',
  'consent.changed',
  'preference.changed',
] as const);

/** CG4.2 foundation still writes CG3-shaped events to the same contact stream */
export const CG4_FOUNDATION_CONTACT_EVENT_TYPES = Object.freeze(['exception.recorded'] as const);

/** A reason the CG4 registry already has, used when a scoped kill switch stops work */
export const GOVERNANCE_KILL_SWITCH_ACTIVE = 'GOVERNANCE_KILL_SWITCH_ACTIVE' as const;

export type GovernanceStreamAggregate = 'CONTACT' | 'POLICY';
export type GovernanceEventFamily = 'CG3' | 'CG4';

/**
 * - `REAUTHORIZE` asks for canonical re-authorization of work inside the scope
 * - `HOLD_SCOPE` kill switch: hold work in the scope immediately without asking the evaluator
 * - `NO_OP` relaxation, or an activation that is not due yet: never resume or retry the original work
 */
export type GovernanceDownstreamEffect = 'REAUTHORIZE' | 'HOLD_SCOPE' | 'NO_OP';

/** `null` means the dimension is not bound, which is broader, not a mismatch */
export interface GovernanceDownstreamScope {
  identityId: string | null;
  channel: ContactChannel | null;
  purpose: string | null;
  contactKind: string | null;
  sourceType: string | null;
  scopeKey: string | null;
}

export interface GovernanceDownstreamEvent {
  family: GovernanceEventFamily;
  eventType: string;
  aggregate: GovernanceStreamAggregate;
  aggregateId: string;
  aggregateVersion: number;
  subjectVersion: number;
  mutationId: string;
  transitionKind?: Cg4TransitionKind;
  state?: string;
  restrictiveness: Cg4Restrictiveness;
  effect: GovernanceDownstreamEffect;
  scope: GovernanceDownstreamScope;
  stateDigest: string;
  effectiveAt: string;
  policyVersion?: number;
  /** digest of the whole payload, used to detect duplicates and hash conflicts per version */
  payloadDigest: string;
}

export const GOVERNANCE_DOWNSTREAM_REJECTION_REASONS = Object.freeze([
  'UNSUPPORTED_EVENT_TYPE',
  'UNSUPPORTED_TRANSITION_KIND',
  'MALFORMED_PAYLOAD',
  'UNSUPPORTED_CONTRACT_VERSION',
  'UNSUPPORTED_POLICY_SCHEMA_VERSION',
  'UNSUPPORTED_RULE_REGISTRY_VERSION',
  'UNSUPPORTED_EVALUATOR_VERSION',
] as const);

export type GovernanceDownstreamRejectionReason =
  (typeof GOVERNANCE_DOWNSTREAM_REJECTION_REASONS)[number];

/** A reason that must go to the DLQ (#179 §4 "unknown contract/schema version goes to the DLQ"), unlike a hash conflict */
export function isGovernanceContractRejection(
  reasonCode: string | undefined,
): reasonCode is GovernanceDownstreamRejectionReason {
  return (
    reasonCode !== undefined &&
    (GOVERNANCE_DOWNSTREAM_REJECTION_REASONS as readonly string[]).includes(reasonCode)
  );
}

export interface GovernanceDownstreamRejection {
  ok: false;
  reason: GovernanceDownstreamRejectionReason;
  detail: string;
  aggregate: GovernanceStreamAggregate;
  aggregateId: string;
  aggregateVersion: number;
  payloadDigest: string;
}

export type GovernanceDownstreamClassification =
  { ok: true; event: GovernanceDownstreamEvent } | GovernanceDownstreamRejection;

export interface GovernanceEventEnvelopeInput {
  type: string;
  aggregateType: string;
  aggregateId: string;
  aggregateVersion: number;
  payload: unknown;
}

const TRANSITION_KINDS: ReadonlySet<string> = new Set<Cg4TransitionKind>([
  'EXCEPTION_REQUESTED',
  'EXCEPTION_APPROVED',
  'EXCEPTION_REJECTED',
  'EXCEPTION_CANCELLED',
  'EXCEPTION_ACTIVATED',
  'EXCEPTION_EXPIRED',
  'EXCEPTION_REVOKED',
  'POLICY_CHANGED',
  'POLICY_ACTIVATED',
  'KILL_SWITCH_ACTIVATED',
  'KILL_SWITCH_CLEARED',
]);
const RESTRICTIVENESS: ReadonlySet<string> = new Set(['TIGHTENING', 'NEUTRAL', 'RELAXATION']);
const SHA256_HEX = /^[a-f0-9]{64}$/;

export function governanceStreamAggregate(
  aggregateType: string,
): GovernanceStreamAggregate | undefined {
  if (aggregateType === CG4_EVENT_AGGREGATE_TYPES.CONTACT) return 'CONTACT';
  if (aggregateType === CG4_EVENT_AGGREGATE_TYPES.POLICY) return 'POLICY';
  return undefined;
}

/**
 * The same digest the Journey/Dialer inbox has used since S1 (keys sorted with localeCompare)
 * kept so existing inbox rows can be compared correctly with redelivered events
 */
export function governancePayloadDigest(value: unknown): string {
  const encode = (item: unknown): string => {
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    if (item && typeof item === 'object') {
      return `{${Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => `${JSON.stringify(key)}:${encode(nested)}`)
        .join(',')}}`;
    }
    return JSON.stringify(item ?? null);
  };
  return createHash('sha256').update(encode(value)).digest('hex');
}

class PayloadRejection extends Error {
  constructor(
    readonly reason: GovernanceDownstreamRejectionReason,
    detail: string,
  ) {
    super(detail);
  }
}

function malformed(detail: string): never {
  throw new PayloadRejection('MALFORMED_PAYLOAD', detail);
}

function objectField(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    malformed(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) malformed(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string): string | null {
  if (value === undefined || value === null) return null;
  return requiredString(value, name);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    malformed(`${name} must be a positive integer`);
  }
  return value as number;
}

function sha256(value: unknown, name: string): string {
  if (typeof value !== 'string' || !SHA256_HEX.test(value)) {
    malformed(`${name} must be a lowercase SHA-256`);
  }
  return value;
}

function instant(value: unknown, name: string): string {
  const text = requiredString(value, name);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) malformed(`${name} must be ISO-8601`);
  return parsed.toISOString();
}

function optionalPolicyVersion(payload: Record<string, unknown>): { policyVersion?: number } {
  return payload.policyVersion === undefined
    ? {}
    : { policyVersion: positiveInteger(payload.policyVersion, 'policyVersion') };
}

/** CG3 payload: the subject version is always the aggregate version, and every change must re-authorize */
function parseCg3Shape(
  input: GovernanceEventEnvelopeInput,
  aggregate: GovernanceStreamAggregate,
  payloadDigest: string,
): GovernanceDownstreamEvent {
  const payload = objectField(input.payload, 'payload');
  if (payload.contractVersion !== 1) {
    throw new PayloadRejection(
      'UNSUPPORTED_CONTRACT_VERSION',
      `CG3 contractVersion ${String(payload.contractVersion)} is not supported`,
    );
  }
  const subjectVersion = positiveInteger(payload.subjectVersion, 'subjectVersion');
  if (subjectVersion !== input.aggregateVersion) {
    malformed('CG3 subjectVersion must match the envelope aggregateVersion');
  }
  const scope = objectField(payload.affectedScope, 'affectedScope');
  return {
    family: 'CG3',
    eventType: input.type,
    aggregate,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    subjectVersion,
    mutationId: requiredString(payload.mutationId, 'mutationId'),
    restrictiveness: 'NEUTRAL',
    effect: 'REAUTHORIZE',
    scope: {
      identityId: optionalString(scope.identityId, 'affectedScope.identityId'),
      channel: optionalString(scope.channel, 'affectedScope.channel') as ContactChannel | null,
      purpose: optionalString(scope.purpose, 'affectedScope.purpose'),
      contactKind: optionalString(scope.contactKind, 'affectedScope.contactKind'),
      sourceType: null,
      scopeKey: null,
    },
    stateDigest: sha256(payload.stateDigest, 'stateDigest'),
    effectiveAt: instant(payload.effectiveAt, 'effectiveAt'),
    ...optionalPolicyVersion(payload),
    payloadDigest,
  };
}

const TRANSITIONS_BY_EVENT_TYPE: Readonly<Record<string, (kind: string) => boolean>> = {
  [CG4_EVENT_TYPES.EXCEPTION_CHANGED]: (kind) => kind.startsWith('EXCEPTION_'),
  [CG4_EVENT_TYPES.POLICY_CHANGED]: (kind) =>
    kind === 'POLICY_CHANGED' || kind === 'POLICY_ACTIVATED',
  [CG4_EVENT_TYPES.KILL_SWITCH_CHANGED]: (kind) => kind.startsWith('KILL_SWITCH_'),
};

/**
 * CG4 payload (#179 §4). The contract/schema/registry/evaluator versions are checked before any other field:
 * a payload from a newer contract may have a different shape and must come out as unsupported, not malformed
 */
function parseCg4Shape(
  input: GovernanceEventEnvelopeInput,
  aggregate: GovernanceStreamAggregate,
  payloadDigest: string,
): GovernanceDownstreamEvent {
  const payload = objectField(input.payload, 'payload');
  const versionChecks = [
    ['contractVersion', CG4_CONTRACT_VERSION, 'UNSUPPORTED_CONTRACT_VERSION'],
    ['policySchemaVersion', CG4_POLICY_SCHEMA_VERSION, 'UNSUPPORTED_POLICY_SCHEMA_VERSION'],
    ['ruleRegistryVersion', CG4_RULE_REGISTRY_VERSION, 'UNSUPPORTED_RULE_REGISTRY_VERSION'],
    ['evaluatorVersion', CG4_EVALUATOR_VERSION, 'UNSUPPORTED_EVALUATOR_VERSION'],
  ] as const;
  for (const [field, expected, reason] of versionChecks) {
    if (payload[field] !== expected) {
      throw new PayloadRejection(reason, `${field} ${String(payload[field])} is not supported`);
    }
  }

  const transitionKind = requiredString(payload.transitionKind, 'transitionKind');
  if (!TRANSITION_KINDS.has(transitionKind)) {
    throw new PayloadRejection(
      'UNSUPPORTED_TRANSITION_KIND',
      `transitionKind ${transitionKind} is not supported`,
    );
  }
  if (!TRANSITIONS_BY_EVENT_TYPE[input.type]?.(transitionKind)) {
    malformed(`transitionKind ${transitionKind} does not match event type ${input.type}`);
  }
  const restrictiveness = requiredString(payload.restrictiveness, 'restrictiveness');
  if (!RESTRICTIVENESS.has(restrictiveness)) malformed('restrictiveness is not a known value');
  const state = requiredString(payload.state, 'state');
  const scope = objectField(payload.affectedScope, 'affectedScope');
  requiredString(payload.subjectId, 'subjectId');
  sha256(payload.scopeDigest, 'scopeDigest');

  let effect: GovernanceDownstreamEffect;
  if (input.type === CG4_EVENT_TYPES.KILL_SWITCH_CHANGED) {
    if (state === 'ACTIVE') {
      if (restrictiveness !== 'TIGHTENING') malformed('an ACTIVE kill switch must be TIGHTENING');
      effect = 'HOLD_SCOPE';
    } else if (state === 'CLEARED') {
      effect = 'NO_OP';
    } else {
      malformed(`kill switch state ${state} is not supported`);
    }
  } else if (input.type === CG4_EVENT_TYPES.POLICY_CHANGED && state === 'SCHEDULED') {
    // a head that has not reached its activation time does not change any result yet; the activation emits its own event
    effect = 'NO_OP';
  } else {
    effect = restrictiveness === 'RELAXATION' ? 'NO_OP' : 'REAUTHORIZE';
  }

  return {
    family: 'CG4',
    eventType: input.type,
    aggregate,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    subjectVersion: positiveInteger(payload.subjectVersion, 'subjectVersion'),
    mutationId: requiredString(payload.mutationId, 'mutationId'),
    transitionKind: transitionKind as Cg4TransitionKind,
    state,
    restrictiveness: restrictiveness as Cg4Restrictiveness,
    effect,
    scope: {
      identityId: null,
      channel: optionalString(scope.channel, 'affectedScope.channel') as ContactChannel | null,
      purpose: optionalString(scope.purpose, 'affectedScope.purpose'),
      contactKind: optionalString(scope.contactKind, 'affectedScope.contactKind'),
      sourceType: optionalString(scope.sourceType, 'affectedScope.sourceType'),
      scopeKey: requiredString(scope.scopeKey, 'affectedScope.scopeKey'),
    },
    stateDigest: sha256(payload.stateDigest, 'stateDigest'),
    effectiveAt: instant(payload.effectiveAt, 'effectiveAt'),
    ...optionalPolicyVersion(payload),
    payloadDigest,
  };
}

/**
 * returns `undefined` only when the aggregateType does not belong to Contact Governance, which has no scope,
 * so it can fail closed right away; every other case returns a result the consumer can use to decide what to do next
 */
export function classifyGovernanceEvent(
  input: GovernanceEventEnvelopeInput,
): GovernanceDownstreamClassification | undefined {
  const aggregate = governanceStreamAggregate(input.aggregateType);
  if (!aggregate) return undefined;
  const payloadDigest = governancePayloadDigest(input.payload);
  const rejection = (
    reason: GovernanceDownstreamRejectionReason,
    detail: string,
  ): GovernanceDownstreamRejection => ({
    ok: false,
    reason,
    detail,
    aggregate,
    aggregateId: input.aggregateId,
    aggregateVersion: input.aggregateVersion,
    payloadDigest,
  });

  if (!Number.isInteger(input.aggregateVersion) || input.aggregateVersion < 1) {
    return rejection('MALFORMED_PAYLOAD', 'aggregateVersion must be a positive integer');
  }

  try {
    if (aggregate === 'CONTACT') {
      if (
        (CG3_CONTACT_EVENT_TYPES as readonly string[]).includes(input.type) ||
        (CG4_FOUNDATION_CONTACT_EVENT_TYPES as readonly string[]).includes(input.type)
      ) {
        return { ok: true, event: parseCg3Shape(input, aggregate, payloadDigest) };
      }
      if (input.type === CG4_EVENT_TYPES.EXCEPTION_CHANGED) {
        return { ok: true, event: parseCg4Shape(input, aggregate, payloadDigest) };
      }
    } else {
      if (input.type === CG4_EVENT_TYPES.POLICY_CHANGED) {
        const payload = input.payload as Record<string, unknown> | null;
        const isCg4 = !!payload && typeof payload === 'object' && 'transitionKind' in payload;
        return {
          ok: true,
          event: isCg4
            ? parseCg4Shape(input, aggregate, payloadDigest)
            : parseCg3Shape(input, aggregate, payloadDigest),
        };
      }
      if (input.type === CG4_EVENT_TYPES.KILL_SWITCH_CHANGED) {
        return { ok: true, event: parseCg4Shape(input, aggregate, payloadDigest) };
      }
    }
  } catch (error) {
    if (error instanceof PayloadRejection) return rejection(error.reason, error.message);
    throw error;
  }
  return rejection(
    'UNSUPPORTED_EVENT_TYPE',
    `event type ${input.type} is not supported on ${input.aggregateType}`,
  );
}

export interface GovernanceWorkScope {
  identityId: string;
  channel: string;
  purpose: string;
  /** Unknown contactKind of the work = treat it as in scope so it fails closed */
  contactKind?: string | null;
  /** source types this owner's work can have, e.g. Dialer is both DIALER and CAMPAIGN */
  sourceTypes: readonly string[];
}

export function governanceScopeCovers(
  scope: GovernanceDownstreamScope,
  work: GovernanceWorkScope,
): boolean {
  if (scope.identityId && scope.identityId !== work.identityId) return false;
  if (scope.channel && scope.channel !== work.channel) return false;
  if (scope.purpose && scope.purpose !== work.purpose) return false;
  if (scope.sourceType && !work.sourceTypes.includes(scope.sourceType)) return false;
  if (scope.contactKind && work.contactKind && scope.contactKind !== work.contactKind) {
    return false;
  }
  return true;
}

export interface GovernanceStreamCursor {
  version: number;
  digest: string;
}

export type GovernanceStreamPosition =
  /** exactly the next version */
  | { kind: 'APPLY' }
  /** version+digest already applied: no duplicate effect */
  | { kind: 'DUPLICATE' }
  /** same version but a different digest: two truths for one version */
  | { kind: 'HASH_CONFLICT'; version: number }
  /** a version is missing: never build a projection over a gap */
  | { kind: 'GAP'; expectedVersion: number; receivedVersion: number }
  /** older than the version the cursor skipped past with a canonical reload */
  | { kind: 'SUPERSEDED' };

/**
 * Position of an event within the stream of a single aggregate (#179 §4). A pure function so every
 * consumer decides the same way and every branch can be tested without a broker
 *
 * `appliedAtIncomingVersion` is used only when the event is older than the cursor: if that version was already
 * applied, compare the digest of that version itself, not that of the cursor
 */
export function classifyGovernanceStreamPosition(input: {
  cursor?: GovernanceStreamCursor;
  appliedAtIncomingVersion?: { digest: string };
  incoming: GovernanceStreamCursor;
}): GovernanceStreamPosition {
  const { cursor, incoming } = input;
  if (!cursor) {
    return incoming.version === 1
      ? { kind: 'APPLY' }
      : { kind: 'GAP', expectedVersion: 1, receivedVersion: incoming.version };
  }
  if (incoming.version === cursor.version + 1) return { kind: 'APPLY' };
  if (incoming.version > cursor.version) {
    return {
      kind: 'GAP',
      expectedVersion: cursor.version + 1,
      receivedVersion: incoming.version,
    };
  }
  const applied =
    incoming.version === cursor.version
      ? { digest: cursor.digest }
      : input.appliedAtIncomingVersion;
  if (!applied) return { kind: 'SUPERSEDED' };
  return applied.digest === incoming.digest
    ? { kind: 'DUPLICATE' }
    : { kind: 'HASH_CONFLICT', version: incoming.version };
}
