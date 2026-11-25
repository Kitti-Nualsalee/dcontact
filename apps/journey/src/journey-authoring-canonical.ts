import { createHash } from 'node:crypto';
import type { JourneyDefinitionContent, JourneyGraphStep } from './journey-definition.js';
import { JOURNEY_OWNER_RESULT_CONTINUATION_CAPABILITY } from './journey-owner-continuation.js';

/**
 * J5.2 (#340): canonical JSON, digest and runtime capability registry for authoring
 * (Phase Spec #337 §4)
 *
 * - UTF-8 JSON, object keys sorted lexicographically, numbers use JSON serialization (stable per value)
 * - arrays that are an evaluation order (the DC_EXPR AST) keep their original order
 * - runtime steps are sorted by `step.id` and exit rules (unordered) by canonical value
 * - every digest is lowercase hex SHA-256
 *
 * The content hash of existing published versions (`inputHash`) is not recomputed — this canonicalization
 * applies only to J5 artifacts and new publishes
 */

export const JOURNEY_AUTHORING_COMPILER_VERSION = 'J5_COMPILER_V1';

export function canonicalJourneyJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonical JSON does not support a non-finite number');
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]),
  );
}

export function journeyAuthoringDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJourneyJson(value), 'utf8').digest('hex');
}

/** Runtime content in canonical form — steps sorted by id and exit rules sorted by canonical value */
export function canonicalRuntimeDefinition(
  content: JourneyDefinitionContent,
): JourneyDefinitionContent {
  const steps = [...content.graph.steps]
    .sort((left, right) => compareText(left.id, right.id))
    .map((step) => canonicalize(step) as JourneyGraphStep);
  const exitRules = [...content.exitRules].sort((left, right) =>
    compareText(canonicalJourneyJson(left), canonicalJourneyJson(right)),
  );
  return canonicalize({
    ...content,
    graph: { entryStepId: content.graph.entryStepId, steps },
    exitRules,
  }) as JourneyDefinitionContent;
}

export function journeyRuntimeHash(content: JourneyDefinitionContent): string {
  return journeyAuthoringDigest(canonicalRuntimeDefinition(content));
}

/** Compare by code unit, independent of the machine locale — the order must be the same in every environment */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ── Runtime capability registry ─────────────────────────────────────────────

export interface JourneyRuntimeCapability {
  readonly id: string;
  readonly version: number;
  readonly available: boolean;
  /** Evidence that enables the capability — only a PR/marker that has passed acceptance */
  readonly evidence: string;
}

/**
 * restricted owner-action nodes can be enabled once J5.0 continuation passes the J2 focused/full regression
 * (PR #352: J2 acceptance 16/16 with `JOURNEY_J2_ACCEPTED`) — Phase Contract §7
 */
export const JOURNEY_RUNTIME_CAPABILITIES: readonly JourneyRuntimeCapability[] = Object.freeze([
  Object.freeze({
    id: JOURNEY_OWNER_RESULT_CONTINUATION_CAPABILITY.id,
    version: JOURNEY_OWNER_RESULT_CONTINUATION_CAPABILITY.version,
    available: true,
    evidence: 'PR#352',
  }),
]);

export const RESTRICTED_NODE_CAPABILITY = JOURNEY_OWNER_RESULT_CONTINUATION_CAPABILITY.id;

export function capabilityAvailable(
  capabilities: readonly JourneyRuntimeCapability[],
  id: string,
): boolean {
  return capabilities.some((capability) => capability.id === id && capability.available);
}

/** Digest of the capabilities an artifact uses — a capability change after compile makes the artifact stale */
export function journeyCapabilityDigest(capabilities: readonly JourneyRuntimeCapability[]): string {
  return journeyAuthoringDigest(
    [...capabilities]
      .map(({ id, version, available }) => ({ id, version, available }))
      .sort((left, right) => compareText(left.id, right.id)),
  );
}
