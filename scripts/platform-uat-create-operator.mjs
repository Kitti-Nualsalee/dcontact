/** A1.9 (#574): create the first platform-only UAT operator; the password is accepted from stdin only */
const base = process.env.KEYCLOAK_ADMIN_URL;
const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME;
const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD;
const username = process.env.PLATFORM_UAT_OPERATOR_USERNAME;
const email = process.env.PLATFORM_UAT_OPERATOR_EMAIL;
if (!base || !adminUsername || !adminPassword || !username || !email) {
  throw new Error('the operator provisioning configuration is incomplete');
}
if (!/^[a-z0-9._-]{3,64}$/.test(username) || !/^[^\s@]+@[^\s@]+$/.test(email)) {
  throw new Error('the username/email does not match the expected format');
}
const parts = [];
for await (const part of process.stdin) parts.push(part);
const password = Buffer.concat(parts)
  .toString('utf8')
  .replace(/\r?\n$/, '');
if (password.length < 12 || password.includes('\n'))
  throw new Error('the temporary password does not match the expected format');

async function call(path, { method = 'GET', token, body, form } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body: body === undefined ? form : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]} failed (${response.status})`);
  const content = await response.text();
  return content ? JSON.parse(content) : undefined;
}
const result = await call('/realms/master/protocol/openid-connect/token', {
  method: 'POST',
  form: new URLSearchParams({
    grant_type: 'password',
    client_id: 'admin-cli',
    username: adminUsername,
    password: adminPassword,
  }),
});
const token = result.access_token;
const realm = '/admin/realms/dcontact';
const users = await call(`${realm}/users?${new URLSearchParams({ username, exact: 'true' })}`, {
  token,
});
if (users.length)
  throw new Error(
    'the username already exists; stopping before editing the roles of the existing account',
  );
const [client] = await call(`${realm}/clients?clientId=dcontact-platform-api`, { token });
if (!client) throw new Error('the dcontact-platform-api client does not exist yet');
const role = await call(`${realm}/clients/${client.id}/roles/platform_operator`, { token });
await call(`${realm}/users`, {
  method: 'POST',
  token,
  body: {
    username,
    email,
    enabled: true,
    emailVerified: false,
    requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
    credentials: [{ type: 'password', value: password, temporary: true }],
  },
});
const [created] = await call(`${realm}/users?${new URLSearchParams({ username, exact: 'true' })}`, {
  token,
});
if (!created?.id)
  throw new Error('the user was created but the ID was not found; stopping to investigate');
await call(`${realm}/users/${created.id}/role-mappings/clients/${client.id}`, {
  method: 'POST',
  token,
  body: [role],
});
process.stdout.write(
  `${JSON.stringify({ type: 'platform.uat.operator', status: 'PASS', subject: created.id, username })}\n`,
);
