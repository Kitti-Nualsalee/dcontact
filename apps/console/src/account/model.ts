/**
 * AC5 (#598): the part of the "My account" page not tied to React — kept separate so it can be unit tested
 */
import { AccountApiError } from './api.js';

/** sessionStorage key holding the email verification token while waiting for login/verification (deleted as soon as used) */
export const VERIFY_TOKEN_KEY = 'dc.account.verifyToken';

/**
 * Verification link `/?view=account&verify=<token>`: move the token out of the URL immediately (before the login redirect and before render)
 * into sessionStorage temporarily, then `replaceState` to a URL without the token — so the token does not linger in the URL, history
 * or the login return URL
 */
export function stashVerifyToken(
  location: URL,
  storage: Pick<Storage, 'setItem'>,
  history: Pick<History, 'replaceState'>,
): URL {
  const token = location.searchParams.get('verify');
  if (token === null) return location;
  const clean = new URL(location.href);
  clean.searchParams.delete('verify');
  history.replaceState(null, '', `${clean.pathname}${clean.search}${clean.hash}`);
  if (token.trim()) {
    try {
      storage.setItem(VERIFY_TOKEN_KEY, token);
    } catch {
      // storage unusable (private mode) — the user must reopen the link after login; the token still does not linger in the URL
    }
  }
  return clean;
}

/** read then delete immediately — usable once */
export function takeVerifyToken(storage: Pick<Storage, 'getItem' | 'removeItem'>): string | null {
  try {
    const token = storage.getItem(VERIFY_TOKEN_KEY);
    storage.removeItem(VERIFY_TOKEN_KEY);
    return token;
  } catch {
    return null;
  }
}

/** API error → key in the `account` namespace (do not show the raw code or the identity system's name) */
export function accountErrorKey(error: unknown): string {
  if (!(error instanceof AccountApiError)) return 'errors.generic';
  switch (error.code) {
    case 'PASSWORD_POLICY_VIOLATION':
      return 'errors.passwordPolicy';
    case 'EMAIL_IN_USE':
      return 'errors.emailInUse';
    case 'EMAIL_CHANGE_NOT_ALLOWED':
      return 'errors.emailChangeNotAllowed';
    case 'EMAIL_CHANGE_EXPIRED':
      return 'errors.emailChangeExpired';
    case 'INVALID_OTP_CODE':
      return 'errors.invalidOtp';
    case 'ENROLMENT_EXPIRED':
      return 'errors.enrolmentExpired';
    case 'MFA_REQUIRED_LAST_DEVICE':
      return 'errors.lastDevice';
    case 'DEVICE_NOT_FOUND':
      return 'errors.deviceNotFound';
    case 'RATE_LIMITED':
      return 'errors.rateLimited';
    case 'REVISION_CONFLICT':
      return 'errors.revisionConflict';
    case 'MFA_ENFORCEMENT_UNAVAILABLE':
    case 'IDENTITY_UNAVAILABLE':
      return 'errors.unavailable';
    case 'VALIDATION_FAILED':
      return error.details.reason === 'SAME'
        ? 'errors.sameEmail'
        : error.details.reason === 'DUPLICATE'
          ? 'errors.labelInUse'
          : 'errors.invalid';
    default:
      return error.status === 403 ? 'errors.forbidden' : 'errors.generic';
  }
}

/** known password rules → message key (a new rule not yet known = a generic message) */
export const PASSWORD_RULE_KEYS: Record<string, string> = {
  MIN_LENGTH: 'password.rules.minLength',
  MAX_LENGTH: 'password.rules.maxLength',
  DIGITS: 'password.rules.digits',
  LOWER_CASE: 'password.rules.lowerCase',
  UPPER_CASE: 'password.rules.upperCase',
  SPECIAL_CHARS: 'password.rules.specialChars',
  NOT_USERNAME: 'password.rules.notUsername',
  NOT_EMAIL: 'password.rules.notEmail',
  PATTERN: 'password.rules.pattern',
  HISTORY: 'password.rules.history',
  BLACKLISTED: 'password.rules.blacklisted',
};

export const passwordRuleKey = (rule: string) => PASSWORD_RULE_KEYS[rule] ?? 'password.rules.other';

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** open the Console account page for this tenant (same tab within Console, new tab from Workspace) */
export function accountHref(consoleOrigin: string, tenantAlias: string | undefined): string {
  const url = new URL('/', consoleOrigin);
  if (tenantAlias) url.searchParams.set('tenant', tenantAlias);
  url.searchParams.set('view', 'account');
  return url.href;
}
