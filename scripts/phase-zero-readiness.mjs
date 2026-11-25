import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

export const PHASE_ZERO_READINESS_CHECKS = [
  {
    id: 'environment',
    dependency: 'Docker Compose dev environment',
    boundaries: ['PostgreSQL', 'Redis', 'Object storage', 'Redpanda', 'FreeSWITCH', 'Keycloak'],
    command: [pnpm, 'infra:up'],
    remediation: 'Check the Docker daemon/port/volume and then run pnpm infra:up',
  },
  {
    id: 'database-baseline',
    dependency: 'PostgreSQL baseline',
    boundaries: ['migration', 'RLS policy', 'seed', 'Keycloak identity link'],
    command: [pnpm, 'infra:bootstrap'],
    remediation: 'Check PostgreSQL and then run pnpm infra:bootstrap',
  },
  {
    id: 'infrastructure-boundaries',
    dependency: 'Phase 0 infrastructure',
    boundaries: [
      'PostgreSQL connection',
      'Redis state store',
      'Object storage buckets (S3 HeadBucket)',
      'Redpanda cluster/topics',
      'FreeSWITCH ESL/SIP/WebSocket/RTP',
    ],
    command: [process.execPath, 'scripts/dev-infra-readiness.mjs'],
    remediation:
      'Use the dependency and the ✗ messages in the detail to fix the service, then re-run pnpm infra:ready',
  },
  {
    id: 'tenant-isolation',
    dependency: 'PostgreSQL RLS boundary',
    boundaries: [
      'dcontact_app has no tenant context',
      'dcontact_app uses the demo tenant context',
      'cross-tenant read/write rejection',
    ],
    command: [pnpm, '--filter', '@d-contact/db', 'test:integration'],
    remediation:
      'Check the migrations and packages/db/prisma/rls.sql and then run pnpm infra:bootstrap',
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
    remediation: 'Check the Keycloak realm and then run pnpm infra:identity:link',
  },
  {
    id: 'gateway-boundary',
    dependency: 'API Gateway identity boundary',
    boundaries: ['401 invalid identity', '403 insufficient role', 'verified tenant derivation'],
    command: [pnpm, '--filter', '@d-contact/api', 'test'],
    remediation: 'Check the API Gateway OIDC guard and the workspace session adapters',
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
    remediation: 'Check the Redpanda topics and the @d-contact/kafka contract',
  },
];

/** Strip credentials before showing child-process output in a diagnostic */
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
 * A GitHub Actions run ID is in the evidence path (`artifacts/<phase>/<runId>.json`) and some values happen to match
 * the Thai phone number pattern of the PII guard (e.g. 36683968610 has `66` + 8 digits), which made S1 crash while writing the manifest
 * instead of reporting the failed suite - used only for the `detail` text, not for JSON evidence that must be parsed further
 */
export function redactRunId(text, runId = process.env.GITHUB_RUN_ID) {
  return runId && /^\d+$/.test(runId) ? String(text).replaceAll(runId, '[RUN_ID]') : String(text);
}

/**
 * This window must be wide enough to cover the "failure block" of the test runner, not just the last summary line
 * When it was set to 10 lines/1500 characters, the diagnostic of a failed Playwright run kept only the line
 * "N failed" and the list of test names, while the real assertion message was cut off entirely, so the result of the gate
 * could say only that it failed but not why, which cannot be used as evidence to close a phase
 * Nested readiness serializes the diagnostic again at several levels, so the character window must be wide enough
 * to still show the root-cause assertion, and every message always passes sanitize before being kept
 */
const DIAGNOSTIC_DETAIL_LINES = 80;
const DIAGNOSTIC_DETAIL_CHARACTERS = 32_000;

/**
 * A line that says "what failed" must always survive truncation, wherever it sits in the output
 *
 * A head/tail window alone is not enough: the TAP of a suite with over a hundred tests pushes the `not ok` of the
 * failed test into the middle of the output, where it gets cut, leaving only `# fail 1` at the end, which says
 * something failed but not which test - hit twice in a row while chasing the J2 acceptance, forcing guesswork
 */
/**
 * `# Error:` is the only line saying a test file failed because of async activity that escaped after the test ended
 *
 * When a promise rejects after the test body has ended, node:test reports the test itself as ok as usual, and then
 * fails the "file" with failureType: 'testCodeFailure' and error: 'test failed', which says nothing
 * The real details are in the diagnostic line that starts with `# Error: Test "<test name>" at <file>:<line>
 * generated asynchronous activity after the test ended...` together with the original error message
 *
 * exitCode/signal is the only line that separates "a test failed an assert" from "the whole process died"
 *
 * node:test reports a test file whose process ended badly with the same failureType: 'testCodeFailure' and
 * error: 'test failed' every time; the details that give the real cause are only in signal: (e.g. SIGSEGV
 * of the Prisma engine when memory is low) or exitCode: - if these two lines are not kept when
 * truncating, only a cause-less failure remains and one has to guess why it was flaky
 */
const FAILURE_LINE_PATTERN =
  /^\s*(?:not ok\b|# fail\b|# Error\b|error:|failureType:|code: 'ERR_|exitCode:|signal:|AssertionError|\s*at .*\.(?:test|integration)\.ts)/;

/**
 * The `not ok`/`error:` lines say "what failed" but "why it failed" is in the next lines (the assertion message,
 * the actual/expected diff), which do not match FAILURE_LINE_PATTERN at all and so get cut - hit for real while chasing
 * CG4-OB02 in the J2 acceptance, where only `code: 'ERR_ASSERTION'` was left with no way to tell which assert
 *
 * so keep the continuous block after a failure line too, until the result of the next test appears
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
    // the result of the next test has started = the end of this failure block
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
  const safe = redactRunId(sanitizeDiagnostic(`${result.stderr ?? ''}\n${result.stdout ?? ''}`));
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
    // also keep the lines that indicate a failure that sit outside the head/tail window
    const rescued = rescueFailureBlocks(lines.slice(headCount, tailStart));
    detail = [
      ...head,
      ...(rescued.length > 0
        ? [
            '... diagnostic output truncated (only the lines that indicate a failure were kept) ...',
            ...rescued,
          ]
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
 * node:test reports a file whose process died midway as `not ok <file>` with `signal: 'SIGSEGV'` and no
 * red assertion at all - pure TypeScript code cannot make a process die like that; the crash is in the native
 * layer (Prisma query engine / V8). docs/j3-handover.md has recorded since J3 that the failing file keeps changing,
 * unrelated to the number of PrismaClients, and it could not be reproduced locally in 16 rounds
 *
 * The result is that an acceptance run of about 3 hours is blocked by a failure that says nothing about the product,
 * so re-run that command "once" only when every failed block died by a signal - if even one
 * red assertion is mixed in it is a real result and is not re-run, and if the second round dies again it counts as truly red
 * the diagnostic always keeps `retriedAfterSignal` so the evidence can say that the round was re-run
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

/** Return the signal name when "every" failed block died by a signal; undefined when a real failure is mixed in */
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
        `# ${check.id}: process died with ${retriedAfterSignal} with no red assertion - re-running once\n`,
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

// several checks often reference the same command (e.g. governance test:integration is referenced from
// several dimensions); each re-run costs CI time without adding coverage because the result is
// deterministic for the same SHA - cache the result by command so it runs once per process
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
