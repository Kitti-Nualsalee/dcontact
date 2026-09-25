/**
 * D1.11 (#450): ลำดับการเลือกภาษาและ timezone ตาม D1.5 (#425)
 *
 * ภาษา: ผู้ใช้ (Keycloak attribute `locale`) → ค่าเริ่มต้นของ tenant → ภาษา browser → `th`
 * timezone: ผู้ใช้ (claim `zoneinfo`) → tenant (IANA) — ไม่ใช้เวลาเครื่องเด็ดขาด เพราะเอเจนต์ที่นั่ง
 * ต่างเครื่อง/ต่างประเทศต้องเห็นเวลาของงานตรงกัน
 */

export const SUPPORTED_LOCALES = ['th', 'en'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'th';

/**
 * ใช้เมื่อทั้งผู้ใช้และ tenant ยังไม่มี timezone (tenant เดิมก่อน A1.5 ไม่มีแถว `tenant_settings`)
 * เป็นค่าคงที่ของระบบ ไม่ใช่เวลาเครื่อง
 */
export const DEFAULT_TIME_ZONE = 'Asia/Bangkok';

/** รับ `th`, `th-TH`, `en_US`, `EN` ฯลฯ แล้วคืนภาษาที่ระบบรองรับ หรือ undefined */
export function normalizeLocale(value: unknown): SupportedLocale | undefined {
  if (typeof value !== 'string') return undefined;
  const language = value.trim().toLowerCase().split(/[-_]/)[0];
  return SUPPORTED_LOCALES.find((locale) => locale === language);
}

export interface LocaleSources {
  user?: unknown;
  tenant?: unknown;
  /** `navigator.languages` ตามลำดับที่ browser ส่งมา */
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
