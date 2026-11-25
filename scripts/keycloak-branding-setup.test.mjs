import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HIDDEN_USER_ATTRIBUTES,
  consoleUrl,
  withHiddenInternalAttributes,
} from './keycloak-branding-setup.mjs';

test('consoleUrl: CONSOLE_PUBLIC_URL first, then UAT_HOST; always ends with /; neither = undefined', () => {
  assert.equal(
    consoleUrl({ CONSOLE_PUBLIC_URL: 'http://localhost:5173' }),
    'http://localhost:5173/',
  );
  assert.equal(
    consoleUrl({ CONSOLE_PUBLIC_URL: 'https://app.example.test/x/' }),
    'https://app.example.test/x/',
  );
  assert.equal(consoleUrl({ UAT_HOST: 'uat.example.test' }), 'https://uat.example.test/');
  assert.equal(
    consoleUrl({ CONSOLE_PUBLIC_URL: 'https://a.example.test', UAT_HOST: 'b.example.test' }),
    'https://a.example.test/',
  );
  assert.equal(consoleUrl({}), undefined);
});

test('consoleUrl: rejects a URL that cannot be used as a redirect target', () => {
  for (const bad of [
    'not a url',
    'javascript:alert(1)',
    'ftp://x.example.test',
    'https://user:pw@x.example.test/',
    'https://x.example.test/?a=1',
    'https://x.example.test/#f',
  ]) {
    assert.throws(() => consoleUrl({ CONSOLE_PUBLIC_URL: bad }), undefined, bad);
  }
});

test('internal attributes are hidden from the user, and other attributes are not touched', () => {
  const profile = {
    attributes: [
      { name: 'email', permissions: { view: ['admin', 'user'], edit: ['admin', 'user'] } },
      ...HIDDEN_USER_ATTRIBUTES.map((name) => ({
        name,
        permissions: { view: ['admin', 'user'], edit: ['admin'] },
      })),
    ],
  };
  const hidden = withHiddenInternalAttributes(profile);
  assert.notEqual(hidden, profile);
  assert.deepEqual(hidden.attributes[0], profile.attributes[0]);
  for (const attribute of hidden.attributes.slice(1)) {
    assert.deepEqual(attribute.permissions, { view: ['admin'], edit: ['admin'] });
  }
  // a re-run = nothing changes (returns the original object, no PUT)
  assert.equal(withHiddenInternalAttributes(hidden), hidden);
});

test('attributes the user can edit are forced to admin only', () => {
  const profile = {
    attributes: [{ name: 'tenant_id', permissions: { view: ['admin'], edit: ['admin', 'user'] } }],
  };
  assert.deepEqual(withHiddenInternalAttributes(profile).attributes[0].permissions, {
    view: ['admin'],
    edit: ['admin'],
  });
});
