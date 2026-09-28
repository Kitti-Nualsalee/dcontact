/**
 * Owner: UAT control — ตรวจเนื้อหาหลักฐาน UAT แบบ pure (U1.5 #433)
 *
 * Authority: Phase Contract #374, evidence/defect #379
 *
 * - รับเฉพาะภาพหน้าจอ PNG/JPEG ตรวจจาก magic bytes ไม่เชื่อ content type ที่ browser ส่ง; zip (รวม Playwright
 *   `trace.zip`), JSON/HAR, network log และข้อความล้วนถูกปฏิเสธเสมอ
 * - ไฟล์ต้อง parse เป็นโครง PNG/JPEG ได้ครบและไม่มีข้อมูลต่อท้าย (กันไฟล์ polyglot ที่แอบพ่วง trace/zip มา)
 * - negative scan ตรวจ token/JWT, `Authorization`/cookie, รูปแบบ secret, email/เบอร์โทรจริง และ `code=`/`state=`
 *   ของ OIDC; ผลบอกเฉพาะชนิดที่พบ ไม่คืนข้อความที่ match (ไม่ขยายการรั่ว)
 * - ภาพตรวจได้เฉพาะ metadata ที่เป็นข้อความ (PNG tEXt/zTXt/iTXt + ancillary chunk อื่น, JPEG COM/APPn)
 *   ไม่ทำ OCR ของพิกเซล — อยู่นอกขอบเขตของ U1.5; ผู้ทดสอบยังต้องไม่ถ่ายจอที่มี secret/PII
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
 * รูปแบบข้อมูลจริง/secret ที่ต้องไม่อยู่ใน fixture, ผลบันทึก หรือหลักฐานของ UAT
 * ใช้ร่วมกันทั้งตอน provision fixture pack (U1.1) และ negative scan ของ run (U1.5)
 */
export const UAT_SENSITIVE_PATTERNS: ReadonlyArray<readonly [UatSensitiveKind, RegExp]> = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['BEARER', /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  // เบอร์ไทย และเบอร์สากลรูป E.164
  ['PHONE', /(?<![0-9A-Za-z-])(?:(?:\+66|0)[1-9][0-9]{7,8}|\+[1-9][0-9]{7,14})(?![0-9])/],
  ['AUTHORIZATION_HEADER', /\b(?:proxy-)?authorization\s*["']?\s*[:=]\s*["']?[A-Za-z0-9]/i],
  ['COOKIE', /\b(?:set-)?cookie\s*["']?\s*[:=]\s*["']?[^\s;=]+=/i],
  [
    'SECRET',
    new RegExp(
      [
        // key=value / key: value ของ credential ทั่วไป
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

/** ชนิดของข้อมูลต้องห้ามที่พบในข้อความ — เรียงตาม `UAT_SENSITIVE_KINDS` และไม่ซ้ำ */
export function scanUatText(value: string): UatSensitiveKind[] {
  // metadata บางชนิด (เช่น UTF-16 ของ EXIF) มี NUL คั่นทุกตัวอักษร — ตรวจทั้งแบบเดิมและแบบตัด NUL
  const variants = value.includes('\u0000') ? [value, value.replace(/\u0000/g, '')] : [value];
  return UAT_SENSITIVE_PATTERNS.filter(([, pattern]) =>
    variants.some((variant) => pattern.test(variant)),
  ).map(([kind]) => kind);
}

// ── ชนิดไฟล์ ──────────────────────────────────────────────────────────────

export const UAT_EVIDENCE_CONTENT_TYPES = ['image/png', 'image/jpeg'] as const;
export type UatEvidenceContentType = (typeof UAT_EVIDENCE_CONTENT_TYPES)[number];
/** เพดานขนาดภาพหน้าจอหนึ่งไฟล์ */
export const UAT_EVIDENCE_MAX_BYTES = 5 * 1024 * 1024;

export type UatEvidenceSniff = 'PNG' | 'JPEG' | 'ZIP' | 'GZIP' | 'JSON' | 'TEXT' | 'UNKNOWN';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return prefix.length <= bytes.length && prefix.every((byte, index) => bytes[index] === byte);
}

/** ชนิดจาก magic bytes — ใช้บอกเหตุผลที่ปฏิเสธโดยไม่สะท้อนเนื้อหาไฟล์กลับไป */
export function sniffUatEvidence(bytes: Uint8Array): UatEvidenceSniff {
  if (startsWith(bytes, PNG_SIGNATURE)) return 'PNG';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'JPEG';
  // PK\x03\x04 / PK\x05\x06 (zip เปล่า) / PK\x07\x08 — ครอบ Playwright trace.zip
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

// ── metadata ที่เป็นข้อความในภาพ ─────────────────────────────────────────────

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

/** เพดานข้อความที่คลายจาก zTXt/iTXt — กัน zip bomb ใน metadata */
const MAX_INFLATED_TEXT = 1024 * 1024;

function malformed(): never {
  throw new UatEvidenceFormatError('MALFORMED');
}

function inflateText(data: Uint8Array): string {
  try {
    return inflateSync(data, { maxOutputLength: MAX_INFLATED_TEXT }).toString('utf8');
  } catch {
    // คลายไม่ได้ (หรือใหญ่เกินเพดาน) = metadata ผิดรูป — ไม่ปล่อยให้หลุด scan
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
      // ancillary chunk อื่น (eXIf, private chunk ฯลฯ) — ตรวจเป็นข้อความดิบ
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
    // fill byte 0xFF ซ้ำได้ก่อน marker
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
      // entropy-coded data: วิ่งจนเจอ marker จริง (0xFF ที่ไม่ใช่ byte stuffing 0x00 หรือ RSTn)
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

/** ข้อความใน metadata ของภาพ — ภาพที่ parse ไม่ผ่านหรือมีข้อมูลต่อท้ายโยน `UatEvidenceFormatError` */
export function extractUatImageText(
  bytes: Uint8Array,
  contentType: UatEvidenceContentType,
): UatImageText[] {
  return contentType === 'image/png' ? parsePng(bytes) : parseJpeg(bytes);
}
