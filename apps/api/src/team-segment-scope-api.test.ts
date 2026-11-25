import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { teamScopePermission, teamScopeSegment } from './team-segment-scope-api.js';

test('#915: permission accepts VIEW and WORK; unspecified uses the default only', () => {
  assert.equal(teamScopePermission('VIEW'), 'VIEW');
  assert.equal(teamScopePermission('WORK'), 'WORK');
  assert.equal(teamScopePermission(undefined, 'VIEW'), 'VIEW');
  for (const value of [undefined, 'CONTACT', 'work', '', null, 1])
    assert.throws(() => teamScopePermission(value), BadRequestException);
});

test('#915: a system segment with `:` passes while a value with other characters or too long is rejected', () => {
  assert.equal(teamScopeSegment('system:all-customers'), 'system:all-customers');
  assert.equal(teamScopeSegment('system:vip'), 'system:vip');
  assert.equal(teamScopeSegment('VIP'), 'VIP');
  for (const value of ['', 'a b', 'system/all', '../x', 'x'.repeat(121), undefined, 3])
    assert.throws(() => teamScopeSegment(value), BadRequestException);
});
