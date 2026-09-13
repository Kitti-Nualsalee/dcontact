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

test('content ที่เหมือนกันทุกมิติเป็น NEUTRAL', () => {
  assert.equal(classifyCg4PolicyDiff(content(), content()).diffClass, 'NEUTRAL');
});

test('quiet hours ที่กว้างขึ้นเป็น TIGHTENING แคบลงเป็น RELAXATION', () => {
  const wider = content({
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '06:00' }],
  });
  const narrower = content({
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '23:00', endLocal: '06:00' }],
  });
  assert.equal(classifyCg4PolicyDiff(content(), wider).diffClass, 'TIGHTENING');
  assert.equal(classifyCg4PolicyDiff(content(), narrower).diffClass, 'RELAXATION');
});

test('quiet hours ที่ขยับหน้าต่าง (กว้างขึ้นบางส่วน แคบลงบางส่วน) fail closed เป็น RELAXATION', () => {
  const shifted = content({
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '23:00', endLocal: '07:00' }],
  });
  const diff = classifyCg4PolicyDiff(content(), shifted);
  assert.equal(diff.diffClass, 'RELAXATION');
  assert.equal(diff.changes.find((c) => c.dimension === 'quietHours')?.direction, 'RELAXATION');
});

test('เพิ่มวันหยุด CLOSED เป็น TIGHTENING และถอดออกเป็น RELAXATION', () => {
  const withHoliday = content({
    holidays: [{ localDate: '2026-01-01', effect: 'CLOSED', windows: [] }],
  });
  assert.equal(classifyCg4PolicyDiff(content(), withHoliday).diffClass, 'TIGHTENING');
  assert.equal(classifyCg4PolicyDiff(withHoliday, content()).diffClass, 'RELAXATION');
});

test('วันหยุดแบบ WINDOWS ที่เปิดกว้างกว่า CLOSED เป็น RELAXATION', () => {
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

test('allowlist ที่ยาวขึ้นเป็น RELAXATION สั้นลงเป็น TIGHTENING', () => {
  const more = content({ allowedOperationalRuleCodes: ['QUIET_HOURS', 'TENANT_HOLIDAY'] });
  const none = content({ allowedOperationalRuleCodes: [] });
  assert.equal(classifyCg4PolicyDiff(content(), more).diffClass, 'RELAXATION');
  assert.equal(classifyCg4PolicyDiff(content(), none).diffClass, 'TIGHTENING');
});

test('callback mode ที่อนุญาตมากขึ้นเป็น RELAXATION', () => {
  assert.equal(
    classifyCg4PolicyDiff(content(), content({ callbackMode: 'TIME_POLICY_OVERRIDE' })).diffClass,
    'RELAXATION',
  );
  assert.equal(
    classifyCg4PolicyDiff(content(), content({ callbackMode: 'NO_OVERRIDE' })).diffClass,
    'TIGHTENING',
  );
});

test('เปลี่ยน timezone fallback พิสูจน์ไม่ได้ว่าแคบลง จึงเป็น RELAXATION', () => {
  const diff = classifyCg4PolicyDiff(content(), content({ timezoneFallback: 'America/New_York' }));
  assert.equal(diff.diffClass, 'RELAXATION');
  assert.equal(
    diff.changes.find((c) => c.dimension === 'timezoneFallback')?.direction,
    'RELAXATION',
  );
});

test('version แรกของ scope เทียบกับ baseline ว่าง: quiet hours อย่างเดียวเป็น TIGHTENING', () => {
  const tightOnly = content({
    callbackMode: 'NO_OVERRIDE',
    overridableRules: [],
    allowedOperationalRuleCodes: [],
  });
  assert.equal(classifyCg4PolicyDiff(null, tightOnly).diffClass, 'TIGHTENING');
  // ถ้า version แรกเปิด override ไว้ด้วย ถือว่ามีมิติที่ผ่อนคลาย
  assert.equal(classifyCg4PolicyDiff(null, content()).diffClass, 'RELAXATION');
});

test('diff digest ต่างกันเมื่อ base หรือ candidate ต่างกัน และคงที่เมื่อ input เดิม', () => {
  const a = classifyCg4PolicyDiff(content(), content({ callbackMode: 'NO_OVERRIDE' }));
  const b = classifyCg4PolicyDiff(content(), content({ callbackMode: 'NO_OVERRIDE' }));
  const c = classifyCg4PolicyDiff(null, content({ callbackMode: 'NO_OVERRIDE' }));
  assert.equal(a.diffDigest, b.diffDigest);
  assert.notEqual(a.diffDigest, c.diffDigest);
});
