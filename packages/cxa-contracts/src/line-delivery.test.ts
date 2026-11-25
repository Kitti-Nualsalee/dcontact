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
  CORRELATED_TOUCH_ERROR_CODES,
  CorrelatedTouchError,
  LineOutcomeScopeError,
  assertLineOutcomeScope,
  isLineRetryKey,
  isTouchEvidenceKind,
  lineNormalizedOutcome,
  lineProviderSettlement,
} from './index.js';

// this package compiles to CommonJS, so it uses __dirname instead of import.meta
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
  assert.ok(match, `enum ${name} not found in migration`);
  return [...match[1]!.matchAll(/'([A-Z0-9_]+)'/g)].map((value) => value[1]!);
}

test('the vocabulary in the contract matches every Postgres enum of the migration', () => {
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

test('outcome code -> class in the contract matches the CHECK of dl_provider_submission_attempts', () => {
  const check = persistenceSql.match(/"outcome_class" = CASE "outcome_code"([\s\S]*?)END/);
  assert.ok(check);
  const fromSql = Object.fromEntries(
    [...check[1]!.matchAll(/WHEN '([A-Z_]+)' THEN '([A-Z_]+)'/g)].map((row) => [row[1], row[2]]),
  );
  assert.deepEqual(fromSql, { ...LINE_PROVIDER_OUTCOME_CLASS });
  // 2xx/409 is acceptance only, not delivered; unknown is still reconciled with the original key
  assert.equal(LINE_PROVIDER_OUTCOME_CLASS.LINE_ACCEPTED_REPLAY, 'ACCEPTED');
  assert.equal(LINE_PROVIDER_OUTCOME_CLASS.LINE_RESPONSE_INVALID, 'RETRYABLE_UNKNOWN');
});

test('the operational rejection list matches the CHECK of dl_provider_submission_attempts_rejection_check', () => {
  // unlike the outcome class, this CHECK is NOT (scope=RECIPIENT AND code IN (...)), not a straight CASE
  // so the code list still has to be parsed out and compared, otherwise TS and the DB can drift apart with no test to catch it
  const check = persistenceSql.match(
    /"rejection_scope" = 'RECIPIENT'\s*\n\s*AND "outcome_code" IN \(([^)]*)\)/,
  );
  assert.ok(check);
  const codesFromSql = [...check[1]!.matchAll(/'([A-Z_]+)'/g)].map((row) => row[1]!);
  assert.deepEqual(codesFromSql.sort(), [...LINE_ALWAYS_OPERATIONAL_REJECTIONS].sort());
});

test('rejection scope: only TERMINAL_REJECTED needs a scope, and auth/rate/quota are operational', () => {
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

test('the retry key must be a lowercase hexadecimal UUID, and the caps match the S2 profile', () => {
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

test('the line-delivery contract has no network, provider SDK or credential dependency', () => {
  const source = readFileSync(resolve(here, 'line-delivery.ts'), 'utf8');
  const imports = [...source.matchAll(/from '([^']+)'/g)].map((row) => row[1]);
  // the shared Governance vocabulary may come in only as type-only, so there is no runtime cycle
  assert.deepEqual(imports, ['./identifiers.js', './contact-governance.js']);
  assert.match(source, /import type \{[^}]*\} from '\.\/contact-governance\.js';/);
  assert.doesNotMatch(source, /\bfetch\(|https?:\/\/|@line\/|process\.env/);
});

// ── S2.2 (#364): settlement matrix and correlated Touch ──────────────────────

test('acceptance is Attempt 1/Touch 0/refund 0, and a rejection counts the Attempt by scope', () => {
  for (const accepted of ['LINE_ACCEPTED', 'LINE_ACCEPTED_REPLAY'] as const) {
    assert.deepEqual(
      { ...lineProviderSettlement(accepted) },
      {
        countsAsAttempt: true,
        countsAsSuccessfulTouch: false,
        refundOnFailure: false,
      },
    );
    assert.equal(lineNormalizedOutcome(accepted), 'PROVIDER_ACCEPTED');
  }

  assert.equal(lineProviderSettlement('LINE_REQUEST_REJECTED', 'RECIPIENT').countsAsAttempt, true);
  assert.equal(
    lineProviderSettlement('LINE_REQUEST_REJECTED', 'OPERATIONAL').countsAsAttempt,
    false,
  );
  for (const operational of LINE_ALWAYS_OPERATIONAL_REJECTIONS) {
    assert.equal(lineProviderSettlement(operational, 'OPERATIONAL').countsAsAttempt, false);
    assert.equal(lineNormalizedOutcome(operational), 'PROVIDER_REJECTED');
  }

  // unknown/quarantined is not terminal yet: no Attempt/Touch/refund, and the sweeper must not release
  for (const unresolved of [
    'LINE_PROVIDER_UNAVAILABLE',
    'LINE_UNKNOWN_OUTCOME',
    'LINE_RESPONSE_INVALID',
    'LINE_RETRY_WINDOW_EXPIRED',
  ] as const) {
    assert.deepEqual(
      { ...lineProviderSettlement(unresolved) },
      {
        countsAsAttempt: false,
        countsAsSuccessfulTouch: false,
        refundOnFailure: false,
      },
    );
    assert.equal(lineNormalizedOutcome(unresolved), 'UNKNOWN_RECONCILING');
  }

  // no LINE outcome causes a Touch or refund from the settlement side
  for (const code of LINE_PROVIDER_OUTCOME_CODES) {
    const scope =
      LINE_PROVIDER_OUTCOME_CLASS[code] === 'TERMINAL_REJECTED' ? 'OPERATIONAL' : undefined;
    const decision = lineProviderSettlement(code, scope);
    assert.equal(decision.countsAsSuccessfulTouch, false, code);
    assert.equal(decision.refundOnFailure, false, code);
  }
});

test('LINE settlement rejects an outcome/scope pair that violates the contract instead of guessing', () => {
  assert.throws(() => lineProviderSettlement('LINE_REQUEST_REJECTED'), LineOutcomeScopeError);
  assert.throws(
    () => lineProviderSettlement('LINE_AUTH_INVALID', 'RECIPIENT'),
    LineOutcomeScopeError,
  );
  assert.throws(() => lineProviderSettlement('LINE_ACCEPTED', 'RECIPIENT'), LineOutcomeScopeError);
});

test('Touch evidence accepts only a quoted response and a signed postback: no time-window', () => {
  assert.deepEqual([...TOUCH_EVIDENCE_KINDS], ['USER_QUOTED_RESPONSE', 'SIGNED_POSTBACK']);
  for (const kind of TOUCH_EVIDENCE_KINDS) assert.equal(isTouchEvidenceKind(kind), true);
  for (const rejected of [
    'TIME_WINDOW',
    'UNQUOTED_RESPONSE',
    'AMBIGUOUS_RESPONSE',
    'INFERRED',
    'user_quoted_response',
    '',
    undefined,
    null,
    true,
  ]) {
    assert.equal(isTouchEvidenceKind(rejected), false, String(rejected));
  }
});

test('CorrelatedTouchError keeps the full set of machine-readable codes', () => {
  assert.deepEqual(
    [...CORRELATED_TOUCH_ERROR_CODES],
    [
      'ATTEMPT_NOT_FOUND',
      'ATTEMPT_NOT_ACCEPTED',
      'TOUCH_BINDING_CONFLICT',
      'TOUCH_EVIDENCE_CONFLICT',
      'TOUCH_EVIDENCE_KIND_UNSUPPORTED',
    ],
  );
  const error = new CorrelatedTouchError('ATTEMPT_NOT_FOUND');
  assert.ok(error instanceof Error);
  assert.equal(error.code, 'ATTEMPT_NOT_FOUND');
  assert.equal(error.name, 'CorrelatedTouchError');
});

test('the LINE rejection scope matches the shared vocabulary and the CgFactOutcome in the migration', () => {
  assert.deepEqual([...LINE_REJECTION_SCOPES], ['RECIPIENT', 'OPERATIONAL']);
  // PROVIDER_ACCEPTED must really exist in the DB-side enum before the write path can settle this value
  assert.match(enumValuesSql, /"CgFactOutcome" ADD VALUE IF NOT EXISTS 'PROVIDER_ACCEPTED'/);
});
