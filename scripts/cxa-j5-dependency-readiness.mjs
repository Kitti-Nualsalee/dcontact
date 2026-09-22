import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * J5-REG01 (#333): `JOURNEY_J5_ACCEPTED` ต้องมี J1/J2/J3/CG3 marker บน SHA เดียวกัน — script นี้รายงาน
 * เฉพาะสิ่งที่พบใน manifest จริงที่ `pnpm cxa:j3:acceptance` (และ acceptance ที่มันเรียกต่อ) เขียนไว้
 * การตัดสินว่าออก marker ได้หรือไม่เป็นของ runner ผ่าน marker blockers
 */
export const J5_DEPENDENCY_PHASES = Object.freeze([
  { phase: 'j1', marker: 'J1_ACCEPTED', directory: 'cxa-c1' },
  { phase: 'j2', marker: 'JOURNEY_J2_ACCEPTED', directory: 'cxa-j2' },
  { phase: 'j3', marker: 'JOURNEY_J3_ACCEPTED', directory: 'cxa-j3' },
  { phase: 'cg3', marker: 'CONTACT_GOVERNANCE_CG3_ACCEPTED', directory: 's1' },
]);

function git(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return undefined;
  return String(result.stdout).trim();
}

function manifestsIn(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .flatMap((name) => {
      try {
        return [JSON.parse(readFileSync(resolve(directory, name), 'utf8'))];
      } catch {
        return [];
      }
    });
}

/** นับเฉพาะ manifest บน commit เดียวกันที่มี marker ของเฟสนั้นจริง — ไฟล์ค้างจาก SHA อื่นไม่นับ */
export function j5PhaseMarkerStatus(manifests, commitSha, marker) {
  const accepted = manifests.find(
    (manifest) =>
      manifest?.commitSha === commitSha &&
      manifest?.candidate !== true &&
      (manifest.markers ?? []).includes(marker),
  );
  return accepted
    ? // digest อยู่ใต้ key `sha256` ที่ PII guard รู้จัก — hex ยาวอาจบังเอิญคล้ายเบอร์โทรที่ท้าย string
      { status: 'ACCEPTED_SAME_SHA', marker, manifest: { sha256: sha256(accepted) } }
    : { status: 'ABSENT', marker, manifest: null };
}

export function cxaJ5DependencySummary(options = {}) {
  const commitSha = options.commitSha ?? git(['rev-parse', 'HEAD']);
  const artifactsRoot = options.artifactsRoot ?? resolve(repositoryRoot, 'artifacts');
  const manifests = options.manifests ?? {};
  const phases = Object.fromEntries(
    J5_DEPENDENCY_PHASES.map(({ phase, marker, directory }) => [
      phase,
      j5PhaseMarkerStatus(
        manifests[phase] ?? manifestsIn(resolve(artifactsRoot, directory)),
        commitSha,
        marker,
      ),
    ]),
  );
  return {
    type: 'dependency.readiness',
    workflow: 'cxa-j5-dependency',
    status: 'PASS',
    commitSha,
    allAcceptedSameSha: Object.values(phases).every(({ status }) => status === 'ACCEPTED_SAME_SHA'),
    phases,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(
      `CXA_J5_DEPENDENCY_EVIDENCE:${JSON.stringify(cxaJ5DependencySummary())}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
