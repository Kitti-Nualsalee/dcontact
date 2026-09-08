import { createPublicKey, verify } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compose } from './dev-infra-compose.mjs';
import { PHASE_ONE_TENANT_IDENTITIES } from './phase-one-tenants.mjs';

const issuer = process.env.KEYCLOAK_ISSUER ?? 'http://localhost:8081/realms/dcontact';
const audience = process.env.KEYCLOAK_AUDIENCE ?? 'dcontact-api';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function databaseTenantId(slug) {
  const safeSlug = slug.replaceAll("'", "''");
  const tenantId = compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact',
    '-tAc',
    `SELECT id FROM tenants WHERE slug = '${safeSlug}';`,
  );
  assert(tenantId, `ไม่พบ tenant ${slug} ใน Postgres`);
  return tenantId;
}

async function issueServiceToken(tokenEndpoint, identity) {
  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: identity.eventClientId,
      client_secret: identity.eventClientSecret,
      scope: `openid ${identity.organizationScope}`,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `ออก client_credentials token ของ ${identity.slug} ไม่สำเร็จ (${response.status})`,
    );
  }
  return (await response.json()).access_token;
}

function decodeJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function verifyServiceToken(accessToken, jwks, identity, tenantId) {
  const [encodedHeader, encodedPayload, encodedSignature] = accessToken.split('.');
  const header = decodeJson(encodedHeader);
  const claims = decodeJson(encodedPayload);
  const signingJwk = jwks.keys.find((key) => key.kid === header.kid);
  assert(signingJwk, 'ไม่พบ signing key ของ service token ใน JWKS');
  assert(
    verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key: signingJwk, format: 'jwk' }),
      Buffer.from(encodedSignature, 'base64url'),
    ),
    'ตรวจลายเซ็น service token ไม่ผ่าน',
  );
  assert(claims.iss === issuer, 'service token issuer ไม่ตรง');
  assert(
    claims.aud === audience || claims.aud?.includes(audience),
    'service token audience ไม่ตรง',
  );
  assert(claims.exp * 1_000 > Date.now(), 'service token หมดอายุ');
  assert(claims.tenant_id === tenantId, `service tenant ของ ${identity.slug} ไม่ตรง`);
  assert(claims.tenant_slug === identity.slug, `service tenant_slug ของ ${identity.slug} ไม่ตรง`);
  assert(
    claims.organization?.[identity.slug]?.tenant_id?.[0] === tenantId,
    `service Organization ของ ${identity.slug} ไม่ตรง`,
  );
  assert(claims.azp === identity.eventClientId, `service client ของ ${identity.slug} ไม่ตรง`);
  assert(
    claims.preferred_username === `service-account-${identity.eventClientId}`,
    `service account ของ ${identity.slug} ไม่ตรง`,
  );
  assert(
    claims.realm_access?.roles?.includes('journey-ingress'),
    `service client ของ ${identity.slug} ไม่มี journey-ingress role`,
  );
  assert(
    claims.dc_user_id === undefined && claims.sid === undefined,
    'service token มี user claims',
  );
  return { tenantId, clientId: claims.azp };
}

export async function runCxaServiceIdentityReadiness() {
  const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
  assert(discoveryResponse.ok, `OIDC discovery ตอบ ${discoveryResponse.status}`);
  const discovery = await discoveryResponse.json();
  const jwksResponse = await fetch(discovery.jwks_uri);
  assert(jwksResponse.ok, `JWKS ตอบ ${jwksResponse.status}`);
  const jwks = await jwksResponse.json();
  const evidence = [];

  for (const identity of PHASE_ONE_TENANT_IDENTITIES) {
    const tenantId = databaseTenantId(identity.slug);
    const accessToken = await issueServiceToken(discovery.token_endpoint, identity);
    const serviceIdentity = verifyServiceToken(accessToken, jwks, identity, tenantId);
    evidence.push({
      tenantSlug: identity.slug,
      tenantId,
      clientId: serviceIdentity.clientId,
      role: 'journey-ingress',
    });
  }

  assert(new Set(evidence.map(({ tenantId }) => tenantId)).size === 2, 'ต้องยืนยันสอง tenant');
  const summary = {
    type: 'identity.readiness',
    workflow: 'cx-automation-service-identity',
    status: 'PASS',
    grantType: 'client_credentials',
    evidence,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const invokedUrl = process.argv[1]
  ? pathToFileURL(resolve(repositoryRoot, process.argv[1])).href
  : undefined;
if (invokedUrl === import.meta.url) {
  runCxaServiceIdentityReadiness().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
