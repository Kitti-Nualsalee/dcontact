import assert from 'node:assert/strict';
import test from 'node:test';
import {
  displayNameFromClaims,
  shellRolesFromClaims,
  shellUserFromClaims,
  userInitials,
} from './user.js';

test('display name: name → given_name + family_name → preferred_username', () => {
  assert.equal(
    displayNameFromClaims({ name: 'สมชาย ใจดี', given_name: 'x', preferred_username: 'y' }), // allow-thai: Thai name fixture
    'สมชาย ใจดี', // allow-thai: Thai name fixture
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

test('roles: only known ones in a fixed order — other roles in the token are hidden', () => {
  assert.deepEqual(
    shellRolesFromClaims({
      realm_access: { roles: ['agent', 'offline_access', 'admin', 'default-roles-dcontact'] },
    }),
    ['admin', 'agent'],
  );
  assert.deepEqual(shellRolesFromClaims({ realm_access: { roles: 'admin' } }), []);
  assert.deepEqual(shellRolesFromClaims({}), []);
});

test('shellUserFromClaims combines name, email, organization and roles', () => {
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

test('initials: Thai skips leading vowels, English is uppercase, no letters = empty', () => {
  assert.equal(userInitials('Somchai Jaidee'), 'SJ');
  assert.equal(userInitials('somchai'), 'S');
  assert.equal(userInitials('สมชาย ใจดี'), 'สจ'); // allow-thai: Thai initials
  assert.equal(userInitials('ไพโรจน์ แก้วใส'), 'พก'); // allow-thai: Thai initials
  assert.equal(userInitials('Anna Maria de Souza'), 'AS');
  assert.equal(userInitials('  (agent) 01 '), 'A');
  assert.equal(userInitials('123 456'), '');
  assert.equal(userInitials(''), '');
});

test('initials do not depend on the machine locale (e.g. Turkish i → I, not İ)', () => {
  assert.equal(userInitials('ilker ince'), 'II');
});
