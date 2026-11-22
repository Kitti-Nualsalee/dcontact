import assert from 'node:assert/strict';
import test from 'node:test';
import { unexpectedErrorCode } from './tenant-core-errors.js';

test('unexpectedErrorCode คืน Prisma code, SQLSTATE และรหัสของ trigger เพื่อหาเหตุของ 500 (#977)', () => {
  assert.equal(
    unexpectedErrorCode({
      code: 'P2010',
      meta: { code: '23514', message: 'ERROR: CORE_TEAM_EFFECT_RECEIPT_REQUIRED' },
    }),
    'P2010:23514:CORE_TEAM_EFFECT_RECEIPT_REQUIRED',
  );
});

test('unexpectedErrorCode ไม่คืนข้อความอิสระที่อาจมีข้อมูลผู้ใช้', () => {
  assert.equal(
    unexpectedErrorCode({
      code: 'P2002',
      meta: { code: '23505', message: 'ERROR: duplicate key (email)=(a@example.test)' },
    }),
    'P2002:23505',
  );
  assert.equal(unexpectedErrorCode(new Error('a@example.test is invalid')), null);
  assert.equal(unexpectedErrorCode({ code: 'not a stable code' }), null);
  assert.equal(unexpectedErrorCode(undefined), null);
});
