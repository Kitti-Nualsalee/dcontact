import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { executeReadinessCheck } from './phase-zero-readiness.mjs';
import { assertPiiSafeEvidence, sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export { assertPiiSafeEvidence, sha256 };

export const J2_MARKER = 'JOURNEY_J2_ACCEPTED';

/**
 * J2's own Phase Contract (#127) — ต่างจาก C1 ที่มีสอง sub-phase (CG2/J1) — ประกาศ
 * marker เดียวที่รอ check ทั้ง 16 ตัว PASS พร้อมกัน ไม่มี sub-marker ระหว่างทาง
 */
export const CXA_J2_READINESS_CHECKS = [
  {
    id: 'J2-F01',
    dimension: 'functional',
    dependency: 'J2 cross-domain contract: payload/command/result validation และ canonical hash',
    boundaries: [
      'closed payload contract',
      'canonical request/result hash',
      'error taxonomy frozen',
    ],
    commands: [[pnpm, '--filter', '@d-contact/cxa-contracts', 'test']],
    remediation: 'ตรวจ interaction-result.ts validation/hash function (J2.1)',
  },
  {
    id: 'J2-F02',
    dimension: 'functional',
    dependency:
      'Journey outcome trigger pipeline: definition, durable receipt และ trigger matching',
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
      'ตรวจ journey-definition/-outcome-receipt-repository/-outcome-trigger-processor (J2.2/J2.3/J2.7)',
  },
  {
    id: 'J2-F03',
    dimension: 'functional',
    dependency: 'Cases durable owner ของ ENSURE_CASE',
    boundaries: ['dedupe/reopen policy', 'canonical Case writer'],
    commands: [
      [pnpm, '--filter', '@d-contact/cases', 'test'],
      [pnpm, '--filter', '@d-contact/cases', 'test:integration'],
    ],
    remediation: 'ตรวจ Cases owner implementation ของ J2DialerOwnerPort/J2CaseOwnerPort (J2.4)',
  },
  {
    id: 'J2-F04',
    dimension: 'functional',
    dependency:
      'Dialer durable owner ของ ADMIT_CAMPAIGN_TARGET/SCHEDULE_CALLBACK และ originate barrier',
    boundaries: [
      'admission policy',
      'callback exact scope/expiry',
      'originate barrier TEST_ADAPTER only',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/dialer', 'test'],
      [pnpm, '--filter', '@d-contact/dialer', 'test:integration'],
    ],
    remediation: 'ตรวจ Dialer owner implementation และ DialerOriginateBarrier (J2.5/J2.6/J2.9)',
  },
  {
    id: 'J2-TI01',
    dimension: 'tenant-isolation',
    dependency: 'RLS/tenant policy ครอบคลุมตาราง J2 ใหม่ทั้งหมด',
    boundaries: ['two tenant fixture', 'cross-tenant rejection', 'RLS policy ของตารางใหม่'],
    commands: [[pnpm, '--filter', '@d-contact/db', 'test:integration']],
    remediation: 'ตรวจ RLS ของ jr_outcome_*/jr_owner_*/cs_*/ob_* ที่ J2 เพิ่ม',
  },
  {
    id: 'J2-AU01',
    dimension: 'authorization',
    dependency: 'trusted current tenant/team/contact scope ก่อนทุก owner command (#122)',
    boundaries: [
      'WORK scope ก่อน enrollment/action',
      'CONTACT scope ก่อน admission',
      'DEFER ไม่ cache เป็น ALLOW',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
      [pnpm, '--filter', '@d-contact/dialer', 'test:integration'],
    ],
    remediation:
      'ตรวจ JourneyOutcomeTriggerProcessor และ Dialer owner service scope check (J2.5/J2.6/J2.7)',
  },
  {
    id: 'J2-AU02',
    dimension: 'authorization',
    dependency: 'Governance outbound barrier ตรวจ scope + เรียก CG3 ใหม่เสมอก่อน originate (#124)',
    boundaries: [
      'fresh authorizeAndReserve ทุกครั้ง',
      'ไม่ reuse admission decision',
      'fail closed',
    ],
    commands: [[pnpm, '--filter', '@d-contact/dialer', 'test:integration']],
    remediation: 'ตรวจ DialerOriginateBarrier (J2.9)',
  },
  {
    id: 'J2-ID01',
    dimension: 'identity',
    dependency:
      'canonical outcome identity สองชั้น: transport (source,eventId) และ logical (outcomeType,outcomeId,outcomeVersion)',
    boundaries: ['duplicate no-op', 'version gap wait/reconcile', 'hash conflict quarantine'],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'ตรวจ JourneyOutcomeReceiptRepository (J2.3)',
  },
  {
    id: 'J2-ID02',
    dimension: 'identity',
    dependency: 'internal contactId resolution boundary และ ambiguous/missing เข้า REVIEW (#120)',
    boundaries: ['IDENTITY_UNRESOLVED', 'cross-tenant contactId ปฏิเสธ'],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'ตรวจ CustomerIdentityResolver/PrismaCustomerIdentityResolver (J2.7)',
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
    remediation: 'ตรวจ JourneyOwnerCommandRelay/JourneyOwnerResultReconciler (J2.8)',
  },
  {
    id: 'J2-CC02',
    dimension: 'cancellation-recovery',
    dependency: 'Dialer cancel/supersede เฉพาะ state ที่ reversible และ callback expiry',
    boundaries: [
      'CANCEL/SUPERSEDE เฉพาะ SCHEDULED',
      'TOO_LATE เมื่อ irreversible',
      'callback expiresAt',
    ],
    commands: [[pnpm, '--filter', '@d-contact/dialer', 'test:integration']],
    remediation: 'ตรวจ DialerCallbackService และ DialerOriginateBarrier expiry check (J2.6/J2.9)',
  },
  {
    id: 'J2-RC01',
    dimension: 'cancellation-recovery',
    dependency: 'receipt gap/quarantine/reconcile ไม่ blind retry',
    boundaries: [
      'WAITING_FOR_GAP reevaluation',
      'QUARANTINED escalation',
      'markRetryableFailure backoff',
    ],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation: 'ตรวจ markApplied/markRetryableFailure ของ JourneyOutcomeReceiptRepository (J2.3)',
  },
  {
    id: 'J2-RC02',
    dimension: 'cancellation-recovery',
    dependency: 'command/result idempotency และ recovery audit append-only',
    boundaries: [
      'first terminal commit wins',
      'late result ไม่ย้อน state',
      'JrRecoveryAudit append-only',
    ],
    commands: [[pnpm, '--filter', '@d-contact/journey', 'test:integration']],
    remediation:
      'ตรวจ JourneyOwnerActionRepository.applyResult และ JourneyRecoveryAudit (J2.3/J2.8)',
  },
  {
    id: 'J2-MG01',
    dimension: 'migration-compatibility',
    dependency: 'schema migration ครอบคลุมตาราง J2 ใหม่ทั้งหมดทั้ง existing และ fresh migrate',
    boundaries: ['fresh migration', 'canonical table/RLS/policy lock'],
    commands: [[process.execPath, 'scripts/cxa-j2-schema-readiness.mjs']],
    remediation:
      'ตรวจ cxa-j2-schema-readiness ครอบคลุมตาราง jr_outcome_*/jr_owner_*/cs_*/ob_* ใหม่',
  },
  {
    id: 'J2-OB01',
    dimension: 'observability-pii-redaction',
    dependency: 'owner profile เป็น durable/TEST_ADAPTER จริง และ evidence ไม่มี raw PII',
    boundaries: [
      'DURABLE_OWNER profile',
      'TEST_ADAPTER|CG3_INTEGRATED governance',
      'no raw PII ใน evidence',
    ],
    commands: [
      [pnpm, '--filter', '@d-contact/journey', 'test:integration'],
      [pnpm, '--filter', '@d-contact/dialer', 'test:integration'],
      [process.execPath, 'scripts/cxa-j2-profile-readiness.mjs'],
    ],
    evidencePrefix: 'CXA_J2_OWNER_PROFILE_EVIDENCE:',
    remediation:
      'ตรวจ owner profile evidence และ negative-scan ของ Dialer originate barrier (J2.9)',
  },
  {
    id: 'J2-REG01',
    dimension: 'regression',
    dependency: 'root build/typecheck/lint และ C1/S1 acceptance เดิมยังผ่าน',
    boundaries: ['root build', 'root typecheck', 'root lint', 'C1 acceptance', 'S1 acceptance'],
    commands: [
      [pnpm, 'build'],
      [pnpm, 'typecheck'],
      [pnpm, 'lint'],
      [pnpm, 'cxa:c1:acceptance'],
      [pnpm, 's1:acceptance'],
    ],
    remediation: 'แก้ build/typecheck/lint หรือ C1/S1 regression ก่อนยอมรับ J2',
  },
];

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

/** marker ออกได้เฉพาะ default-branch completion run บน commit เดียว (#126) — PR run
 * (มี pullRequest number) ต้องได้แค่ candidate manifest แม้ check ทุกตัว PASS */
function isDefaultBranchRun(environment) {
  if (environment.GITHUB_PR_NUMBER) return false;
  const ref = environment.GITHUB_REF ?? environment.CXA_J2_REF;
  if (!ref) return true; // local run นอก CI ถือเป็น default-branch-equivalent ของผู้เรียกเอง
  return ref === 'refs/heads/main' || ref === 'main';
}

export function createEvidenceContext(environment = process.env) {
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const expectedCommitSha = environment.CXA_J2_EXPECTED_COMMIT_SHA;
  if (expectedCommitSha && expectedCommitSha !== commitSha) {
    throw new TypeError('CXA_J2_EXPECTED_COMMIT_SHA ไม่ตรงกับ commit ที่กำลังรัน');
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
    throw new TypeError('evidence manifest มี phase หรือ schemaVersion ไม่ถูกต้อง');
  }
  if (!/^[0-9a-f]{40}$/i.test(manifest.commitSha)) {
    throw new TypeError('evidence manifest ต้องมี commit SHA เต็มรูปแบบ');
  }
  const declaredMarkers = manifest.markers ?? [];
  for (const marker of declaredMarkers) {
    if (marker !== J2_MARKER) throw new TypeError('evidence manifest มี marker ไม่ถูกต้อง');
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
  if (!declaredMarkers.includes(J2_MARKER)) return;

  if (checks.length !== CXA_J2_READINESS_CHECKS.length) {
    throw new TypeError('marker ต้องมี check ครบทั้ง 16 ตัวของ J2 acceptance matrix');
  }
  const allChecksPassed = checks.every((check) => check.status === 'PASS');
  if (!allChecksPassed) {
    throw new TypeError('JOURNEY_J2_ACCEPTED ต้องมี check ทุกตัว PASS');
  }
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map(({ id }) => id)).size !== checks.length
  ) {
    throw new TypeError('marker ต้องมี evidence artifact หนึ่งรายการต่อ check');
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
      'marker ต้องมี evidence ว่า owner profile ปิด actual provider traffic/release',
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
  const executeCheck = options.executeCheck ?? executeReadinessCheck;
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
