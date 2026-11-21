import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AgentCaseError,
  CASE_NOTE_MAX,
  CASE_SUBJECT_MAX,
  canTransition,
  listLimit,
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

test('เส้นทางสถานะ: OPEN ↔ RESOLVED และปิดได้จากทั้งสอง ส่วน CLOSED ไปต่อไม่ได้', () => {
  assert.equal(canTransition('OPEN', 'RESOLVED'), true);
  assert.equal(canTransition('RESOLVED', 'OPEN'), true);
  assert.equal(canTransition('OPEN', 'CLOSED'), true);
  assert.equal(canTransition('RESOLVED', 'CLOSED'), true);
  assert.equal(canTransition('OPEN', 'OPEN'), false);
  assert.equal(canTransition('RESOLVED', 'RESOLVED'), false);
  for (const to of ['OPEN', 'RESOLVED', 'CLOSED'] as const) {
    assert.equal(canTransition('CLOSED', to), false);
  }
});

test('ข้อความตัดช่องว่างหัวท้าย และนับความยาวเป็นตัวอักษร ไม่ใช่ byte', () => {
  assert.equal(
    textInput('  ลูกค้าขอคืนสินค้า  ', 'subject', CASE_SUBJECT_MAX),
    'ลูกค้าขอคืนสินค้า',
  );
  assert.equal(textInput('ก'.repeat(CASE_SUBJECT_MAX), 'subject', CASE_SUBJECT_MAX).length, 200);
  assert.equal(
    code(() => textInput('ก'.repeat(CASE_SUBJECT_MAX + 1), 'subject', CASE_SUBJECT_MAX)),
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

test('uuid รับเฉพาะรูปแบบที่ถูกต้องและคืนเป็นตัวพิมพ์เล็ก', () => {
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

test('expectedVersion ต้องเป็นจำนวนเต็มบวก', () => {
  assert.equal(versionInput(3), 3);
  for (const value of [0, -1, 1.5, '2', undefined]) {
    assert.equal(
      code(() => versionInput(value)),
      'INVALID:INVALID_INPUT:expectedVersion',
    );
  }
});

test('status รับเฉพาะสามค่าที่รองรับ', () => {
  assert.equal(statusInput('RESOLVED'), 'RESOLVED');
  assert.equal(
    code(() => statusInput('PENDING_CUSTOMER')),
    'INVALID:INVALID_INPUT:status',
  );
});

test('limit ของรายการมีค่าเริ่มต้น 50 และไม่เกิน 100', () => {
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

test('error code แต่ละตัวมีชนิดที่ API ใช้เลือก HTTP status', () => {
  assert.equal(new AgentCaseError('AGENT_REQUIRED').kind, 'FORBIDDEN');
  assert.equal(new AgentCaseError('CASE_NOT_FOUND').kind, 'NOT_FOUND');
  assert.equal(new AgentCaseError('WORK_NOT_FOUND').kind, 'NOT_FOUND');
  assert.equal(new AgentCaseError('VERSION_CONFLICT').kind, 'CONFLICT');
  assert.equal(new AgentCaseError('CONTACT_REQUIRED').kind, 'CONFLICT');
  assert.equal(new AgentCaseError('ASSIGNEE_NOT_IN_TEAM').kind, 'INVALID');
});
