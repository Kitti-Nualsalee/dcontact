import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeReadinessCheck } from './phase-zero-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const E0_MARKER = 'CX_AUTOMATION_E0_CONTRACTS_ACCEPTED';
const E0_DIMENSIONS = [
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

export const CXA_E0_READINESS_CHECKS = [
  {
    id: 'functional',
    dimension: 'functional',
    dependency: 'E0 contracts and DC_EXPR V1',
    boundaries: [
      'resolved/ambiguous/not-found',
      'scope allow/deny',
      'expression true/false/error',
      'reservation/delivery transition',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/cxa-contracts', 'test'],
      [pnpm, '--filter', '@d-contact/expression', 'test'],
      [pnpm, '--filter', '@d-contact/contact-governance', 'test'],
    ],
    remediation: 'Check the CXA contract fixture and DC_EXPR V1 conformance',
  },
  {
    id: 'tenant-isolation',
    dimension: 'tenant-isolation',
    dependency: 'tenant RLS and cross-tenant rejection',
    boundaries: ['two tenant fixture', 'cross-tenant ID swap', 'reservation/scope fail closed'],
    commands: [[pnpm, '--filter', '@d-contact/db', 'test:integration']],
    remediation: 'Check RLS, tenant context and cross-tenant mutation/read rejection',
  },
  {
    id: 'authorization',
    dimension: 'authorization',
    dependency: 'trusted Customer Context and Team scope before Governance',
    boundaries: ['caller-provided membership is not trusted', 'scope allow/deny', 'fail closed'],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'Check the Journey scope gate and the composition adapter before Governance',
  },
  {
    id: 'idempotency',
    dimension: 'idempotency',
    dependency: 'stable action/event/delivery identities',
    boundaries: ['duplicate replay', 'canonical conflict', 'outcome/enqueue idempotency'],
    commands: [
      [pnpm, '--filter', '@d-contact/contact-governance', 'test:integration'],
      [pnpm, '--filter', '@d-contact/kafka', 'test'],
    ],
    remediation: 'Check the Kafka idempotency contract and stable action/delivery identity',
  },
  {
    id: 'concurrency',
    dimension: 'concurrency',
    dependency: 'single business effect under concurrent claims/events',
    boundaries: ['concurrent event', 'reservation/delivery claim', 'one durable effect'],
    commands: [[pnpm, '--filter', '@d-contact/cxa-contracts', 'test']],
    remediation: 'Check concurrent claim/enqueue conformance and conflict behavior',
  },
  {
    id: 'recovery',
    dimension: 'recovery',
    dependency: 'crash/restart/reconcile boundary',
    boundaries: ['crash before/after commit', 'restart duplicate', 'provider timeout reconcile'],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'Check the durable Journey consumer, rollback and the provider reconcile fixture',
  },
  {
    id: 'migration-compatibility',
    dimension: 'migration-compatibility',
    dependency: 'schema migration and Kafka V1/V2 rollback decoder',
    boundaries: [
      'existing/fresh migration',
      'V1 legacy decode',
      'V2 validation',
      'unknown version DLQ',
    ],
    commands: [
      [process.execPath, 'scripts/cxa-schema-readiness.mjs'],
      [pnpm, '--filter', '@d-contact/kafka', 'test'],
    ],
    remediation: 'Check the fresh migration and the V1/V2 compatibility/rollback decoder',
  },
  {
    id: 'observability-pii-redaction',
    dimension: 'observability-pii-redaction',
    dependency: 'trace metadata and non-PII Journey ingress',
    boundaries: ['correlation/causation', 'reason code/version', 'no raw PII key/header/log'],
    commands: [
      [pnpm, '--filter', '@d-contact/journey', 'test'],
      [process.execPath, 'scripts/cxa-e0-profile-readiness.mjs'],
    ],
    evidencePrefix: 'CXA_E0_ADAPTER_PROFILE_EVIDENCE:',
    remediation:
      'Check the Journey Kafka key/header/log and an adapter profile with no provider traffic',
  },
  {
    id: 'regression',
    dimension: 'regression',
    dependency: 'CXA Foundation and Inbound Voice critical regression',
    boundaries: [
      'root build',
      'root typecheck',
      'root lint',
      'CX Automation Phase 1',
      'Inbound Voice',
    ],
    commands: [
      [pnpm, 'build'],
      [pnpm, 'typecheck'],
      [pnpm, 'lint'],
      [pnpm, 'cxa:phase1:acceptance'],
    ],
    remediation: 'Fix build/typecheck/lint or the CXA/Inbound Voice regression before accepting E0',
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
          throw new TypeError(`evidence has a forbidden field: ${path}.${key}`);
        visit(nested, `${path}.${key}`, key);
      }
      return;
    }
    const isDigestOrCommit = /^(?:sha256|commitSha|baseSha)$/i.test(fieldName);
    // The GitHub Actions run ID is evidence bundle metadata, not a business identifier,
    // so it may coincidentally look like a Thai phone number
    const isGitHubActionsRunId = path === '$.run.id';
    if (
      !isDigestOrCommit &&
      !isGitHubActionsRunId &&
      typeof candidate === 'string' &&
      sensitiveValue.some((pattern) => pattern.test(candidate))
    ) {
      throw new TypeError(`evidence has PII or a credential at ${path}`);
    }
  };
  visit(value);
}

function runGit(arguments_) {
  const result = spawnSync('git', arguments_, { cwd: repositoryRoot, encoding: 'utf8' });
  if (result.status !== 0 || result.error) {
    throw new Error(`git ${arguments_.join(' ')} failed`);
  }
  return String(result.stdout).trim();
}

function repositoryName(environment) {
  if (environment.GITHUB_REPOSITORY) return environment.GITHUB_REPOSITORY;
  const remote = runGit(['config', '--get', 'remote.origin.url']);
  const match = remote.match(/(?:github\.com[/:])([^/]+\/[^/.]+)(?:\.git)?$/);
  if (!match) throw new TypeError('cannot determine the repository for the evidence manifest');
  return match[1];
}

export function createEvidenceContext(environment = process.env) {
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const expectedCommitSha = environment.CXA_E0_EXPECTED_COMMIT_SHA;
  if (expectedCommitSha && expectedCommitSha !== commitSha) {
    throw new TypeError('CXA_E0_EXPECTED_COMMIT_SHA does not match the running commit');
  }
  return {
    repository: repositoryName(environment),
    pullRequest: environment.GITHUB_PR_NUMBER ? Number(environment.GITHUB_PR_NUMBER) : null,
    baseSha: environment.CXA_E0_BASE_SHA ?? runGit(['merge-base', 'HEAD', 'origin/main']),
    commitSha,
    runId: environment.GITHUB_RUN_ID ?? `local-${randomUUID()}`,
    attempt: Number(environment.GITHUB_RUN_ATTEMPT ?? 1),
  };
}

function toManifestCheck(diagnostic) {
  return {
    id: diagnostic.checkId,
    dimension: diagnostic.dimension,
    status: diagnostic.status,
    durationMs: diagnostic.durationMs ?? null,
    boundaries: diagnostic.boundaries,
    ...(diagnostic.subchecks ? { subchecks: diagnostic.subchecks } : {}),
    ...(diagnostic.evidence ? { evidence: diagnostic.evidence } : {}),
  };
}

export function cxaE0Summary(diagnostics, startedAt = new Date()) {
  const failed = diagnostics.filter(({ status }) => status === 'FAIL');
  const mandatoryPassed = E0_DIMENSIONS.every((dimension) =>
    diagnostics.some(
      (diagnostic) => diagnostic.dimension === dimension && diagnostic.status === 'PASS',
    ),
  );
  const missingOrIncomplete = E0_DIMENSIONS.filter(
    (dimension) =>
      !diagnostics.some(
        (diagnostic) => diagnostic.dimension === dimension && diagnostic.status === 'PASS',
      ),
  );
  return {
    type: 'readiness.summary',
    workflow: 'cx-automation-e0-acceptance',
    workflowVersion: 1,
    status: mandatoryPassed && failed.length === 0 ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: diagnostics.filter(({ status }) => status === 'PASS').length,
    failed: failed.length + missingOrIncomplete.length,
    skipped: diagnostics.filter(({ status }) => status === 'SKIP').length,
    entryCondition: mandatoryPassed && failed.length === 0 ? E0_MARKER : 'NOT_READY',
    evidenceScope: 'development acceptance baseline; provider traffic remains disabled',
  };
}

export function createCxaE0EvidenceManifest(context, diagnostics, summary) {
  const checks = diagnostics.map(toManifestCheck);
  const artifacts = checks.map((check) => ({
    id: `check:${check.id}`,
    kind: 'readiness-diagnostic',
    commitSha: context.commitSha,
    sha256: sha256(check),
  }));
  const manifest = {
    schemaVersion: 1,
    phase: 'E0',
    ...(summary.status === 'PASS' ? { marker: E0_MARKER } : {}),
    repository: context.repository,
    pullRequest: { number: context.pullRequest, baseSha: context.baseSha },
    commitSha: context.commitSha,
    run: { id: context.runId, attempt: context.attempt },
    contractVersions: {
      customerContext: 1,
      teamContactScope: 1,
      contactGovernance: 1,
      delivery: 1,
      expression: 'DC_EXPR:1',
      kafkaEnvelope: 2,
    },
    dimensions: E0_DIMENSIONS.map((dimension) => ({
      name: dimension,
      status: checks.find((check) => check.dimension === dimension)?.status ?? 'FAIL',
    })),
    checks,
    migration: {
      status: checks.find((check) => check.id === 'migration-compatibility')?.status ?? 'FAIL',
      existingAndFreshSchema: 'migration-compatibility',
    },
    rollback: {
      status: checks.find((check) => check.id === 'migration-compatibility')?.status ?? 'FAIL',
      decoder: 'Kafka V1_LEGACY compatibility',
    },
    artifacts,
  };
  assertValidEvidenceManifest(manifest);
  return manifest;
}

export function assertValidEvidenceManifest(manifest) {
  assertPiiSafeEvidence(manifest);
  if (manifest.phase !== 'E0' || manifest.schemaVersion !== 1) {
    throw new TypeError('evidence manifest has an invalid phase or schemaVersion');
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.commitSha)) {
    throw new TypeError('evidence manifest must have a full commit SHA');
  }
  if (manifest.marker !== undefined && manifest.marker !== E0_MARKER) {
    throw new TypeError('evidence manifest has an invalid marker');
  }
  const checks = manifest.checks ?? [];
  const artifacts = manifest.artifacts ?? [];
  for (const artifact of artifacts) {
    if (artifact.commitSha !== manifest.commitSha) {
      throw new TypeError('evidence artifact references a commit that does not match the manifest');
    }
    const checkId = String(artifact.id).replace(/^check:/, '');
    const check = checks.find(({ id }) => id === checkId);
    if (!check || artifact.sha256 !== sha256(check)) {
      throw new TypeError('SHA-256 of the evidence artifact does not match the check');
    }
  }
  if (manifest.marker !== E0_MARKER) return;

  const dimensions = manifest.dimensions ?? [];
  const mandatoryChecksPassed = E0_DIMENSIONS.every(
    (dimension) =>
      dimensions.filter(({ name }) => name === dimension).length === 1 &&
      dimensions.find(({ name }) => name === dimension)?.status === 'PASS' &&
      checks.filter((check) => check.dimension === dimension).length === 1 &&
      checks.find((check) => check.dimension === dimension)?.status === 'PASS',
  );
  if (!mandatoryChecksPassed || checks.length !== E0_DIMENSIONS.length) {
    throw new TypeError(
      'marker must have the mandatory E0 checks in all nine dimensions, and every dimension PASS',
    );
  }
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map(({ id }) => id)).size !== checks.length
  ) {
    throw new TypeError('marker must have one evidence artifact per check');
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
    throw new TypeError(
      'marker must have evidence that TEST_ADAPTER disables actual provider traffic',
    );
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
      ...(result.detail ? { detail: result.detail } : {}),
      ...(result.remediation ? { remediation: result.remediation } : {}),
    });
    if (result.status === 'FAIL') {
      return {
        checkId: check.id,
        dimension: check.dimension,
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
    dependency: check.dependency,
    boundaries: check.boundaries,
    status: 'PASS',
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    subchecks,
  };
}

function defaultEvidencePath(context) {
  return resolve(repositoryRoot, 'artifacts', 'cxa-e0', `${context.runId}.json`);
}

export function runCxaE0Readiness(options = {}) {
  const startedAt = options.now?.() ?? new Date();
  const context = options.context ?? createEvidenceContext(options.environment ?? process.env);
  const checks = options.checks ?? CXA_E0_READINESS_CHECKS;
  const executeCheck = options.executeCheck ?? executeReadinessCheck;
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const diagnostics = checks.map((check) => {
    const diagnostic = executeCompositeCheck(check, executeCheck);
    emit({ type: 'readiness.check', ...diagnostic });
    return diagnostic;
  });
  const summary = cxaE0Summary(diagnostics, startedAt);
  const manifest = createCxaE0EvidenceManifest(context, diagnostics, summary);
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
    ...(summary.status === 'PASS' ? { marker: E0_MARKER } : {}),
  });
  return { context, diagnostics, summary, manifest, evidencePath, manifestSha256 };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = runCxaE0Readiness();
    if (result.summary.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
