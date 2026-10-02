import assert from 'node:assert/strict';
import test from 'node:test';
import {
  displayNameFromClaims,
  shellRolesFromClaims,
  shellUserFromClaims,
  userInitials,
} from './user.js';

test('ชื่อที่แสดง: name → given_name + family_name → preferred_username', () => {
  assert.equal(
    displayNameFromClaims({ name: 'สมชาย ใจดี', given_name: 'x', preferred_username: 'y' }),
    'สมชาย ใจดี',
  );
  assert.equal(
    displayNameFromClaims({
      given_name: 'Somchai',
      family_name: 'Jaidee',
      preferred_username: 'y',
    }),
    'Somchai Jaidee',
  );
  assert.equal(displayNameFromClaims({ given_name: 'Somchai' }), 'Somchai');
  assert.equal(displayNameFromClaims({ name: '  ', preferred_username: 'agent01' }), 'agent01');
  assert.equal(displayNameFromClaims({}), '');
});

test('บทบาท: เฉพาะที่รู้จักตามลำดับคงที่ — role อื่นใน token ถูกซ่อน', () => {
  assert.deepEqual(
    shellRolesFromClaims({
      realm_access: { roles: ['agent', 'offline_access', 'admin', 'default-roles-dcontact'] },
    }),
    ['admin', 'agent'],
  );
  assert.deepEqual(shellRolesFromClaims({ realm_access: { roles: 'admin' } }), []);
  assert.deepEqual(shellRolesFromClaims({}), []);
});

test('shellUserFromClaims รวมชื่อ, email, organization และบทบาท', () => {
  assert.deepEqual(
    shellUserFromClaims(
      {
        name: 'Somchai Jaidee',
        email: 'somchai@example.com',
        realm_access: { roles: ['supervisor'] },
      },
      'acme',
    ),
    {
      displayName: 'Somchai Jaidee',
      email: 'somchai@example.com',
      organization: 'acme',
      roles: ['supervisor'],
    },
  );
  assert.equal(shellUserFromClaims({ name: 'x', email: '' }).email, undefined);
});

test('อักษรย่อ: ไทยข้ามสระหน้า, อังกฤษเป็นตัวพิมพ์ใหญ่, ไม่มีตัวอักษร = ว่าง', () => {
  assert.equal(userInitials('Somchai Jaidee'), 'SJ');
  assert.equal(userInitials('somchai'), 'S');
  assert.equal(userInitials('สมชาย ใจดี'), 'สจ');
  assert.equal(userInitials('ไพโรจน์ แก้วใส'), 'พก');
  assert.equal(userInitials('Anna Maria de Souza'), 'AS');
  assert.equal(userInitials('  (agent) 01 '), 'A');
  assert.equal(userInitials('123 456'), '');
  assert.equal(userInitials(''), '');
});
