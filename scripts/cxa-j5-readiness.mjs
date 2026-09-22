import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPiiSafeEvidence, sha256 } from './cxa-c1-readiness.mjs';
import { cg4FailureDetail, parseTapSummary } from './cxa-cg4-readiness.mjs';
import { J5_DEPENDENCY_PHASES } from './cxa-j5-dependency-readiness.mjs';
import {
  J5_ENVIRONMENT_PROFILES,
  J5_FIXED_FLAGS,
  J5_OWNER_PROFILES,
} from './cxa-j5-profile-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export { assertPiiSafeEvidence, parseTapSummary, sha256, J5_FIXED_FLAGS, J5_OWNER_PROFILES };

/**
 * J5.7 (#345): Journey J5 development acceptance (#333, Phase Contract #334 §§14–16, Phase Spec #337)
 *
 * - `cxa:j5:focused` รัน 15 checks (ไม่รวม J5-REG01) เป็น candidate เสมอ: `markers=[]`
 * - `cxa:j5:acceptance` รันครบ 16 checks และเป็นคำสั่งเดียวที่ออก `JOURNEY_J5_ACCEPTED` ได้ เมื่อ
 *   clean final main SHA + immutable artifact + dependency markers J1/J2/J3/CG3 บน SHA เดียวกัน
 * - suite คือคำสั่งจริงของแต่ละ package และรันครั้งเดียวต่อ run แม้หลาย check ใช้ร่วมกัน
 * - status ของ check/dimension derive จาก suite เท่านั้น ไม่มี override/waiver
 */
export const J5_MARKER = 'JOURNEY_J5_ACCEPTED';
export const J5_WORKFLOW = Object.freeze({ name: 'cxa-j5-acceptance', version: 1 });
export const J5_CONTEXT_POINTERS = Object.freeze([
  '#327',
  '#328',
  '#329',
  '#330',
  '#331',
  '#332',
  '#333',
  '#334',
  '#337',
]);
export const J5_VERSIONS = Object.freeze({
  authoringSchema: 'J5_AUTHORING_V1',
  nodeRegistry: 'J5_PALETTE_V1',
  templateSchema: 'J5_TEMPLATE_V1',
  compileArtifact: 1,
  manifestSchema: 1,
});
export const J5_DIMENSIONS = Object.freeze([
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

/** fixture registry ของ #333 §4 — ชี้ไปที่ไฟล์เทสต์ที่ใช้ fixture สังเคราะห์นั้นจริง */
export const J5_FIXTURE_REGISTRY = Object.freeze([
  {
    id: 'J5FX-HAPPY-01',
    sources: [
      'apps/journey/src/journey-authoring-repository.integration.ts',
      'apps/journey/src/journey-authoring-review.integration.ts',
    ],
  },
  { id: 'J5FX-VISUAL-01', sources: ['apps/journey/src/journey-authoring-compiler.test.ts'] },
  { id: 'J5FX-INVALID-01', sources: ['apps/journey/src/journey-authoring-compiler.test.ts'] },
  {
    id: 'J5FX-CONFLICT-01',
    sources: [
      'apps/journey/src/journey-authoring-repository.integration.ts',
      'apps/console/e2e/journey-authoring.spec.ts',
    ],
  },
  {
    id: 'J5FX-PUBLISH-RACE-01',
    sources: [
      'apps/journey/src/journey-authoring-review.integration.ts',
      'apps/api/src/journey-authoring-api.integration.ts',
    ],
  },
  {
    id: 'J5FX-TEMPLATE-01',
    sources: [
      'apps/journey/src/journey-template.test.ts',
      'apps/journey/src/journey-template-repository.integration.ts',
    ],
  },
  {
    id: 'J5FX-TENANT-01',
    sources: [
      'apps/api/src/journey-authoring-api.integration.ts',
      'apps/journey/src/journey-template-repository.integration.ts',
    ],
  },
  {
    id: 'J5FX-RECOVERY-01',
    sources: [
      'apps/journey/src/journey-authoring-repository.integration.ts',
      'apps/api/src/journey-authoring-api.integration.ts',
    ],
  },
]);

const node = (script, ...arguments_) => [process.execPath, ...arguments_, script];
const filter = (name, ...arguments_) => [pnpm, '--filter', name, ...arguments_];

const contracts = filter('@d-contact/cxa-contracts', 'test');
const journeyUnit = filter('@d-contact/journey', 'test');
const journeyIntegration = filter('@d-contact/journey', 'test:integration');
const apiIntegration = filter('@d-contact/api', 'test:integration');
const iamIntegration = filter('@d-contact/iam', 'test:integration');
const dbIntegration = filter('@d-contact/db', 'test:integration');
const consoleUnit = filter('@d-contact/console', 'test');
const consoleBuild = filter('@d-contact/console', 'build');
// `pnpm test:e2e -- …` ส่ง `--` ตรง ๆ ทำให้ Playwright มองธงที่ตามมาเป็นตัวกรองไฟล์ จึงเรียก exec โดยตรง
const consoleE2e = filter(
  '@d-contact/console',
  'exec',
  'playwright',
  'test',
  '--project=chromium',
  '--trace=on',
);
const browserEvidence = node('scripts/cxa-j5-browser-evidence.mjs');
const schema = node('scripts/cxa-j5-schema-readiness.mjs');
const negativeScan = node('scripts/cxa-j5-negative-scan.mjs');
const profile = node('scripts/cxa-j5-profile-readiness.mjs');
const dependency = node('scripts/cxa-j5-dependency-readiness.mjs');
const readinessTests = [
  process.execPath,
  '--test',
  'scripts/cxa-j5-readiness.test.mjs',
  'scripts/cxa-j5-schema-readiness.test.mjs',
];

function check(id, dimension, boundaries, commands) {
  return { id, dimension, boundaries, commands, remediation: `แก้ ${id} ตาม #333/#337` };
}

/** #333 §2: 16 checks / 9 dimensions — ลำดับของ command คือลำดับที่ suite ถูกรันครั้งแรก */
export const CXA_J5_READINESS_CHECKS = Object.freeze([
  check(
    'J5-F01',
    'functional',
    [
      'closed node/port registry',
      'stable identity',
      'load→edit→save→load round-trip',
      'visual-only digest',
    ],
    [contracts, journeyUnit, journeyIntegration],
  ),
  check(
    'J5-F02',
    'functional',
    [
      'draft→validate→review→approve→publish',
      'approval superseded by edit',
      'enrollment pinned',
      'roll-forward',
    ],
    [journeyIntegration, apiIntegration],
  ),
  check(
    'J5-F03',
    'functional',
    [
      'template catalog/parameters/references',
      'detached instantiate/fork',
      'three-way upgrade',
      'deprecation',
    ],
    [journeyUnit, journeyIntegration, apiIntegration],
  ),
  check(
    'J5-F04',
    'functional',
    [
      'keyboard-only authoring',
      'outline = visual projection',
      'modal focus',
      '200% zoom',
      'reduced motion',
      '<960px read-only',
    ],
    [consoleUnit, consoleBuild, consoleE2e, browserEvidence],
  ),
  check(
    'J5-TI01',
    'tenant-isolation',
    [
      'two-tenant generic not-found',
      'no list/count leak',
      'recovery key bound to tenant/resource/revision',
    ],
    [dbIntegration, journeyIntegration, apiIntegration, consoleUnit],
  ),
  check(
    'J5-AU01',
    'authorization',
    [
      'capability/team scope',
      'maker-checker',
      'strong-auth publish',
      'delegation expiry',
      'current-scope recheck',
    ],
    [iamIntegration, journeyIntegration, apiIntegration],
  ),
  check(
    'J5-AU02',
    'authorization',
    ['Journey is sole canonical writer', 'no cross-owner writes', 'simulation blocked ports'],
    [journeyUnit, negativeScan],
  ),
  check(
    'J5-ID01',
    'idempotency',
    ['same key same receipt', 'conflicting payload rejected', 'unknown publish ack queryable'],
    [journeyIntegration, apiIntegration],
  ),
  check(
    'J5-ID02',
    'idempotency',
    [
      'nodeId = step.id',
      'canonical serialization',
      'deterministic digests',
      'visual metadata excluded',
    ],
    [contracts, journeyUnit],
  ),
  check(
    'J5-CC01',
    'concurrency',
    ['whole-draft CAS', 'loser gets DRAFT_VERSION_CONFLICT', 'no silent merge'],
    [journeyIntegration, apiIntegration, consoleE2e],
  ),
  check(
    'J5-CC02',
    'concurrency',
    ['exact candidate', 'stale approval/head/scope rejected', 'single immutable winner'],
    [journeyIntegration, apiIntegration],
  ),
  check(
    'J5-RC01',
    'recovery',
    [
      'crash checkpoints leave no partial state',
      'no Published before receipt',
      'unknown ack resolved by original key',
    ],
    [journeyIntegration, apiIntegration, consoleE2e],
  ),
  check(
    'J5-RC02',
    'recovery',
    [
      'session recovery',
      'template upgrade conflict',
      'unsupported node read-only',
      'stale reference',
    ],
    [journeyUnit, journeyIntegration, consoleUnit, consoleE2e],
  ),
  check(
    'J5-MG01',
    'migration',
    ['fresh + existing schema', 'RLS/check/trigger/index', 'legacy J1–J3 definitions still load'],
    [schema, dbIntegration, journeyIntegration],
  ),
  check(
    'J5-OB01',
    'observability',
    [
      'audit/correlation to receipt',
      'PII/credential-free artifacts',
      'browser/a11y digests',
      'owner profiles/flags',
    ],
    [apiIntegration, negativeScan, browserEvidence, profile, readinessTests],
  ),
  check(
    'J5-REG01',
    'regression',
    ['build/typecheck/lint', 'J1/J2/J3/CG3 acceptance on same SHA', 'no disabled tests'],
    [[pnpm, 'build'], [pnpm, 'typecheck'], [pnpm, 'lint'], [pnpm, 'cxa:j3:acceptance'], dependency],
  ),
]);

export const J5_FOCUSED_EXCLUDED = Object.freeze(['J5-REG01']);

export function j5Checks(scope = 'full') {
  return scope === 'focused'
    ? CXA_J5_READINESS_CHECKS.filter(({ id }) => !J5_FOCUSED_EXCLUDED.includes(id))
    : CXA_J5_READINESS_CHECKS;
}

// ── Suite plan / execution ──────────────────────────────────────────────────

const suiteKey = (command) => JSON.stringify(command);

/** รวมคำสั่งซ้ำข้าม check เหลือ suite เดียวตามลำดับที่ปรากฏครั้งแรก — ไม่รันซ้ำเพื่อเพิ่มจำนวน check */
export function j5SuitePlan(checks = CXA_J5_READINESS_CHECKS) {
  const suites = new Map();
  for (const item of checks) {
    for (const command of item.commands) {
      const key = suiteKey(command);
      const existing = suites.get(key);
      if (existing) {
        if (!existing.checkIds.includes(item.id)) existing.checkIds.push(item.id);
        continue;
      }
      suites.set(key, {
        id: `suite:${String(suites.size + 1).padStart(2, '0')}`,
        command,
        checkIds: [item.id],
      });
    }
  }
  return [...suites.values()];
}

const EVIDENCE_PREFIXES = [
  'CXA_J5_PROFILE_EVIDENCE:',
  'CXA_J5_DEPENDENCY_EVIDENCE:',
  'CXA_J5_SCAN_EVIDENCE:',
  'CXA_J5_BROWSER_EVIDENCE:',
];

/** เก็บเฉพาะ evidence ที่ script ของ J5 ประกาศเอง; schema summary เก็บแค่ผล ไม่เก็บทั้งก้อน */
export function j5StructuredEvidence(output) {
  return String(output)
    .split('\n')
    .flatMap((line) => {
      const prefix = EVIDENCE_PREFIXES.find((candidate) => line.startsWith(candidate));
      try {
        if (prefix) return [JSON.parse(line.slice(prefix.length))];
        if (line.startsWith('{"type":"schema.readiness"')) {
          const summary = JSON.parse(line);
          return [
            {
              type: summary.type,
              status: summary.status,
              existing: summary.existing?.status ?? null,
              fresh: summary.fresh?.status ?? null,
            },
          ];
        }
      } catch {
        return [];
      }
      return [];
    });
}

/**
 * Playwright ไม่ใช่ TAP: ผ่านต้องมี `N passed` > 0 และไม่มี failed/flaky/skipped/did not run/interrupted
 * — flaky ที่ผ่านเพราะ retry ถือว่าไม่ผ่าน (#333 §1)
 */
export function parsePlaywrightSummary(output) {
  const text = String(output);
  const passed = [...text.matchAll(/^\s*(\d+) passed\b/gm)].reduce(
    (sum, match) => sum + Number(match[1]),
    0,
  );
  if (passed === 0 && !/^\s*\d+ (failed|flaky|skipped|did not run|interrupted)\b/m.test(text))
    return null;
  const count = (word) =>
    [...text.matchAll(new RegExp(`^\\s*(\\d+) ${word}\\b`, 'gm'))].reduce(
      (sum, match) => sum + Number(match[1]),
      0,
    );
  return {
    passed,
    failed: count('failed'),
    flaky: count('flaky'),
    skipped: count('skipped'),
    didNotRun: count('did not run'),
    interrupted: count('interrupted'),
  };
}

const isPlaywright = (command) => command.includes('test:e2e') || command.includes('playwright');

export function executeJ5Suite(suite, runner = spawnSync) {
  const started = performance.now();
  const [command, ...arguments_] = suite.command;
  const result = runner(command, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', CI: process.env.CI ?? '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 512 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const tap = parseTapSummary(output);
  const playwright = isPlaywright(suite.command) ? parsePlaywrightSummary(output) : null;
  const exitedCleanly = result.status === 0 && !result.error;
  const tapClean =
    tap === null ||
    (tap.tests > 0 &&
      tap.failed === 0 &&
      tap.cancelled === 0 &&
      tap.skipped === 0 &&
      tap.todo === 0);
  const browserClean =
    !isPlaywright(suite.command) ||
    (playwright !== null &&
      playwright.passed > 0 &&
      playwright.failed +
        playwright.flaky +
        playwright.skipped +
        playwright.didNotRun +
        playwright.interrupted ===
        0);
  const passed = exitedCleanly && tapClean && browserClean;
  const evidence = passed ? j5StructuredEvidence(output) : [];
  return {
    status: passed ? 'PASS' : 'FAIL',
    durationMs: Math.round(performance.now() - started),
    ...(tap ? { tap } : {}),
    ...(playwright ? { playwright } : {}),
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

// ── Context / digests ───────────────────────────────────────────────────────

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
  if (!match) throw new TypeError('ไม่สามารถระบุ repository สำหรับ J5 manifest');
  return match[1];
}

export function createJ5EvidenceContext(environment = process.env) {
  const repository = repositoryName(environment);
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const finalMainSha = runGit(['rev-parse', 'origin/main']);
  const expectedCommitSha = environment.CXA_J5_EXPECTED_COMMIT_SHA ?? finalMainSha;
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
    baseSha: runGit(['merge-base', 'HEAD', 'origin/main']),
    commitSha,
    finalMainSha,
    expectedCommitSha,
    cleanTree: runGit(['status', '--porcelain', '--untracked-files=no']) === '',
    runId,
    attempt,
    runUrl,
    artifact: {
      name: `cxa-j5-evidence-${commitSha}`,
      url: runUrl ? `${runUrl}#artifacts` : null,
      immutable: runUrl !== null,
    },
  };
}

function fileDigest(paths) {
  return sha256(
    paths
      .map((path) => resolve(repositoryRoot, path))
      .flatMap((path) =>
        statSync(path).isDirectory()
          ? readdirSync(path)
              .sort()
              .map((name) => resolve(path, name))
              .filter((entry) => statSync(entry).isFile())
          : [path],
      )
      .map((path) => ({
        path: path.slice(repositoryRoot.length + 1),
        sha256: sha256(readFileSync(path, 'utf8')),
      })),
  );
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

export function j5RegistryDigest(checks = CXA_J5_READINESS_CHECKS) {
  return sha256(
    checks.map(({ id, dimension, boundaries, commands }) => ({
      id,
      dimension,
      boundaries,
      commands: commands.map((command) =>
        command[0] === process.execPath ? ['node', ...command.slice(1)] : command,
      ),
    })),
  );
}

export function j5ContentDigests() {
  const existing = (paths) => paths.filter((path) => existsSync(resolve(repositoryRoot, path)));
  return {
    registry: j5RegistryDigest(),
    nodeRegistry: fileDigest(['packages/cxa-contracts/src/journey-authoring-v1.ts']),
    compiler: fileDigest([
      'apps/journey/src/journey-authoring-canonical.ts',
      'apps/journey/src/journey-authoring-compiler.ts',
      'apps/journey/src/journey-authoring-validator.ts',
    ]),
    templateRegistry: fileDigest([
      'packages/cxa-contracts/src/journey-template-v1.ts',
      'apps/journey/templates/builtin',
    ]),
    fixtures: sha256({
      registry: J5_FIXTURE_REGISTRY,
      files: fileDigest(
        existing([
          'apps/journey/test/fixtures/j5',
          ...new Set(J5_FIXTURE_REGISTRY.flatMap(({ sources }) => sources)),
        ]),
      ),
    }),
    migrations: migrationDigest(),
  };
}

// ── Summary / manifest ──────────────────────────────────────────────────────

function evidenceOf(checks, type) {
  return checks
    .flatMap((item) => item.subchecks ?? [])
    .flatMap(({ evidence = [] }) => evidence)
    .find((evidence) => evidence?.type === type);
}

export function j5MarkerBlockers(context, checks, scope = 'full') {
  const blockers = [];
  const expected = j5Checks(scope);
  if (scope !== 'full') blockers.push('FOCUSED_CANDIDATE');
  if (checks.length !== expected.length || checks.some((item) => item.status !== 'PASS'))
    blockers.push('CHECKS_NOT_ALL_PASS');
  if (context.pullRequest !== null) blockers.push('PULL_REQUEST_RUN');
  if (context.ref !== 'refs/heads/main') blockers.push('NOT_DEFAULT_BRANCH_REF');
  if (context.commitSha !== context.finalMainSha || context.commitSha !== context.expectedCommitSha)
    blockers.push('NOT_FINAL_MAIN_SHA');
  if (!context.cleanTree) blockers.push('DIRTY_TREE');
  if (!context.artifact?.immutable || !context.runUrl) blockers.push('ARTIFACT_NOT_IMMUTABLE');
  const profileEvidence = evidenceOf(checks, 'owner-profile.readiness');
  if (
    !profileEvidence ||
    JSON.stringify(profileEvidence.profiles) !== JSON.stringify(J5_OWNER_PROFILES) ||
    JSON.stringify(profileEvidence.environmentProfiles) !==
      JSON.stringify(J5_ENVIRONMENT_PROFILES) ||
    JSON.stringify(profileEvidence.flags) !== JSON.stringify(J5_FIXED_FLAGS)
  )
    blockers.push('OWNER_PROFILE_OR_FLAGS_MISMATCH');
  if (evidenceOf(checks, 'browser.readiness')?.status !== 'PASS')
    blockers.push('BROWSER_EVIDENCE_MISSING');
  const scan = evidenceOf(checks, 'negative-scan.readiness');
  if (scan?.status !== 'PASS' || scan?.bundleScanned !== true)
    blockers.push('NEGATIVE_SCAN_NOT_PASS');
  const schemaEvidence = evidenceOf(checks, 'schema.readiness');
  if (schemaEvidence?.existing !== 'PASS' || schemaEvidence?.fresh !== 'PASS')
    blockers.push('MIGRATION_NOT_PROVEN');
  if (scope === 'full' && evidenceOf(checks, 'dependency.readiness')?.allAcceptedSameSha !== true)
    blockers.push('DEPENDENCY_MARKERS_NOT_SAME_SHA');
  return blockers;
}

export function cxaJ5Summary(context, checks, startedAt = new Date(), scope = 'full') {
  const blockers = j5MarkerBlockers(context, checks, scope);
  const allPassed = !blockers.includes('CHECKS_NOT_ALL_PASS');
  const markers = blockers.length === 0 ? [J5_MARKER] : [];
  return {
    type: 'readiness.summary',
    workflow: J5_WORKFLOW.name,
    workflowVersion: J5_WORKFLOW.version,
    scope,
    status: allPassed ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: checks.filter(({ status }) => status === 'PASS').length,
    failed: checks.filter(({ status }) => status !== 'PASS').length,
    markers,
    markerBlockers: blockers,
    candidateOnly: markers.length === 0,
    markerEligible: scope === 'full',
    entryCondition: markers.length > 0 ? J5_MARKER : 'NOT_READY',
    evidenceScope:
      'J5 Development Complete only; releaseEnabled=false, actualProviderTraffic=false, providerConformance=false',
  };
}

export function createCxaJ5EvidenceManifest(context, checks, summary, suites, digests) {
  const status = (id) => checks.find((item) => item.id === id)?.status ?? 'NOT_RUN';
  const browser = evidenceOf(checks, 'browser.readiness');
  const scan = evidenceOf(checks, 'negative-scan.readiness');
  const schemaEvidence = evidenceOf(checks, 'schema.readiness');
  const dependencyEvidence = evidenceOf(checks, 'dependency.readiness');
  const profileEvidence = evidenceOf(checks, 'owner-profile.readiness');
  const manifest = {
    schemaVersion: 1,
    phase: 'J5',
    evidenceType: 'development-acceptance',
    scope: summary.scope,
    candidate: summary.markers.length === 0,
    candidateOnly: summary.markers.length === 0,
    markerEligible: summary.markerEligible,
    markers: [...summary.markers],
    markerBlockers: [...summary.markerBlockers],
    entryCondition: summary.entryCondition,
    retentionDays: summary.markers.length > 0 ? 90 : 30,
    repository: context.repository,
    defaultBranch: context.defaultBranch,
    pullRequest: { number: context.pullRequest, baseSha: context.baseSha },
    commitSha: context.commitSha,
    finalMainSha: context.finalMainSha,
    expectedCommitSha: context.expectedCommitSha,
    refProof: {
      ref: context.ref,
      cleanTree: context.cleanTree,
      headEqualsFinalMain: context.commitSha === context.finalMainSha,
    },
    workflow: { ...J5_WORKFLOW },
    run: { id: context.runId, attempt: context.attempt, url: context.runUrl },
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    artifact: { ...context.artifact },
    contextPointers: [...J5_CONTEXT_POINTERS],
    versions: { ...J5_VERSIONS },
    digests: { ...digests },
    fixtures: J5_FIXTURE_REGISTRY.map(({ id }) => id),
    suites: suites.map((suite) => ({
      id: suite.id,
      command:
        suite.command[0] === process.execPath ? ['node', ...suite.command.slice(1)] : suite.command,
      checkIds: [...suite.checkIds],
      status: suite.status,
      durationMs: suite.durationMs ?? null,
      ...(suite.tap ? { tap: { ...suite.tap } } : {}),
      ...(suite.playwright ? { playwright: { ...suite.playwright } } : {}),
    })),
    checks,
    dimensions: J5_DIMENSIONS.map((name) => {
      const inDimension = checks.filter((item) => item.dimension === name);
      return {
        name,
        checks: inDimension.length,
        status:
          inDimension.length === 0
            ? 'NOT_RUN'
            : inDimension.every((item) => item.status === 'PASS')
              ? 'PASS'
              : 'FAIL',
      };
    }),
    browser: browser
      ? {
          browser: browser.browser,
          matrix: browser.matrix,
          axeWcag22: browser.axeWcag22,
          traces: browser.traces,
          artifactsSha256: browser.artifactsSha256,
        }
      : null,
    migration: {
      schema: schemaEvidence
        ? { existing: schemaEvidence.existing, fresh: schemaEvidence.fresh }
        : null,
      check: status('J5-MG01'),
    },
    dependencies: dependencyEvidence?.phases ?? null,
    ownerProfiles: profileEvidence ? structuredClone(profileEvidence.profiles) : null,
    environmentProfiles: profileEvidence
      ? structuredClone(profileEvidence.environmentProfiles)
      : null,
    flags: { ...J5_FIXED_FLAGS },
    negativeScan: scan
      ? {
          status: scan.status,
          files: scan.files,
          bundleScanned: scan.bundleScanned,
          allowlist: scan.allowlist,
        }
      : null,
    artifacts: checks.map((item) => ({
      id: `check:${item.id}`,
      kind: 'readiness-diagnostic',
      commitSha: context.commitSha,
      sha256: sha256(item),
    })),
  };
  assertValidCxaJ5EvidenceManifest(manifest);
  return manifest;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

export function assertValidCxaJ5EvidenceManifest(manifest) {
  // PII/credential ก่อน validation อื่นทั้งหมด (#333 §7)
  assertPiiSafeEvidence(manifest);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.phase !== 'J5' ||
    manifest.evidenceType !== 'development-acceptance'
  )
    throw new TypeError('J5 manifest มี schemaVersion/phase/evidenceType ไม่ถูกต้อง');
  if (!['full', 'focused'].includes(manifest.scope))
    throw new TypeError('J5 manifest ต้องระบุ scope full หรือ focused');
  for (const field of ['commitSha', 'finalMainSha', 'expectedCommitSha']) {
    if (!FULL_SHA.test(manifest[field] ?? ''))
      throw new TypeError(`J5 manifest ต้องมี ${field} แบบ SHA เต็ม`);
  }
  if (JSON.stringify(manifest.flags) !== JSON.stringify(J5_FIXED_FLAGS))
    throw new TypeError('J5 manifest flags ไม่ตรง fixed flags');

  const expected = j5Checks(manifest.scope);
  const registered = new Map(expected.map((item) => [item.id, item]));
  const checks = manifest.checks ?? [];
  if (new Set(checks.map((item) => item.id)).size !== checks.length)
    throw new TypeError('J5 manifest มี check ซ้ำ');
  const unknown = checks.find((item) => !registered.has(item.id));
  if (unknown) throw new TypeError(`J5 manifest มี check ที่ไม่อยู่ใน scope: ${unknown.id}`);
  if (checks.length !== expected.length)
    throw new TypeError(
      `J5 manifest scope ${manifest.scope} ต้องมี check ครบ ${expected.length} ตัว`,
    );
  if (checks.some((item) => registered.get(item.id).dimension !== item.dimension))
    throw new TypeError('J5 manifest มี dimension ของ check ไม่ตรง registry');
  const dimensions = manifest.dimensions ?? [];
  if (dimensions.length !== J5_DIMENSIONS.length)
    throw new TypeError('J5 manifest ต้องมีครบ 9 dimensions');
  for (const name of J5_DIMENSIONS) {
    const dimension = dimensions.find((item) => item.name === name);
    const inScope = expected.filter((item) => item.dimension === name).length;
    if (!dimension || dimension.checks !== inScope)
      throw new TypeError(`J5 manifest dimension ${name} ไม่ตรงกับ checks`);
    const derived =
      inScope === 0
        ? 'NOT_RUN'
        : checks.filter((item) => item.dimension === name).every((item) => item.status === 'PASS')
          ? 'PASS'
          : 'FAIL';
    if (dimension.status !== derived)
      throw new TypeError(`J5 manifest dimension ${name} ต้อง derive จาก checks เท่านั้น`);
  }

  const suites = new Map((manifest.suites ?? []).map((suite) => [suite.id, suite]));
  if (suites.size === 0 || suites.size !== (manifest.suites ?? []).length)
    throw new TypeError('J5 manifest ต้องมี suites ที่ id ไม่ซ้ำ');
  const commands = (manifest.suites ?? []).map((suite) => suiteKey(suite.command));
  if (new Set(commands).size !== commands.length)
    throw new TypeError('J5 manifest รัน suite เดียวกันซ้ำใน run เดียว');
  for (const item of checks) {
    const subchecks = item.subchecks ?? [];
    if (subchecks.length !== registered.get(item.id).commands.length)
      throw new TypeError(`J5 check ${item.id} ต้องอ้าง suite ครบตาม registry`);
    for (const subcheck of subchecks) {
      const suite = suites.get(subcheck.suiteId);
      if (!suite || suite.status !== subcheck.status || !suite.checkIds.includes(item.id))
        throw new TypeError(`J5 check ${item.id} อ้าง suite ที่ไม่ตรงกับผลของ suite`);
    }
    const derived = subchecks.every((subcheck) => subcheck.status === 'PASS') ? 'PASS' : 'FAIL';
    if (item.status !== derived)
      throw new TypeError(`J5 check ${item.id} มี status ไม่ตรงกับ suite ที่อ้าง`);
  }

  const artifacts = manifest.artifacts ?? [];
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map(({ id }) => id)).size !== checks.length
  )
    throw new TypeError('J5 manifest ต้องมี evidence artifact หนึ่งรายการต่อ check');
  for (const artifact of artifacts) {
    const item = checks.find(({ id }) => `check:${id}` === artifact.id);
    if (!item) throw new TypeError('J5 evidence artifact อ้าง check ที่ไม่มี');
    if (artifact.commitSha !== manifest.commitSha)
      throw new TypeError('J5 evidence artifact อ้าง commit ไม่ตรงกับ manifest');
    if (artifact.sha256 !== sha256(item))
      throw new TypeError('SHA-256 ของ J5 evidence artifact ไม่ตรงกับ check');
  }

  const markers = manifest.markers ?? [];
  if (markers.some((marker) => marker !== J5_MARKER) || new Set(markers).size !== markers.length)
    throw new TypeError('J5 manifest มี marker ไม่ถูกต้อง');
  if (markers.length === 0) {
    if (manifest.candidate !== true || manifest.entryCondition !== 'NOT_READY')
      throw new TypeError('J5 manifest ที่ไม่มี marker ต้องเป็น candidate และ NOT_READY');
    return;
  }

  if (manifest.scope !== 'full')
    throw new TypeError('focused run ออก J5 marker ไม่ได้ ได้แค่ candidate manifest');
  if (manifest.candidate !== false || (manifest.markerBlockers ?? []).length > 0)
    throw new TypeError('J5 marker ออกพร้อม candidate/blocker ไม่ได้');
  if (
    checks.some((item) => item.status !== 'PASS') ||
    [...suites.values()].some((suite) => suite.status !== 'PASS')
  )
    throw new TypeError(`${J5_MARKER} ต้องมีทุก check/suite PASS (ไม่มี skip/flaky/waiver)`);
  if (manifest.pullRequest?.number !== null && manifest.pullRequest?.number !== undefined)
    throw new TypeError('PR run ออก J5 marker ไม่ได้');
  if (
    manifest.commitSha !== manifest.finalMainSha ||
    manifest.commitSha !== manifest.expectedCommitSha ||
    manifest.refProof?.ref !== 'refs/heads/main' ||
    manifest.refProof?.cleanTree !== true
  )
    throw new TypeError(
      'J5 marker ต้องมาจาก clean final main SHA (HEAD == origin/main == expected)',
    );
  if (
    manifest.artifact?.immutable !== true ||
    manifest.artifact?.name !== `cxa-j5-evidence-${manifest.commitSha}` ||
    !/^https:\/\/[^/]+\/.+\/actions\/runs\/\d+\/attempts\/\d+#artifacts$/.test(
      manifest.artifact?.url ?? '',
    )
  )
    throw new TypeError('J5 marker ต้องอ้าง immutable CI artifact');
  if (
    J5_DEPENDENCY_PHASES.some(
      ({ phase }) => manifest.dependencies?.[phase]?.status !== 'ACCEPTED_SAME_SHA',
    )
  )
    throw new TypeError('J5 marker ต้องมี J1/J2/J3/CG3 marker บน SHA เดียวกัน');
  if (
    JSON.stringify(manifest.ownerProfiles) !== JSON.stringify(J5_OWNER_PROFILES) ||
    JSON.stringify(manifest.environmentProfiles) !== JSON.stringify(J5_ENVIRONMENT_PROFILES)
  )
    throw new TypeError('J5 marker ต้องมี owner/environment profiles ตรง contract');
  if (manifest.browser?.axeWcag22 !== true || !(manifest.browser?.traces > 0))
    throw new TypeError('J5 marker ต้องมี browser/accessibility evidence');
  if (manifest.negativeScan?.status !== 'PASS' || manifest.negativeScan?.bundleScanned !== true)
    throw new TypeError('J5 marker ต้องผ่าน negative scans รวม built bundle');
  if (
    manifest.migration?.schema?.existing !== 'PASS' ||
    manifest.migration?.schema?.fresh !== 'PASS'
  )
    throw new TypeError('J5 marker ต้องพิสูจน์ migration ทั้ง fresh และ existing');
}

// ── Runner ──────────────────────────────────────────────────────────────────

function composeCheck(item, suiteByKey) {
  const subchecks = item.commands.map((command) => {
    const suite = suiteByKey.get(suiteKey(command));
    return {
      suiteId: suite.id,
      status: suite.status,
      durationMs: suite.durationMs ?? null,
      ...(suite.tap ? { tap: { ...suite.tap } } : {}),
      ...(suite.playwright ? { playwright: { ...suite.playwright } } : {}),
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

export function runCxaJ5Readiness(options = {}) {
  const scope = options.scope ?? 'full';
  const startedAt = options.now?.() ?? new Date();
  const context = options.context ?? createJ5EvidenceContext(options.environment ?? process.env);
  const executeSuite = options.executeSuite ?? executeJ5Suite;
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const registry = j5Checks(scope);

  const suites = j5SuitePlan(registry).map((suite) => {
    const executed = { ...suite, ...executeSuite(suite) };
    emit({
      type: 'readiness.suite',
      id: executed.id,
      checkIds: executed.checkIds,
      status: executed.status,
      durationMs: executed.durationMs,
      ...(executed.tap ? { tap: executed.tap } : {}),
      ...(executed.playwright ? { playwright: executed.playwright } : {}),
      ...(executed.detail ? { detail: executed.detail } : {}),
    });
    return executed;
  });
  const suiteByKey = new Map(suites.map((suite) => [suiteKey(suite.command), suite]));
  const checks = registry.map((item) => {
    const composed = composeCheck(item, suiteByKey);
    emit({ type: 'readiness.check', id: composed.id, status: composed.status });
    return composed;
  });

  const summary = cxaJ5Summary(context, checks, startedAt, scope);
  const manifest = createCxaJ5EvidenceManifest(
    context,
    checks,
    summary,
    suites,
    options.digests ?? j5ContentDigests(),
  );
  const evidencePath =
    options.evidencePath ??
    resolve(repositoryRoot, 'artifacts', 'cxa-j5', `${scope}-${context.runId}.json`);
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
    const scope = process.argv.includes('--focused') ? 'focused' : 'full';
    const result = runCxaJ5Readiness({ scope });
    if (result.summary.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
