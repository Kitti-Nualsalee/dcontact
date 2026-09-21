import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPiiSafeEvidence, sha256 } from './cxa-c1-readiness.mjs';
import { executeCg4Suite } from './cxa-cg4-readiness.mjs';
import { CG5_FIXED_FLAGS, CG5_OWNER_PROFILES } from './cxa-cg5-profile-readiness.mjs';
import { CG5_DEPENDENCY_PHASES } from './cxa-cg5-dependency-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export { assertPiiSafeEvidence, sha256, CG5_FIXED_FLAGS };

export const CG5_MARKER = 'CONTACT_GOVERNANCE_CG5_ACCEPTED';
export const CG5_BASELINE_SHA = 'dcdd18e22c9d8146c68414b0c59358c0332112a2';
export const CG5_WORKFLOW = Object.freeze({ name: 'cxa-cg5-acceptance', version: 1 });
export const CG5_CONTEXT_POINTERS = Object.freeze([
  '#265',
  '#266',
  '#267',
  '#268',
  '#269',
  '#270',
  '#271',
  '#272',
  '#273',
]);
/** #273 §1: manifest ล็อกเวอร์ชันของสัญญาที่ acceptance รอบนี้ยืนอยู่ */
export const CG5_VERSIONS = Object.freeze({
  cg5Contract: 1,
  projectionSchema: 1,
  anomalyRuleRegistry: 'CG5_RULE_REGISTRY_V1',
  kafkaEnvelope: 2,
  externalOpenApi: 'contact-governance-external-read.v1',
  fixturePack: 'TENANT_SYNTHETIC_CROSS_MONTH_V1',
  manifestSchema: 1,
});

/** 9 มิติของ #273 §3 บวก UX — ทุกมิติต้องมีอย่างน้อยหนึ่ง check */
export const CG5_DIMENSIONS = Object.freeze([
  'functional',
  'tenant-isolation',
  'authorization',
  'idempotency',
  'concurrency',
  'recovery',
  'migration',
  'observability',
  'regression',
  'ux',
]);

/** หน่วยของ suite คือไฟล์เทสต์หนึ่งไฟล์ เพื่อให้ runner รันแต่ละไฟล์ครั้งเดียวแม้หลาย check ใช้ร่วมกัน */
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
const contracts = testFiles('@d-contact/cxa-contracts');
const consoleUnit = testFiles('@d-contact/console');
const dbRls = [pnpm, '--filter', '@d-contact/db', 'test:integration'];
const consoleE2e = [
  pnpm,
  '--filter',
  '@d-contact/console',
  'exec',
  'playwright',
  'test',
  'e2e/governance.spec.ts',
];
const cg5Contracts = contracts('contact-governance-cg5.test.ts');
const cg5Api = api('contact-governance-cg5-api.integration.ts');
const cg5ExportApi = api('contact-governance-cg5-export-api.integration.ts');

function check(id, dimension, dependency, boundaries, commands, extra = {}) {
  return {
    id,
    dimension,
    dependency,
    boundaries,
    commands,
    remediation: `แก้ ${id} ตาม #273`,
    ...extra,
  };
}

/** ทุก integration suite รันบน Postgres/Redis จริง — in-memory fake ใช้เฉพาะ unit/contract */
export const CXA_CG5_READINESS_CHECKS = Object.freeze([
  check(
    'CG5-F01',
    'functional',
    'metric ทั้ง 8 คีย์ตรงกับ canonical',
    ['8 metric keys with feed', 'event-fed metrics via inbox', 'decision volume from canonical'],
    [
      ...cg5Contracts,
      ...governance(
        'cg5-event-metrics-consumer.test.ts',
        'cg5-event-metrics-consumer.integration.ts',
        'cg5-incremental-projection-reader.integration.ts',
      ),
    ],
  ),
  check(
    'CG5-F02',
    'functional',
    'ตารางผลกระทบราย policy version',
    ['impact bucket per policy version', 'query route scope-filtered'],
    [
      ...governance(
        'cg5-incremental-projection-reader.integration.ts',
        'cg5-query-service.integration.ts',
      ),
      ...cg5Api,
    ],
  ),
  check(
    'CG5-F03',
    'functional',
    'กฎค่าคงที่',
    ['closed rule registry', 'fixed rules never suppressed'],
    [
      ...cg5Contracts,
      ...governance('cg5-anomaly-evaluator.test.ts', 'cg5-anomaly-engine.integration.ts'),
    ],
  ),
  check(
    'CG5-F04',
    'functional',
    'กฎเทียบฐาน 4 สัปดาห์พร้อมพื้นปริมาณขั้นต่ำ',
    ['4-week baseline', 'minimum volume floor', 'insufficient baseline suppressed'],
    governance('cg5-anomaly-evaluator.test.ts', 'cg5-anomaly-engine.integration.ts'),
  ),
  check(
    'CG5-F05',
    'functional',
    'วงจร alert พร้อม hysteresis',
    ['OPEN/ACKED/RESOLVED closed transitions', 'hysteresis', 'no Governance state change'],
    [
      ...cg5Contracts,
      ...governance('cg5-anomaly-evaluator.test.ts', 'cg5-alert-repository.integration.ts'),
    ],
  ),
  check(
    'CG5-F06',
    'functional',
    'export ครบ 4 ชุดพร้อม manifest และ hash ที่ตรวจได้',
    ['4 datasets from canonical', 'manifest SHA-256 matches file', 'tenant watermark'],
    governance('cg5-export-worker.integration.ts', 'cg5-prisma-export-reader.integration.ts'),
  ),
  check(
    'CG5-F07',
    'functional',
    'external read API ตอบตามสัญญาและไม่มี route เขียน',
    ['read-only external routes', 'ETag/304', 'OpenAPI breaking-change guard'],
    [
      ...api(
        'contact-governance-external-read-api.test.ts',
        'contact-governance-api.integration.ts',
      ),
      [process.execPath, '--test', 'scripts/cg5-openapi-breaking-check.test.mjs'],
    ],
  ),
  check(
    'CG5-TI01',
    'tenant-isolation',
    'อ่าน metric/alert/export ข้าม tenant ไม่ได้และ fail closed',
    ['tenant from token only', 'RLS on every cg5 table', 'generic not-found'],
    [
      ...governance(
        'cg5-tenant-config-repository.integration.ts',
        'cg5-query-service.integration.ts',
      ),
      ...cg5Api,
      ...cg5ExportApi,
      dbRls,
    ],
  ),
  check(
    'CG5-TI02',
    'tenant-isolation',
    'ไฟล์ export อยู่ใต้ prefix ของ tenant และดึงข้าม tenant ไม่ได้',
    ['storage key under tenant prefix', 'cross-tenant download not found'],
    [
      ...governance('cg5-export-worker.integration.ts', 'cg5-export-lifecycle.integration.ts'),
      ...cg5ExportApi,
    ],
  ),
  check(
    'CG5-AU01',
    'authorization',
    'SUPERVISOR เห็นเฉพาะทีมตัวเองและไม่เห็นยอดรวม tenant',
    ['team scope filter before paging', 'no tenant-wide aggregate', 'scope-bound cache key'],
    [
      ...governance('cg5-query-service.integration.ts', 'cg5-query-cache.test.ts'),
      ...cg5Api,
      consoleE2e,
    ],
  ),
  check(
    'CG5-AU02',
    'authorization',
    'export จำกัด ADMIN/COMPLIANCE',
    ['export capability', 'Supervisor has no export route call'],
    [...cg5ExportApi, ...consoleUnit('cg5-console-api.test.ts'), consoleE2e],
  ),
  check(
    'CG5-AU03',
    'authorization',
    'EVIDENCE ต้องมี capability, ยกระดับผ่าน field ไม่ได้ และถูกบันทึก audit',
    ['evidence capability', 'no field escalation', 'evidence access audited'],
    [
      ...cg5ExportApi,
      ...api('contact-governance-api.integration.ts'),
      ...governance('cg5-prisma-export-reader.integration.ts'),
    ],
  ),
  check(
    'CG5-AU04',
    'authorization',
    'scope ของ external client บังคับได้ และ scope เขียนที่จองชื่อไว้ไม่มี route',
    ['governance:read enforced', 'governance:restrictions:write reserved only', '429 Retry-After'],
    [
      ...cg5Contracts,
      ...api(
        'gateway-auth.test.ts',
        'contact-governance-external-read-api.test.ts',
        'tenant-client-rate-limiter.test.ts',
      ),
    ],
  ),
  check(
    'CG5-ID01',
    'idempotency',
    'Idempotency-Key ซ้ำได้งานเดิม ไม่สร้างไฟล์ใหม่',
    ['same key same job', 'no duplicate object'],
    [...governance('cg5-export-job-repository.integration.ts'), ...cg5ExportApi],
  ),
  check(
    'CG5-ID02',
    'idempotency',
    'reader รันซ้ำช่วงเดิมไม่ทำให้ bucket ซ้ำ',
    ['rerun same range idempotent', 'duplicate delivery counted once'],
    governance(
      'cg5-incremental-projection-reader.integration.ts',
      'cg5-event-metrics-consumer.integration.ts',
    ),
  ),
  check(
    'CG5-CC01',
    'concurrency',
    'ack ที่ชน version ถูกปฏิเสธและไม่เขียนทับ',
    ['optimistic version', 'no event on stale version', 'UI does not resend ACK'],
    [...governance('cg5-alert-repository.integration.ts'), ...cg5Api, consoleE2e],
  ),
  check(
    'CG5-CC02',
    'concurrency',
    'reader/consumer สองตัวพร้อมกันไม่นับซ้ำ',
    ['concurrent readers counted once', 'concurrent consumers counted once'],
    governance(
      'cg5-incremental-projection-reader.integration.ts',
      'cg5-event-metrics-consumer.integration.ts',
    ),
  ),
  check(
    'CG5-CC03',
    'concurrency',
    'cache ไม่ตอบข้อมูลเก่ากว่า asOf ที่ประกาศ',
    ['entry carries asOf', 'TTL within refresh interval', 'no older-than-asOf answer'],
    governance('cg5-query-cache.test.ts', 'cg5-query-service.integration.ts'),
  ),
  check(
    'CG5-RC01',
    'recovery',
    'Redis ล่มแล้วอ่าน projection ตรงได้',
    ['cache miss falls back to projection'],
    governance('cg5-query-cache.test.ts', 'cg5-query-service.integration.ts'),
  ),
  check(
    'CG5-RC02',
    'recovery',
    'consumer gap หรือ scope pause ทำให้กฎเทียบฐานถูกระงับและหน้าจอบอกว่าข้อมูลไม่ครบ',
    ['gap/out-of-order pause scope', 'baseline rules suppressed', 'UI reports incomplete data'],
    [
      ...governance(
        'cg5-event-metrics-consumer.integration.ts',
        'cg5-anomaly-evaluator.test.ts',
        'cg5-anomaly-engine.integration.ts',
      ),
      consoleE2e,
    ],
  ),
  check(
    'CG5-RC03',
    'recovery',
    'export job ที่ล้มกลางคันไม่ทิ้งไฟล์ค้างและล้มอย่างชัดเจน',
    ['partial objects removed', 'job marked FAILED', 'revoke before delete'],
    governance('cg5-export-worker.integration.ts', 'cg5-export-lifecycle.integration.ts'),
  ),
  check(
    'CG5-MG01',
    'migration',
    'migration additive ล้วน ไม่แก้ canonical และ index สร้างแบบ concurrent',
    ['additive only', 'canonical index CONCURRENTLY', 'RLS/grants on every cg5 table'],
    [
      [process.execPath, 'scripts/cxa-cg5-migration-readiness.mjs'],
      ...governance('cg5-tenant-config-repository.integration.ts'),
      dbRls,
    ],
    { evidencePrefix: 'CXA_CG5_MIGRATION_EVIDENCE:' },
  ),
  check(
    'CG5-MG02',
    'migration',
    'backfill/rebuild drill บน fixture ข้ามเดือนแบบย่อขนาด',
    [
      'cross-month scaled fixture',
      'rebuild same range identical rows',
      'interrupt/resume equals single run',
      'NOT_READY until backfill completes',
    ],
    governance(
      'cg5-projection-maintenance.integration.ts',
      'cg5-incremental-projection-reader.integration.ts',
    ),
  ),
  check(
    'CG5-MG03',
    'migration',
    'งานลบตามอายุทำงานถูกชั้นและไม่แตะ canonical',
    ['retention per granularity', 'canonical untouched'],
    governance('cg5-projection-maintenance.integration.ts'),
  ),
  check(
    'CG5-OB01',
    'observability',
    'metric, alert และ export มี telemetry และ audit ครบทุกเหตุการณ์',
    [
      'projection lag/throughput telemetry',
      'alert transition telemetry',
      'export telemetry',
      'audit',
    ],
    governance(
      'cg5-observability.test.ts',
      'cg5-alert-repository.integration.ts',
      'cg5-export-job-repository.integration.ts',
    ),
  ),
  check(
    'CG5-OB02',
    'observability',
    'ไม่มี PII ใน projection, alert, manifest, event และ log',
    ['contract PII guard', 'SUMMARY redaction', 'manifest negative scan'],
    [...cg5Contracts, ...governance('cg5-prisma-export-reader.integration.ts'), ...cg5ExportApi],
  ),
  check(
    'CG5-REG01',
    'regression',
    'conformance ของ CG3/CG4 บน SHA เดียวกัน และบันทึกสถานะ marker ที่พบ',
    ['CG3 targeted conformance', 'CG4 targeted conformance', 'phase marker status recorded'],
    [
      ...contracts('contact-governance.test.ts', 'contact-governance-cg4.test.ts'),
      ...governance(
        'cg3-persistence.test.ts',
        'cg3-policy-evaluator.test.ts',
        'cg3-authorize-and-reserve.integration.ts',
        'cg3-persistence.integration.ts',
        'cg3-event-relay.integration.ts',
        'cg3-acknowledgement-consumer.integration.ts',
        'cg4-rule-registry.test.ts',
        'cg4-exception-evaluation.test.ts',
        'cg4-authorization-engine.test.ts',
        'cg4-policy-resolution.test.ts',
        'cg4-cache.test.ts',
        'cg4-redaction.test.ts',
        'cg4-exception-authorize.integration.ts',
        'cg4-policy-lifecycle.integration.ts',
      ),
      ...api('contact-governance-cg4-api.integration.ts'),
      [process.execPath, 'scripts/cxa-cg5-dependency-readiness.mjs'],
    ],
    { evidencePrefix: 'CXA_CG5_DEPENDENCY_EVIDENCE:' },
  ),
  check(
    'CG5-REG02',
    'regression',
    'สัญญาของ J2/J3 ไม่ถูกแตะ',
    ['J2/J3 contracts unchanged', 'Journey unit suite', 'owner profiles and fixed flags'],
    [
      ...contracts(
        'contact-governance-downstream.test.ts',
        'interaction-result.test.ts',
        'segment-membership.test.ts',
        'delivery.test.ts',
      ),
      [pnpm, '--filter', '@d-contact/journey', 'test'],
      [process.execPath, 'scripts/cxa-cg5-profile-readiness.mjs'],
    ],
    { evidencePrefix: 'CXA_CG5_PROFILE_EVIDENCE:' },
  ),
  check(
    'CG5-UX01',
    'ux',
    'แถบความสดแยกตามแหล่ง เตือนเมื่อเกิน SLO, สถานะข้อมูลยังไม่พร้อม และตัวกรอง alert ทำงานจริง',
    ['freshness per source', 'SLO warning', 'not-ready state', 'alert filters', 'no console error'],
    [
      ...consoleUnit('cg5-console-api.test.ts'),
      [pnpm, '--filter', '@d-contact/console', 'build'],
      consoleE2e,
    ],
  ),
]);

// ── Suite plan ───────────────────────────────────────────────────────────────

const suiteKey = (command) => JSON.stringify(command);

/** รวมคำสั่งที่ซ้ำกันข้าม check ให้เหลือ suite เดียว ตามลำดับที่ปรากฏครั้งแรก (#295: รันครั้งเดียวต่อ run) */
export function cg5SuitePlan(checks = CXA_CG5_READINESS_CHECKS) {
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
  if (!match) throw new TypeError('ไม่สามารถระบุ repository สำหรับ CG5 manifest');
  return match[1];
}

export function createCg5EvidenceContext(environment = process.env) {
  const repository = repositoryName(environment);
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const finalMainSha = runGit(['rev-parse', 'origin/main']);
  const expectedCommitSha = environment.CXA_CG5_EXPECTED_COMMIT_SHA ?? finalMainSha;
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
      name: `cxa-cg5-evidence-${commitSha}`,
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

export function cg5RegistryDigest(checks = CXA_CG5_READINESS_CHECKS) {
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

/**
 * #273 §2: marker ที่พบใน manifest จริงเป็น `ACCEPTED_SAME_SHA`; ถ้าไม่พบแต่ targeted conformance ของ
 * check ที่ครอบเฟสนั้นผ่านเป็น `CONTRACT_COMPATIBLE`; ไม่งั้น `ABSENT`
 */
export function cg5PhaseMarkers(checks) {
  const found = evidenceFor(checks, 'CG5-REG01', 'dependency.readiness')?.phases ?? {};
  return Object.fromEntries(
    CG5_DEPENDENCY_PHASES.map(({ phase, marker, checkId }) => {
      const conformance = checks.find((item) => item.id === checkId)?.status === 'PASS';
      const status =
        found[phase]?.status === 'ACCEPTED_SAME_SHA'
          ? 'ACCEPTED_SAME_SHA'
          : conformance
            ? 'CONTRACT_COMPATIBLE'
            : 'ABSENT';
      return [
        phase,
        {
          status,
          marker,
          conformanceCheck: checkId,
          manifestSha256: found[phase]?.manifestSha256 ?? null,
        },
      ];
    }),
  );
}

export function cg5MarkerBlockers(context, checks) {
  const blockers = [];
  if (
    checks.length !== CXA_CG5_READINESS_CHECKS.length ||
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
  const phases = cg5PhaseMarkers(checks);
  if (Object.values(phases).some(({ status }) => status === 'ABSENT')) {
    blockers.push('PHASE_CONFORMANCE_NOT_PROVEN');
  }
  const profile = evidenceFor(checks, 'CG5-REG02', 'owner-profile.readiness');
  if (
    !profile ||
    JSON.stringify(profile.profiles) !== JSON.stringify(CG5_OWNER_PROFILES) ||
    JSON.stringify(profile.flags) !== JSON.stringify(CG5_FIXED_FLAGS)
  ) {
    blockers.push('OWNER_PROFILE_OR_FLAGS_MISMATCH');
  }
  return blockers;
}

export function cxaCg5Summary(context, checks, startedAt = new Date()) {
  const blockers = cg5MarkerBlockers(context, checks);
  const allPassed = !blockers.includes('CHECKS_NOT_ALL_PASS');
  const markers = blockers.length === 0 ? [CG5_MARKER] : [];
  return {
    type: 'readiness.summary',
    workflow: CG5_WORKFLOW.name,
    workflowVersion: CG5_WORKFLOW.version,
    status: allPassed ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: checks.filter(({ status }) => status === 'PASS').length,
    failed: checks.filter(({ status }) => status !== 'PASS').length,
    markers,
    markerBlockers: blockers,
    candidateOnly: markers.length === 0,
    entryCondition: markers.length > 0 ? CG5_MARKER : 'NOT_READY',
    evidenceScope:
      'CG5 Development Complete only; releaseEnabled=false, externalApiEnabled=false, provider traffic disabled',
  };
}

export function createCxaCg5EvidenceManifest(context, checks, summary, suites, digests = {}) {
  const status = (id) => checks.find((item) => item.id === id)?.status ?? 'FAIL';
  const manifest = {
    schemaVersion: 1,
    phase: 'CG5',
    evidenceType: 'development-acceptance',
    candidate: summary.markers.length === 0,
    ...(summary.markers.length > 0 ? { markers: summary.markers } : {}),
    markerBlockers: [...summary.markerBlockers],
    repository: context.repository,
    defaultBranch: context.defaultBranch,
    baselineSha: CG5_BASELINE_SHA,
    pullRequest: { number: context.pullRequest, baseSha: context.baseSha },
    commitSha: context.commitSha,
    finalMainSha: context.finalMainSha,
    expectedCommitSha: context.expectedCommitSha,
    refProof: {
      ref: context.ref,
      cleanTree: context.cleanTree,
      headEqualsFinalMain: context.commitSha === context.finalMainSha,
    },
    workflow: { ...CG5_WORKFLOW },
    run: { id: context.runId, attempt: context.attempt, url: context.runUrl },
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    artifact: { ...context.artifact },
    contextPointers: [...CG5_CONTEXT_POINTERS],
    versions: { ...CG5_VERSIONS },
    digests: {
      registry: digests.registry ?? cg5RegistryDigest(),
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
    dimensions: CG5_DIMENSIONS.map((name) => {
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
      additiveOnly: status('CG5-MG01'),
      backfillRebuildDrill: status('CG5-MG02'),
      retention: status('CG5-MG03'),
    },
    recovery: {
      redisFallback: status('CG5-RC01'),
      gapSuppression: status('CG5-RC02'),
      exportFailureCleanup: status('CG5-RC03'),
    },
    // สำเนาอิสระจาก evidence ใน check: manifest ห้าม alias object ที่ถูก hash ไว้ใน artifact
    ownerProfiles: structuredClone(
      evidenceFor(checks, 'CG5-REG02', 'owner-profile.readiness')?.profiles ?? null,
    ),
    phaseMarkers: cg5PhaseMarkers(checks),
    flags: { ...CG5_FIXED_FLAGS },
    negativeScan: { suites: status('CG5-OB02'), manifest: 'PASS' },
    artifacts: checks.map((item) => ({
      id: `check:${item.id}`,
      kind: 'readiness-diagnostic',
      commitSha: context.commitSha,
      sha256: sha256(item),
    })),
  };
  assertValidCxaCg5EvidenceManifest(manifest);
  return manifest;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;
const PHASE_STATUSES = new Set(['ACCEPTED_SAME_SHA', 'CONTRACT_COMPATIBLE', 'ABSENT']);

export function assertValidCxaCg5EvidenceManifest(manifest) {
  assertPiiSafeEvidence(manifest);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.phase !== 'CG5' ||
    manifest.evidenceType !== 'development-acceptance'
  ) {
    throw new TypeError('CG5 manifest มี schemaVersion/phase/evidenceType ไม่ถูกต้อง');
  }
  for (const field of ['commitSha', 'finalMainSha', 'expectedCommitSha', 'baselineSha']) {
    if (!FULL_SHA.test(manifest[field] ?? ''))
      throw new TypeError(`CG5 manifest ต้องมี ${field} แบบ SHA เต็ม`);
  }
  if (manifest.baselineSha !== CG5_BASELINE_SHA)
    throw new TypeError('CG5 manifest อ้าง baseline ไม่ถูกต้อง');
  if (JSON.stringify(manifest.flags) !== JSON.stringify(CG5_FIXED_FLAGS)) {
    throw new TypeError('CG5 manifest flags ไม่ตรง fixed flags');
  }
  const phases = manifest.phaseMarkers ?? {};
  if (
    CG5_DEPENDENCY_PHASES.some(({ phase }) => !PHASE_STATUSES.has(phases[phase]?.status)) ||
    Object.keys(phases).length !== CG5_DEPENDENCY_PHASES.length
  ) {
    throw new TypeError('CG5 manifest ต้องบันทึกสถานะ marker ของ CG3/CG4/J2/J3 ครบ');
  }

  const checks = manifest.checks ?? [];
  const registered = new Map(CXA_CG5_READINESS_CHECKS.map((item) => [item.id, item]));
  if (new Set(checks.map((item) => item.id)).size !== checks.length) {
    throw new TypeError('CG5 manifest มี check ซ้ำ');
  }
  const unknown = checks.find((item) => !registered.has(item.id));
  if (unknown) throw new TypeError(`CG5 manifest มี check ที่ไม่รู้จัก: ${unknown.id}`);
  if (checks.length !== CXA_CG5_READINESS_CHECKS.length) {
    throw new TypeError(`CG5 manifest ต้องมี check ครบทั้ง ${CXA_CG5_READINESS_CHECKS.length} ตัว`);
  }
  if (checks.some((item) => registered.get(item.id).dimension !== item.dimension)) {
    throw new TypeError('CG5 manifest มี dimension ของ check ไม่ตรง registry');
  }
  const dimensions = manifest.dimensions ?? [];
  if (
    dimensions.length !== CG5_DIMENSIONS.length ||
    CG5_DIMENSIONS.some((name) => !(dimensions.find((item) => item.name === name)?.checks > 0))
  ) {
    throw new TypeError('CG5 manifest ต้องมีครบ 9 มิติบวก UX และไม่มีมิติว่าง');
  }

  // suite ที่ใช้ร่วมกันต้องเป็นผลเดียวกันในทุก check ที่อ้าง — ห้ามแต่ง status ของ check แยกจาก suite
  const suites = new Map((manifest.suites ?? []).map((suite) => [suite.id, suite]));
  if (suites.size === 0 || suites.size !== (manifest.suites ?? []).length) {
    throw new TypeError('CG5 manifest ต้องมี suites ที่ id ไม่ซ้ำ');
  }
  const commands = (manifest.suites ?? []).map((suite) => suiteKey(suite.command));
  if (new Set(commands).size !== commands.length) {
    throw new TypeError('CG5 manifest รัน suite เดียวกันซ้ำใน run เดียว');
  }
  for (const item of checks) {
    const subchecks = item.subchecks ?? [];
    if (subchecks.length !== registered.get(item.id).commands.length) {
      throw new TypeError(`CG5 check ${item.id} ต้องอ้าง suite ครบตาม registry`);
    }
    for (const subcheck of subchecks) {
      const suite = suites.get(subcheck.suiteId);
      if (!suite || suite.status !== subcheck.status || !suite.checkIds.includes(item.id)) {
        throw new TypeError(`CG5 check ${item.id} อ้าง suite ที่ไม่ตรงกับผลของ suite`);
      }
    }
    const derived = subchecks.every((subcheck) => subcheck.status === 'PASS') ? 'PASS' : 'FAIL';
    if (item.status !== derived) {
      throw new TypeError(`CG5 check ${item.id} มี status ไม่ตรงกับ suite ที่อ้าง`);
    }
  }

  const artifacts = manifest.artifacts ?? [];
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map(({ id }) => id)).size !== checks.length
  ) {
    throw new TypeError('CG5 manifest ต้องมี evidence artifact หนึ่งรายการต่อ check');
  }
  for (const artifact of artifacts) {
    const item = checks.find(({ id }) => `check:${id}` === artifact.id);
    if (!item) throw new TypeError('CG5 evidence artifact อ้าง check ที่ไม่มี');
    if (artifact.commitSha !== manifest.commitSha)
      throw new TypeError('CG5 evidence artifact อ้าง commit ไม่ตรงกับ manifest');
    if (artifact.sha256 !== sha256(item))
      throw new TypeError('SHA-256 ของ CG5 evidence artifact ไม่ตรงกับ check');
  }

  const markers = manifest.markers ?? [];
  if (markers.some((marker) => marker !== CG5_MARKER) || new Set(markers).size !== markers.length) {
    throw new TypeError('CG5 manifest มี marker ไม่ถูกต้อง');
  }
  if (markers.length === 0) {
    if (manifest.candidate !== true) {
      throw new TypeError('CG5 manifest ที่ไม่มี marker ต้องทำเครื่องหมาย candidate');
    }
    return;
  }

  if (manifest.candidate !== false || (manifest.markerBlockers ?? []).length > 0) {
    throw new TypeError('CG5 marker ออกพร้อม candidate/blocker ไม่ได้');
  }
  if (
    checks.some((item) => item.status !== 'PASS') ||
    [...suites.values()].some((s) => s.status !== 'PASS')
  ) {
    throw new TypeError(`${CG5_MARKER} ต้องมีทุก check PASS (ไม่มี skip/flaky/waiver)`);
  }
  if (manifest.pullRequest?.number !== null && manifest.pullRequest?.number !== undefined) {
    throw new TypeError('PR run ออก CG5 marker ไม่ได้ ได้แค่ candidate manifest');
  }
  if (
    manifest.commitSha !== manifest.finalMainSha ||
    manifest.commitSha !== manifest.expectedCommitSha
  ) {
    throw new TypeError('CG5 marker ต้องมาจาก HEAD == origin/main == expectedCommitSha');
  }
  if (manifest.refProof?.ref !== 'refs/heads/main' || manifest.refProof?.cleanTree !== true) {
    throw new TypeError('CG5 marker ต้องมาจาก clean checkout ของ default branch');
  }
  if (
    manifest.artifact?.immutable !== true ||
    !/^https:\/\/[^/]+\/.+\/actions\/runs\/\d+\/attempts\/\d+#artifacts$/.test(
      manifest.artifact?.url ?? '',
    ) ||
    manifest.artifact?.name !== `cxa-cg5-evidence-${manifest.commitSha}`
  ) {
    throw new TypeError('CG5 marker ต้องอ้าง immutable CI artifact ไม่ใช่ local/mutable reference');
  }
  if (Object.values(phases).some(({ status }) => status === 'ABSENT')) {
    throw new TypeError('CG5 marker ต้องพิสูจน์ conformance ของ CG3/CG4/J2/J3 บน SHA เดียวกัน');
  }
  if (JSON.stringify(manifest.ownerProfiles) !== JSON.stringify(CG5_OWNER_PROFILES)) {
    throw new TypeError('CG5 marker ต้องมี owner profiles ตรง contract');
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

export function runCxaCg5Readiness(options = {}) {
  const startedAt = options.now?.() ?? new Date();
  const context = options.context ?? createCg5EvidenceContext(options.environment ?? process.env);
  const executeSuite = options.executeSuite ?? executeCg4Suite;
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));

  const suites = cg5SuitePlan().map((suite) => {
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
  const checks = CXA_CG5_READINESS_CHECKS.map((item) => {
    const composed = composeCheck(item, suiteByKey);
    emit({ type: 'readiness.check', ...composed });
    return composed;
  });

  const summary = cxaCg5Summary(context, checks, startedAt);
  const manifest = createCxaCg5EvidenceManifest(context, checks, summary, suites, options.digests);
  const evidencePath =
    options.evidencePath ??
    resolve(repositoryRoot, 'artifacts', 'cxa-cg5', `${context.runId}.json`);
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
    const result = runCxaCg5Readiness();
    if (result.summary.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
