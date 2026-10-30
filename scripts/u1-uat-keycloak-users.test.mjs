import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  PLATFORM_API_CLIENT,
  UAT_REALM_TEMPLATE,
  applyAccounts,
  applyRealmConfig,
  createKeycloakAdmin,
  realmConfigDigest,
  reconcileConsoleRedirects,
  renderRealm,
  validateAccounts,
} from './u1-uat-keycloak-users.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const template = JSON.parse(readFileSync(resolve(repositoryRoot, UAT_REALM_TEMPLATE), 'utf8'));
test('UAT realm มี VERIFY_EMAIL provider ที่เปิดใช้งานสำหรับ onboarding แต่ไม่บังคับทุกบัญชี', () => {
  const rendered = renderRealm(template, environment);
  const actions = rendered.requiredActions.filter((entry) => entry.alias === 'VERIFY_EMAIL');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].providerId, 'VERIFY_EMAIL');
  assert.equal(actions[0].enabled, true);
  assert.equal(actions[0].defaultAction, false);
});
const tenantId = '00000000-0000-4000-8000-000000000001';
const environment = {
  UAT_HOST: 'uat.example.test',
  UAT_TENANT_ID: tenantId,
  UAT_TENANT_SLUG: 'uat-tenant',
  UAT_TENANT_NAME: 'UAT Tenant',
  UAT_ORGANIZATION_DOMAIN: 'uat.example.test',
};
const password = ['Uat', 'Temp', 'Pass', '2026'].join('-');
const accounts = {
  accounts: [
    {
      role: 'maker',
      username: 'maker.one@uat.example.test',
      email: 'maker.one@uat.example.test',
      firstName: 'Maker',
      lastName: 'One',
      dcUserId: '00000000-0000-4000-8000-00000000000a',
      temporaryPassword: password,
    },
    {
      role: 'reviewer',
      username: 'reviewer.one@uat.example.test',
      email: 'reviewer.one@uat.example.test',
      firstName: 'Reviewer',
      lastName: 'One',
      dcUserId: '00000000-0000-4000-8000-00000000000b',
      temporaryPassword: password,
    },
  ],
};

test('render realm: แทน ${env.*} ครบ, redirect ตรง host/tenant และ digest คงที่', () => {
  const rendered = renderRealm(template, environment);
  const text = JSON.stringify(rendered);
  assert.ok(!text.includes('${env.'));
  const client = rendered.clients.find((entry) => entry.clientId === 'dcontact-uat-console');
  assert.deepEqual(client.redirectUris, ['https://uat.example.test/?tenant=uat-tenant']);
  assert.deepEqual(client.webOrigins, ['https://uat.example.test']);
  assert.deepEqual(rendered.organizations[0].attributes.tenant_id, [tenantId]);
  assert.equal(realmConfigDigest(rendered), realmConfigDigest(renderRealm(template, environment)));
  assert.notEqual(
    realmConfigDigest(rendered),
    realmConfigDigest(renderRealm(template, { ...environment, UAT_HOST: 'other.example.test' })),
  );
});

test('additional tenants: exact Console login/logout, deterministic และ Workspace ไม่ขยาย', () => {
  const options = {
    ...environment,
    UAT_ADDITIONAL_TENANT_SLUGS: 'tenant-z,tenant-a,tenant-z,uat-tenant',
    UAT_WORKSPACE_HOST: 'workspace.example.test',
  };
  const rendered = renderRealm(template, options);
  const consoleClient = rendered.clients.find(
    (client) => client.clientId === 'dcontact-uat-console',
  );
  const expected = ['tenant-a', 'tenant-z', 'uat-tenant'].map(
    (slug) => `https://uat.example.test/?tenant=${slug}`,
  );
  assert.deepEqual(consoleClient.redirectUris, expected);
  assert.equal(consoleClient.attributes['post.logout.redirect.uris'], expected.join('##'));
  assert.deepEqual(consoleClient.webOrigins, ['https://uat.example.test']);
  assert.deepEqual(
    rendered.clients.find((client) => client.clientId === 'dcontact-uat-workspace').redirectUris,
    ['https://workspace.example.test/?tenant=uat-tenant'],
  );
  assert.equal(
    realmConfigDigest(rendered),
    realmConfigDigest(
      renderRealm(template, { ...options, UAT_ADDITIONAL_TENANT_SLUGS: 'tenant-a,tenant-z' }),
    ),
  );
});

test('additional tenants: ค่าผิดรูปและ redirect injection ถูกปฏิเสธก่อน apply', () => {
  for (const value of [
    'ok,,two',
    'BAD',
    'ok&next=https://evil.test',
    '../evil',
    'foo--bar',
    'foo-',
    '-foo',
    'x'.repeat(64),
    Array(51).fill('ok').join(','),
  ]) {
    assert.throws(
      () => renderRealm(template, { ...environment, UAT_ADDITIONAL_TENANT_SLUGS: value }),
      /REALM_ENV_INVALID: UAT_ADDITIONAL_TENANT_SLUGS/,
    );
  }
});

test('Console redirect reconciliation: check, compare-before-apply, idempotency และ rollback', async () => {
  const initial = renderRealm(template, environment);
  const desired = renderRealm(template, {
    ...environment,
    UAT_ADDITIONAL_TENANT_SLUGS: 'tenant-a,tenant-b',
  });
  let client = {
    ...structuredClone(initial.clients.find((entry) => entry.clientId === 'dcontact-uat-console')),
    id: 'client-id',
    extra: 'preserve',
  };
  const calls = [];
  const admin = {
    async call(path, options = {}) {
      calls.push({ path, method: options.method ?? 'GET' });
      if (path.includes('?clientId=')) return [{ id: client.id }];
      if (options.method === 'PUT') client = structuredClone(options.body);
      return structuredClone(client);
    },
  };
  const check = await reconcileConsoleRedirects(admin, desired);
  assert.equal(check.changed, true);
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 0);
  await assert.rejects(
    reconcileConsoleRedirects(admin, desired, {
      apply: true,
      expectedDigest: 'sha256:' + '0'.repeat(64),
    }),
    /CONSOLE_REDIRECT_STATE_CHANGED/,
  );
  await reconcileConsoleRedirects(admin, desired, {
    apply: true,
    expectedDigest: check.beforeDigest,
  });
  assert.equal(client.extra, 'preserve');
  assert.equal(client.redirectUris.length, 3);
  const same = await reconcileConsoleRedirects(admin, desired, {
    apply: true,
    expectedDigest: check.targetDigest,
  });
  assert.equal(same.changed, false);
  const reverse = await reconcileConsoleRedirects(admin, initial);
  await reconcileConsoleRedirects(admin, initial, {
    apply: true,
    expectedDigest: reverse.beforeDigest,
  });
  assert.deepEqual(client.redirectUris, ['https://uat.example.test/?tenant=uat-tenant']);
  assert.equal(client.attributes['post.logout.redirect.uris'], client.redirectUris[0]);
  assert.equal(calls.filter((call) => call.method === 'PUT').length, 2);
});

test('render realm: env ขาดหรือผิดรูป = fail closed', () => {
  assert.throws(
    () => renderRealm(template, { ...environment, UAT_HOST: '' }),
    /REALM_ENV_MISSING: UAT_HOST/,
  );
  assert.throws(
    () => renderRealm(template, { ...environment, UAT_HOST: 'localhost' }),
    /REALM_ENV_INVALID/,
  );
  assert.throws(
    () => renderRealm(template, { ...environment, UAT_TENANT_ID: 'demo' }),
    /UAT_TENANT_ID/,
  );
});

test('บัญชี: maker/reviewer คนละบัญชี, ไม่ใช้บัญชี/รหัสผ่านของ dev', () => {
  assert.equal(validateAccounts(accounts).length, 2);
  const mutate = (index, change) => {
    const copy = structuredClone(accounts);
    Object.assign(copy.accounts[index], change);
    return () => validateAccounts(copy);
  };
  assert.throws(
    mutate(1, { dcUserId: accounts.accounts[0].dcUserId }),
    /ACCOUNTS_INVALID: dcUserId/,
  );
  assert.throws(mutate(1, { role: 'maker' }), /maker และ reviewer/);
  assert.throws(mutate(0, { username: 'admin@demo.local' }), /SHARED_CREDENTIAL_WITH_DEV/);
  assert.throws(mutate(0, { temporaryPassword: 'admin1234' }), /SHARED_CREDENTIAL_WITH_DEV/);
  assert.throws(mutate(0, { temporaryPassword: 'short' }), /ACCOUNTS_INVALID/);
  assert.throws(mutate(0, { role: 'admin' }), /ACCOUNTS_INVALID/);
  assert.throws(() => validateAccounts({}), /ACCOUNTS_INVALID/);
});

/** Keycloak admin REST ปลอม — เก็บ state ขั้นต่ำและบันทึก call (ไม่มี network) */
function fakeKeycloak({ realmExists = false, existingUsers = [], roleMappings = {} } = {}) {
  const calls = [];
  const state = {
    realm: realmExists ? { realm: 'dcontact' } : null,
    clients: [],
    organizations: realmExists
      ? [{ id: 'org-1', alias: 'uat-tenant', attributes: { tenant_id: [tenantId] } }]
      : [],
    users: [...existingUsers],
    members: [],
  };
  const respond = (status, body) =>
    new Response(body === undefined ? null : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = async (url, init) => {
    const { pathname, searchParams } = new URL(url);
    const method = init.method ?? 'GET';
    const body =
      init.body && typeof init.body === 'string' && init.body.startsWith('{')
        ? JSON.parse(init.body)
        : init.body;
    calls.push({ method, pathname, body });
    const base = '/auth/admin/realms/dcontact';
    if (pathname === '/auth/realms/master/protocol/openid-connect/token')
      return respond(200, { access_token: 'admin-token' });
    if (pathname === '/auth/admin/realms' && method === 'POST') {
      state.realm = body;
      state.organizations = body.organizations.map((organization, index) => ({
        id: `org-${index + 1}`,
        ...organization,
      }));
      return respond(201);
    }
    if (pathname === base && method === 'GET')
      return state.realm ? respond(200, state.realm) : respond(404);
    if (pathname === base && method === 'PUT') return respond(204);
    if (pathname === `${base}/authentication/flows`) {
      return respond(
        200,
        template.authenticationFlows.map((flow) => ({ alias: flow.alias })),
      );
    }
    if (pathname.startsWith(`${base}/authentication/required-actions/`)) {
      return method === 'GET' ? respond(200, { alias: pathname.split('/').pop() }) : respond(204);
    }
    if (pathname === `${base}/client-scopes`) {
      return respond(200, [
        ...['web-origins', 'acr', 'basic', 'roles', 'profile', 'email'].map((name) => ({
          id: name,
          name,
        })),
        {
          id: 'organization',
          name: 'organization',
          protocol: 'openid-connect',
          protocolMappers: [
            { id: 'm1', protocolMapper: 'oidc-organization-membership-mapper', config: {} },
          ],
        },
      ]);
    }
    if (pathname === `${base}/clients` && method === 'GET') {
      return respond(
        200,
        state.clients.filter((client) => client.clientId === searchParams.get('clientId')),
      );
    }
    if (pathname === `${base}/clients` && method === 'POST') {
      state.clients.push({ id: `client-${state.clients.length + 1}`, ...body });
      return respond(201);
    }
    if (/\/clients\/[^/]+\/protocol-mappers\/models$/.test(pathname) && method === 'GET')
      return respond(200, []);
    if (pathname === `${base}/users/profile`) {
      return method === 'GET' ? respond(200, { attributes: [{ name: 'username' }] }) : respond(200);
    }
    if (pathname === `${base}/organizations` && method === 'GET')
      return respond(200, state.organizations);
    const organization = /\/organizations\/([^/]+)$/.exec(pathname);
    if (organization && method === 'GET') {
      return respond(
        200,
        state.organizations.find((entry) => entry.id === organization[1]),
      );
    }
    if (pathname === `${base}/users` && method === 'GET') {
      return respond(
        200,
        state.users.filter((user) => user.username === searchParams.get('username')),
      );
    }
    if (pathname === `${base}/users` && method === 'POST') {
      state.users.push({ id: `user-${state.users.length + 1}`, ...body });
      return respond(201);
    }
    const mappings = /\/users\/([^/]+)\/role-mappings$/.exec(pathname);
    if (mappings && method === 'GET') return respond(200, roleMappings[mappings[1]] ?? {});
    if (/\/organizations\/[^/]+\/members$/.test(pathname)) {
      if (method === 'GET')
        return respond(
          200,
          state.members.map((id) => ({ id })),
        );
      state.members.push(body);
      return respond(201);
    }
    return respond(204);
  };
  return { calls, state, fetchImpl };
}

async function admin(fake) {
  const client = createKeycloakAdmin({
    baseUrl: 'http://keycloak:8080/auth',
    username: 'uat-admin',
    password: 'not-a-dev-password',
    fetchImpl: fake.fetchImpl,
  });
  await client.login();
  return client;
}

test('config: realm ใหม่ถูกสร้างจาก template ที่ render แล้ว + Organization mapper มี attribute', async () => {
  const fake = fakeKeycloak();
  const rendered = renderRealm(template, environment);
  const result = await applyRealmConfig(await admin(fake), rendered);
  assert.equal(result.created, true);
  assert.equal(result.realmConfigDigest, realmConfigDigest(rendered));
  assert.equal(fake.state.realm.browserFlow, template.browserFlow);
  assert.ok(fake.state.clients.some((client) => client.clientId === 'dcontact-uat-console'));
  const mapper = fake.calls.find((call) => call.pathname.endsWith('/protocol-mappers/models/m1'));
  assert.equal(mapper.body.config.addOrganizationAttributes, 'true');
  const profile = fake.calls.find(
    (call) => call.pathname.endsWith('/users/profile') && call.method === 'PUT',
  );
  assert.deepEqual(
    profile.body.attributes.map((attribute) => attribute.name),
    ['username', 'tenant_id', 'tenant_slug', 'dc_user_id'],
  );
});

test('config (#645): realm เดิมกลับไปใช้ browser flow/session ของ template และ Organization ไม่เสีย attribute เดิม', async () => {
  const fake = fakeKeycloak({ realmExists: true });
  fake.state.realm.browserFlow = 'dcontact-browser';
  fake.state.organizations[0].attributes.dc_mfa_required = ['true'];
  const rendered = renderRealm(template, environment);
  const result = await applyRealmConfig(await admin(fake), rendered);
  assert.equal(result.created, false);

  const realmUpdate = fake.calls.find(
    (call) => call.pathname === '/auth/admin/realms/dcontact' && call.method === 'PUT',
  );
  assert.equal(realmUpdate.body.browserFlow, template.browserFlow);
  assert.equal(realmUpdate.body.ssoSessionIdleTimeout, template.ssoSessionIdleTimeout);
  assert.equal(realmUpdate.body.ssoSessionMaxLifespan, template.ssoSessionMaxLifespan);

  const organizationUpdate = fake.calls.find(
    (call) => call.pathname.endsWith('/organizations/org-1') && call.method === 'PUT',
  );
  assert.deepEqual(organizationUpdate.body.attributes, {
    tenant_id: [tenantId],
    tenant_slug: ['uat-tenant'],
    dc_mfa_required: ['true'],
  });
});

test('users: บัญชีใหม่ได้รหัสผ่าน temporary + ต้องตั้ง TOTP และเป็นสมาชิก Organization', async () => {
  const fake = fakeKeycloak({ realmExists: true });
  const results = await applyAccounts(await admin(fake), {
    realm: 'dcontact',
    tenantId,
    tenantSlug: 'uat-tenant',
    accounts: validateAccounts(accounts),
  });
  assert.deepEqual(
    results.map((entry) => [entry.role, entry.status]),
    [
      ['maker', 'CREATED'],
      ['reviewer', 'CREATED'],
    ],
  );
  for (const user of fake.state.users) {
    assert.deepEqual(user.requiredActions, ['UPDATE_PASSWORD', 'CONFIGURE_TOTP']);
    assert.deepEqual(user.attributes.tenant_id, [tenantId]);
  }
  const resets = fake.calls.filter((call) => call.pathname.endsWith('/reset-password'));
  assert.equal(resets.length, 2);
  assert.ok(resets.every((call) => call.body.temporary === true));
  assert.deepEqual(fake.state.members, ['user-1', 'user-2']);
  assert.ok(!JSON.stringify(results).includes(password));
});

test('users: บัญชีเดิมที่ผูก dc_user_id อื่นไว้ = หยุด ไม่ย้ายเงียบ ๆ', async () => {
  const fake = fakeKeycloak({
    realmExists: true,
    existingUsers: [
      {
        id: 'user-x',
        username: 'maker.one@uat.example.test',
        attributes: { dc_user_id: ['00000000-0000-4000-8000-0000000000ff'] },
      },
    ],
  });
  await assert.rejects(
    applyAccounts(await admin(fake), {
      realm: 'dcontact',
      tenantId,
      tenantSlug: 'uat-tenant',
      accounts: validateAccounts(accounts),
    }),
    /ACCOUNT_SUBJECT_MISMATCH/,
  );
});

test('Workspace client opt-in แยก origin ใช้ exact redirect/PKCE และคง Console เดิม', () => {
  assert.equal(
    renderRealm(template, environment).clients.some((c) => c.clientId === 'dcontact-uat-workspace'),
    false,
  );
  const rendered = renderRealm(template, {
    ...environment,
    UAT_WORKSPACE_HOST: 'workspace-uat.example.test',
  });
  const client = rendered.clients.find((c) => c.clientId === 'dcontact-uat-workspace');
  assert.deepEqual(client.redirectUris, ['https://workspace-uat.example.test/?tenant=uat-tenant']);
  assert.deepEqual(client.webOrigins, ['https://workspace-uat.example.test']);
  assert.equal(client.attributes['post.logout.redirect.uris'], client.redirectUris[0]);
  assert.equal(client.attributes['pkce.code.challenge.method'], 'S256');
  assert.equal(client.directAccessGrantsEnabled, false);
  assert.equal(client.publicClient, true);
  assert.deepEqual(
    rendered.clients.find((c) => c.clientId === 'dcontact-uat-console'),
    renderRealm(template, environment).clients.find((c) => c.clientId === 'dcontact-uat-console'),
  );
  for (const host of [
    environment.UAT_HOST,
    'https://workspace.example',
    '*.example.test',
    'localhost',
    'host/path',
  ]) {
    assert.throws(
      () => renderRealm(template, { ...environment, UAT_WORKSPACE_HOST: host }),
      /REALM_ENV_INVALID/,
    );
  }
});

test('users (#685): บัญชีเดิมที่มี platform role = หยุด ไม่เติม tenant attribute/Organization', async () => {
  const fake = fakeKeycloak({
    realmExists: true,
    existingUsers: [{ id: 'platform-1', username: 'maker.one@uat.example.test', attributes: {} }],
    roleMappings: {
      'platform-1': {
        clientMappings: {
          [PLATFORM_API_CLIENT]: {
            client: PLATFORM_API_CLIENT,
            mappings: [{ name: 'platform_operator' }],
          },
        },
      },
    },
  });
  await assert.rejects(
    applyAccounts(await admin(fake), {
      realm: 'dcontact',
      tenantId,
      tenantSlug: 'uat-tenant',
      accounts: validateAccounts(accounts),
    }),
    /PLATFORM_IDENTITY_REFUSED/,
  );
  assert.equal(
    fake.calls.some(
      (call) =>
        (call.method === 'PUT' && call.pathname.endsWith('/users/platform-1')) ||
        (call.method === 'POST' && call.pathname.endsWith('/members')),
    ),
    false,
  );
});
