/**
 * D1.11 (#450): order for choosing language and timezone per D1.5 (#425)
 *
 * language: user (Keycloak attribute `locale`) → tenant default → browser language → `th`
 * timezone: user (claim `zoneinfo`) → tenant (IANA) — never the machine time, because agents on
 * different machines/countries must see the same job times
 */

export const SUPPORTED_LOCALES = ['th', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'th';

/**
 * used when neither the user nor the tenant has a timezone yet (tenants before A1.5 have no `tenant_settings` row)
 * a system constant, not the machine time
 */
export const DEFAULT_TIME_ZONE = 'Asia/Bangkok';

/** accepts `th`, `th-TH`, `en_US`, `EN`, etc. and returns a supported language, or undefined */
export function normalizeLocale(value: unknown): SupportedLocale | undefined {
  if (typeof value !== 'string') return undefined;
  const language = value.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.find((locale) => locale === language);
}

export interface LocaleSources {
  user?: unknown;
  tenant?: unknown;
  /** `navigator.languages` in the order the browser sends them */
  browser?: readonly string[];
}

export function resolveLocale(sources: LocaleSources): SupportedLocale {
  const candidates = [sources.user, sources.tenant, ...(sources.browser ?? [])];
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}

export function isIanaTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function resolveTimeZone(sources: { user?: unknown; tenant?: unknown }): string {
  if (isIanaTimeZone(sources.user)) return sources.user;
  if (isIanaTimeZone(sources.tenant)) return sources.tenant;
  return DEFAULT_TIME_ZONE;
}
