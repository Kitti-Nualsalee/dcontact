/**
 * E1.11 (#485): normalizes and validates the origins a tenant allows to embed dphone (E1.5 #461 item 2)
 *
 * Used by both the API (the decider) and the Console (checks as you type) so results agree
 * - `https://` only; `http://localhost` / `http://127.0.0.1` only when `allowLocalhost` (dev)
 * - normalized to lowercase `scheme://host[:port]`, default port stripped
 * - no path, query, fragment, userinfo, wildcard, raw IP, or the D-Contact origin itself
 */

// the shared build has no DOM lib — uses the WHATWG URL available in both Node and browsers, only the fields needed
declare const URL: new (input: string) => {
  username: string;
  password: string;
  hostname: string;
  origin: string;
};

export const MAX_EMBED_ORIGINS_PER_TENANT = 10;

export type EmbedOriginRejection =
  | 'INVALID_URL'
  | 'SCHEME_NOT_ALLOWED'
  | 'WILDCARD'
  | 'USERINFO'
  | 'PATH_QUERY_FRAGMENT'
  | 'IP_ADDRESS'
  | 'LOCALHOST_NOT_ALLOWED'
  | 'RESERVED_ORIGIN';

export type EmbedOriginResult =
  { ok: true; origin: string } | { ok: false; reason: EmbedOriginRejection };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
}

export function normalizeEmbedOrigin(
  input: string,
  options: { allowLocalhost?: boolean; reservedOrigins?: readonly string[] } = {},
): EmbedOriginResult {
  const raw = input.trim();
  if (!raw || raw.length > 255) return { ok: false, reason: 'INVALID_URL' };
  if (raw.includes('*')) return { ok: false, reason: 'WILDCARD' };
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase();
  if (!scheme) return { ok: false, reason: 'INVALID_URL' };
  let url: InstanceType<typeof URL>;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'INVALID_URL' };
  }
  if (url.username || url.password || /^[a-z]+:\/\/[^/]*@/i.test(raw)) {
    return { ok: false, reason: 'USERINFO' };
  }
  // anything after host[:port] other than a single "/" = path/query/fragment
  const afterAuthority = raw.slice(raw.indexOf('//') + 2).replace(/^[^/?#]*/, '');
  if (afterAuthority !== '' && afterAuthority !== '/') {
    return { ok: false, reason: 'PATH_QUERY_FRAGMENT' };
  }
  const hostname = url.hostname.toLowerCase();
  const local = LOCAL_HOSTS.has(hostname);
  if (scheme === 'http') {
    if (!local) return { ok: false, reason: 'SCHEME_NOT_ALLOWED' };
    if (!options.allowLocalhost) return { ok: false, reason: 'LOCALHOST_NOT_ALLOWED' };
  } else if (scheme !== 'https') {
    return { ok: false, reason: 'SCHEME_NOT_ALLOWED' };
  }
  if (local && !options.allowLocalhost) return { ok: false, reason: 'LOCALHOST_NOT_ALLOWED' };
  if (!local && isIpLiteral(hostname)) return { ok: false, reason: 'IP_ADDRESS' };
  // URL already strips the default port (https:443, http:80)
  const origin = url.origin.toLowerCase();
  const reserved = (options.reservedOrigins ?? []).map((value) => value.toLowerCase());
  if (reserved.includes(origin)) return { ok: false, reason: 'RESERVED_ORIGIN' };
  return { ok: true, origin };
}
