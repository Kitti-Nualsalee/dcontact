/** A1.9 (#574): สร้าง platform-only UAT operator ครั้งแรก; password รับจาก stdin เท่านั้น */
const base = process.env.KEYCLOAK_ADMIN_URL;
const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME;
const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD;
const username = process.env.PLATFORM_UAT_OPERATOR_USERNAME;
const email = process.env.PLATFORM_UAT_OPERATOR_EMAIL;
if (!base || !adminUsername || !adminPassword || !username || !email) {
  throw new Error('operator provisioning configuration ไม่ครบ');
}
if (!/^[a-z0-9._-]{3,64}$/.test(username) || !/^[^\s@]+@[^\s@]+$/.test(email)) {
  throw new Error('username/email ไม่ตรงรูปแบบ');
}
const parts = [];
for await (const part of process.stdin) parts.push(part);
const password = Buffer.concat(parts)
  .toString('utf8')
  .replace(/\r?\n$/, '');
if (password.length < 12 || password.includes('\n'))
  throw new Error('temporary password ไม่ตรงรูปแบบ');

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
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]} ล้มเหลว (${response.status})`);
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
if (users.length) throw new Error('username มีอยู่แล้ว; หยุดก่อนแก้ role ของบัญชีเดิม');
const [client] = await call(`${realm}/clients?clientId=dcontact-platform-api`, { token });
if (!client) throw new Error('ยังไม่มี dcontact-platform-api client');
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
if (!created?.id) throw new Error('สร้าง user แล้วแต่หา ID ไม่พบ; หยุดเพื่อตรวจ');
await call(`${realm}/users/${created.id}/role-mappings/clients/${client.id}`, {
  method: 'POST',
  token,
  body: [role],
});
process.stdout.write(
  `${JSON.stringify({ type: 'platform.uat.operator', status: 'PASS', subject: created.id, username })}\n`,
);
