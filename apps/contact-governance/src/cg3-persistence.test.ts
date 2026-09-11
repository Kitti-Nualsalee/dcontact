import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeLocalTimeWindows,
  stableDigest,
  validateCgEventPayloadV1,
  validateCgScope,
} from './cg3-persistence.js';

test('normalize local-time windows และ digest ให้ผลคงที่จากข้อมูลเชิงความหมายเดียวกัน', () => {
  const normalized = normalizeLocalTimeWindows([
    { daysOfWeek: [5, 1, 5], startLocal: '09:00', endLocal: '17:30' },
  ]);

  assert.deepEqual(normalized, [{ daysOfWeek: [1, 5], startLocal: '09:00', endLocal: '17:30' }]);
  assert.equal(
    stableDigest({ windows: normalized, timezone: 'Asia/Bangkok' }),
    stableDigest({ timezone: 'Asia/Bangkok', windows: normalized }),
  );
});

test('ปฏิเสธ local-time windows ที่ทับซ้อนกันหลัง normalize ข้ามเที่ยงคืน', () => {
  assert.throws(
    () =>
      normalizeLocalTimeWindows([
        { daysOfWeek: [1], startLocal: '22:00', endLocal: '02:00' },
        { daysOfWeek: [2], startLocal: '01:00', endLocal: '03:00' },
      ]),
    /ทับซ้อนกัน/,
  );
});

test('validate scope และ event payload จาก JSON ที่ boundary พร้อม normalize ค่า optional', () => {
  const scope = validateCgScope({ channel: 'LINE', purpose: ' SERVICE_NOTIFICATION ' });
  assert.deepEqual(scope, {
    identityId: null,
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    contactKind: null,
  });

  assert.deepEqual(
    validateCgEventPayloadV1({
      contractVersion: 1,
      mutationId: 'mutation-1',
      subjectVersion: 2,
      affectedScope: scope,
      effectiveAt: '2026-09-11T02:00:00.000Z',
      stateDigest: 'a'.repeat(64),
    }),
    {
      contractVersion: 1,
      mutationId: 'mutation-1',
      subjectVersion: 2,
      affectedScope: scope,
      effectiveAt: '2026-09-11T02:00:00.000Z',
      stateDigest: 'a'.repeat(64),
    },
  );
});

test('ปฏิเสธ JSON scope/payload ที่ channel, version หรือ digest ไม่ถูกต้อง', () => {
  assert.throws(() => validateCgScope({ channel: 'SMS' }), /channel/);
  assert.throws(
    () =>
      validateCgEventPayloadV1({
        contractVersion: 1,
        mutationId: 'mutation-1',
        subjectVersion: 0,
        affectedScope: {},
        effectiveAt: 'not-an-instant',
        stateDigest: 'unsafe',
      }),
    /subjectVersion/,
  );
  assert.throws(
    () =>
      validateCgEventPayloadV1({
        contractVersion: 1,
        subjectVersion: 1,
        affectedScope: {},
        effectiveAt: '2026-09-11T02:00:00.000Z',
        stateDigest: 'a'.repeat(64),
      }),
    /mutationId/,
  );
  assert.throws(
    () =>
      validateCgEventPayloadV1({
        contractVersion: 1,
        mutationId: 'mutation-1',
        subjectVersion: 1,
        affectedScope: {},
        effectiveAt: '2026-09-11T02:00:00.000Z',
        stateDigest: 'a'.repeat(64),
        rawContact: 'ห้ามติดไปกับ event',
      }),
    /field ที่ไม่รู้จัก: rawContact/,
  );
});
