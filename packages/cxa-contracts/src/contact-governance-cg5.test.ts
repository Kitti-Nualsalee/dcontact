import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CG5_BOUND_API_SCOPES,
  CG5_CONFIG_BOUNDS,
  CG5_CONTRACT_VERSION,
  CG5_DEFAULT_TENANT_CONFIG,
  CG5_EVENT_AGGREGATE_TYPES,
  CG5_EVENT_TYPES,
  CG5_GRANULARITY_SECONDS,
  CG5_METRIC_FEEDS,
  CG5_METRIC_KEYS,
  CG5_RESERVED_API_SCOPES,
  CG5_RULE_CODES,
  CG5_RULE_REGISTRY_VERSION,
  Cg5ContractError,
  assertCg5BoundApiScope,
  assertCg5PiiFreePayload,
  assertCg5TenantConfig,
  assertSupportedCg5Versions,
  canCg5AlertTransition,
  cg5ConfigDigest,
  cg5DimensionKey,
  cg5RuleMetadata,
  isCg5RuleCode,
  validateCg5TenantConfig,
  type Cg5BoundApiScope,
  type Cg5ConfigField,
  type Cg5MetricDimensions,
} from './index.js';
import {
  createCg5AlertChangedPayloadFixture,
  createCg5ExportChangedPayloadFixture,
  createCg5ExportManifestFixture,
  createCg5TenantConfigFixture,
} from './testing/cg5-fixtures.js';

const DIMENSIONS: Cg5MetricDimensions = {
  channel: 'LINE',
  purpose: 'COLLECTION',
  decision: 'BLOCK',
  gate: 'TEMPORAL_POLICY',
  reasonCode: 'QUIET_HOURS',
  teamId: 'team-001',
};

test('dimensionKey does not depend on key order and separates rows whose dimension is null', () => {
  const reordered: Cg5MetricDimensions = {
    teamId: 'team-001',
    reasonCode: 'QUIET_HOURS',
    gate: 'TEMPORAL_POLICY',
    decision: 'BLOCK',
    purpose: 'COLLECTION',
    channel: 'LINE',
  };
  assert.equal(cg5DimensionKey(DIMENSIONS), cg5DimensionKey(reordered));
  assert.match(cg5DimensionKey(DIMENSIONS), /^[a-f0-9]{64}$/);

  // two rows that differ only in a null dimension must get different keys, otherwise the unique constraint lets duplicate rows through
  const withoutTeam = { ...DIMENSIONS, teamId: null };
  const withoutReason = { ...DIMENSIONS, reasonCode: null };
  assert.notEqual(cg5DimensionKey(DIMENSIONS), cg5DimensionKey(withoutTeam));
  assert.notEqual(cg5DimensionKey(withoutTeam), cg5DimensionKey(withoutReason));
});

test('all 8 metric keys have a feed path declared', () => {
  assert.equal(CG5_METRIC_KEYS.length, 8);
  for (const key of CG5_METRIC_KEYS) {
    assert.ok(
      CG5_METRIC_FEEDS[key] === 'EVENT_INBOX' || CG5_METRIC_FEEDS[key] === 'INCREMENTAL_READ',
    );
  }
  // decision volume must come from a periodic read of the canonical data, not from an event on the decision path (#266)
  assert.equal(CG5_METRIC_FEEDS['cg.decision'], 'INCREMENTAL_READ');
  assert.equal(CG5_METRIC_FEEDS['cg.reservation'], 'INCREMENTAL_READ');
  assert.equal(CG5_METRIC_FEEDS['cg.restriction'], 'EVENT_INBOX');
  assert.deepEqual(Object.values(CG5_GRANULARITY_SECONDS), [300, 3_600, 86_400]);
});

test('the rule registry is a closed set of 10 rules, and only baseline-comparison rules can be suppressed when data is incomplete', () => {
  assert.equal(CG5_RULE_CODES.length, 10);
  assert.ok(isCg5RuleCode('CG5_OPT_OUT_SPIKE'));
  assert.equal(isCg5RuleCode('CG5_NOT_A_RULE'), false);

  const lag = cg5RuleMetadata('CG5_PROJECTION_LAG');
  assert.equal(lag.kind, 'FIXED_THRESHOLD');
  assert.equal(lag.suppressibleByDataGap, false);
  assert.equal(lag.registryVersion, CG5_RULE_REGISTRY_VERSION);

  for (const code of CG5_RULE_CODES) {
    const metadata = cg5RuleMetadata(code);
    assert.equal(metadata.suppressibleByDataGap, metadata.kind === 'BASELINE_RELATIVE');
  }
});

test('an alert can change state only along the closed paths, and ack is not a close', () => {
  assert.ok(canCg5AlertTransition('OPEN', 'ACKED'));
  assert.ok(canCg5AlertTransition('ACKED', 'RESOLVED'));
  assert.ok(canCg5AlertTransition('RESOLVED', 'OPEN'));
  assert.equal(canCg5AlertTransition('RESOLVED', 'ACKED'), false);
  assert.equal(canCg5AlertTransition('SUPPRESSED', 'ACKED'), false);
});

test('write scopes are reserved by name but cannot be bound to a route yet', () => {
  assert.deepEqual([...CG5_BOUND_API_SCOPES], ['governance:read', 'governance:evidence']);
  assert.deepEqual([...CG5_RESERVED_API_SCOPES], ['governance:restrictions:write']);

  // after the assert passes, the type must narrow to only the scopes that can bind to a route, not the whole Cg5ApiScope
  const scope: string = 'governance:read';
  assertCg5BoundApiScope(scope);
  const bound: Cg5BoundApiScope = scope;
  assert.equal(bound, 'governance:read');

  assert.throws(
    () => assertCg5BoundApiScope('governance:restrictions:write'),
    (error: unknown) => error instanceof Cg5ContractError && error.code === 'SCOPE_NOT_BOUND',
  );
});

test('unsupported contract version and rule registry version fail closed', () => {
  assertSupportedCg5Versions({
    contractVersion: CG5_CONTRACT_VERSION,
    ruleRegistryVersion: CG5_RULE_REGISTRY_VERSION,
  });
  assert.throws(
    () =>
      assertSupportedCg5Versions({
        contractVersion: 2,
        ruleRegistryVersion: CG5_RULE_REGISTRY_VERSION,
      }),
    (error: unknown) =>
      error instanceof Cg5ContractError && error.code === 'UNSUPPORTED_CONTRACT_VERSION',
  );
  assert.throws(
    () =>
      assertSupportedCg5Versions({
        contractVersion: CG5_CONTRACT_VERSION,
        ruleRegistryVersion: 'CG5_RULE_REGISTRY_V2',
      }),
    (error: unknown) =>
      error instanceof Cg5ContractError && error.code === 'UNSUPPORTED_RULE_REGISTRY_VERSION',
  );
});

test('per-tenant config must be within the system-defined ranges and have every field', () => {
  assert.deepEqual(validateCg5TenantConfig(CG5_DEFAULT_TENANT_CONFIG), []);

  const tooLongRetention = createCg5TenantConfigFixture({ retentionDailyMonths: 24 });
  const violations = validateCg5TenantConfig(tooLongRetention);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.field, 'retentionDailyMonths');
  assert.equal(violations[0]?.reason, 'ABOVE_MAX');

  // may be set shorter than the ceiling but not longer (#268)
  assert.deepEqual(
    validateCg5TenantConfig(createCg5TenantConfigFixture({ retentionDailyMonths: 6 })),
    [],
  );

  assert.throws(
    () => assertCg5TenantConfig(tooLongRetention),
    (error: unknown) => error instanceof Cg5ContractError && error.code === 'CONFIG_OUT_OF_RANGE',
  );
  assert.throws(
    () => assertCg5TenantConfig({}),
    (error: unknown) => error instanceof Cg5ContractError && error.code === 'CONFIG_FIELD_MISSING',
  );
  assert.throws(
    () =>
      assertCg5TenantConfig(createCg5TenantConfigFixture({ refreshIntervalSeconds: Number.NaN })),
    (error: unknown) => error instanceof Cg5ContractError && error.code === 'CONFIG_OUT_OF_RANGE',
  );

  // the refresh interval is always on the order of minutes per #266
  const refresh = CG5_CONFIG_BOUNDS.refreshIntervalSeconds;
  assert.equal(refresh.min, 60);
  assert.equal(refresh.max, 300);
  assert.ok(refresh.fallback >= refresh.min && refresh.fallback <= refresh.max);
  for (const [field, range] of Object.entries(CG5_CONFIG_BOUNDS) as Array<
    [Cg5ConfigField, { min: number; max: number; fallback: number }]
  >) {
    assert.ok(range.min <= range.max, `${field} must have a usable range`);
    assert.ok(
      range.fallback >= range.min && range.fallback <= range.max,
      `${field} fallback must be within the range`,
    );
  }
});

test('config digest does not depend on key order and changes when an enforced value changes', () => {
  const left = createCg5TenantConfigFixture();
  const right = createCg5TenantConfigFixture();
  assert.equal(cg5ConfigDigest(left), cg5ConfigDigest(right));
  assert.notEqual(
    cg5ConfigDigest(left),
    cg5ConfigDigest(createCg5TenantConfigFixture({ lagSloSeconds: 240 })),
  );
});

test('alert and export payloads pass the check that they have no PII', () => {
  assertCg5PiiFreePayload(createCg5AlertChangedPayloadFixture());
  assertCg5PiiFreePayload(createCg5ExportChangedPayloadFixture());
  assertCg5PiiFreePayload(createCg5ExportManifestFixture());

  assert.throws(
    () =>
      assertCg5PiiFreePayload({
        ...createCg5AlertChangedPayloadFixture(),
        contactId: 'contact-001',
      }),
    (error: unknown) => error instanceof Cg5ContractError && error.code === 'PII_FIELD_FORBIDDEN',
  );
  assert.throws(
    () => assertCg5PiiFreePayload({ scope: { nested: [{ email: 'a@example.test' }] } }),
    (error: unknown) => error instanceof Cg5ContractError && error.code === 'PII_FIELD_FORBIDDEN',
  );
});

test('event type and aggregate type are constants consumers can rely on', () => {
  assert.equal(CG5_EVENT_TYPES.ALERT_CHANGED, 'governance.alert.changed');
  assert.equal(CG5_EVENT_TYPES.EXPORT_CHANGED, 'governance.export.changed');
  assert.equal(CG5_EVENT_AGGREGATE_TYPES.ALERT, 'contact_governance_alert');
  assert.equal(CG5_EVENT_AGGREGATE_TYPES.EXPORT, 'contact_governance_export');

  const alert = createCg5AlertChangedPayloadFixture();
  assert.equal(alert.contractVersion, CG5_CONTRACT_VERSION);
  assert.match(alert.stateDigest, /^[a-f0-9]{64}$/);
  assert.match(alert.scopeKey, /^[a-f0-9]{64}$/);
});
