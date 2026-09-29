import assert from 'node:assert/strict';
import test from 'node:test';
import { dueExpirations, expiresAt, planMigration, sha256 } from './uat-object-storage.mjs';

const now = new Date('2026-10-01T12:00:00Z');
const key = (name) => `uat-evidence/tenant/run/${name}.png`;

test('วันหมดอายุตามกติกา S3: LastModified + 90 วัน ปัดขึ้นเป็นเที่ยงคืน UTC', () => {
  assert.equal(expiresAt('2026-07-05T08:30:00Z').toISOString(), '2026-10-04T00:00:00.000Z');
  assert.equal(expiresAt('2026-07-05T00:00:00Z').toISOString(), '2026-10-03T00:00:00.000Z');
});

test('plan: คัดลอกเฉพาะ object ที่ยังไม่หมดอายุและมีแถว พร้อมวันหมดอายุเดิม', () => {
  const plan = planMigration({
    now,
    sourceObjects: [
      { key: key('fresh'), lastModified: new Date('2026-09-20T10:00:00Z') },
      { key: key('expired'), lastModified: new Date('2026-06-01T10:00:00Z') },
      { key: 'migration/old.json', lastModified: new Date('2026-09-20T10:00:00Z') },
    ],
    rows: [
      {
        storageKey: key('fresh'),
        sha256: 'a'.repeat(64),
        recordedAt: new Date('2026-09-20T10:00:00Z'),
      },
      {
        storageKey: key('expired'),
        sha256: 'b'.repeat(64),
        recordedAt: new Date('2026-06-01T10:00:00Z'),
      },
    ],
  });
  assert.deepEqual(plan.problems, []);
  assert.deepEqual(plan.skippedExpired, [key('expired')]);
  assert.deepEqual(plan.copy, [
    {
      key: key('fresh'),
      sha256: 'a'.repeat(64),
      sourceLastModified: '2026-09-20T10:00:00.000Z',
      expiresAt: '2026-12-20T00:00:00.000Z',
    },
  ]);
});

test('plan: object ไม่มีแถว (orphan) และแถวที่ยังไม่หมดอายุแต่ไม่มี object = ผิดปกติ', () => {
  const plan = planMigration({
    now,
    sourceObjects: [{ key: key('orphan'), lastModified: new Date('2026-09-20T10:00:00Z') }],
    rows: [
      {
        storageKey: key('lost'),
        sha256: 'c'.repeat(64),
        recordedAt: new Date('2026-09-25T10:00:00Z'),
      },
      // แถวเก่าที่ object หมดอายุไปแล้ว = ปกติ (lifecycle ลบ object แต่แถวเป็น append-only)
      {
        storageKey: key('gone'),
        sha256: 'd'.repeat(64),
        recordedAt: new Date('2026-05-01T10:00:00Z'),
      },
    ],
  });
  assert.deepEqual(plan.problems, [
    { key: key('orphan'), kind: 'ORPHAN_OBJECT' },
    { key: key('lost'), kind: 'MISSING_OBJECT' },
  ]);
  assert.deepEqual(plan.copy, []);
});

test('expire: ลบเฉพาะรายการที่ถึงวันหมดอายุ ไม่ซ้ำ key และไม่แตะนอก prefix', () => {
  const manifests = [
    {
      entries: [
        { key: key('due'), expiresAt: '2026-10-01T00:00:00.000Z' },
        { key: key('later'), expiresAt: '2026-12-01T00:00:00.000Z' },
        { key: 'other/secret.txt', expiresAt: '2026-01-01T00:00:00.000Z' },
      ],
    },
    { entries: [{ key: key('due'), expiresAt: '2026-10-01T00:00:00.000Z' }] },
  ];
  assert.deepEqual(
    dueExpirations(manifests, now).map((entry) => entry.key),
    [key('due')],
  );
});

test('sha256 เป็น hex 64 ตัว', () => {
  assert.equal(
    sha256(Buffer.from('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});
