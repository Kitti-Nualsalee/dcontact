import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const CG3_MARKER = 'CONTACT_GOVERNANCE_CG3_ACCEPTED';
export const J2_MARKER = 'JOURNEY_J2_ACCEPTED';

/**
 * regression ของ `CG4-REG01` ที่ S1 รันอยู่แล้วใน `S1-REG-01` บน SHA เดียวกัน — CG4 ไม่รันซ้ำเอง
 * แต่ต้องพิสูจน์จาก S1 manifest ว่าทุกคำสั่ง PASS จริง (subcheck ที่ไม่ได้รันเพราะตัวก่อนหน้าล้มถือว่า MISSING)
 */
export const S1_REGRESSION_SCRIPTS = Object.freeze([
  'build',
  'typecheck',
  'lint',
  'cxa:e0:acceptance',
  'cxa:c1:acceptance',
  'voice:acceptance',
]);

/**
 * CG4-REG01 (#178): dependency marker บน SHA เดียวกัน — S1 ต้องถูก rerun ใน workflow เดียวกันจนออก
 * `CONTACT_GOVERNANCE_CG3_ACCEPTED`; J2 marker ไม่เป็น prerequisite แต่ถ้ามีบน SHA เดียวกันให้บันทึก
 * `ACCEPTED_SAME_SHA` ไม่งั้นเป็น `CONTRACT_COMPATIBLE` ซึ่ง targeted conformance ของ CG4-REG02 พิสูจน์
 *
 * run ที่ไม่ใช่ final main (PR/local) บันทึก `CANDIDATE_NOT_FINAL_MAIN` เพื่อให้ได้ candidate manifest
 * แต่ validator ไม่ยอมออก CG4 marker จาก profile นี้
 */

function git(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return undefined;
  return String(result.stdout).trim();
}

function readManifest(path) {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function s1RegressionStatus(s1) {
  const regression = s1?.checks?.find((item) => item.id === 'S1-REG-01');
  return Object.fromEntries(
    S1_REGRESSION_SCRIPTS.map((script) => [
      script,
      regression?.subchecks?.find((subcheck) => subcheck.command?.at(-1) === script)?.status ??
        'MISSING',
    ]),
  );
}

export function cxaCg4DependencySummary(options = {}) {
  const environment = options.environment ?? process.env;
  const commitSha = options.commitSha ?? git(['rev-parse', 'HEAD']);
  const mainSha = options.mainSha ?? git(['rev-parse', 'origin/main']);
  const expectedCommitSha = environment.CXA_CG4_EXPECTED_COMMIT_SHA ?? mainSha;
  const runId = environment.GITHUB_RUN_ID ?? 'local';
  const finalMain =
    Boolean(environment.GITHUB_RUN_ID) &&
    !environment.GITHUB_PR_NUMBER &&
    commitSha !== undefined &&
    commitSha === mainSha &&
    commitSha === expectedCommitSha;
  const s1Path =
    options.s1ManifestPath ?? resolve(repositoryRoot, 'artifacts', 's1', `${runId}.json`);
  const j2Path =
    options.j2ManifestPath ?? resolve(repositoryRoot, 'artifacts', 'cxa-j2', `${runId}.json`);
  const s1 = options.s1Manifest ?? readManifest(s1Path);
  const j2 = options.j2Manifest ?? readManifest(j2Path);

  const sameSha = s1 !== undefined && s1.commitSha === commitSha && s1.finalMainSha === commitSha;
  const cg3SameSha = sameSha && (s1.markers ?? []).includes(CG3_MARKER);
  const s1Regression = s1RegressionStatus(sameSha ? s1 : undefined);
  const regressionPassed = Object.values(s1Regression).every((status) => status === 'PASS');

  if (finalMain && !cg3SameSha) {
    throw new Error(
      `CG4 acceptance ต้องมี ${CG3_MARKER} จาก S1 manifest บน SHA เดียวกัน (${s1 ? 'marker/SHA ไม่ตรง' : 'ไม่พบ manifest'})`,
    );
  }
  if (finalMain && !regressionPassed) {
    const failed = Object.entries(s1Regression)
      .filter(([, status]) => status !== 'PASS')
      .map(([script, status]) => `${script}=${status}`);
    throw new Error(`CG4-REG01 ต้องมี regression ของ S1-REG-01 PASS ครบ: ${failed.join(', ')}`);
  }
  const j2SameSha =
    j2 !== undefined && j2.commitSha === commitSha && (j2.markers ?? []).includes(J2_MARKER);

  return {
    type: 'dependency.readiness',
    workflow: 'cxa-cg4-dependency',
    status: 'PASS',
    commitSha,
    cg3: cg3SameSha ? 'INTEGRATED_SAME_SHA' : 'CANDIDATE_NOT_FINAL_MAIN',
    cg3Marker: cg3SameSha ? CG3_MARKER : null,
    s1ManifestSha256: s1 ? sha256(s1) : null,
    s1Regression,
    j2: j2SameSha ? 'ACCEPTED_SAME_SHA' : 'CONTRACT_COMPATIBLE',
    j2ManifestSha256: j2SameSha ? sha256(j2) : null,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(
      `CXA_CG4_DEPENDENCY_EVIDENCE:${JSON.stringify(cxaCg4DependencySummary())}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
