import assert from 'node:assert/strict';
import test from 'node:test';
import { withZoneinfoAttribute, ZONEINFO_ATTRIBUTE } from './keycloak-locale-setup.mjs';

test('เพิ่ม zoneinfo ต่อท้ายโดยคง attribute และ group เดิมไว้ครบ', () => {
  const profile = {
    attributes: [{ name: 'username' }, { name: 'email' }],
    groups: [{ name: 'user-metadata' }],
  };
  const next = withZoneinfoAttribute(profile);
  assert.deepEqual(next.attributes, [{ name: 'username' }, { name: 'email' }, ZONEINFO_ATTRIBUTE]);
  assert.deepEqual(next.groups, profile.groups);
});

test('idempotent: มี zoneinfo อยู่แล้วคืน object เดิม (ไม่ PUT ซ้ำ)', () => {
  const profile = { attributes: [{ name: 'zoneinfo', permissions: { edit: ['admin', 'user'] } }] };
  assert.equal(withZoneinfoAttribute(profile), profile);
});

test('ผู้ใช้เห็น timezone ได้ แต่แก้ได้เฉพาะ admin', () => {
  assert.deepEqual(ZONEINFO_ATTRIBUTE.permissions, { view: ['admin', 'user'], edit: ['admin'] });
});

test('ผู้ใช้ dev ในสคริปต์ตรงกับ realm JSON และทุกคนมี default-roles-dcontact (Account API ต้องใช้)', async () => {
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
