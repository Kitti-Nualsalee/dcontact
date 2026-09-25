import assert from 'node:assert/strict';
import test from 'node:test';
import { createFormatters } from './format.js';

// 16:40 ตามเวลาไทย
const AT = new Date('2026-09-12T09:40:00Z');
const now = () => AT;

test('th แสดงปี พ.ศ. เดือนย่อไทย เวลา 24 ชั่วโมง', () => {
  const f = createFormatters({ locale: 'th', timeZone: 'Asia/Bangkok', now });
  assert.equal(f.dateTime(AT), '12 ก.ย. 2569 16:40');
  assert.equal(f.date(AT), '12 ก.ย. 2569');
  assert.equal(f.time(AT), '16:40');
});

test('en ใช้ en-GB ปี ค.ศ. โดยไม่มี comma และย่อเดือนเป็น 3 ตัวอักษรทุกเวอร์ชัน ICU', () => {
  const f = createFormatters({ locale: 'en', timeZone: 'Asia/Bangkok', now });
  assert.equal(f.dateTime(AT), '12 Sep 2026 16:40');
  assert.equal(f.date('2026-01-05T00:00:00Z'), '5 Jan 2026');
});

test('เวลาหลังเที่ยงคืนเป็น 00 ไม่ใช่ 24 และไม่มี AM/PM', () => {
  const f = createFormatters({ locale: 'en', timeZone: 'UTC', now });
  assert.equal(f.time('2026-09-12T00:05:00Z'), '00:05');
  assert.equal(f.time('2026-09-12T13:05:00Z'), '13:05');
});

test('แสดงตาม timezone ที่ส่งเข้ามา ไม่ใช่เวลาเครื่อง — วันเปลี่ยนตาม timezone', () => {
  const instant = '2026-09-12T20:30:00Z';
  assert.equal(
    createFormatters({ locale: 'en', timeZone: 'Asia/Bangkok' }).dateTime(instant),
    '13 Sep 2026 03:30',
  );
  assert.equal(
    createFormatters({ locale: 'en', timeZone: 'America/New_York' }).dateTime(instant),
    '12 Sep 2026 16:30',
  );
});

test('relative time ใช้เฉพาะภายใน 24 ชั่วโมง', () => {
  const th = createFormatters({ locale: 'th', timeZone: 'Asia/Bangkok', now });
  const en = createFormatters({ locale: 'en', timeZone: 'Asia/Bangkok', now });
  const minus = (ms: number) => new Date(AT.getTime() - ms);
  assert.equal(en.relative(minus(5 * 60_000)), '5 minutes ago');
  assert.equal(th.relative(minus(5 * 60_000)), '5 นาทีที่ผ่านมา');
  assert.equal(en.relative(minus(30_000)), '30 seconds ago');
  assert.equal(en.relative(minus(3 * 3_600_000)), '3 hours ago');
  assert.equal(en.relative(new Date(AT.getTime() + 2 * 3_600_000)), 'in 2 hours');
  assert.equal(en.relative(minus(24 * 3_600_000)), '24 hours ago');
  assert.equal(en.relative(minus(25 * 3_600_000)), '11 Sep 2026 15:40');
  assert.equal(th.relative(minus(25 * 3_600_000)), '11 ก.ย. 2569 15:40');
});

test('ตัวเลขใช้เลขอารบิกทั้งสองภาษา', () => {
  assert.equal(createFormatters({ locale: 'th', timeZone: 'UTC' }).number(12345.6), '12,345.6');
  assert.equal(
    createFormatters({ locale: 'en', timeZone: 'UTC' }).number(0.25, { style: 'percent' }),
    '25%',
  );
});

test('วันที่ที่ parse ไม่ได้ต้องโยน error ไม่ใช่แสดง Invalid Date', () => {
  const f = createFormatters({ locale: 'th', timeZone: 'UTC' });
  assert.throws(() => f.dateTime('not-a-date'), RangeError);
});
