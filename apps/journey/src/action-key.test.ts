import assert from 'node:assert/strict';
import test from 'node:test';
import { createJourneyActionKey } from './action-key.js';

test('Journey action key คงที่ข้าม retry', () => {
  const input = {
    enrollmentId: 'enrollment-001',
    journeyVersion: 3,
    stepId: 'send-email-001',
  };

  assert.equal(createJourneyActionKey(input), 'enrollment-001:3:send-email-001');
  assert.equal(createJourneyActionKey({ ...input }), createJourneyActionKey(input));
});
