import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createMemoizedExecuteCheck, executeReadinessCheck } from './phase-zero-readiness.mjs';
import { assertPiiSafeEvidence, sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export { assertPiiSafeEvidence, sha256 };

export const J2_MARKER = 'JOURNEY_J2_ACCEPTED';

/**
 * J2's own Phase Contract (#127) - unlike C1, which has two sub-phases (CG2/J1) - declares
 * a single marker that waits for all 16 checks to PASS together, with no intermediate sub-marker
 */
export const CXA_J2_READINESS_CHECKS = [
  {
    id: 'J2-F01',
    dimension: 'functional',
    dependency: 'J2 cross-domain contract: payload/command/result validation and canonical hash',
    boundaries: [
      'closed payload contract',
      'canonical request/result hash',
      'error taxonomy frozen',
    ],
    commands: [[pnpm, '--filter', '@d-contact/cxa-contracts', 'test']],
    remediation: 'Check the interaction-result.ts validation/hash function (J2.1)',
  },
  {
    id: 'J2-F02',
    dimension: 'functional',
    dependency:
      'Journey outcome trigger pipeline: definition, durable receipt and trigger matching',
    boundaries: [
      'outcome trigger definition',
      'durable receipt/version gate',
      'enrollment + action intent atomic',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/journey', 'test'],
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
    ],
    remediation:
      'Check journey-definition/-outcome-receipt-repository/-outcome-trigger-processor (J2.2/J2.3/J2.7)',
  },
  {
    id: 'J2-F03',
    dimension: 'functional',
    dependency: 'Cases durable owner of ENSURE_CASE',
    boundaries: ['dedupe/reopen policy', 'canonical Case writer'],
    commands: [
      [pnpm, '--filter', '@d-contact/cases', 'test'],
      [pnpm, '--filter', '@d-contact/cases', 'test:integration'],
    ],
    remediation: 'Check the Cases owner implementation of J2DialerOwnerPort/J2CaseOwnerPort (J2.4)',
  },
  {
    id: 'J2-F04',
    dimension: 'functional',
    dependency:
      'Dialer durable owner of ADMIT_CAMPAIGN_TARGET/SCHEDULE_CALLBACK and the originate barrier',
    boundaries: [
      'admission policy',
      'callback exact scope/expiry',
      'originate barrier TEST_ADAPTER only',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/dialer', 'test'],
      [pnpm, '--filter', '@d-contact/dialer', 'test:integration'],
    ],
    remediation:
      'Check the Dialer owner implementation and DialerOriginateBarrier (J2.5/J2.6/J2.9)',
  },
  {
    id: 'J2-TI01',
    dimension: 'tenant-isolation',
    dependency: 'RLS/tenant policy covers all the new J2 tables',
    boundaries: ['two tenant fixture', 'cross-tenant rejection', 'RLS policy of the new tables'],
    commands: [[pnpm, '--filter', '@d-contact/db', 'test:integration']],
    remediation: 'Check RLS of the jr_outcome_*/jr_owner_*/cs_*/ob_* tables J2 adds',
  },
  {
    id: 'J2-AU01',
    dimension: 'authorization',
    dependency: 'trusted current tenant/team/contact scope before every owner command (#122)',
    boundaries: [
      'WORK scope before enrollment/action',
      'CONTACT scope before admission',
      'DEFER is not cached as ALLOW',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
      [pnpm, '--filter', '@d-contact/dialer', 'test:integration'],
    ],
    remediation:
      'Check JourneyOutcomeTriggerProcessor and the Dialer owner service scope check (J2.5/J2.6/J2.7)',
  },
  {
    id: 'J2-AU02',
    dimension: 'authorization',
    dependency:
      'the Governance outbound barrier checks scope + always calls CG3 afresh before originate (#124)',
    boundaries: [
      'fresh authorizeAndReserve every time',
      'does not reuse admission decision',
      'fail closed',
    ],
    commands: [[pnpm, '--filter', '@d-contact/dialer', 'test:integration']],
    remediation: 'Check DialerOriginateBarrier (J2.9)',
  },
  {
    id: 'J2-ID01',
    dimension: 'identity',
    dependency:
      'canonical outcome identity in two layers: transport (source,eventId) and logical (outcomeType,outcomeId,outcomeVersion)',
    boundaries: ['duplicate no-op', 'version gap wait/reconcile', 'hash conflict quarantine'],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'Check JourneyOutcomeReceiptRepository (J2.3)',
  },
  {
    id: 'J2-ID02',
    dimension: 'identity',
    dependency:
      'internal contactId resolution boundary, and ambiguous/missing goes to REVIEW (#120)',
    boundaries: ['IDENTITY_UNRESOLVED', 'cross-tenant contactId rejected'],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'Check CustomerIdentityResolver/PrismaCustomerIdentityResolver (J2.7)',
  },
  {
    id: 'J2-CC01',
    dimension: 'cancellation-recovery',
    dependency: 'cross-owner command relay/result reconciliation (#123)',
    boundaries: [
      'relay dispatch idempotent',
      'reconciler apply terminal-precedence',
      'cancel/supersede staged',
    ],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'Check JourneyOwnerCommandRelay/JourneyOwnerResultReconciler (J2.8)',
  },
  {
    id: 'J2-CC02',
    dimension: 'cancellation-recovery',
    dependency: 'Dialer cancel/supersede only in reversible states, and callback expiry',
    boundaries: [
      'CANCEL/SUPERSEDE only when SCHEDULED',
      'TOO_LATE when irreversible',
      'callback expiresAt',
    ],
    commands: [[pnpm, '--filter', '@d-contact/dialer', 'test:integration']],
    remediation:
      'Check DialerCallbackService and the DialerOriginateBarrier expiry check (J2.6/J2.9)',
  },
  {
    id: 'J2-RC01',
    dimension: 'cancellation-recovery',
    dependency: 'receipt gap/quarantine/reconcile, no blind retry',
    boundaries: [
      'WAITING_FOR_GAP reevaluation',
      'QUARANTINED escalation',
      'markRetryableFailure backoff',
    ],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'Check markApplied/markRetryableFailure of JourneyOutcomeReceiptRepository (J2.3)',
  },
  {
    id: 'J2-RC02',
    dimension: 'cancellation-recovery',
    dependency: 'command/result idempotency and append-only recovery audit',
    boundaries: [
      'first terminal commit wins',
      'a late result does not roll back state',
      'JrRecoveryAudit append-only',
    ],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation:
      'Check JourneyOwnerActionRepository.applyResult and JourneyRecoveryAudit (J2.3/J2.8)',
  },
  {
    id: 'J2-MG01',
    dimension: 'migration-compatibility',
    dependency:
      'schema migration covers all the new J2 tables, on both an existing and a fresh migrate',
    boundaries: ['fresh migration', 'canonical table/RLS/policy lock'],
    commands: [[process.execPath, 'scripts/cxa-j2-schema-readiness.mjs']],
    remediation:
      'Check that cxa-j2-schema-readiness covers the new jr_outcome_*/jr_owner_*/cs_*/ob_* tables',
  },
  {
    id: 'J2-OB01',
    dimension: 'observability-pii-redaction',
    dependency: 'the owner profile is really durable/TEST_ADAPTER and the evidence has no raw PII',
    boundaries: [
      'DURABLE_OWNER profile',
      'TEST_ADAPTER|CG3_INTEGRATED governance',
      'no raw PII in evidence',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
      [pnpm, '--filter', '@d-contact/dialer', 'test:integration'],
      [process.execPath, 'scripts/cxa-j2-profile-readiness.mjs'],
    ],
    evidencePrefix: 'CXA_J2_OWNER_PROFILE_EVIDENCE:',
    remediation:
      'Check the owner profile evidence and the negative scan of the Dialer originate barrier (J2.9)',
  },
  {
    id: 'J2-REG01',
    dimension: 'regression',
    dependency: 'root build/typecheck/lint and the C1/S1 acceptance marker on the same SHA',
    // #559: do not re-run the C1/S1 acceptance - check the marker from an immutable CI artifact on the same SHA instead
    boundaries: [
      'root build',
      'root typecheck',
      'root lint',
      'C1 acceptance marker (J1_ACCEPTED) same SHA',
      'S1 acceptance marker (CONTACT_GOVERNANCE_CG3_ACCEPTED) same SHA',
    ],
    commands: [
      [pnpm, 'build'],
      [pnpm, 'typecheck'],
      [pnpm, 'lint'],
      [process.execPath, 'scripts/acceptance-dependency-markers.mjs', 'J2'],
    ],
    evidencePrefix: 'ACCEPTANCE_DEPENDENCY_EVIDENCE:',
    remediation:
      'Fix build/typecheck/lint, or run the S1 acceptance on the same SHA until it passes (see the dependency detail)',
  },
];

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

/** A marker can be issued only by a default-branch completion run on a single commit (#126) - a PR run
 * (with a pullRequest number) must get only a candidate manifest even if every check PASSES */
function isDefaultBranchRun(environment) {
  if (environment.GITHUB_PR_NUMBER) return false;
  const ref = environment.GITHUB_REF ?? environment.CXA_J2_REF;
  if (!ref) return true; // a local run outside CI counts as default-branch-equivalent (the caller is responsible for it)
  return ref === 'refs/heads/main' || ref === 'main';
}

export function createEvidenceContext(environment = process.env) {
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const expectedCommitSha = environment.CXA_J2_EXPECTED_COMMIT_SHA;
  if (expectedCommitSha && expectedCommitSha !== commitSha) {
    throw new TypeError('CXA_J2_EXPECTED_COMMIT_SHA does not match the running commit');
  }
  return {
    repository: repositoryName(environment),
    pullRequest: environment.GITHUB_PR_NUMBER ? Number(environment.GITHUB_PR_NUMBER) : null,
    baseSha: environment.CXA_J2_BASE_SHA ?? runGit(['merge-base', 'HEAD', 'origin/main']),
    commitSha,
    runId: environment.GITHUB_RUN_ID ?? `local-${randomUUID()}`,
    attempt: Number(environment.GITHUB_RUN_ATTEMPT ?? 1),
    isDefaultBranchRun: isDefaultBranchRun(environment),
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

export function cxaJ2Summary(diagnostics, context, startedAt = new Date()) {
  const failed = diagnostics.filter(({ status }) => status === 'FAIL');
  const allPassed = failed.length === 0 && diagnostics.length === CXA_J2_READINESS_CHECKS.length;
  const markerEligible = allPassed && (context?.isDefaultBranchRun ?? true);
  return {
    type: 'readiness.summary',
    workflow: 'cx-automation-j2-acceptance',
    workflowVersion: 1,
    status: allPassed ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: diagnostics.filter(({ status }) => status === 'PASS').length,
    failed: failed.length,
    skipped: diagnostics.filter(({ status }) => status === 'SKIP').length,
    markers: markerEligible ? [J2_MARKER] : [],
    entryCondition: markerEligible ? J2_MARKER : 'NOT_READY',
    evidenceScope: 'development acceptance baseline; provider traffic remains disabled',
  };
}

export function createCxaJ2EvidenceManifest(context, diagnostics, summary) {
  const checks = diagnostics.map(toManifestCheck);
  const artifacts = checks.map((check) => ({
    id: `check:${check.id}`,
    kind: 'readiness-diagnostic',
    commitSha: context.commitSha,
    sha256: sha256(check),
  }));
  const manifest = {
    schemaVersion: 1,
    phase: 'J2',
    ...(summary.markers.length > 0 ? { markers: summary.markers } : {}),
    repository: context.repository,
    pullRequest: { number: context.pullRequest, baseSha: context.baseSha },
    commitSha: context.commitSha,
    run: { id: context.runId, attempt: context.attempt },
    contractVersions: {
      j2Contract: 1,
      customerIdentityResolution: 1,
      scopeAuthorization: 1,
      kafkaEnvelope: 2,
    },
    dimensions: [...new Set(CXA_J2_READINESS_CHECKS.map(({ dimension }) => dimension))].map(
      (dimension) => ({
        name: dimension,
        status: checks
          .filter(
            (check) =>
              CXA_J2_READINESS_CHECKS.find((c) => c.id === check.id)?.dimension === dimension,
          )
          .every((check) => check.status === 'PASS')
          ? 'PASS'
          : 'FAIL',
      }),
    ),
    checks,
    migration: {
      status: checks.find((check) => check.id === 'J2-MG01')?.status ?? 'FAIL',
      canonicalTables: 'cxa-j2-schema-readiness',
    },
    artifacts,
  };
  assertValidCxaJ2EvidenceManifest(manifest);
  return manifest;
}

export function assertValidCxaJ2EvidenceManifest(manifest) {
  assertPiiSafeEvidence(manifest);
  if (manifest.phase !== 'J2' || manifest.schemaVersion !== 1) {
    throw new TypeError('evidence manifest has an invalid phase or schemaVersion');
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.commitSha)) {
    throw new TypeError('evidence manifest must have a full commit SHA');
  }
  const declaredMarkers = manifest.markers ?? [];
  for (const marker of declaredMarkers) {
    if (marker !== J2_MARKER) throw new TypeError('evidence manifest has an invalid marker');
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
  if (!declaredMarkers.includes(J2_MARKER)) return;

  if (checks.length !== CXA_J2_READINESS_CHECKS.length) {
    throw new TypeError('marker must have all 16 checks of the J2 acceptance matrix');
  }
  const allChecksPassed = checks.every((check) => check.status === 'PASS');
  if (!allChecksPassed) {
    throw new TypeError('JOURNEY_J2_ACCEPTED needs every check to PASS');
  }
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map(({ id }) => id)).size !== checks.length
  ) {
    throw new TypeError('marker must have one evidence artifact per check');
  }
  const ownerProfileEvidence = checks
    .find(({ id }) => id === 'J2-OB01')
    ?.subchecks?.flatMap(({ evidence = [] }) => evidence)
    .some(
      (evidence) =>
        evidence?.type === 'owner-profile.readiness' &&
        evidence.actualProviderTraffic === false &&
        evidence.providerConformance === false &&
        evidence.releaseEnabled === false,
    );
  if (!ownerProfileEvidence) {
    throw new TypeError(
      'marker must have evidence that the owner profile disables actual provider traffic/release',
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
  return resolve(repositoryRoot, 'artifacts', 'cxa-j2', `${context.runId}.json`);
}

export function runCxaJ2Readiness(options = {}) {
  const startedAt = options.now?.() ?? new Date();
  const context = options.context ?? createEvidenceContext(options.environment ?? process.env);
  const checks = options.checks ?? CXA_J2_READINESS_CHECKS;
  // several checks reference the same command - memoize by command so CI does not re-run it without adding coverage
  const executeCheck = options.executeCheck ?? createMemoizedExecuteCheck();
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const diagnostics = checks.map((check) => {
    const diagnostic = executeCompositeCheck(check, executeCheck);
    emit({ type: 'readiness.check', ...diagnostic });
    return diagnostic;
  });
  const summary = cxaJ2Summary(diagnostics, context, startedAt);
  const manifest = createCxaJ2EvidenceManifest(context, diagnostics, summary);
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
    candidateOnly: !context.isDefaultBranchRun,
  });
  return { context, diagnostics, summary, manifest, evidencePath, manifestSha256 };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = runCxaJ2Readiness();
    if (result.summary.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
