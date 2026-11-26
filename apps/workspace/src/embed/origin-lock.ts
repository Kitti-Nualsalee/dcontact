/**
 * E1.11 (#485): lock the host origin of the embedded dphone (E1.5 #461 item 5)
 *
 * - the allowlist comes only from JSON the API embeds in the shell (`#dphone-embed-config`) — values from the host are not accepted
 * - the host origin is found from `location.ancestorOrigins` (Chrome/Edge) or `document.referrer`
 *   if it does not match the allowlist exactly, it does not start
 * - after locking, an inbound message must have `event.origin` equal to the locked one and `event.source === window.parent`
 * - on receiving `embed.origin.revoked` for the locked origin → reject messages from that host immediately
 */

export interface EmbedConfig {
  v: 1;
  ownerWindow?: boolean;
  tenant: string | null;
  allowedHostOrigins: string[];
  /** E1.13: OIDC of the embedded dphone (client `dphone-embedded`) — absent = cannot log in yet */
  auth: { issuer: string; clientId: string } | null;
  /** E1.14: screen-pop level per origin (unknown/absent value = off) — the server re-checks when actually sending */
  screenPopLevels?: Record<string, 'off' | 'ids' | 'contact' | 'custom'>;
}

export function parseEmbedConfig(text: string | null | undefined): EmbedConfig | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<EmbedConfig>;
    if (value.v !== 1 || !Array.isArray(value.allowedHostOrigins)) return null;
    if (!value.allowedHostOrigins.every((origin) => typeof origin === 'string')) return null;
    return {
      v: 1,
      ownerWindow: value.ownerWindow === true,
      tenant: typeof value.tenant === 'string' ? value.tenant : null,
      allowedHostOrigins: value.allowedHostOrigins,
      auth:
        typeof value.auth?.issuer === 'string' && typeof value.auth.clientId === 'string'
          ? { issuer: value.auth.issuer, clientId: value.auth.clientId }
          : null,
      screenPopLevels: screenPopLevelsOf(value.screenPopLevels),
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
  /** messages only from the locked host (exact origin + source is the parent) and not yet revoked */
  accepts(event: { origin: string; source: unknown }): boolean;
  /** `embed.origin.revoked` from the WS — returns true when it is the locked origin (stops accepting messages immediately) */
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

function screenPopLevelsOf(value: unknown): EmbedConfig['screenPopLevels'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const levels: NonNullable<EmbedConfig['screenPopLevels']> = {};
  for (const [origin, level] of Object.entries(value as Record<string, unknown>)) {
    if (level === 'ids' || level === 'contact' || level === 'custom') levels[origin] = level;
  }
  return levels;
}
