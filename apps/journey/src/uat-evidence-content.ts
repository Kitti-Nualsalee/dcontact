/**
 * Owner: UAT control — pure checking of UAT evidence content (U1.5 #433)
 *
 * Authority: Phase Contract #374, evidence/defect #379
 *
 * - accepts only PNG/JPEG screenshots checked from the magic bytes, not trusting the content type the browser sends; zip (including Playwright
 *   `trace.zip`), JSON/HAR, network logs and plain text are always rejected
 * - a file must parse completely as a PNG/JPEG structure with no trailing data (guards against a polyglot file that smuggles in a trace/zip)
 * - the negative scan checks token/JWT, `Authorization`/cookie, secret shapes, real email/phone numbers and the OIDC `code=`/`state=`;
 *   the result states only the kinds found and does not return the matched text (so the leak is not widened)
 * - an image can be checked only through its textual metadata (PNG tEXt/zTXt/iTXt + other ancillary chunks, JPEG COM/APPn)
 *   with no OCR of pixels — outside the scope of U1.5; testers must still not capture a screen containing a secret/PII
 */
import { inflateSync } from 'node:zlib';

// ── Negative scan ─────────────────────────────────────────────────────────

export const UAT_SENSITIVE_KINDS = [
  'EMAIL',
  'JWT',
  'BEARER',
  'PHONE',
  'AUTHORIZATION_HEADER',
  'COOKIE',
  'SECRET',
  'OIDC_CODE',
  'OIDC_STATE',
] as const;
export type UatSensitiveKind = (typeof UAT_SENSITIVE_KINDS)[number];

/**
 * real data/secret shapes that must not be in a fixture, a recorded result or UAT evidence
 * shared by both the fixture pack provision (U1.1) and the negative scan of a run (U1.5)
 */
export const UAT_SENSITIVE_PATTERNS: ReadonlyArray<readonly [UatSensitiveKind, RegExp]> = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['BEARER', /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  // Thai numbers and international numbers in E.164 form — both edges must not be a digit/ASCII letter, otherwise hex such as a git SHA
  // (`0812345678ab…`) would be caught as a number (U1.11 #512); a number followed by Thai text/whitespace is still caught
  ['PHONE', /(?<![0-9A-Za-z-])(?:(?:\+66|0)[1-9][0-9]{7,8}|\+[1-9][0-9]{7,14})(?![0-9A-Za-z])/],
  ['AUTHORIZATION_HEADER', /\b(?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?[A-Za-z0-9]/i],
  ['COOKIE', /\b(?:set-)?cookie\s*["']?\s*[:=]\s*["']?[^\s;=]+=/i],
  [
    'SECRET',
    new RegExp(
      [
        // key=value / key: value of a common credential
        String.raw`\b(?:client[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|private[_-]?key|password|passwd|secret)\s*["']?\s*[:=]\s*["']?[^\s"'&,;]{6,}`,
        String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----`,
        String.raw`\bAKIA[0-9A-Z]{16}\b`,
        String.raw`\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}`,
        String.raw`\bgh[pousr]_[A-Za-z0-9]{30,}`,
        String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`,
      ].join('|'),
      'i',
    ),
  ],
  ['OIDC_CODE', /[?&#]code=[^&#\s]+/i],
  ['OIDC_STATE', /[?&#]state=[^&#\s]+/i],
];

/** the kinds of forbidden data found in the text — sorted per `UAT_SENSITIVE_KINDS` and without duplicates */
export function scanUatText(value: string): UatSensitiveKind[] {
  // some metadata (e.g. EXIF UTF-16) has a NUL between every character — check both the original and the NUL-stripped form
  const variants = value.includes('\u0000') ? [value, value.replace(/\u0000/g, '')] : [value];
  return UAT_SENSITIVE_PATTERNS.filter(([, pattern]) =>
    variants.some((variant) => pattern.test(variant)),
  ).map(([kind]) => kind);
}

// ── file kinds ────────────────────────────────────────────────────────────

export const UAT_EVIDENCE_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const;
export type UatEvidenceContentType = (typeof UAT_EVIDENCE_CONTENT_TYPES)[number];
/** size ceiling of a single screenshot file */
export const UAT_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

export type UatEvidenceSniff = 'PNG' | 'JPEG' | 'ZIP' | 'GZIP' | 'JSON' | 'TEXT' | 'UNKNOWN';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

/** the kind from magic bytes — used to state the reason for rejecting without reflecting the file content back */
export function sniffUatEvidence(bytes: Uint8Array): UatEvidenceSniff {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'PNG';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'JPEG';
  // PK\x03\x04 / PK\x05\x06 (an empty zip) / PK\x07\x08 — covers the Playwright trace.zip
  if (startsWith(bytes, [0x50, 0x4b]) && [3, 5, 7].includes(bytes[2] ?? 0)) return 'ZIP';
  if (startsWith(bytes, [0x1f, 0x8b])) return 'GZIP';
  const head = Buffer.from(bytes.subarray(0, 512)).toString('utf8').replace(/^﻿/, '').trimStart();
  if (head.startsWith('{') || head.startsWith('[')) return 'JSON';
  const sample = bytes.subarray(0, 512);
  if (
    sample.length > 0 &&
    sample.every((byte) => byte === 9 || byte === 10 || byte === 13 || byte >= 32)
  ) {
    return 'TEXT';
  }
  return 'UNKNOWN';
}

// ── textual metadata in an image ─────────────────────────────────────────────

export type UatImageTextField = 'PNG_TEXT' | 'PNG_ANCILLARY' | 'JPEG_COM' | 'JPEG_APP';

export interface UatImageText {
  readonly field: UatImageTextField;
  readonly text: string;
}

export class UatEvidenceFormatError extends Error {
  constructor(readonly reason: 'MALFORMED' | 'TRAILING_DATA') {
    super(`uat evidence: ${reason}`);
    this.name = 'UatEvidenceFormatError';
  }
}

/** ceiling on text decompressed from zTXt/iTXt — guards against a zip bomb in metadata */
const MAX_INFLATED_TEXT = 1024 * 1024;

function malformed(): never {
  throw new UatEvidenceFormatError('MALFORMED');
}

function inflateText(data: Uint8Array): string {
  try {
    return inflateSync(data, { maxOutputLength: MAX_INFLATED_TEXT }).toString('utf8');
  } catch {
    // cannot decompress (or exceeds the ceiling) = malformed metadata — must not slip past the scan
    return malformed();
  }
}

function latin1(data: Uint8Array): string {
  return Buffer.from(data).toString('latin1');
}

function parsePng(bytes: Uint8Array): UatImageText[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const texts: UatImageText[] = [];
  let offset = PNG_SIGNATURE.length;
  let first = true;
  for (;;) {
    if (offset + 12 > view.length) malformed();
    const length = view.readUInt32BE(offset);
    const type = view.toString('latin1', offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (!/^[A-Za-z]{4}$/.test(type) || end + 4 > view.length) malformed();
    if (first && type !== 'IHDR') malformed();
    first = false;
    const data = view.subarray(start, end);
    offset = end + 4;
    if (type === 'IEND') break;
    if (type === 'tEXt') {
      texts.push({ field: 'PNG_TEXT', text: latin1(data).replace('\u0000', ' ') });
    } else if (type === 'zTXt') {
      const separator = data.indexOf(0);
      if (separator < 0 || separator + 2 > data.length) malformed();
      texts.push({ field: 'PNG_TEXT', text: latin1(data.subarray(0, separator)) });
      texts.push({ field: 'PNG_TEXT', text: inflateText(data.subarray(separator + 2)) });
    } else if (type === 'iTXt') {
      const keywordEnd = data.indexOf(0);
      if (keywordEnd < 0 || keywordEnd + 3 > data.length) malformed();
      const compressed = data[keywordEnd + 1] === 1;
      const languageEnd = data.indexOf(0, keywordEnd + 3);
      const translatedEnd = languageEnd < 0 ? -1 : data.indexOf(0, languageEnd + 1);
      if (translatedEnd < 0) malformed();
      const header = Buffer.from(data.subarray(0, translatedEnd)).toString('utf8');
      const body = data.subarray(translatedEnd + 1);
      texts.push({ field: 'PNG_TEXT', text: header });
      texts.push({
        field: 'PNG_TEXT',
        text: compressed ? inflateText(body) : Buffer.from(body).toString('utf8'),
      });
    } else if (!['IHDR', 'PLTE', 'IDAT'].includes(type)) {
      // other ancillary chunks (eXIf, private chunks, etc.) — checked as raw text
      texts.push({ field: 'PNG_ANCILLARY', text: latin1(data) });
    }
  }
  if (offset !== view.length) throw new UatEvidenceFormatError('TRAILING_DATA');
  return texts;
}

function parseJpeg(bytes: Uint8Array): UatImageText[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const texts: UatImageText[] = [];
  if (view[0] !== 0xff || view[1] !== 0xd8) malformed();
  let offset = 2;
  for (;;) {
    if (offset + 2 > view.length || view[offset] !== 0xff) malformed();
    // the fill byte 0xFF may repeat before a marker
    while (view[offset + 1] === 0xff) offset += 1;
    if (offset + 2 > view.length) malformed();
    const marker = view[offset + 1]!;
    offset += 2;
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0x00 || marker === 0xd8) malformed();
    if (offset + 2 > view.length) malformed();
    const length = view.readUInt16BE(offset);
    if (length < 2 || offset + length > view.length) malformed();
    const data = view.subarray(offset + 2, offset + length);
    offset += length;
    if (marker === 0xfe) texts.push({ field: 'JPEG_COM', text: latin1(data) });
    else if (marker >= 0xe0 && marker <= 0xef)
      texts.push({ field: 'JPEG_APP', text: latin1(data) });
    if (marker === 0xda) {
      // entropy-coded data: run until a real marker (0xFF that is not byte stuffing 0x00 or RSTn)
      for (;;) {
        if (offset + 1 >= view.length) malformed();
        if (view[offset] === 0xff) {
          const next = view[offset + 1]!;
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        offset += 1;
      }
    }
  }
  if (offset !== view.length) throw new UatEvidenceFormatError('TRAILING_DATA');
  return texts;
}

/** text in an image's metadata — an image that fails to parse or has trailing data throws `UatEvidenceFormatError` */
export function extractUatImageText(
  bytes: Uint8Array,
  contentType: UatEvidenceContentType,
): UatImageText[] {
  return contentType === 'image/png' ? parsePng(bytes) : parseJpeg(bytes);
}
