import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  ACCEPTANCE_DEPENDENCIES,
  ACCEPTANCE_PHASES,
  PROVENANCE_PATH,
  fileDigest,
} from './acceptance-dependency-markers.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ARTIFACTS_PER_PHASE = 10;

/**
 * #559: ดาวน์โหลด evidence manifest ของ phase ที่ REG ต้องใช้ จาก CI artifact ของ run ใดก็ได้บน SHA เดียวกัน
 * แล้วบันทึก provenance (run, artifact, digest ของไฟล์) ให้ `acceptance-dependency-markers.mjs` ตรวจ
 *
 * เลือกเฉพาะ artifact ที่ยังไม่หมดอายุ ชื่อ `<artifact>-<sha>` มาจาก run บน main และ head SHA ตรง —
 * ดาวน์โหลดทุกตัวที่เข้าเงื่อนไข (ใหม่สุดก่อน) เพราะ run ที่ล้มก็ upload manifest ที่ไม่มี marker ไว้เหมือนกัน
 */
export function selectArtifacts(artifacts, name, commitSha) {
  return (artifacts ?? [])
    .filter(
      (artifact) =>
        artifact?.name === name &&
        artifact.expired !== true &&
        artifact.workflow_run?.head_sha === commitSha &&
        artifact.workflow_run?.head_branch === 'main',
    )
    .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
    .slice(0, MAX_ARTIFACTS_PER_PHASE);
}

export async function fetchDependencyEvidence({
  acceptance,
  commitSha,
  artifactsRoot = resolve(repositoryRoot, 'artifacts'),
  listArtifacts,
  downloadArtifact,
  log = (line) => process.stdout.write(`${line}\n`),
}) {
  const phases = ACCEPTANCE_DEPENDENCIES[acceptance];
  if (!phases) throw new TypeError(`ไม่รู้จัก acceptance ${acceptance}`);
  if (!/^[0-9a-f]{40}$/.test(commitSha ?? '')) throw new TypeError('ต้องระบุ commit SHA เต็ม');
  const entries = [];
  for (const phase of phases) {
    const { artifact, directory } = ACCEPTANCE_PHASES[phase];
    const name = `${artifact}-${commitSha}`;
    const selected = selectArtifacts(await listArtifacts(name), name, commitSha);
    if (selected.length === 0) {
      log(`[dependency] ${phase}: ไม่พบ artifact ${name} บน main`);
      continue;
    }
    const folder = resolve(artifactsRoot, directory);
    mkdirSync(folder, { recursive: true });
    for (const item of selected) {
      const staging = mkdtempSync(resolve(tmpdir(), 'acceptance-evidence-'));
      try {
        await downloadArtifact(item, staging);
        for (const file of readdirSync(staging).filter((entry) => entry.endsWith('.json'))) {
          const bytes = readFileSync(resolve(staging, file));
          copyFileSync(resolve(staging, file), resolve(folder, file));
          entries.push({
            phase,
            file,
            sha256: fileDigest(bytes),
            headSha: commitSha,
            headBranch: item.workflow_run.head_branch,
            runId: item.workflow_run.id,
            artifactId: item.id,
            artifactName: item.name,
          });
        }
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    log(`[dependency] ${phase}: ดาวน์โหลด ${selected.length} artifact`);
  }
  const provenancePath = resolve(artifactsRoot, PROVENANCE_PATH);
  mkdirSync(dirname(provenancePath), { recursive: true });
  writeFileSync(provenancePath, `${JSON.stringify({ commitSha, entries }, null, 2)}\n`);
  return entries;
}

function githubApi(repository, token) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const base = `${process.env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${repository}`;
  return {
    async listArtifacts(name) {
      const response = await fetch(
        `${base}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`,
        { headers },
      );
      if (!response.ok) throw new Error(`list artifacts ${name} ล้มเหลว: HTTP ${response.status}`);
      return (await response.json()).artifacts ?? [];
    },
    async downloadArtifact(artifact, destination) {
      const response = await fetch(`${base}/actions/artifacts/${artifact.id}/zip`, { headers });
      if (!response.ok)
        throw new Error(`download artifact ${artifact.id} ล้มเหลว: HTTP ${response.status}`);
      const zip = resolve(destination, 'artifact.zip');
      writeFileSync(zip, Buffer.from(await response.arrayBuffer()));
      const result = spawnSync('unzip', ['-o', '-q', '-j', zip, '*.json', '-d', destination], {
        encoding: 'utf8',
      });
      rmSync(zip, { force: true });
      if (result.status !== 0 || result.error)
        throw new Error(`unzip artifact ${artifact.id} ล้มเหลว: ${result.stderr ?? result.error}`);
    },
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const { GITHUB_REPOSITORY: repository, GITHUB_SHA: commitSha } = process.env;
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  try {
    if (!repository || !token) throw new Error('ต้องมี GITHUB_REPOSITORY และ GH_TOKEN');
    await fetchDependencyEvidence({
      acceptance: process.argv[2],
      commitSha,
      ...githubApi(repository, token),
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
