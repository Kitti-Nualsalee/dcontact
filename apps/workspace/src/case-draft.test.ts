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

test('a new draft is empty, gets a new commandId every time, and is in the editing state', () => {
  let n = 0;
  const first = emptyCaseDraft(() => `cmd-${++n}`);
  const second = emptyCaseDraft(() => `cmd-${++n}`);
  assert.equal(first.phase, 'editing');
  assert.equal(first.subject, '');
  assert.equal(first.assigneeUserId, '');
  assert.notEqual(first.commandId, second.commandId);
});

test('text trims leading/trailing whitespace, merges CRLF, and counts in characters', () => {
  assert.equal(normalizeCaseText('  บรรทัดแรก\r\nบรรทัดสอง  '), 'บรรทัดแรก\nบรรทัดสอง'); // allow-thai: Thai text normalization fixture
  assert.equal(caseTextValid('   ', CASE_SUBJECT_MAX), false);
  assert.equal(caseTextValid('ก'.repeat(CASE_SUBJECT_MAX), CASE_SUBJECT_MAX), true); // allow-thai: Thai character counting
  assert.equal(caseTextValid('ก'.repeat(CASE_SUBJECT_MAX + 1), CASE_SUBJECT_MAX), false); // allow-thai: Thai character counting
  assert.equal(caseTextValid('😀'.repeat(CASE_NOTE_MAX), CASE_NOTE_MAX), true);
});

test('an unknown result (network failure or 5xx) must lock and reuse the same commandId', () => {
  assert.deepEqual(classifyOpenCaseError(new TypeError('Failed to fetch')), { phase: 'unknown' });
  assert.deepEqual(classifyOpenCaseError(new AgentApiError(503, 'REQUEST_FAILED')), {
    phase: 'unknown',
  });
});

test('an error with a known result returns to editing with a new commandId and gives the correct reason', () => {
  const cases: Array<[number, string, string | undefined]> = [
    [409, 'WORK_NOT_ACTIVE', 'workClosed'],
    [409, 'WORK_HAS_CASE', 'workHasCase'],
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
