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

/** Write a manifest with the same provenance the fetch script writes */
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

test('nested suite that fails: detail names the suite id and the inner cause, not just the exit status', () => {
  const nested = [
    'noise line',
    JSON.stringify({ type: 'readiness.suite', id: 'suite:18', status: 'PASS' }),
    JSON.stringify({
      type: 'readiness.suite',
      id: 'suite:20',
      command: ['pnpm', 'cxa:cg4:acceptance'],
      status: 'FAIL',
      detail: 'not ok 3 - CG4 exception scope contacts customer@example.test',
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

test('no line reporting the failure: use the tail of the output instead of the exit status alone', () => {
  const detail = cg4FailureDetail(
    'step 1\ndependency marker is incomplete',
    'process exited with status 1',
  );
  assert.match(detail, /process exited with status 1/);
  assert.match(detail, /dependency marker is incomplete/);
  assert.equal(cg4FailureDetail('', 'SIGTERM'), 'SIGTERM');
});

test('J2/J3/J5 registry no longer spawns the acceptance of other phases, but checks the marker instead', () => {
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
      `${acceptance} still calls *:acceptance`,
    );
    const script =
      {
        J5: 'cxa-j5-dependency-readiness.mjs',
        CG4: 'cxa-cg4-dependency-readiness.mjs',
      }[acceptance] ?? 'acceptance-dependency-markers.mjs';
    const reg = checks.find(({ id }) => id === `${acceptance}-REG01`);
    assert.ok(
      reg.commands.some((command) => command.some((part) => String(part).endsWith(script))),
      `${acceptance}-REG01 must check the marker`,
    );
  }
});

test('a marker counts only for files with provenance on the same SHA and a matching digest', (t) => {
  const root = temporaryRoot(t);
  // a leftover file from a local run has no provenance
  mkdirSync(resolve(root, 's1'), { recursive: true });
  writeFileSync(resolve(root, 's1', 'local.json'), JSON.stringify(acceptedManifest('s1')));
  // a manifest edited after download
  writeFetched(root, 'c1', '1.json', acceptedManifest('c1'), { tamper: true });
  let summary = acceptanceDependencySummary('J2', { commitSha: SHA, artifactsRoot: root });
  assert.equal(summary.status, 'FAIL');
  assert.equal(summary.allAcceptedSameSha, false);
  assert.equal(summary.phases.s1.status, 'ABSENT');
  assert.equal(summary.phases.c1.status, 'ABSENT');
  assert.match(missingDependencyMessage(summary), /acceptance=s1/);

  // another SHA / candidate does not count
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

test('J5 dependency uses the same loader and fails when markers are incomplete', (t) => {
  const root = temporaryRoot(t);
  for (const phase of ACCEPTANCE_DEPENDENCIES.J5)
    writeFetched(root, phase, `${phase}.json`, acceptedManifest(phase));
  assert.equal(cxaJ5DependencySummary({ commitSha: SHA, artifactsRoot: root }).status, 'PASS');
  const missing = cxaJ5DependencySummary({ commitSha: OTHER_SHA, artifactsRoot: root });
  assert.equal(missing.status, 'FAIL');
  assert.deepEqual(Object.keys(missing.phases), ['j1', 'j2', 'j3', 'cg3']);
});

test('fetch: picks only artifacts on main + the same SHA, then writes provenance the checker accepts', async (t) => {
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
      // a failed run (id 5) uploaded a manifest without a marker - a marker must still be found from another run
      const manifest = item.id === 5 ? { commitSha: SHA, markers: [] } : acceptedManifest(phase);
      writeFileSync(resolve(destination, `${item.workflow_run.id}.json`), JSON.stringify(manifest));
    },
  });
  // in J2 phase order: c1 then s1 (newest first)
  assert.deepEqual(downloaded, [9, 5, 1]);
  assert.equal(entries.length, 3);
  const summary = acceptanceDependencySummary('J2', { commitSha: SHA, artifactsRoot: root });
  assert.equal(summary.status, 'PASS');
  assert.equal(summary.phases.s1.sourceRunId, 101);

  await assert.rejects(
    fetchDependencyEvidence({ acceptance: 'J9', commitSha: SHA, listArtifacts: async () => [] }),
    /unknown acceptance/,
  );
});

test('#572: CG4-REG01 uses the S1 manifest from an artifact with provenance and picks the one with the CG3 marker', (t) => {
  const root = temporaryRoot(t);
  const finalEnv = { GITHUB_RUN_ID: '99', CXA_CG4_EXPECTED_COMMIT_SHA: SHA };
  const summary = () =>
    cxaCg4DependencySummary({
      environment: finalEnv,
      commitSha: SHA,
      mainSha: SHA,
      artifactsRoot: root,
    });

  // no S1 on this SHA yet -> final main fails and says to run S1 first
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
  // a failed S1 run also has a manifest - it must not be picked over the run that passed
  writeFetched(root, 's1', '1.json', s1([], 'FAIL'));
  assert.throws(summary, /CONTACT_GOVERNANCE_CG3_ACCEPTED/);
  writeFetched(root, 's1', '2.json', s1(['CONTACT_GOVERNANCE_CG3_ACCEPTED'], 'PASS'));
  const result = summary();
  assert.equal(result.cg3, 'INTEGRATED_SAME_SHA');
  assert.ok(Object.values(result.s1Regression).every((status) => status === 'PASS'));
});

test('ADR-032: a marker can be issued when the commit is already on main even if main has moved on, but not when it is not on main', () => {
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

  // main has moved on (finalMainSha != commit) but the commit is on main -> not blocked by NOT_FINAL_MAIN_SHA
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
  // a commit not yet merged
  assert.ok(
    j3MarkerBlockers({ ...context, commitOnMain: false }, []).includes('NOT_FINAL_MAIN_SHA'),
  );
  // the run expected SHA must always match
  assert.ok(
    j3MarkerBlockers({ ...context, expectedCommitSha: OTHER_SHA }, []).includes(
      'NOT_FINAL_MAIN_SHA',
    ),
  );
  // an old context with no check result uses the original rule (HEAD)
  assert.equal(contextOnMain({ commitSha: SHA, finalMainSha: SHA }), true);
  assert.equal(contextOnMain({ commitSha: SHA, finalMainSha: OTHER_SHA }), false);
});
