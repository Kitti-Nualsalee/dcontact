import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPiiSafeEvidence, sha256 } from './cxa-c1-readiness.mjs';
import { executeReadinessCheck } from './phase-zero-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const CG3_MARKER = 'CONTACT_GOVERNANCE_CG3_ACCEPTED';
export const LINE_MARKER = 'LINE_IN_MEMORY_SIMULATION_ACCEPTED';
export const S1_FLAGS = Object.freeze({
  simulationOnly: true,
  actualProviderTraffic: false,
  providerConformance: false,
  accountEvidence: false,
});

const dimensions = [
  'functional',
  'tenant-isolation',
  'authorization',
  'idempotency',
  'concurrency',
  'recovery',
  'migration',
  'observability',
  'regression',
];

const governanceIntegration = [
  pnpm,
  '--filter',
  '@d-contact/contact-governance',
  'test:integration',
];
const apiIntegration = [pnpm, '--filter', '@d-contact/api', 'test:integration'];
const journeyIntegration = [pnpm, '--filter', '@d-contact/journey', 'test:integration'];
const deliveryIntegration = [pnpm, '--filter', '@d-contact/delivery', 'test:integration'];

function check(id, dimension, commands, marker = CG3_MARKER) {
  return {
    id,
    dimension,
    marker,
    commands,
    boundaries: ['tenant isolation', 'fail closed', 'PII-safe evidence'],
  };
}

export const S1_READINESS_CHECKS = [
  check('S1-CG3-F01', 'functional', [governanceIntegration]),
  check('S1-CG3-F02', 'functional', [governanceIntegration]),
  check('S1-CG3-F03', 'functional', [journeyIntegration]),
  check('S1-CG3-F04', 'functional', [deliveryIntegration]),
  check('S1-CG3-F05', 'functional', [apiIntegration]),
  check('S1-CG3-RT01', 'recovery', [governanceIntegration]),
  check('S1-CG3-RT02', 'recovery', [journeyIntegration]),
  check('S1-CG3-RT03', 'idempotency', [journeyIntegration]),
  check('S1-CG3-TI01', 'tenant-isolation', [apiIntegration]),
  check('S1-CG3-AU01', 'authorization', [apiIntegration]),
  check('S1-CG3-ID01', 'idempotency', [governanceIntegration]),
  check('S1-CG3-CC01', 'concurrency', [governanceIntegration]),
  check('S1-CG3-RC01', 'recovery', [deliveryIntegration]),
  check('S1-CG3-MG01', 'migration', [[process.execPath, 'scripts/cxa-schema-readiness.mjs']]),
  check('S1-CG3-OB01', 'observability', [[pnpm, '--filter', '@d-contact/delivery', 'test']]),
  check('S1-PC-UX01', 'functional', [[pnpm, '--filter', '@d-contact/console', 'build']]),
  check(
    'S1-LINE-SIM01',
    'functional',
    [[pnpm, '--filter', '@d-contact/delivery', 'test']],
    LINE_MARKER,
  ),
  check(
    'S1-LINE-SIM02',
    'concurrency',
    [[pnpm, '--filter', '@d-contact/delivery', 'test:integration']],
    LINE_MARKER,
  ),
  check(
    'S1-LINE-SIM03',
    'observability',
    [[pnpm, '--filter', '@d-contact/delivery', 'test']],
    LINE_MARKER,
  ),
  check('S1-REG-01', 'regression', [
    [pnpm, 'build'],
    [pnpm, 'typecheck'],
    [pnpm, 'lint'],
    [pnpm, 'cxa:e0:acceptance'],
    [pnpm, 'cxa:c1:acceptance'],
    [pnpm, 'voice:acceptance'],
  ]),
];

function git(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) throw new Error(`git ${arguments_.join(' ')} ล้มเหลว`);
  return String(result.stdout).trim();
}

function repository() {
  const remote = git(['config', '--get', 'remote.origin.url']);
  const match = remote.match(/(?:github\.com[/:])([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match) throw new TypeError('ไม่สามารถระบุ repository ของ S1 manifest');
  return match[1];
}

export function createS1Context(environment = process.env) {
  const commitSha = git(['rev-parse', 'HEAD']);
  const mainSha = git(['rev-parse', 'origin/main']);
  const expectedCommitSha = environment.S1_EXPECTED_COMMIT_SHA ?? mainSha;
  return {
    repository: repository(),
    commitSha,
    mainSha,
    expectedCommitSha,
    finalMain: commitSha === mainSha && commitSha === expectedCommitSha,
    runId: environment.GITHUB_RUN_ID ?? 'local',
    attempt: Number(environment.GITHUB_RUN_ATTEMPT ?? 1),
  };
}

function markerReady(marker, diagnostics) {
  const relevant = S1_READINESS_CHECKS.filter((item) => item.marker === marker);
  return (
    relevant.length > 0 &&
    relevant.every((item) => diagnostics.find((entry) => entry.id === item.id)?.status === 'PASS')
  );
}

export function s1Summary(context, diagnostics, startedAt = new Date()) {
  const finalMain = context.finalMain === true;
  const allChecksPassed =
    diagnostics.length === S1_READINESS_CHECKS.length &&
    diagnostics.every((item) => item.status === 'PASS');
  const cg3Ready = finalMain && allChecksPassed && markerReady(CG3_MARKER, diagnostics);
  const lineReady = finalMain && allChecksPassed && markerReady(LINE_MARKER, diagnostics);
  const markers = [...(cg3Ready ? [CG3_MARKER] : []), ...(lineReady ? [LINE_MARKER] : [])];
  return {
    type: 'readiness.summary',
    workflow: 's1-convergence-acceptance',
    workflowVersion: 1,
    status:
      markers.length === 2 && diagnostics.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: diagnostics.filter((item) => item.status === 'PASS').length,
    failed: diagnostics.filter((item) => item.status === 'FAIL').length,
    markers,
    finalMain,
    entryCondition: markers.length === 2 ? 'S1_DEVELOPMENT_ACCEPTED' : 'NOT_READY',
  };
}

export function createS1Manifest(context, diagnostics, summary) {
  const checks = diagnostics.map((item) => ({
    id: item.id,
    dimension: item.dimension,
    status: item.status,
    durationMs: item.durationMs,
    boundaries: item.boundaries,
    ...(item.subchecks ? { subchecks: item.subchecks } : {}),
  }));
  const manifest = {
    schemaVersion: 1,
    phase: 'S1',
    repository: context.repository,
    commitSha: context.commitSha,
    finalMainSha: context.mainSha,
    expectedCommitSha: context.expectedCommitSha,
    run: { id: context.runId, attempt: context.attempt },
    flags: S1_FLAGS,
    markers: summary.markers,
    checks,
    dimensions: dimensions.map((name) => ({
      name,
      status: checks
        .filter((item) => item.dimension === name)
        .every((item) => item.status === 'PASS')
        ? 'PASS'
        : 'FAIL',
    })),
    artifacts: checks.map((item) => ({
      id: `check:${item.id}`,
      commitSha: context.commitSha,
      sha256: sha256(item),
    })),
  };
  assertValidS1Manifest(manifest);
  return manifest;
}

export function assertValidS1Manifest(manifest) {
  assertPiiSafeEvidence(manifest);
  if (manifest.schemaVersion !== 1 || manifest.phase !== 'S1')
    throw new TypeError('S1 manifest schema ไม่ถูกต้อง');
  if (
    Object.keys(manifest.flags ?? {}).length !== Object.keys(S1_FLAGS).length ||
    !Object.entries(S1_FLAGS).every(([key, value]) => manifest.flags?.[key] === value)
  )
    throw new TypeError('S1 manifest flags ไม่ปลอดภัย');
  const checks = manifest.checks ?? [];
  if (
    !/^[0-9a-f]{40}$/i.test(manifest.commitSha) ||
    !/^[0-9a-f]{40}$/i.test(manifest.finalMainSha) ||
    !/^[0-9a-f]{40}$/i.test(manifest.expectedCommitSha)
  )
    throw new TypeError('S1 manifest ต้องอ้าง commit SHA เต็มรูปแบบ');
  if (
    checks.length !== S1_READINESS_CHECKS.length ||
    new Set(checks.map((item) => item.id)).size !== checks.length ||
    checks.some((item) => !S1_READINESS_CHECKS.some((registered) => registered.id === item.id))
  )
    throw new TypeError('S1 manifest ต้องมี 20 checks ไม่ซ้ำกัน');
  const artifacts = manifest.artifacts ?? [];
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map((item) => item.id)).size !== artifacts.length
  )
    throw new TypeError('S1 manifest ต้องมี evidence artifact หนึ่งรายการต่อ check');
  for (const artifact of artifacts) {
    const check = checks.find((item) => `check:${item.id}` === artifact.id);
    if (!check || artifact.commitSha !== manifest.commitSha || artifact.sha256 !== sha256(check))
      throw new TypeError('S1 evidence artifact ไม่ตรงกับ check/commit');
  }
  const markers = manifest.markers ?? [];
  if (
    markers.some((marker) => ![CG3_MARKER, LINE_MARKER].includes(marker)) ||
    new Set(markers).size !== markers.length
  )
    throw new TypeError('S1 manifest มี marker ไม่ถูกต้อง');
  if (markers.length > 0) {
    if (
      manifest.commitSha !== manifest.finalMainSha ||
      manifest.commitSha !== manifest.expectedCommitSha
    )
      throw new TypeError('S1 marker ต้องออกจาก final main SHA เดียว');
    if (!checks.every((item) => item.status === 'PASS'))
      throw new TypeError('S1 marker ต้องมี 20 checks PASS');
  }
}

function executeCompositeCheck(check, execute) {
  const started = performance.now();
  const subchecks = [];
  for (const command of check.commands) {
    const result = execute({ ...check, checkId: check.id, command });
    subchecks.push({ command, status: result.status, durationMs: result.durationMs ?? null });
    if (result.status !== 'PASS') {
      return {
        id: check.id,
        dimension: check.dimension,
        status: 'FAIL',
        durationMs: Math.round(performance.now() - started),
        boundaries: check.boundaries,
        subchecks,
      };
    }
  }
  return {
    id: check.id,
    dimension: check.dimension,
    status: 'PASS',
    durationMs: Math.round(performance.now() - started),
    boundaries: check.boundaries,
    subchecks,
  };
}

export function runS1Readiness(options = {}) {
  const context = options.context ?? createS1Context(options.environment ?? process.env);
  const execute = options.executeCheck ?? executeReadinessCheck;
  const startedAt = options.now?.() ?? new Date();
  const diagnostics = S1_READINESS_CHECKS.map((item) => executeCompositeCheck(item, execute));
  const summary = s1Summary(context, diagnostics, startedAt);
  const manifest = createS1Manifest(context, diagnostics, summary);
  const evidencePath =
    options.evidencePath ?? resolve(repositoryRoot, 'artifacts', 's1', `${context.runId}.json`);
  if (options.writeManifest !== false) {
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  diagnostics.forEach((diagnostic) => emit({ type: 'readiness.check', ...diagnostic }));
  emit(summary);
  emit({
    type: 'evidence.manifest',
    path: evidencePath,
    sha256: sha256(manifest),
    markers: summary.markers,
  });
  return { context, diagnostics, summary, manifest, evidencePath };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const result = runS1Readiness();
  if (result.summary.status !== 'PASS') process.exitCode = 1;
}
