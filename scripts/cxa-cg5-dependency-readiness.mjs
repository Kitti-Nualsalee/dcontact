import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * CG5-REG01/REG02 (#273 §2): CG5 ไม่บังคับ marker ของเฟสอื่นบน SHA เดียวกัน แต่ต้องบันทึกว่าหลักฐานรอบนี้
 * ยืนอยู่บนอะไร — script นี้รายงานเฉพาะสิ่งที่พบใน manifest จริง (`ACCEPTED_SAME_SHA` หรือ `ABSENT`)
 * ส่วน `CONTRACT_COMPATIBLE` ตัดสินที่ runner จากผล targeted conformance ของ check ที่ครอบเฟสนั้น
 */
export const CG5_DEPENDENCY_PHASES = Object.freeze([
  {
    phase: 'cg3',
    marker: 'CONTACT_GOVERNANCE_CG3_ACCEPTED',
    directory: 's1',
    checkId: 'CG5-REG01',
  },
  {
    phase: 'cg4',
    marker: 'CONTACT_GOVERNANCE_CG4_ACCEPTED',
    directory: 'cxa-cg4',
    checkId: 'CG5-REG01',
  },
  { phase: 'j2', marker: 'JOURNEY_J2_ACCEPTED', directory: 'cxa-j2', checkId: 'CG5-REG02' },
  { phase: 'j3', marker: 'JOURNEY_J3_ACCEPTED', directory: 'cxa-j3', checkId: 'CG5-REG02' },
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

/** manifest ที่นับได้ต้องอยู่บน commit เดียวกันและมี marker ของเฟสนั้นจริง — ไฟล์ค้างจาก SHA อื่นไม่นับ */
export function cg5PhaseMarkerStatus(manifests, commitSha, marker) {
  const accepted = manifests.find(
    (manifest) => manifest?.commitSha === commitSha && (manifest.markers ?? []).includes(marker),
  );
  return accepted
    ? { status: 'ACCEPTED_SAME_SHA', marker, manifestSha256: sha256(accepted) }
    : { status: 'ABSENT', marker, manifestSha256: null };
}

export function cxaCg5DependencySummary(options = {}) {
  const commitSha = options.commitSha ?? git(['rev-parse', 'HEAD']);
  const artifactsRoot = options.artifactsRoot ?? resolve(repositoryRoot, 'artifacts');
  const manifests = options.manifests ?? {};
  const phases = Object.fromEntries(
    CG5_DEPENDENCY_PHASES.map(({ phase, marker, directory }) => [
      phase,
      cg5PhaseMarkerStatus(
        manifests[phase] ?? manifestsIn(resolve(artifactsRoot, directory)),
        commitSha,
        marker,
      ),
    ]),
  );
  return {
    type: 'dependency.readiness',
    workflow: 'cxa-cg5-dependency',
    status: 'PASS',
    commitSha,
    phases,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(
      `CXA_CG5_DEPENDENCY_EVIDENCE:${JSON.stringify(cxaCg5DependencySummary())}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
