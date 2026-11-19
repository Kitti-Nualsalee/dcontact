import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { teamScopePermission, teamScopeSegment } from './team-segment-scope-api.js';

test('#915: permission รับ VIEW และ WORK; ไม่ส่งใช้ค่าเริ่มต้นเฉพาะที่ระบุ', () => {
  assert.equal(teamScopePermission('VIEW'), 'VIEW');
  assert.equal(teamScopePermission('WORK'), 'WORK');
  assert.equal(teamScopePermission(undefined, 'VIEW'), 'VIEW');
  for (const value of [undefined, 'CONTACT', 'work', '', null, 1])
    assert.throws(() => teamScopePermission(value), BadRequestException);
});

test('#915: segment ระบบที่มี `:` ผ่าน ส่วนค่าที่มีอักขระอื่นหรือยาวเกินถูกปฏิเสธ', () => {
  assert.equal(teamScopeSegment('system:all-customers'), 'system:all-customers');
  assert.equal(teamScopeSegment('system:vip'), 'system:vip');
  assert.equal(teamScopeSegment('VIP'), 'VIP');
  for (const value of ['', 'a b', 'system/all', '../x', 'x'.repeat(121), undefined, 3])
    assert.throws(() => teamScopeSegment(value), BadRequestException);
});
