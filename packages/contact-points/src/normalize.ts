import emailAddresses from 'email-addresses';
import { isSupportedCountry, parsePhoneNumber, type CountryCode } from 'libphonenumber-js/max';
import tr46 from 'tr46';
import { caseFold } from 'unicode-case-folding';

/**
 * Cus360 C3 (#793) S1: parser และ normalization contract v1 ตาม E1 C
 *
 * กฎเดียวที่ API/operator/UI ใช้ร่วมกัน รุ่นของ dependency ถูก pin แบบ exact ใน package.json และ lockfile;
 * การ upgrade ต้องเปลี่ยน normalization version พร้อม collision review ไม่เปลี่ยน key เงียบ ๆ
 * ไม่มี network call: parser ทำงานบน metadata ที่ติดมากับ package เท่านั้น
 */
export const C360_PHONE_NORMALIZATION_VERSION = 'c360-phone-v1+libphonenumber-js@1.13.15/max';
export const C360_EMAIL_NORMALIZATION_VERSION = 'c360-email-v1+email-addresses@5.0.0+tr46@5.1.1';
export const C360_TAG_NORMALIZATION_VERSION = 'c360-tag-v1+unicode-case-folding@1.1.1';

export const C360_PHONE_RAW_MAX = 64;
export const C360_EMAIL_RAW_MAX = 512;
export const C360_TAG_NAME_MAX = 80;

export type C360ContactPointErrorCode =
  | 'PHONE_INVALID'
  | 'PHONE_TOO_LONG'
  | 'PHONE_COUNTRY_REQUIRED'
  | 'PHONE_COUNTRY_UNSUPPORTED'
  | 'PHONE_EXTENSION_UNSUPPORTED'
  | 'EMAIL_INVALID'
  | 'EMAIL_TOO_LONG'
  | 'EMAIL_DOMAIN_INVALID';

export class C360ContactPointError extends Error {
  constructor(readonly code: C360ContactPointErrorCode) {
    super(code);
    this.name = 'C360ContactPointError';
  }
}

export interface C360NormalizedContactPoint {
  kind: 'PHONE' | 'EMAIL';
  /** ค่าที่ผู้ใช้กรอกตามจริง เก็บเป็น provenance ไม่ใช้จับคู่ */
  rawValue: string;
  normalizedValue: string;
  normalizationVersion: string;
  /** ประเทศที่ผู้ใช้เลือกเองเท่านั้น; null เมื่อกรอกแบบ international */
  explicitCountry: string | null;
}

/** lone surrogate ทำให้ข้อความไม่ well-formed (String.prototype.isWellFormed ยังไม่อยู่ใน lib target) */
function wellFormed(value: string): boolean {
  return !/\p{Cs}/u.test(value);
}

/** ใช้ metadata รุ่นเดียวกับ C4 เพื่อตรวจประเทศที่ผู้ใช้ระบุ ไม่อนุมานจาก locale */
export function isC360SupportedPhoneCountry(value: unknown): value is CountryCode {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) && isSupportedCountry(value);
}

/** E1 C PHONE: whole-input, international หรือประเทศที่เลือกชัดเจน, ห้ามตัดส่วนใดทิ้ง */
export function normalizeC360Phone(
  value: unknown,
  explicitCountry: unknown = null,
): C360NormalizedContactPoint {
  if (typeof value !== 'string') throw new C360ContactPointError('PHONE_INVALID');
  if (value.length > C360_PHONE_RAW_MAX) throw new C360ContactPointError('PHONE_TOO_LONG');
  if (!wellFormed(value) || /[\r\n]/.test(value)) throw new C360ContactPointError('PHONE_INVALID');
  // tel: URI และ parameter (;ext=, ;phone-context=) ถูกปฏิเสธก่อน parse ไม่ให้ parser ตีความแทน
  if (/[:;]/.test(value)) throw new C360ContactPointError('PHONE_INVALID');
  let country: CountryCode | undefined;
  if (explicitCountry !== null && explicitCountry !== undefined) {
    if (!isC360SupportedPhoneCountry(explicitCountry))
      throw new C360ContactPointError('PHONE_COUNTRY_UNSUPPORTED');
    country = explicitCountry;
  }
  const input = value.trim();
  let parsed;
  try {
    parsed = parsePhoneNumber(input, {
      ...(country ? { defaultCountry: country } : {}),
      extract: false,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    // ไม่มี + และไม่มีประเทศที่ผู้ใช้เลือก: ห้ามเดาจาก locale/timezone/IP
    if (reason === 'INVALID_COUNTRY' && !country)
      throw new C360ContactPointError('PHONE_COUNTRY_REQUIRED');
    throw new C360ContactPointError('PHONE_INVALID');
  }
  // มี extension (ext./x/#/pause) ให้แจ้ง unsupported ไม่เก็บเบอร์หลักที่ตัดส่วนออก
  if (parsed.ext) throw new C360ContactPointError('PHONE_EXTENSION_UNSUPPORTED');
  if (!parsed.isValid()) throw new C360ContactPointError('PHONE_INVALID');
  return {
    kind: 'PHONE',
    rawValue: value,
    normalizedValue: parsed.number,
    normalizationVersion: C360_PHONE_NORMALIZATION_VERSION,
    // provenance: เก็บประเทศเฉพาะเมื่อใช้ parse จริง (input แบบ international ไม่ใช้ประเทศที่เลือก)
    explicitCountry: country && !input.startsWith('+') ? country : null,
  };
}

const IDNA_DOTS = /[。．｡]/;

function validDomain(domain: string): boolean {
  if (domain.startsWith('[') || IDNA_DOTS.test(domain)) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return false;
  // validation เท่านั้น: ผล A-label ถูกทิ้ง ไม่ใช่ค่าที่เก็บ
  const ascii = tr46.toASCII(domain, {
    checkHyphens: true,
    checkBidi: true,
    checkJoiners: true,
    useSTD3ASCIIRules: true,
    verifyDNSLength: true,
    transitionalProcessing: false,
    ignoreInvalidPunycode: false,
  });
  if (ascii === null) return false;
  // IP domain ในรูป dot-atom และ TLD ตัวเลขล้วนไม่ใช่ DNS name ตาม E1 C; ตรวจหลัง IDNA mapping
  // เพื่อให้ตัวเลข full-width (เช่น １.２.３.４) ที่ถูก map เป็น ASCII ไม่หลุด
  return !/^[0-9]+$/.test(ascii.slice(ascii.lastIndexOf('.') + 1));
}

/** E1 C EMAIL: addr-spec เดี่ยว, คง local tokens ตรงเดิม, lowercase เฉพาะ domain */
export function normalizeC360Email(value: unknown): C360NormalizedContactPoint {
  if (typeof value !== 'string') throw new C360ContactPointError('EMAIL_INVALID');
  if (value.length > C360_EMAIL_RAW_MAX) throw new C360ContactPointError('EMAIL_TOO_LONG');
  if (!wellFormed(value) || /[\r\n]/.test(value)) throw new C360ContactPointError('EMAIL_INVALID');
  const input = value.trim();
  const result = emailAddresses({
    input,
    startAt: 'mailbox',
    strict: true,
    rfc6532: true,
    simple: false,
    partial: false,
    rejectTLD: false,
  });
  const mailbox = result?.addresses.length === 1 ? result.addresses[0] : undefined;
  if (!mailbox || mailbox.type !== 'mailbox') throw new C360ContactPointError('EMAIL_INVALID');
  const { name, local, domain, address, comments } = mailbox.parts;
  // display-name/angle wrapper/comment/CFWS ถูกปฏิเสธ; ช่องว่างภายใน quoted local-string ไม่ใช่ CFWS
  if (name !== null || comments.length > 0) throw new C360ContactPointError('EMAIL_INVALID');
  const rebuilt = `${local.tokens}@${domain.tokens}`;
  if (rebuilt !== input || address.tokens !== input)
    throw new C360ContactPointError('EMAIL_INVALID');
  if (!validDomain(domain.tokens)) throw new C360ContactPointError('EMAIL_DOMAIN_INVALID');
  return {
    kind: 'EMAIL',
    rawValue: value,
    // ไม่ punycode/NFC/NFKC/alias-fold/unquote: local ตาม tokens ดิบ, domain lowercase เท่านั้น
    normalizedValue: `${local.tokens}@${domain.tokens.toLowerCase()}`,
    normalizationVersion: C360_EMAIL_NORMALIZATION_VERSION,
    explicitCountry: null,
  };
}

export class C360TagNameError extends Error {
  constructor(readonly code: 'TAG_NAME_INVALID' | 'TAG_NAME_TOO_LONG') {
    super(code);
    this.name = 'C360TagNameError';
  }
}

/**
 * nameKey = NFC(fullDefaultCaseFold(NFC(trim(name)))) จาก Unicode C+F mappings
 * ห้าม Turkic T/NFKC/toLowerCase/locale collator; ชื่อแสดง 1–80 UTF-16 ตรวจก่อน fold, key ห้ามตัด
 */
export function normalizeC360TagName(value: unknown): { name: string; nameKey: string } {
  if (
    typeof value !== 'string' ||
    !wellFormed(value) ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
  )
    throw new C360TagNameError('TAG_NAME_INVALID');
  const name = value.trim().normalize('NFC');
  if (name.length === 0) throw new C360TagNameError('TAG_NAME_INVALID');
  if (name.length > C360_TAG_NAME_MAX) throw new C360TagNameError('TAG_NAME_TOO_LONG');
  return { name, nameKey: caseFold(name).normalize('NFC') };
}
