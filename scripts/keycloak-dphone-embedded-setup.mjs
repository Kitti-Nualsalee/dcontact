import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * E1.13 (#487): Keycloak public client `dphone-embedded` สำหรับ dphone ที่ถูกฝังในระบบอื่น (E1.4 #460)
 *
 * - redirect เป็น exact `<dphone-origin>/dphone/auth/callback` (dphone origin = origin ของ API ที่ส่ง
 *   `/dphone/embed`), PKCE S256, ปิด implicit/direct grant/service account
 * - token contract เดียวกับ client ต้นแบบ (ค่าเริ่มต้น `agent-desktop`) — copy mapper และ client scope
 *   จาก client นั้นทุกครั้งที่รัน จึงไม่ drift; UAT ระบุ `dcontact-uat-console` อย่างชัดเจน
 * - access token 5 นาที, client session idle 30 นาที / สูงสุด 10 ชั่วโมง
 * - refresh token ใช้ได้ครั้งเดียว + ตรวจ reuse: Keycloak 26 ตั้งได้เฉพาะระดับ realm — เจ้าของงานเลือก
 *   เปิดทั้ง realm (#487, 2026-09-28) ใช้ `revokeRefreshToken=true`, `refreshTokenMaxReuse=0`
 *
 * idempotent — รันซ้ำได้; `DPHONE_EMBED_ORIGIN` ตั้ง origin จริงของ production
 */
export const DPHONE_EMBEDDED_CLIENT = 'dphone-embedded';
export const DPHONE_EMBEDDED_LIFESPANS = Object.freeze({
  accessTokenSeconds: 300,
  sessionIdleSeconds: 1800,
  sessionMaxSeconds: 36000,
});

const realm = process.env.KEYCLOAK_REALM ?? 'dcontact';
const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername =
  process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? process.env.KEYCLOAK_ADMIN_USERNAME ?? 'admin';
const adminPassword =
  process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';
export const dphoneTemplateClientId = process.env.DPHONE_EMBED_TEMPLATE_CLIENT ?? 'agent-desktop';
export const dphoneOrigin = (process.env.DPHONE_EMBED_ORIGIN ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const realmPath = `/admin/realms/${realm}`;

async function request(path, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(`${keycloakBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? form : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]} ล้มเหลว (${response.status})`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function adminToken() {
  const body = await request('/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    form: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUsername,
      password: adminPassword,
    }),
  });
  return body.access_token;
}

/** representation ของ client — แยกเป็นฟังก์ชันเพื่อทดสอบได้โดยไม่ต้องมี Keycloak */
export function dphoneEmbeddedClient(template, origin = dphoneOrigin) {
  return {
    clientId: DPHONE_EMBEDDED_CLIENT,
    name: 'dphone (embedded)',
    protocol: 'openid-connect',
    publicClient: true,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    frontchannelLogout: false,
    redirectUris: [`${origin}/dphone/auth/callback`],
    webOrigins: [origin],
    fullScopeAllowed: template.fullScopeAllowed ?? true,
    attributes: {
      'pkce.code.challenge.method': 'S256',
      'access.token.lifespan': String(DPHONE_EMBEDDED_LIFESPANS.accessTokenSeconds),
      'client.session.idle.timeout': String(DPHONE_EMBEDDED_LIFESPANS.sessionIdleSeconds),
      'client.session.max.lifespan': String(DPHONE_EMBEDDED_LIFESPANS.sessionMaxSeconds),
      'post.logout.redirect.uris': '',
      'oauth2.device.authorization.grant.enabled': 'false',
      'oidc.ciba.grant.enabled': 'false',
    },
    protocolMappers: (template.protocolMappers ?? []).map(({ id: _id, ...mapper }) => mapper),
  };
}

export async function setupDphoneEmbedded() {
  const token = await adminToken();
  const clients = await request(`${realmPath}/clients`, { token });
  const template = clients.find((client) => client.clientId === dphoneTemplateClientId);
  if (!template) {
    throw new Error(`ไม่พบ client ${dphoneTemplateClientId} ที่ใช้เป็นต้นแบบ token contract`);
  }
  const representation = dphoneEmbeddedClient(template);

  let client = clients.find((candidate) => candidate.clientId === DPHONE_EMBEDDED_CLIENT);
  if (client) {
    await request(`${realmPath}/clients/${client.id}`, {
      method: 'PUT',
      token,
      body: { ...client, ...representation, protocolMappers: undefined },
    });
    // mapper: ลบของเดิมแล้วสร้างใหม่จากต้นแบบ — กัน drift จาก template client
    for (const mapper of client.protocolMappers ?? []) {
      await request(`${realmPath}/clients/${client.id}/protocol-mappers/models/${mapper.id}`, {
        method: 'DELETE',
        token,
      });
    }
    for (const mapper of representation.protocolMappers) {
      await request(`${realmPath}/clients/${client.id}/protocol-mappers/models`, {
        method: 'POST',
        token,
        body: mapper,
      });
    }
  } else {
    await request(`${realmPath}/clients`, { method: 'POST', token, body: representation });
    [client] = await request(`${realmPath}/clients?clientId=${DPHONE_EMBEDDED_CLIENT}`, { token });
  }

  // client scope ชุดเดียวกับ template client (default + optional)
  for (const kind of ['default-client-scopes', 'optional-client-scopes']) {
    const wanted = await request(`${realmPath}/clients/${template.id}/${kind}`, { token });
    const current = await request(`${realmPath}/clients/${client.id}/${kind}`, { token });
    for (const scope of current.filter((scope) => !wanted.some((w) => w.id === scope.id))) {
      await request(`${realmPath}/clients/${client.id}/${kind}/${scope.id}`, {
        method: 'DELETE',
        token,
      });
    }
    for (const scope of wanted.filter((scope) => !current.some((c) => c.id === scope.id))) {
      await request(`${realmPath}/clients/${client.id}/${kind}/${scope.id}`, {
        method: 'PUT',
        token,
      });
    }
  }

  // rotation + reuse detection ระดับ realm (decision #487)
  const realmRepresentation = await request(realmPath, { token });
  await request(realmPath, {
    method: 'PUT',
    token,
    body: { ...realmRepresentation, revokeRefreshToken: true, refreshTokenMaxReuse: 0 },
  });
  return { client: DPHONE_EMBEDDED_CLIENT, redirectUri: representation.redirectUris[0] };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = await setupDphoneEmbedded();
    console.log(
      JSON.stringify({ type: 'keycloak.dphone_embedded.setup', status: 'PASS', ...result }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: 'keycloak.dphone_embedded.setup',
        status: 'FAIL',
        error: String(error.message),
      }),
    );
    process.exitCode = 1;
  }
}
