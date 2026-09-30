import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  loadVerifiedManifests,
  missingDependencyMessage,
  phaseMarkerStatus,
} from './acceptance-dependency-markers.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * J5-REG01 (#333): `JOURNEY_J5_ACCEPTED` ต้องมี J1/J2/J3/CG3 marker บน SHA เดียวกัน
 * #559: manifest มาจาก immutable CI artifact ของ run ใดก็ได้บน SHA นี้ (`acceptance-fetch-evidence.mjs J5`)
 * ไม่ได้มาจาก `cxa:j3:acceptance` ที่รันซ้อนอยู่ใน J5 อีกแล้ว — marker ไม่ครบ = suite ล้ม (fail-closed)
 * และ runner ยังกัน marker ของ J5 ผ่าน `DEPENDENCY_MARKERS_NOT_SAME_SHA`
 *
 * key ของ phase (j1/cg3) คงเดิมเพื่อให้ evidence ของ J5 เทียบกับ manifest รุ่นก่อนได้
 */
export const J5_DEPENDENCY_PHASES = Object.freeze([
  { phase: 'j1', marker: 'J1_ACCEPTED', source: 'c1' },
  { phase: 'j2', marker: 'JOURNEY_J2_ACCEPTED', source: 'j2' },
  { phase: 'j3', marker: 'JOURNEY_J3_ACCEPTED', source: 'j3' },
  { phase: 'cg3', marker: 'CONTACT_GOVERNANCE_CG3_ACCEPTED', source: 's1' },
]);

function git(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return undefined;
  return String(result.stdout).trim();
}

/** นับเฉพาะ manifest บน commit เดียวกันที่มี marker ของเฟสนั้นจริง — ไฟล์ค้างจาก SHA อื่นไม่นับ */
export function j5PhaseMarkerStatus(manifests, commitSha, marker) {
  const { source } = J5_DEPENDENCY_PHASES.find((item) => item.marker === marker);
  return phaseMarkerStatus(
    manifests.map((manifest) => ({ manifest })),
    commitSha,
    source,
  );
}

/** `manifests` override ใช้ใน test (ถือว่าผ่าน provenance แล้ว) — ปกติโหลดจาก `artifacts/` */
export function cxaJ5DependencySummary(options = {}) {
  const commitSha = options.commitSha ?? git(['rev-parse', 'HEAD']);
  const artifactsRoot = options.artifactsRoot ?? resolve(repositoryRoot, 'artifacts');
  const manifests = options.manifests ?? {};
  const phases = Object.fromEntries(
    J5_DEPENDENCY_PHASES.map(({ phase, source }) => [
      phase,
      phaseMarkerStatus(
        manifests[phase]
          ? manifests[phase].map((manifest) => ({ manifest }))
          : loadVerifiedManifests(artifactsRoot, source, commitSha),
        commitSha,
        source,
      ),
    ]),
  );
  const allAcceptedSameSha = Object.values(phases).every(
    ({ status }) => status === 'ACCEPTED_SAME_SHA',
  );
  return {
    type: 'dependency.readiness',
    workflow: 'cxa-j5-dependency',
    status: allAcceptedSameSha ? 'PASS' : 'FAIL',
    commitSha,
    allAcceptedSameSha,
    phases,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = cxaJ5DependencySummary();
    process.stdout.write(`CXA_J5_DEPENDENCY_EVIDENCE:${JSON.stringify(summary)}\n`);
    if (!summary.allAcceptedSameSha) {
      process.stderr.write(`${missingDependencyMessage(summary)}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
