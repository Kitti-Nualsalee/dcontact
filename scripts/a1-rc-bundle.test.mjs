import assert from 'node:assert/strict';
import test from 'node:test';
import {
  A1_CHECKS,
  A1_MANIFEST_SCHEMA,
  A1_WORKFLOW,
  NON_WAIVABLE_GATES,
} from './a1-acceptance.mjs';
import { buildBundle, verifyBundle } from './a1-rc-bundle.mjs';

const SHA = 'a'.repeat(40);
const CONFIG = 'b'.repeat(64);
const IMAGES = {
  'quay.io/keycloak/keycloak:26.0.0': `quay.io/keycloak/keycloak@sha256:${'c'.repeat(64)}`,
};

function manifest(profile, overrides = {}) {
  const checks = A1_CHECKS.filter((check) => check.profile === profile).map((check) => ({
    checkId: check.id,
    status: 'PASS',
    durationMs: 10,
    counters: { pass: 3, fail: 0, skipped: 0, todo: 0 },
    gates: check.gates ?? [],
  }));
  return {
    schemaVersion: A1_MANIFEST_SCHEMA,
    workflow: { ...A1_WORKFLOW },
    run: { id: `run-${profile}`, profile, startedFrom: 'github' },
    source: { commitSha: SHA, dirty: false, config: { sha256: CONFIG } },
    environment: {
      node: 'v20',
      platform: 'linux',
      ...(profile === 'real-boundary' ? { images: IMAGES } : {}),
    },
    status: 'PASS',
    nonWaivable: Object.fromEntries(NON_WAIVABLE_GATES.map((gate) => [gate, 'PASS'])),
    checks,
    artifacts: [],
    ...overrides,
  };
}

const texts = (...manifests) => manifests.map((m) => JSON.stringify(m));

test('build ผ่านเมื่อ fast + real-boundary ของ SHA เดียวกันผ่านครบ และ verify ซ้ำได้', () => {
  const result = buildBundle({
    manifestTexts: texts(manifest('fast'), manifest('real-boundary')),
    expectedSha: SHA,
  });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.deepEqual(verifyBundle(result.text, SHA).reasons, []);
  assert.deepEqual(verifyBundle(result.text, 'd'.repeat(40)).ok, false);
});

test('build ปฏิเสธ: SHA ไม่ตรง, dirty, profile ขาด, check SKIP/ขาด, gate FAIL, ไม่มี image digest, PII', () => {
  const fast = manifest('fast');
  const boundary = manifest('real-boundary');
  const cases = [
    [
      texts(manifest('fast', { source: { ...fast.source, commitSha: 'e'.repeat(40) } }), boundary),
      'COMMIT_MISMATCH:fast',
    ],
    [
      texts(manifest('fast', { source: { ...fast.source, dirty: true } }), boundary),
      'DIRTY_TREE:fast',
    ],
    [texts(fast), 'PROFILE_MISSING:real-boundary'],
    [
      texts(
        fast,
        manifest('real-boundary', {
          source: { ...boundary.source, config: { sha256: 'f'.repeat(64) } },
        }),
      ),
      'CONFIG_DIGEST_MISMATCH',
    ],
    [
      texts(
        manifest('fast', {
          checks: fast.checks.map((check, index) =>
            index === 0 ? { ...check, counters: { ...check.counters, skipped: 1 } } : check,
          ),
        }),
        boundary,
      ),
      `CHECK_NOT_PASS:${fast.checks[0].checkId}`,
    ],
    [
      texts(manifest('fast', { checks: fast.checks.slice(1) }), boundary),
      `CHECK_MISSING:${fast.checks[0].checkId}`,
    ],
    [
      texts(
        manifest('fast', { nonWaivable: { ...fast.nonWaivable, isolation: 'FAIL' } }),
        boundary,
      ),
      'GATE_NOT_PASS:isolation',
    ],
    [
      texts(
        manifest('fast', { nonWaivable: { ...fast.nonWaivable, 'complete-audit': 'UNCOVERED' } }),
        boundary,
      ),
      'GATE_NOT_PASS:complete-audit',
    ],
    [
      texts(fast, manifest('real-boundary', { environment: { node: 'v20' } })),
      'IMAGE_DIGESTS_MISSING',
    ],
    [
      texts(manifest('fast', { contextPointers: ['owner@example.test'] }), boundary),
      'PII_OR_SECRET_IN_EVIDENCE',
    ],
  ];
  for (const [manifestTexts, reason] of cases) {
    const result = buildBundle({ manifestTexts, expectedSha: SHA });
    assert.equal(result.ok, false, reason);
    assert.ok(result.reasons.includes(reason), `${reason} ไม่อยู่ใน ${result.reasons}`);
  }
});

test('verify จับ manifest ที่ถูกแก้หลัง build (SHA-256 ไม่ตรง)', () => {
  const { text } = buildBundle({
    manifestTexts: texts(manifest('fast'), manifest('real-boundary')),
    expectedSha: SHA,
  });
  const bundle = JSON.parse(text);
  bundle.manifests[0].content = bundle.manifests[0].content.replace('"PASS"', '"PASS" ');
  const result = verifyBundle(JSON.stringify(bundle), SHA);
  assert.equal(result.ok, false);
  assert.ok(result.reasons.includes('MANIFEST_TAMPERED:fast'), String(result.reasons));
  assert.equal(verifyBundle('not json', SHA).reasons[0], 'BUNDLE_UNREADABLE');
});

test('UAT gate: ไม่มี release = FAIL, attestation ไม่ผ่าน = FAIL, ครบ = PASS', async () => {
  const { uatGate, RC_BUNDLE_FILE } = await import('./a1-rc-bundle.mjs');
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { text } = buildBundle({
    manifestTexts: texts(manifest('fast'), manifest('real-boundary')),
    expectedSha: SHA,
  });
  const runner =
    ({ release = true, attested = true } = {}) =>
    (command, args) => {
      assert.equal(command, 'gh');
      if (args[0] === 'release') {
        if (!release) throw new Error('release not found');
        writeFileSync(join(args[args.indexOf('--dir') + 1], RC_BUNDLE_FILE), text);
        return '';
      }
      if (args[0] === 'attestation' && !attested) throw new Error('no attestation');
      return '';
    };
  assert.deepEqual(
    uatGate({ expectedSha: SHA, repo: 'o/r', run: runner({ release: false }) }).reasons,
    ['RC_RELEASE_MISSING'],
  );
  assert.deepEqual(
    uatGate({ expectedSha: SHA, repo: 'o/r', run: runner({ attested: false }) }).reasons,
    ['ATTESTATION_UNVERIFIED'],
  );
  assert.equal(uatGate({ expectedSha: SHA, repo: 'o/r', run: runner() }).ok, true);
});
