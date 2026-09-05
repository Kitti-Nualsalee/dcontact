import { createPublicKey, verify } from 'node:crypto';
import { compose } from './dev-infra-compose.mjs';
import { PHASE_ONE_TENANT_IDENTITIES } from './phase-one-tenants.mjs';

const issuer = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8081/realms/dcontact';
const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const fallbackOnly = process.argv.includes('--fallback-only');
const autoFallback = process.argv.includes('--auto-fallback');

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
    `SELECT u.id, u.tenant_id, u.keycloak_id FROM users u WHERE u.email = '${safeEmail}';`,
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

  const issueAccessToken = async (identity, scope) => {
    const response = await fetch(discovery.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'dcontact-dev-readiness',
        username: identity.agentEmail,
        password: identity.agentPassword,
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

  const verifiedTenantIds = [];
  let verifiedNativeOrganizations = 0;
  for (const identity of PHASE_ONE_TENANT_IDENTITIES) {
    let accessToken;
    let nativeTokenIssued = false;
    if (fallbackOnly) {
      accessToken = await issueAccessToken(identity, 'openid');
    } else {
      try {
        accessToken = await issueAccessToken(identity, `openid ${identity.organizationScope}`);
        nativeTokenIssued = true;
      } catch (error) {
        if (!autoFallback) throw error;
        accessToken = await issueAccessToken(identity, 'openid');
        console.warn(
          `⚠ native Organization token ของ ${identity.slug} ใช้ไม่ได้; ตรวจ fallback แทน: ${error.message}`,
        );
      }
    }
    const [encodedHeader, encodedPayload, encodedSignature] = accessToken.split('.');
    const header = base64UrlJson(encodedHeader);
    const claims = base64UrlJson(encodedPayload);
    assert(header.typ === 'JWT', `Keycloak access token typ ไม่ตรง contract: ${header.typ}`);
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
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...claims, tenant_id: 'identity-that-was-not-verified' }),
    ).toString('base64url');
    assert(
      !verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${tamperedPayload}`),
        createPublicKey({ key: signingJwk, format: 'jwk' }),
        Buffer.from(encodedSignature, 'base64url'),
      ),
      'token ที่ payload ถูกแก้ไขต้องไม่ผ่านการตรวจลายเซ็น',
    );

    const database = databaseIdentity(identity.agentEmail);
    verifiedTenantIds.push(database.tenantId);
    assert(claims.iss === issuer, 'token issuer ไม่ตรง contract');
    assert(
      claims.aud === 'dcontact-api' || claims.aud?.includes('dcontact-api'),
      'token ไม่มี dcontact-api audience',
    );
    assert(claims.sub === database.keycloakId, 'token subject ไม่ตรง users.keycloak_id');
    assert(claims.tenant_id === database.tenantId, 'tenant_id ไม่ตรง Postgres tenant');
    assert(claims.tenant_slug === identity.slug, `tenant_slug ต้องเป็น ${identity.slug}`);
    assert(claims.dc_user_id === database.userId, 'dc_user_id ไม่ตรง Postgres user');
    assert(claims.realm_access?.roles?.includes('agent'), 'token ไม่มี agent role');
    if (!fallbackOnly && nativeTokenIssued) {
      const organization = claims.organization?.[identity.slug];
      const nativeClaimsMatch =
        organization?.tenant_id?.[0] === database.tenantId &&
        organization?.tenant_slug?.[0] === identity.slug;
      if (!nativeClaimsMatch && autoFallback) {
        console.warn(
          `⚠ native Organization mapper ของ ${identity.slug} ไม่มี tenant attributes; flat claims ยังพร้อมใช้`,
        );
        nativeTokenIssued = false;
      } else {
        assert(
          nativeClaimsMatch,
          `native Organization mapper ไม่มี tenant attributes ของ ${identity.slug}`,
        );
      }
    }
    if (nativeTokenIssued) verifiedNativeOrganizations += 1;

    const fallbackClaims = base64UrlJson(
      (await issueAccessToken(identity, 'openid')).split('.')[1],
    );
    assert(!fallbackClaims.organization, 'fallback evidence ต้องไม่พึ่ง native Organization claim');
    assert(fallbackClaims.tenant_id === database.tenantId, 'fallback tenant_id ไม่ตรง contract');
    assert(
      fallbackClaims.tenant_slug === identity.slug,
      `fallback tenant_slug ต้องเป็น ${identity.slug}`,
    );
    assert(fallbackClaims.dc_user_id === database.userId, 'fallback dc_user_id ไม่ตรง contract');
  }
  assert(new Set(verifiedTenantIds).size === 2, 'Phase 1 ต้องยืนยัน tenant_id ที่ต่างกันสองค่า');

  console.log('✓ OIDC discovery และ JWKS เข้าถึงได้');
  console.log('✓ Access token มีลายเซ็น audience และ claims ที่ตรงกับ Postgres');
  console.log('✓ identity จาก token ที่ถูกแก้ไขถูกปฏิเสธก่อนสร้าง tenant context');
  console.log('✓ Access token ของสอง tenant มี claims ตรงกับ Postgres และ tenant_id ไม่ซ้ำกัน');
  if (!fallbackOnly && verifiedNativeOrganizations === PHASE_ONE_TENANT_IDENTITIES.length)
    console.log('✓ Keycloak 26 native Organization mapper ส่ง tenant attributes ครบสอง tenant');
  console.log('✓ flat fallback claims คง public claim shape โดยไม่พึ่ง native mapper');
}

main().catch((error) => {
  console.error(`✗ Keycloak dev identity ยังไม่พร้อม: ${error.message}`);
  process.exitCode = 1;
});
