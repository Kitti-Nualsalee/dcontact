import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentCaseError,
  CASE_NOTE_MAX,
  CASE_SUBJECT_MAX,
  canTransition,
  decodeCaseCursor,
  encodeCaseCursor,
  listLimit,
  statusFilterInput,
  statusInput,
  textInput,
  uuidInput,
  versionInput,
} from './agent-cases.js';

function code(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof AgentCaseError) return `${error.kind}:${error.code}:${error.field ?? ''}`;
    throw error;
  }
  return undefined;
}

test('status path: OPEN ↔ RESOLVED, closing is allowed only from RESOLVED, and CLOSED cannot move on', () => {
  assert.equal(canTransition('OPEN', 'RESOLVED'), true);
  assert.equal(canTransition('RESOLVED', 'OPEN'), true);
  assert.equal(canTransition('OPEN', 'CLOSED'), false);
  assert.equal(canTransition('RESOLVED', 'CLOSED'), true);
  assert.equal(canTransition('OPEN', 'OPEN'), false);
  assert.equal(canTransition('RESOLVED', 'RESOLVED'), false);
  for (const to of ['OPEN', 'RESOLVED', 'CLOSED'] as const) {
    assert.equal(canTransition('CLOSED', to), false);
  }
});

test('text is trimmed at both ends and length is counted in characters, not bytes', () => {
  assert.equal(
    textInput('  ลูกค้าขอคืนสินค้า  ', 'subject', CASE_SUBJECT_MAX), // allow-thai: Thai text for trim and character counting
    'ลูกค้าขอคืนสินค้า', // allow-thai: Thai text for trim and character counting
  );
  assert.equal(textInput('ก'.repeat(CASE_SUBJECT_MAX), 'subject', CASE_SUBJECT_MAX).length, 200); // allow-thai: Thai characters counted by length, not bytes
  assert.equal(
    code(() => textInput('ก'.repeat(CASE_SUBJECT_MAX + 1), 'subject', CASE_SUBJECT_MAX)), // allow-thai: Thai characters counted by length, not bytes
    'INVALID:INVALID_INPUT:subject',
  );
  assert.equal(
    code(() => textInput('   ', 'note', CASE_NOTE_MAX)),
    'INVALID:INVALID_INPUT:note',
  );
  assert.equal(
    code(() => textInput(42, 'note', CASE_NOTE_MAX)),
    'INVALID:INVALID_INPUT:note',
  );
});

test('uuid accepts only a valid format and returns lowercase', () => {
  assert.equal(
    uuidInput('6F1D2C3B-4A5E-4F60-8A7B-9C0D1E2F3A4B', 'caseId'),
    '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b',
  );
  assert.equal(
    code(() => uuidInput('case-1', 'caseId')),
    'INVALID:INVALID_INPUT:caseId',
  );
  assert.equal(
    code(() => uuidInput(undefined, 'commandId')),
    'INVALID:INVALID_INPUT:commandId',
  );
});

test('expectedVersion must be a positive integer', () => {
  assert.equal(versionInput(3), 3);
  for (const value of [0, -1, 1.5, '2', undefined]) {
    assert.equal(
      code(() => versionInput(value)),
      'INVALID:INVALID_INPUT:expectedVersion',
    );
  }
});

test('status accepts only the three supported values', () => {
  assert.equal(statusInput('RESOLVED'), 'RESOLVED');
  assert.equal(
    code(() => statusInput('PENDING_CUSTOMER')),
    'INVALID:INVALID_INPUT:status',
  );
});

test('the list limit defaults to 50 and does not exceed 100', () => {
  assert.equal(listLimit(undefined), 50);
  assert.equal(listLimit(100), 100);
  assert.equal(
    code(() => listLimit(101)),
    'INVALID:INVALID_INPUT:limit',
  );
  assert.equal(
    code(() => listLimit(0)),
    'INVALID:INVALID_INPUT:limit',
  );
});

test('each error code has a kind the API uses to pick the HTTP status', () => {
  assert.equal(new AgentCaseError('AGENT_REQUIRED').kind, 'FORBIDDEN');
  assert.equal(new AgentCaseError('CASE_NOT_FOUND').kind, 'NOT_FOUND');
  assert.equal(new AgentCaseError('WORK_NOT_FOUND').kind, 'NOT_FOUND');
  assert.equal(new AgentCaseError('VERSION_CONFLICT').kind, 'CONFLICT');
  assert.equal(new AgentCaseError('CONTACT_REQUIRED').kind, 'CONFLICT');
  assert.equal(new AgentCaseError('ASSIGNEE_NOT_IN_TEAM').kind, 'INVALID');
});

test('a cursor decodes back to the same position, and forged or corrupt values are rejected', () => {
  const at = new Date('2026-11-21T10:00:00.123Z');
  const id = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
  assert.deepEqual(decodeCaseCursor(encodeCaseCursor(at, id)), { updatedAt: at, id });
  assert.equal(decodeCaseCursor(undefined), undefined);
  for (const value of ['not-base64', Buffer.from('[1,2]').toString('base64url'), 42]) {
    assert.equal(
      code(() => decodeCaseCursor(value)),
      'INVALID:INVALID_INPUT:cursor',
    );
  }
});

test('the status filter accepts NOT_CLOSED for cases that are not closed yet', () => {
  assert.equal(statusFilterInput('NOT_CLOSED'), 'NOT_CLOSED');
  assert.equal(statusFilterInput(''), undefined);
  assert.equal(statusFilterInput('OPEN'), 'OPEN');
  assert.equal(
    code(() => statusFilterInput('ALL')),
    'INVALID:INVALID_INPUT:status',
  );
});
