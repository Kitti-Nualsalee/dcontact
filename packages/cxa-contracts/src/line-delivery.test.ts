import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  DELIVERY_ADAPTERS,
  LINE_ALWAYS_OPERATIONAL_REJECTIONS,
  LINE_CAP_KINDS,
  LINE_CAP_RESERVATION_STATES,
  LINE_CREDENTIAL_KINDS,
  LINE_CREDENTIAL_STATUSES,
  LINE_KILL_REASONS,
  LINE_PILOT_CAPS,
  LINE_PROVIDER_OUTCOME_CLASS,
  LINE_PROVIDER_OUTCOME_CLASSES,
  LINE_PROVIDER_OUTCOME_CODES,
  LINE_REJECTION_SCOPES,
  LINE_ROLLOUT_STATES,
  LINE_RUN_AUTHORIZATION_STATES,
  LINE_TOUCH_CORRELATION_STATES,
  LINE_WEBHOOK_CODES,
  LINE_WEBHOOK_INBOX_STATES,
  TOUCH_EVIDENCE_KINDS,
  LineOutcomeScopeError,
  assertLineOutcomeScope,
  isLineRetryKey,
} from './index.js';

// package นี้ compile เป็น CommonJS จึงใช้ __dirname แทน import.meta
const here = __dirname;
const migrations = resolve(here, '../../db/prisma/migrations');
const persistenceSql = readFileSync(
  resolve(migrations, '20260922160100_add_s2_line_persistence/migration.sql'),
  'utf8',
);
const enumValuesSql = readFileSync(
  resolve(migrations, '20260922160000_add_s2_line_enum_values/migration.sql'),
  'utf8',
);

function postgresEnum(name: string): string[] {
  const match = persistenceSql.match(new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`));
  assert.ok(match, `ไม่พบ enum ${name} ใน migration`);
  return [...match[1]!.matchAll(/'([A-Z0-9_]+)'/g)].map((value) => value[1]!);
}

test('vocabulary ใน contract ตรงกับ Postgres enum ของ migration ทุกชุด', () => {
  const pairs: Array<[string, readonly string[]]> = [
    ['DlLineProviderOutcomeCode', LINE_PROVIDER_OUTCOME_CODES],
    ['DlLineProviderOutcomeClass', LINE_PROVIDER_OUTCOME_CLASSES],
    ['DlLineRejectionScope', LINE_REJECTION_SCOPES],
    ['DlLineRolloutState', LINE_ROLLOUT_STATES],
    ['DlLineKillReason', LINE_KILL_REASONS],
    ['DlLineRunAuthorizationState', LINE_RUN_AUTHORIZATION_STATES],
    ['DlLineCapKind', LINE_CAP_KINDS],
    ['DlLineCapReservationState', LINE_CAP_RESERVATION_STATES],
    ['DlLineCredentialKind', LINE_CREDENTIAL_KINDS],
    ['DlLineCredentialStatus', LINE_CREDENTIAL_STATUSES],
    ['DlLineWebhookInboxState', LINE_WEBHOOK_INBOX_STATES],
    ['DlLineWebhookCode', LINE_WEBHOOK_CODES],
    ['DlLineTouchCorrelationState', LINE_TOUCH_CORRELATION_STATES],
    ['CgTouchEvidenceKind', TOUCH_EVIDENCE_KINDS],
  ];
  for (const [name, values] of pairs) assert.deepEqual(postgresEnum(name), [...values], name);
  assert.match(enumValuesSql, /"DlDeliveryAdapter" ADD VALUE IF NOT EXISTS 'LINE_MESSAGING_API'/);
  assert.match(enumValuesSql, /"CgFactOutcome" ADD VALUE IF NOT EXISTS 'PROVIDER_ACCEPTED'/);
  assert.deepEqual([...DELIVERY_ADAPTERS], ['TEST_ADAPTER', 'LINE_MESSAGING_API']);
});

test('outcome code -> class ใน contract ตรงกับ CHECK ของ dl_provider_submission_attempts', () => {
  const check = persistenceSql.match(/"outcome_class" = CASE "outcome_code"([\s\S]*?)END/);
  assert.ok(check);
  const fromSql = Object.fromEntries(
    [...check[1]!.matchAll(/WHEN '([A-Z_]+)' THEN '([A-Z_]+)'/g)].map((row) => [row[1], row[2]]),
  );
  assert.deepEqual(fromSql, { ...LINE_PROVIDER_OUTCOME_CLASS });
  // 2xx/409 เป็น acceptance เท่านั้น ไม่ใช่ delivered; unknown ยัง reconcile ด้วย key เดิม
  assert.equal(LINE_PROVIDER_OUTCOME_CLASS.LINE_ACCEPTED_REPLAY, 'ACCEPTED');
  assert.equal(LINE_PROVIDER_OUTCOME_CLASS.LINE_RESPONSE_INVALID, 'RETRYABLE_UNKNOWN');
});

test('operational rejection list ตรงกับ CHECK ของ dl_provider_submission_attempts_rejection_check', () => {
  // ต่างจาก outcome class ตรงที่ CHECK นี้เป็น NOT (scope=RECIPIENT AND code IN (...)) ไม่ใช่ CASE
  // ตรง ๆ — ยังต้อง parse รายชื่อ code ออกมาเทียบ ไม่งั้น TS กับ DB เดินแยกกันได้โดยไม่มีเทสต์จับ
  const check = persistenceSql.match(
    /"rejection_scope" = 'RECIPIENT'\s*\n\s*AND "outcome_code" IN \(([^)]*)\)/,
  );
  assert.ok(check);
  const codesFromSql = [...check[1]!.matchAll(/'([A-Z_]+)'/g)].map((row) => row[1]!);
  assert.deepEqual(codesFromSql.sort(), [...LINE_ALWAYS_OPERATIONAL_REJECTIONS].sort());
});

test('rejection scope: เฉพาะ TERMINAL_REJECTED ต้องมี scope และ auth/rate/quota เป็น operational', () => {
  assert.equal(assertLineOutcomeScope('LINE_ACCEPTED'), 'ACCEPTED');
  assert.equal(assertLineOutcomeScope('LINE_REQUEST_REJECTED', 'RECIPIENT'), 'TERMINAL_REJECTED');
  assert.equal(assertLineOutcomeScope('LINE_RATE_LIMITED', 'OPERATIONAL'), 'TERMINAL_REJECTED');
  assert.throws(
    () => assertLineOutcomeScope('LINE_AUTH_INVALID', 'RECIPIENT'),
    LineOutcomeScopeError,
  );
  assert.throws(() => assertLineOutcomeScope('LINE_REQUEST_REJECTED'), LineOutcomeScopeError);
  assert.throws(
    () => assertLineOutcomeScope('LINE_UNKNOWN_OUTCOME', 'OPERATIONAL'),
    LineOutcomeScopeError,
  );
});

test('retry key ต้องเป็น hexadecimal UUID ตัวพิมพ์เล็ก และ caps ตรง profile S2', () => {
  assert.equal(isLineRetryKey('123e4567-e89b-12d3-a456-426614174000'), true);
  assert.equal(isLineRetryKey('123E4567-E89B-12D3-A456-426614174000'), false);
  assert.equal(isLineRetryKey('pk_0123456789abcdef'), false);
  assert.deepEqual(
    { ...LINE_PILOT_CAPS },
    {
      logicalDeliveriesPerRun: 1,
      runAuthorizationTtlMinutes: 30,
      logicalDeliveriesPerRecipientPer24h: 1,
      logicalDeliveriesPer24h: 3,
      logicalDeliveriesLifetime: 10,
      concurrentSubmissions: 1,
      concurrentUnknownReconciling: 1,
      providerAttemptsPerLogicalDelivery: 4,
    },
  );
});

test('line-delivery contract ไม่มี network, provider SDK หรือ credential dependency', () => {
  const source = readFileSync(resolve(here, 'line-delivery.ts'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((row) => row[1]);
  assert.deepEqual(imports, ['./identifiers.js']);
  assert.doesNotMatch(source, /\bfetch\(|https?:\/\/|@line\/|process\.env/);
});
