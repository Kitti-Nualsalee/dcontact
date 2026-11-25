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
  'docker.io/keycloak/keycloak:26.7.5': `docker.io/keycloak/keycloak@sha256:${'c'.repeat(64)}`,
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

test('build passes when fast + real-boundary for the same SHA both pass fully, and verify can re-run', () => {
  const result = buildBundle({
    manifestTexts: texts(manifest('fast'), manifest('real-boundary')),
    expectedSha: SHA,
  });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.deepEqual(verifyBundle(result.text, SHA).reasons, []);
  assert.deepEqual(verifyBundle(result.text, 'd'.repeat(40)).ok, false);
});

test('build rejects: SHA mismatch, dirty, missing profile, check SKIP/missing, gate FAIL, no image digest, PII', () => {
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
    assert.ok(result.reasons.includes(reason), `${reason} is not in ${result.reasons}`);
  }
});

test('verify catches a manifest edited after build (SHA-256 mismatch)', () => {
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

test('UAT gate: no release = FAIL, attestation fails = FAIL, complete = PASS', async () => {
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

test('a run ID that looks like a phone number uses the same root metadata contract, but PII in other manifests is still rejected', () => {
  const fast = manifest('fast', {
    run: { id: '40080776718-1', profile: 'fast', startedFrom: 'github' },
  });
  const boundary = manifest('real-boundary', {
    run: { id: '40080776718-1', profile: 'real-boundary', startedFrom: 'github' },
  });
  const result = buildBundle({ manifestTexts: texts(fast, boundary), expectedSha: SHA });
  assert.equal(result.ok, true, JSON.stringify(result.reasons));
  assert.equal(verifyBundle(result.text, SHA).ok, true);
  for (const privateValue of [
    '0812345678',
    'owner@example.test',
    'postgresql://user:secret@db/data',
  ]) {
    const rejected = buildBundle({
      manifestTexts: texts(fast, { ...boundary, artifacts: [{ summary: privateValue }] }),
      expectedSha: SHA,
    });
    assert.equal(rejected.ok, false);
    assert.ok(rejected.reasons.includes('PII_OR_SECRET_IN_EVIDENCE'));
  }
});
