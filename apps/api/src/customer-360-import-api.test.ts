import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { c360Uuid } from '@d-contact/customer-360';
import { c360ImportChildCommandId, c360ImportRowResult } from './customer-360-import-api.js';

const plan = 'a'.repeat(64);

test('child commandId คงที่ต่อ request/plan/แถว และเป็น UUID ที่ command ยอมรับ', () => {
  const id = randomUUID();
  const first = c360ImportChildCommandId(id, plan, 1);
  assert.equal(first, c360ImportChildCommandId(id, plan, 1));
  assert.equal(c360Uuid(first), first);
  const others = new Set([
    first,
    c360ImportChildCommandId(id, plan, 2),
    c360ImportChildCommandId(randomUUID(), plan, 1),
    c360ImportChildCommandId(id, 'b'.repeat(64), 1),
  ]);
  assert.equal(others.size, 4);
});

const receipt = (over: Record<string, unknown>) =>
  ({
    status: 200,
    state: 'TERMINAL' as const,
    receipt: {
      commandId: randomUUID(),
      action: 'CONTACT_CREATE',
      resourceType: 'CONTACT',
      resourceId: null,
      outcome: 'APPLIED',
      code: null,
      originalHttpStatus: 201,
      committedRevisions: {},
      resourceRefs: [],
      committedAt: new Date().toISOString(),
      readbackRequired: true,
      ...over,
    },
  }) as never;

test('ผล command เป็นสถานะรายแถวโดยไม่มีค่า raw และ UNKNOWN ไม่ถูกนับเป็นล้ม', () => {
  const contact = randomUUID();
  assert.deepEqual(
    c360ImportRowResult(3, receipt({ resourceRefs: [{ type: 'CONTACT', id: contact }] })),
    { rowNo: 3, state: 'APPLIED', contactId: contact },
  );
  // ref ที่ผู้อ่านไม่มีสิทธิ์ถูกกรองออกแล้ว: ยัง APPLIED แต่ไม่มี contactId
  assert.deepEqual(c360ImportRowResult(4, receipt({})), { rowNo: 4, state: 'APPLIED' });
  assert.deepEqual(
    c360ImportRowResult(5, receipt({ outcome: 'REJECTED', code: 'FIELD_INVALID' })),
    {
      rowNo: 5,
      state: 'REJECTED',
      code: 'FIELD_INVALID',
    },
  );
  assert.deepEqual(
    c360ImportRowResult(6, { status: 202, state: 'PENDING', commandId: randomUUID() }),
    { rowNo: 6, state: 'PENDING' },
  );
  assert.deepEqual(
    c360ImportRowResult(7, { status: 404, state: 'UNKNOWN', commandId: randomUUID() }),
    { rowNo: 7, state: 'UNKNOWN' },
  );
});
