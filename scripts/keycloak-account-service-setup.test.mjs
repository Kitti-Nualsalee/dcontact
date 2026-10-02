import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_USER_SCOPES,
  ALLOWED_USER_SCOPES,
  PROTECTED_PERMISSION,
  USERS_PERMISSION,
  clientRepresentation,
  permissionRepresentations,
  protectedUserIds,
} from './keycloak-account-service-setup.mjs';

test('ผู้ใช้ที่ไม่อยู่ใน Organization ใดถูกป้องกัน ส่วนสมาชิกของ tenant ไม่ถูกป้องกัน', () => {
  assert.deepEqual(
    protectedUserIds(
      ['tenant-a', 'platform-operator', 'tenant-b', 'service-account-x', 'tenant-a'],
      ['tenant-b', 'tenant-a', 'tenant-a'],
    ),
    ['platform-operator', 'service-account-x'],
  );
  assert.deepEqual(protectedUserIds([], []), []);
});

test('client ไม่มี browser/direct grant และใช้ service account เท่านั้น', () => {
  const client = clientRepresentation('secret');
  assert.equal(client.serviceAccountsEnabled, true);
  assert.equal(client.publicClient, false);
  assert.equal(client.standardFlowEnabled, false);
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.implicitFlowEnabled, false);
});

test('สิทธิ์ที่ให้มีแค่ view/manage/reset-password และ deny ครอบทุก scope ของผู้ใช้ที่ถูกป้องกัน', () => {
  const [allow, deny] = permissionRepresentations({
    allowPolicyId: 'allow',
    denyPolicyId: 'deny',
    protectedIds: ['p1', 'p2'],
  });
  assert.equal(allow.name, USERS_PERMISSION);
  assert.deepEqual(allow.scopes, [...ALLOWED_USER_SCOPES]);
  assert.equal(allow.resources, undefined);
  assert.deepEqual(allow.policies, ['allow']);
  assert.ok(!allow.scopes.includes('map-roles'));
  assert.ok(!allow.scopes.includes('impersonate'));

  assert.equal(deny.name, PROTECTED_PERMISSION);
  assert.deepEqual(deny.resources, ['p1', 'p2']);
  assert.deepEqual(deny.scopes, [...ALL_USER_SCOPES]);
  assert.deepEqual(deny.policies, ['deny']);
  for (const scope of ALLOWED_USER_SCOPES) assert.ok(deny.scopes.includes(scope));
});

test('ไม่มีผู้ใช้ที่ต้องป้องกัน → ไม่สร้าง deny (deny ที่ไม่มี resources จะ deny ผู้ใช้ทุกคน)', () => {
  const permissions = permissionRepresentations({
    allowPolicyId: 'allow',
    denyPolicyId: 'deny',
    protectedIds: [],
  });
  assert.deepEqual(
    permissions.map((permission) => permission.name),
    [USERS_PERMISSION],
  );
});
