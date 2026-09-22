import { createHash } from 'node:crypto';
import type { JourneyDefinitionContent, JourneyGraphStep } from './journey-definition.js';
import { JOURNEY_OWNER_RESULT_CONTINUATION_CAPABILITY } from './journey-owner-continuation.js';

/**
 * J5.2 (#340): canonical JSON, digest และ runtime capability registry ของ authoring
 * (Phase Spec #337 §4)
 *
 * - UTF-8 JSON, object key เรียง lexicographic, number ใช้ serialization ของ JSON (คงที่ต่อค่า)
 * - array ที่เป็นลำดับการประเมิน (AST ของ DC_EXPR) คงลำดับเดิม
 * - runtime steps เรียงตาม `step.id` และ exit rules (unordered) เรียงตาม canonical value
 * - digest ทุกตัวเป็น SHA-256 lowercase hex
 *
 * content hash ของ published version เดิม (`inputHash`) ไม่ถูกคำนวณใหม่ — canonicalization นี้
 * ใช้กับ artifact และ publish ใหม่ของ J5 เท่านั้น
 */

export const JOURNEY_AUTHORING_COMPILER_VERSION = 'J5_COMPILER_V1';

export function canonicalJourneyJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonical JSON ไม่รองรับ number ที่ไม่ finite');
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

/** runtime content ในรูป canonical — steps เรียงตาม id และ exit rules เรียงตาม canonical value */
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

/** เทียบแบบ code unit ไม่ขึ้นกับ locale ของเครื่อง — ลำดับต้องเหมือนกันทุก environment */
export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ── Runtime capability registry ─────────────────────────────────────────────

export interface JourneyRuntimeCapability {
  readonly id: string;
  readonly version: number;
  readonly available: boolean;
  /** หลักฐานที่เปิด capability — PR/marker ที่ผ่าน acceptance แล้วเท่านั้น */
  readonly evidence: string;
}

/**
 * restricted owner-action nodes เปิดได้เมื่อ J5.0 continuation ผ่าน J2 focused/full regression
 * แล้ว (PR #352: J2 acceptance 16/16 พร้อม `JOURNEY_J2_ACCEPTED`) — Phase Contract §7
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

/** digest ของ capability ที่ artifact ใช้ — capability เปลี่ยนหลัง compile ทำให้ artifact stale */
export function journeyCapabilityDigest(capabilities: readonly JourneyRuntimeCapability[]): string {
  return journeyAuthoringDigest(
    [...capabilities]
      .map(({ id, version, available }) => ({ id, version, available }))
      .sort((left, right) => compareText(left.id, right.id)),
  );
}
