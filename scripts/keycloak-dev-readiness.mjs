import { createPublicKey, verify } from 'node:crypto';
import { compose } from './dev-infra-compose.mjs';

const issuer = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8081/realms/dcontact';
const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const fallbackOnly = process.argv.includes('--fallback-only');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function base64UrlJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function databaseIdentity(email) {
  const safeEmail = email.replaceAll("'", "''");
  const result = compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact',
    '-At',
    '-F',
    '|',
    '-c',
    `SELECT u.id, u.tenant_id, u.keycloak_id FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = 'demo' AND u.email = '${safeEmail}';`,
  );
  const [userId, tenantId, keycloakId] = result.split('|');
  assert(userId && tenantId && keycloakId, `Postgres identity ของ ${email} ยังเชื่อมไม่ครบ`);
  return { userId, tenantId, keycloakId };
}

async function main() {
  const discoveryResponse = await fetch(discoveryUrl);
  assert(discoveryResponse.ok, `OIDC discovery ตอบ ${discoveryResponse.status}`);
  const discovery = await discoveryResponse.json();
  assert(discovery.issuer === issuer, `issuer ไม่ตรง contract: ${discovery.issuer}`);

  const jwksResponse = await fetch(discovery.jwks_uri);
  assert(jwksResponse.ok, `JWKS ตอบ ${jwksResponse.status}`);
  const jwks = await jwksResponse.json();
  assert(Array.isArray(jwks.keys) && jwks.keys.length > 0, 'JWKS ไม่มี signing key');

  const issueAccessToken = async (scope) => {
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'dcontact-dev-readiness',
        username: 'agent1000@demo.local',
        password: 'agent1234',
        scope,
      }),
    });
    if (!response.ok) {
      throw new Error(
        `ออก dev access token ไม่สำเร็จ (${response.status}): ${await response.text()}`,
      );
    }
    return (await response.json()).access_token;
  };

  const accessToken = await issueAccessToken(fallbackOnly ? 'openid' : 'openid organization:demo');
  const [encodedHeader, encodedPayload, encodedSignature] = accessToken.split('.');
  const header = base64UrlJson(encodedHeader);
  const claims = base64UrlJson(encodedPayload);
  const signingJwk = jwks.keys.find((key) => key.kid === header.kid);
  assert(signingJwk, 'ไม่พบ signing key ของ token ใน JWKS');
  assert(
    verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key: signingJwk, format: 'jwk' }),
      Buffer.from(encodedSignature, 'base64url'),
    ),
    'ตรวจลายเซ็น access token ด้วย JWKS ไม่ผ่าน',
  );

  const database = databaseIdentity('agent1000@demo.local');
  assert(claims.iss === issuer, 'token issuer ไม่ตรง contract');
  assert(
    claims.aud === 'dcontact-api' || claims.aud?.includes('dcontact-api'),
    'token ไม่มี dcontact-api audience',
  );
  assert(claims.sub === database.keycloakId, 'token subject ไม่ตรง users.keycloak_id');
  assert(claims.tenant_id === database.tenantId, 'tenant_id ไม่ตรง Postgres tenant');
  assert(claims.tenant_slug === 'demo', 'tenant_slug ต้องเป็น demo');
  assert(claims.dc_user_id === database.userId, 'dc_user_id ไม่ตรง Postgres user');
  assert(claims.realm_access?.roles?.includes('agent'), 'token ไม่มี agent role');
  if (!fallbackOnly) {
    assert(
      claims.organization?.demo?.tenant_id?.[0] === database.tenantId,
      'native Organization mapper ไม่มี tenant_id ของ demo',
    );
    assert(
      claims.organization?.demo?.tenant_slug?.[0] === 'demo',
      'native Organization mapper ไม่มี tenant_slug',
    );
  }

  const fallbackClaims = base64UrlJson((await issueAccessToken('openid')).split('.')[1]);
  assert(!fallbackClaims.organization, 'fallback evidence ต้องไม่พึ่ง native Organization claim');
  assert(fallbackClaims.tenant_id === database.tenantId, 'fallback tenant_id ไม่ตรง contract');
  assert(fallbackClaims.tenant_slug === 'demo', 'fallback tenant_slug ไม่ตรง contract');
  assert(fallbackClaims.dc_user_id === database.userId, 'fallback dc_user_id ไม่ตรง contract');

  console.log('✓ OIDC discovery และ JWKS เข้าถึงได้');
  console.log('✓ Access token มีลายเซ็น audience และ claims ที่ตรงกับ Postgres');
  if (!fallbackOnly)
    console.log('✓ Keycloak 26 native Organization mapper ส่ง tenant attributes ได้');
  console.log('✓ flat fallback claims คง public claim shape โดยไม่พึ่ง native mapper');
}

main().catch((error) => {
  console.error(`✗ Keycloak dev identity ยังไม่พร้อม: ${error.message}`);
  process.exitCode = 1;
});
