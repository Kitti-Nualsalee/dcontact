import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPiiSafeEvidence, sha256 } from './cxa-c1-readiness.mjs';
import { J3_FIXED_FLAGS, J3_OWNER_PROFILES } from './cxa-j3-profile-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export { assertPiiSafeEvidence, sha256, J3_FIXED_FLAGS, J3_OWNER_PROFILES };
export const J3_MARKER = 'JOURNEY_J3_ACCEPTED';
export const J3_WORKFLOW = Object.freeze({ name: 'cxa-j3-acceptance', version: 1 });
export const J3_DIMENSIONS = Object.freeze([
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
export const J3_CONTEXT_POINTERS = Object.freeze([
  '#202',
  '#203',
  '#204',
  '#206',
  '#207',
  '#208',
  '#209',
  '#222',
]);

const tests =
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
const customer360 = tests('@d-contact/customer-360');
const journey = tests('@d-contact/journey');
const api = tests('@d-contact/api');
const contracts = tests('@d-contact/cxa-contracts');
const db = [pnpm, '--filter', '@d-contact/db', 'test:integration'];
const profile = [process.execPath, 'scripts/cxa-j3-profile-readiness.mjs'];
const schema = [process.execPath, 'scripts/cxa-j3-schema-readiness.mjs'];

function check(id, dimension, dependency, boundaries, commands, extra = {}) {
  return {
    id,
    dimension,
    dependency,
    boundaries,
    commands,
    remediation: `แก้ ${id} ตาม #222`,
    ...extra,
  };
}

/** Registry คือ contract ของ #208: check เดียวอ้างได้หลาย suite แต่ suite เดียวรันได้ครั้งเดียว */
export const CXA_J3_READINESS_CHECKS = Object.freeze([
  check(
    'J3-F01',
    'functional',
    'Customer 360 canonical membership และ OUT→IN entry identity',
    ['definition immutable', 'membership/head/change/outbox atomic', 'OUT→IN only creates entry'],
    customer360(
      'segment-definition.test.ts',
      'segment-membership.integration.ts',
      'segment-repository.integration.ts',
    ),
  ),
  check(
    'J3-F02',
    'functional',
    'customer.segment.changed V1 และ owner read/reconcile contract',
    ['closed payload', 'resolveEntry statuses', 'ordered readChanges'],
    [
      ...contracts('segment-membership.test.ts'),
      ...customer360('segment-membership.integration.ts'),
      ...journey('journey-segment-consumer.integration.ts'),
    ],
  ),
  check(
    'J3-F03',
    'functional',
    'SEGMENT_ENTRY re-read และ immutable PII-safe enrollment reason',
    ['published version pinned', 'intent exactly once', 'no caller snapshot/raw attribute'],
    journey(
      'journey-segment-trigger-processor.integration.ts',
      'journey-segment-receipt-repository.integration.ts',
    ),
  ),
  check(
    'J3-F04',
    'functional',
    're-filter, correction และ merge/split ไม่ revive predecessor',
    ['LEFT/CORRECTED/refilter', 'barrier-aware cancellation', 'new canonical entry required'],
    journey(
      'journey-segment-refilter-processor.integration.ts',
      'journey-segment-baseline.integration.ts',
    ),
  ),
  check(
    'J3-TI01',
    'tenant-isolation',
    'two-tenant binding/RLS และ generic foreign result',
    ['tenant envelope/read/query/recovery', 'RLS all J3 tables', 'no foreign disclosure'],
    [
      ...db,
      ...api('journey-segment-recovery-api.integration.ts'),
      ...journey('journey-segment-consumer.integration.ts'),
    ],
  ),
  check(
    'J3-AU01',
    'authorization',
    'trusted current membership and WORK/CONTACT scope boundaries',
    ['receipt/refilter fail closed', 'current owner fact', 'outbound remains owner gate'],
    journey(
      'journey-segment-consumer.integration.ts',
      'journey-segment-refilter-processor.integration.ts',
    ),
  ),
  check(
    'J3-AU02',
    'authorization',
    'owner boundary and restrictive invalidation',
    ['no direct cross-owner write', 'IAM test adapter declared', 'relaxation cannot revive'],
    [...journey('journey-segment-refilter-processor.integration.ts'), profile],
    { evidencePrefix: 'CXA_J3_PROFILE_EVIDENCE:' },
  ),
  check(
    'J3-ID01',
    'idempotency',
    'transport/logical duplicate, hash conflict, correction and re-entry',
    ['same hash no-op', 'conflict quarantine', 'intent unique per entry/version'],
    journey(
      'journey-segment-receipt-repository.integration.ts',
      'journey-segment-consumer.integration.ts',
    ),
  ),
  check(
    'J3-ID02',
    'idempotency',
    'query/recovery command identity and original binding',
    ['ETag/Idempotency-Key', 'replay original identity', 'no partial stale apply'],
    [
      ...api('journey-segment-recovery-api.integration.ts'),
      ...journey('journey-segment-rollout.integration.ts'),
    ],
  ),
  check(
    'J3-CC01',
    'concurrency',
    'membership/outbox and multi-consumer lease/CAS head race',
    ['canonical winner', 'gap never skipped', 'one intent per entry/version'],
    [
      ...customer360('segment-membership.integration.ts'),
      ...journey('journey-segment-receipt-repository.integration.ts'),
    ],
  ),
  check(
    'J3-CC02',
    'concurrency',
    'invalidation races with enrollment and irreversible owner boundary',
    ['first terminal wins', 'pre-barrier cancel/release', 'post-barrier reconcile'],
    journey('journey-segment-refilter-processor.integration.ts'),
  ),
  check(
    'J3-RC01',
    'recovery',
    'crash/restart at durable owner boundaries',
    ['outbox/retry no loss', 'receipt/head recovery', 'no blind retry'],
    [
      ...customer360('segment-membership.integration.ts'),
      ...journey(
        'journey-segment-consumer.integration.ts',
        'journey-segment-rollout.integration.ts',
      ),
    ],
  ),
  check(
    'J3-RC02',
    'recovery',
    'reconcile/backfill/shadow/rebuild and forward-fix only',
    ['original identities', 'no offset/direct DB edit', 'rollback preserves facts'],
    journey('journey-segment-baseline.integration.ts', 'journey-segment-rollout.integration.ts'),
  ),
  check(
    'J3-MG01',
    'migration',
    'fresh and upgrade schema readiness',
    ['20 J3 tables', 'RLS/check/index/trigger', 'composite tenant binding'],
    [schema],
  ),
  check(
    'J3-OB01',
    'observability',
    'PII-safe evidence, durable owner profile and bounded diagnostics',
    ['owner profiles true', 'no raw PII/credentials', 'manifest digest'],
    [...api('journey-segment-recovery-api.integration.ts'), profile],
    { evidencePrefix: 'CXA_J3_PROFILE_EVIDENCE:' },
  ),
  check(
    'J3-REG01',
    'regression',
    'E0/C1/J1/Core plus merged J2/S1/CG3/CG4 paths on target SHA',
    ['no regression disabled', 'acceptance paths run', 'provider traffic stays disabled'],
    [[pnpm, 's1:acceptance'], [pnpm, 'cxa:j2:acceptance'], [pnpm, 'cxa:cg4:acceptance'], profile],
    { evidencePrefix: 'CXA_J3_PROFILE_EVIDENCE:' },
  ),
]);

const suiteKey = (command) => JSON.stringify(command);
export function j3SuitePlan(checks = CXA_J3_READINESS_CHECKS) {
  const suites = new Map();
  for (const item of checks)
    for (const command of item.commands) {
      const key = suiteKey(command);
      const existing = suites.get(key);
      if (existing) {
        if (!existing.checkIds.includes(item.id)) existing.checkIds.push(item.id);
        existing.evidencePrefix ??= item.evidencePrefix;
      } else
        suites.set(key, {
          id: `suite:${String(suites.size + 1).padStart(2, '0')}`,
          command,
          checkIds: [item.id],
          ...(item.evidencePrefix ? { evidencePrefix: item.evidencePrefix } : {}),
        });
    }
  return [...suites.values()];
}

export function parseTapSummary(output) {
  const total = (name) => {
    const values = [...String(output).matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, 'gm'))].map(
      (match) => Number(match[1]),
    );
    return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
  };
  const tests = total('tests');
  if (tests === undefined) return null;
  const passed = total('pass') ?? 0;
  const failed = total('fail') ?? 0;
  const cancelled = total('cancelled') ?? 0;
  const skipped = total('skipped') ?? 0;
  const todo = total('todo') ?? 0;
  const titles = [...String(output).matchAll(/^(?:not )?ok \d+ - (.+)$/gm)]
    .map((match) => match[1].trim())
    .sort();
  return {
    tests,
    passed,
    failed,
    cancelled,
    skipped,
    todo,
    titlesSha256: sha256(titles),
    clean: tests > 0 && failed === 0 && cancelled === 0 && skipped === 0 && todo === 0,
  };
}

function evidence(output, prefix) {
  if (!prefix) return [];
  return String(output)
    .split('\n')
    .flatMap((line) => {
      const at = line.indexOf(prefix);
      if (at < 0) return [];
      try {
        return [JSON.parse(line.slice(at + prefix.length))];
      } catch {
        return [];
      }
    });
}

export function executeJ3Suite(suite, runner = spawnSync) {
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
  const passed = result.status === 0 && !result.error && (tap === null || tap.clean);
  return {
    status: passed ? 'PASS' : 'FAIL',
    durationMs: Math.round(performance.now() - started),
    ...(tap ? { tap } : {}),
    ...(passed
      ? {
          ...(evidence(output, suite.evidencePrefix).length
            ? { evidence: evidence(output, suite.evidencePrefix) }
            : {}),
        }
      : { detail: output.slice(-4000) }),
  };
}

function git(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) throw new Error(`git ${arguments_.join(' ')} ล้มเหลว`);
  return String(result.stdout).trim();
}
function repositoryName(environment) {
  if (environment.GITHUB_REPOSITORY) return environment.GITHUB_REPOSITORY;
  const match = git(['config', '--get', 'remote.origin.url']).match(
    /(?:github\.com[/:])([^/]+\/[^/.]+)(?:\.git)?$/,
  );
  if (!match) throw new TypeError('ไม่สามารถระบุ repository สำหรับ J3 manifest');
  return match[1];
}
export function createJ3EvidenceContext(environment = process.env) {
  const repository = repositoryName(environment);
  const commitSha = git(['rev-parse', 'HEAD']);
  const finalMainSha = git(['rev-parse', 'origin/main']);
  const runId = environment.GITHUB_RUN_ID ?? `local-${randomUUID()}`;
  const attempt = Number(environment.GITHUB_RUN_ATTEMPT ?? 1);
  const runUrl = environment.GITHUB_RUN_ID
    ? `${environment.GITHUB_SERVER_URL ?? 'https://github.com'}/${repository}/actions/runs/${runId}/attempts/${attempt}`
    : null;
  return {
    repository,
    defaultBranch: 'main',
    ref: environment.GITHUB_REF ?? `refs/heads/${git(['rev-parse', '--abbrev-ref', 'HEAD'])}`,
    pullRequest: environment.GITHUB_PR_NUMBER ? Number(environment.GITHUB_PR_NUMBER) : null,
    baseSha: environment.CXA_J3_BASE_SHA ?? git(['merge-base', 'HEAD', 'origin/main']),
    commitSha,
    finalMainSha,
    expectedCommitSha: environment.CXA_J3_EXPECTED_COMMIT_SHA ?? finalMainSha,
    cleanTree: git(['status', '--porcelain', '--untracked-files=no']) === '',
    runId,
    attempt,
    runUrl,
    artifact: {
      name: `cxa-j3-evidence-${commitSha}`,
      url: runUrl ? `${runUrl}#artifacts` : null,
      immutable: runUrl !== null,
    },
  };
}
function migrationDigest() {
  const directory = resolve(repositoryRoot, 'packages/db/prisma/migrations');
  return sha256(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .map((name) => ({
        name,
        sha256: sha256(readFileSync(resolve(directory, name, 'migration.sql'), 'utf8')),
      })),
  );
}
export const j3RegistryDigest = (checks = CXA_J3_READINESS_CHECKS) =>
  sha256(
    checks.map(({ id, dimension, boundaries, commands }) => ({
      id,
      dimension,
      boundaries,
      commands: commands.map((command) =>
        command[0] === process.execPath ? ['node', ...command.slice(1)] : command,
      ),
    })),
  );
function profileEvidence(checks) {
  return checks
    .flatMap((check) => check.subchecks ?? [])
    .flatMap((subcheck) => subcheck.evidence ?? [])
    .find((item) => item?.type === 'owner-profile.readiness');
}
export function j3MarkerBlockers(context, checks) {
  const blockers = [];
  if (
    checks.length !== CXA_J3_READINESS_CHECKS.length ||
    checks.some((item) => item.status !== 'PASS')
  )
    blockers.push('CHECKS_NOT_ALL_PASS');
  if (context.pullRequest !== null) blockers.push('PULL_REQUEST_RUN');
  if (context.ref !== 'refs/heads/main') blockers.push('NOT_DEFAULT_BRANCH_REF');
  if (context.commitSha !== context.finalMainSha || context.commitSha !== context.expectedCommitSha)
    blockers.push('NOT_FINAL_MAIN_SHA');
  if (!context.cleanTree) blockers.push('DIRTY_TREE');
  if (!context.artifact?.immutable || !context.runUrl) blockers.push('ARTIFACT_NOT_IMMUTABLE');
  const owner = profileEvidence(checks);
  if (
    !owner ||
    JSON.stringify(owner.profiles) !== JSON.stringify(J3_OWNER_PROFILES) ||
    JSON.stringify(owner.flags) !== JSON.stringify(J3_FIXED_FLAGS)
  )
    blockers.push('OWNER_PROFILE_OR_FLAGS_MISMATCH');
  return blockers;
}
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
    };
  });
  return {
    id: item.id,
    dimension: item.dimension,
    status: subchecks.every((entry) => entry.status === 'PASS') ? 'PASS' : 'FAIL',
    boundaries: item.boundaries,
    subchecks,
  };
}
function summary(context, checks, startedAt) {
  const blockers = j3MarkerBlockers(context, checks);
  return {
    type: 'readiness.summary',
    workflow: J3_WORKFLOW.name,
    workflowVersion: J3_WORKFLOW.version,
    status: blockers.includes('CHECKS_NOT_ALL_PASS') ? 'FAIL' : 'PASS',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: checks.filter((item) => item.status === 'PASS').length,
    failed: checks.filter((item) => item.status !== 'PASS').length,
    markers: blockers.length === 0 ? [J3_MARKER] : [],
    markerBlockers: blockers,
    candidateOnly: blockers.length > 0,
    entryCondition: blockers.length === 0 ? J3_MARKER : 'NOT_READY',
    evidenceScope: 'J3 Development Complete only; provider traffic remains disabled',
  };
}
export function createCxaJ3EvidenceManifest(context, checks, readiness, suites, digests = {}) {
  const status = (id) => checks.find((item) => item.id === id)?.status ?? 'FAIL';
  const manifest = {
    schemaVersion: 1,
    phase: 'J3',
    evidenceType: 'development-acceptance',
    ...(readiness.markers.length ? { markers: readiness.markers } : {}),
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
    workflow: { ...J3_WORKFLOW },
    run: { id: context.runId, attempt: context.attempt, url: context.runUrl },
    artifact: { ...context.artifact },
    contextPointers: [...J3_CONTEXT_POINTERS],
    digests: {
      registry: digests.registry ?? j3RegistryDigest(),
      migrations: digests.migrations ?? migrationDigest(),
    },
    suites: suites.map(({ id, command, checkIds, status, durationMs, tap }) => ({
      id,
      command,
      checkIds: [...checkIds],
      status,
      durationMs: durationMs ?? null,
      ...(tap ? { tap: { ...tap } } : {}),
    })),
    checks,
    dimensions: J3_DIMENSIONS.map((name) => {
      const selected = checks.filter((item) => item.dimension === name);
      return {
        name,
        checks: selected.length,
        status:
          selected.length && selected.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL',
      };
    }),
    migration: { schemaReadiness: status('J3-MG01') },
    recovery: { restart: status('J3-RC01'), reconcileRollout: status('J3-RC02') },
    ownerProfiles: structuredClone(profileEvidence(checks)?.profiles ?? null),
    flags: { ...J3_FIXED_FLAGS },
    negativeScan: { suites: status('J3-OB01'), manifest: 'PASS' },
    artifacts: checks.map((item) => ({
      id: `check:${item.id}`,
      kind: 'readiness-diagnostic',
      commitSha: context.commitSha,
      sha256: sha256(item),
    })),
  };
  assertValidCxaJ3EvidenceManifest(manifest);
  return manifest;
}
const FULL_SHA = /^[0-9a-f]{40}$/i;
export function assertValidCxaJ3EvidenceManifest(manifest) {
  assertPiiSafeEvidence(manifest);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.phase !== 'J3' ||
    manifest.evidenceType !== 'development-acceptance'
  )
    throw new TypeError('J3 manifest มี schemaVersion/phase/evidenceType ไม่ถูกต้อง');
  for (const name of ['commitSha', 'finalMainSha', 'expectedCommitSha'])
    if (!FULL_SHA.test(manifest[name] ?? ''))
      throw new TypeError(`J3 manifest ต้องมี ${name} แบบ SHA เต็ม`);
  if (JSON.stringify(manifest.flags) !== JSON.stringify(J3_FIXED_FLAGS))
    throw new TypeError('J3 manifest flags ไม่ตรง fixed flags');
  const registered = new Map(CXA_J3_READINESS_CHECKS.map((item) => [item.id, item]));
  const checks = manifest.checks ?? [];
  if (
    checks.length !== registered.size ||
    new Set(checks.map((item) => item.id)).size !== checks.length
  )
    throw new TypeError('J3 manifest ต้องมี check ครบ 16 ตัวและไม่ซ้ำ');
  for (const item of checks)
    if (!registered.has(item.id) || registered.get(item.id).dimension !== item.dimension)
      throw new TypeError(`J3 manifest มี check/dimension ที่ไม่ตรง registry: ${item.id}`);
  const dimensions = manifest.dimensions ?? [];
  if (
    dimensions.length !== J3_DIMENSIONS.length ||
    J3_DIMENSIONS.some((name) => !(dimensions.find((item) => item.name === name)?.checks > 0))
  )
    throw new TypeError('J3 manifest ต้องมีครบ 9 dimensions และไม่มี dimension ว่าง');
  const suites = new Map((manifest.suites ?? []).map((suite) => [suite.id, suite]));
  if (!suites.size || suites.size !== (manifest.suites ?? []).length)
    throw new TypeError('J3 manifest ต้องมี suites id ไม่ซ้ำ');
  for (const item of checks) {
    const registeredCheck = registered.get(item.id);
    if ((item.subchecks ?? []).length !== registeredCheck.commands.length)
      throw new TypeError(`J3 check ${item.id} ต้องอ้าง suite ครบตาม registry`);
    for (const subcheck of item.subchecks) {
      const suite = suites.get(subcheck.suiteId);
      if (!suite || suite.status !== subcheck.status || !suite.checkIds.includes(item.id))
        throw new TypeError(`J3 check ${item.id} อ้าง suite ที่ไม่ตรงกับผลของ suite`);
    }
    const derived = item.subchecks.every((subcheck) => subcheck.status === 'PASS')
      ? 'PASS'
      : 'FAIL';
    if (item.status !== derived)
      throw new TypeError(`J3 check ${item.id} มี status ไม่ตรงกับ suite ที่อ้าง`);
  }
  for (const suite of suites.values()) {
    if (suite.tap && (!suite.tap.clean || !/^[0-9a-f]{64}$/.test(suite.tap.titlesSha256 ?? '')))
      throw new TypeError(`J3 suite ${suite.id} มี TAP summary ที่ไม่ผ่านหรือ digest ไม่ถูกต้อง`);
  }
  const artifacts = manifest.artifacts ?? [];
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map((item) => item.id)).size !== artifacts.length
  )
    throw new TypeError('J3 manifest ต้องมี evidence artifact หนึ่งรายการต่อ check');
  for (const artifact of artifacts) {
    const item = checks.find((check) => artifact.id === `check:${check.id}`);
    if (!item || artifact.commitSha !== manifest.commitSha || artifact.sha256 !== sha256(item))
      throw new TypeError('J3 evidence artifact ไม่ bind กับ check/commit/digest');
  }
  const markers = manifest.markers ?? [];
  if (markers.some((marker) => marker !== J3_MARKER) || new Set(markers).size !== markers.length)
    throw new TypeError('J3 manifest มี marker ไม่ถูกต้อง');
  if (!markers.length) return;
  if (
    checks.some((item) => item.status !== 'PASS') ||
    [...suites.values()].some((suite) => suite.status !== 'PASS')
  )
    throw new TypeError(`${J3_MARKER} ต้องมีทุก check/suite PASS`);
  if (manifest.pullRequest?.number !== null && manifest.pullRequest?.number !== undefined)
    throw new TypeError('PR run ออก J3 marker ไม่ได้');
  if (
    manifest.commitSha !== manifest.finalMainSha ||
    manifest.commitSha !== manifest.expectedCommitSha ||
    manifest.refProof?.ref !== 'refs/heads/main' ||
    manifest.refProof?.cleanTree !== true
  )
    throw new TypeError('J3 marker ต้องมาจาก clean final main SHA เดียว');
  if (
    manifest.artifact?.immutable !== true ||
    manifest.artifact?.name !== `cxa-j3-evidence-${manifest.commitSha}`
  )
    throw new TypeError('J3 marker ต้องอ้าง immutable CI artifact');
  if (JSON.stringify(manifest.ownerProfiles) !== JSON.stringify(J3_OWNER_PROFILES))
    throw new TypeError('J3 marker ต้องมี owner profiles ตรง contract');
}
export function runCxaJ3Readiness(options = {}) {
  const startedAt = options.now?.() ?? new Date();
  const context = options.context ?? createJ3EvidenceContext(options.environment ?? process.env);
  const executeSuite = options.executeSuite ?? executeJ3Suite;
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const suites = j3SuitePlan().map((plan) => {
    const suite = { ...plan, ...executeSuite(plan) };
    emit({
      type: 'readiness.suite',
      id: suite.id,
      command: suite.command,
      checkIds: suite.checkIds,
      status: suite.status,
      durationMs: suite.durationMs,
      ...(suite.tap ? { tap: suite.tap } : {}),
    });
    return suite;
  });
  const suiteByKey = new Map(suites.map((suite) => [suiteKey(suite.command), suite]));
  const checks = CXA_J3_READINESS_CHECKS.map((item) => {
    const result = composeCheck(item, suiteByKey);
    emit({ type: 'readiness.check', ...result });
    return result;
  });
  const readiness = summary(context, checks, startedAt);
  const manifest = createCxaJ3EvidenceManifest(context, checks, readiness, suites, options.digests);
  const evidencePath =
    options.evidencePath ?? resolve(repositoryRoot, 'artifacts', 'cxa-j3', `${context.runId}.json`);
  if (options.writeManifest !== false) {
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  }
  const manifestSha256 = sha256(manifest);
  emit(readiness);
  emit({
    type: 'evidence.manifest',
    path: evidencePath,
    sha256: manifestSha256,
    markers: readiness.markers,
    candidateOnly: readiness.candidateOnly,
    artifact: context.artifact,
    suites: suites.length,
  });
  return { context, suites, checks, summary: readiness, manifest, evidencePath, manifestSha256 };
}
const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = runCxaJ3Readiness();
    if (result.summary.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
