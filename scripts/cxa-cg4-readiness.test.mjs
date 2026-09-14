import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CG3_BASELINE_SHA,
  CG4_DIMENSIONS,
  CG4_FIXED_FLAGS,
  CG4_MARKER,
  CXA_CG4_READINESS_CHECKS,
  assertPiiSafeEvidence,
  assertValidCxaCg4EvidenceManifest,
  cg4MarkerBlockers,
  runCxaCg4Readiness,
  sha256,
} from './cxa-cg4-readiness.mjs';
import { cxaCg4ProfileSummary } from './cxa-cg4-profile-readiness.mjs';
import { CG3_MARKER, cxaCg4DependencySummary } from './cxa-cg4-dependency-readiness.mjs';
import { executeReadinessCheck } from './phase-zero-readiness.mjs';

const SHA = 'b'.repeat(40);
const finalMainContext = Object.freeze({
  repository: 'Kitti-Nualsalee/dcontact',
  defaultBranch: 'main',
  ref: 'refs/heads/main',
  pullRequest: null,
  baseSha: SHA,
  commitSha: SHA,
  finalMainSha: SHA,
  expectedCommitSha: SHA,
  cleanTree: true,
  runId: '123456',
  attempt: 1,
  runUrl: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/123456/attempts/1',
  artifact: {
    name: `cxa-cg4-evidence-${SHA}`,
    url: 'https://github.com/Kitti-Nualsalee/dcontact/actions/runs/123456/attempts/1#artifacts',
    immutable: true,
  },
});

const dependencyEvidence = {
  type: 'dependency.readiness',
  status: 'PASS',
  commitSha: SHA,
  cg3: 'INTEGRATED_SAME_SHA',
  cg3Marker: CG3_MARKER,
  s1ManifestSha256: 'c'.repeat(64),
  j2: 'CONTRACT_COMPATIBLE',
  j2ManifestSha256: null,
};

function passingExecutor(check) {
  const last = check.command === check.commands.at(-1);
  const evidence =
    last && check.id === 'CG4-REG01'
      ? [dependencyEvidence]
      : last && check.id === 'CG4-REG02'
        ? [cxaCg4ProfileSummary({})]
        : undefined;
  return { status: 'PASS', durationMs: 1, ...(evidence ? { evidence } : {}) };
}

function run(options = {}) {
  return runCxaCg4Readiness({
    context: options.context ?? finalMainContext,
    executeCheck: options.executeCheck ?? passingExecutor,
    now: () => new Date('2026-09-15T00:00:00.000Z'),
    emit: () => undefined,
    writeManifest: false,
    digests: { registry: 'd'.repeat(64), migrations: 'e'.repeat(64) },
  });
}

test('CG4 registry มี 25 mandatory checks ครบ 9 dimensions ตาม #178 และไม่มี check ซ้ำ', () => {
  assert.deepEqual(
    CXA_CG4_READINESS_CHECKS.map(({ id }) => id),
    [
      'CG4-F01',
      'CG4-F02',
      'CG4-F03',
      'CG4-F04',
      'CG4-F05',
      'CG4-UX01',
      'CG4-TI01',
      'CG4-TI02',
      'CG4-AU01',
      'CG4-AU02',
      'CG4-ID01',
      'CG4-ID02',
      'CG4-CC01',
      'CG4-CC02',
      'CG4-CC03',
      'CG4-CC04',
      'CG4-RC01',
      'CG4-RC02',
      'CG4-RC03',
      'CG4-MG01',
      'CG4-MG02',
      'CG4-OB01',
      'CG4-OB02',
      'CG4-REG01',
      'CG4-REG02',
    ],
  );
  assert.deepEqual(
    [...new Set(CXA_CG4_READINESS_CHECKS.map(({ dimension }) => dimension))].sort(),
    [...CG4_DIMENSIONS].sort(),
  );
  for (const item of CXA_CG4_READINESS_CHECKS) {
    assert.ok(item.commands.length > 0, item.id);
    assert.ok(item.boundaries.length > 0, item.id);
  }
  const regression = CXA_CG4_READINESS_CHECKS.find(({ id }) => id === 'CG4-REG01');
  for (const script of [
    'build',
    'typecheck',
    'lint',
    'cxa:e0:acceptance',
    'cxa:c1:acceptance',
    'voice:acceptance',
    's1:acceptance',
  ]) {
    assert.ok(
      regression.commands.some((command) => command.at(-1) === script),
      script,
    );
  }
});

test('final main run ที่ 25/25 PASS พร้อม dependency/profile ออก CONTACT_GOVERNANCE_CG4_ACCEPTED', () => {
  const result = run();
  assert.equal(result.summary.status, 'PASS');
  assert.deepEqual(result.summary.markers, [CG4_MARKER]);
  assert.deepEqual(result.manifest.markers, [CG4_MARKER]);
  assert.deepEqual(result.manifest.flags, CG4_FIXED_FLAGS);
  assert.equal(result.manifest.baselineSha, CG3_BASELINE_SHA);
  assert.equal(result.manifest.dimensions.length, 9);
  assert.doesNotThrow(() => assertValidCxaCg4EvidenceManifest(result.manifest));
  assert.match(result.manifestSha256, /^[0-9a-f]{64}$/);
});

test('marker suppression: PR run, non-final SHA, dirty tree, local artifact และ CG3 marker คนละ SHA ได้แค่ candidate', () => {
  const cases = [
    [{ pullRequest: 241 }, 'PULL_REQUEST_RUN'],
    [{ ref: 'refs/heads/claude/cg4-11' }, 'NOT_DEFAULT_BRANCH_REF'],
    [{ finalMainSha: 'a'.repeat(40) }, 'NOT_FINAL_MAIN_SHA'],
    [{ expectedCommitSha: 'a'.repeat(40) }, 'NOT_FINAL_MAIN_SHA'],
    [{ cleanTree: false }, 'DIRTY_TREE'],
    [
      { runUrl: null, artifact: { name: `cxa-cg4-evidence-${SHA}`, url: null, immutable: false } },
      'ARTIFACT_NOT_IMMUTABLE',
    ],
  ];
  for (const [override, blocker] of cases) {
    const result = run({ context: { ...finalMainContext, ...override } });
    assert.deepEqual(result.summary.markers, [], blocker);
    assert.equal(result.manifest.markers, undefined, blocker);
    assert.ok(result.summary.markerBlockers.includes(blocker), blocker);
  }

  const staleCg3 = run({
    executeCheck(check) {
      const base = passingExecutor(check);
      return check.id === 'CG4-REG01' && base.evidence
        ? {
            ...base,
            evidence: [{ ...dependencyEvidence, cg3: 'CANDIDATE_NOT_FINAL_MAIN', cg3Marker: null }],
          }
        : base;
    },
  });
  assert.ok(staleCg3.summary.markerBlockers.includes('CG3_MARKER_NOT_SAME_SHA'));
});

test('check ใดล้มหรือขาด evidence marker ไม่ออก', () => {
  for (const failed of CXA_CG4_READINESS_CHECKS) {
    const result = run({
      executeCheck(check) {
        return check.id === failed.id ? { status: 'FAIL', durationMs: 1 } : passingExecutor(check);
      },
    });
    assert.equal(result.summary.status, 'FAIL', failed.id);
    assert.equal(result.manifest.markers, undefined, failed.id);
  }
  const noProfile = run({
    executeCheck(check) {
      const base = passingExecutor(check);
      return check.id === 'CG4-REG02' ? { status: 'PASS', durationMs: 1 } : base;
    },
  });
  assert.ok(noProfile.summary.markerBlockers.includes('OWNER_PROFILE_OR_FLAGS_MISMATCH'));
});

test('validator ปฏิเสธ check ไม่รู้จัก/ซ้ำ/หาย, dimension ว่าง, artifact hash/commit ผิด, flag และ SHA/ref mismatch', () => {
  const { manifest } = run();
  const reject = (mutate, pattern) => {
    const copy = structuredClone(manifest);
    mutate(copy);
    assert.throws(() => assertValidCxaCg4EvidenceManifest(copy), pattern);
  };
  reject((copy) => {
    copy.checks[0].id = 'CG4-X99';
    copy.artifacts[0] = {
      ...copy.artifacts[0],
      id: 'check:CG4-X99',
      sha256: sha256(copy.checks[0]),
    };
  }, /ไม่รู้จัก/);
  reject((copy) => {
    copy.checks[1] = { ...copy.checks[0] };
  }, /ซ้ำ/);
  reject((copy) => {
    copy.checks.pop();
    copy.artifacts.pop();
  }, /ครบทั้ง 25/);
  reject((copy) => {
    copy.dimensions[0].checks = 0;
  }, /dimension ว่าง/);
  reject((copy) => {
    copy.artifacts[0].sha256 = '0'.repeat(64);
  }, /SHA-256/);
  reject((copy) => {
    copy.artifacts[0].commitSha = 'c'.repeat(40);
  }, /commit ไม่ตรง/);
  reject((copy) => {
    copy.flags.releaseEnabled = true;
  }, /fixed flags/);
  reject((copy) => {
    copy.finalMainSha = 'a'.repeat(40);
  }, /HEAD == origin\/main/);
  reject((copy) => {
    copy.refProof.cleanTree = false;
  }, /clean checkout/);
  reject((copy) => {
    copy.artifact.url = 'file:///tmp/cxa-cg4.json';
  }, /immutable CI artifact/);
  reject((copy) => {
    copy.dependencies.cg3 = 'CANDIDATE_NOT_FINAL_MAIN';
  }, /CONTACT_GOVERNANCE_CG3_ACCEPTED/);
  reject((copy) => {
    copy.ownerProfiles.provider = 'LIVE';
  }, /owner profiles/);
  reject((copy) => {
    copy.checks[2].status = 'SKIP';
    copy.artifacts[2].sha256 = sha256(copy.checks[2]);
  }, /25 checks PASS/);
});

test('manifest ปฏิเสธ PII และ credential แม้อยู่ใน diagnostic ลึก', () => {
  assert.throws(
    () => assertPiiSafeEvidence({ nested: [{ detail: 'customer@example.test' }] }),
    /PII/,
  );
  assert.throws(() => assertPiiSafeEvidence({ client_secret: 'x' }), /field ต้องห้าม/);
  // runner ห้าม persist manifest ที่มี PII — createCxaCg4EvidenceManifest ต้อง throw ก่อนเขียนไฟล์
  assert.throws(
    () =>
      run({
        executeCheck(check) {
          return check.id === 'CG4-F01'
            ? { status: 'FAIL', durationMs: 1, detail: 'phone 0812345678' }
            : passingExecutor(check);
        },
      }),
    /PII/,
  );
});

test('owner profile fail closed เมื่อ profile ผิดหรือพยายามเปิด release/provider/real data', () => {
  assert.deepEqual(cxaCg4ProfileSummary({}).flags, CG4_FIXED_FLAGS);
  assert.throws(
    () => cxaCg4ProfileSummary({ CXA_CG4_GOVERNANCE_PROFILE: 'IN_MEMORY' }),
    /contactGovernance/,
  );
  assert.throws(
    () => cxaCg4ProfileSummary({ CXA_CG4_CONSOLE_PROFILE: 'PROVIDER_DIRECT' }),
    /console/,
  );
  assert.throws(() => cxaCg4ProfileSummary({ CXA_CG4_PROVIDER_PROFILE: 'LINE' }), /provider/);
  assert.throws(
    () => cxaCg4ProfileSummary({ CXA_PROVIDER_TRAFFIC_ENABLED: 'true' }),
    /provider traffic/,
  );
  assert.throws(() => cxaCg4ProfileSummary({ CXA_CG4_RELEASE_ENABLED: 'true' }), /releaseEnabled/);
  assert.throws(
    () => cxaCg4ProfileSummary({ CXA_CG4_PROVIDER_CONFORMANCE: 'true' }),
    /providerConformance/,
  );
  assert.throws(() => cxaCg4ProfileSummary({ CXA_CG4_REAL_CUSTOMER_DATA: 'true' }), /synthetic/);
});

test('dependency: final main ต้องมี CG3 marker จาก S1 manifest บน SHA เดียวกัน; candidate บันทึกแยก', () => {
  const s1 = { commitSha: SHA, finalMainSha: SHA, markers: [CG3_MARKER] };
  const finalEnv = { GITHUB_RUN_ID: '1' };
  assert.equal(
    cxaCg4DependencySummary({ environment: finalEnv, commitSha: SHA, mainSha: SHA, s1Manifest: s1 })
      .cg3,
    'INTEGRATED_SAME_SHA',
  );
  assert.throws(
    () =>
      cxaCg4DependencySummary({
        environment: finalEnv,
        commitSha: SHA,
        mainSha: SHA,
        s1Manifest: { ...s1, markers: [] },
      }),
    /CONTACT_GOVERNANCE_CG3_ACCEPTED/,
  );
  assert.throws(
    () =>
      cxaCg4DependencySummary({
        environment: finalEnv,
        commitSha: SHA,
        mainSha: SHA,
        s1Manifest: { ...s1, commitSha: 'a'.repeat(40) },
      }),
    /SHA เดียวกัน/,
  );
  const candidate = cxaCg4DependencySummary({
    environment: { GITHUB_PR_NUMBER: '9', GITHUB_RUN_ID: '1' },
    commitSha: SHA,
    mainSha: 'a'.repeat(40),
    s1Manifest: undefined,
  });
  assert.equal(candidate.cg3, 'CANDIDATE_NOT_FINAL_MAIN');
  const j2 = cxaCg4DependencySummary({
    environment: finalEnv,
    commitSha: SHA,
    mainSha: SHA,
    s1Manifest: s1,
    j2Manifest: { commitSha: SHA, markers: ['JOURNEY_J2_ACCEPTED'] },
  });
  assert.equal(j2.j2, 'ACCEPTED_SAME_SHA');
});

test('profile evidence ถูกเก็บจาก child process ผ่าน evidence prefix', () => {
  const profileCheck = CXA_CG4_READINESS_CHECKS.find(({ id }) => id === 'CG4-REG02');
  const diagnostic = executeReadinessCheck({
    ...profileCheck,
    command: profileCheck.commands.at(-1),
  });
  assert.equal(diagnostic.status, 'PASS');
  assert.equal(diagnostic.evidence?.[0]?.type, 'owner-profile.readiness');
  assert.deepEqual(diagnostic.evidence?.[0]?.flags, CG4_FIXED_FLAGS);
});

test('marker blockers ว่างเฉพาะ context ที่ถูกต้องทุกข้อ', () => {
  const { manifest } = run();
  assert.deepEqual(cg4MarkerBlockers(finalMainContext, manifest.checks), []);
});
