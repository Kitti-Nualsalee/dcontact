import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  assertPiiSafeEvidence,
  createJ3EvidenceContext,
  CXA_J3_READINESS_CHECKS,
  executeJ3Suite,
  j3SuitePlan,
  sha256,
} from './cxa-j3-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOCUSED_CHECK_ID = 'J3-REG01';

/**
 * Candidate gate สำหรับรอบพัฒนา: รันเฉพาะ behavior ของ J3 ก่อน
 * full convergence และ marker ยังคงเป็นหน้าที่ของ cxa:j3:acceptance เท่านั้น
 */
export const CXA_J3_FOCUSED_CHECKS = Object.freeze(
  CXA_J3_READINESS_CHECKS.filter((check) => check.id !== FOCUSED_CHECK_ID),
);

export const J3_FOCUSED_DIMENSIONS = Object.freeze([
  ...new Set(CXA_J3_FOCUSED_CHECKS.map((check) => check.dimension)),
]);

function suiteKey(command) {
  return JSON.stringify(command);
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
    status: subchecks.every((subcheck) => subcheck.status === 'PASS') ? 'PASS' : 'FAIL',
    boundaries: item.boundaries,
    subchecks,
  };
}

export function j3FocusedSuitePlan(checks = CXA_J3_FOCUSED_CHECKS) {
  return j3SuitePlan(checks);
}

export function createCxaJ3FocusedEvidenceManifest(context, checks, suites) {
  const manifest = {
    schemaVersion: 1,
    phase: 'J3',
    evidenceType: 'candidate-preflight',
    candidateScope: 'J3-focused',
    excludes: [FOCUSED_CHECK_ID],
    markerEligible: false,
    markers: [],
    repository: context.repository,
    commitSha: context.commitSha,
    ref: context.ref,
    // Candidate evidence ใช้ run ID เพื่อย้อนกลับไปหน้า Actions ได้ โดยไม่ต้องคัดลอก URL
    // ที่อาจมีเลขบังเอิญตรงรูปแบบ PII เข้ามาใน evidence bundle.
    run: { id: context.runId, attempt: context.attempt },
    artifact: { name: context.artifact.name },
    suites: suites.map(({ id, command, checkIds, status, durationMs, tap }) => ({
      id,
      command,
      checkIds: [...checkIds],
      status,
      durationMs: durationMs ?? null,
      ...(tap ? { tap: { ...tap } } : {}),
    })),
    checks,
    dimensions: J3_FOCUSED_DIMENSIONS.map((name) => {
      const selected = checks.filter((check) => check.dimension === name);
      return {
        name,
        checks: selected.length,
        status: selected.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL',
      };
    }),
  };
  assertValidCxaJ3FocusedEvidenceManifest(manifest);
  return manifest;
}

export function assertValidCxaJ3FocusedEvidenceManifest(manifest) {
  assertPiiSafeEvidence(manifest);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.phase !== 'J3' ||
    manifest.evidenceType !== 'candidate-preflight' ||
    manifest.candidateScope !== 'J3-focused' ||
    manifest.markerEligible !== false ||
    JSON.stringify(manifest.excludes) !== JSON.stringify([FOCUSED_CHECK_ID]) ||
    JSON.stringify(manifest.markers) !== JSON.stringify([]) ||
    Object.hasOwn(manifest.run ?? {}, 'url') ||
    Object.hasOwn(manifest.artifact ?? {}, 'url')
  )
    throw new TypeError('J3 focused manifest มี scope หรือ marker policy ไม่ถูกต้อง');

  const registered = new Map(CXA_J3_FOCUSED_CHECKS.map((check) => [check.id, check]));
  const checks = manifest.checks ?? [];
  if (
    checks.length !== registered.size ||
    new Set(checks.map((check) => check.id)).size !== checks.length ||
    checks.some((check) => !registered.has(check.id) || check.id === FOCUSED_CHECK_ID)
  )
    throw new TypeError('J3 focused manifest ต้องมี 15 J3 checks และห้ามมี J3-REG01');

  const suites = new Map((manifest.suites ?? []).map((suite) => [suite.id, suite]));
  if (!suites.size || suites.size !== (manifest.suites ?? []).length)
    throw new TypeError('J3 focused manifest ต้องมี suites id ไม่ซ้ำ');
  for (const suite of suites.values()) {
    if (suite.tap && (!suite.tap.clean || !/^[0-9a-f]{64}$/.test(suite.tap.titlesSha256 ?? '')))
      throw new TypeError(
        `J3 focused suite ${suite.id} มี TAP summary ที่ไม่ผ่านหรือ digest ไม่ถูกต้อง`,
      );
  }
  for (const check of checks) {
    const registeredCheck = registered.get(check.id);
    if (
      check.dimension !== registeredCheck.dimension ||
      check.subchecks?.length !== registeredCheck.commands.length
    )
      throw new TypeError(`J3 focused check ${check.id} ไม่ตรง registry`);
    const derived = check.subchecks.every((subcheck) => {
      const suite = suites.get(subcheck.suiteId);
      return suite && suite.status === subcheck.status && suite.checkIds.includes(check.id);
    })
      ? check.subchecks.every((subcheck) => subcheck.status === 'PASS')
        ? 'PASS'
        : 'FAIL'
      : null;
    if (derived === null || check.status !== derived)
      throw new TypeError(`J3 focused check ${check.id} มี status ไม่ตรงกับ suite ที่อ้าง`);
  }
}

export function runCxaJ3FocusedReadiness(options = {}) {
  const startedAt = options.now?.() ?? new Date();
  const context = options.context ?? createJ3EvidenceContext(options.environment ?? process.env);
  const executeSuite = options.executeSuite ?? executeJ3Suite;
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const suites = j3FocusedSuitePlan().map((plan) => {
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
  const checks = CXA_J3_FOCUSED_CHECKS.map((item) => {
    const result = composeCheck(item, suiteByKey);
    emit({ type: 'readiness.check', ...result });
    return result;
  });
  const summary = {
    type: 'readiness.summary',
    workflow: 'cxa-j3-focused',
    workflowVersion: 1,
    status: checks.every((check) => check.status === 'PASS') ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: checks.filter((check) => check.status === 'PASS').length,
    failed: checks.filter((check) => check.status !== 'PASS').length,
    markers: [],
    markerBlockers: ['FOCUSED_CANDIDATE_ONLY', 'J3_REGRESSION_NOT_RUN'],
    candidateOnly: true,
    entryCondition: 'NOT_READY',
    evidenceScope:
      'J3-focused candidate only; S1/J2/CG4 regression and JOURNEY_J3_ACCEPTED excluded',
  };
  const manifest = createCxaJ3FocusedEvidenceManifest(context, checks, suites);
  const evidencePath =
    options.evidencePath ??
    resolve(repositoryRoot, 'artifacts', 'cxa-j3-focused', `${context.runId}.json`);
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
    markers: [],
    candidateOnly: true,
    artifact: context.artifact,
    suites: suites.length,
  });
  return { context, suites, checks, summary, manifest, evidencePath, manifestSha256 };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = runCxaJ3FocusedReadiness();
    if (result.summary.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
