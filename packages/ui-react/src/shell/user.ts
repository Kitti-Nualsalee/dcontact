/**
 * #588: ข้อมูลผู้ใช้ของเมนูบนแถบบน — อ่านจาก claims ของ OIDC ที่แอปมีอยู่แล้ว ไม่เรียก API เพิ่ม
 * ใช้แสดงผลอย่างเดียว สิทธิ์จริงอยู่ที่ API
 */

/** บทบาทที่เมนูรู้จัก ตามลำดับที่แสดง — role อื่นใน token ถูกซ่อน (ไม่แสดงชื่อ role ดิบ) */
export const SHELL_ROLES = ['admin', 'supervisor', 'compliance', 'agent'] as const;

export type ShellRole = (typeof SHELL_ROLES)[number];

export interface ShellUser {
  displayName: string;
  email?: string;
  /** tenant alias ที่แอปใช้อยู่ */
  organization?: string;
  roles: readonly ShellRole[];
}

export type ShellUserClaims = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** `name` → `given_name` + `family_name` → `preferred_username` */
export function displayNameFromClaims(claims: ShellUserClaims): string {
  const given = [text(claims.given_name), text(claims.family_name)].filter(Boolean).join(' ');
  return text(claims.name) ?? (given || text(claims.preferred_username) || '');
}

export function shellRolesFromClaims(claims: ShellUserClaims): ShellRole[] {
  const realm = claims.realm_access as { roles?: unknown } | undefined;
  const roles = Array.isArray(realm?.roles) ? realm.roles : [];
  return SHELL_ROLES.filter((role) => roles.includes(role));
}

export function shellUserFromClaims(claims: ShellUserClaims, organization?: string): ShellUser {
  return {
    displayName: displayNameFromClaims(claims),
    email: text(claims.email),
    organization,
    roles: shellRolesFromClaims(claims),
  };
}

// สระหน้า (เ แ โ ใ ไ) อยู่ก่อนพยัญชนะในการเขียน — อักษรย่อของชื่อไทยต้องเป็นพยัญชนะตัวแรก
const THAI_LEADING_VOWEL = /[เ-ไ]/u;
const LETTER = /\p{L}/u;

function firstLetter(word: string): string | undefined {
  for (const char of word) {
    if (THAI_LEADING_VOWEL.test(char)) continue;
    if (LETTER.test(char)) return char.toLocaleUpperCase();
  }
  return undefined;
}

/** อักษรตัวแรกของคำแรกและคำสุดท้าย เช่น "Somchai Jaidee" → "SJ", "สมชาย ใจดี" → "สจ"; ไม่มีตัวอักษร = "" */
export function userInitials(displayName: string): string {
  const words = displayName.split(/\s+/u).filter((word) => firstLetter(word));
  if (words.length === 0) return '';
  const first = firstLetter(words[0]!)!;
  return words.length === 1 ? first : first + firstLetter(words[words.length - 1]!)!;
}
