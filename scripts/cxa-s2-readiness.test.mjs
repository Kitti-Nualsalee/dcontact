import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';
import {
  assertS2EvidenceSafe,
  cxaS2NegativeScan,
  S2_FORBIDDEN_FIELD_NAMES,
  scanTextForS2Leaks,
} from './cxa-s2-negative-scan.mjs';
import {
  S2_PR01_STEPS,
  verifyS2ProviderBundle,
  verifyS2ProviderBundles,
} from './cxa-s2-provider-bundle.mjs';
import {
  assertValidCxaS2EvidenceManifest,
  CXA_S2_READINESS_CHECKS,
  executeS2Suite,
  ingestS2ProviderEvidence,
  runCxaS2Readiness,
  s2Checks,
  s2ContentDigests,
  S2_DIMENSIONS,
  S2_FAULT_SUITES,
  S2_MARKER,
  S2_MARKER_FLAGS,
  s2SuitePlan,
} from './cxa-s2-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);
const HEX = (seed) => sha256(seed);

const FROZEN_IDS = [
  'S2-LINE-F01',
  'S2-LINE-F02',
  'S2-LINE-F03',
  'S2-LINE-F04',
  'S2-LINE-TI01',
  'S2-LINE-AU01',
  'S2-LINE-ID01',
  'S2-LINE-CC01',
  'S2-LINE-RC01',
  'S2-LINE-RC02',
  'S2-LINE-RC03',
  'S2-LINE-MG01',
  'S2-LINE-OB01',
  'S2-LINE-OB02',
  'S2-LINE-REG01',
  'S2-LINE-PR01',
  'S2-LINE-PR02',
  'S2-LINE-RB01',
  'S2-LINE-EV01',
];

function finalMainContext(overrides = {}) {
  const runUrl = 'https://github.com/o/r/actions/runs/123/attempts/1';
  return {
    repository: 'o/r',
    defaultBranch: 'main',
    ref: 'refs/heads/main',
    pullRequest: null,
    baseSha: SHA,
    commitSha: SHA,
    finalMainSha: SHA,
    expectedCommitSha: SHA,
    cleanTree: true,
    runId: '123',
    attempt: 1,
    runUrl,
    protectedEnvironment: 'line-provider-pilot',
    artifact: {
      name: `cxa-s2-evidence-${SHA}`,
      url: `${runUrl}#artifacts`,
      immutable: true,
      retentionDays: 90,
    },
    ...overrides,
  };
}

const DIGESTS = Object.freeze({ registry: HEX('registry'), migrations: HEX('migrations') });

/** suite double: ผ่านทุกตัว และคืน evidence ของ scan/schema เหมือนของจริง */
function passingSuite(suite) {
  const text = suite.command.join(' ');
  const evidence = text.includes('cxa-s2-negative-scan')
    ? [{ type: 'negative-scan.readiness', status: 'PASS', files: 3, layers: {}, allowlist: [] }]
    : text.includes('cxa-s2-schema-readiness')
      ? [{ type: 'schema.readiness', status: 'PASS', existing: 'PASS', fresh: 'PASS' }]
      : [];
  return {
    status: 'PASS',
    durationMs: 1,
    runtimeLogScan: { status: 'PASS', rules: [] },
    tap: { tests: 1, passed: 1, failed: 0, cancelled: 0, skipped: 0, todo: 0 },
    ...(evidence.length > 0 ? { evidence } : {}),
  };
}

function pr01Evidence(status = 'PASS') {
  return {
    type: 'line.provider-conformance',
    checkId: 'S2-LINE-PR01',
    status,
    startedAt: '2026-09-23T00:00:00.000Z',
    finishedAt: '2026-09-23T00:01:00.000Z',
    channelAccountFingerprint: HEX('channel'),
    token: {
      credentialRefId: '00000000-0000-4000-8000-000000000001',
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      version: 1,
      fingerprint: HEX('token'),
      expiresAt: '2026-10-01T00:00:00.000Z',
      clientIdMatches: true,
    },
    quota: { type: 'limited', targetLimit: 200, totalUsage: 1, advisory: 'OK' },
    fixture: { contentRef: 'fixture:service-notification/v1', contentDigest: HEX('fixture') },
    webhook: {
      endpointDigest: HEX('endpoint'),
      active: true,
      testStatusCode: 200,
      invalidSignatureStatus: 401,
      signedMessagesAccepted: 1,
    },
    steps: S2_PR01_STEPS.map((id, index) =>
      status === 'FAIL' && index === 0
        ? { id, status: 'FAIL', code: 'TOKEN_CLIENT_ID_MISMATCH' }
        : { id, status: 'PASS' },
    ),
    pushAttempted: false,
  };
}

const pr02Evidence = () => ({
  type: 'line.capped-pilot',
  checkId: 'S2-LINE-PR02',
  status: 'PASS',
  pushStatus: 200,
  replayStatus: 409,
  messageIdsMatch: true,
  logicalDeliveries: 1,
  attempts: 1,
  touches: 1,
  refunds: 0,
  duplicateObserved: false,
  proposalPresentationDigest: HEX('proposal'),
});

const rb01Evidence = () => ({
  type: 'line.rollback-drill',
  checkId: 'S2-LINE-RB01',
  status: 'PASS',
  technicalSwitchOn: false,
  killLatched: true,
  unresolvedDeliveries: 0,
  credentialRevoked: true,
  freshSendBlockedBeforeIo: true,
});

/** สร้าง bundle แบบเดียวกับ `buildLineProviderEvidenceBundle` ฝั่ง TypeScript */
function bundle(evidence, overrides = {}) {
  const body = {
    schemaVersion: 1,
    phase: 'S2',
    evidenceType: 'line-provider-evidence-bundle',
    commitSha: SHA,
    generatedAt: '2026-09-23T00:02:00.000Z',
    runner: {
      profile: 'S2_LINE_PROTECTED_RUNNER_V1',
      platform: 'darwin',
      keychain: true,
      hostFingerprint: HEX('host'),
      workflowRunId: null,
    },
    entries: evidence.map((item) => ({
      checkId: item.checkId,
      status: item.status,
      evidenceSha256: sha256(item),
      evidence: item,
    })),
    secretScan: { status: 'PASS', exactValuesChecked: 1 },
    ...overrides,
  };
  return { ...body, bundleSha256: sha256(body) };
}

function providerVerified(evidence) {
  const verified = verifyS2ProviderBundle(bundle(evidence), { expectedCommitSha: SHA });
  return {
    status: 'VERIFIED',
    checks: Object.fromEntries(
      Object.entries(verified.checks).map(([id, value]) => [
        id,
        { ...value, bundleSha256: verified.bundleSha256 },
      ]),
    ),
    bundles: [{ bundleSha256: verified.bundleSha256, generatedAt: verified.generatedAt }],
  };
}

const run = (options) =>
  runCxaS2Readiness({
    writeManifest: false,
    emit: () => {},
    digests: DIGESTS,
    executeSuite: passingSuite,
    context: finalMainContext(),
    ...options,
  });

// ── Registry ────────────────────────────────────────────────────────────────

test('S2-LINE-EV01: registry ตรง 19 check IDs ของ #360 §B และครบ 9 dimensions', () => {
  assert.deepEqual(CXA_S2_READINESS_CHECKS.map(({ id }) => id).sort(), [...FROZEN_IDS].sort());
  for (const dimension of S2_DIMENSIONS) {
    assert.ok(
      CXA_S2_READINESS_CHECKS.some((item) => item.dimension === dimension),
      `ไม่มี check ใน ${dimension}`,
    );
  }
  const provider = CXA_S2_READINESS_CHECKS.filter((item) => item.kind === 'provider');
  assert.deepEqual(
    provider.map(({ id }) => id),
    ['S2-LINE-PR01', 'S2-LINE-PR02', 'S2-LINE-RB01'],
  );
  assert.ok(provider.every((item) => item.commands.length === 0));
  assert.equal(s2Checks('focused').length, 15);
  assert.ok(!s2Checks('focused').some(({ id }) => id === 'S2-LINE-REG01'));
});

test('S2-LINE-EV01: fault suite ทุกชุดชี้ไฟล์ที่มีอยู่ และ automated check มี fault suite', () => {
  const ids = new Set(S2_FAULT_SUITES.map(({ id }) => id));
  assert.equal(ids.size, S2_FAULT_SUITES.length);
  for (const suite of S2_FAULT_SUITES) {
    assert.ok(suite.faults.length > 0, suite.id);
    for (const source of suite.sources)
      assert.ok(existsSync(resolve(repositoryRoot, source)), `${suite.id}: ${source}`);
  }
  const used = new Set();
  for (const item of CXA_S2_READINESS_CHECKS) {
    for (const suite of item.faultSuites) {
      assert.ok(ids.has(suite), `${item.id} อ้าง ${suite}`);
      used.add(suite);
    }
    if (item.kind === 'automated' && !['S2-LINE-REG01', 'S2-LINE-EV01'].includes(item.id))
      assert.ok(item.faultSuites.length > 0, `${item.id} ไม่มี fault suite`);
  }
  assert.deepEqual([...used].sort(), [...ids].sort());
  const digests = s2ContentDigests();
  for (const value of Object.values(digests)) assert.match(value, /^[0-9a-f]{64}$/);
});

test('S2-LINE-EV01: suite ที่หลาย check ใช้ร่วมกันรันครั้งเดียว', () => {
  const plan = s2SuitePlan();
  const commands = plan.map(({ command }) => JSON.stringify(command));
  assert.equal(new Set(commands).size, commands.length);
  const delivery = plan.find(({ command }) =>
    command.join(' ').endsWith('@d-contact/delivery test'),
  );
  assert.ok(delivery.checkIds.length > 5);
});

test('S2-LINE-OB02: denylist ของ script ตรงกับ LINE_FORBIDDEN_EVIDENCE_FIELDS ใน contract', () => {
  const source = readFileSync(
    resolve(repositoryRoot, 'packages/cxa-contracts/src/line-delivery.ts'),
    'utf8',
  );
  const block = source.match(/LINE_FORBIDDEN_EVIDENCE_FIELDS = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(block);
  const fields = [...block[1].matchAll(/'([^']+)'/g)].map(([, name]) => name);
  assert.deepEqual(fields, [...S2_FORBIDDEN_FIELD_NAMES]);
});

test('S2-LINE-EV01: digest แบบ stable JSON ตรงกับ vector ที่ฝั่ง TypeScript ใช้', () => {
  // vector เดียวกันอยู่ใน apps/delivery/src/line-provider-evidence-bundle.test.ts
  assert.equal(
    sha256({ b: [{ z: 1, a: 'ไทย' }], a: null, c: true }),
    'ac573c0ba944f84e3dd2c61e91939ccd0359be7ca4853176df88ee658ffc1632',
  );
});

// ── Suite execution ─────────────────────────────────────────────────────────

const fakeRun =
  (stdout, status = 0) =>
  () => ({ status, stdout, stderr: '' });

test('S2-LINE-EV01: skip/todo ใน TAP ทำให้ suite ล้ม ไม่มี waiver', () => {
  const result = executeS2Suite(
    { command: ['node', '--test'] },
    fakeRun('# tests 2\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'),
  );
  assert.equal(result.status, 'FAIL');
});

test('S2-LINE-OB02: runtime log ที่มี LINE ID/token ทำให้ suite ล้มโดยไม่พาค่าออกมา', () => {
  const leakedId = `U${'0123456789abcdef'.repeat(2)}`;
  const result = executeS2Suite(
    { command: ['node', '--test'] },
    fakeRun(`# tests 1\n# pass 1\n# fail 0\nsource ${leakedId}\n`),
  );
  assert.equal(result.status, 'FAIL');
  assert.deepEqual(result.runtimeLogScan.rules, ['raw-line-id']);
  assert.ok(!JSON.stringify(result).includes(leakedId));
  assert.equal(
    executeS2Suite({ command: ['node', '--test'] }, fakeRun('# tests 1\n# pass 1\n# fail 0\n'))
      .status,
    'PASS',
  );
});

// ── Candidate / marker ──────────────────────────────────────────────────────

test('S2-LINE-EV01: focused run เป็น candidate เสมอแม้ทุก suite ผ่านบน final main', () => {
  const { manifest, summary } = run({ scope: 'focused' });
  assert.deepEqual(summary.markers, []);
  assert.ok(summary.markerBlockers.includes('FOCUSED_CANDIDATE'));
  assert.equal(manifest.candidate, true);
  assert.equal(manifest.flags.providerConformance, false);
  assert.equal(manifest.flags.productionReleaseEnabled, false);
  assert.equal(manifest.retentionDays, 90);
});

test('S2-LINE-EV01: ไม่มี provider bundle = PR01/PR02/RB01 FAIL และออก marker ไม่ได้', () => {
  const { manifest, summary, checks } = run({
    providerEvidence: ingestS2ProviderEvidence([], SHA),
  });
  assert.equal(summary.status, 'FAIL');
  assert.ok(summary.markerBlockers.includes('PROVIDER_EVIDENCE_MISSING'));
  const pr01 = checks.find(({ id }) => id === 'S2-LINE-PR01');
  assert.equal(pr01.status, 'FAIL');
  assert.equal(pr01.detail, 'PROVIDER_EVIDENCE_MISSING');
  assert.equal(manifest.flags.simulationOnly, true);
});

test('S2-LINE-PR01: มีแค่ PR01 PASS (ขอบเขต S2.6) = providerConformance จริงแต่ยัง candidate', () => {
  const { manifest, summary } = run({ providerEvidence: providerVerified([pr01Evidence()]) });
  assert.deepEqual(summary.markers, []);
  assert.equal(manifest.flags.providerConformance, true);
  assert.equal(manifest.flags.actualProviderTraffic, false);
  assert.equal(manifest.flags.accountEvidence, false);
  assert.equal(manifest.flags.killLatchedAtArtifact, null);
});

test(`S2-LINE-EV01: ครบ 19/19 บน clean final main + immutable artifact ออก ${S2_MARKER} พร้อม fixed flags`, () => {
  const { manifest, summary } = run({
    providerEvidence: providerVerified([pr01Evidence(), pr02Evidence(), rb01Evidence()]),
  });
  assert.deepEqual(summary.markerBlockers, []);
  assert.deepEqual(summary.markers, [S2_MARKER]);
  assert.deepEqual(manifest.flags, { ...S2_MARKER_FLAGS });
  assert.equal(manifest.candidate, false);
  assert.equal(manifest.checks.length, 19);
});

test('S2-LINE-EV01: PR run, dirty tree, SHA ไม่ใช่ final main และ artifact mutable ต่างเป็น blocker', () => {
  const provider = providerVerified([pr01Evidence(), pr02Evidence(), rb01Evidence()]);
  const cases = [
    [{ pullRequest: 12 }, 'PULL_REQUEST_RUN'],
    [{ cleanTree: false }, 'DIRTY_TREE'],
    [{ finalMainSha: OTHER_SHA }, 'NOT_FINAL_MAIN_SHA'],
    [{ ref: 'refs/heads/feature' }, 'NOT_DEFAULT_BRANCH_REF'],
    [
      {
        runUrl: null,
        artifact: {
          name: `cxa-s2-evidence-${SHA}`,
          url: null,
          immutable: false,
          retentionDays: 90,
        },
      },
      'ARTIFACT_NOT_IMMUTABLE',
    ],
  ];
  for (const [overrides, blocker] of cases) {
    const { summary } = run({ context: finalMainContext(overrides), providerEvidence: provider });
    assert.deepEqual(summary.markers, [], blocker);
    assert.ok(summary.markerBlockers.includes(blocker), blocker);
  }
});

test('S2-LINE-EV01: suite ที่ล้มหนึ่งตัวทำให้ทุก check ที่ใช้ร่วมล้มและไม่มี marker', () => {
  const { checks, summary } = run({
    providerEvidence: providerVerified([pr01Evidence(), pr02Evidence(), rb01Evidence()]),
    executeSuite: (suite) =>
      suite.command.join(' ').includes('correlated-touch')
        ? {
            status: 'FAIL',
            durationMs: 1,
            detail: 'boom',
            runtimeLogScan: { status: 'PASS', rules: [] },
          }
        : passingSuite(suite),
  });
  assert.deepEqual(summary.markers, []);
  for (const id of ['S2-LINE-F04', 'S2-LINE-TI01', 'S2-LINE-ID01'])
    assert.equal(checks.find((item) => item.id === id).status, 'FAIL', id);
});

test('S2-LINE-EV01: manifest ที่ถูกแก้ status/flags/hash/marker ถูกปฏิเสธ', () => {
  const { manifest } = run({
    providerEvidence: providerVerified([pr01Evidence(), pr02Evidence(), rb01Evidence()]),
  });
  const tamper = (mutate) => {
    const copy = structuredClone(manifest);
    mutate(copy);
    return () => assertValidCxaS2EvidenceManifest(copy);
  };
  assert.doesNotThrow(() => assertValidCxaS2EvidenceManifest(structuredClone(manifest)));
  assert.throws(tamper((copy) => (copy.flags.productionReleaseEnabled = true)));
  assert.throws(tamper((copy) => (copy.checks[0].subchecks[0].status = 'FAIL')));
  assert.throws(tamper((copy) => (copy.artifacts[0].sha256 = HEX('other'))));
  assert.throws(tamper((copy) => (copy.retentionDays = 30)));
  assert.throws(tamper((copy) => (copy.finalMainSha = OTHER_SHA)));
  assert.throws(tamper((copy) => (copy.provider.status = 'INVALID')));
  assert.throws(tamper((copy) => (copy.dimensions[0].status = 'FAIL')));
  assert.throws(tamper((copy) => (copy.markers = ['LINE_IN_MEMORY_SIMULATION_ACCEPTED'])));
});

test('S2-LINE-OB02: manifest ที่มี LINE user ID หรือ token ถูกปฏิเสธก่อน validation อื่น', () => {
  const { manifest } = run({ scope: 'focused' });
  const withId = structuredClone(manifest);
  withId.checks[0].boundaries = [`U${'f'.repeat(32)}`];
  assert.throws(() => assertValidCxaS2EvidenceManifest(withId), /LINE ID หรือ credential/);
  const withField = structuredClone(manifest);
  withField.checks[0].replyToken = 'x';
  assert.throws(() => assertValidCxaS2EvidenceManifest(withField), /field ต้องห้าม/);
});

test('S2-LINE-OB02: digest/UUID ที่ลงท้ายด้วยเลขล้วนไม่ถูกมองเป็นเบอร์โทร', () => {
  assert.doesNotThrow(() =>
    assertS2EvidenceSafe({
      digest: `${'f'.repeat(54)}0812345678`,
      id: 'local-00000000-0000-4000-8000-000812345678',
    }),
  );
  assert.throws(() => assertS2EvidenceSafe({ note: 'โทร 0812345678' }));
});

// ── Provider bundle ─────────────────────────────────────────────────────────

test('S2-LINE-PR01: bundle ที่ถูกต้องผ่าน และคืนแค่ status/digest ต่อ check', () => {
  const result = verifyS2ProviderBundle(bundle([pr01Evidence()]), { expectedCommitSha: SHA });
  assert.deepEqual(Object.keys(result.checks), ['S2-LINE-PR01']);
  assert.equal(result.checks['S2-LINE-PR01'].status, 'PASS');
});

test('S2-LINE-OB02: bundle ที่ถูกแก้, คนละ commit หรือไม่ใช่ protected runner ถูกปฏิเสธ', () => {
  const valid = bundle([pr01Evidence()]);
  const tampered = structuredClone(valid);
  tampered.entries[0].evidence.quota.totalUsage = 0;
  assert.throws(() => verifyS2ProviderBundle(tampered, { expectedCommitSha: SHA }), /SHA-256/);
  const resigned = structuredClone(valid);
  resigned.generatedAt = '2026-09-24T00:00:00.000Z';
  assert.throws(() => verifyS2ProviderBundle(resigned, { expectedCommitSha: SHA }), /digest/);
  assert.throws(() => verifyS2ProviderBundle(valid, { expectedCommitSha: OTHER_SHA }), /commit/);
  assert.throws(
    () =>
      verifyS2ProviderBundle(
        bundle([pr01Evidence()], {
          runner: {
            profile: 'LOCAL',
            platform: 'linux',
            keychain: false,
            hostFingerprint: HEX('h'),
          },
        }),
        { expectedCommitSha: SHA },
      ),
    /protected runner/,
  );
  assert.throws(
    () =>
      verifyS2ProviderBundle(
        bundle([pr01Evidence()], { secretScan: { status: 'PASS', exactValuesChecked: 0 } }),
        {
          expectedCommitSha: SHA,
        },
      ),
    /exact-value/,
  );
});

test('S2-LINE-OB02: bundle ที่มี token หรือ LINE user ID ถูกปฏิเสธ', () => {
  const withToken = { ...pr01Evidence(), accessToken: 'x'.repeat(20) };
  assert.throws(() => verifyS2ProviderBundle(bundle([withToken]), { expectedCommitSha: SHA }));
  const withUser = pr01Evidence();
  withUser.fixture.contentRef = `U${'a'.repeat(32)}`;
  assert.throws(() => verifyS2ProviderBundle(bundle([withUser]), { expectedCommitSha: SHA }));
});

test('S2-LINE-PR01: status ต้อง derive จาก step ครบ และห้ามมี push', () => {
  const lying = { ...pr01Evidence('FAIL'), status: 'PASS' };
  assert.throws(
    () => verifyS2ProviderBundle(bundle([lying]), { expectedCommitSha: SHA }),
    /derive/,
  );
  const pushed = { ...pr01Evidence(), pushAttempted: true };
  assert.throws(() => verifyS2ProviderBundle(bundle([pushed]), { expectedCommitSha: SHA }), /push/);
  const missingStep = pr01Evidence();
  missingStep.steps.pop();
  assert.throws(() => verifyS2ProviderBundle(bundle([missingStep]), { expectedCommitSha: SHA }));
  const failed = verifyS2ProviderBundle(bundle([pr01Evidence('FAIL')]), { expectedCommitSha: SHA });
  assert.equal(failed.checks['S2-LINE-PR01'].status, 'FAIL');
});

test('S2-LINE-PR02/RB01: PASS ต้องมี invariant ครบตาม #360 §D/§F', () => {
  const duplicate = { ...pr02Evidence(), logicalDeliveries: 2 };
  assert.throws(() => verifyS2ProviderBundle(bundle([duplicate]), { expectedCommitSha: SHA }));
  const activeCredential = { ...rb01Evidence(), credentialRevoked: false };
  assert.throws(() =>
    verifyS2ProviderBundle(bundle([activeCredential]), { expectedCommitSha: SHA }),
  );
  const frozenFailure = { ...rb01Evidence(), status: 'FAIL', credentialRevoked: false };
  assert.equal(
    verifyS2ProviderBundle(bundle([frozenFailure]), { expectedCommitSha: SHA }).checks[
      'S2-LINE-RB01'
    ].status,
    'FAIL',
  );
});

test('S2-LINE-EV01: check เดียวกันจากสอง bundle และ bundle เสียทำให้ provider check ทั้งหมด FAIL', () => {
  const read = [bundle([pr01Evidence()]), bundle([pr01Evidence()])];
  assert.throws(() =>
    verifyS2ProviderBundles(
      ['one', 'two'],
      { expectedCommitSha: SHA },
      (path) => read[path === 'one' ? 0 : 1],
    ),
  );
  const invalid = ingestS2ProviderEvidence(['missing.json'], SHA);
  assert.equal(invalid.status, 'INVALID');
  const { summary, checks } = run({ providerEvidence: invalid });
  assert.ok(summary.markerBlockers.includes('PROVIDER_BUNDLE_INVALID'));
  for (const id of ['S2-LINE-PR01', 'S2-LINE-PR02', 'S2-LINE-RB01'])
    assert.equal(checks.find((item) => item.id === id).detail, 'PROVIDER_BUNDLE_INVALID');
});

// ── Negative scan ───────────────────────────────────────────────────────────

test('S2-LINE-OB02: source/test/workflow ของ repo ผ่าน negative scan', () => {
  const summary = cxaS2NegativeScan();
  assert.equal(summary.status, 'PASS', JSON.stringify(summary.violations));
  assert.ok(summary.layers.source > 0 && summary.layers.tests > 0 && summary.layers.workflows > 0);
  assert.equal(summary.layers.compositionRoots, 2);
});

test('S2-LINE-OB02: scan จับ SDK, env, marker, skip, secret ใน workflow/composition root และ artifact ที่รั่ว', () => {
  const files = {
    'src/a.ts':
      "import x from '@line/bot-sdk'; const v = process.env.X; const m = 'OUTBOUND_DELIVERY_LINE_PILOT_READY';",
    'src/a.test.ts': "test.skip('x', () => {});",
    'ci.yml': 'token: ${{ secrets.LINE_TOKEN }}',
    'main.ts': "const secret = required('LINE_CHANNEL_SECRET');",
  };
  const summary = cxaS2NegativeScan({
    read: (path) => files[path],
    targets: {
      sources: ['src/a.ts'],
      tests: ['src/a.test.ts'],
      readiness: [],
      workflows: ['ci.yml'],
      compositionRoots: ['main.ts'],
    },
    allowlist: [],
    artifacts: [{ path: 'bundle.json', value: { note: `U${'1'.repeat(32)}` } }],
  });
  assert.equal(summary.status, 'FAIL');
  const rules = summary.violations.map(({ rule }) => rule).sort();
  assert.deepEqual(rules, [
    'artifact-evidence',
    'env-read',
    'hard-coded-marker',
    'line-secret-env',
    'sdk-import',
    'skipped-test',
    'workflow-secret',
  ]);
  assert.ok(summary.emptyGroups.includes('readiness'));
  assert.deepEqual(scanTextForS2Leaks('Bearer abcdefghijklmnopqrstuvwxyz'), ['bearer-token']);
});
