import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accessRows,
  grantableTeams,
  hasGrant,
  SEGMENT_LABEL_KEYS,
  SYSTEM_SEGMENTS,
  validRevokeReason,
} from './customer-access/model.js';

const teams = [
  { id: 't-b', name: 'ทีมบริการ', isActive: true },
  { id: 't-a', name: 'ทีมขาย', isActive: true },
  { id: 't-off', name: 'ทีมเดิม', isActive: false },
];

test('#915: แถวสิทธิ์ใช้ชื่อทีม เรียงตามชื่อแล้ว WORK ก่อน VIEW; ทีมที่ไม่รู้จักอยู่ท้าย', () => {
  const rows = accessRows(
    [
      { grantId: 'g1', teamId: 't-b', segmentId: 'system:vip', permission: 'VIEW', updatedAt: '' },
      { grantId: 'g2', teamId: 'gone', segmentId: 'system:vip', permission: 'WORK', updatedAt: '' },
      { grantId: 'g3', teamId: 't-b', segmentId: 'system:vip', permission: 'WORK', updatedAt: '' },
      { grantId: 'g4', teamId: 't-a', segmentId: 'system:all-customers', updatedAt: '' },
    ],
    teams,
  );
  assert.deepEqual(
    rows.map((row) => [row.grantId, row.teamName, row.permission]),
    [
      ['g4', 'ทีมขาย', 'VIEW'],
      ['g3', 'ทีมบริการ', 'WORK'],
      ['g1', 'ทีมบริการ', 'VIEW'],
      ['g2', null, 'WORK'],
    ],
  );
  assert.equal(rows[3]!.teamActive, false);
});

test('#915: ให้สิทธิ์ได้เฉพาะทีมที่ใช้งาน และกันการให้ซ้ำก่อนส่ง', () => {
  assert.deepEqual(
    grantableTeams(teams).map((team) => team.id),
    ['t-a', 't-b'],
  );
  const rows = accessRows(
    [
      {
        grantId: 'g',
        teamId: 't-a',
        segmentId: SYSTEM_SEGMENTS[0],
        permission: 'WORK',
        updatedAt: '',
      },
    ],
    teams,
  );
  assert.equal(
    hasGrant(rows, { teamId: 't-a', segmentId: SYSTEM_SEGMENTS[0], permission: 'WORK' }),
    true,
  );
  assert.equal(
    hasGrant(rows, { teamId: 't-a', segmentId: SYSTEM_SEGMENTS[0], permission: 'VIEW' }),
    false,
  );
});

test('#915: เหตุผลการถอนสิทธิ์ 3–120 ตัวอักษรหลังตัดช่องว่าง', () => {
  assert.equal(validRevokeReason('  ab '), false);
  assert.equal(validRevokeReason('ย้ายทีม'), true);
  assert.equal(validRevokeReason('x'.repeat(121)), false);
});

test('#915: label ของ segment ระบบไม่มี `:` ซึ่ง i18next ใช้แยก namespace', () => {
  for (const id of SYSTEM_SEGMENTS) assert.doesNotMatch(SEGMENT_LABEL_KEYS[id], /:/);
});
