import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeCg4PolicyContent } from './cg4-policy-compiler.js';
import { classifyCg4PolicyDiff } from './cg4-policy-diff.js';

function content(overrides: Record<string, unknown> = {}) {
  return normalizeCg4PolicyContent({
    timezoneFallback: 'Asia/Bangkok',
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '06:00' }],
    callbackMode: 'SCOPED_OVERRIDE',
    overridableRules: ['QUIET_HOURS'],
    allowedOperationalRuleCodes: ['QUIET_HOURS'],
    holidays: [],
    ...overrides,
  });
}

test('content that is identical in every dimension is NEUTRAL', () => {
  assert.equal(classifyCg4PolicyDiff(content(), content()).diffClass, 'NEUTRAL');
});

test('wider quiet hours are TIGHTENING and narrower are RELAXATION', () => {
  const wider = content({
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '06:00' }],
  });
  const narrower = content({
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '23:00', endLocal: '06:00' }],
  });
  assert.equal(classifyCg4PolicyDiff(content(), wider).diffClass, 'TIGHTENING');
  assert.equal(classifyCg4PolicyDiff(content(), narrower).diffClass, 'RELAXATION');
});

test('quiet hours whose window shifts (partly wider, partly narrower) fail closed as RELAXATION', () => {
  const shifted = content({
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '23:00', endLocal: '07:00' }],
  });
  const diff = classifyCg4PolicyDiff(content(), shifted);
  assert.equal(diff.diffClass, 'RELAXATION');
  assert.equal(diff.changes.find((c) => c.dimension === 'quietHours')?.direction, 'RELAXATION');
});

test('adding a CLOSED holiday is TIGHTENING and removing it is RELAXATION', () => {
  const withHoliday = content({
    holidays: [{ localDate: '2026-01-01', effect: 'CLOSED', windows: [] }],
  });
  assert.equal(classifyCg4PolicyDiff(content(), withHoliday).diffClass, 'TIGHTENING');
  assert.equal(classifyCg4PolicyDiff(withHoliday, content()).diffClass, 'RELAXATION');
});

test('a WINDOWS holiday that opens wider than CLOSED is RELAXATION', () => {
  const closed = content({
    holidays: [{ localDate: '2026-01-02', effect: 'CLOSED', windows: [] }],
  });
  const windows = content({
    holidays: [
      {
        localDate: '2026-01-02',
        effect: 'WINDOWS',
        windows: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '09:00', endLocal: '17:00' }],
      },
    ],
  });
  assert.equal(classifyCg4PolicyDiff(closed, windows).diffClass, 'RELAXATION');
  assert.equal(classifyCg4PolicyDiff(windows, closed).diffClass, 'TIGHTENING');
});

test('a longer allowlist is RELAXATION and a shorter one is TIGHTENING', () => {
  const more = content({ allowedOperationalRuleCodes: ['QUIET_HOURS', 'TENANT_HOLIDAY'] });
  const none = content({ allowedOperationalRuleCodes: [] });
  assert.equal(classifyCg4PolicyDiff(content(), more).diffClass, 'RELAXATION');
  assert.equal(classifyCg4PolicyDiff(content(), none).diffClass, 'TIGHTENING');
});

test('a callback mode that allows more is RELAXATION', () => {
  assert.equal(
    classifyCg4PolicyDiff(content(), content({ callbackMode: 'TIME_POLICY_OVERRIDE' })).diffClass,
    'RELAXATION',
  );
  assert.equal(
    classifyCg4PolicyDiff(content(), content({ callbackMode: 'NO_OVERRIDE' })).diffClass,
    'TIGHTENING',
  );
});

test('changing the timezone fallback cannot be proven narrower, so it is RELAXATION', () => {
  const diff = classifyCg4PolicyDiff(content(), content({ timezoneFallback: 'America/New_York' }));
  assert.equal(diff.diffClass, 'RELAXATION');
  assert.equal(
    diff.changes.find((c) => c.dimension === 'timezoneFallback')?.direction,
    'RELAXATION',
  );
});

test('the first version of a scope compared with an empty baseline: quiet hours alone are TIGHTENING', () => {
  const tightOnly = content({
    callbackMode: 'NO_OVERRIDE',
    overridableRules: [],
    allowedOperationalRuleCodes: [],
  });
  assert.equal(classifyCg4PolicyDiff(null, tightOnly).diffClass, 'TIGHTENING');
  // if the first version also enables an override, it counts as having a relaxing dimension
  assert.equal(classifyCg4PolicyDiff(null, content()).diffClass, 'RELAXATION');
});

test('the diff digest differs when the base or candidate differs, and is stable for the same input', () => {
  const a = classifyCg4PolicyDiff(content(), content({ callbackMode: 'NO_OVERRIDE' }));
  const b = classifyCg4PolicyDiff(content(), content({ callbackMode: 'NO_OVERRIDE' }));
  const c = classifyCg4PolicyDiff(null, content({ callbackMode: 'NO_OVERRIDE' }));
  assert.equal(a.diffDigest, b.diffDigest);
  assert.notEqual(a.diffDigest, c.diffDigest);
});
