import assert from 'node:assert/strict';
import test from 'node:test';
import {
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

test('scope key เป็น canonical form ที่ round-trip ได้และนับ specificity จาก dimension ที่ผูกจริง', () => {
  const key = buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'MARKETING' });
  assert.equal(key, 'channel=VOICE|contactKind=*|purpose=MARKETING|sourceType=*');
  assert.deepEqual(parseCg4PolicyScopeKey(key), { channel: 'VOICE', purpose: 'MARKETING' });
  assert.equal(cg4PolicyScopeSpecificity(key), 2);
  assert.equal(cg4PolicyScopeSpecificity(buildCg4PolicyScopeKey({})), 0);
});

test('scope key ที่ไม่ใช่ canonical form ถูก reject', () => {
  for (const bad of ['channel=VOICE', 'channel=VOICE|purpose=X|contactKind=*|sourceType=*', '']) {
    assert.throws(() => parseCg4PolicyScopeKey(bad), Cg4PolicyValidationError);
  }
  assert.throws(() => buildCg4PolicyScopeKey({ channel: 'a|b' }), Cg4PolicyValidationError);
});

test('scope ที่ specificity เท่ากันแต่ผูกคนละ dimension ถือว่ากำกวม', () => {
  const byChannel = buildCg4PolicyScopeKey({ channel: 'VOICE' });
  const byPurpose = buildCg4PolicyScopeKey({ purpose: 'MARKETING' });
  assert.equal(cg4PolicyScopesAmbiguous(byChannel, byPurpose), true);
  // request เดียวที่ match ทั้งคู่ได้จริง
  const request = { channel: 'VOICE' as const, purpose: 'MARKETING' };
  assert.equal(cg4PolicyScopeMatches(byChannel, request), true);
  assert.equal(cg4PolicyScopeMatches(byPurpose, request), true);
});

test('scope ที่ผูก dimension เดียวกันคนละค่า หรือ specificity ต่างกัน ไม่กำกวม', () => {
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

test('normalize ทำให้ payload ที่ต่างแค่ลำดับ/ค่าซ้ำ ได้ content digest เดียวกัน', () => {
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

test('content ที่มี field นอก schema ถูก reject แทนที่จะถูกทิ้งเงียบ ๆ', () => {
  assert.throws(
    () => normalizeCg4PolicyContent(content({ minGapSeconds: 900 })),
    (error: unknown) =>
      error instanceof Cg4PolicyValidationError && error.code === 'VALIDATION_FAILED',
  );
});

test('rule ที่ override ไม่ได้หรือไม่อยู่ใน registry เข้า allowlist ไม่ได้', () => {
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

test('rule ที่รองรับเฉพาะ callback ใส่ใน exception allowlist ไม่ได้ (และกลับกัน)', () => {
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

test('schema/registry/evaluator version ที่ไม่รู้จักทำให้ compile ไม่ผ่าน', () => {
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

test('compile คืน facts ชุดเดียวกับที่ runtime evaluator กิน', () => {
  const compiled = compileCg4Policy({ content: content(), version: 3 });
  assert.equal(compiled.facts.version, 3);
  assert.equal(compiled.facts.timezoneFallback, 'Asia/Bangkok');
  assert.equal(compiled.facts.callbackMode, 'TIME_POLICY_OVERRIDE');
  assert.deepEqual(compiled.facts.overridableRules, ['QUIET_HOURS']);
  assert.equal(compiled.facts.holidays.length, 1);
  assert.match(compiled.contentDigest, /^[a-f0-9]{64}$/);
});

test('timezone ที่ไม่ใช่ IANA zone และ holiday ที่ผิดรูปถูก reject', () => {
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
