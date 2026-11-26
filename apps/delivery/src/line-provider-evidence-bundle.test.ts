import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildLineProviderEvidenceBundle,
  LineProviderBundleError,
  LINE_PROTECTED_RUNNER_PROFILE,
  stableSha256,
  type LineProviderCheckEvidence,
} from './line-provider-evidence-bundle.js';

const SHA = 'a'.repeat(40);
const SECRET = 'synthetic-bundle-secret-value';
const runner = {
  platform: 'darwin',
  keychain: true,
  hostFingerprint: 'b'.repeat(64),
  workflowRunId: null,
};
const pr01: LineProviderCheckEvidence = {
  checkId: 'S2-LINE-PR01',
  status: 'PASS',
  type: 'line.provider-conformance',
};

test('S2-LINE-EV01: the stable digest matches the vector of scripts/cxa-s2-readiness.test.mjs', () => {
  assert.equal(
    stableSha256({ b: [{ z: 1, a: 'ไทย' }], a: null, c: true }), // allow-thai: stable digest vector shared with scripts/cxa-s2-readiness.test.mjs
    'ac573c0ba944f84e3dd2c61e91939ccd0359be7ca4853176df88ee658ffc1632',
  );
});

test('S2-LINE-EV01: the bundle has per-item hashes + a whole digest and the profile of the protected runner', () => {
  const bundle = buildLineProviderEvidenceBundle({
    commitSha: SHA,
    generatedAt: new Date('2026-09-23T00:00:00.000Z'),
    runner,
    evidence: [pr01],
    secrets: [SECRET],
  });
  assert.equal(bundle.runner.profile, LINE_PROTECTED_RUNNER_PROFILE);
  assert.equal(bundle.entries[0]!.evidenceSha256, stableSha256(pr01));
  const { bundleSha256, ...body } = bundle;
  assert.equal(bundleSha256, stableSha256(body));
  assert.deepEqual(bundle.secretScan, { status: 'PASS', exactValuesChecked: 1 });
});

test('S2-LINE-OB02: a real secret or a forbidden field makes the bundle impossible to build', () => {
  const build = (evidence: LineProviderCheckEvidence) => () =>
    buildLineProviderEvidenceBundle({
      commitSha: SHA,
      generatedAt: new Date(),
      runner,
      evidence: [evidence],
      secrets: [SECRET],
    });
  assert.throws(
    build({ ...pr01, note: `prefix ${SECRET}` }),
    (error: LineProviderBundleError) =>
      error.code === 'PII_OR_CREDENTIAL_LEAK' && !error.message.includes(SECRET),
  );
  assert.throws(build({ ...pr01, replyToken: 'x' }), LineProviderBundleError);
});

test('S2-LINE-EV01: a non-full commit, a duplicate check or one outside the provider set is rejected', () => {
  const base = { generatedAt: new Date(), runner, secrets: [SECRET] };
  assert.throws(() =>
    buildLineProviderEvidenceBundle({ ...base, commitSha: 'abc', evidence: [pr01] }),
  );
  assert.throws(() =>
    buildLineProviderEvidenceBundle({ ...base, commitSha: SHA, evidence: [pr01, pr01] }),
  );
  assert.throws(() =>
    buildLineProviderEvidenceBundle({
      ...base,
      commitSha: SHA,
      evidence: [{ ...pr01, checkId: 'S2-LINE-F01' as never }],
    }),
  );
  assert.throws(() => buildLineProviderEvidenceBundle({ ...base, commitSha: SHA, evidence: [] }));
});
