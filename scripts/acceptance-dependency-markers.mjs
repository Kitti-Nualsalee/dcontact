import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * #559: REG ของ J2/J3/J5 ไม่ spawn acceptance ของ phase ก่อนหน้าซ้ำ แต่ตรวจ marker ใน evidence manifest
 * ของ phase นั้นบน SHA เดียวกัน — manifest มาจาก immutable CI artifact ของ run ใดก็ได้บน SHA นี้
 * (ตัดสินใจข้อ 1 ของ #559) ซึ่ง `acceptance-fetch-evidence.mjs` ดาวน์โหลดมาพร้อม provenance
 *
 * `dispatch` คือคำสั่งที่ต้องรันก่อนเมื่อ marker ขาด
 */
export const ACCEPTANCE_PHASES = Object.freeze({
  c1: Object.freeze({
    marker: 'J1_ACCEPTED',
    directory: 'cxa-c1',
    artifact: 'cxa-c1-evidence',
    dispatch: 'gh workflow run CI --ref main -f acceptance=s1',
  }),
  s1: Object.freeze({
    marker: 'CONTACT_GOVERNANCE_CG3_ACCEPTED',
    directory: 's1',
    artifact: 's1-evidence',
    dispatch: 'gh workflow run CI --ref main -f acceptance=s1',
  }),
  j2: Object.freeze({
    marker: 'JOURNEY_J2_ACCEPTED',
    directory: 'cxa-j2',
    artifact: 'cxa-j2-evidence',
    dispatch: 'gh workflow run CI --ref main -f acceptance=j2',
  }),
  cg4: Object.freeze({
    marker: 'CONTACT_GOVERNANCE_CG4_ACCEPTED',
    directory: 'cxa-cg4',
    artifact: 'cxa-cg4-evidence',
    dispatch: 'gh workflow run CI --ref main -f acceptance=cg4',
  }),
  j3: Object.freeze({
    marker: 'JOURNEY_J3_ACCEPTED',
    directory: 'cxa-j3',
    artifact: 'cxa-j3-evidence',
    dispatch: 'gh workflow run cxa-j3-acceptance --ref main',
  }),
});

/** phase ที่ REG ของแต่ละ acceptance ต้องเห็น marker บน SHA เดียวกัน */
export const ACCEPTANCE_DEPENDENCIES = Object.freeze({
  J2: Object.freeze(['c1', 's1']),
  J3: Object.freeze(['s1', 'j2', 'cg4']),
  J5: Object.freeze(['c1', 'j2', 'j3', 's1']),
});

export const PROVENANCE_PATH = 'acceptance-dependencies/provenance.json';

export const fileDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function git(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) return undefined;
  return String(result.stdout).trim();
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * manifest ที่นับได้ต้องมี provenance จากการดาวน์โหลด CI artifact บน SHA เดียวกัน และ digest ของไฟล์ต้องตรง
 * ไฟล์ที่ไม่มี provenance (เช่นไฟล์ค้างจาก local run) หรือถูกแก้หลังดาวน์โหลดไม่นับ
 */
export function loadVerifiedManifests(artifactsRoot, phase, commitSha) {
  const { directory } = ACCEPTANCE_PHASES[phase];
  const provenance = readJson(resolve(artifactsRoot, PROVENANCE_PATH));
  const entries = Array.isArray(provenance?.entries) ? provenance.entries : [];
  const folder = resolve(artifactsRoot, directory);
  if (!existsSync(folder)) return [];
  const files = new Set(readdirSync(folder));
  return entries
    .filter((entry) => entry?.phase === phase && entry.headSha === commitSha)
    .filter((entry) => typeof entry.file === 'string' && files.has(entry.file))
    .flatMap((entry) => {
      const bytes = readFileSync(resolve(folder, entry.file));
      if (fileDigest(bytes) !== entry.sha256) return [];
      try {
        return [{ manifest: JSON.parse(bytes.toString('utf8')), source: entry }];
      } catch {
        return [];
      }
    });
}

/** นับเฉพาะ manifest บน commit เดียวกันที่ไม่ใช่ candidate และมี marker ของเฟสนั้นจริง */
export function phaseMarkerStatus(records, commitSha, phase) {
  const { marker, dispatch } = ACCEPTANCE_PHASES[phase];
  const accepted = records.find(
    ({ manifest }) =>
      manifest?.commitSha === commitSha &&
      manifest?.candidate !== true &&
      (manifest.markers ?? []).includes(marker),
  );
  return accepted
    ? {
        status: 'ACCEPTED_SAME_SHA',
        marker,
        // digest อยู่ใต้ key `sha256` ที่ PII guard รู้จัก — hex ยาวอาจบังเอิญคล้ายเบอร์โทรที่ท้าย string
        manifest: { sha256: sha256(accepted.manifest) },
        // run id เป็น number: PII guard ตรวจเฉพาะ string ซึ่ง run id อาจบังเอิญคล้ายเบอร์โทร
        sourceRunId: accepted.source ? Number(accepted.source.runId) : null,
      }
    : { status: 'ABSENT', marker, manifest: null, remediation: dispatch };
}

/**
 * `records` override ใช้ใน test (ถือว่าผ่าน provenance แล้ว) — ปกติโหลดจาก `artifacts/`
 */
export function acceptanceDependencySummary(acceptance, options = {}) {
  const phases = ACCEPTANCE_DEPENDENCIES[acceptance];
  if (!phases) throw new TypeError(`ไม่รู้จัก acceptance ${acceptance}`);
  const commitSha = options.commitSha ?? git(['rev-parse', 'HEAD']);
  const artifactsRoot = options.artifactsRoot ?? resolve(repositoryRoot, 'artifacts');
  const records = options.records ?? {};
  const result = Object.fromEntries(
    phases.map((phase) => [
      phase,
      phaseMarkerStatus(
        records[phase] ?? loadVerifiedManifests(artifactsRoot, phase, commitSha),
        commitSha,
        phase,
      ),
    ]),
  );
  const allAcceptedSameSha = Object.values(result).every(
    ({ status }) => status === 'ACCEPTED_SAME_SHA',
  );
  return {
    type: 'dependency.readiness',
    workflow: `acceptance-dependency-${acceptance.toLowerCase()}`,
    status: allAcceptedSameSha ? 'PASS' : 'FAIL',
    commitSha,
    allAcceptedSameSha,
    phases: result,
  };
}

export function missingDependencyMessage(summary) {
  const missing = Object.entries(summary.phases).filter(
    ([, value]) => value.status !== 'ACCEPTED_SAME_SHA',
  );
  return [
    `marker ของ dependency ยังไม่ครบบน ${summary.commitSha}:`,
    ...missing.map(
      ([phase, value]) => `- ${phase} (${value.marker}): สั่ง \`${value.remediation}\``,
    ),
    'แล้วรอให้ผ่านก่อนสั่ง acceptance นี้อีกครั้ง',
  ].join('\n');
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = acceptanceDependencySummary(process.argv[2]);
    process.stdout.write(`ACCEPTANCE_DEPENDENCY_EVIDENCE:${JSON.stringify(summary)}\n`);
    if (!summary.allAcceptedSameSha) {
      process.stderr.write(`${missingDependencyMessage(summary)}\n`);
      process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
