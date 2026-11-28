import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCg4ConsentScope,
  assertCg4PolicyRegistryConsistent,
  buildCg4PolicyScopeKey,
  cg4PolicyScopeMatches,
  cg4PolicyScopeSpecificity,
  cg4PolicyScopesAmbiguous,
  compileCg4Policy,
  normalizeCg4PolicyContent,
  parseCg4PolicyScopeKey,
  Cg4PolicyValidationError,
} from './cg4-policy-compiler.js';

function content(overrides: Record<string, unknown> = {}) {
  return {
    timezoneFallback: 'Asia/Bangkok',
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '06:00' }],
    callbackMode: 'TIME_POLICY_OVERRIDE',
    overridableRules: ['QUIET_HOURS'],
    allowedOperationalRuleCodes: ['QUIET_HOURS'],
    holidays: [{ localDate: '2026-01-01', effect: 'CLOSED', windows: [] }],
    ...overrides,
  };
}

test('a scope key is a canonical form that round-trips and counts specificity from the dimensions actually bound', () => {
  const key = buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'MARKETING' });
  assert.equal(key, 'channel=VOICE|contactKind=*|purpose=MARKETING|sourceType=*');
  assert.deepEqual(parseCg4PolicyScopeKey(key), { channel: 'VOICE', purpose: 'MARKETING' });
  assert.equal(cg4PolicyScopeSpecificity(key), 2);
  assert.equal(cg4PolicyScopeSpecificity(buildCg4PolicyScopeKey({})), 0);
});

test('a scope key that is not in canonical form is rejected', () => {
  for (const bad of ['channel=VOICE', 'channel=VOICE|purpose=X|contactKind=*|sourceType=*', '']) {
    assert.throws(() => parseCg4PolicyScopeKey(bad), Cg4PolicyValidationError);
  }
  assert.throws(() => buildCg4PolicyScopeKey({ channel: 'a|b' }), Cg4PolicyValidationError);
});

test('scopes with equal specificity that bind different dimensions count as ambiguous', () => {
  const byChannel = buildCg4PolicyScopeKey({ channel: 'VOICE' });
  const byPurpose = buildCg4PolicyScopeKey({ purpose: 'MARKETING' });
  assert.equal(cg4PolicyScopesAmbiguous(byChannel, byPurpose), true);
  // a single request that can really match both
  const request = { channel: 'VOICE' as const, purpose: 'MARKETING' };
  assert.equal(cg4PolicyScopeMatches(byChannel, request), true);
  assert.equal(cg4PolicyScopeMatches(byPurpose, request), true);
});

test('scopes that bind the same dimension with different values, or have different specificity, are not ambiguous', () => {
  assert.equal(
    cg4PolicyScopesAmbiguous(
      buildCg4PolicyScopeKey({ channel: 'VOICE' }),
      buildCg4PolicyScopeKey({ channel: 'EMAIL' }),
    ),
    false,
  );
  assert.equal(
    cg4PolicyScopesAmbiguous(
      buildCg4PolicyScopeKey({ channel: 'VOICE' }),
      buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'MARKETING' }),
    ),
    false,
  );
  assert.equal(
    cg4PolicyScopesAmbiguous(
      buildCg4PolicyScopeKey({ channel: 'VOICE' }),
      buildCg4PolicyScopeKey({ channel: 'VOICE' }),
    ),
    false,
  );
});

test('normalizing gives the same content digest to payloads that differ only in order/duplicate values', () => {
  const left = compileCg4Policy({ content: content(), version: 1 });
  const right = compileCg4Policy({
    content: content({
      allowedOperationalRuleCodes: ['QUIET_HOURS', 'QUIET_HOURS'],
      quietHours: [{ daysOfWeek: [7, 6, 5, 4, 3, 2, 1], startLocal: '22:00', endLocal: '06:00' }],
    }),
    version: 1,
  });
  assert.equal(left.contentDigest, right.contentDigest);
});

test('content with a field outside the schema is rejected instead of being silently dropped', () => {
  assert.throws(
    () => normalizeCg4PolicyContent(content({ minGapSeconds: 900 })),
    (error: unknown) =>
      error instanceof Cg4PolicyValidationError && error.code === 'VALIDATION_FAILED',
  );
});

test('a rule that cannot be overridden or is not in the registry cannot enter the allowlist', () => {
  assert.throws(
    () =>
      assertCg4PolicyRegistryConsistent(
        normalizeCg4PolicyContent(content({ allowedOperationalRuleCodes: ['DNC_GLOBAL'] })),
      ),
    (error: unknown) =>
      error instanceof Cg4PolicyValidationError && error.code === 'NON_OVERRIDABLE_RULE',
  );
  assert.throws(
    () =>
      assertCg4PolicyRegistryConsistent(
        normalizeCg4PolicyContent(content({ allowedOperationalRuleCodes: ['NOT_A_RULE'] })),
      ),
    (error: unknown) =>
      error instanceof Cg4PolicyValidationError && error.code === 'RULE_NOT_REGISTERED',
  );
});

test('a rule that supports only callback cannot be put in the exception allowlist (and vice versa)', () => {
  assert.throws(
    () =>
      assertCg4PolicyRegistryConsistent(
        normalizeCg4PolicyContent(
          content({ allowedOperationalRuleCodes: ['PREFERENCE_WINDOW_CLOSED'] }),
        ),
      ),
    (error: unknown) =>
      error instanceof Cg4PolicyValidationError && error.code === 'NON_OVERRIDABLE_RULE',
  );
  assert.throws(
    () =>
      assertCg4PolicyRegistryConsistent(
        normalizeCg4PolicyContent(content({ overridableRules: ['MIN_GAP'] })),
      ),
    (error: unknown) =>
      error instanceof Cg4PolicyValidationError && error.code === 'NON_OVERRIDABLE_RULE',
  );
});

test('an unknown schema/registry/evaluator version makes the compile fail', () => {
  for (const overrides of [
    { schemaVersion: 2 },
    { registryVersion: 'CG4_RULE_REGISTRY_V0' },
    { evaluatorVersion: 'CG4_EVALUATOR_V0' },
  ]) {
    assert.throws(
      () => compileCg4Policy({ content: content(), version: 1, ...overrides }),
      (error: unknown) =>
        error instanceof Cg4PolicyValidationError && error.code === 'POLICY_VERSION_UNSUPPORTED',
    );
  }
});

test('compile returns the same facts that the runtime evaluator consumes', () => {
  const compiled = compileCg4Policy({ content: content(), version: 3 });
  assert.equal(compiled.facts.version, 3);
  assert.equal(compiled.facts.timezoneFallback, 'Asia/Bangkok');
  assert.equal(compiled.facts.callbackMode, 'TIME_POLICY_OVERRIDE');
  assert.deepEqual(compiled.facts.overridableRules, ['QUIET_HOURS']);
  assert.equal(compiled.facts.holidays.length, 1);
  assert.match(compiled.contentDigest, /^[a-f0-9]{64}$/);
});

test('a timezone that is not an IANA zone and a malformed holiday are rejected', () => {
  assert.throws(() => normalizeCg4PolicyContent(content({ timezoneFallback: 'Mars/Olympus' })));
  assert.throws(() =>
    normalizeCg4PolicyContent(content({ holidays: [{ localDate: '2026-1-1', effect: 'CLOSED' }] })),
  );
  assert.throws(() =>
    normalizeCg4PolicyContent(
      content({ holidays: [{ localDate: '2026-01-01', effect: 'WINDOWS', windows: [] }] }),
    ),
  );
  assert.throws(() =>
    normalizeCg4PolicyContent(
      content({
        holidays: [
          { localDate: '2026-01-01', effect: 'CLOSED', windows: [] },
          { localDate: '2026-01-01', effect: 'CLOSED', windows: [] },
        ],
      }),
    ),
  );
});

test('#1065 consent required is the default: saying so keeps the digest of content written before the option', () => {
  const before = compileCg4Policy({ content: content(), version: 1 });
  const explicit = compileCg4Policy({
    content: content({ consent: { requirement: 'REQUIRED' } }),
    version: 1,
  });
  assert.equal(explicit.contentDigest, before.contentDigest);
  assert.equal(before.facts.consent, undefined);
});

test('#1065 a policy that does not require consent compiles to the waiver the runtime reads', () => {
  const compiled = compileCg4Policy({
    content: content({ consent: { requirement: 'NOT_REQUIRED', lawfulBasis: ' CONTRACT ' } }),
    version: 2,
  });
  assert.deepEqual(compiled.content.consent, {
    requirement: 'NOT_REQUIRED',
    lawfulBasis: 'CONTRACT',
  });
  assert.deepEqual(compiled.facts.consent, compiled.content.consent);
  assert.notEqual(
    compiled.contentDigest,
    compileCg4Policy({ content: content(), version: 2 }).contentDigest,
  );
});

test('#1065 not requiring consent needs a lawful basis other than consent, and nothing else', () => {
  for (const consent of [
    { requirement: 'NOT_REQUIRED' },
    { requirement: 'NOT_REQUIRED', lawfulBasis: 'CONSENT' },
    { requirement: 'NOT_REQUIRED', lawfulBasis: 'BECAUSE' },
    { requirement: 'REQUIRED', lawfulBasis: 'CONTRACT' },
    { requirement: 'SOMETIMES' },
    { requirement: 'NOT_REQUIRED', lawfulBasis: 'CONTRACT', purposes: ['SERVICE'] },
  ]) {
    assert.throws(
      () => normalizeCg4PolicyContent(content({ consent })),
      (error: unknown) =>
        error instanceof Cg4PolicyValidationError && error.code === 'VALIDATION_FAILED',
      JSON.stringify(consent),
    );
  }
});

test('#1065 only a scope that names a purpose and a channel, and not marketing, may stop requiring consent', () => {
  const waived = normalizeCg4PolicyContent(
    content({ consent: { requirement: 'NOT_REQUIRED', lawfulBasis: 'CONTRACT' } }),
  );
  assert.doesNotThrow(() =>
    assertCg4ConsentScope(buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'SERVICE' }), waived),
  );
  for (const scope of [
    {},
    { channel: 'VOICE' },
    { purpose: 'SERVICE' },
    { channel: 'VOICE', purpose: 'MARKETING' },
  ] as const) {
    assert.throws(
      () => assertCg4ConsentScope(buildCg4PolicyScopeKey(scope), waived),
      (error: unknown) =>
        error instanceof Cg4PolicyValidationError && error.code === 'SCOPE_INVALID',
      JSON.stringify(scope),
    );
  }
  // a policy that requires consent may have any scope
  assert.doesNotThrow(() =>
    assertCg4ConsentScope(buildCg4PolicyScopeKey({}), normalizeCg4PolicyContent(content())),
  );
});
