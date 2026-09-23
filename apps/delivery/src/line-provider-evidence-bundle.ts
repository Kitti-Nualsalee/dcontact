/**
 * Owner: Delivery/Channels — sanitized evidence bundle ของ protected provider runner (S2.6 #366)
 *
 * Authority: #360 §C/§E/§G
 *
 * bundle คือสิ่งเดียวที่ออกจากเครื่อง protected runner ไปถึง CI: ไม่มี token/secret/recipient/body
 * มีแค่ evidence ของ provider checks (PR01 ใน S2.6; PR02/RB01 ใน S2.7) พร้อม SHA-256 รายชิ้นและ
 * digest ของทั้งก้อน ฝั่ง CI (`scripts/cxa-s2-provider-bundle.mjs`) คำนวณ digest ซ้ำด้วยอัลกอริทึม
 * เดียวกัน (JSON ที่เรียง key แล้ว) ถ้าไม่ตรงคือ `EVIDENCE_HASH_MISMATCH`
 *
 * bundle ที่สร้างบนเครื่อง local เป็น candidate เสมอ — marker ต้องมาจาก ingestion job บน final main
 * ที่ตรวจ bundle นี้ซ้ำแล้ว upload เป็น immutable Actions artifact (#360 §G)
 */
import { createHash } from 'node:crypto';
import { assertRedactedPayload } from './line-credential-boundary.js';
import { assertNoSecretValue } from './line-provider-conformance.js';

export const LINE_PROVIDER_BUNDLE_SCHEMA_VERSION = 1 as const;
export const LINE_PROTECTED_RUNNER_PROFILE = 'S2_LINE_PROTECTED_RUNNER_V1' as const;
export const LINE_PROVIDER_CHECK_IDS = ['S2-LINE-PR01', 'S2-LINE-PR02', 'S2-LINE-RB01'] as const;
export type LineProviderCheckId = (typeof LINE_PROVIDER_CHECK_IDS)[number];

export interface LineProviderCheckEvidence {
  checkId: LineProviderCheckId;
  status: 'PASS' | 'FAIL';
  [field: string]: unknown;
}

export interface LineProviderBundleEntry {
  checkId: LineProviderCheckId;
  status: 'PASS' | 'FAIL';
  evidenceSha256: string;
  evidence: LineProviderCheckEvidence;
}

export interface LineProviderEvidenceBundle {
  schemaVersion: typeof LINE_PROVIDER_BUNDLE_SCHEMA_VERSION;
  phase: 'S2';
  evidenceType: 'line-provider-evidence-bundle';
  commitSha: string;
  generatedAt: string;
  runner: {
    profile: typeof LINE_PROTECTED_RUNNER_PROFILE;
    platform: string;
    keychain: boolean;
    hostFingerprint: string;
    workflowRunId: string | null;
  };
  entries: LineProviderBundleEntry[];
  secretScan: { status: 'PASS'; exactValuesChecked: number };
  bundleSha256: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

/** อัลกอริทึมเดียวกับ `sha256` ของ `scripts/cxa-c1-readiness.mjs` — ห้ามแยกกันเปลี่ยน */
export function stableSha256(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

const FULL_SHA = /^[0-9a-f]{40}$/;

export class LineProviderBundleError extends Error {
  constructor(readonly code: 'BUNDLE_INVALID' | 'PII_OR_CREDENTIAL_LEAK') {
    super(`สร้าง provider evidence bundle ไม่ได้: ${code}`);
    this.name = 'LineProviderBundleError';
  }
}

export interface BuildLineProviderBundleInput {
  commitSha: string;
  generatedAt: Date;
  runner: Omit<LineProviderEvidenceBundle['runner'], 'profile'>;
  evidence: readonly LineProviderCheckEvidence[];
  /** ค่า secret จริงที่ runner ถืออยู่ — ใช้ตรวจแบบ exact-value แล้วทิ้ง ไม่ถูกเก็บ */
  secrets: readonly string[];
}

export function buildLineProviderEvidenceBundle(
  input: BuildLineProviderBundleInput,
): LineProviderEvidenceBundle {
  if (!FULL_SHA.test(input.commitSha)) throw new LineProviderBundleError('BUNDLE_INVALID');
  const checkIds = input.evidence.map(({ checkId }) => checkId);
  if (
    checkIds.length === 0 ||
    new Set(checkIds).size !== checkIds.length ||
    checkIds.some((id) => !LINE_PROVIDER_CHECK_IDS.includes(id))
  ) {
    throw new LineProviderBundleError('BUNDLE_INVALID');
  }
  const entries = input.evidence.map((evidence) => ({
    checkId: evidence.checkId,
    status: evidence.status,
    evidenceSha256: stableSha256(evidence),
    evidence,
  }));
  const body = {
    schemaVersion: LINE_PROVIDER_BUNDLE_SCHEMA_VERSION,
    phase: 'S2' as const,
    evidenceType: 'line-provider-evidence-bundle' as const,
    commitSha: input.commitSha,
    generatedAt: input.generatedAt.toISOString(),
    runner: { profile: LINE_PROTECTED_RUNNER_PROFILE, ...input.runner },
    entries,
    secretScan: { status: 'PASS' as const, exactValuesChecked: input.secrets.length },
  };
  try {
    assertRedactedPayload(body);
    assertNoSecretValue(body, input.secrets);
  } catch {
    throw new LineProviderBundleError('PII_OR_CREDENTIAL_LEAK');
  }
  return { ...body, bundleSha256: stableSha256(body) };
}

export function lineHostFingerprint(hostname: string): string {
  return createHash('sha256').update(`line-runner-host|${hostname}`).digest('hex');
}
