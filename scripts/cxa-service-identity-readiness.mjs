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
  assert(tenantId, `tenant ${slug} not found in Postgres`);
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
      `failed to issue a client_credentials token for ${identity.slug} (${response.status})`,
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
  assert(signingJwk, 'service token signing key not found in JWKS');
  assert(
    verify(
      'RSA-SHA256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      createPublicKey({ key: signingJwk, format: 'jwk' }),
      Buffer.from(encodedSignature, 'base64url'),
    ),
    'service token signature verification failed',
  );
  assert(claims.iss === issuer, 'service token issuer does not match');
  assert(
    claims.aud === audience || claims.aud?.includes(audience),
    'service token audience does not match',
  );
  assert(claims.exp * 1_000 > Date.now(), 'service token has expired');
  assert(claims.tenant_id === tenantId, `service tenant of ${identity.slug} does not match`);
  assert(
    claims.tenant_slug === identity.slug,
    `service tenant_slug of ${identity.slug} does not match`,
  );
  assert(
    claims.organization?.[identity.slug]?.tenant_id?.[0] === tenantId,
    `service Organization of ${identity.slug} does not match`,
  );
  assert(
    claims.azp === identity.eventClientId,
    `service client of ${identity.slug} does not match`,
  );
  assert(
    claims.preferred_username === `service-account-${identity.eventClientId}`,
    `service account of ${identity.slug} does not match`,
  );
  assert(
    claims.realm_access?.roles?.includes('journey-ingress'),
    `service client of ${identity.slug} has no journey-ingress role`,
  );
  assert(
    claims.dc_user_id === undefined && claims.sid === undefined,
    'service token has user claims',
  );
  return { tenantId, clientId: claims.azp };
}

export async function runCxaServiceIdentityReadiness() {
  const discoveryResponse = await fetch(`${issuer}/.well-known/openid-configuration`);
  assert(discoveryResponse.ok, `OIDC discovery responded ${discoveryResponse.status}`);
  const discovery = await discoveryResponse.json();
  const jwksResponse = await fetch(discovery.jwks_uri);
  assert(jwksResponse.ok, `JWKS responded ${jwksResponse.status}`);
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

  assert(
    new Set(evidence.map(({ tenantId }) => tenantId)).size === 2,
    'both tenants must be verified',
  );
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
