#!/usr/bin/env node
/**
 * A1.8 (#413): release candidate evidence bundle ของ A1 ตาม #393 §6–7
 *
 * - `build`: รวม `acceptance-manifest.json` ของ fast + real-boundary จาก commit เดียวกันเป็นไฟล์เดียว
 *   (manifest เก็บเป็น byte เดิมพร้อม SHA-256) — ปฏิเสธเมื่อ non-waivable gate ไม่ PASS, มี check ขาด/SKIP,
 *   SHA ไม่ตรง, tree dirty, config digest ต่างกัน, ไม่มี image digest หรือพบ PII/secret
 * - `verify`: ตรวจ bundle เดิมซ้ำทั้งหมด (ใช้เป็น gate ก่อนเปิด UAT preview) — ลายเซ็นตรวจแยกด้วย
 *   `gh attestation verify` เพราะ bundle ถูก attest ใน workflow ด้วย Sigstore
 *
 * CLI:
 *   node scripts/a1-rc-bundle.mjs build --manifest <file> [--manifest <file>] --expect-sha <sha> --out <file>
 *   node scripts/a1-rc-bundle.mjs verify --bundle <file> --expect-sha <sha>
 *   node scripts/a1-rc-bundle.mjs gate --expect-sha <sha> [--repo owner/name]
 *     = UAT preview gate: ดาวน์โหลด asset จาก pre-release `a1-rc-<sha>`, verify ซ้ำ และ
 *       `gh attestation verify` — ต้อง PASS ก่อนเปิด UAT preview ของ build จาก SHA เดียวกัน
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import {
  A1_CHECKS,
  A1_MANIFEST_SCHEMA,
  A1_WORKFLOW,
  NON_WAIVABLE_GATES,
} from './a1-acceptance.mjs';
import { assertPiiSafeEvidence } from './cxa-c1-readiness.mjs';

export const A1_RC_BUNDLE_SCHEMA = 1;
const REQUIRED_PROFILES = ['fast', 'real-boundary'];
const IMAGE_DIGEST = /@sha256:[a-f0-9]{64}$/;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** ตรวจ manifest ชุดหนึ่งตาม #393 §7 — คืนเหตุผลที่ไม่ผ่าน (ว่าง = ผ่าน) */
export function evaluateManifests(manifests, expectedSha) {
  const reasons = [];
  if (!/^[a-f0-9]{40}$/.test(expectedSha ?? '')) reasons.push('EXPECTED_SHA_INVALID');
  const profiles = new Set();
  const checks = new Map();
  const configs = new Set();
  const gates = Object.fromEntries(NON_WAIVABLE_GATES.map((gate) => [gate, []]));
  let images = {};
  for (const manifest of manifests) {
    const run = manifest.run ?? {};
    if (manifest.schemaVersion !== A1_MANIFEST_SCHEMA) reasons.push(`SCHEMA_MISMATCH:${run.id}`);
    if (manifest.workflow?.name !== A1_WORKFLOW.name) reasons.push(`WORKFLOW_MISMATCH:${run.id}`);
    if (manifest.source?.commitSha !== expectedSha) reasons.push(`COMMIT_MISMATCH:${run.profile}`);
    if (manifest.source?.dirty !== false) reasons.push(`DIRTY_TREE:${run.profile}`);
    if (manifest.status !== 'PASS') reasons.push(`MANIFEST_NOT_PASS:${run.profile}`);
    configs.add(manifest.source?.config?.sha256);
    for (const profile of run.profile === 'all' ? REQUIRED_PROFILES : [run.profile]) {
      profiles.add(profile);
    }
    for (const check of manifest.checks ?? []) checks.set(check.checkId, check);
    for (const [gate, status] of Object.entries(manifest.nonWaivable ?? {})) {
      gates[gate]?.push(status);
    }
    images = { ...images, ...(manifest.environment?.images ?? {}) };
  }
  for (const profile of REQUIRED_PROFILES) {
    if (!profiles.has(profile)) reasons.push(`PROFILE_MISSING:${profile}`);
  }
  if (configs.size !== 1) reasons.push('CONFIG_DIGEST_MISMATCH');
  for (const check of A1_CHECKS) {
    const result = checks.get(check.id);
    if (!result) {
      reasons.push(`CHECK_MISSING:${check.id}`);
      continue;
    }
    const counters = result.counters ?? {};
    // SKIP/todo/flaky ไม่นับเป็นผ่าน (#393 §7: ห้ามมี SKIP)
    if (
      result.status !== 'PASS' ||
      (counters.skipped ?? 0) > 0 ||
      (counters.todo ?? 0) > 0 ||
      (counters.flaky ?? 0) > 0
    ) {
      reasons.push(`CHECK_NOT_PASS:${check.id}`);
    }
  }
  for (const [gate, statuses] of Object.entries(gates)) {
    // ต้องมีหลักฐาน PASS อย่างน้อยหนึ่ง profile และไม่มี profile ใด FAIL/UNCOVERED
    if (
      !statuses.includes('PASS') ||
      statuses.some((s) => s !== 'PASS' && s !== 'NOT_IN_PROFILE')
    ) {
      reasons.push(`GATE_NOT_PASS:${gate}`);
    }
  }
  const digests = Object.values(images);
  if (digests.length === 0 || !digests.every((digest) => IMAGE_DIGEST.test(digest))) {
    reasons.push('IMAGE_DIGESTS_MISSING');
  }
  try {
    assertPiiSafeEvidence(manifests);
  } catch {
    reasons.push('PII_OR_SECRET_IN_EVIDENCE');
  }
  return { ok: reasons.length === 0, reasons, images };
}

export function buildBundle({ manifestTexts, expectedSha, createdAt = new Date() }) {
  const manifests = manifestTexts.map((text) => JSON.parse(text));
  const evaluation = evaluateManifests(manifests, expectedSha);
  if (!evaluation.ok) return { ok: false, reasons: evaluation.reasons };
  const bundle = {
    schemaVersion: A1_RC_BUNDLE_SCHEMA,
    workflow: { ...A1_WORKFLOW },
    kind: 'a1-release-candidate',
    commitSha: expectedSha,
    createdAt: createdAt.toISOString(),
    configSha256: manifests[0].source.config.sha256,
    nonWaivable: Object.fromEntries(NON_WAIVABLE_GATES.map((gate) => [gate, 'PASS'])),
    images: evaluation.images,
    contextPointers: ['#385', '#393', '#413'],
    manifests: manifestTexts.map((content, index) => ({
      runId: manifests[index].run.id,
      profile: manifests[index].run.profile,
      sha256: sha256(content),
      content,
    })),
  };
  return { ok: true, bundle, text: `${JSON.stringify(bundle, null, 2)}\n` };
}

export function verifyBundle(text, expectedSha) {
  let bundle;
  try {
    bundle = JSON.parse(text);
  } catch {
    return { ok: false, reasons: ['BUNDLE_UNREADABLE'] };
  }
  const reasons = [];
  if (bundle.schemaVersion !== A1_RC_BUNDLE_SCHEMA || bundle.kind !== 'a1-release-candidate') {
    reasons.push('BUNDLE_SCHEMA_MISMATCH');
  }
  if (bundle.commitSha !== expectedSha) reasons.push('BUNDLE_COMMIT_MISMATCH');
  const entries = Array.isArray(bundle.manifests) ? bundle.manifests : [];
  for (const entry of entries) {
    if (sha256(entry.content ?? '') !== entry.sha256)
      reasons.push(`MANIFEST_TAMPERED:${entry.profile}`);
  }
  let manifests = [];
  try {
    manifests = entries.map((entry) => JSON.parse(entry.content));
  } catch {
    reasons.push('MANIFEST_UNREADABLE');
  }
  reasons.push(...evaluateManifests(manifests, expectedSha).reasons);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)], sha256: sha256(text) };
}

export const rcReleaseTag = (sha) => `a1-rc-${sha}`;
export const RC_BUNDLE_FILE = 'a1-rc-bundle.json';

/** gate ก่อนเปิด UAT preview: bundle ต้องมีจริง, ตรวจซ้ำผ่าน และ attestation ของ repo นี้ยืนยัน digest */
export function uatGate({ expectedSha, repo: requestedRepo, run = execFileSync }) {
  const directory = mkdtempSync(join(tmpdir(), 'a1-rc-'));
  try {
    const gh = (...args) =>
      run('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    // attestation ต้องผูกกับ repo นี้เสมอ — ไม่ยอมรับ attestation ของ repo อื่นใน owner เดียวกัน
    const repo =
      requestedRepo ??
      process.env.GITHUB_REPOSITORY ??
      String(gh('repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner')).trim();
    try {
      gh(
        'release',
        'download',
        rcReleaseTag(expectedSha),
        '--pattern',
        RC_BUNDLE_FILE,
        '--dir',
        directory,
        '--repo',
        repo,
      );
    } catch {
      return { ok: false, reasons: ['RC_RELEASE_MISSING'] };
    }
    const file = join(directory, RC_BUNDLE_FILE);
    const verified = verifyBundle(readFileSync(file, 'utf8'), expectedSha);
    if (!verified.ok) return verified;
    try {
      gh('attestation', 'verify', file, '--repo', repo);
    } catch {
      return { ok: false, reasons: ['ATTESTATION_UNVERIFIED'], sha256: verified.sha256 };
    }
    return verified;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function option(argv, name) {
  const values = [];
  argv.forEach((value, index) => {
    if (value === `--${name}` && argv[index + 1]) values.push(argv[index + 1]);
  });
  return values;
}

export function main(argv = process.argv.slice(2)) {
  const [command] = argv;
  const expectedSha = option(argv, 'expect-sha')[0];
  if (command === 'build') {
    const out = option(argv, 'out')[0];
    const result = buildBundle({
      manifestTexts: option(argv, 'manifest').map((file) => readFileSync(file, 'utf8')),
      expectedSha,
    });
    if (!result.ok || !out) {
      console.log(
        JSON.stringify({
          type: 'a1.rc.bundle',
          status: 'FAIL',
          reasons: result.reasons ?? ['OUT_REQUIRED'],
        }),
      );
      return 1;
    }
    writeFileSync(out, result.text);
    console.log(
      JSON.stringify({
        type: 'a1.rc.bundle',
        status: 'PASS',
        file: out,
        sha256: sha256(result.text),
      }),
    );
    return 0;
  }
  if (command === 'verify') {
    const result = verifyBundle(readFileSync(option(argv, 'bundle')[0], 'utf8'), expectedSha);
    console.log(
      JSON.stringify({ type: 'a1.rc.verify', status: result.ok ? 'PASS' : 'FAIL', ...result }),
    );
    return result.ok ? 0 : 1;
  }
  if (command === 'gate') {
    const result = uatGate({ expectedSha, repo: option(argv, 'repo')[0] });
    console.log(
      JSON.stringify({ type: 'a1.uat.gate', status: result.ok ? 'PASS' : 'FAIL', ...result }),
    );
    return result.ok ? 0 : 1;
  }
  console.error('ใช้: a1-rc-bundle.mjs build|verify|gate ...');
  return 2;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) process.exitCode = main();
