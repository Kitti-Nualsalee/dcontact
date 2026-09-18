import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const PHASE_ZERO_READINESS_CHECKS = [
  {
    id: 'environment',
    dependency: 'Docker Compose dev environment',
    boundaries: ['PostgreSQL', 'Redis', 'MinIO', 'Redpanda', 'FreeSWITCH', 'Keycloak'],
    command: [pnpm, 'infra:up'],
    remediation: 'ตรวจ Docker daemon/port/volume แล้วรัน pnpm infra:up',
  },
  {
    id: 'database-baseline',
    dependency: 'PostgreSQL baseline',
    boundaries: ['migration', 'RLS policy', 'seed', 'Keycloak identity link'],
    command: [pnpm, 'infra:bootstrap'],
    remediation: 'ตรวจ PostgreSQL แล้วรัน pnpm infra:bootstrap',
  },
  {
    id: 'infrastructure-boundaries',
    dependency: 'Phase 0 infrastructure',
    boundaries: [
      'PostgreSQL connection',
      'Redis state store',
      'MinIO live endpoint',
      'MinIO recordings bucket',
      'Redpanda cluster/topics',
      'FreeSWITCH ESL/SIP/WebSocket/RTP',
    ],
    command: [process.execPath, 'scripts/dev-infra-readiness.mjs'],
    remediation:
      'ใช้ dependency และข้อความ ✗ ใน detail เพื่อแก้ service แล้วรัน pnpm infra:ready ซ้ำ',
  },
  {
    id: 'tenant-isolation',
    dependency: 'PostgreSQL RLS boundary',
    boundaries: [
      'dcontact_app ไม่มี tenant context',
      'dcontact_app ใช้ demo tenant context',
      'cross-tenant read/write rejection',
    ],
    command: [pnpm, '--filter', '@d-contact/db', 'test:integration'],
    remediation: 'ตรวจ migration และ packages/db/prisma/rls.sql แล้วรัน pnpm infra:bootstrap',
  },
  {
    id: 'identity-contract',
    dependency: 'Keycloak OIDC boundary',
    boundaries: [
      'OIDC discovery',
      'JWKS signature',
      'audience/tenant/user/role claims',
      'tampered-token rejection',
    ],
    command: [process.execPath, 'scripts/keycloak-dev-readiness.mjs', '--auto-fallback'],
    remediation: 'ตรวจ Keycloak realm แล้วรัน pnpm infra:identity:link',
  },
  {
    id: 'gateway-boundary',
    dependency: 'API Gateway identity boundary',
    boundaries: ['401 invalid identity', '403 insufficient role', 'verified tenant derivation'],
    command: [pnpm, '--filter', '@d-contact/api', 'test'],
    remediation: 'ตรวจ API Gateway OIDC guard และ workspace session adapters',
  },
  {
    id: 'event-backbone',
    dependency: 'Redpanda Kafka contract',
    boundaries: [
      '@d-contact/kafka public producer/consumer',
      'tenant/correlation/ordering envelope',
      'duplicate-event idempotency',
    ],
    command: [pnpm, '--filter', '@d-contact/kafka', 'test:integration'],
    remediation: 'ตรวจ Redpanda topics และ @d-contact/kafka contract',
  },
];

/** ลบข้อมูลรับรองก่อนนำ child-process output มาแสดงใน diagnostic */
export function sanitizeDiagnostic(value) {
  return String(value ?? '')
    .replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
    .replaceAll(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_TOKEN]')
    .replaceAll(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replaceAll(
      /((?:access|refresh|id)_token|authorization|password|passwd|secret|client_secret)(["']?\s*[:=]\s*["']?)([^"',\s}]+)/gi,
      '$1$2[REDACTED]',
    )
    .replaceAll(
      /(postgres(?:ql)?|redis|https?):\/\/([^:\s/@]+):([^@\s/]+)@/gi,
      '$1://$2:[REDACTED]@',
    )
    .trim();
}

/**
 * หน้าต่างนี้ต้องกว้างพอจะครอบ "บล็อกความล้มเหลว" ของ test runner ไม่ใช่แค่บรรทัดสรุปท้ายสุด
 * ตอนตั้งไว้ 10 บรรทัด/1500 อักษร diagnostic ของ Playwright ที่ล้มเก็บได้เพียงบรรทัด
 * "N failed" กับรายชื่อ test ส่วนข้อความ assertion จริงถูกตัดทิ้งทั้งหมด ทำให้ผลของ gate
 * บอกได้แค่ว่าล้ม แต่บอกไม่ได้ว่าล้มเพราะอะไร ซึ่งใช้เป็นหลักฐานปิดเฟสไม่ได้
 * Nested readiness จะ serialize diagnostic ซ้ำหลายชั้น จึงต้องมี character window ที่กว้างพอ
 * ให้ยังเห็น assertion ต้นเหตุ โดยทุกข้อความผ่าน sanitize ก่อนเก็บเสมอ
 */
const DIAGNOSTIC_DETAIL_LINES = 80;
const DIAGNOSTIC_DETAIL_CHARACTERS = 32_000;

/**
 * บรรทัดที่บอก "อะไรล้ม" ต้องรอดจากการตัดเสมอ ไม่ว่าจะอยู่ตำแหน่งไหนของ output
 *
 * head/tail window อย่างเดียวไม่พอ: TAP ของ suite ที่มีร้อยกว่า test จะดัน `not ok` ของ
 * test ที่ล้มไปอยู่กลาง output พอดี แล้วโดนตัดทิ้ง เหลือแต่ `# fail 1` ท้ายสุดซึ่งบอกว่า
 * มีตัวล้มแต่ไม่บอกว่าตัวไหน — เจอจริงสองรอบติดกันตอนไล่ J2 acceptance จนต้องเดา
 */
/**
 * `# Error:` คือบรรทัดเดียวที่บอกว่า test file ล้มเพราะ async activity ที่รอดออกมาหลังเทสจบ
 *
 * เมื่อ promise reject หลัง test body จบไปแล้ว node:test จะรายงานตัวเทสว่า ok ตามปกติ แล้วค่อย
 * ทำให้ "ไฟล์" ล้มด้วย failureType: 'testCodeFailure' กับ error: 'test failed' ซึ่งไม่บอกอะไรเลย
 * รายละเอียดจริงอยู่ในบรรทัด diagnostic ที่ขึ้นต้นด้วย `# Error: Test "<ชื่อเทส>" at <ไฟล์>:<บรรทัด>
 * generated asynchronous activity after the test ended...` พร้อมข้อความ error ต้นทาง
 *
 * exitCode/signal คือบรรทัดเดียวที่แยก "เทสใน assert ไม่ผ่าน" ออกจาก "process ตายทั้งตัว"
 *
 * node:test รายงาน test file ที่ process จบไม่สวยด้วย failureType: 'testCodeFailure' และ
 * error: 'test failed' เหมือนกันหมด รายละเอียดที่บอกสาเหตุจริงอยู่ที่ signal: (เช่น SIGSEGV
 * ของ Prisma engine ตอน memory พร่อง) หรือ exitCode: เท่านั้น ถ้าไม่เก็บสองบรรทัดนี้ไว้ตอน
 * truncate จะเหลือแต่ failure ที่ไม่มีสาเหตุ แล้วต้องเดาเอาเองว่า flaky เพราะอะไร
 */
const FAILURE_LINE_PATTERN =
  /^\s*(?:not ok\b|# fail\b|# Error\b|error:|failureType:|code: 'ERR_|exitCode:|signal:|AssertionError|\s*at .*\.(?:test|integration)\.ts)/;

/**
 * บรรทัด `not ok`/`error:` บอกว่า "อะไรล้ม" แต่ "ล้มเพราะอะไร" อยู่ในบรรทัดถัดมา (ข้อความ assertion,
 * diff ของ actual/expected) ซึ่งไม่ match FAILURE_LINE_PATTERN เลยถูกตัดทิ้งหมด — เจอจริงตอนไล่
 * CG4-OB02 ใน J2 acceptance ที่เหลือแค่ `code: 'ERR_ASSERTION'` โดยไม่รู้ว่า assert ตัวไหน
 *
 * จึงเก็บบล็อกต่อเนื่องหลังบรรทัด failure ไว้ด้วย จนกว่าจะเจอผลของเทสตัวถัดไป
 */
const FAILURE_BLOCK_CONTEXT_LINES = 12;

function rescueFailureBlocks(lines) {
  const rescued = [];
  let remaining = 0;
  for (const line of lines) {
    if (FAILURE_LINE_PATTERN.test(line)) {
      remaining = FAILURE_BLOCK_CONTEXT_LINES;
      rescued.push(line);
      continue;
    }
    if (remaining === 0) continue;
    // ผลของเทสตัวถัดไปเริ่มแล้ว = จบบล็อกของความล้มเหลวนี้
    if (/^\s*(?:ok\b|# Subtest:)/.test(line)) {
      remaining = 0;
      continue;
    }
    rescued.push(line);
    remaining -= 1;
  }
  return rescued;
}

function diagnosticDetail(result) {
  const safe = sanitizeDiagnostic(`${result.stderr ?? ''}\n${result.stdout ?? ''}`);
  if (!safe)
    return result.error?.code ?? `process exited with status ${result.status ?? 'unknown'}`;
  const lines = safe.split('\n').filter(Boolean);
  const headCount = Math.ceil(DIAGNOSTIC_DETAIL_LINES / 2);
  let detail;
  if (lines.length <= DIAGNOSTIC_DETAIL_LINES) {
    detail = lines.join('\n');
  } else {
    const head = lines.slice(0, headCount);
    const tail = lines.slice(-headCount);
    const tailStart = lines.length - headCount;
    // เก็บบรรทัดที่บ่งบอกความล้มเหลวซึ่งอยู่นอก head/tail window ไว้ด้วย
    const rescued = rescueFailureBlocks(lines.slice(headCount, tailStart));
    detail = [
      ...head,
      ...(rescued.length > 0
        ? ['... diagnostic output truncated (เก็บเฉพาะบรรทัดที่บ่งบอกความล้มเหลว) ...', ...rescued]
        : []),
      '... diagnostic output truncated ...',
      ...tail,
    ].join('\n');
  }
  if (detail.length <= DIAGNOSTIC_DETAIL_CHARACTERS) return detail;
  const half = Math.floor((DIAGNOSTIC_DETAIL_CHARACTERS - 40) / 2);
  return `${detail.slice(0, half)}\n... diagnostic output truncated ...\n${detail.slice(-half)}`;
}

function structuredEvidence(result, prefix) {
  if (!prefix) return [];
  return sanitizeDiagnostic(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
    .split('\n')
    .flatMap((line) => {
      const marker = line.indexOf(prefix);
      if (marker < 0) return [];
      try {
        return [JSON.parse(line.slice(marker + prefix.length))];
      } catch {
        return [];
      }
    });
}

/**
 * node:test รายงานไฟล์ที่ process ตายกลางคันเป็น `not ok <file>` พร้อม `signal: 'SIGSEGV'` โดยไม่มี
 * assertion ใดแดงเลย — โค้ด TypeScript ล้วนไม่มีทางทำให้ process ตายแบบนั้น crash อยู่ใน native
 * layer (Prisma query engine / V8) docs/j3-handover.md บันทึกไว้ตั้งแต่ J3 ว่าไฟล์ที่ล้มเปลี่ยนไป
 * เรื่อย ๆ ไม่สัมพันธ์กับจำนวน PrismaClient และรีโปรในเครื่องไม่ได้เลยจาก 16 รอบ
 *
 * ผลคือ acceptance run ที่ยาว ~3 ชั่วโมงถูกบล็อกด้วยความล้มเหลวที่ไม่ได้บอกอะไรเกี่ยวกับ product
 * จึงรันคำสั่งนั้นซ้ำ "หนึ่งครั้ง" เฉพาะกรณีที่ทุกบล็อกที่ล้มตายด้วย signal เท่านั้น — ถ้ามี
 * assertion แดงปนมาแม้ตัวเดียวถือเป็นผลจริงและไม่รันซ้ำ และถ้ารอบสองยังตายซ้ำก็ถือว่าแดงจริง
 * diagnostic เก็บ `retriedAfterSignal` ไว้เสมอเพื่อให้ evidence บอกได้ว่ารอบนั้นมีการรันซ้ำ
 */
const CRASH_SIGNAL_PATTERN = /signal: '(SIG[A-Z0-9]+)'/;

function tapFailureBlocks(output) {
  const blocks = [];
  let current;
  for (const line of output.split('\n')) {
    if (/^\s*not ok\b/.test(line)) {
      current = [line];
      blocks.push(current);
      continue;
    }
    if (!current) continue;
    if (/^\s*(?:ok\b|# Subtest:|1\.\.|# tests\b)/.test(line)) {
      current = undefined;
      continue;
    }
    current.push(line);
  }
  return blocks;
}

/** คืนชื่อ signal เมื่อ "ทุก" บล็อกที่ล้มตายด้วย signal; undefined เมื่อมีความล้มเหลวจริงปนอยู่ */
function crashSignalOnlyFailure(result) {
  const blocks = tapFailureBlocks(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (blocks.length === 0) return undefined;
  const signals = new Set();
  for (const block of blocks) {
    const signal = block
      .map((line) => CRASH_SIGNAL_PATTERN.exec(line)?.[1])
      .find((match) => match !== undefined);
    if (!signal) return undefined;
    signals.add(signal);
  }
  return [...signals].sort().join(',');
}

function runCheckCommand(check, runner) {
  const [command, ...arguments_] = check.command;
  return runner(command, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function executeReadinessCheck(check, runner = spawnSync) {
  const startedAt = new Date();
  const started = performance.now();
  let result = runCheckCommand(check, runner);
  let retriedAfterSignal;
  if (result.status !== 0 || result.error) {
    retriedAfterSignal = crashSignalOnlyFailure(result);
    if (retriedAfterSignal) {
      process.stderr.write(
        `# ${check.id}: process ตายด้วย ${retriedAfterSignal} โดยไม่มี assertion แดง — รันซ้ำหนึ่งครั้ง\n`,
      );
      result = runCheckCommand(check, runner);
    }
  }
  const passed = result.status === 0 && !result.error;
  const evidence = passed ? structuredEvidence(result, check.evidencePrefix) : [];

  return {
    checkId: check.id,
    dependency: check.dependency,
    boundaries: check.boundaries,
    status: passed ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - started),
    ...(retriedAfterSignal ? { retriedAfterSignal } : {}),
    ...(evidence.length > 0 ? { evidence } : {}),
    ...(passed
      ? {}
      : {
          remediation: check.remediation,
          detail: diagnosticDetail(result),
        }),
  };
}

// checks หลายรายการมักอ้างคำสั่งเดิมซ้ำ (เช่น governance test:integration ถูกอ้างจาก
// หลาย dimension) การรันซ้ำแต่ละครั้งกิน CI time โดยไม่เพิ่ม coverage เพราะผลลัพธ์
// deterministic ต่อ SHA เดียวกัน — cache ผลตาม command เพื่อรันครั้งเดียวต่อ process
export function createMemoizedExecuteCheck(execute = executeReadinessCheck) {
  const cache = new Map();
  return (check) => {
    const key = JSON.stringify(check.command);
    if (cache.has(key)) return cache.get(key);
    const result = execute(check);
    cache.set(key, result);
    return result;
  };
}

export function skippedDiagnostic(check, blockedBy) {
  return {
    checkId: check.id,
    dependency: check.dependency,
    boundaries: check.boundaries,
    status: 'SKIP',
    blockedBy,
  };
}

export function runPhaseZeroReadiness() {
  const startedAt = new Date();
  const diagnostics = [];
  let blocker;

  for (const check of PHASE_ZERO_READINESS_CHECKS) {
    const diagnostic = blocker ? skippedDiagnostic(check, blocker) : executeReadinessCheck(check);
    diagnostics.push(diagnostic);
    process.stdout.write(`${JSON.stringify({ type: 'readiness.check', ...diagnostic })}\n`);
    if (diagnostic.status === 'FAIL') blocker = diagnostic.checkId;
  }

  const failed = diagnostics.filter(({ status }) => status === 'FAIL');
  const summary = {
    type: 'readiness.summary',
    workflow: 'phase-0-readiness',
    workflowVersion: 1,
    status: failed.length === 0 ? 'PASS' : 'FAIL',
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    passed: diagnostics.filter(({ status }) => status === 'PASS').length,
    failed: failed.length,
    skipped: diagnostics.filter(({ status }) => status === 'SKIP').length,
    entryCondition: failed.length === 0 ? 'READY_FOR_INBOUND_VOICE_PHASE_1' : 'NOT_READY',
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  const summary = runPhaseZeroReadiness();
  if (summary.status === 'FAIL') process.exitCode = 1;
}
