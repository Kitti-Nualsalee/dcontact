import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  ACCEPTANCE_DEPENDENCIES,
  ACCEPTANCE_PHASES,
  PROVENANCE_PATH,
  acceptanceDependencySummary,
  fileDigest,
  missingDependencyMessage,
} from './acceptance-dependency-markers.mjs';
import { fetchDependencyEvidence, selectArtifacts } from './acceptance-fetch-evidence.mjs';
import { CXA_CG4_READINESS_CHECKS, cg4FailureDetail } from './cxa-cg4-readiness.mjs';
import { S1_REGRESSION_SCRIPTS, cxaCg4DependencySummary } from './cxa-cg4-dependency-readiness.mjs';
import { CXA_J2_READINESS_CHECKS } from './cxa-j2-readiness.mjs';
import { CXA_J3_READINESS_CHECKS, j3FailureDetail } from './cxa-j3-readiness.mjs';
import { cxaJ5DependencySummary } from './cxa-j5-dependency-readiness.mjs';
import { j5Checks } from './cxa-j5-readiness.mjs';
import { nestedReadinessFailures } from './readiness-failure-detail.mjs';
import { commitOnMain, contextOnMain } from './acceptance-main-proof.mjs';
import { j3MarkerBlockers } from './cxa-j3-readiness.mjs';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function temporaryRoot(t) {
  const root = mkdtempSync(resolve(tmpdir(), 'acceptance-dependency-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

const acceptedManifest = (phase, commitSha = SHA) => ({
  commitSha,
  markers: [ACCEPTANCE_PHASES[phase].marker],
});

/** เขียน manifest พร้อม provenance แบบเดียวกับที่ fetch script เขียน */
function writeFetched(root, phase, file, manifest, { headSha = SHA, tamper = false } = {}) {
  const folder = resolve(root, ACCEPTANCE_PHASES[phase].directory);
  mkdirSync(folder, { recursive: true });
  const bytes = Buffer.from(JSON.stringify(manifest));
  writeFileSync(resolve(folder, file), tamper ? Buffer.from(`${bytes} `) : bytes);
  const provenancePath = resolve(root, PROVENANCE_PATH);
  mkdirSync(resolve(provenancePath, '..'), { recursive: true });
  const provenance = existsSync(provenancePath)
    ? JSON.parse(readFileSync(provenancePath, 'utf8'))
    : { entries: [] };
  provenance.entries.push({ phase, file, sha256: fileDigest(bytes), headSha, runId: 7 });
  writeFileSync(provenancePath, JSON.stringify(provenance));
}

test('suite ซ้อนที่ล้ม: detail ระบุ suite id และสาเหตุของชั้นใน ไม่ใช่แค่ exit status', () => {
  const nested = [
    'noise line',
    JSON.stringify({ type: 'readiness.suite', id: 'suite:18', status: 'PASS' }),
    JSON.stringify({
      type: 'readiness.suite',
      id: 'suite:20',
      command: ['pnpm', 'cxa:cg4:acceptance'],
      status: 'FAIL',
      detail: 'not ok 3 - CG4 exception scope ติดต่อ customer@example.test',
    }),
    JSON.stringify({ type: 'readiness.check', id: 'J3-REG01', status: 'FAIL' }),
  ].join('\n');

  const failures = nestedReadinessFailures(nested);
  assert.equal(failures.length, 2);
  assert.match(failures[0], /suite suite:20 FAIL pnpm cxa:cg4:acceptance.*not ok 3/);
  assert.match(failures[1], /check J3-REG01 FAIL/);

  const detail = cg4FailureDetail(nested, 'process exited with status 1');
  assert.match(detail, /suite:20/);
  assert.match(detail, /not ok 3/);
  assert.doesNotMatch(detail, /customer@example\.test/);

  const j3 = j3FailureDetail(`${nested}\nlast line`);
  assert.match(j3, /^\[nested suite suite:20 FAIL/);
  assert.match(j3, /last line/);
});

test('ไม่มีบรรทัดบอกความล้มเหลว: ใช้ท้าย output แทน exit status อย่างเดียว', () => {
  const detail = cg4FailureDetail(
    'step 1\nmarker ของ dependency ยังไม่ครบ',
    'process exited with status 1',
  );
  assert.match(detail, /process exited with status 1/);
  assert.match(detail, /dependency ยังไม่ครบ/);
  assert.equal(cg4FailureDetail('', 'SIGTERM'), 'SIGTERM');
});

test('J2/J3/J5 registry ไม่ spawn acceptance ของ phase อื่นอีกแล้ว แต่ตรวจ marker แทน', () => {
  const registries = {
    J2: CXA_J2_READINESS_CHECKS,
    J3: CXA_J3_READINESS_CHECKS,
    J5: j5Checks('full'),
    CG4: CXA_CG4_READINESS_CHECKS,
  };
  for (const [acceptance, checks] of Object.entries(registries)) {
    const commands = checks.flatMap(({ commands }) => commands);
    assert.ok(
      !commands.some((command) => command.some((part) => /:acceptance$/.test(String(part)))),
      `${acceptance} ยังเรียก *:acceptance`,
    );
    const script =
      {
        J5: 'cxa-j5-dependency-readiness.mjs',
        CG4: 'cxa-cg4-dependency-readiness.mjs',
      }[acceptance] ?? 'acceptance-dependency-markers.mjs';
    const reg = checks.find(({ id }) => id === `${acceptance}-REG01`);
    assert.ok(
      reg.commands.some((command) => command.some((part) => String(part).endsWith(script))),
      `${acceptance}-REG01 ต้องตรวจ marker`,
    );
  }
});

test('marker นับได้เฉพาะไฟล์ที่มี provenance บน SHA เดียวกันและ digest ตรง', (t) => {
  const root = temporaryRoot(t);
  // ไฟล์ค้างจาก local run ไม่มี provenance
  mkdirSync(resolve(root, 's1'), { recursive: true });
  writeFileSync(resolve(root, 's1', 'local.json'), JSON.stringify(acceptedManifest('s1')));
  // manifest ที่ถูกแก้หลังดาวน์โหลด
  writeFetched(root, 'c1', '1.json', acceptedManifest('c1'), { tamper: true });
  let summary = acceptanceDependencySummary('J2', { commitSha: SHA, artifactsRoot: root });
  assert.equal(summary.status, 'FAIL');
  assert.equal(summary.allAcceptedSameSha, false);
  assert.equal(summary.phases.s1.status, 'ABSENT');
  assert.equal(summary.phases.c1.status, 'ABSENT');
  assert.match(missingDependencyMessage(summary), /acceptance=s1/);

  // SHA อื่น / candidate ไม่นับ
  writeFetched(root, 's1', '2.json', acceptedManifest('s1', OTHER_SHA), { headSha: OTHER_SHA });
  writeFetched(root, 's1', '3.json', { ...acceptedManifest('s1'), candidate: true });
  summary = acceptanceDependencySummary('J2', { commitSha: SHA, artifactsRoot: root });
  assert.equal(summary.phases.s1.status, 'ABSENT');

  writeFetched(root, 's1', '4.json', acceptedManifest('s1'));
  writeFetched(root, 'c1', '5.json', acceptedManifest('c1'));
  summary = acceptanceDependencySummary('J2', { commitSha: SHA, artifactsRoot: root });
  assert.equal(summary.status, 'PASS');
  assert.equal(summary.phases.s1.sourceRunId, 7);
});

test('J5 dependency ใช้ loader เดียวกันและ fail เมื่อ marker ไม่ครบ', (t) => {
  const root = temporaryRoot(t);
  for (const phase of ACCEPTANCE_DEPENDENCIES.J5)
    writeFetched(root, phase, `${phase}.json`, acceptedManifest(phase));
  assert.equal(cxaJ5DependencySummary({ commitSha: SHA, artifactsRoot: root }).status, 'PASS');
  const missing = cxaJ5DependencySummary({ commitSha: OTHER_SHA, artifactsRoot: root });
  assert.equal(missing.status, 'FAIL');
  assert.deepEqual(Object.keys(missing.phases), ['j1', 'j2', 'j3', 'cg3']);
});

test('fetch: เลือกเฉพาะ artifact บน main + SHA เดียวกัน แล้วเขียน provenance ที่ checker ยอมรับ', async (t) => {
  const artifact = (id, overrides = {}) => ({
    id,
    name: `s1-evidence-${SHA}`,
    expired: false,
    created_at: `2026-09-${String(id).padStart(2, '0')}T00:00:00Z`,
    workflow_run: { id: 100 + id, head_sha: SHA, head_branch: 'main' },
    ...overrides,
  });
  const listed = [
    artifact(1),
    artifact(2, { expired: true }),
    artifact(3, { workflow_run: { id: 103, head_sha: SHA, head_branch: 'feature' } }),
    artifact(4, { workflow_run: { id: 104, head_sha: OTHER_SHA, head_branch: 'main' } }),
    artifact(5),
  ];
  assert.deepEqual(
    selectArtifacts(listed, `s1-evidence-${SHA}`, SHA).map(({ id }) => id),
    [5, 1],
  );

  const root = temporaryRoot(t);
  const downloaded = [];
  const entries = await fetchDependencyEvidence({
    acceptance: 'J2',
    commitSha: SHA,
    artifactsRoot: root,
    log: () => undefined,
    listArtifacts: async (name) =>
      name.startsWith('s1-') ? listed : [artifact(9, { name: `cxa-c1-evidence-${SHA}` })],
    downloadArtifact: async (item, destination) => {
      downloaded.push(item.id);
      const phase = item.name.startsWith('s1-') ? 's1' : 'c1';
      // run ที่ล้ม (id 5) upload manifest ที่ไม่มี marker — ต้องยังหา marker จาก run อื่นเจอ
      const manifest = item.id === 5 ? { commitSha: SHA, markers: [] } : acceptedManifest(phase);
      writeFileSync(resolve(destination, `${item.workflow_run.id}.json`), JSON.stringify(manifest));
    },
  });
  // ตามลำดับ phase ของ J2: c1 แล้ว s1 (ใหม่สุดก่อน)
  assert.deepEqual(downloaded, [9, 5, 1]);
  assert.equal(entries.length, 3);
  const summary = acceptanceDependencySummary('J2', { commitSha: SHA, artifactsRoot: root });
  assert.equal(summary.status, 'PASS');
  assert.equal(summary.phases.s1.sourceRunId, 101);

  await assert.rejects(
    fetchDependencyEvidence({ acceptance: 'J9', commitSha: SHA, listArtifacts: async () => [] }),
    /ไม่รู้จัก/,
  );
});

test('#572: CG4-REG01 ใช้ S1 manifest จาก artifact ที่มี provenance และเลือกตัวที่มี CG3 marker', (t) => {
  const root = temporaryRoot(t);
  const finalEnv = { GITHUB_RUN_ID: '99', CXA_CG4_EXPECTED_COMMIT_SHA: SHA };
  const summary = () =>
    cxaCg4DependencySummary({
      environment: finalEnv,
      commitSha: SHA,
      mainSha: SHA,
      artifactsRoot: root,
    });

  // ยังไม่มี S1 บน SHA นี้ → final main ล้มพร้อมบอกให้สั่ง S1 ก่อน
  assert.throws(summary, /acceptance=s1/);

  const s1 = (markers, status) => ({
    commitSha: SHA,
    finalMainSha: SHA,
    markers,
    checks: [
      {
        id: 'S1-REG-01',
        subchecks: S1_REGRESSION_SCRIPTS.map((script) => ({ command: ['pnpm', script], status })),
      },
    ],
  });
  // run S1 ที่ล้มก็มี manifest — ต้องไม่ถูกเลือกแทน run ที่ผ่าน
  writeFetched(root, 's1', '1.json', s1([], 'FAIL'));
  assert.throws(summary, /CONTACT_GOVERNANCE_CG3_ACCEPTED/);
  writeFetched(root, 's1', '2.json', s1(['CONTACT_GOVERNANCE_CG3_ACCEPTED'], 'PASS'));
  const result = summary();
  assert.equal(result.cg3, 'INTEGRATED_SAME_SHA');
  assert.ok(Object.values(result.s1Regression).every((status) => status === 'PASS'));
});

test('ADR-032: marker ออกได้เมื่อ commit อยู่บน main แล้ว แม้ main ขยับไปแล้ว แต่ไม่ออกถ้าไม่อยู่บน main', () => {
  const calls = [];
  const git = (command, args) => {
    calls.push([command, ...args]);
    return { status: args[2] === SHA ? 0 : 1 };
  };
  assert.equal(commitOnMain(SHA, git), true);
  assert.deepEqual(calls[0], ['git', 'merge-base', '--is-ancestor', SHA, 'origin/main']);
  assert.equal(commitOnMain(OTHER_SHA, git), false);
  assert.equal(commitOnMain('HEAD', git), false);
  assert.equal(calls.length, 2);

  // main ขยับไปแล้ว (finalMainSha ≠ commit) แต่ commit อยู่บน main → ไม่ติด NOT_FINAL_MAIN_SHA
  const context = {
    commitSha: SHA,
    finalMainSha: OTHER_SHA,
    expectedCommitSha: SHA,
    commitOnMain: true,
    pullRequest: null,
    ref: 'refs/heads/main',
    cleanTree: true,
    runUrl: 'https://github.com/x/y/actions/runs/1',
    artifact: { immutable: true },
  };
  assert.equal(contextOnMain(context), true);
  assert.ok(!j3MarkerBlockers(context, []).includes('NOT_FINAL_MAIN_SHA'));
  // commit ที่ยังไม่ merge
  assert.ok(
    j3MarkerBlockers({ ...context, commitOnMain: false }, []).includes('NOT_FINAL_MAIN_SHA'),
  );
  // expected SHA ของ run ต้องตรงเสมอ
  assert.ok(
    j3MarkerBlockers({ ...context, expectedCommitSha: OTHER_SHA }, []).includes(
      'NOT_FINAL_MAIN_SHA',
    ),
  );
  // context เก่าที่ไม่มีผลตรวจ ใช้กติกาเดิม (HEAD)
  assert.equal(contextOnMain({ commitSha: SHA, finalMainSha: SHA }), true);
  assert.equal(contextOnMain({ commitSha: SHA, finalMainSha: OTHER_SHA }), false);
});
