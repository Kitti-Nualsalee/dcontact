/**
 * Owner: IAM + Platform edge — platform principal ของ Platform Admin (A1.2 #407)
 *
 * Authority: #387 (identity plane/roles/enforcement invariants), Phase Contract #388
 *
 * แปลง claims ที่ verifier ตรวจ signature/issuer/audience/expiry แล้ว เป็น platform principal แบบ fail closed:
 * - ต้องออกให้ `platform-console` เท่านั้น (`azp`) และเป็น access token (`typ=Bearer`)
 * - **ห้ามมี tenant context ใด ๆ** (`tenant_id/tenant_slug/organization/dc_user_id`) และห้ามมี realm role
 *   ของ tenant — token ที่ปน platform กับ tenant ถูกปฏิเสธทั้งใบ ไม่ใช่ตัดส่วนเกินทิ้ง
 * - role มาจาก client roles ของ `dcontact-platform-api` เท่านั้น และต้องเป็นค่าที่รู้จัก
 * - ต้อง login ด้วยรหัสผ่าน + OTP (`amr` มีทั้ง `pwd` และ `otp`) — API บังคับ MFA ซ้ำ ไม่เชื่อ UI
 */
export const PLATFORM_API_AUDIENCE = 'dcontact-platform-api';
export const PLATFORM_CONSOLE_CLIENT = 'platform-console';
export const PLATFORM_ROLES = ['platform_operator', 'platform_auditor'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/**
 * capability ที่ route ประกาศ — mutation ต้องระบุ explicit (#387 deny by default)
 * `platform_auditor` มีเฉพาะ read ไม่ว่ากรณีใด
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

/** เหตุผลแบบ machine code สำหรับ audit/metrics — ไม่ส่งกลับ client (client ได้ error แบบ generic) */
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
    // platform-console ใช้ fullScopeAllowed=false — realm role โผล่มาแปลว่า token ไม่ได้มาจาก profile นี้
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
