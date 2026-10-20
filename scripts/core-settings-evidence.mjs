import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitOnMain } from './acceptance-main-proof.mjs';

export function summarizeTap(text) {
  const last = (key) => [...text.matchAll(new RegExp(`^# ${key} (\\d+)$`, 'gm'))].at(-1)?.[1];
  const counts = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].map((key) => [
      key,
      last(key) === undefined ? null : Number(last(key)),
    ]),
  );
  const complete = Object.values(counts).every((count) => count !== null);
  const result =
    !complete || counts.tests === 0 || counts.skipped > 0 || counts.todo > 0
      ? 'NOT_RUN'
      : counts.fail > 0 || counts.cancelled > 0 || counts.pass !== counts.tests
        ? 'FAIL'
        : 'PASS';
  return { result, ...counts };
}

function imageId(container) {
  if (!container) return null;
  try {
    const id = execFileSync('docker', ['inspect', '--format', '{{.Image}}', container], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^sha256:[a-f0-9]{64}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function captureEvidence() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const directory = resolve(root, 'artifacts/core-settings');
  const env = process.env;
  const expected = {
    'contract-db': ['contract.tap', 'http.tap', 'db.tap', 'provisioner.tap'],
    'identity-boundary': ['identity.tap'],
    'organization-browser': ['model.tap', 'browser.tap'],
    'organization-compatibility': ['compatibility.tap'],
  }[env.GITHUB_JOB];
  if (
    !expected ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '') ||
    !/^\d+$/.test(env.GITHUB_RUN_ID ?? '')
  )
    throw Error('ต้องมี CI job/SHA/run context จริงก่อนเก็บ evidence');
  const checks = expected.map((file) => {
    try {
      const content = readFileSync(resolve(directory, file));
      return {
        file,
        sha256: createHash('sha256').update(content).digest('hex'),
        ...summarizeTap(content.toString()),
      };
    } catch {
      return { file, result: 'NOT_RUN' };
    }
  });
  const sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const clean =
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: root,
      encoding: 'utf8',
    }).trim() === '';
  const postgres = imageId(env.CORE_POSTGRES_CONTAINER_ID);
  const needsKeycloak = [
    'identity-boundary',
    'organization-browser',
    'organization-compatibility',
  ].includes(env.GITHUB_JOB);
  const keycloak = needsKeycloak ? imageId('core-settings-identity') : null;
  const metadataFiles =
    {
      'organization-browser': ['browser-config.json'],
      'organization-compatibility': ['compatibility-config.json', 'migration-config.json'],
    }[env.GITHUB_JOB] ?? [];
  const metadata = metadataFiles.map((file) => {
    try {
      const content = readFileSync(resolve(directory, file));
      return { file, sha256: createHash('sha256').update(content).digest('hex'), result: 'PASS' };
    } catch {
      return { file, result: 'NOT_RUN' };
    }
  });
  const passed =
    sourceSha === env.GITHUB_SHA &&
    clean &&
    postgres &&
    (!needsKeycloak || keycloak) &&
    checks.every((check) => check.result === 'PASS') &&
    metadata.every((check) => check.result === 'PASS');
  const evidence = {
    schemaVersion: 1,
    kind: 'CORE_SETTINGS_TEST_EVIDENCE',
    result: passed ? 'PASS' : 'NOT_PASSED',
    sourceSha,
    expectedSha: env.GITHUB_SHA,
    ref: env.GITHUB_REF,
    commitOnMain: commitOnMain(sourceSha),
    cleanCheckout: clean,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
    job: env.GITHUB_JOB,
    runUrl: `https://github.com/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
    nodeVersion: process.version,
    images: { postgres, ...(keycloak ? { keycloak } : {}) },
    checks,
    metadata,
    runtime: { icu: process.versions.icu, tzdb: process.versions.tz },
    // หลักฐาน CI ของ foundation ไม่ใช่ VM UAT หรือ marker ของ first slice
    vmUat: 'NOT_RUN',
    recordedAt: new Date().toISOString(),
  };
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolve(directory, 'manifest.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  if (!passed) process.exitCode = 1;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  captureEvidence();
