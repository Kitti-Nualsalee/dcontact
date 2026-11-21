import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentApiError } from './agent-api.js';
import {
  CASE_NOTE_MAX,
  CASE_SUBJECT_MAX,
  caseTextValid,
  classifyOpenCaseError,
  emptyCaseDraft,
  normalizeCaseText,
} from './case-draft.js';

test('ร่างใหม่ว่าง มี commandId ใหม่ทุกครั้ง และอยู่ในสถานะแก้ไข', () => {
  let n = 0;
  const first = emptyCaseDraft(() => `cmd-${++n}`);
  const second = emptyCaseDraft(() => `cmd-${++n}`);
  assert.equal(first.phase, 'editing');
  assert.equal(first.subject, '');
  assert.equal(first.assigneeUserId, '');
  assert.notEqual(first.commandId, second.commandId);
});

test('ข้อความตัดช่องว่างหัวท้าย รวม CRLF และนับเป็นตัวอักษร', () => {
  assert.equal(normalizeCaseText('  บรรทัดแรก\r\nบรรทัดสอง  '), 'บรรทัดแรก\nบรรทัดสอง');
  assert.equal(caseTextValid('   ', CASE_SUBJECT_MAX), false);
  assert.equal(caseTextValid('ก'.repeat(CASE_SUBJECT_MAX), CASE_SUBJECT_MAX), true);
  assert.equal(caseTextValid('ก'.repeat(CASE_SUBJECT_MAX + 1), CASE_SUBJECT_MAX), false);
  assert.equal(caseTextValid('😀'.repeat(CASE_NOTE_MAX), CASE_NOTE_MAX), true);
});

test('ไม่รู้ผล (เครือข่ายล้มหรือ 5xx) ต้องล็อกและใช้ commandId เดิม', () => {
  assert.deepEqual(classifyOpenCaseError(new TypeError('Failed to fetch')), { phase: 'unknown' });
  assert.deepEqual(classifyOpenCaseError(new AgentApiError(503, 'REQUEST_FAILED')), {
    phase: 'unknown',
  });
});

test('error ที่รู้ผลแน่นอนกลับไปแก้ไขพร้อม commandId ใหม่ และบอกเหตุที่ถูกต้อง', () => {
  const cases: Array<[number, string, string | undefined]> = [
    [409, 'WORK_NOT_ACTIVE', 'workClosed'],
    [404, 'WORK_NOT_FOUND', 'workClosed'],
    [400, 'ASSIGNEE_NOT_IN_TEAM', 'assigneeRejected'],
    [403, 'TEAM_REQUIRED', 'noTeam'],
    [409, 'CONTACT_REQUIRED', undefined],
    [400, 'INVALID_INPUT', 'invalid'],
    [409, 'COMMAND_PAYLOAD_MISMATCH', 'failed'],
  ];
  for (const [status, code, expected] of cases) {
    assert.deepEqual(classifyOpenCaseError(new AgentApiError(status, code)), {
      phase: 'editing',
      error: expected,
      newCommand: true,
    });
  }
});
