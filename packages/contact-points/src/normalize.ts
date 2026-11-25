import emailAddresses from 'email-addresses';
import { isSupportedCountry, parsePhoneNumber, type CountryCode } from 'libphonenumber-js/max';
import tr46 from 'tr46';
import { caseFold } from 'unicode-case-folding';

/**
 * Cus360 C3 (#793) S1: parser and normalization contract v1 per E1 C
 *
 * the single rule set shared by the API/operator/UI; dependency versions are pinned exactly in package.json and the lockfile;
 * an upgrade must change the normalization version together with a collision review and never change keys silently
 * no network call: the parser works only on the metadata shipped with the package
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
  /** The value the user actually entered; kept as provenance and not used for matching */
  rawValue: string;
  normalizedValue: string;
  normalizationVersion: string;
  /** Only a country the user chose; null when entered in international form */
  explicitCountry: string | null;
}

/** a lone surrogate makes the text not well-formed (String.prototype.isWellFormed is not yet in the lib target) */
function wellFormed(value: string): boolean {
  return !/\p{Cs}/u.test(value);
}

/** Uses the same metadata version as C4 to check the user-specified country; never infers it from the locale */
export function isC360SupportedPhoneCountry(value: unknown): value is CountryCode {
  return typeof value === 'string' && /^[A-Z]{2}$/.test(value) && isSupportedCountry(value);
}

/** E1 C PHONE: whole-input, international or an explicitly chosen country; no part may be dropped */
export function normalizeC360Phone(
  value: unknown,
  explicitCountry: unknown = null,
): C360NormalizedContactPoint {
  if (typeof value !== 'string') throw new C360ContactPointError('PHONE_INVALID');
  if (value.length > C360_PHONE_RAW_MAX) throw new C360ContactPointError('PHONE_TOO_LONG');
  if (!wellFormed(value) || /[\r\n]/.test(value)) throw new C360ContactPointError('PHONE_INVALID');
  // a tel: URI and parameters (;ext=, ;phone-context=) are rejected before parsing so the parser does not interpret them
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
    // no + and no user-selected country: never guess from locale/timezone/IP
    if (reason === 'INVALID_COUNTRY' && !country)
      throw new C360ContactPointError('PHONE_COUNTRY_REQUIRED');
    throw new C360ContactPointError('PHONE_INVALID');
  }
  // with an extension (ext./x/#/pause) report unsupported and do not store the main number with the part cut off
  if (parsed.ext) throw new C360ContactPointError('PHONE_EXTENSION_UNSUPPORTED');
  if (!parsed.isValid()) throw new C360ContactPointError('PHONE_INVALID');
  return {
    kind: 'PHONE',
    rawValue: value,
    normalizedValue: parsed.number,
    normalizationVersion: C360_PHONE_NORMALIZATION_VERSION,
    // provenance: keep the country only when it was actually used to parse (an international input ignores the selected country)
    explicitCountry: country && !input.startsWith('+') ? country : null,
  };
}

const IDNA_DOTS = /[。．｡]/;

function validDomain(domain: string): boolean {
  if (domain.startsWith('[') || IDNA_DOTS.test(domain)) return false;
  const labels = domain.split('.');
  if (labels.length < 2 || labels.some((label) => label.length === 0)) return false;
  // validation only: the A-label result is discarded and is not the stored value
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
  // an IP domain in dot-atom form and an all-numeric TLD are not a DNS name per E1 C; checked after IDNA mapping
  // so full-width digits (e.g. １.２.３.４) that get mapped to ASCII do not slip through
  return !/^[0-9]+$/.test(ascii.slice(ascii.lastIndexOf('.') + 1));
}

/** E1 C EMAIL: a single addr-spec, local tokens kept as is, lowercase only the domain */
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
  // display-name/angle wrapper/comment/CFWS are rejected; whitespace inside a quoted local-string is not CFWS
  if (name !== null || comments.length > 0) throw new C360ContactPointError('EMAIL_INVALID');
  const rebuilt = `${local.tokens}@${domain.tokens}`;
  if (rebuilt !== input || address.tokens !== input)
    throw new C360ContactPointError('EMAIL_INVALID');
  if (!validDomain(domain.tokens)) throw new C360ContactPointError('EMAIL_DOMAIN_INVALID');
  return {
    kind: 'EMAIL',
    rawValue: value,
    // no punycode/NFC/NFKC/alias-fold/unquote: local follows the raw tokens, only the domain is lowercased
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
 * nameKey = NFC(fullDefaultCaseFold(NFC(trim(name)))) from Unicode C+F mappings
 * no Turkic T/NFKC/toLowerCase/locale collator; display name of 1–80 UTF-16 is checked before fold, the key must not be truncated
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
