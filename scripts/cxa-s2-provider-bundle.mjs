import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';
import { assertS2EvidenceSafe } from './cxa-s2-negative-scan.mjs';

/**
 * S2.6 (#366): ingestion/verification of the sanitized bundle from the protected provider runner (#360 §C/§G)
 *
 * The bundle is built by `apps/delivery/src/line-provider-evidence-bundle.ts` on a machine with a Keychain;
 * this side trusts nothing in the bundle until it can recompute it exactly:
 * - schema/phase/runner profile are correct, and the bundle commit = the commit the acceptance is running
 * - SHA-256 of each evidence and the digest of the whole (JSON with sorted keys - the same algorithm as `sha256`)
 * - passes the PII/credential guard before anything else is checked
 * - the entry status is derived from the evidence, and the PR01 evidence is derived from the full set of steps
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
  throw new TypeError(`S2 provider bundle failed: ${message}`);
}

function assertPr01(evidence) {
  if (evidence.type !== 'line.provider-conformance') fail('PR01 evidence type is invalid');
  if (evidence.pushAttempted !== false) fail('PR01 must have no push');
  const steps = evidence.steps ?? [];
  if (
    steps.length !== S2_PR01_STEPS.length ||
    S2_PR01_STEPS.some((id, index) => steps[index]?.id !== id)
  )
    fail('PR01 must have the full set of steps in order');
  const derived = steps.every((step) => step.status === 'PASS') ? 'PASS' : 'FAIL';
  if (evidence.status !== derived) fail('the PR01 status must be derived from the steps');
  if (!HEX64.test(evidence.channelAccountFingerprint ?? ''))
    fail('PR01 must have a channel fingerprint');
  if (!HEX64.test(evidence.token?.fingerprint ?? '')) fail('PR01 must have a token fingerprint');
  if (!HEX64.test(evidence.fixture?.contentDigest ?? '')) fail('PR01 must have a content digest');
}

/**
 * minimum contract of the evidence S2.7 must send (#360 §D items 5-10, §F) - a FAIL may take any shape so failure evidence
 * can be frozen, but a PASS must prove every invariant, otherwise a runner could claim PASS out of thin air
 */
function assertPr02(evidence) {
  if (evidence.type !== 'line.capped-pilot') fail('PR02 evidence type is invalid');
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
  if (!invariant)
    fail('PR02 PASS needs the original 200 + 409, delivery 1, Attempt 1, Touch 1, refund 0');
}

function assertRb01(evidence) {
  if (evidence.type !== 'line.rollback-drill') fail('RB01 evidence type is invalid');
  if (evidence.status !== 'PASS') return;
  const invariant =
    evidence.technicalSwitchOn === false &&
    evidence.killLatched === true &&
    evidence.unresolvedDeliveries === 0 &&
    evidence.credentialRevoked === true &&
    evidence.freshSendBlockedBeforeIo === true;
  if (!invariant)
    fail('RB01 PASS needs switch closed, kill latched, nothing stuck, revoke and block before I/O');
}

/**
 * Returns the result per check - does not throw when a provider check fails (that is the correct evidence of a failure)
 * but throws when the bundle itself cannot be trusted, which the caller must treat as `EVIDENCE_HASH_MISMATCH`/fail closed
 */
export function verifyS2ProviderBundle(bundle, { expectedCommitSha }) {
  assertS2EvidenceSafe(bundle);
  if (
    bundle?.schemaVersion !== 1 ||
    bundle.phase !== 'S2' ||
    bundle.evidenceType !== 'line-provider-evidence-bundle'
  )
    fail('invalid schemaVersion/phase/evidenceType');
  if (!FULL_SHA.test(bundle.commitSha ?? '')) fail('commitSha must be a full SHA');
  if (bundle.commitSha !== expectedCommitSha)
    fail('the bundle commit does not match the commit the acceptance runs');
  if (
    bundle.runner?.profile !== S2_RUNNER_PROFILE ||
    bundle.runner.platform !== 'darwin' ||
    bundle.runner.keychain !== true ||
    !HEX64.test(bundle.runner.hostFingerprint ?? '')
  )
    fail('the runner is not a protected runner profile');
  if (bundle.secretScan?.status !== 'PASS' || !(bundle.secretScan.exactValuesChecked > 0))
    fail('the bundle must pass the exact-value secret scan on the runner');

  const entries = bundle.entries ?? [];
  const ids = entries.map(({ checkId }) => checkId);
  if (entries.length === 0 || new Set(ids).size !== ids.length)
    fail('entries are empty or duplicated');
  for (const entry of entries) {
    if (!S2_PROVIDER_CHECK_IDS.includes(entry.checkId)) fail(`unknown check ${entry.checkId}`);
    if (entry.evidence?.checkId !== entry.checkId)
      fail(`evidence of ${entry.checkId} does not match the entry`);
    if (entry.evidenceSha256 !== sha256(entry.evidence))
      fail(`SHA-256 of ${entry.checkId} does not match`);
    if (entry.status !== entry.evidence.status)
      fail(`status of ${entry.checkId} does not match the evidence`);
    if (entry.checkId === 'S2-LINE-PR01') assertPr01(entry.evidence);
    if (entry.checkId === 'S2-LINE-PR02') assertPr02(entry.evidence);
    if (entry.checkId === 'S2-LINE-RB01') assertRb01(entry.evidence);
  }
  const { bundleSha256, ...body } = bundle;
  if (bundleSha256 !== sha256(body)) fail('bundle digest does not match');

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

/** Read several files (PR01 from S2.6, PR02/RB01 from S2.7) - the same check must not come from two bundles */
export function verifyS2ProviderBundles(
  paths,
  options,
  read = (path) => JSON.parse(readFileSync(path, 'utf8')),
) {
  const merged = { bundles: [], checks: {} };
  for (const path of paths) {
    const result = verifyS2ProviderBundle(read(path), options);
    for (const [checkId, value] of Object.entries(result.checks)) {
      if (merged.checks[checkId]) fail(`${checkId} comes from several bundles`);
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
    if (paths.length === 0) throw new TypeError('at least one bundle path is required');
    const expectedCommitSha = process.env.CXA_S2_EXPECTED_COMMIT_SHA;
    if (!expectedCommitSha) throw new TypeError('CXA_S2_EXPECTED_COMMIT_SHA must be set');
    const result = verifyS2ProviderBundles(paths, { expectedCommitSha });
    process.stdout.write(`CXA_S2_PROVIDER_EVIDENCE:${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
