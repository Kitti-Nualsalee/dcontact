import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HttpException } from '@nestjs/common';
import { normalizePeopleCreate, peopleCreateDigest } from './tenant-people-input.js';

const commandId = '10a1d4f0-35f4-477a-922d-e3b527b612b0';
const teamId = '10a1d4f0-35f4-477a-922d-e3b527b612b1';
const input = {
  commandId,
  teamId,
  displayName: 'ทดสอบ ทีม',
  email: 'Agent@EXAMPLE.TEST',
  role: 'AGENT',
  extension: '1104',
};

function invalid(value: unknown, field: string) {
  assert.throws(
    () => normalizePeopleCreate(value),
    (error: unknown) => {
      assert.ok(error instanceof HttpException);
      assert.equal(error.getStatus(), 400);
      assert.deepEqual(error.getResponse(), { code: 'VALIDATION_FAILED', field });
      return true;
    },
  );
}

test('normalize create คง local-part และ derive username จาก email เท่านั้น', () => {
  const result = normalizePeopleCreate({ ...input, displayName: '  ทดสอบ   ทีม  ' });
  assert.equal(result.displayName, 'ทดสอบ ทีม');
  assert.equal(result.email, 'Agent@example.test');
  assert.equal(result.username, result.email);
  assert.equal(result.teamId, teamId);
});

test('email ใช้ IDNA lowercase และ trailing-dot normalization แบบ first-admin', () => {
  assert.equal(
    normalizePeopleCreate({ ...input, email: 'Agent@BÜCHER.TEST.' }).email,
    'Agent@xn--bcher-kva.test',
  );
});

test('digest ของ payload normalized ไม่เปลี่ยนจาก field order/commandId/whitespace', () => {
  const normalized = normalizePeopleCreate(input);
  const equivalent = normalizePeopleCreate({
    extension: '1104',
    role: 'AGENT',
    email: ' Agent@example.test ',
    displayName: ' ทดสอบ  ทีม ',
    teamId: teamId.toUpperCase(),
    commandId: '10a1d4f0-35f4-477a-922d-e3b527b612b2',
  });
  assert.equal(peopleCreateDigest(normalized), peopleCreateDigest(equivalent));
  assert.notEqual(
    peopleCreateDigest(normalized),
    peopleCreateDigest(
      normalizePeopleCreate({
        ...input,
        extension: '1105',
      }),
    ),
  );
  assert.notEqual(
    peopleCreateDigest(normalized),
    peopleCreateDigest(
      normalizePeopleCreate({
        ...input,
        email: 'agent@example.test',
      }),
    ),
  );
});

test('รับเฉพาะสาม domain roles และ extension เฉพาะ AGENT', () => {
  for (const role of ['SUPERVISOR', 'ADMIN']) {
    assert.equal(normalizePeopleCreate({ ...input, role, extension: null }).extension, null);
    const { extension, ...withoutExtension } = input;
    assert.equal(normalizePeopleCreate({ ...withoutExtension, role }).extension, null);
    invalid({ ...input, role }, 'extension');
  }
  for (const role of ['agent', 'PLATFORM_ADMIN', 'SERVICE', null])
    invalid({ ...input, role }, 'role');
  for (const extension of [null, undefined, 1104, ' 1104', '104', '1234567', '١١٠٤']) {
    invalid({ ...input, extension }, 'extension');
  }
});

test('ไม่รับ identity/authority/credential/unknown attributes จาก browser', () => {
  for (const field of [
    'tenantId',
    'userId',
    'username',
    'isActive',
    'password',
    'realmRoles',
    'attributes',
    'keycloakId',
    'dc_identity_class',
    '__proto__',
  ]) {
    invalid({ ...input, [field]: 'injected' }, 'body');
  }
  for (const value of [null, [], 'create', 12]) invalid(value, 'body');
});

test('ชื่อใช้ Unicode codepoints 1–120 และปฏิเสธ control ก่อนยุบ whitespace', () => {
  assert.equal(
    normalizePeopleCreate({ ...input, displayName: '😀'.repeat(120) }).displayName.length,
    240,
  );
  for (const displayName of [
    '',
    ' ',
    '😀'.repeat(121),
    'ชื่อ\nใหม่',
    'ชื่อ\tใหม่',
    'ชื่อ\u0000ใหม่',
  ]) {
    invalid({ ...input, displayName }, 'displayName');
  }
});

test('email ปฏิเสธ malformed/controls/URL/เกินความยาวโดยไม่คืน payload', () => {
  invalid({ ...input, email: 'Agent\u200b@example.test' }, 'email');
  invalid({ ...input, displayName: 'Agent\u200b' }, 'displayName');
  for (const email of [
    'a b@example.test',
    'a@@example.test',
    'a@example',
    'a@example.test/path',
    'a@example.test:443',
    'a\u0000b@example.test',
    `${'a'.repeat(65)}@example.test`,
    `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.test`,
  ]) {
    invalid({ ...input, email }, 'email');
  }
});

test('team และ command ต้องเป็น UUID; canonical เป็น lowercase', () => {
  assert.equal(
    normalizePeopleCreate({ ...input, commandId: commandId.toUpperCase() }).commandId,
    commandId,
  );
  for (const field of ['teamId', 'commandId']) {
    for (const value of [undefined, '', 'wrong', 123]) invalid({ ...input, [field]: value }, field);
  }
});
