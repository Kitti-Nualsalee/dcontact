/**
 * #588: user info for the top bar menu — read from the OIDC claims the app already has, no extra API call
 * display only; real permissions live in the API
 */

/** roles the menu knows, in display order — other roles in the token are hidden (raw role names are not shown) */
export const SHELL_ROLES = ['admin', 'supervisor', 'compliance', 'agent'] as const;

export type ShellRole = (typeof SHELL_ROLES)[number];

export interface ShellUser {
  displayName: string;
  email?: string;
  /** tenant alias the app is using */
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

// leading vowels (เ แ โ ใ ไ) are written before the consonant — the initial of a Thai name must be the first consonant // allow-thai: Thai vowel examples
const THAI_LEADING_VOWEL = /[เ-ไ]/u; // allow-thai: Thai leading-vowel range
const LETTER = /\p{L}/u;

function firstLetter(word: string): string | undefined {
  for (const char of word) {
    if (THAI_LEADING_VOWEL.test(char)) continue;
    if (LETTER.test(char)) return char.toUpperCase();
  }
  return undefined;
}

/** first letter of the first and last word, e.g. "Somchai Jaidee" → "SJ", "สมชาย ใจดี" → "สจ"; no letters = "" */ // allow-thai: Thai example
export function userInitials(displayName: string): string {
  const letters = displayName
    .split(/\s+/u)
    .map(firstLetter)
    .filter((letter): letter is string => letter !== undefined);
  if (letters.length === 0) return '';
  return letters.length === 1 ? letters[0]! : letters[0]! + letters[letters.length - 1]!;
}
