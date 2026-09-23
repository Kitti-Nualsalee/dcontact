import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';
import { cg4FailureDetail, parseTapSummary } from './cxa-cg4-readiness.mjs';
import {
  assertS2EvidenceSafe,
  S2_PILOT_MARKER,
  scanTextForS2Leaks,
} from './cxa-s2-negative-scan.mjs';
import { S2_PROVIDER_CHECK_IDS, verifyS2ProviderBundles } from './cxa-s2-provider-bundle.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * S2.6 (#366): LINE provider pilot acceptance — frozen registry 19 checks ของ #360 §B
 *
 * - `cxa:s2:focused` รัน automated checks 15 ตัว (ไม่รวม REG01 และ provider checks) เป็น candidate เสมอ
 * - `cxa:s2:acceptance` รันครบ 19 checks: automated 16 ตัวรันคำสั่งจริง ส่วน PR01/PR02/RB01 มาจาก
 *   sanitized bundle ของ protected runner (`CXA_S2_PROVIDER_BUNDLES`) ที่ตรวจซ้ำแล้วเท่านั้น
 * - marker `OUTBOUND_DELIVERY_LINE_PILOT_READY` ออกได้เมื่อ 19/19 PASS บน clean final main SHA เดียว +
 *   immutable Actions artifact + bundle ผ่าน + negative scans ผ่าน + rollback state ตรง #360 §F
 * - status ของ check/dimension derive จาก suite/bundle เท่านั้น ไม่มี override/waiver; skip/flaky = FAIL
 * - output ของทุก suite ถูกสแกนหา LINE ID/credential (runtime log layer ของ OB02) พบ = suite FAIL
 */
export const S2_MARKER = S2_PILOT_MARKER;
export const S2_WORKFLOW = Object.freeze({ name: 'cxa-s2-acceptance', version: 1 });
export const S2_CONTEXT_POINTERS = Object.freeze([
  '#355',
  '#356',
  '#357',
  '#358',
  '#359',
  '#360',
  '#361',
  '#362',
  '#366',
]);
export const S2_S1_BASELINE = Object.freeze({
  markers: ['CONTACT_GOVERNANCE_CG3_ACCEPTED', 'LINE_IN_MEMORY_SIMULATION_ACCEPTED'],
  finalMainSha: 'b634dc738e4e1544e06711d165e58cfe453c68e2',
});
export const S2_VERSIONS = Object.freeze({
  profile: 'S2_LINE_LOCAL_PILOT_V1',
  runnerProfile: 'S2_LINE_PROTECTED_RUNNER_V1',
  providerBundleSchema: 1,
  manifestSchema: 1,
});
export const S2_DIMENSIONS = Object.freeze([
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
 * flags ของ marker ตาม #360 §F — marker ไม่มี authority เปิด traffic
 * `actualProviderTraffic=true` หมายถึงมี capped-pilot evidence ใน run นี้ ไม่ใช่ gate เปิดค้าง
 */
export const S2_MARKER_FLAGS = Object.freeze({
  simulationOnly: false,
  actualProviderTraffic: true,
  providerConformance: true,
  accountEvidence: true,
  cappedPilotReady: true,
  productionReleaseEnabled: false,
  technicalSwitchAtArtifact: false,
  killLatchedAtArtifact: true,
  credentialActiveAtArtifact: false,
});

/**
 * deterministic fault suites (#360 §B: failure cases ใช้ provider double/fault proxy เท่านั้น)
 * ชี้ไปที่ไฟล์เทสต์ที่ inject fault นั้นจริง — test ของ registry ตรวจว่าไฟล์มีอยู่และทุก automated check
 * ที่ไม่ใช่ REG01/EV01 มี fault suite อย่างน้อยหนึ่งชุด
 */
export const S2_FAULT_SUITES = Object.freeze([
  {
    id: 'S2FX-PROVIDER-MAPPING',
    faults: [
      '2xx',
      '409+accepted id',
      '409 ไม่มี id',
      '400/404',
      '401/403',
      '429',
      '5xx',
      'timeout',
    ],
    sources: [
      'apps/delivery/src/line-outbound-policy.test.ts',
      'apps/delivery/src/line-outbound-adapter.integration.ts',
    ],
  },
  {
    id: 'S2FX-WEBHOOK-INGRESS',
    faults: [
      'invalid/missing signature',
      'empty verify',
      'multi-event',
      'malformed body',
      'DB down',
    ],
    sources: [
      'apps/delivery/src/line-webhook-signature.test.ts',
      'apps/delivery/src/line-webhook-ingress.integration.ts',
      'apps/api/src/line-webhook-api.integration.ts',
    ],
  },
  {
    id: 'S2FX-BARRIER-CRASH',
    faults: [
      'crash ก่อน barrier',
      'crash หลัง barrier',
      'restart replay',
      'kill ก่อน/หลัง barrier',
    ],
    sources: [
      'apps/delivery/src/line-outbound-adapter.integration.ts',
      'apps/delivery/src/line-control-plane.integration.ts',
    ],
  },
  {
    id: 'S2FX-RETRY-WINDOW',
    faults: ['bounded backoff', 'attempts > 4', '24h window expiry', 'quarantine + kill'],
    sources: [
      'apps/delivery/src/line-outbound-policy.test.ts',
      'apps/delivery/src/line-outbound-adapter.integration.ts',
      'apps/delivery/src/line-control-plane.integration.ts',
    ],
  },
  {
    id: 'S2FX-WEBHOOK-REDELIVERY',
    faults: [
      'redelivery',
      'same id different hash',
      'out-of-order',
      'pending correlation',
      'restart',
    ],
    sources: [
      'apps/delivery/src/line-webhook-ingress.integration.ts',
      'apps/delivery/src/line-webhook-worker.integration.ts',
    ],
  },
  {
    id: 'S2FX-CAP-RACE',
    faults: ['one-shot race', 'concurrent reservation', 'window/lifetime caps', 'unknown pause'],
    sources: [
      'apps/delivery/src/line-control-plane.integration.ts',
      'apps/delivery/src/line-persistence.integration.ts',
    ],
  },
  {
    id: 'S2FX-TENANT-SWAP',
    faults: ['guard tenant', 'channel/sender/recipient/content swap', 'credential swap'],
    sources: [
      'apps/delivery/src/line-pilot-wiring.integration.ts',
      'apps/delivery/src/line-control-plane.integration.ts',
      'apps/delivery/src/line-outbound-adapter.integration.ts',
      'apps/delivery/src/line-webhook-worker.integration.ts',
      'apps/contact-governance/src/correlated-touch.integration.ts',
    ],
  },
  {
    id: 'S2FX-TOUCH-BINDING',
    faults: [
      'quoted',
      'postback',
      'unquoted/group/wrong sender',
      'late/expired',
      'duplicate evidence',
    ],
    sources: [
      'apps/delivery/src/line-pilot-wiring.integration.ts',
      'apps/delivery/src/line-webhook-worker.integration.ts',
      'apps/contact-governance/src/correlated-touch.integration.ts',
    ],
  },
  {
    id: 'S2FX-MIGRATION',
    faults: ['fresh/upgrade', 'mixed-version worker', 'RLS/composite FK', 'append-only'],
    sources: [
      'scripts/cxa-s2-schema-readiness.test.mjs',
      'apps/delivery/src/line-persistence.integration.ts',
      'packages/cxa-contracts/src/line-delivery.test.ts',
    ],
  },
  {
    id: 'S2FX-OBSERVABILITY',
    faults: ['stuck settlement', 'signature storm', 'cap denial', 'quota/auth', 'kill latch'],
    sources: [
      'apps/delivery/src/line-observability.test.ts',
      'apps/delivery/src/line-observability.integration.ts',
    ],
  },
  {
    id: 'S2FX-PROVIDER-RUNNER',
    faults: ['client_id mismatch', 'quota exhausted', 'endpoint drift', 'secret in evidence'],
    sources: [
      'apps/delivery/src/line-provider-conformance.test.ts',
      'apps/delivery/src/line-run-proposal-view.test.ts',
      'scripts/cxa-s2-readiness.test.mjs',
    ],
  },
]);

const node = (script, ...arguments_) => [process.execPath, ...arguments_, script];
const filter = (name, ...arguments_) => [pnpm, '--filter', name, ...arguments_];
const tsxFile = (name, file) => filter(name, 'exec', 'tsx', '--test', '--test-concurrency=1', file);

const contracts = filter('@d-contact/cxa-contracts', 'test');
const deliveryUnit = filter('@d-contact/delivery', 'test');
const deliveryIntegration = filter('@d-contact/delivery', 'test:integration');
const correlatedTouch = tsxFile(
  '@d-contact/contact-governance',
  'src/correlated-touch.integration.ts',
);
const webhookApi = tsxFile('@d-contact/api', 'src/line-webhook-api.integration.ts');
const schema = node('scripts/cxa-s2-schema-readiness.mjs');
const negativeScan = node('scripts/cxa-s2-negative-scan.mjs');
const readinessTests = [
  process.execPath,
  '--test',
  'scripts/cxa-s2-readiness.test.mjs',
  'scripts/cxa-s2-schema-readiness.test.mjs',
];

function automated(id, dimension, boundaries, faultSuites, commands) {
  return {
    id,
    dimension,
    kind: 'automated',
    boundaries,
    faultSuites,
    commands,
    remediation: `แก้ ${id} ตาม #360/#362`,
  };
}

function provider(id, dimension, boundaries) {
  return {
    id,
    dimension,
    kind: 'provider',
    boundaries,
    faultSuites: [],
    commands: [],
    remediation: `รัน ${id} บน protected runner แล้ว ingest bundle ใหม่ (#360 §C/§D)`,
  };
}

/** #360 §B: 19 checks / 9 dimensions — ลำดับของ command คือลำดับที่ suite ถูกรันครั้งแรก */
export const CXA_S2_READINESS_CHECKS = Object.freeze([
  automated(
    'S2-LINE-F01',
    'functional',
    ['canonical one-to-one push', 'immutable fixture/content digest', 'exact tuple'],
    ['S2FX-PROVIDER-MAPPING'],
    [contracts, deliveryUnit, deliveryIntegration],
  ),
  automated(
    'S2-LINE-F02',
    'functional',
    ['2xx/409/4xx/429/5xx/timeout mapping ตาม #357'],
    ['S2FX-PROVIDER-MAPPING'],
    [contracts, deliveryUnit, deliveryIntegration],
  ),
  automated(
    'S2-LINE-F03',
    'functional',
    ['raw-body signature', 'empty/multi-event webhook', 'async durable ack'],
    ['S2FX-WEBHOOK-INGRESS'],
    [deliveryUnit, deliveryIntegration, webhookApi],
  ),
  automated(
    'S2-LINE-F04',
    'functional',
    ['reservation/Attempt/Touch/refund matrix', 'explicit response binding ตาม #361'],
    ['S2FX-TOUCH-BINDING'],
    [contracts, deliveryIntegration, correlatedTouch],
  ),
  automated(
    'S2-LINE-TI01',
    'tenant-isolation',
    ['pilot+guard tenant', 'channel/sender/recipient/content/credential swap fail ก่อน I/O'],
    ['S2FX-TENANT-SWAP'],
    [deliveryIntegration, correlatedTouch, webhookApi],
  ),
  automated(
    'S2-LINE-AU01',
    'authorization',
    [
      'immutable proposal',
      'Tenant Admin/Compliance approval',
      'technical switch',
      'one-shot consume',
      'kill clear authority',
    ],
    ['S2FX-CAP-RACE', 'S2FX-PROVIDER-RUNNER'],
    [deliveryUnit, deliveryIntegration],
  ),
  automated(
    'S2-LINE-ID01',
    'idempotency',
    [
      'actionKey',
      'UUID retry key',
      'accepted request ID',
      'outcomeRef',
      'webhookEventId',
      'response Touch dedupe/conflict',
    ],
    ['S2FX-PROVIDER-MAPPING', 'S2FX-WEBHOOK-REDELIVERY', 'S2FX-TOUCH-BINDING'],
    [deliveryUnit, deliveryIntegration, correlatedTouch, webhookApi],
  ),
  automated(
    'S2-LINE-CC01',
    'concurrency',
    ['atomic cap/run reservation', 'worker race', 'cap profile 1/run,1/recipient/day,3/day,10,c=1'],
    ['S2FX-CAP-RACE'],
    [deliveryUnit, deliveryIntegration],
  ),
  automated(
    'S2-LINE-RC01',
    'recovery',
    ['crash/fault matrix ก่อน/หลัง submission barrier', 'no blind resend/release'],
    ['S2FX-BARRIER-CRASH'],
    [deliveryUnit, deliveryIntegration],
  ),
  automated(
    'S2-LINE-RC02',
    'recovery',
    ['exact-request retry/backoff', 'attempts≤4', '24h expiry', 'pause/kill/quarantine'],
    ['S2FX-RETRY-WINDOW'],
    [deliveryUnit, deliveryIntegration],
  ),
  automated(
    'S2-LINE-RC03',
    'recovery',
    ['webhook redelivery/out-of-order', 'pending correlation', 'restart'],
    ['S2FX-WEBHOOK-REDELIVERY'],
    [deliveryIntegration, webhookApi],
  ),
  automated(
    'S2-LINE-MG01',
    'migration',
    ['fresh/upgrade/mixed-version', 'RLS/composite binding', 'rollback-forward-fix'],
    ['S2FX-MIGRATION'],
    [schema, contracts, deliveryIntegration],
  ),
  automated(
    'S2-LINE-OB01',
    'observability',
    ['metrics/alerts', 'audit', 'stuck-settlement', 'no PII/credential in labels/events'],
    ['S2FX-OBSERVABILITY'],
    [deliveryUnit, deliveryIntegration],
  ),
  automated(
    'S2-LINE-OB02',
    'observability',
    ['source/runtime/log/artifact negative scan', 'evidence hash verification'],
    ['S2FX-WEBHOOK-INGRESS', 'S2FX-PROVIDER-RUNNER'],
    [negativeScan, deliveryUnit, webhookApi],
  ),
  automated(
    'S2-LINE-REG01',
    'regression',
    ['build/typecheck/lint', 'E0/C1/S1 acceptance บน SHA เดียว', 'no disabled tests'],
    [],
    [
      [pnpm, 'build'],
      [pnpm, 'typecheck'],
      [pnpm, 'lint'],
      [pnpm, 'cxa:e0:acceptance'],
      [pnpm, 'cxa:c1:acceptance'],
      [pnpm, 's1:acceptance'],
    ],
  ),
  provider('S2-LINE-PR01', 'functional', [
    'token verify client_id',
    'quota/consumption',
    'validate push',
    'signed webhook test',
  ]),
  provider('S2-LINE-PR02', 'idempotency', [
    'protected actual push 1 logical delivery: 200',
    'same-key replay 409',
    'message IDs ตรง',
    'quoted reply สร้าง Touch 1',
  ]),
  provider('S2-LINE-RB01', 'recovery', [
    'switch off + kill + drain/quarantine + revoke token',
    'send ใหม่ถูก block ก่อน I/O',
  ]),
  automated(
    'S2-LINE-EV01',
    'observability',
    ['immutable final-main manifest/artifact/marker integrity', 'fixed flags'],
    [],
    [readinessTests],
  ),
]);

export const S2_FOCUSED_EXCLUDED = Object.freeze(['S2-LINE-REG01', ...S2_PROVIDER_CHECK_IDS]);

export function s2Checks(scope = 'full') {
  return scope === 'focused'
    ? CXA_S2_READINESS_CHECKS.filter(({ id }) => !S2_FOCUSED_EXCLUDED.includes(id))
    : CXA_S2_READINESS_CHECKS;
}

// ── Suite plan / execution ──────────────────────────────────────────────────

const suiteKey = (command) => JSON.stringify(command);

/** รวมคำสั่งซ้ำข้าม check เหลือ suite เดียวตามลำดับที่ปรากฏครั้งแรก */
export function s2SuitePlan(checks = CXA_S2_READINESS_CHECKS) {
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

const EVIDENCE_PREFIXES = ['CXA_S2_SCAN_EVIDENCE:'];

export function s2StructuredEvidence(output) {
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

export function executeS2Suite(suite, runner = spawnSync) {
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
  const exitedCleanly = result.status === 0 && !result.error;
  const tapClean =
    tap === null ||
    (tap.tests > 0 &&
      tap.failed === 0 &&
      tap.cancelled === 0 &&
      tap.skipped === 0 &&
      tap.todo === 0);
  // runtime log layer ของ OB02: log ที่มี LINE ID/credential = suite ล้ม แม้เทสต์จะผ่าน
  const leaks = scanTextForS2Leaks(output);
  const passed = exitedCleanly && tapClean && leaks.length === 0;
  const evidence = passed ? s2StructuredEvidence(output) : [];
  return {
    status: passed ? 'PASS' : 'FAIL',
    durationMs: Math.round(performance.now() - started),
    runtimeLogScan: { status: leaks.length === 0 ? 'PASS' : 'FAIL', rules: leaks },
    ...(tap ? { tap } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(passed
      ? {}
      : {
          detail:
            leaks.length > 0
              ? `RUNTIME_LOG_LEAK: ${leaks.join(', ')}`
              : cg4FailureDetail(
                  output,
                  result.error?.code ?? `process exited with status ${result.status ?? 'unknown'}`,
                ),
        }),
  };
}

// ── Provider evidence (bundle ingestion) ────────────────────────────────────

/**
 * PR01/PR02/RB01 ไม่มีคำสั่งให้รันใน CI — ผลมาจาก bundle ที่ผ่าน `verifyS2ProviderBundles` เท่านั้น
 * ไม่มี bundle = FAIL (missing evidence ไม่ใช่ skip), bundle เชื่อไม่ได้ = FAIL ทุก provider check
 */
export function ingestS2ProviderEvidence(
  paths,
  expectedCommitSha,
  verify = verifyS2ProviderBundles,
) {
  if (paths.length === 0) return { status: 'MISSING', checks: {}, bundles: [] };
  try {
    const result = verify(paths, { expectedCommitSha });
    return { status: 'VERIFIED', checks: result.checks, bundles: result.bundles };
  } catch (error) {
    return {
      status: 'INVALID',
      checks: {},
      bundles: [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function composeProviderCheck(item, providerEvidence) {
  const found = providerEvidence.checks[item.id];
  const detail =
    providerEvidence.status === 'INVALID'
      ? 'PROVIDER_BUNDLE_INVALID'
      : found
        ? undefined
        : 'PROVIDER_EVIDENCE_MISSING';
  const status = found && providerEvidence.status === 'VERIFIED' ? found.status : 'FAIL';
  return {
    id: item.id,
    dimension: item.dimension,
    kind: item.kind,
    status,
    boundaries: item.boundaries,
    provider: found
      ? { evidenceSha256: found.evidenceSha256, bundleSha256: found.bundleSha256 }
      : null,
    ...(detail ? { detail } : {}),
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
  if (!match) throw new TypeError('ไม่สามารถระบุ repository สำหรับ S2 manifest');
  return match[1];
}

export function createS2EvidenceContext(environment = process.env) {
  const repository = repositoryName(environment);
  const commitSha = runGit(['rev-parse', 'HEAD']);
  const finalMainSha = runGit(['rev-parse', 'origin/main']);
  const expectedCommitSha = environment.CXA_S2_EXPECTED_COMMIT_SHA ?? finalMainSha;
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
    protectedEnvironment: environment.CXA_S2_PROTECTED_ENVIRONMENT ?? null,
    artifact: {
      name: `cxa-s2-evidence-${commitSha}`,
      url: runUrl ? `${runUrl}#artifacts` : null,
      immutable: runUrl !== null,
      retentionDays: 90,
    },
  };
}

function fileDigest(paths) {
  return sha256(
    paths.map((path) => ({
      path,
      sha256: sha256(readFileSync(resolve(repositoryRoot, path), 'utf8')),
    })),
  );
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

const portable = (command) =>
  command[0] === process.execPath ? ['node', ...command.slice(1)] : command;

export function s2RegistryDigest(checks = CXA_S2_READINESS_CHECKS) {
  return sha256(
    checks.map(({ id, dimension, kind, boundaries, faultSuites, commands }) => ({
      id,
      dimension,
      kind,
      boundaries,
      faultSuites,
      commands: commands.map(portable),
    })),
  );
}

export function s2ContentDigests() {
  const existing = (paths) => paths.filter((path) => existsSync(resolve(repositoryRoot, path)));
  return {
    registry: s2RegistryDigest(),
    contracts: fileDigest(['packages/cxa-contracts/src/line-delivery.ts']),
    profile: fileDigest([
      'apps/delivery/src/line-control-policy.ts',
      'apps/delivery/src/line-rollout-gate.ts',
    ]),
    contentFixture: fileDigest(['apps/delivery/src/line-push-request.ts']),
    faultSuites: sha256({
      registry: S2_FAULT_SUITES,
      files: fileDigest(existing([...new Set(S2_FAULT_SUITES.flatMap(({ sources }) => sources))])),
    }),
    schema: fileDigest(['packages/db/prisma/schema.prisma']),
    migrations: migrationDigest(),
  };
}

// ── Flags / summary / manifest ──────────────────────────────────────────────

function evidenceOf(checks, type) {
  return checks
    .flatMap((item) => item.subchecks ?? [])
    .flatMap(({ evidence = [] }) => evidence)
    .find((evidence) => evidence?.type === type);
}

const passed = (checks, id) => checks.find((item) => item.id === id)?.status === 'PASS';

/**
 * flags derive จาก evidence ของ run นี้ — candidate จึงไม่มีทางอ้าง provider conformance ที่ไม่มีจริง
 * สถานะ ณ artifact (switch/kill/credential) รู้ได้จาก RB01 เท่านั้น: ไม่มี RB01 PASS = `null`
 */
export function s2DerivedFlags(checks) {
  const pr01 = passed(checks, 'S2-LINE-PR01');
  const pr02 = passed(checks, 'S2-LINE-PR02');
  const rb01 = passed(checks, 'S2-LINE-RB01');
  const hasPilotEvidence = checks.some((item) => item.id === 'S2-LINE-PR02' && item.provider);
  return {
    simulationOnly: !pr02,
    actualProviderTraffic: hasPilotEvidence,
    providerConformance: pr01,
    accountEvidence: pr01 && pr02,
    cappedPilotReady:
      checks.length === CXA_S2_READINESS_CHECKS.length &&
      checks.every((item) => item.status === 'PASS'),
    productionReleaseEnabled: false,
    technicalSwitchAtArtifact: rb01 ? false : null,
    killLatchedAtArtifact: rb01 ? true : null,
    credentialActiveAtArtifact: rb01 ? false : null,
  };
}

export function s2MarkerBlockers(context, checks, providerEvidence, scope = 'full') {
  const blockers = [];
  const expected = s2Checks(scope);
  if (scope !== 'full') blockers.push('FOCUSED_CANDIDATE');
  if (checks.length !== expected.length || checks.some((item) => item.status !== 'PASS'))
    blockers.push('CHECKS_NOT_ALL_PASS');
  if (context.pullRequest !== null) blockers.push('PULL_REQUEST_RUN');
  if (context.ref !== 'refs/heads/main') blockers.push('NOT_DEFAULT_BRANCH_REF');
  if (context.commitSha !== context.finalMainSha || context.commitSha !== context.expectedCommitSha)
    blockers.push('NOT_FINAL_MAIN_SHA');
  if (!context.cleanTree) blockers.push('DIRTY_TREE');
  if (!context.artifact?.immutable || !context.runUrl) blockers.push('ARTIFACT_NOT_IMMUTABLE');
  if (scope === 'full') {
    if (providerEvidence.status === 'INVALID') blockers.push('PROVIDER_BUNDLE_INVALID');
    if (S2_PROVIDER_CHECK_IDS.some((id) => !providerEvidence.checks[id]))
      blockers.push('PROVIDER_EVIDENCE_MISSING');
  }
  const scan = evidenceOf(checks, 'negative-scan.readiness');
  if (scan?.status !== 'PASS') blockers.push('NEGATIVE_SCAN_NOT_PASS');
  const schemaEvidence = evidenceOf(checks, 'schema.readiness');
  if (schemaEvidence?.existing !== 'PASS' || schemaEvidence?.fresh !== 'PASS')
    blockers.push('MIGRATION_NOT_PROVEN');
  if (JSON.stringify(s2DerivedFlags(checks)) !== JSON.stringify(S2_MARKER_FLAGS))
    blockers.push('FLAGS_NOT_FINAL');
  return blockers;
}

export function cxaS2Summary(
  context,
  checks,
  providerEvidence,
  startedAt = new Date(),
  scope = 'full',
) {
  const blockers = s2MarkerBlockers(context, checks, providerEvidence, scope);
  const allPassed = !blockers.includes('CHECKS_NOT_ALL_PASS');
  const markers = blockers.length === 0 ? [S2_MARKER] : [];
  return {
    type: 'readiness.summary',
    workflow: S2_WORKFLOW.name,
    workflowVersion: S2_WORKFLOW.version,
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
    entryCondition: markers.length > 0 ? S2_MARKER : 'NOT_READY',
    evidenceScope:
      'S2 Development + Capped Pilot only; marker ไม่เปิด traffic และ productionReleaseEnabled=false',
  };
}

function dimensionsOf(checks, scope) {
  const expected = s2Checks(scope);
  return S2_DIMENSIONS.map((name) => {
    const inDimension = checks.filter((item) => item.dimension === name);
    return {
      name,
      checks: expected.filter((item) => item.dimension === name).length,
      status:
        inDimension.length === 0
          ? 'NOT_RUN'
          : inDimension.every((item) => item.status === 'PASS')
            ? 'PASS'
            : 'FAIL',
    };
  });
}

export function createCxaS2EvidenceManifest(
  context,
  checks,
  summary,
  suites,
  digests,
  providerEvidence,
) {
  const scan = evidenceOf(checks, 'negative-scan.readiness');
  const schemaEvidence = evidenceOf(checks, 'schema.readiness');
  const manifest = {
    schemaVersion: 1,
    phase: 'S2',
    evidenceType: 'provider-pilot-acceptance',
    scope: summary.scope,
    candidate: summary.markers.length === 0,
    candidateOnly: summary.markers.length === 0,
    markerEligible: summary.markerEligible,
    markers: [...summary.markers],
    markerBlockers: [...summary.markerBlockers],
    entryCondition: summary.entryCondition,
    retentionDays: context.artifact.retentionDays,
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
    workflow: { ...S2_WORKFLOW },
    run: { id: context.runId, attempt: context.attempt, url: context.runUrl },
    protectedEnvironment: context.protectedEnvironment,
    startedAt: summary.startedAt,
    finishedAt: summary.finishedAt,
    artifact: { ...context.artifact },
    baseline: { ...S2_S1_BASELINE, markers: [...S2_S1_BASELINE.markers] },
    contextPointers: [...S2_CONTEXT_POINTERS],
    versions: { ...S2_VERSIONS },
    digests: { ...digests },
    faultSuites: S2_FAULT_SUITES.map(({ id }) => id),
    suites: suites.map((suite) => ({
      id: suite.id,
      command: portable(suite.command),
      checkIds: [...suite.checkIds],
      status: suite.status,
      durationMs: suite.durationMs ?? null,
      runtimeLogScan: suite.runtimeLogScan ?? null,
      ...(suite.tap ? { tap: { ...suite.tap } } : {}),
    })),
    checks,
    dimensions: dimensionsOf(checks, summary.scope),
    provider: {
      status: providerEvidence.status,
      bundles: providerEvidence.bundles.map((bundle) => ({ ...bundle })),
    },
    migration: {
      schema: schemaEvidence
        ? { existing: schemaEvidence.existing, fresh: schemaEvidence.fresh }
        : null,
    },
    negativeScan: scan
      ? { status: scan.status, files: scan.files, layers: scan.layers, allowlist: scan.allowlist }
      : null,
    flags: s2DerivedFlags(checks),
    artifacts: checks.map((item) => ({
      id: `check:${item.id}`,
      kind: item.kind === 'provider' ? 'provider-evidence' : 'readiness-diagnostic',
      commitSha: context.commitSha,
      sha256: sha256(item),
    })),
  };
  assertValidCxaS2EvidenceManifest(manifest);
  return manifest;
}

const FULL_SHA = /^[0-9a-f]{40}$/i;

export function assertValidCxaS2EvidenceManifest(manifest) {
  // PII/credential ก่อน validation อื่นทั้งหมด (#360 §E)
  assertS2EvidenceSafe(manifest);
  if (
    manifest.schemaVersion !== 1 ||
    manifest.phase !== 'S2' ||
    manifest.evidenceType !== 'provider-pilot-acceptance'
  )
    throw new TypeError('S2 manifest มี schemaVersion/phase/evidenceType ไม่ถูกต้อง');
  if (!['full', 'focused'].includes(manifest.scope))
    throw new TypeError('S2 manifest ต้องระบุ scope full หรือ focused');
  for (const field of ['commitSha', 'finalMainSha', 'expectedCommitSha']) {
    if (!FULL_SHA.test(manifest[field] ?? ''))
      throw new TypeError(`S2 manifest ต้องมี ${field} แบบ SHA เต็ม`);
  }
  if (!(manifest.retentionDays >= 90)) throw new TypeError('S2 artifact ต้องเก็บอย่างน้อย 90 วัน');

  const expected = s2Checks(manifest.scope);
  const registered = new Map(expected.map((item) => [item.id, item]));
  const checks = manifest.checks ?? [];
  if (new Set(checks.map((item) => item.id)).size !== checks.length)
    throw new TypeError('S2 manifest มี check ซ้ำ');
  const unknown = checks.find((item) => !registered.has(item.id));
  if (unknown) throw new TypeError(`S2 manifest มี check ที่ไม่อยู่ใน scope: ${unknown.id}`);
  if (checks.length !== expected.length)
    throw new TypeError(
      `S2 manifest scope ${manifest.scope} ต้องมี check ครบ ${expected.length} ตัว`,
    );
  if (checks.some((item) => registered.get(item.id).dimension !== item.dimension))
    throw new TypeError('S2 manifest มี dimension ของ check ไม่ตรง registry');

  if (JSON.stringify(manifest.dimensions) !== JSON.stringify(dimensionsOf(checks, manifest.scope)))
    throw new TypeError('S2 manifest dimensions ต้อง derive จาก checks เท่านั้น');
  if (JSON.stringify(manifest.flags) !== JSON.stringify(s2DerivedFlags(checks)))
    throw new TypeError('S2 manifest flags ต้อง derive จาก evidence ของ run นี้');
  if (manifest.flags.productionReleaseEnabled !== false)
    throw new TypeError('S2 ห้ามเปิด productionReleaseEnabled');

  const suites = new Map((manifest.suites ?? []).map((suite) => [suite.id, suite]));
  if (suites.size === 0 || suites.size !== (manifest.suites ?? []).length)
    throw new TypeError('S2 manifest ต้องมี suites ที่ id ไม่ซ้ำ');
  const commands = (manifest.suites ?? []).map((suite) => suiteKey(suite.command));
  if (new Set(commands).size !== commands.length)
    throw new TypeError('S2 manifest รัน suite เดียวกันซ้ำใน run เดียว');
  for (const item of checks) {
    const definition = registered.get(item.id);
    if (definition.kind === 'provider') {
      if (item.subchecks) throw new TypeError(`provider check ${item.id} ต้องไม่อ้าง suite`);
      if (item.status === 'PASS' && !item.provider)
        throw new TypeError(`provider check ${item.id} PASS ได้เฉพาะเมื่อมี bundle evidence`);
      if (item.status === 'PASS' && manifest.provider?.status !== 'VERIFIED')
        throw new TypeError(`provider check ${item.id} PASS ได้เฉพาะเมื่อ bundle ผ่านการตรวจ`);
      continue;
    }
    const subchecks = item.subchecks ?? [];
    if (subchecks.length !== definition.commands.length)
      throw new TypeError(`S2 check ${item.id} ต้องอ้าง suite ครบตาม registry`);
    for (const subcheck of subchecks) {
      const suite = suites.get(subcheck.suiteId);
      if (!suite || suite.status !== subcheck.status || !suite.checkIds.includes(item.id))
        throw new TypeError(`S2 check ${item.id} อ้าง suite ที่ไม่ตรงกับผลของ suite`);
    }
    const derived = subchecks.every((subcheck) => subcheck.status === 'PASS') ? 'PASS' : 'FAIL';
    if (item.status !== derived)
      throw new TypeError(`S2 check ${item.id} มี status ไม่ตรงกับ suite ที่อ้าง`);
  }

  const artifacts = manifest.artifacts ?? [];
  if (
    artifacts.length !== checks.length ||
    new Set(artifacts.map(({ id }) => id)).size !== checks.length
  )
    throw new TypeError('S2 manifest ต้องมี evidence artifact หนึ่งรายการต่อ check');
  for (const artifact of artifacts) {
    const item = checks.find(({ id }) => `check:${id}` === artifact.id);
    if (!item) throw new TypeError('S2 evidence artifact อ้าง check ที่ไม่มี');
    if (artifact.commitSha !== manifest.commitSha)
      throw new TypeError('S2 evidence artifact อ้าง commit ไม่ตรงกับ manifest');
    if (artifact.sha256 !== sha256(item))
      throw new TypeError('SHA-256 ของ S2 evidence artifact ไม่ตรงกับ check');
  }

  const markers = manifest.markers ?? [];
  if (markers.some((marker) => marker !== S2_MARKER) || new Set(markers).size !== markers.length)
    throw new TypeError('S2 manifest มี marker ไม่ถูกต้อง');
  if (markers.length === 0) {
    if (manifest.candidate !== true || manifest.entryCondition !== 'NOT_READY')
      throw new TypeError('S2 manifest ที่ไม่มี marker ต้องเป็น candidate และ NOT_READY');
    return;
  }

  if (manifest.scope !== 'full')
    throw new TypeError('focused run ออก S2 marker ไม่ได้ ได้แค่ candidate manifest');
  if (manifest.candidate !== false || (manifest.markerBlockers ?? []).length > 0)
    throw new TypeError('S2 marker ออกพร้อม candidate/blocker ไม่ได้');
  if (
    checks.some((item) => item.status !== 'PASS') ||
    [...suites.values()].some((suite) => suite.status !== 'PASS')
  )
    throw new TypeError(`${S2_MARKER} ต้องมีทุก check/suite PASS (ไม่มี skip/flaky/waiver)`);
  if (manifest.pullRequest?.number !== null && manifest.pullRequest?.number !== undefined)
    throw new TypeError('PR run ออก S2 marker ไม่ได้');
  if (
    manifest.commitSha !== manifest.finalMainSha ||
    manifest.commitSha !== manifest.expectedCommitSha ||
    manifest.refProof?.ref !== 'refs/heads/main' ||
    manifest.refProof?.cleanTree !== true
  )
    throw new TypeError(
      'S2 marker ต้องมาจาก clean final main SHA (HEAD == origin/main == expected)',
    );
  if (
    manifest.artifact?.immutable !== true ||
    manifest.artifact?.name !== `cxa-s2-evidence-${manifest.commitSha}` ||
    !/^https:\/\/[^/]+\/.+\/actions\/runs\/\d+\/attempts\/\d+#artifacts$/.test(
      manifest.artifact?.url ?? '',
    )
  )
    throw new TypeError('S2 marker ต้องอ้าง immutable CI artifact');
  if (manifest.provider?.status !== 'VERIFIED' || (manifest.provider?.bundles ?? []).length === 0)
    throw new TypeError('S2 marker ต้องมี provider bundle ที่ตรวจแล้ว');
  if (JSON.stringify(manifest.flags) !== JSON.stringify(S2_MARKER_FLAGS))
    throw new TypeError('S2 marker ต้องมี fixed flags ตาม #360 §F');
  if (manifest.negativeScan?.status !== 'PASS')
    throw new TypeError('S2 marker ต้องผ่าน negative scans');
  if (
    manifest.migration?.schema?.existing !== 'PASS' ||
    manifest.migration?.schema?.fresh !== 'PASS'
  )
    throw new TypeError('S2 marker ต้องพิสูจน์ migration ทั้ง fresh และ existing');
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
      ...(suite.evidence ? { evidence: structuredClone(suite.evidence) } : {}),
      ...(suite.detail ? { detail: suite.detail } : {}),
    };
  });
  return {
    id: item.id,
    dimension: item.dimension,
    kind: item.kind,
    status: subchecks.every((subcheck) => subcheck.status === 'PASS') ? 'PASS' : 'FAIL',
    boundaries: item.boundaries,
    faultSuites: item.faultSuites,
    subchecks,
  };
}

export function s2ProviderBundlePaths(environment = process.env) {
  return (environment.CXA_S2_PROVIDER_BUNDLES ?? '')
    .split(/[\n,]/)
    .map((path) => path.trim())
    .filter(Boolean)
    .map((path) => resolve(repositoryRoot, path));
}

export function runCxaS2Readiness(options = {}) {
  const scope = options.scope ?? 'full';
  const startedAt = options.now?.() ?? new Date();
  const context = options.context ?? createS2EvidenceContext(options.environment ?? process.env);
  const executeSuite = options.executeSuite ?? executeS2Suite;
  const emit = options.emit ?? ((value) => process.stdout.write(`${JSON.stringify(value)}\n`));
  const registry = s2Checks(scope);

  const providerEvidence =
    scope === 'full'
      ? (options.providerEvidence ??
        ingestS2ProviderEvidence(
          s2ProviderBundlePaths(options.environment ?? process.env),
          context.commitSha,
        ))
      : { status: 'NOT_IN_SCOPE', checks: {}, bundles: [] };
  emit({
    type: 'readiness.provider',
    status: providerEvidence.status,
    checks: Object.keys(providerEvidence.checks),
  });

  const suites = s2SuitePlan(registry).map((suite) => {
    const executed = { ...suite, ...executeSuite(suite) };
    emit({
      type: 'readiness.suite',
      id: executed.id,
      checkIds: executed.checkIds,
      status: executed.status,
      durationMs: executed.durationMs,
      ...(executed.tap ? { tap: executed.tap } : {}),
      ...(executed.detail ? { detail: executed.detail } : {}),
    });
    return executed;
  });
  const suiteByKey = new Map(suites.map((suite) => [suiteKey(suite.command), suite]));
  const checks = registry.map((item) => {
    const composed =
      item.kind === 'provider'
        ? composeProviderCheck(item, providerEvidence)
        : composeCheck(item, suiteByKey);
    emit({ type: 'readiness.check', id: composed.id, status: composed.status });
    return composed;
  });

  const summary = cxaS2Summary(context, checks, providerEvidence, startedAt, scope);
  const manifest = createCxaS2EvidenceManifest(
    context,
    checks,
    summary,
    suites,
    options.digests ?? s2ContentDigests(),
    providerEvidence,
  );
  const evidencePath =
    options.evidencePath ??
    resolve(repositoryRoot, 'artifacts', 'cxa-s2', `${scope}-${context.runId}.json`);
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
    const result = runCxaS2Readiness({ scope });
    if (result.summary.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
