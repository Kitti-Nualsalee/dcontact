import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeReadinessCheck } from './phase-zero-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const CG2_MARKER = 'CG2_ACCEPTED';
export const J1_MARKER = 'J1_ACCEPTED';
export const CORE_MARKER = 'CX_AUTOMATION_CORE_ACCEPTED';
const C1_DIMENSIONS = [
  'functional',
  'tenant-isolation',
  'authorization',
  'idempotency',
  'concurrency',
  'recovery',
  'migration-compatibility',
  'observability-pii-redaction',
  'regression',
];

/**
 * แต่ละ check ประกาศว่ามี `markers` ใดที่ต้องรอผลของมัน — `CG2_ACCEPTED` และ
 * `J1_ACCEPTED` เป็น sub-marker ของ domain ตัวเอง ส่วน `CX_AUTOMATION_CORE_ACCEPTED`
 * ต้องรอทั้งสอง sub-marker บวก regression gate ของตัวเอง (ดู `cxaC1Summary`)
 */
export const CXA_C1_READINESS_CHECKS = [
  {
    id: 'cg2-functional',
    dimension: 'functional',
    markers: [CG2_MARKER],
    dependency: 'CG2 canonical Attempt/Touch และ reservation lease/submission/settlement runtime',
    boundaries: [
      'claim/renew/begin/confirm/release/settle',
      'canonical duplicate replay',
      'terminal outcome idempotent',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/contact-governance', 'test'],
      [pnpm, '--filter', '@d-contact/contact-governance', 'test:integration'],
    ],
    remediation: 'ตรวจ ReservationRuntime และ Attempt/Touch fixture ของ CG2 (C1.1/C1.2)',
  },
  {
    id: 'j1-functional',
    dimension: 'functional',
    markers: [J1_MARKER],
    dependency: 'J1 versioned definition, durable execution และ SEND/BRANCH composition',
    boundaries: [
      'publish idempotent',
      'graph entry/terminal/reachability',
      'SEND/WAIT/BRANCH node contract',
      'scope -> authorize -> enqueue',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/journey', 'test'],
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
      [pnpm, '--filter', '@d-contact/delivery', 'test'],
      [pnpm, '--filter', '@d-contact/delivery', 'test:integration'],
    ],
    remediation:
      'ตรวจ Journey definition/execution/send-composition และ Delivery test adapter (C1.3-C1.6)',
  },
  {
    id: 'tenant-isolation',
    dimension: 'tenant-isolation',
    markers: [CG2_MARKER, J1_MARKER],
    dependency: 'tenant RLS และ cross-tenant rejection ครอบคลุมตาราง C1 ใหม่ทั้งหมด',
    boundaries: ['two tenant fixture', 'cross-tenant ID swap', 'RLS policy ของตารางใหม่'],
    commands: [[pnpm, '--filter', '@d-contact/db', 'test:integration']],
    remediation:
      'ตรวจ RLS ของ jr_journey_definitions/dl_outbox_entries/jr_schedule_occurrences/jr_step_runs',
  },
  {
    id: 'authorization',
    dimension: 'authorization',
    markers: [J1_MARKER],
    dependency: 'trusted team scope ก่อน authorize/reserve เสมอ',
    boundaries: ['scope ALLOW/DENY', 'enqueue หลัง reservation binding เท่านั้น', 'fail closed'],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'ตรวจ JourneySendExecutor scope gate ก่อนเรียก Governance (C1.6)',
  },
  {
    id: 'idempotency',
    dimension: 'idempotency',
    markers: [CG2_MARKER, J1_MARKER],
    dependency: 'actionKey/reservation/delivery/publish idempotency',
    boundaries: ['duplicate replay', 'canonical conflict', 'retry ไม่ enqueue/settle ซ้ำ'],
    commands: [
      [pnpm, '--filter', '@d-contact/cxa-contracts', 'test'],
      [pnpm, '--filter', '@d-contact/contact-governance', 'test:integration'],
      [pnpm, '--filter', '@d-contact/delivery', 'test:integration'],
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
    ],
    remediation: 'ตรวจ idempotency ของ reservation command, delivery outbox และ Journey execution',
  },
  {
    id: 'concurrency',
    dimension: 'concurrency',
    markers: [CG2_MARKER, J1_MARKER],
    dependency: 'business effect เดียวภายใต้ concurrent claim/advance/enqueue',
    boundaries: [
      'two workers advance enrollment เดียวกัน',
      'concurrent enqueue เดียวกัน',
      'CAS/advisory lock',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
      [pnpm, '--filter', '@d-contact/delivery', 'test:integration'],
    ],
    remediation: 'ตรวจ concurrency ของ JourneyExecutionService และ DeliveryTestAdapter',
  },
  {
    id: 'recovery',
    dimension: 'recovery',
    markers: [CG2_MARKER, J1_MARKER],
    dependency: 'crash/restart/reconcile boundary',
    boundaries: [
      'submission barrier reconcile',
      'WAIT claim/restart',
      'provider timeout reconcile',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/delivery', 'test:integration'],
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
    ],
    remediation: 'ตรวจ reconcile sweeper ของ Delivery และ WAIT/claim ของ Journey',
  },
  {
    id: 'migration-compatibility',
    dimension: 'migration-compatibility',
    markers: [CG2_MARKER, J1_MARKER],
    dependency: 'schema migration ครอบคลุมตาราง C1 ใหม่ทั้งหมด',
    boundaries: ['fresh migration', 'canonical table/RLS/policy lock'],
    commands: [[process.execPath, 'scripts/cxa-schema-readiness.mjs']],
    remediation:
      'ตรวจ cxa-schema-readiness ครอบคลุม jr_journey_definitions/dl_outbox_entries/jr_schedule_occurrences/jr_step_runs',
  },
  {
    id: 'observability-pii-redaction',
    dimension: 'observability-pii-redaction',
    markers: [CG2_MARKER, J1_MARKER],
    dependency: 'evidence ของ outbox/enrollment ไม่มี raw PII และ adapter เป็น TEST_ADAPTER',
    boundaries: [
      'no raw PII ใน outbox evidence',
      'no PII ใน enrollment evidence',
      'adapter profile TEST_ADAPTER',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/delivery', 'test:integration'],
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
      [process.execPath, 'scripts/cxa-c1-profile-readiness.mjs'],
    ],
    evidencePrefix: 'CXA_C1_ADAPTER_PROFILE_EVIDENCE:',
    remediation: 'ตรวจ evidence ของ Delivery outbox และ Journey enrollment ไม่มี PII',
  },
  {
    id: 'regression',
    dimension: 'regression',
    markers: [CORE_MARKER],
    dependency: 'root build/typecheck/lint, E0 acceptance และ Inbound Voice regression',
    boundaries: ['root build', 'root typecheck', 'root lint', 'E0 acceptance', 'Inbound Voice'],
    commands: [
      [pnpm, 'build'],
      [pnpm, 'typecheck'],
      [pnpm, 'lint'],
      [pnpm, 'cxa:e0:acceptance'],
      [pnpm, 'voice:acceptance'],
    ],
    remediation: 'แก้ build/typecheck/lint หรือ E0/Inbound Voice regression ก่อนยอมรับ C1',
  },
];

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function sha256(value) {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

const sensitiveKey =
  /^(?:(?:access|refresh|id)_token|authorization|password|passwd|secret|client_secret|phone(?:Number)?|email(?:Address)?|contact(?:Ref|Id)?|line(?:Id)?|crm(?:Id)?|identity(?:Id|Ref)?)$/i;
const sensitiveValue = [
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
  /(?:\+?66|0)\d{8,9}\b/,
  /(?:postgres(?:ql)?|redis|https?):\/\/[^:\s/@]+:[^@\s/]+@/i,
];

export function assertPiiSafeEvidence(value) {
  const visit = (candidate, path = '$', fieldName = '') => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`, fieldName));
      return;
    }
    if (candidate && typeof candidate === 'object') {
      for (const [key, nested] of Object.entries(candidate)) {
        if (sensitiveKey.test(key))
          throw new TypeError(`evidence มี field ต้องห้าม: ${path}.${key}`);
        visit(nested, `${path}.${key}`, key);
      }
      return;
    }
    const isDigestOrCommit = /^(?:sha256|commitSha|baseSha)$/i.test(fieldName);
    if (
      !isDigestOrCommit &&
      typeof candidate === 'string' &&
      sensitiveValue.some((pattern) => pattern.test(candidate))
    ) {
      throw new TypeError(`evidence มี PII หรือ credential ที่ตำแหน่ง ${path}`);
    }
  };
  visit(value);
}

function runGit(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${arguments_.join(' ')} ล้มเหลว`);
  }
  return String(result.stdout).trim();
}

function repositoryName(environment) {
  if (environment.GITHUB_REPOSITORY) return environment.GITHUB_REPOSITORY;
  const remote = runGit(['config', '--get', 'remote.origin.url']);
  const match = remote.match(/(?:github\.com[/:])([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match) throw new TypeError('ไม่สามารถระบุ repository สำหรับ evidence manifest');
  return match[1];
}

export function createEvidenceContext(environment = process.env) {
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const expectedCommitSha = environment.CXA_C1_EXPECTED_COMMIT_SHA;
  if (expectedCommitSha && expectedCommitSha !== commitSha) {
    throw new TypeError('CXA_C1_EXPECTED_COMMIT_SHA ไม่ตรงกับ commit ที่กำลังรัน');
  }
  return {
    repository: repositoryName(environment),
    pullRequest: environment.GITHUB_PR_NUMBER ? Number(environment.GITHUB_PR_NUMBER) : null,
    baseSha: environment.CXA_C1_BASE_SHA ?? runGit(['merge-base', 'HEAD', 'origin/main']),
    commitSha,
    runId: environment.GITHUB_RUN_ID ?? `local-${randomUUID()}`,
    attempt: Number(environment.GITHUB_RUN_ATTEMPT ?? 1),
  };
}

function toManifestCheck(diagnostic) {
  return {
    id: diagnostic.checkId,
    dimension: diagnostic.dimension,
    markers: diagnostic.markers,
    status: diagnostic.status,
    durationMs: diagnostic.durationMs ?? null,
    boundaries: diagnostic.boundaries,
    ...(diagnostic.subchecks ? { subchecks: diagnostic.subchecks } : {}),
    ...(diagnostic.evidence ? { evidence: diagnostic.evidence } : {}),
  };
}

/** marker หนึ่งตัวพร้อมก็ต่อเมื่อ check ทุกตัวที่ประกาศ marker นั้นไว้ผ่านหมด */
function markerReady(markerName, diagnostics) {
  const relevant = CXA_C1_READINESS_CHECKS.filter((check) => check.markers.includes(markerName));
  return (
    relevant.length > 0 &&
    relevant.every((check) =>
      diagnostics.some(
        (diagnostic) => diagnostic.checkId === check.id && diagnostic.status === 'PASS',
      ),
    )
  );
}

export function cxaC1Summary(diagnostics, startedAt = new Date()) {
  const failed = diagnostics.filter(({ status }) => status === 'FAIL');
  const cg2Ready = markerReady(CG2_MARKER, diagnostics);
  const j1Ready = markerReady(J1_MARKER, diagnostics);
  const coreReady = cg2Ready && j1Ready && markerReady(CORE_MARKER, diagnostics);
  const markers = [
    ...(cg2Ready ? [CG2_MARKER] : []),
    ...(j1Ready ? [J1_MARKER] : []),
    ...(coreReady ? [CORE_MARKER] : []),
  ];
  return {
    type: 'readiness.summary',
    workflow: 'cx-automation-c1-acceptance',
    workflowVersion: 1,
    status: coreReady && failed.length === 0 ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: diagnostics.filter(({ status }) => status === 'PASS').length,
    failed: failed.length,
    skipped: diagnostics.filter(({ status }) => status === 'SKIP').length,
    markers,
    entryCondition: coreReady ? CORE_MARKER : 'NOT_READY',
    evidenceScope: 'development acceptance baseline; provider traffic remains disabled',
  };
}

export function createCxaC1EvidenceManifest(context, diagnostics, summary) {
  const checks = diagnostics.map(toManifestCheck);
  const artifacts = checks.map((check) => ({
    id: `check:${check.id}`,
    kind: 'readiness-diagnostic',
    commitSha: context.commitSha,
    sha256: sha256(check),
  }));
  const manifest = {
    schemaVersion: 1,
    phase: 'C1',
    ...(summary.markers.length > 0 ? { markers: summary.markers } : {}),
    repository: context.repository,
    pullRequest: { number: context.pullRequest, baseSha: context.baseSha },
    commitSha: context.commitSha,
    run: { id: context.runId, attempt: context.attempt },
    contractVersions: {
      customerContext: 1,
      teamContactScope: 1,
      contactGovernance: 1,
      delivery: 1,
      journeyDefinition: 1,
      expression: 'DC_EXPR:1',
      kafkaEnvelope: 2,
    },
    dimensions: C1_DIMENSIONS.map((dimension) => ({
      name: dimension,
      status: checks
        .filter((check) => check.dimension === dimension)
        .every((check) => check.status === 'PASS')
        ? 'PASS'
        : 'FAIL',
    })),
    checks,
    migration: {
      status: checks.find((check) => check.id === 'migration-compatibility')?.status ?? 'FAIL',
      canonicalTables: 'cxa-schema-readiness',
    },
    artifacts,
  };
  assertValidCxaC1EvidenceManifest(manifest);
  return manifest;
}

export function assertValidCxaC1EvidenceManifest(manifest) {
  assertPiiSafeEvidence(manifest);
  if (manifest.phase !== 'C1' || manifest.schemaVersion !== 1) {
    throw new TypeError('evidence manifest มี phase หรือ schemaVersion ไม่ถูกต้อง');
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.commitSha)) {
    throw new TypeError('evidence manifest ต้องมี commit SHA เต็มรูปแบบ');
  }
  const declaredMarkers = manifest.markers ?? [];
  for (const marker of declaredMarkers) {
    if (![CG2_MARKER, J1_MARKER, CORE_MARKER].includes(marker)) {
      throw new TypeError('evidence manifest มี marker ไม่ถูกต้อง');
    }
  }
  const checks = manifest.checks ?? [];
  const artifacts = manifest.artifacts ?? [];
  for (const artifact of artifacts) {
    if (artifact.commitSha !== manifest.commitSha) {
      throw new TypeError('evidence artifact อ้าง commit ไม่ตรงกับ manifest');
    }
    const checkId = String(artifact.id).replace(/^check:/, '');
    const check = checks.find(({ id }) => id === checkId);
    if (!check || artifact.sha256 !== sha256(check)) {
      throw new TypeError('SHA-256 ของ evidence artifact ไม่ตรงกับ check');
    }
  }
  if (!declaredMarkers.includes(CORE_MARKER)) return;

  if (checks.length !== CXA_C1_READINESS_CHECKS.length) {
    throw new TypeError('marker ต้องมี check ครบทุกตัวของ C1 acceptance matrix');
  }
  const allChecksPassed = checks.every((check) => check.status === 'PASS');
  if (!allChecksPassed) {
    throw new TypeError('CX_AUTOMATION_CORE_ACCEPTED ต้องมี check ทุกตัว PASS');
  }
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map(({ id }) => id)).size !== checks.length
  ) {
    throw new TypeError('marker ต้องมี evidence artifact หนึ่งรายการต่อ check');
  }
  const adapterProfileEvidence = checks
    .find(({ id }) => id === 'observability-pii-redaction')
    ?.subchecks?.flatMap(({ evidence = [] }) => evidence)
    .some(
      (evidence) =>
        evidence?.type === 'adapter-profile.readiness' &&
        evidence.adapterProfile === 'TEST_ADAPTER' &&
        evidence.actualProviderTraffic === false,
    );
  if (!adapterProfileEvidence) {
    throw new TypeError('marker ต้องมี evidence ว่า TEST_ADAPTER ปิด actual provider traffic');
  }
}

function executeCompositeCheck(check, executeCheck) {
  const startedAt = new Date();
  const started = performance.now();
  const subchecks = [];
  for (const command of check.commands) {
    const result = executeCheck({ ...check, checkId: undefined, command });
    subchecks.push({
      command,
      status: result.status,
      durationMs: result.durationMs,
      ...(result.evidence ? { evidence: result.evidence } : {}),
    });
    if (result.status === 'FAIL') {
      return {
        checkId: check.id,
        dimension: check.dimension,
        markers: check.markers,
        dependency: check.dependency,
        boundaries: check.boundaries,
        status: 'FAIL',
        startedAt: startedAt.toISOString(),
        durationMs: Math.round(performance.now() - started),
        subchecks,
        remediation: check.remediation,
      };
    }
  }
  return {
    checkId: check.id,
    dimension: check.dimension,
    markers: check.markers,
    dependency: check.dependency,
    boundaries: check.boundaries,
    status: 'PASS',
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    subchecks,
  };
}

function defaultEvidencePath(context) {
  return resolve(repositoryRoot, 'artifacts', 'cxa-c1', `${context.runId}.json`);
}

export function runCxaC1Readiness(options = {}) {
  const startedAt = options.now?.() ?? new Date();
  const context = options.context ?? createEvidenceContext(options.environment ?? process.env);
  const checks = options.checks ?? CXA_C1_READINESS_CHECKS;
  const executeCheck = options.executeCheck ?? executeReadinessCheck;
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const diagnostics = checks.map((check) => {
    const diagnostic = executeCompositeCheck(check, executeCheck);
    emit({ type: 'readiness.check', ...diagnostic });
    return diagnostic;
  });
  const summary = cxaC1Summary(diagnostics, startedAt);
  const manifest = createCxaC1EvidenceManifest(context, diagnostics, summary);
  const evidencePath = options.evidencePath ?? defaultEvidencePath(context);
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
  });
  return { context, diagnostics, summary, manifest, evidencePath, manifestSha256 };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = runCxaC1Readiness();
    if (result.summary.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
