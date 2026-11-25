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
  assert(userId && tenantId && keycloakId, `the Postgres identity of ${email} is not fully linked`);
  return { userId, tenantId, keycloakId };
}

async function main() {
  const discoveryResponse = await fetch(discoveryUrl);
  assert(discoveryResponse.ok, `OIDC discovery responded ${discoveryResponse.status}`);
  const discovery = await discoveryResponse.json();
  assert(discovery.issuer === issuer, `issuer does not match the contract: ${discovery.issuer}`);

  const jwksResponse = await fetch(discovery.jwks_uri);
  assert(jwksResponse.ok, `JWKS responded ${jwksResponse.status}`);
  const jwks = await jwksResponse.json();
  assert(Array.isArray(jwks.keys) && jwks.keys.length > 0, 'JWKS has no signing key');

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
        `failed to issue a dev access token (${response.status}): ${await response.text()}`,
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
          `⚠ the native Organization token of ${identity.slug} is unusable; checking the fallback instead: ${error.message}`,
        );
      }
    }
    const [encodedHeader, encodedPayload, encodedSignature] = accessToken.split('.');
    const header = base64UrlJson(encodedHeader);
    const claims = base64UrlJson(encodedPayload);
    assert(
      header.typ === 'JWT',
      `the Keycloak access token typ does not match the contract: ${header.typ}`,
    );
    const signingJwk = jwks.keys.find((key) => key.kid === header.kid);
    assert(signingJwk, 'the signing key of the token was not found in JWKS');
    assert(
      verify(
        'RSA-SHA256',
        Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey({ key: signingJwk, format: 'jwk' }),
        Buffer.from(encodedSignature, 'base64url'),
      ),
      'verifying the access token signature with JWKS failed',
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
      'a token whose payload was edited must fail signature verification',
    );

    const database = databaseIdentity(identity.agentEmail);
    verifiedTenantIds.push(database.tenantId);
    assert(claims.iss === issuer, 'the token issuer does not match the contract');
    assert(
      claims.aud === 'dcontact-api' || claims.aud?.includes('dcontact-api'),
      'the token has no dcontact-api audience',
    );
    assert(
      claims.sub === database.keycloakId,
      'the token subject does not match users.keycloak_id',
    );
    assert(claims.tenant_id === database.tenantId, 'tenant_id does not match the Postgres tenant');
    assert(claims.tenant_slug === identity.slug, `tenant_slug must be ${identity.slug}`);
    assert(claims.dc_user_id === database.userId, 'dc_user_id does not match the Postgres user');
    assert(claims.realm_access?.roles?.includes('agent'), 'the token has no agent role');
    if (!fallbackOnly && nativeTokenIssued) {
      const organization = claims.organization?.[identity.slug];
      const nativeClaimsMatch =
        organization?.tenant_id?.[0] === database.tenantId &&
        organization?.tenant_slug?.[0] === identity.slug;
      if (!nativeClaimsMatch && autoFallback) {
        console.warn(
          `⚠ the native Organization mapper of ${identity.slug} has no tenant attributes; the flat claims are still usable`,
        );
        nativeTokenIssued = false;
      } else {
        assert(
          nativeClaimsMatch,
          `the native Organization mapper has no tenant attributes for ${identity.slug}`,
        );
      }
    }
    if (nativeTokenIssued) verifiedNativeOrganizations += 1;

    const fallbackClaims = base64UrlJson(
      (await issueAccessToken(identity, 'openid')).split('.')[1],
    );
    assert(
      !fallbackClaims.organization,
      'the fallback evidence must not depend on the native Organization claim',
    );
    assert(
      fallbackClaims.tenant_id === database.tenantId,
      'the fallback tenant_id does not match the contract',
    );
    assert(
      fallbackClaims.tenant_slug === identity.slug,
      `the fallback tenant_slug must be ${identity.slug}`,
    );
    assert(
      fallbackClaims.dc_user_id === database.userId,
      'the fallback dc_user_id does not match the contract',
    );
  }
  assert(
    new Set(verifiedTenantIds).size === 2,
    'Phase 1 must verify two different tenant_id values',
  );

  console.log('✓ OIDC discovery and JWKS are reachable');
  console.log('✓ The access token has a signature, audience and claims that match Postgres');
  console.log('✓ An identity from an edited token is rejected before a tenant context is created');
  console.log(
    '✓ The access tokens of the two tenants have claims matching Postgres and the tenant_id values differ',
  );
  if (!fallbackOnly && verifiedNativeOrganizations === PHASE_ONE_TENANT_IDENTITIES.length)
    console.log(
      '✓ The Keycloak 26 native Organization mapper sends the full tenant attributes for both tenants',
    );
  console.log(
    '✓ The flat fallback claims keep the public claim shape without depending on the native mapper',
  );
}

main().catch((error) => {
  console.error(`✗ The Keycloak dev identity is not ready: ${error.message}`);
  process.exitCode = 1;
});
