import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPiiSafeEvidence } from './cxa-c1-readiness.mjs';

/**
 * A1.8 (#413): acceptance ของ Platform Admin Tenant Provisioning ตาม #393
 *
 * - profile `fast` (PR gate 2–4 นาที): unit/contract/state machine, replay/recovery matrix ด้วย fake
 *   adapters, adversarial isolation matrix บน Postgres จริง, token fixtures ที่ลงนามในเครื่อง, Console
 * - profile `real-boundary` (8–12 นาที): Postgres + Keycloak (พร้อม invitation guard) + email sink จริง
 * - check ที่ skip/todo/ไม่มีผล/อ่านผลไม่ได้ = FAIL (#413: fail เมื่อมี skip/waiver/unknown result)
 * - `acceptance-manifest.json` ผูก commit SHA + config digest (+ image digest ของ real-boundary);
 *   log เต็มเก็บเฉพาะ check ที่ล้ม และผ่าน redaction + PII scan ก่อนเขียน (#393 checkpoint 2)
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const A1_WORKFLOW = Object.freeze({
  name: 'a1-platform-provisioning-acceptance',
  version: 1,
});
export const A1_MANIFEST_SCHEMA = 1;

/** ข้อบังคับที่ห้าม waive (#393/#413) — ทุกข้อต้องมี check อย่างน้อยหนึ่งตัวใน profile ที่รัน */
export const NON_WAIVABLE_GATES = Object.freeze([
  'isolation',
  'idempotency',
  'no-duplicate-resource',
  'no-premature-active',
  'complete-audit',
  'no-secret-leakage',
]);

const tsx = (filter, script) => [pnpm, '--filter', filter, script];

/**
 * check แต่ละตัว = หนึ่งคำสั่ง + ข้อใน #393 ที่มันพิสูจน์ (`proves`) + gate ที่ห้าม waive (`gates`)
 * `parser` บอกวิธีอ่านผล: `tap` (node:test) หรือ `playwright`
 */
export const A1_CHECKS = Object.freeze([
  {
    id: 'A1-F-CONTRACT',
    profile: 'fast',
    dimension: 'contract',
    command: tsx('@d-contact/platform-control', 'test'),
    parser: 'tap',
    proves: ['input canonicalization', 'error envelope ของ Keycloak client', 'deterministic ids'],
    gates: ['no-secret-leakage'],
  },
  {
    id: 'A1-F-SCHEMA-REGISTRY',
    profile: 'fast',
    dimension: 'migration',
    command: ['node', '--test', 'scripts/a1-schema-readiness.test.mjs'],
    parser: 'tap',
    proves: ['expand-only', 'append-only ledger ไม่มีสิทธิ์ UPDATE/DELETE', 'role/policy registry'],
    gates: ['complete-audit'],
  },
  {
    id: 'A1-F-CONTROL-PLANE',
    profile: 'fast',
    dimension: 'recovery',
    command: tsx('@d-contact/platform-control', 'test:integration'),
    parser: 'tap',
    proves: [
      'idempotency replay/IDEMPOTENCY_KEY_REUSED/concurrent slug',
      'lost response, lease expiry, parallel workers, attempt/deadline exhaustion',
      'readiness/isolation failure ห้าม ACTIVE; ACTIVE atomic',
      'Safe compensate เฉพาะ resource ที่พิสูจน์ ownership; FAILED_FINAL เก็บ ledger/tombstone',
      'Tenant A↔B RLS บนตาราง baseline; platform role อ่าน business data ไม่ได้',
      'append-only audit + COMMAND_REPLAYED',
    ],
    gates: [
      'idempotency',
      'no-duplicate-resource',
      'no-premature-active',
      'isolation',
      'complete-audit',
    ],
  },
  {
    id: 'A1-F-PLATFORM-API-TOKENS',
    profile: 'fast',
    dimension: 'authorization',
    command: tsx('@d-contact/platform-api', 'test'),
    parser: 'tap',
    proves: ['operator/auditor/tenant-only/mixed/wrong audience/expired/forged token matrix'],
    gates: ['isolation', 'no-secret-leakage'],
  },
  {
    id: 'A1-F-PLATFORM-API',
    profile: 'fast',
    dimension: 'tenant-isolation',
    command: tsx('@d-contact/platform-api', 'test:integration'),
    parser: 'tap',
    proves: [
      'auditor mutation ถูกปฏิเสธ; tenant/mixed token 401 ทุก endpoint',
      'generic 404 สำหรับ foreign/missing resource',
      'duplicate idempotency, stale revision, target swap, concurrent recovery',
      'dependency failure หลังรับคำขอไม่คืน 503 หลอก',
    ],
    gates: ['isolation', 'idempotency', 'no-secret-leakage'],
  },
  {
    id: 'A1-F-TENANT-LIFECYCLE',
    profile: 'fast',
    dimension: 'tenant-isolation',
    command: tsx('@d-contact/workspace-session', 'test'),
    parser: 'tap',
    proves: [
      'tenant PROVISIONING เข้า workspace session ไม่ได้',
      'platform token ใช้กับ tenant boundary ไม่ได้',
    ],
    gates: ['isolation', 'no-premature-active'],
  },
  {
    id: 'A1-F-TENANT-GATEWAY',
    profile: 'fast',
    dimension: 'tenant-isolation',
    command: [
      pnpm,
      '--filter',
      '@d-contact/api',
      'exec',
      'tsx',
      '--test',
      'src/gateway-auth.test.ts',
    ],
    parser: 'tap',
    proves: ['tenant PROVISIONING เข้า tenant API ไม่ได้ (workspace + service identity)'],
    gates: ['isolation', 'no-premature-active'],
  },
  {
    id: 'A1-F-CONSOLE',
    profile: 'fast',
    dimension: 'ux',
    command: tsx('@d-contact/platform-console', 'test'),
    parser: 'tap',
    proves: ['route ไม่มี PII; OIDC callback ไม่ทิ้ง code/state'],
    gates: ['no-secret-leakage'],
  },
  {
    id: 'A1-F-CONSOLE-E2E',
    profile: 'fast',
    dimension: 'ux',
    command: tsx('@d-contact/platform-console', 'test:e2e'),
    parser: 'playwright',
    proves: [
      'Guided onboarding, validation, conflict, ACTION_REQUIRED, stale revision, auditor read-only, axe',
    ],
    gates: ['no-secret-leakage'],
  },
  {
    id: 'A1-F-KEYCLOAK-EXTENSION',
    profile: 'fast',
    dimension: 'authorization',
    command: ['bash', 'scripts/keycloak-extensions-build.sh'],
    parser: 'exit',
    proves: ['invitation guard compile เทียบ Keycloak runtime ที่ pin ไว้'],
    gates: [],
  },
  {
    id: 'A1-R-AUTH',
    profile: 'real-boundary',
    dimension: 'authorization',
    command: tsx('@d-contact/platform-api', 'test:boundary'),
    parser: 'tap',
    proves: ['platform-console client/audience/role mapping และ password+TOTP กับ Keycloak จริง'],
    gates: ['isolation'],
  },
  {
    id: 'A1-R-PROVISIONING',
    profile: 'real-boundary',
    dimension: 'recovery',
    command: tsx('@d-contact/platform-control', 'test:boundary'),
    parser: 'tap',
    proves: [
      'happy path ถึง ACTIVE, replay ไม่มี Postgres/Keycloak/outbox duplicate',
      'ambiguous Keycloak outcome → reconcile/adopt/resume; ambiguous invitation ห้าม blind resend',
      'invitation รุ่นเก่าใช้ไม่ได้ (#436); first admin login ผ่าน tenant boundary',
    ],
    gates: ['idempotency', 'no-duplicate-resource', 'no-premature-active', 'isolation'],
  },
]);

// ── Result parsing ──────────────────────────────────────────────────────────

/** node:test (TAP): ต้องมี pass > 0 และ fail/skipped/todo/cancelled เป็นศูนย์ทุกบล็อกสรุป */
export function parseTap(output) {
  const counters = { pass: 0, fail: 0, skipped: 0, todo: 0, cancelled: 0 };
  let summaries = 0;
  for (const match of String(output).matchAll(/^# (pass|fail|skipped|todo|cancelled) (\d+)$/gm)) {
    counters[match[1]] += Number(match[2]);
    if (match[1] === 'pass') summaries += 1;
  }
  const status =
    summaries === 0
      ? 'UNKNOWN'
      : counters.fail + counters.cancelled > 0
        ? 'FAIL'
        : counters.skipped + counters.todo > 0
          ? 'SKIPPED'
          : counters.pass > 0
            ? 'PASS'
            : 'UNKNOWN';
  return { status, counters };
}

/** Playwright line/list reporter: "N passed" และห้ามมี failed/flaky/skipped */
export function parsePlaywright(output) {
  const text = String(output);
  const count = (label) => Number(text.match(new RegExp(`(\\d+) ${label}`))?.[1] ?? 0);
  const counters = {
    pass: count('passed'),
    fail: count('failed'),
    flaky: count('flaky'),
    skipped: count('skipped'),
  };
  const status =
    counters.fail > 0
      ? 'FAIL'
      : counters.flaky + counters.skipped > 0
        ? 'SKIPPED'
        : counters.pass > 0
          ? 'PASS'
          : 'UNKNOWN';
  return { status, counters };
}

export function judge(check, exitCode, output) {
  const parsed =
    check.parser === 'tap'
      ? parseTap(output)
      : check.parser === 'playwright'
        ? parsePlaywright(output)
        : { status: exitCode === 0 ? 'PASS' : 'FAIL', counters: {} };
  // exit code ที่ไม่ใช่ศูนย์ชนะเสมอ แม้ summary จะดูผ่าน
  const status = exitCode !== 0 && parsed.status === 'PASS' ? 'FAIL' : parsed.status;
  return { status, counters: parsed.counters };
}

// ── Evidence ────────────────────────────────────────────────────────────────

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/** log ของ check ที่ล้ม: ตัด token/email/connection string/URL ที่มี query ก่อนเก็บ (#393 checkpoint 2) */
export function redactLog(text) {
  return String(text)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted-email]')
    .replace(/(postgres(?:ql)?|redis|https?):\/\/[^\s/@]+:[^\s/@]+@/gi, '$1://[redacted]@')
    .replace(/(action-token\?key=|[?&](?:code|state|key|token)=)[^\s&"']+/gi, '$1[redacted]');
}

function listFiles(path) {
  const absolute = resolve(repositoryRoot, path);
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(join(path, entry.name)) : [resolve(absolute, entry.name)],
  );
}

/** digest ของ config ที่ acceptance ยืนอยู่ — migration, RLS, Keycloak setup และ extension source */
export function configDigest() {
  const inputs = [
    'packages/db/prisma/migrations',
    'packages/db/prisma/rls.sql',
    'scripts/keycloak-platform-setup.mjs',
    'scripts/keycloak-provisioning-setup.mjs',
    'infra/keycloak/extensions/invitation-guard/src',
  ]
    .flatMap(listFiles)
    .sort()
    .map((file) => `${relative(repositoryRoot, file)}:${sha256Hex(readFileSync(file))}`);
  return sha256Hex(inputs.join('\n'));
}

function git(...args) {
  const result = spawnSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

/** image digest ของ dependency จริง (real-boundary เท่านั้น) — pinned version เป็นส่วนหนึ่งของหลักฐาน */
function imageDigests() {
  const digests = {};
  for (const image of [
    'quay.io/keycloak/keycloak:26.0.0',
    'postgres:16-alpine',
    'axllent/mailpit:v1.20',
  ]) {
    const result = spawnSync(
      'docker',
      ['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image],
      {
        encoding: 'utf8',
      },
    );
    digests[image] = result.status === 0 ? result.stdout.trim() : null;
  }
  return digests;
}

// ── Runner ──────────────────────────────────────────────────────────────────

export function runA1Acceptance({
  profile = 'fast',
  only = null,
  runId = randomUUID(),
  execute = spawnSync,
} = {}) {
  const selected = A1_CHECKS.filter(
    (check) =>
      (profile === 'all' || check.profile === profile) && (!only || only.includes(check.id)),
  );
  if (selected.length === 0) throw new TypeError(`ไม่มี check ใน profile ${profile}`);
  const outputDirectory = resolve(repositoryRoot, 'artifacts/a1', runId);
  mkdirSync(outputDirectory, { recursive: true });

  const results = [];
  const artifacts = [];
  for (const check of selected) {
    const startedAt = Date.now();
    const result = execute(check.command[0], check.command.slice(1), {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 256 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    const verdict = judge(check, result.status ?? 1, output);
    const entry = {
      checkId: check.id,
      dimension: check.dimension,
      status: verdict.status,
      durationMs: Date.now() - startedAt,
      counters: verdict.counters,
      proves: check.proves,
      gates: check.gates,
    };
    if (verdict.status !== 'PASS') {
      // log เต็มเฉพาะ check ที่ล้ม (เก็บ 30 วันใน CI) — ผ่าน redaction ก่อน
      const path = join(outputDirectory, `${check.id}.log`);
      const body = redactLog(output);
      writeFileSync(path, body);
      // ชื่อไฟล์เท่านั้น: directory คือ artifacts/a1/<run.id>/ (path เต็มมี run id ที่ scanner อาจเข้าใจผิด)
      artifacts.push({ checkId: check.id, file: `${check.id}.log`, sha256: sha256Hex(body) });
    }
    results.push(entry);
    process.stdout.write(
      `${JSON.stringify({ type: 'a1.acceptance.check', ...entry, proves: undefined })}\n`,
    );
  }

  const gateStatus = Object.fromEntries(
    NON_WAIVABLE_GATES.map((gate) => {
      const covering = results.filter((entry) => entry.gates.includes(gate));
      return [
        gate,
        covering.length === 0
          ? profile === 'fast' || profile === 'all'
            ? 'UNCOVERED'
            : 'NOT_IN_PROFILE'
          : covering.every((entry) => entry.status === 'PASS')
            ? 'PASS'
            : 'FAIL',
      ];
    }),
  );
  const passed =
    results.every((entry) => entry.status === 'PASS') &&
    Object.values(gateStatus).every((status) => status === 'PASS' || status === 'NOT_IN_PROFILE');

  const manifest = {
    schemaVersion: A1_MANIFEST_SCHEMA,
    workflow: A1_WORKFLOW,
    run: {
      id: runId,
      profile,
      startedFrom: process.env.GITHUB_RUN_ID ? 'github-actions' : 'local',
    },
    source: {
      commitSha: git('rev-parse', 'HEAD'),
      // ไฟล์ใหม่ที่ยังไม่ commit ก็ทำให้ SHA ไม่ครอบโค้ดที่ทดสอบ — ยกเว้นผลของ acceptance เอง
      dirty: (git('status', '--porcelain') ?? '')
        .split('\n')
        .some((line) => line.trim() && !line.slice(3).startsWith('artifacts/')),
      config: { sha256: configDigest() },
    },
    environment: {
      node: process.version,
      platform: process.platform,
      ...(profile !== 'fast' ? { images: imageDigests() } : {}),
    },
    status: passed ? 'PASS' : 'FAIL',
    nonWaivable: gateStatus,
    checks: results,
    artifacts,
    contextPointers: ['#385', '#388', '#393', '#413'],
  };
  // manifest ต้องไม่มี PII/secret ก่อนเขียน (fail เมื่อพบ)
  assertPiiSafeEvidence(manifest);
  const manifestPath = join(outputDirectory, 'acceptance-manifest.json');
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, body);
  process.stdout.write(
    `${JSON.stringify({
      type: 'a1.acceptance.summary',
      status: manifest.status,
      profile,
      manifest: relative(repositoryRoot, manifestPath),
      sha256: sha256Hex(body),
      nonWaivable: gateStatus,
    })}\n`,
  );
  return manifest;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const argument = (name) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : undefined;
  };
  try {
    const manifest = runA1Acceptance({
      profile: argument('profile') ?? 'fast',
      only: argument('only')?.split(',') ?? null,
      ...(process.env.GITHUB_RUN_ID
        ? { runId: `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? 1}` }
        : {}),
    });
    if (manifest.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
