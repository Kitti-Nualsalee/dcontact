import assert from 'node:assert/strict';
import test from 'node:test';
import { CoreError } from './tenant-core-errors.js';
import {
  newNotReadyReasonCode,
  notReadyReasonsFieldErrors,
  parseNotReadyReasonsRequest,
} from './tenant-core-not-ready-reasons.js';

const reason = (labelTh: string, labelEn: string, isActive = true, code?: string) => ({
  ...(code ? { code } : {}),
  labelTh,
  labelEn,
  isActive,
});

function rejects(body: unknown) {
  assert.throws(
    () => parseNotReadyReasonsRequest(body),
    (error: unknown) => error instanceof CoreError && error.status === 400,
  );
}

test('request: trims the name whitespace and accepts only known fields', () => {
  const parsed = parseNotReadyReasonsRequest({
    commandId: 'c',
    expectedRevision: '1',
    reasons: [{ code: 'BREAK', labelTh: ' Short break ', labelEn: ' Break ', isActive: true }],
  });
  assert.deepEqual(parsed.reasons, [reason('Short break', 'Break', true, 'BREAK')]);
  rejects({ reasons: [] });
  rejects({ reasons: [reason('a', 'b')], extra: 1 });
  rejects({ reasons: [{ ...reason('a', 'b'), position: 1 }] });
  rejects({ reasons: [{ labelTh: 'a', labelEn: 'b', isActive: 'yes' }] });
  rejects({ reasons: [reason('a', 'b', true, 'bad code')] });
  rejects({ reasons: [reason('a', 'b', true, 'BREAK'), reason('c', 'd', true, 'BREAK')] });
  rejects({ reasons: Array.from({ length: 31 }, (_, i) => reason(`th${i}`, `en${i}`)) });
});

test('rules: an empty/too long/duplicate name points at the row, and at least one reason must be enabled', () => {
  assert.deepEqual(
    notReadyReasonsFieldErrors([
      reason('Short break', 'Break'),
      reason('Staff meeting', 'Meeting'),
    ]),
    {},
  );
  assert.deepEqual(
    notReadyReasonsFieldErrors([
      reason('', 'Break'),
      reason('Staff meeting', 'meeting'),
      reason('Staff meeting', 'MEETING'),
      reason('x'.repeat(41), 'Long'),
    ]),
    {
      'reasons.0.labelTh': 'core.validation.notReadyReasonLabel',
      'reasons.2.labelTh': 'core.validation.notReadyReasonDuplicate',
      'reasons.2.labelEn': 'core.validation.notReadyReasonDuplicate',
      'reasons.3.labelTh': 'core.validation.notReadyReasonLabel',
    },
  );
  assert.deepEqual(notReadyReasonsFieldErrors([reason('Rest', 'Break', false)]), {
    reasons: 'core.validation.notReadyReasonActiveRequired',
  });
});

test('the code of a new reason comes from the English name and does not collide with existing ones', () => {
  assert.equal(newNotReadyReasonCode('Quality check', new Set()), 'QUALITY_CHECK');
  assert.equal(newNotReadyReasonCode('Break', new Set(['BREAK'])), 'BREAK_2');
  assert.equal(newNotReadyReasonCode('Break', new Set(['BREAK', 'BREAK_2'])), 'BREAK_3');
  assert.equal(newNotReadyReasonCode('1:1 coaching', new Set()), 'COACHING');
  assert.equal(newNotReadyReasonCode('ประชุม', new Set()), 'REASON'); // allow-thai: a Thai-only name falls back to the REASON code
  assert.equal(newNotReadyReasonCode('X', new Set()), 'X_X');
  assert.match(newNotReadyReasonCode('a'.repeat(60), new Set()), /^[A-Z][A-Z0-9_]{1,31}$/);
});
