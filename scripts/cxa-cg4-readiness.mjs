import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sanitizeDiagnostic } from './phase-zero-readiness.mjs';
import { assertPiiSafeEvidence, sha256 } from './cxa-c1-readiness.mjs';
import { CG4_FIXED_FLAGS, CG4_OWNER_PROFILES } from './cxa-cg4-profile-readiness.mjs';
import { CG3_MARKER, S1_REGRESSION_SCRIPTS } from './cxa-cg4-dependency-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export { assertPiiSafeEvidence, sha256, CG4_FIXED_FLAGS };

export const CG4_MARKER = 'CONTACT_GOVERNANCE_CG4_ACCEPTED';
export const CG3_BASELINE_SHA = 'b634dc738e4e1544e06711d165e58cfe453c68e2';
export const CG4_WORKFLOW = Object.freeze({ name: 'cxa-cg4-acceptance', version: 2 });
export const CG4_CONTEXT_POINTERS = Object.freeze([
  '#172',
  '#174',
  '#177',
  '#173',
  '#176',
  '#179',
  '#180',
  '#178',
  '#183',
]);
export const CG4_VERSIONS = Object.freeze({
  cg4Contract: 1,
  policySchema: 1,
  ruleRegistry: 'CG4_RULE_REGISTRY_V1',
  evaluator: 'CG4_EVALUATOR_V1',
  kafkaEnvelope: 2,
  fixturePack: 'TENANT_SYNTHETIC_V1',
  manifestSchema: 1,
});

/** 9 มิติของ #178: ทุกมิติต้องมีอย่างน้อยหนึ่ง check */
export const CG4_DIMENSIONS = Object.freeze([
  'functional',
  'tenant-isolation',
  'authorization',
  'idempotency',
  'concurrency',
  'recovery',
  'migration',
  'observability',
  'regression',
]);

/**
 * หน่วยของ suite คือ "ไฟล์เทสต์หนึ่งไฟล์" (หรือหนึ่ง package script) เพื่อให้ runner รันแต่ละไฟล์ครั้งเดียว
 * แม้หลาย check จะใช้ไฟล์เดียวกันเป็นหลักฐาน — check แต่ละ ID ยังอ้าง suite ของตัวเองแยกตรวจได้
 */
const testFiles =
  (filter) =>
  (...files) =>
    files.map((file) => [
      pnpm,
      '--filter',
      filter,
      'exec',
      'tsx',
      '--test',
      '--test-concurrency=1',
      `src/${file}`,
    ]);
const governance = testFiles('@d-contact/contact-governance');
const api = testFiles('@d-contact/api');
const journey = testFiles('@d-contact/journey');
const dialer = testFiles('@d-contact/dialer');
const contracts = testFiles('@d-contact/cxa-contracts');
const dbRls = [pnpm, '--filter', '@d-contact/db', 'test:integration'];
const cg4Api = api('contact-governance-cg4-api.integration.ts');

function check(id, dimension, dependency, boundaries, commands, extra = {}) {
  return {
    id,
    dimension,
    dependency,
    boundaries,
    commands,
    remediation: `แก้ ${id} ตาม #178`,
    ...extra,
  };
}

/** ทุก suite เป็น owner implementation จริงบน Postgres/Redpanda — in-memory fake ใช้เฉพาะ unit/conformance */
export const CXA_CG4_READINESS_CHECKS = Object.freeze([
  check(
    'CG4-F01',
    'functional',
    'closed rule taxonomy และ canonical precedence',
    [
      'closed rule registry',
      'provisional operational rule only',
      'final ALLOW after reservation gate',
    ],
    [
      ...contracts('contact-governance-cg4.test.ts'),
      ...governance('cg4-rule-registry.test.ts', 'cg4-exception-evaluation.test.ts'),
      ...governance('cg4-exception-authorize.integration.ts'),
    ],
  ),
  check(
    'CG4-F02',
    'functional',
    'exception exact scope, immutable revision และ lifecycle',
    [
      'immutable revision',
      'PENDING→APPROVED|REJECTED|CANCELLED',
      'renewal-as-new-series',
      'exclusive expiry',
    ],
    [
      ...governance('cg4-exception-evaluation.test.ts'),
      ...governance(
        'cg4-foundation-repository.integration.ts',
        'cg4-exception-authorize.integration.ts',
        'cg4-events-runtime.integration.ts',
      ),
    ],
  ),
  check(
    'CG4-F03',
    'functional',
    'risk tier/quorum, direct Compliance seat และ emergency',
    ['STANDARD|HIGH|EMERGENCY quorum', 'direct Compliance seat', 'current-scope re-authorization'],
    governance('cg4-authorization-engine.test.ts', 'cg4-authorization-repository.integration.ts'),
  ),
  check(
    'CG4-F04',
    'functional',
    'policy lifecycle, deterministic preview/diff/tests และ publish',
    [
      'deterministic preview/diff/tests',
      'approval binding',
      'immediate/scheduled publish',
      'one active head per scope',
    ],
    governance(
      'cg4-policy-compiler.test.ts',
      'cg4-policy-diff.test.ts',
      'cg4-policy-preview.test.ts',
      'cg4-policy-resolution.test.ts',
      'cg4-policy-lifecycle.integration.ts',
    ),
  ),
  check(
    'CG4-F05',
    'functional',
    'rollback-as-new-version และ scoped kill switch',
    [
      'monotonic rollback version',
      'kill switch tightening only',
      'clear needs publish-grade approval',
    ],
    [
      ...governance(
        'cg4-policy-lifecycle.integration.ts',
        'cg4-exception-authorize.integration.ts',
      ),
      ...cg4Api,
    ],
  ),
  check(
    'CG4-UX01',
    'functional',
    'Hybrid Governance Console (#180)',
    [
      'Exceptions=A Policies=B Audit=C',
      'Approve ≠ ALLOW ≠ Activate',
      'keyboard/focus/screen reader',
      'no console error',
    ],
    [
      [pnpm, '--filter', '@d-contact/console', 'exec', 'tsx', '--test', 'src/governance.test.ts'],
      [pnpm, '--filter', '@d-contact/console', 'build'],
      [
        pnpm,
        '--filter',
        '@d-contact/console',
        'exec',
        'playwright',
        'test',
        'e2e/governance.spec.ts',
      ],
    ],
  ),
  check(
    'CG4-TI01',
    'tenant-isolation',
    'two-tenant fixture และ generic not-found',
    ['two tenant fixture', 'ID swap generic not-found', 'RLS owner transaction'],
    [...cg4Api, ...governance('cg4-foundation-repository.integration.ts'), dbRls],
  ),
  check(
    'CG4-TI02',
    'tenant-isolation',
    'reused IDs ข้าม tenant ใน cache/head/receipt/event/inbox/ack',
    ['tenant-bound cache key', 'wrong-tenant event quarantine', 'no existence disclosure'],
    governance(
      'cg4-cache.test.ts',
      'cg4-inbox.test.ts',
      'cg4-consumer-inbox.integration.ts',
      'cg4-events-runtime.integration.ts',
      'cg4-observability.integration.ts',
    ),
  ),
  check(
    'CG4-AU01',
    'authorization',
    'trusted context + exact capability ทุก command',
    [
      'exact capability per command',
      'gateway role coarse guard only',
      'quorum finalization re-authorization',
    ],
    [
      ...governance('cg4-authorization-engine.test.ts'),
      ...cg4Api,
      ...governance('cg4-policy-lifecycle.integration.ts'),
    ],
  ),
  check(
    'CG4-AU02',
    'authorization',
    'self/shared/service approval, delegation และ stale epoch',
    [
      'self approval rejected',
      'delegation boundary',
      'stale epoch/scope rejected',
      'evidence access audited',
    ],
    [
      ...governance(
        'cg4-authorization-engine.test.ts',
        'cg4-redaction.test.ts',
        'cg4-authorization-repository.integration.ts',
      ),
      ...cg4Api,
    ],
  ),
  check(
    'CG4-ID01',
    'idempotency',
    'Idempotency-Key + canonical request hash',
    [
      'same key same hash canonical result',
      'same key different hash IDEMPOTENCY_CONFLICT',
      'no duplicate effect',
    ],
    [
      ...cg4Api,
      ...governance(
        'cg4-policy-lifecycle.integration.ts',
        'cg4-foundation-repository.integration.ts',
      ),
    ],
  ),
  check(
    'CG4-ID02',
    'idempotency',
    'outbox/inbox/job/ack identity ใน retry/replay/reconcile',
    ['event identity stable', 'duplicate no-op', 'no duplicate head swap or ack'],
    [
      ...governance(
        'cg4-inbox.test.ts',
        'cg4-consumer-inbox.integration.ts',
        'cg4-events-runtime.integration.ts',
      ),
      ...journey('journey-governance-cg4.integration.ts'),
    ],
  ),
  check(
    'CG4-CC01',
    'concurrency',
    'approve/reject/cancel race ด้วย CAS',
    ['distinct checker counted once', 'first terminal commit wins'],
    governance(
      'cg4-authorization-engine.test.ts',
      'cg4-authorization-repository.integration.ts',
      'cg4-exception-authorize.integration.ts',
    ),
  ),
  check(
    'CG4-CC02',
    'concurrency',
    'authorizeAndReserve แข่งกับ revoke/expiry/permission change',
    ['commit order at database-time boundary', 'no reservation after restrictive commit'],
    governance('cg4-exception-authorize.integration.ts'),
  ),
  check(
    'CG4-CC03',
    'concurrency',
    'publish/rollback/kill/evaluate แข่งกันด้วย scope lock/head CAS',
    ['scope lock', 'head CAS', 'no partial head visible'],
    governance('cg4-policy-lifecycle.integration.ts', 'cg4-events-runtime.integration.ts'),
  ),
  check(
    'CG4-CC04',
    'concurrency',
    'overlap/equal-specificity/multiple schedule conflict',
    ['no latest-time winner', 'equal specificity fail closed', 'single scheduled candidate'],
    governance(
      'cg4-policy-resolution.test.ts',
      'cg4-exception-authorize.integration.ts',
      'cg4-policy-lifecycle.integration.ts',
      'cg4-legacy-backfill.integration.ts',
    ),
  ),
  check(
    'CG4-RC01',
    'recovery',
    'fault injection รอบ canonical revision/head/approval/audit/receipt/outbox',
    ['atomic commit', 'restart/retry without loss or duplicate', 'migration switch boundary'],
    governance('cg4-foundation-repository.integration.ts', 'cg4-rollout-switch.integration.ts'),
  ),
  check(
    'CG4-RC02',
    'recovery',
    'duplicate/gap/out-of-order/hash mismatch/unknown contract/DLQ',
    ['pause exact scope', 'canonical reload then ack', 'no blind retry', 'no automatic relaxation'],
    [
      ...governance('cg4-consumer-inbox.integration.ts'),
      ...journey('journey-governance-cg4.integration.ts'),
      ...dialer('dialer-governance-cg4.integration.ts'),
      [pnpm, '--filter', '@d-contact/kafka', 'test:integration'],
    ],
  ),
  check(
    'CG4-RC03',
    'recovery',
    'cache/registry/canonical unavailable และ activation/expiry ล่าช้า fail closed',
    ['stale head fail closed', 'due activation fail closed', 'no fallback policy/exception'],
    governance(
      'cg4-cache.test.ts',
      'cg4-policy-resolution.test.ts',
      'cg4-events-runtime.integration.ts',
      'cg4-rollout-switch.integration.ts',
    ),
  ),
  check(
    'CG4-MG01',
    'migration',
    `fresh + upgrade จาก CG3 baseline ${CG3_BASELINE_SHA}`,
    ['fresh migration', 'upgrade from final CG3 baseline', 'RLS/grants/immutable history'],
    [...governance('cg4-upgrade-drill.integration.ts'), dbRls],
  ),
  check(
    'CG4-MG02',
    'migration',
    'expand→backfill→reconcile→shadow→seed→switch→enforce→contract',
    [
      'PII-safe shadow digest',
      'legacy publish alias single validation',
      'pre-mutation disable path',
      'forward-fix without down-migrate',
    ],
    [
      ...governance(
        'cg4-rollout.test.ts',
        'cg4-legacy-backfill.integration.ts',
        'cg4-rollout-switch.integration.ts',
      ),
      ...api('contact-governance-api.integration.ts'),
      ...cg4Api,
    ],
  ),
  check(
    'CG4-OB01',
    'observability',
    'decision trace pins และ metrics/alerts ตาม #179 §7',
    [
      'pinned policy/exception digests',
      'quorum age/activation lag/ack lag/DLQ alerts',
      'kill and migration mismatch alerts',
    ],
    [
      ...governance(
        'cg4-observability.test.ts',
        'cg4-event-envelope.test.ts',
        'cg4-observability.integration.ts',
        'cg4-exception-authorize.integration.ts',
      ),
      ...cg4Api,
    ],
  ),
  check(
    'CG4-OB02',
    'observability',
    'negative scan ของ event/log/metric/URL/evidence',
    [
      'no raw contact identity',
      'no actor name/email',
      'no free-text evidence',
      'role-based redaction audited',
    ],
    [
      ...governance(
        'cg4-redaction.test.ts',
        'cg4-event-envelope.test.ts',
        'cg4-observability.integration.ts',
      ),
      ...cg4Api,
    ],
  ),
  check(
    'CG4-REG01',
    'regression',
    'root build/typecheck/lint, E0, C1, Inbound Voice และ S1 บน SHA เดียวกัน',
    [
      'root build/typecheck/lint via S1-REG-01',
      'E0/C1/Inbound Voice acceptance via S1-REG-01',
      `${CG3_MARKER} same SHA`,
    ],
    // S1-REG-01 รัน build/typecheck/lint/E0/C1/Inbound Voice อยู่แล้ว: รัน S1 ครั้งเดียวแล้วพิสูจน์จาก
    // S1 manifest บน SHA เดียวกันแทนการรันซ้ำสองรอบ (#194 A)
    [
      [pnpm, 's1:acceptance'],
      [process.execPath, 'scripts/cxa-cg4-dependency-readiness.mjs'],
    ],
    { evidencePrefix: 'CXA_CG4_DEPENDENCY_EVIDENCE:' },
  ),
  check(
    'CG4-REG02',
    'regression',
    'J2 merged paths ใช้ final Governance result ผ่าน stable owner port',
    [
      'J2 targeted conformance',
      'no reservation from internal actions',
      'Journey sees no approval internals',
      'owner profiles and fixed flags',
    ],
    [
      ...contracts('contact-governance-downstream.test.ts'),
      ...journey('journey-governance-cg4.integration.ts'),
      ...dialer('dialer-governance-cg4.integration.ts'),
      [pnpm, '--filter', '@d-contact/journey', 'test'],
      [pnpm, '--filter', '@d-contact/dialer', 'test'],
      [process.execPath, 'scripts/cxa-cg4-profile-readiness.mjs'],
    ],
    { evidencePrefix: 'CXA_CG4_PROFILE_EVIDENCE:' },
  ),
]);

// ── Suite plan / execution ───────────────────────────────────────────────────

const suiteKey = (command) => JSON.stringify(command);

/** รวมคำสั่งที่ซ้ำกันข้าม check ให้เหลือ suite เดียวต่อไฟล์/สคริปต์ ตามลำดับที่ปรากฏครั้งแรก */
export function cg4SuitePlan(checks = CXA_CG4_READINESS_CHECKS) {
  const suites = new Map();
  for (const item of checks) {
    for (const command of item.commands) {
      const key = suiteKey(command);
      const existing = suites.get(key);
      if (existing) {
        if (!existing.checkIds.includes(item.id)) existing.checkIds.push(item.id);
        existing.evidencePrefix ??= item.evidencePrefix;
        continue;
      }
      suites.set(key, {
        id: `suite:${String(suites.size + 1).padStart(2, '0')}`,
        command,
        checkIds: [item.id],
        ...(item.evidencePrefix ? { evidencePrefix: item.evidencePrefix } : {}),
      });
    }
  }
  return [...suites.values()];
}

/**
 * สรุป TAP ของ node test runner (รวมหลาย summary ได้ เช่น package ที่ build ก่อน test) —
 * คืน null เมื่อ output ไม่ใช่ TAP (เช่น build หรือ Playwright) ซึ่งตัดสินจาก exit code อย่างเดียว
 */
export function parseTapSummary(output) {
  const total = (name) => {
    const matches = [...String(output).matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))];
    return matches.length === 0
      ? undefined
      : matches.reduce((sum, match) => sum + Number(match[1]), 0);
  };
  const tests = total('tests');
  if (tests === undefined) return null;
  const titles = [...String(output).matchAll(/^(?:not )?ok \d+ - (.+)$/gm)]
    .map((match) => match[1].trim())
    .sort();
  return {
    tests,
    passed: total('pass') ?? 0,
    failed: total('fail') ?? 0,
    cancelled: total('cancelled') ?? 0,
    skipped: total('skipped') ?? 0,
    todo: total('todo') ?? 0,
    titlesSha256: sha256(titles),
  };
}

const PII_VALUE_PATTERNS = [
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]'],
  [/(?:\+?66|0)\d{8,9}\b/g, '[REDACTED_PHONE]'],
];

/** detail ของ suite ที่ล้มเก็บเฉพาะบรรทัดล้มเหลวที่ redact แล้ว เพื่อไม่ให้ manifest ทั้งไฟล์ใช้ไม่ได้เพราะ PII */
export function cg4FailureDetail(output, fallback) {
  const lines = sanitizeDiagnostic(output)
    .split('\n')
    .filter((line) =>
      /^\s*not ok |error:|Error\b|expected:|actual:|ERR_|failureType|signal:/.test(line),
    )
    .slice(0, 60);
  let detail = lines.length > 0 ? lines.join('\n') : fallback;
  for (const [pattern, replacement] of PII_VALUE_PATTERNS) {
    detail = detail.replaceAll(pattern, replacement);
  }
  return detail.length > 4_000 ? `${detail.slice(0, 4_000)}\n... truncated ...` : detail;
}

function structuredEvidence(output, prefix) {
  if (!prefix) return [];
  return sanitizeDiagnostic(output)
    .split('\n')
    .flatMap((line) => {
      const marker = line.indexOf(prefix);
      if (marker < 0) return [];
      try {
        return [JSON.parse(line.slice(marker + prefix.length))];
      } catch {
        return [];
      }
    });
}

export function executeCg4Suite(suite, runner = spawnSync) {
  const started = performance.now();
  const [command, ...arguments_] = suite.command;
  const result = runner(command, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const tap = parseTapSummary(output);
  const exitedCleanly = result.status === 0 && !result.error;
  // #178: ห้าม skip/todo/cancel — suite ที่ exit 0 แต่ข้ามเทสต์ถือว่าไม่ผ่าน
  const tapClean =
    tap === null ||
    (tap.tests > 0 &&
      tap.failed === 0 &&
      tap.cancelled === 0 &&
      tap.skipped === 0 &&
      tap.todo === 0);
  const passed = exitedCleanly && tapClean;
  const evidence = passed ? structuredEvidence(output, suite.evidencePrefix) : [];
  return {
    status: passed ? 'PASS' : 'FAIL',
    durationMs: Math.round(performance.now() - started),
    ...(tap ? { tap } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(passed
      ? {}
      : {
          detail: cg4FailureDetail(
            output,
            result.error?.code ?? `process exited with status ${result.status ?? 'unknown'}`,
          ),
        }),
  };
}

// ── Context ──────────────────────────────────────────────────────────────────

function runGit(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) throw new Error(`git ${arguments_.join(' ')} ล้มเหลว`);
  return String(result.stdout).trim();
}

function repositoryName(environment) {
  if (environment.GITHUB_REPOSITORY) return environment.GITHUB_REPOSITORY;
  const match = runGit(['config', '--get', 'remote.origin.url']).match(
    /(?:github\.com[/:])([^/]+\/[^/.]+)(?:\.git)?$/,
  );
  if (!match) throw new TypeError('ไม่สามารถระบุ repository สำหรับ CG4 manifest');
  return match[1];
}

export function createCg4EvidenceContext(environment = process.env) {
  const repository = repositoryName(environment);
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const finalMainSha = runGit(['rev-parse', 'origin/main']);
  const expectedCommitSha = environment.CXA_CG4_EXPECTED_COMMIT_SHA ?? finalMainSha;
  const ref =
    environment.GITHUB_REF ?? `refs/heads/${runGit(['rev-parse', '--abbrev-ref', 'HEAD'])}`;
  const runId = environment.GITHUB_RUN_ID ?? `local-${randomUUID()}`;
  const attempt = Number(environment.GITHUB_RUN_ATTEMPT ?? 1);
  const runUrl = environment.GITHUB_RUN_ID
    ? `${environment.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${runId}/attempts/${attempt}`
    : null;
  return {
    repository,
    defaultBranch: 'main',
    ref,
    pullRequest: environment.GITHUB_PR_NUMBER ? Number(environment.GITHUB_PR_NUMBER) : null,
    baseSha: environment.CXA_CG4_BASE_SHA ?? runGit(['merge-base', 'HEAD', 'origin/main']),
    commitSha,
    finalMainSha,
    expectedCommitSha,
    cleanTree: runGit(['status', '--porcelain', '--untracked-files=no']) === '',
    runId,
    attempt,
    runUrl,
    artifact: {
      name: `cxa-cg4-evidence-${commitSha}`,
      url: runUrl ? `${runUrl}#artifacts` : null,
      immutable: runUrl !== null,
    },
  };
}

function migrationDigest() {
  const directory = resolve(repositoryRoot, 'packages/db/prisma/migrations');
  const migrations = readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return sha256(
    migrations.map((name) => ({
      name,
      sha256: sha256(readFileSync(resolve(directory, name, 'migration.sql'), 'utf8')),
    })),
  );
}

export function cg4RegistryDigest(checks = CXA_CG4_READINESS_CHECKS) {
  return sha256(
    checks.map(({ id, dimension, boundaries, commands }) => ({
      id,
      dimension,
      boundaries,
      // path ของ node ต่างกันระหว่างเครื่อง: digest ใช้เฉพาะส่วนที่เป็น contract ของคำสั่ง
      commands: commands.map((command) =>
        command[0] === process.execPath ? ['node', ...command.slice(1)] : command,
      ),
    })),
  );
}

// ── Summary / manifest ───────────────────────────────────────────────────────

function evidenceFor(checks, id, type) {
  return checks
    .find((item) => item.id === id)
    ?.subchecks?.flatMap(({ evidence = [] }) => evidence)
    .find((evidence) => evidence?.type === type);
}

const regressionPassed = (dependency) =>
  S1_REGRESSION_SCRIPTS.every((script) => dependency?.s1Regression?.[script] === 'PASS');

export function cg4MarkerBlockers(context, checks) {
  const blockers = [];
  if (
    checks.length !== CXA_CG4_READINESS_CHECKS.length ||
    checks.some((item) => item.status !== 'PASS')
  ) {
    blockers.push('CHECKS_NOT_ALL_PASS');
  }
  if (context.pullRequest !== null) blockers.push('PULL_REQUEST_RUN');
  if (context.ref !== 'refs/heads/main') blockers.push('NOT_DEFAULT_BRANCH_REF');
  if (
    context.commitSha !== context.finalMainSha ||
    context.commitSha !== context.expectedCommitSha
  ) {
    blockers.push('NOT_FINAL_MAIN_SHA');
  }
  if (!context.cleanTree) blockers.push('DIRTY_TREE');
  if (!context.artifact?.immutable || !context.runUrl) blockers.push('ARTIFACT_NOT_IMMUTABLE');
  const dependency = evidenceFor(checks, 'CG4-REG01', 'dependency.readiness');
  if (dependency?.cg3 !== 'INTEGRATED_SAME_SHA' || dependency?.commitSha !== context.commitSha) {
    blockers.push('CG3_MARKER_NOT_SAME_SHA');
  }
  if (!regressionPassed(dependency)) blockers.push('S1_REGRESSION_NOT_PASS');
  const profile = evidenceFor(checks, 'CG4-REG02', 'owner-profile.readiness');
  if (
    !profile ||
    JSON.stringify(profile.profiles) !== JSON.stringify(CG4_OWNER_PROFILES) ||
    JSON.stringify(profile.flags) !== JSON.stringify(CG4_FIXED_FLAGS)
  ) {
    blockers.push('OWNER_PROFILE_OR_FLAGS_MISMATCH');
  }
  return blockers;
}

export function cxaCg4Summary(context, checks, startedAt = new Date()) {
  const blockers = cg4MarkerBlockers(context, checks);
  const allPassed = !blockers.includes('CHECKS_NOT_ALL_PASS');
  const markers = blockers.length === 0 ? [CG4_MARKER] : [];
  return {
    type: 'readiness.summary',
    workflow: CG4_WORKFLOW.name,
    workflowVersion: CG4_WORKFLOW.version,
    status: allPassed ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: checks.filter(({ status }) => status === 'PASS').length,
    failed: checks.filter(({ status }) => status !== 'PASS').length,
    markers,
    markerBlockers: blockers,
    candidateOnly: markers.length === 0,
    entryCondition: markers.length > 0 ? CG4_MARKER : 'NOT_READY',
    evidenceScope:
      'CG4 Development Complete only; releaseEnabled=false and provider traffic disabled',
  };
}

export function createCxaCg4EvidenceManifest(context, checks, summary, suites, digests = {}) {
  const status = (id) => checks.find((item) => item.id === id)?.status ?? 'FAIL';
  const manifest = {
    schemaVersion: 1,
    phase: 'CG4',
    evidenceType: 'development-acceptance',
    ...(summary.markers.length > 0 ? { markers: summary.markers } : {}),
    repository: context.repository,
    defaultBranch: context.defaultBranch,
    baselineSha: CG3_BASELINE_SHA,
    pullRequest: { number: context.pullRequest, baseSha: context.baseSha },
    commitSha: context.commitSha,
    finalMainSha: context.finalMainSha,
    expectedCommitSha: context.expectedCommitSha,
    refProof: {
      ref: context.ref,
      cleanTree: context.cleanTree,
      headEqualsFinalMain: context.commitSha === context.finalMainSha,
    },
    workflow: { ...CG4_WORKFLOW },
    run: { id: context.runId, attempt: context.attempt, url: context.runUrl },
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    artifact: { ...context.artifact },
    contextPointers: [...CG4_CONTEXT_POINTERS],
    versions: { ...CG4_VERSIONS },
    digests: {
      registry: digests.registry ?? cg4RegistryDigest(),
      migrations: digests.migrations ?? migrationDigest(),
    },
    suites: suites.map((suite) => ({
      id: suite.id,
      command: suite.command,
      checkIds: [...suite.checkIds],
      status: suite.status,
      durationMs: suite.durationMs ?? null,
      ...(suite.tap ? { tap: { ...suite.tap } } : {}),
    })),
    checks,
    dimensions: CG4_DIMENSIONS.map((name) => {
      const inDimension = checks.filter((item) => item.dimension === name);
      return {
        name,
        checks: inDimension.length,
        status:
          inDimension.length > 0 && inDimension.every((item) => item.status === 'PASS')
            ? 'PASS'
            : 'FAIL',
      };
    }),
    migration: {
      freshAndUpgrade: status('CG4-MG01'),
      backfillShadowSwitchForwardFix: status('CG4-MG02'),
    },
    recovery: {
      atomicityFaultInjection: status('CG4-RC01'),
      replayReconcileAck: status('CG4-RC02'),
      failClosedUnavailable: status('CG4-RC03'),
    },
    // สำเนาอิสระจาก evidence ใน check: manifest ห้าม alias object ที่ถูก hash ไว้ใน artifact
    ownerProfiles: structuredClone(
      evidenceFor(checks, 'CG4-REG02', 'owner-profile.readiness')?.profiles ?? null,
    ),
    dependencies: structuredClone(evidenceFor(checks, 'CG4-REG01', 'dependency.readiness') ?? null),
    flags: { ...CG4_FIXED_FLAGS },
    negativeScan: { suites: status('CG4-OB02'), manifest: 'PASS' },
    artifacts: checks.map((item) => ({
      id: `check:${item.id}`,
      kind: 'readiness-diagnostic',
      commitSha: context.commitSha,
      sha256: sha256(item),
    })),
  };
  assertValidCxaCg4EvidenceManifest(manifest);
  return manifest;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

export function assertValidCxaCg4EvidenceManifest(manifest) {
  assertPiiSafeEvidence(manifest);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.phase !== 'CG4' ||
    manifest.evidenceType !== 'development-acceptance'
  ) {
    throw new TypeError('CG4 manifest มี schemaVersion/phase/evidenceType ไม่ถูกต้อง');
  }
  for (const field of ['commitSha', 'finalMainSha', 'expectedCommitSha', 'baselineSha']) {
    if (!FULL_SHA.test(manifest[field] ?? ''))
      throw new TypeError(`CG4 manifest ต้องมี ${field} แบบ SHA เต็ม`);
  }
  if (manifest.baselineSha !== CG3_BASELINE_SHA)
    throw new TypeError('CG4 manifest อ้าง CG3 baseline ไม่ถูกต้อง');
  if (JSON.stringify(manifest.flags) !== JSON.stringify(CG4_FIXED_FLAGS)) {
    throw new TypeError('CG4 manifest flags ไม่ตรง fixed flags');
  }

  const checks = manifest.checks ?? [];
  const registered = new Map(CXA_CG4_READINESS_CHECKS.map((item) => [item.id, item]));
  if (new Set(checks.map((item) => item.id)).size !== checks.length) {
    throw new TypeError('CG4 manifest มี check ซ้ำ');
  }
  const unknown = checks.find((item) => !registered.has(item.id));
  if (unknown) throw new TypeError(`CG4 manifest มี check ที่ไม่รู้จัก: ${unknown.id}`);
  if (checks.length !== CXA_CG4_READINESS_CHECKS.length) {
    throw new TypeError('CG4 manifest ต้องมี check ครบทั้ง 25 ตัว');
  }
  if (checks.some((item) => registered.get(item.id).dimension !== item.dimension)) {
    throw new TypeError('CG4 manifest มี dimension ของ check ไม่ตรง registry');
  }
  const dimensions = manifest.dimensions ?? [];
  if (
    dimensions.length !== CG4_DIMENSIONS.length ||
    CG4_DIMENSIONS.some((name) => !(dimensions.find((item) => item.name === name)?.checks > 0))
  ) {
    throw new TypeError('CG4 manifest ต้องมีครบ 9 dimensions และไม่มี dimension ว่าง');
  }

  // suite ที่ใช้ร่วมกันต้องเป็นผลเดียวกันในทุก check ที่อ้าง — ห้ามแต่ง status ของ check แยกจาก suite
  const suites = new Map((manifest.suites ?? []).map((suite) => [suite.id, suite]));
  if (suites.size === 0 || suites.size !== (manifest.suites ?? []).length) {
    throw new TypeError('CG4 manifest ต้องมี suites ที่ id ไม่ซ้ำ');
  }
  for (const item of checks) {
    const subchecks = item.subchecks ?? [];
    if (subchecks.length !== registered.get(item.id).commands.length) {
      throw new TypeError(`CG4 check ${item.id} ต้องอ้าง suite ครบตาม registry`);
    }
    for (const subcheck of subchecks) {
      const suite = suites.get(subcheck.suiteId);
      if (!suite || suite.status !== subcheck.status || !suite.checkIds.includes(item.id)) {
        throw new TypeError(`CG4 check ${item.id} อ้าง suite ที่ไม่ตรงกับผลของ suite`);
      }
    }
    const derived = subchecks.every((subcheck) => subcheck.status === 'PASS') ? 'PASS' : 'FAIL';
    if (item.status !== derived) {
      throw new TypeError(`CG4 check ${item.id} มี status ไม่ตรงกับ suite ที่อ้าง`);
    }
  }

  const artifacts = manifest.artifacts ?? [];
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map(({ id }) => id)).size !== checks.length
  ) {
    throw new TypeError('CG4 manifest ต้องมี evidence artifact หนึ่งรายการต่อ check');
  }
  for (const artifact of artifacts) {
    const item = checks.find(({ id }) => `check:${id}` === artifact.id);
    if (!item) throw new TypeError('CG4 evidence artifact อ้าง check ที่ไม่มี');
    if (artifact.commitSha !== manifest.commitSha)
      throw new TypeError('CG4 evidence artifact อ้าง commit ไม่ตรงกับ manifest');
    if (artifact.sha256 !== sha256(item))
      throw new TypeError('SHA-256 ของ CG4 evidence artifact ไม่ตรงกับ check');
  }

  const markers = manifest.markers ?? [];
  if (markers.some((marker) => marker !== CG4_MARKER) || new Set(markers).size !== markers.length) {
    throw new TypeError('CG4 manifest มี marker ไม่ถูกต้อง');
  }
  if (markers.length === 0) return;

  if (
    checks.some((item) => item.status !== 'PASS') ||
    [...suites.values()].some((s) => s.status !== 'PASS')
  ) {
    throw new TypeError(`${CG4_MARKER} ต้องมี 25 checks PASS ทั้งหมด (ไม่มี skip/flaky/waiver)`);
  }
  if (manifest.pullRequest?.number !== null && manifest.pullRequest?.number !== undefined) {
    throw new TypeError('PR run ออก CG4 marker ไม่ได้ ได้แค่ candidate manifest');
  }
  if (
    manifest.commitSha !== manifest.finalMainSha ||
    manifest.commitSha !== manifest.expectedCommitSha
  ) {
    throw new TypeError(
      'CG4 marker ต้องมาจาก HEAD == origin/main == expectedCommitSha == finalMainSha',
    );
  }
  if (manifest.refProof?.ref !== 'refs/heads/main' || manifest.refProof?.cleanTree !== true) {
    throw new TypeError('CG4 marker ต้องมาจาก clean checkout ของ default branch');
  }
  if (
    manifest.artifact?.immutable !== true ||
    !/^https:\/\/[^/]+\/.+\/actions\/runs\/\d+\/attempts\/\d+#artifacts$/.test(
      manifest.artifact?.url ?? '',
    ) ||
    manifest.artifact?.name !== `cxa-cg4-evidence-${manifest.commitSha}`
  ) {
    throw new TypeError('CG4 marker ต้องอ้าง immutable CI artifact ไม่ใช่ local/mutable reference');
  }
  if (
    manifest.dependencies?.cg3 !== 'INTEGRATED_SAME_SHA' ||
    manifest.dependencies?.cg3Marker !== CG3_MARKER
  ) {
    throw new TypeError(`CG4 marker ต้องมี ${CG3_MARKER} บน SHA เดียวกัน`);
  }
  if (!regressionPassed(manifest.dependencies)) {
    throw new TypeError(
      'CG4 marker ต้องมี build/typecheck/lint/E0/C1/Inbound Voice PASS ใน S1-REG-01',
    );
  }
  if (!['ACCEPTED_SAME_SHA', 'CONTRACT_COMPATIBLE'].includes(manifest.dependencies?.j2)) {
    throw new TypeError('CG4 marker ต้องบันทึกสถานะ J2 compatibility');
  }
  if (JSON.stringify(manifest.ownerProfiles) !== JSON.stringify(CG4_OWNER_PROFILES)) {
    throw new TypeError('CG4 marker ต้องมี owner profiles ตรง contract');
  }
}

// ── Runner ───────────────────────────────────────────────────────────────────

function composeCheck(item, suiteByKey) {
  const subchecks = item.commands.map((command) => {
    const suite = suiteByKey.get(suiteKey(command));
    return {
      suiteId: suite.id,
      command,
      status: suite.status,
      durationMs: suite.durationMs ?? null,
      ...(suite.tap ? { tap: { ...suite.tap } } : {}),
      ...(suite.evidence ? { evidence: structuredClone(suite.evidence) } : {}),
      ...(suite.detail ? { detail: suite.detail } : {}),
    };
  });
  return {
    id: item.id,
    dimension: item.dimension,
    status: subchecks.every((subcheck) => subcheck.status === 'PASS') ? 'PASS' : 'FAIL',
    boundaries: item.boundaries,
    subchecks,
  };
}

export function runCxaCg4Readiness(options = {}) {
  const startedAt = options.now?.() ?? new Date();
  const context = options.context ?? createCg4EvidenceContext(options.environment ?? process.env);
  const executeSuite = options.executeSuite ?? executeCg4Suite;
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));

  const suites = cg4SuitePlan().map((suite) => {
    const result = executeSuite(suite);
    const executed = { ...suite, ...result };
    emit({
      type: 'readiness.suite',
      id: executed.id,
      command: executed.command,
      checkIds: executed.checkIds,
      status: executed.status,
      durationMs: executed.durationMs,
      ...(executed.tap ? { tap: executed.tap } : {}),
      ...(executed.detail ? { detail: executed.detail } : {}),
    });
    return executed;
  });
  const suiteByKey = new Map(suites.map((suite) => [suiteKey(suite.command), suite]));
  const checks = CXA_CG4_READINESS_CHECKS.map((item) => {
    const composed = composeCheck(item, suiteByKey);
    emit({ type: 'readiness.check', ...composed });
    return composed;
  });

  const summary = cxaCg4Summary(context, checks, startedAt);
  const manifest = createCxaCg4EvidenceManifest(context, checks, summary, suites, options.digests);
  const evidencePath =
    options.evidencePath ??
    resolve(repositoryRoot, 'artifacts', 'cxa-cg4', `${context.runId}.json`);
  if (options.writeManifest !== false) {
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  const manifestSha256 = sha256(manifest);
  emit(summary);
  emit({
    type: 'evidence.manifest',
    path: evidencePath,
    sha256: manifestSha256,
    markers: summary.markers,
    candidateOnly: summary.candidateOnly,
    artifact: context.artifact,
    suites: suites.length,
  });
  return { context, suites, checks, summary, manifest, evidencePath, manifestSha256 };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = runCxaCg4Readiness();
    if (result.summary.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
