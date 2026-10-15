/**
 * AC5 (#598): ส่วนที่ไม่ผูก React ของหน้า "บัญชีของฉัน" — แยกไว้ให้ unit test ได้
 */
import { AccountApiError } from './api.js';

/** sessionStorage key ที่ถือ token ยืนยัน email ระหว่างรอ login/ยืนยัน (ลบทันทีที่ใช้) */
export const VERIFY_TOKEN_KEY = 'dc.account.verifyToken';

/**
 * ลิงก์ยืนยัน `/?view=account&verify=<token>`: ย้าย token ออกจาก URL ทันที (ก่อน login redirect และก่อน render)
 * ไปไว้ใน sessionStorage ชั่วคราว แล้ว `replaceState` เป็น URL ที่ไม่มี token — token จึงไม่ค้างใน URL, history
 * หรือ return URL ของ login
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
      // storage ใช้ไม่ได้ (private mode) — ผู้ใช้ต้องเปิดลิงก์ใหม่หลัง login; token ก็ยังไม่ค้างใน URL
    }
  }
  return clean;
}

/** อ่านแล้วลบทันที — ใช้ได้ครั้งเดียว */
export function takeVerifyToken(storage: Pick<Storage, 'getItem' | 'removeItem'>): string | null {
  try {
    const token = storage.getItem(VERIFY_TOKEN_KEY);
    storage.removeItem(VERIFY_TOKEN_KEY);
    return token;
  } catch {
    return null;
  }
}

/** error ของ API → key ใน namespace `account` (ไม่แสดง code ดิบหรือชื่อระบบ identity) */
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

/** กฎรหัสผ่านที่รู้จัก → key ของข้อความ (กฎใหม่ที่ยังไม่รู้จัก = ข้อความทั่วไป) */
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

/** เปิดหน้าบัญชีของ Console สำหรับ tenant นี้ (แท็บเดิมใน Console, แท็บใหม่จาก Workspace) */
export function accountHref(consoleOrigin: string, tenantAlias: string | undefined): string {
  const url = new URL('/', consoleOrigin);
  if (tenantAlias) url.searchParams.set('tenant', tenantAlias);
  url.searchParams.set('view', 'account');
  return url.href;
}
