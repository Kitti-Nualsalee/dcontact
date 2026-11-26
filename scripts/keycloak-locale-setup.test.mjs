import assert from 'node:assert/strict';
import test from 'node:test';
import { withZoneinfoAttribute, ZONEINFO_ATTRIBUTE } from './keycloak-locale-setup.mjs';

test('adds zoneinfo at the end while keeping every existing attribute and group', () => {
  const profile = {
    attributes: [{ name: 'username' }, { name: 'email' }],
    groups: [{ name: 'user-metadata' }],
  };
  const next = withZoneinfoAttribute(profile);
  assert.deepEqual(next.attributes, [{ name: 'username' }, { name: 'email' }, ZONEINFO_ATTRIBUTE]);
  assert.deepEqual(next.groups, profile.groups);
});

test('idempotent: when zoneinfo already exists, returns the original object (no repeated PUT)', () => {
  const profile = { attributes: [{ name: 'zoneinfo', permissions: { edit: ['admin', 'user'] } }] };
  assert.equal(withZoneinfoAttribute(profile), profile);
});

test('the user can see the timezone but only an admin can edit it', () => {
  assert.deepEqual(ZONEINFO_ATTRIBUTE.permissions, { view: ['admin'], edit: ['admin'] });
});

test('the dev users in the script match the realm JSON and everyone has default-roles-dcontact (the Account API needs it)', async () => {
  const { readFileSync } = await import('node:fs');
  const { LOCALE_DEV_USERS, REALM_DEFAULT_ROLE } = await import('./keycloak-locale-setup.mjs');
  const realm = JSON.parse(
    readFileSync(new URL('../infra/keycloak/realm-dcontact.dev.json', import.meta.url), 'utf8'),
  );
  assert.deepEqual(realm.users.map((user) => user.username).sort(), [...LOCALE_DEV_USERS].sort());
  for (const user of realm.users)
    assert.ok(user.realmRoles.includes(REALM_DEFAULT_ROLE), user.username);
  assert.equal(realm.internationalizationEnabled, true);
  assert.deepEqual(realm.supportedLocales, ['th', 'en']);
  assert.equal(realm.defaultLocale, 'th');
});
