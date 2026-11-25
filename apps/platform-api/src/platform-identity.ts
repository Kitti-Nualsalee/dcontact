/**
 * Owner: IAM + Platform edge — platform principal of the Platform Admin (A1.2 #407)
 *
 * Authority: #387 (identity plane/roles/enforcement invariants), Phase Contract #388
 *
 * Converts claims whose signature/issuer/audience/expiry the verifier has already checked into a platform principal, fail closed:
 * - must be issued to `platform-console` only (`azp`) and be an access token (`typ=Bearer`)
 * - **must not carry any tenant context** (`tenant_id/tenant_slug/organization/dc_user_id`) nor any tenant
 *   realm role — a token mixing platform and tenant is rejected whole, not trimmed of the excess
 * - the role comes only from the client roles of `dcontact-platform-api` and must be a known value
 * - must log in with password + OTP (`amr` has both `pwd` and `otp`) — the API enforces MFA again and does not trust the UI
 */
export const PLATFORM_API_AUDIENCE = 'dcontact-platform-api';
export const PLATFORM_CONSOLE_CLIENT = 'platform-console';
export const PLATFORM_ROLES = ['platform_operator', 'platform_auditor'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * capabilities a route declares — a mutation must be explicit (#387 deny by default)
 * `platform_auditor` only ever has read
 */
export const PLATFORM_CAPABILITIES = {
  CONTROL_PLANE_READ: ['platform_operator', 'platform_auditor'],
  PROVISIONING_MUTATE: ['platform_operator'],
} as const satisfies Record<string, readonly PlatformRole[]>;
export type PlatformCapability = keyof typeof PLATFORM_CAPABILITIES;

export interface VerifiedPlatformIdentity {
  subject: string;
  sessionId: string;
  roles: PlatformRole[];
  capabilities: PlatformCapability[];
  expiresAt: Date;
}

/** machine-code reason for audit/metrics — not sent back to the client (the client gets a generic error) */
export type PlatformIdentityRejection =
  | 'NOT_ACCESS_TOKEN'
  | 'WRONG_CLIENT'
  | 'TENANT_CONTEXT_PRESENT'
  | 'TENANT_ROLE_PRESENT'
  | 'NO_PLATFORM_ROLE'
  | 'MFA_REQUIRED'
  | 'EXPIRED'
  | 'MALFORMED';

export class PlatformIdentityError extends Error {
  constructor(readonly reason: PlatformIdentityRejection) {
    super(`platform identity rejected: ${reason}`);
    this.name = 'PlatformIdentityError';
  }
}

const TENANT_CLAIMS = ['tenant_id', 'tenant_slug', 'organization', 'dc_user_id'] as const;

function asStrings(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;
}

export function toVerifiedPlatformIdentity(
  claims: Record<string, unknown>,
  now: Date = new Date(),
): VerifiedPlatformIdentity {
  if (claims.typ !== 'Bearer') throw new PlatformIdentityError('NOT_ACCESS_TOKEN');
  if (claims.azp !== PLATFORM_CONSOLE_CLIENT) throw new PlatformIdentityError('WRONG_CLIENT');
  if (TENANT_CLAIMS.some((claim) => claims[claim] !== undefined)) {
    throw new PlatformIdentityError('TENANT_CONTEXT_PRESENT');
  }
  const realmRoles = (claims.realm_access as { roles?: unknown } | undefined)?.roles;
  if (realmRoles !== undefined && (asStrings(realmRoles)?.length ?? 1) > 0) {
    // platform-console uses fullScopeAllowed=false — a realm role showing up means the token did not come from this profile
    throw new PlatformIdentityError('TENANT_ROLE_PRESENT');
  }
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp)) {
    throw new PlatformIdentityError('MALFORMED');
  }
  const expiresAt = new Date(claims.exp * 1000);
  if (expiresAt.getTime() <= now.getTime()) throw new PlatformIdentityError('EXPIRED');
  if (
    typeof claims.sub !== 'string' ||
    !claims.sub ||
    typeof claims.sid !== 'string' ||
    !claims.sid
  ) {
    throw new PlatformIdentityError('MALFORMED');
  }
  const amr = asStrings(claims.amr) ?? [];
  if (!amr.includes('pwd') || !amr.includes('otp')) throw new PlatformIdentityError('MFA_REQUIRED');

  const access = claims.resource_access as Record<string, { roles?: unknown }> | undefined;
  const granted = asStrings(access?.[PLATFORM_API_AUDIENCE]?.roles) ?? [];
  const roles = PLATFORM_ROLES.filter((role) => granted.includes(role));
  if (roles.length === 0) throw new PlatformIdentityError('NO_PLATFORM_ROLE');
  const capabilities = (Object.keys(PLATFORM_CAPABILITIES) as PlatformCapability[]).filter(
    (capability) =>
      (PLATFORM_CAPABILITIES[capability] as readonly PlatformRole[]).some((role) =>
        roles.includes(role),
      ),
  );
  return { subject: claims.sub, sessionId: claims.sid, roles, capabilities, expiresAt };
}
