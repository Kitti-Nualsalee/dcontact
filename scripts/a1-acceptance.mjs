import { randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPiiSafeEvidence } from './cxa-c1-readiness.mjs';

/**
 * A1.8 (#413): acceptance for Platform Admin Tenant Provisioning per #393
 *
 * - profile `fast` (PR gate, 2-4 minutes): unit/contract/state machine, replay/recovery matrix with fake
 *   adapters, adversarial isolation matrix on real Postgres, locally signed token fixtures, Console
 * - profile `real-boundary` (8-12 minutes): real Postgres + Keycloak (with invitation guard) + email sink
 * - a check that is skipped/todo/has no result/has an unreadable result = FAIL (#413: fail on skip/waiver/unknown result)
 * - `acceptance-manifest.json` binds the commit SHA + config digest (+ image digest for real-boundary);
 *   full logs are kept only for failed checks and pass redaction + PII scan before being written (#393 checkpoint 2)
 */
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const A1_WORKFLOW = Object.freeze({
  name: 'a1-platform-provisioning-acceptance',
  version: 1,
});
export const A1_MANIFEST_SCHEMA = 1;

/** Mandatory gates that must not be waived (#393/#413) - every gate needs at least one check in the profile that runs */
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
 * each check = one command + the #393 items it proves (`proves`) + the non-waivable gates (`gates`)
 * `parser` says how to read the result: `tap` (node:test) or `playwright`
 */
export const A1_CHECKS = Object.freeze([
  {
    id: 'A1-F-CONTRACT',
    profile: 'fast',
    dimension: 'contract',
    command: tsx('@d-contact/platform-control', 'test'),
    parser: 'tap',
    proves: [
      'input canonicalization',
      'error envelope of the Keycloak client',
      'deterministic ids',
    ],
    gates: ['no-secret-leakage'],
  },
  {
    id: 'A1-F-SCHEMA-REGISTRY',
    profile: 'fast',
    dimension: 'migration',
    command: ['node', '--test', 'scripts/a1-schema-readiness.test.mjs'],
    parser: 'tap',
    proves: [
      'expand-only',
      'append-only ledger has no UPDATE/DELETE privilege',
      'role/policy registry',
    ],
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
      'readiness/isolation failure must never reach ACTIVE; ACTIVE is atomic',
      'Safe compensation only for resources with proven ownership; FAILED_FINAL keeps ledger/tombstone',
      'Tenant A<->B RLS on baseline tables; platform role cannot read business data',
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
      'auditor mutation is rejected; tenant/mixed token gets 401 on every endpoint',
      'generic 404 for foreign/missing resource',
      'duplicate idempotency, stale revision, target swap, concurrent recovery',
      'dependency failure after the request is accepted never returns a false 503',
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
      'tenant PROVISIONING cannot enter a workspace session',
      'platform token cannot be used at the tenant boundary',
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
    proves: ['tenant PROVISIONING cannot enter the tenant API (workspace + service identity)'],
    gates: ['isolation', 'no-premature-active'],
  },
  {
    id: 'A1-F-CONSOLE',
    profile: 'fast',
    dimension: 'ux',
    command: tsx('@d-contact/platform-console', 'test'),
    parser: 'tap',
    proves: ['route has no PII; OIDC callback does not leak code/state'],
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
    proves: ['invitation guard compiles against the pinned Keycloak runtime'],
    gates: [],
  },
  {
    id: 'A1-R-AUTH',
    profile: 'real-boundary',
    dimension: 'authorization',
    command: tsx('@d-contact/platform-api', 'test:boundary'),
    parser: 'tap',
    proves: [
      'platform-console client/audience/role mapping and password+TOTP against real Keycloak',
    ],
    gates: ['isolation'],
  },
  {
    id: 'A1-R-PROVISIONING',
    profile: 'real-boundary',
    dimension: 'recovery',
    command: tsx('@d-contact/platform-control', 'test:boundary'),
    parser: 'tap',
    proves: [
      'happy path reaches ACTIVE, replay creates no Postgres/Keycloak/outbox duplicate',
      'ambiguous Keycloak outcome -> reconcile/adopt/resume; ambiguous invitation must not blind resend',
      'old-generation invitation is unusable (#436); first admin login passes the tenant boundary',
    ],
    gates: ['idempotency', 'no-duplicate-resource', 'no-premature-active', 'isolation'],
  },
]);

// ── Result parsing ──────────────────────────────────────────────────────────

/** node:test (TAP): needs pass > 0 and zero fail/skipped/todo/cancelled in every summary block */
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

/** Playwright line/list reporter: "N passed" and no failed/flaky/skipped allowed */
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
  // a non-zero exit code always wins, even when the summary looks like a pass
  const status = exitCode !== 0 && parsed.status === 'PASS' ? 'FAIL' : parsed.status;
  return { status, counters: parsed.counters };
}

// ── Evidence ────────────────────────────────────────────────────────────────

const sha256Hex = (value) => createHash('sha256').update(value).digest('hex');

/** log of a failed check: strip tokens/emails/connection strings/URLs with a query before keeping it (#393 checkpoint 2) */
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

/** digest of the config the acceptance run stands on - migration, RLS, Keycloak setup and extension source */
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

/** Bind the digest to the container Compose actually runs; an image pulled by digest may have no bare-tag alias */
export function collectA1ImageDigests(execute = spawnSync) {
  const digests = {};
  const docker = (arguments_) => {
    const result = execute('docker', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  for (const service of ['keycloak', 'postgres', 'mailpit']) {
    const container = docker([
      'compose',
      '-f',
      'infra/docker/docker-compose.dev.yml',
      'ps',
      '-q',
      service,
    ]);
    const image = container ? docker(['inspect', '--format', '{{.Image}}', container]) : null;
    const digest = image
      ? docker(['image', 'inspect', '--format', '{{index .RepoDigests 0}}', image])
      : null;
    // never guess a digest from config, and never treat a missing/empty inspect as passing evidence
    digests[service] = digest || null;
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
  if (selected.length === 0) throw new TypeError(`no check in profile ${profile}`);
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
      // full log only for failed checks (kept 30 days in CI) - redacted first
      const path = join(outputDirectory, `${check.id}.log`);
      const body = redactLog(output);
      writeFileSync(path, body);
      // file name only: the directory is artifacts/a1/<run.id>/ (the full path contains a run id the scanner could misread)
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
      // a new uncommitted file also makes the SHA not cover the tested code - except the acceptance output itself
      dirty: (git('status', '--porcelain') ?? '')
        .split('\n')
        .some((line) => line.trim() && !line.slice(3).startsWith('artifacts/')),
      config: { sha256: configDigest() },
    },
    environment: {
      node: process.version,
      platform: process.platform,
      ...(profile !== 'fast' ? { images: collectA1ImageDigests() } : {}),
    },
    status: passed ? 'PASS' : 'FAIL',
    nonWaivable: gateStatus,
    checks: results,
    artifacts,
    contextPointers: ['#385', '#388', '#393', '#413'],
  };
  // the manifest must contain no PII/secret before it is written (fail when found)
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
