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
  PLATFORM_API_CLIENT,
  PLATFORM_ROLES,
  childrenOf,
  clientRepresentation,
  firstTenantUser,
  locateBrowserSubflows,
  permissionRepresentations,
  protectedUserIds,
} from './keycloak-account-service-setup.mjs';

test('a user who is in no Organization is protected, while a tenant member is not', () => {
  assert.deepEqual(
    protectedUserIds(
      ['tenant-a', 'platform-operator', 'tenant-b', 'service-account-x', 'tenant-a'],
      ['tenant-b', 'tenant-a', 'tenant-a'],
    ),
    ['platform-operator', 'service-account-x'],
  );
  assert.deepEqual(protectedUserIds([], []), []);
});

test('#685: a holder of a platform role is always protected, even if bound into a tenant Organization', () => {
  const protectedIds = protectedUserIds(
    ['tenant-a', 'platform-in-org', 'platform-only'],
    ['platform-in-org', 'tenant-a'],
    ['platform-in-org', 'platform-only'],
  );
  assert.deepEqual(protectedIds, ['platform-in-org', 'platform-only']);
  // --verify must pick a real tenant user, not a platform account that is in an Organization
  assert.equal(firstTenantUser(['platform-in-org', 'tenant-a'], protectedIds), 'tenant-a');
  assert.equal(firstTenantUser(['platform-in-org'], protectedIds), undefined);
});

test('#685: the platform client/roles match keycloak-platform-setup.mjs', async () => {
  const platform = await import('./keycloak-platform-setup.mjs');
  assert.equal(PLATFORM_API_CLIENT, platform.PLATFORM_API_CLIENT);
  assert.deepEqual([...PLATFORM_ROLES], [...platform.PLATFORM_ROLES]);
  const uat = await import('./u1-uat-keycloak-users.mjs');
  assert.equal(uat.PLATFORM_API_CLIENT, platform.PLATFORM_API_CLIENT);
});

test('the client has no browser/direct grant and uses the service account only', () => {
  const client = clientRepresentation('secret');
  assert.equal(client.serviceAccountsEnabled, true);
  assert.equal(client.publicClient, false);
  assert.equal(client.standardFlowEnabled, false);
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.implicitFlowEnabled, false);
});

test('the permissions granted are only view/manage/reset-password, and the deny covers every scope of a protected user', () => {
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

test('with no user to protect -> no deny is created (a deny with no resources would deny every user)', () => {
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

/** the executions of `dcontact-browser` after setup on Keycloak 26.7.5 (unused fields trimmed) */
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

test('childrenOf returns only the direct children of the subflow in depth-first order', () => {
  assert.deepEqual(
    childrenOf(configuredFlow, -1).map((execution) => execution.displayName),
    ['Cookie', 'dcontact-browser Organization', 'dcontact-browser forms'],
  );
  assert.deepEqual(
    childrenOf(configuredFlow, 5).map((execution) => execution.displayName),
    ['Username Password Form', 'dcontact-browser Browser - Conditional 2FA', ORG_MFA_FLOW],
  );
});

test('finds the forms subflow, the original 2FA and the Org 2FA from the structure of the copied flow', () => {
  const { forms, twoFactor, orgMfa } = locateBrowserSubflows(configuredFlow);
  assert.equal(forms.displayName, 'dcontact-browser forms');
  assert.equal(twoFactor.displayName, 'dcontact-browser Browser - Conditional 2FA');
  assert.equal(orgMfa.displayName, ORG_MFA_FLOW);
  // before setup adds Org 2FA: the forms/2FA can still be found
  const copied = configuredFlow.filter((_, index) => index < 11);
  assert.equal(locateBrowserSubflows(copied).orgMfa, undefined);
  assert.equal(locateBrowserSubflows(copied).twoFactor.displayName, twoFactor.displayName);
});

test('flow check: must be bound to the realm, Org 2FA complete, and the original 2FA has a negate condition', () => {
  const realm = { browserFlow: TENANT_BROWSER_FLOW };
  assert.deepEqual(browserFlowFailures(realm, configuredFlow), []);
  assert.equal(browserFlowFailures({ browserFlow: 'browser' }, configuredFlow).length, 1);

  const optionalOtp = configuredFlow.map((execution, index) =>
    index === 14 ? { ...execution, requirement: 'ALTERNATIVE' } : execution,
  );
  assert.deepEqual(browserFlowFailures(realm, optionalOtp), [
    `${ORG_MFA_FLOW} must have auth-otp-form as REQUIRED`,
  ]);
  const withoutNegate = configuredFlow.map((execution, index) =>
    index === 11 ? { ...execution, authenticationConfig: undefined } : execution,
  );
  assert.deepEqual(browserFlowFailures(realm, withoutNegate), [
    'the original 2FA subflow must have dc-org-mfa-required as negate',
  ]);
  assert.equal(browserFlowFailures(realm, configuredFlow.slice(0, 12)).length, 1);
});

test('--keep-realm-browser-flow (#645): does not check binding to the realm but still checks the whole flow structure', () => {
  const uatRealm = { browserFlow: 'uat browser password otp' };
  assert.deepEqual(browserFlowFailures(uatRealm, configuredFlow, { bindRealm: false }), []);
  assert.equal(
    browserFlowFailures(uatRealm, configuredFlow.slice(0, 12), { bindRealm: false }).length,
    1,
  );
});
