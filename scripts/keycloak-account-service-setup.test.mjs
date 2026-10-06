import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_USER_SCOPES,
  ALLOWED_USER_SCOPES,
  PROTECTED_PERMISSION,
  ORG_MFA_FLOW,
  TENANT_BROWSER_FLOW,
  USERS_PERMISSION,
  browserFlowFailures,
  childrenOf,
  clientRepresentation,
  locateBrowserSubflows,
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

/** execution ของ `dcontact-browser` หลัง setup บน Keycloak 26.7.5 (ตัด field ที่ไม่ใช้) */
const configuredFlow = [
  { displayName: 'Cookie', level: 0, requirement: 'ALTERNATIVE', providerId: 'auth-cookie' },
  {
    displayName: 'dcontact-browser Organization',
    level: 0,
    requirement: 'ALTERNATIVE',
    authenticationFlow: true,
  },
  {
    displayName: 'dcontact-browser Browser - Conditional Organization',
    level: 1,
    requirement: 'CONDITIONAL',
    authenticationFlow: true,
  },
  {
    displayName: 'Condition - user configured',
    level: 2,
    requirement: 'REQUIRED',
    providerId: 'conditional-user-configured',
  },
  {
    displayName: 'Organization Identity-First Login',
    level: 2,
    requirement: 'ALTERNATIVE',
    providerId: 'organization',
  },
  {
    displayName: 'dcontact-browser forms',
    level: 0,
    requirement: 'ALTERNATIVE',
    authenticationFlow: true,
  },
  {
    displayName: 'Username Password Form',
    level: 1,
    requirement: 'REQUIRED',
    providerId: 'auth-username-password-form',
  },
  {
    displayName: 'dcontact-browser Browser - Conditional 2FA',
    level: 1,
    requirement: 'CONDITIONAL',
    authenticationFlow: true,
  },
  {
    displayName: 'Condition - user configured',
    level: 2,
    requirement: 'REQUIRED',
    providerId: 'conditional-user-configured',
  },
  {
    displayName: 'Condition - credential',
    level: 2,
    requirement: 'REQUIRED',
    providerId: 'conditional-credential',
    authenticationConfig: 'credential',
  },
  { displayName: 'OTP Form', level: 2, requirement: 'ALTERNATIVE', providerId: 'auth-otp-form' },
  {
    displayName: 'Condition - organization requires 2FA',
    level: 2,
    requirement: 'REQUIRED',
    providerId: 'dc-org-mfa-required',
    authenticationConfig: 'negate',
  },
  { displayName: ORG_MFA_FLOW, level: 1, requirement: 'CONDITIONAL', authenticationFlow: true },
  {
    displayName: 'Condition - organization requires 2FA',
    level: 2,
    requirement: 'REQUIRED',
    providerId: 'dc-org-mfa-required',
  },
  { displayName: 'OTP Form', level: 2, requirement: 'REQUIRED', providerId: 'auth-otp-form' },
];

test('childrenOf คืนเฉพาะลูกโดยตรงของ subflow ตามลำดับ depth-first', () => {
  assert.deepEqual(
    childrenOf(configuredFlow, -1).map((execution) => execution.displayName),
    ['Cookie', 'dcontact-browser Organization', 'dcontact-browser forms'],
  );
  assert.deepEqual(
    childrenOf(configuredFlow, 5).map((execution) => execution.displayName),
    ['Username Password Form', 'dcontact-browser Browser - Conditional 2FA', ORG_MFA_FLOW],
  );
});

test('หา subflow forms, 2FA เดิม และ Org 2FA ได้จากโครงของ flow ที่ copy มา', () => {
  const { forms, twoFactor, orgMfa } = locateBrowserSubflows(configuredFlow);
  assert.equal(forms.displayName, 'dcontact-browser forms');
  assert.equal(twoFactor.displayName, 'dcontact-browser Browser - Conditional 2FA');
  assert.equal(orgMfa.displayName, ORG_MFA_FLOW);
  // ก่อน setup เพิ่ม Org 2FA: ยังหา forms/2FA ได้
  const copied = configuredFlow.filter((_, index) => index < 11);
  assert.equal(locateBrowserSubflows(copied).orgMfa, undefined);
  assert.equal(locateBrowserSubflows(copied).twoFactor.displayName, twoFactor.displayName);
});

test('ตรวจ flow: ต้องผูกกับ realm, Org 2FA ครบ และ 2FA เดิมมี condition แบบ negate', () => {
  const realm = { browserFlow: TENANT_BROWSER_FLOW };
  assert.deepEqual(browserFlowFailures(realm, configuredFlow), []);
  assert.equal(browserFlowFailures({ browserFlow: 'browser' }, configuredFlow).length, 1);

  const optionalOtp = configuredFlow.map((execution, index) =>
    index === 14 ? { ...execution, requirement: 'ALTERNATIVE' } : execution,
  );
  assert.deepEqual(browserFlowFailures(realm, optionalOtp), [
    `${ORG_MFA_FLOW} ต้องมี auth-otp-form แบบ REQUIRED`,
  ]);
  const withoutNegate = configuredFlow.map((execution, index) =>
    index === 11 ? { ...execution, authenticationConfig: undefined } : execution,
  );
  assert.deepEqual(browserFlowFailures(realm, withoutNegate), [
    'subflow 2FA เดิมต้องมี dc-org-mfa-required แบบ negate',
  ]);
  assert.equal(browserFlowFailures(realm, configuredFlow.slice(0, 12)).length, 1);
});
