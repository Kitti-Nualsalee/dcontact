import assert from 'node:assert/strict';
import test from 'node:test';
import { unexpectedErrorCode } from './tenant-core-errors.js';

test('unexpectedErrorCode returns the Prisma code, SQLSTATE and the trigger code to find the cause of a 500 (#977)', () => {
  assert.equal(
    unexpectedErrorCode({
      code: 'P2010',
      meta: { code: '23514', message: 'ERROR: CORE_TEAM_EFFECT_RECEIPT_REQUIRED' },
    }),
    'P2010:23514:CORE_TEAM_EFFECT_RECEIPT_REQUIRED',
  );
});

test('unexpectedErrorCode does not return free text that may contain user data', () => {
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
