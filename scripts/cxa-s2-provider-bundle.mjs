import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';
import { assertS2EvidenceSafe } from './cxa-s2-negative-scan.mjs';

/**
 * S2.6 (#366): ingestion/verification ของ sanitized bundle จาก protected provider runner (#360 §C/§G)
 *
 * bundle สร้างโดย `apps/delivery/src/line-provider-evidence-bundle.ts` บนเครื่องที่มี Keychain;
 * ฝั่งนี้ไม่เชื่ออะไรใน bundle จนกว่าจะคำนวณซ้ำได้ตรง:
 * - schema/phase/runner profile ถูกต้อง และ commit ของ bundle = commit ที่ acceptance กำลังรัน
 * - SHA-256 ของ evidence รายชิ้นและ digest ของทั้งก้อน (JSON เรียง key — อัลกอริทึมเดียวกับ `sha256`)
 * - ผ่าน PII/credential guard ก่อนตรวจอย่างอื่น
 * - status ของ entry derive จาก evidence และ evidence ของ PR01 derive จาก step ครบชุด
 */
export const S2_PROVIDER_CHECK_IDS = Object.freeze([
  'S2-LINE-PR01',
  'S2-LINE-PR02',
  'S2-LINE-RB01',
]);
export const S2_RUNNER_PROFILE = 'S2_LINE_PROTECTED_RUNNER_V1';
export const S2_PR01_STEPS = Object.freeze([
  'TOKEN_VERIFIED',
  'CREDENTIAL_POLICY',
  'QUOTA_AVAILABLE',
  'PUSH_PAYLOAD_VALID',
  'WEBHOOK_ENDPOINT_BOUND',
  'WEBHOOK_SIGNED_EMPTY_TEST',
  'WEBHOOK_INVALID_SIGNATURE_REJECTED',
  'WEBHOOK_SIGNED_MESSAGE_ACCEPTED',
]);

const FULL_SHA = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function fail(message) {
  throw new TypeError(`S2 provider bundle ไม่ผ่าน: ${message}`);
}

function assertPr01(evidence) {
  if (evidence.type !== 'line.provider-conformance') fail('PR01 evidence type ไม่ถูกต้อง');
  if (evidence.pushAttempted !== false) fail('PR01 ต้องไม่มี push');
  const steps = evidence.steps ?? [];
  if (
    steps.length !== S2_PR01_STEPS.length ||
    S2_PR01_STEPS.some((id, index) => steps[index]?.id !== id)
  )
    fail('PR01 ต้องมี step ครบตามลำดับ');
  const derived = steps.every((step) => step.status === 'PASS') ? 'PASS' : 'FAIL';
  if (evidence.status !== derived) fail('status ของ PR01 ต้อง derive จาก steps');
  if (!HEX64.test(evidence.channelAccountFingerprint ?? ''))
    fail('PR01 ต้องมี channel fingerprint');
  if (!HEX64.test(evidence.token?.fingerprint ?? '')) fail('PR01 ต้องมี token fingerprint');
  if (!HEX64.test(evidence.fixture?.contentDigest ?? '')) fail('PR01 ต้องมี content digest');
}

/**
 * contract ขั้นต่ำของ evidence ที่ S2.7 ต้องส่ง (#360 §D ข้อ 5–10, §F) — FAIL ส่งรูปใดก็ได้เพื่อ freeze
 * failure evidence แต่ PASS ต้องพิสูจน์ invariant ครบ ไม่อย่างนั้น runner อ้าง PASS ลอย ๆ ได้
 */
function assertPr02(evidence) {
  if (evidence.type !== 'line.capped-pilot') fail('PR02 evidence type ไม่ถูกต้อง');
  if (evidence.status !== 'PASS') return;
  const invariant =
    evidence.pushStatus === 200 &&
    evidence.replayStatus === 409 &&
    evidence.messageIdsMatch === true &&
    evidence.logicalDeliveries === 1 &&
    evidence.attempts === 1 &&
    evidence.touches === 1 &&
    evidence.refunds === 0 &&
    evidence.duplicateObserved === false &&
    HEX64.test(evidence.proposalPresentationDigest ?? '');
  if (!invariant) fail('PR02 PASS ต้องมี 200 + 409 เดิม, delivery 1, Attempt 1, Touch 1, refund 0');
}

function assertRb01(evidence) {
  if (evidence.type !== 'line.rollback-drill') fail('RB01 evidence type ไม่ถูกต้อง');
  if (evidence.status !== 'PASS') return;
  const invariant =
    evidence.technicalSwitchOn === false &&
    evidence.killLatched === true &&
    evidence.unresolvedDeliveries === 0 &&
    evidence.credentialRevoked === true &&
    evidence.freshSendBlockedBeforeIo === true;
  if (!invariant)
    fail('RB01 PASS ต้องปิด switch, kill latched, ไม่มีค้าง, revoke และ block ก่อน I/O');
}

/**
 * คืนผลต่อ check — ไม่ throw เมื่อ provider check ล้ม (นั่นคือ evidence ที่ถูกต้องของความล้มเหลว)
 * แต่ throw เมื่อ bundle เองเชื่อไม่ได้ ซึ่งผู้เรียกต้องถือเป็น `EVIDENCE_HASH_MISMATCH`/fail closed
 */
export function verifyS2ProviderBundle(bundle, { expectedCommitSha }) {
  assertS2EvidenceSafe(bundle);
  if (
    bundle?.schemaVersion !== 1 ||
    bundle.phase !== 'S2' ||
    bundle.evidenceType !== 'line-provider-evidence-bundle'
  )
    fail('schemaVersion/phase/evidenceType ไม่ถูกต้อง');
  if (!FULL_SHA.test(bundle.commitSha ?? '')) fail('commitSha ต้องเป็น SHA เต็ม');
  if (bundle.commitSha !== expectedCommitSha)
    fail('commit ของ bundle ไม่ตรง commit ที่ acceptance รัน');
  if (
    bundle.runner?.profile !== S2_RUNNER_PROFILE ||
    bundle.runner.platform !== 'darwin' ||
    bundle.runner.keychain !== true ||
    !HEX64.test(bundle.runner.hostFingerprint ?? '')
  )
    fail('runner ไม่ใช่ protected runner profile');
  if (bundle.secretScan?.status !== 'PASS' || !(bundle.secretScan.exactValuesChecked > 0))
    fail('bundle ต้องผ่าน exact-value secret scan บน runner');

  const entries = bundle.entries ?? [];
  const ids = entries.map(({ checkId }) => checkId);
  if (entries.length === 0 || new Set(ids).size !== ids.length) fail('entries ว่างหรือซ้ำ');
  for (const entry of entries) {
    if (!S2_PROVIDER_CHECK_IDS.includes(entry.checkId)) fail(`check ที่ไม่รู้จัก ${entry.checkId}`);
    if (entry.evidence?.checkId !== entry.checkId)
      fail(`evidence ของ ${entry.checkId} ไม่ตรง entry`);
    if (entry.evidenceSha256 !== sha256(entry.evidence))
      fail(`SHA-256 ของ ${entry.checkId} ไม่ตรง`);
    if (entry.status !== entry.evidence.status) fail(`status ของ ${entry.checkId} ไม่ตรง evidence`);
    if (entry.checkId === 'S2-LINE-PR01') assertPr01(entry.evidence);
    if (entry.checkId === 'S2-LINE-PR02') assertPr02(entry.evidence);
    if (entry.checkId === 'S2-LINE-RB01') assertRb01(entry.evidence);
  }
  const { bundleSha256, ...body } = bundle;
  if (bundleSha256 !== sha256(body)) fail('bundle digest ไม่ตรง');

  return {
    type: 'provider-bundle.readiness',
    bundleSha256,
    commitSha: bundle.commitSha,
    generatedAt: bundle.generatedAt,
    runner: { profile: bundle.runner.profile, workflowRunId: bundle.runner.workflowRunId ?? null },
    checks: Object.fromEntries(
      entries.map((entry) => [
        entry.checkId,
        { status: entry.status, evidenceSha256: entry.evidenceSha256 },
      ]),
    ),
  };
}

/** อ่านหลายไฟล์ (PR01 จาก S2.6, PR02/RB01 จาก S2.7) — check เดียวกันห้ามมาจากสอง bundle */
export function verifyS2ProviderBundles(
  paths,
  options,
  read = (path) => JSON.parse(readFileSync(path, 'utf8')),
) {
  const merged = { bundles: [], checks: {} };
  for (const path of paths) {
    const result = verifyS2ProviderBundle(read(path), options);
    for (const [checkId, value] of Object.entries(result.checks)) {
      if (merged.checks[checkId]) fail(`${checkId} มาจากหลาย bundle`);
      merged.checks[checkId] = { ...value, bundleSha256: result.bundleSha256 };
    }
    merged.bundles.push({ bundleSha256: result.bundleSha256, generatedAt: result.generatedAt });
  }
  return merged;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const paths = process.argv.slice(2);
    if (paths.length === 0) throw new TypeError('ต้องระบุ path ของ bundle อย่างน้อยหนึ่งไฟล์');
    const expectedCommitSha = process.env.CXA_S2_EXPECTED_COMMIT_SHA;
    if (!expectedCommitSha) throw new TypeError('ต้องตั้ง CXA_S2_EXPECTED_COMMIT_SHA');
    const result = verifyS2ProviderBundles(paths, { expectedCommitSha });
    process.stdout.write(`CXA_S2_PROVIDER_EVIDENCE:${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
