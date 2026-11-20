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

test('request: ตัดช่องว่างชื่อ และรับเฉพาะ field ที่รู้จัก', () => {
  const parsed = parseNotReadyReasonsRequest({
    commandId: 'c',
    expectedRevision: '1',
    reasons: [{ code: 'BREAK', labelTh: ' พักสั้น ', labelEn: ' Break ', isActive: true }],
  });
  assert.deepEqual(parsed.reasons, [reason('พักสั้น', 'Break', true, 'BREAK')]);
  rejects({ reasons: [] });
  rejects({ reasons: [reason('a', 'b')], extra: 1 });
  rejects({ reasons: [{ ...reason('a', 'b'), position: 1 }] });
  rejects({ reasons: [{ labelTh: 'a', labelEn: 'b', isActive: 'yes' }] });
  rejects({ reasons: [reason('a', 'b', true, 'bad code')] });
  rejects({ reasons: [reason('a', 'b', true, 'BREAK'), reason('c', 'd', true, 'BREAK')] });
  rejects({ reasons: Array.from({ length: 31 }, (_, i) => reason(`th${i}`, `en${i}`)) });
});

test('กติกา: ชื่อว่าง/ยาวเกิน/ซ้ำ ชี้แถว และต้องเปิดอย่างน้อยหนึ่งเหตุผล', () => {
  assert.deepEqual(
    notReadyReasonsFieldErrors([reason('พักสั้น', 'Break'), reason('ประชุม', 'Meeting')]),
    {},
  );
  assert.deepEqual(
    notReadyReasonsFieldErrors([
      reason('', 'Break'),
      reason('ประชุม', 'meeting'),
      reason('ประชุม', 'MEETING'),
      reason('ก'.repeat(41), 'Long'),
    ]),
    {
      'reasons.0.labelTh': 'core.validation.notReadyReasonLabel',
      'reasons.2.labelTh': 'core.validation.notReadyReasonDuplicate',
      'reasons.2.labelEn': 'core.validation.notReadyReasonDuplicate',
      'reasons.3.labelTh': 'core.validation.notReadyReasonLabel',
    },
  );
  assert.deepEqual(notReadyReasonsFieldErrors([reason('พัก', 'Break', false)]), {
    reasons: 'core.validation.notReadyReasonActiveRequired',
  });
});

test('code ของเหตุผลใหม่มาจากชื่อภาษาอังกฤษ และไม่ชนกับที่มีอยู่', () => {
  assert.equal(newNotReadyReasonCode('Quality check', new Set()), 'QUALITY_CHECK');
  assert.equal(newNotReadyReasonCode('Break', new Set(['BREAK'])), 'BREAK_2');
  assert.equal(newNotReadyReasonCode('Break', new Set(['BREAK', 'BREAK_2'])), 'BREAK_3');
  assert.equal(newNotReadyReasonCode('1:1 coaching', new Set()), 'COACHING');
  assert.equal(newNotReadyReasonCode('ประชุม', new Set()), 'REASON');
  assert.equal(newNotReadyReasonCode('X', new Set()), 'X_X');
  assert.match(newNotReadyReasonCode('a'.repeat(60), new Set()), /^[A-Z][A-Z0-9_]{1,31}$/);
});
