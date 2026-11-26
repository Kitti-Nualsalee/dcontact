/** Issues test tokens with a local key — same shape as what Keycloak really issues to platform-console (checked in the boundary test) */
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { JosePlatformAccessTokenVerifier } from './platform-verifier.js';

export const TEST_ISSUER = 'http://keycloak.test/realms/dcontact';
export const TEST_NOW = new Date('2026-09-24T03:00:00.000Z');

export interface TestSigner {
  verifier: JosePlatformAccessTokenVerifier;
  sign(
    claims: Record<string, unknown>,
    options?: { typ?: string; issuer?: string },
  ): Promise<string>;
}

async function keyPair() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: randomUUID(), alg: 'RS256', use: 'sig' };
  return { privateKey, jwk };
}

export async function createTestSigner(): Promise<TestSigner & { forger: TestSigner['sign'] }> {
  const trusted = await keyPair();
  const forged = await keyPair();
  const verifier = new JosePlatformAccessTokenVerifier({
    issuer: TEST_ISSUER,
    keys: createLocalJWKSet({ keys: [trusted.jwk] }),
    // test tokens have an exp based on TEST_NOW; jose does not judge time itself, so identity mapping uses the injected clock
    clockToleranceSeconds: 10 * 365 * 24 * 3600,
  });
  const signWith =
    (key: Awaited<ReturnType<typeof keyPair>>) =>
    (claims: Record<string, unknown>, options: { typ?: string; issuer?: string } = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: key.jwk.kid, typ: options.typ ?? 'JWT' })
        .setIssuer(options.issuer ?? TEST_ISSUER)
        .sign(key.privateKey);
  return { verifier, sign: signWith(trusted), forger: signWith(forged) };
}

const exp = Math.floor(TEST_NOW.getTime() / 1000) + 300;

/** real platform-console claims after a password+OTP login (#407 live capture) */
export function platformClaims(role: string, overrides: Record<string, unknown> = {}) {
  return {
    exp,
    iat: exp - 300,
    auth_time: exp - 300,
    jti: randomUUID(),
    aud: 'dcontact-platform-api',
    sub: `sub-${role}`,
    typ: 'Bearer',
    azp: 'platform-console',
    sid: `sid-${role}`,
    acr: '1',
    resource_access: { 'dcontact-platform-api': { roles: [role] } },
    scope: 'openid',
    amr: ['pwd', 'otp'],
    ...overrides,
  };
}

/** claims of a tenant workspace token (console client) — must not work with the Platform API */
export function tenantClaims(overrides: Record<string, unknown> = {}) {
  return {
    exp,
    iat: exp - 300,
    aud: 'dcontact-api',
    sub: 'tenant-admin-sub',
    typ: 'Bearer',
    azp: 'dcontact-console',
    sid: 'tenant-sid',
    tenant_id: '11111111-1111-4111-8111-111111111111',
    tenant_slug: 'demo',
    dc_user_id: '22222222-2222-4222-8222-222222222222',
    organization: { demo: { id: 'org-demo' } },
    realm_access: { roles: ['admin'] },
    ...overrides,
  };
}
