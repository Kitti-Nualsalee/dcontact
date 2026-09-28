/**
 * E1.11 (#485): ล็อก host origin ของ dphone ที่ถูกฝัง (E1.5 #461 ข้อ 5)
 *
 * - allowlist มาจาก JSON ที่ API ฝังใน shell (`#dphone-embed-config`) เท่านั้น — ไม่รับค่าจาก host
 * - host origin หาจาก `location.ancestorOrigins` (Chrome/Edge) หรือ `document.referrer`
 *   ถ้าไม่ตรงกับ allowlist แบบ exact จะไม่เริ่มทำงาน
 * - หลังล็อก ข้อความขาเข้าต้องมี `event.origin` ตรงกับที่ล็อกและ `event.source === window.parent`
 * - ได้ `embed.origin.revoked` ของ origin ที่ล็อก → ปฏิเสธข้อความจาก host นั้นทันที
 */

export interface EmbedConfig {
  v: 1;
  tenant: string | null;
  allowedHostOrigins: string[];
  /** E1.13: OIDC ของ dphone ที่ถูกฝัง (client `dphone-embedded`) — ไม่มี = ยัง login ไม่ได้ */
  auth: { issuer: string; clientId: string } | null;
}

export function parseEmbedConfig(text: string | null | undefined): EmbedConfig | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<EmbedConfig>;
    if (value.v !== 1 || !Array.isArray(value.allowedHostOrigins)) return null;
    if (!value.allowedHostOrigins.every((origin) => typeof origin === 'string')) return null;
    return {
      v: 1,
      tenant: typeof value.tenant === 'string' ? value.tenant : null,
      allowedHostOrigins: value.allowedHostOrigins,
      auth:
        typeof value.auth?.issuer === 'string' && typeof value.auth.clientId === 'string'
          ? { issuer: value.auth.issuer, clientId: value.auth.clientId }
          : null,
    };
  } catch {
    return null;
  }
}

export function resolveHostOrigin(input: {
  ancestorOrigins?: ArrayLike<string> | null;
  referrer?: string;
}): string | null {
  const ancestor = input.ancestorOrigins?.length ? input.ancestorOrigins[0] : undefined;
  if (ancestor) return ancestor;
  if (!input.referrer) return null;
  try {
    return new URL(input.referrer).origin;
  } catch {
    return null;
  }
}

export interface HostOriginLock {
  readonly origin: string;
  /** ข้อความจาก host ที่ล็อกไว้เท่านั้น (exact origin + source เป็น parent) และยังไม่ถูกเพิกถอน */
  accepts(event: { origin: string; source: unknown }): boolean;
  /** `embed.origin.revoked` จาก WS — คืน true เมื่อเป็น origin ที่ล็อกไว้ (หยุดรับข้อความทันที) */
  revoke(origin: string): boolean;
  readonly revoked: boolean;
}

export function lockHostOrigin(
  config: EmbedConfig | null,
  hostOrigin: string | null,
  parent: unknown,
): HostOriginLock | null {
  if (!config || !hostOrigin || !config.allowedHostOrigins.includes(hostOrigin)) return null;
  let revoked = false;
  return {
    origin: hostOrigin,
    accepts: (event) => !revoked && event.origin === hostOrigin && event.source === parent,
    revoke: (origin) => {
      if (origin !== hostOrigin) return false;
      revoked = true;
      return true;
    },
    get revoked() {
      return revoked;
    },
  };
}
