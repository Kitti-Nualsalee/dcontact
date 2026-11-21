import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import {
  NO_DISPOSITION,
  filterKey,
  periodWindow,
  resolveTimeZone,
  summaryPeriodFrom,
  workFilterFrom,
  zonedDayStart,
} from './agent-work-metrics.js';

const code = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof BadRequestException);
    return (error.getResponse() as { code: string }).code;
  }
  assert.fail('expected BadRequestException');
};

test('ขอบวันใช้เขตเวลา tenant — 00:30 ที่กรุงเทพยังเป็นวันใหม่แม้ UTC ยังเป็นเมื่อวาน', () => {
  const now = new Date('2026-11-21T17:30:00.000Z'); // 22 พ.ย. 00:30 Asia/Bangkok
  assert.deepEqual(periodWindow('today', now, 'Asia/Bangkok'), {
    from: new Date('2026-11-21T17:00:00.000Z'),
    to: now,
  });
  assert.deepEqual(periodWindow('today', now, 'UTC'), {
    from: new Date('2026-11-21T00:00:00.000Z'),
    to: now,
  });
});

test('7 วันและ 30 วันนับวันนี้รวมด้วย all ไม่มีขอบต้น และทุกช่วงสิ้นสุดที่เวลาคำนวณ', () => {
  const now = new Date('2026-11-22T05:00:00.000Z');
  assert.deepEqual(periodWindow('7d', now, 'Asia/Bangkok'), {
    from: new Date('2026-11-15T17:00:00.000Z'),
    to: now,
  });
  assert.equal(
    periodWindow('30d', now, 'Asia/Bangkok').from?.toISOString(),
    '2026-10-23T17:00:00.000Z',
  );
  assert.deepEqual(periodWindow('all', now, 'Asia/Bangkok'), { from: null, to: now });
});

test('ช่วงที่คร่อมการเปลี่ยน DST ได้เที่ยงคืนตามเวลาท้องถิ่นทั้งสองฝั่ง', () => {
  // America/New_York เปลี่ยนกลับเวลามาตรฐาน 1 พ.ย. 2569
  const now = new Date('2026-11-03T15:00:00.000Z');
  assert.equal(zonedDayStart(now, 'America/New_York', 0).toISOString(), '2026-11-03T05:00:00.000Z');
  assert.equal(zonedDayStart(now, 'America/New_York', 6).toISOString(), '2026-10-28T04:00:00.000Z');
});

test('เที่ยงคืนที่หายไปตอนเข้า DST ใช้ instant แรกของวันนั้น ไม่ย้อนไปวันก่อน', () => {
  // America/Santiago ข้ามจาก 00:00 ไป 01:00 วันที่ 6 ก.ย. 2569
  assert.equal(
    zonedDayStart(new Date('2026-09-06T15:00:00.000Z'), 'America/Santiago', 0).toISOString(),
    '2026-09-06T04:00:00.000Z',
  );
  // America/Havana ข้ามเที่ยงคืนวันที่ 8 มี.ค. 2569
  assert.equal(
    zonedDayStart(new Date('2026-03-08T15:00:00.000Z'), 'America/Havana', 0).toISOString(),
    '2026-03-08T05:00:00.000Z',
  );
});

test('เขตเวลาไม่รู้จักหรือไม่ได้ตั้ง ใช้ UTC', () => {
  assert.equal(resolveTimeZone('Asia/Bangkok'), 'Asia/Bangkok');
  assert.equal(resolveTimeZone('Mars/Base'), 'UTC');
  assert.equal(resolveTimeZone(null), 'UTC');
});

test('period รับเฉพาะค่าที่รองรับ ค่าเริ่มต้น 7 วัน', () => {
  assert.equal(summaryPeriodFrom(undefined), '7d');
  assert.equal(summaryPeriodFrom('today'), 'today');
  for (const value of ['', '1d', ['7d'], 'ALL'])
    assert.equal(
      code(() => summaryPeriodFrom(value)),
      'INVALID_PERIOD',
    );
});

test('ตัวกรองรายการตรวจเวลา ช่วง และผลบันทึก', () => {
  const filter = workFilterFrom({
    from: '2026-11-15T17:00:00.000Z',
    to: '2026-11-22T17:00:00.000Z',
    disposition: 'CUSTOMER_ASSISTED',
  });
  assert.equal(filter.disposition, 'CUSTOMER_ASSISTED');
  assert.equal(workFilterFrom({ disposition: NO_DISPOSITION }).disposition, null);
  assert.equal(workFilterFrom({}).disposition, undefined);
  assert.equal(
    code(() => workFilterFrom({ from: '2026-11-15' })),
    'INVALID_FROM',
  );
  assert.equal(
    code(() => workFilterFrom({ to: ['2026-11-15T17:00:00.000Z'] })),
    'INVALID_TO',
  );
  assert.equal(
    code(() =>
      workFilterFrom({ from: '2026-11-15T17:00:00.000Z', to: '2026-11-15T17:00:00.000Z' }),
    ),
    'INVALID_RANGE',
  );
  assert.equal(workFilterFrom({ disposition: `A${'B'.repeat(79)}` }).disposition?.length, 80);
  for (const disposition of ['', 'a'.repeat(257), 'bad\nvalue'])
    assert.equal(
      code(() => workFilterFrom({ disposition })),
      'INVALID_DISPOSITION',
    );
});

test('cursor ผูกกับตัวกรอง — ทุกผลบันทึก, ไม่มีผลบันทึก และผลเฉพาะต่างกัน', () => {
  const keys = new Set([
    filterKey({ from: null, to: null }),
    filterKey({ from: null, to: null, disposition: null }),
    filterKey({ from: null, to: null, disposition: 'CUSTOMER_ASSISTED' }),
    filterKey({ from: new Date(0), to: null }),
  ]);
  assert.equal(keys.size, 4);
});
