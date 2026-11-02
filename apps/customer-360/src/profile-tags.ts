import { caseFold } from 'unicode-case-folding';

/**
 * Cus360 C1 (#791) S5: tag name normalization ตาม E1 A/C
 *
 * nameKey = NFC(fullDefaultCaseFold(NFC(trim(name)))) จาก Unicode C+F mappings ของ
 * unicode-case-folding@1.1.1 (pinned exact) ห้าม Turkic T/NFKC/toLowerCase/locale collator
 * ชื่อแสดง 1–80 UTF-16 ตรวจก่อน fold; key อาจยาวเกิน 80 และห้ามตัด
 */
export const C360_TAG_NORMALIZATION_VERSION = 'c360-tag-v1+unicode-case-folding@1.1.1';
export const C360_TAG_NAME_MAX = 80;

export class C360TagNameError extends Error {
  constructor(readonly code: 'TAG_NAME_INVALID' | 'TAG_NAME_TOO_LONG') {
    super(code);
    this.name = 'C360TagNameError';
  }
}

export interface C360TagName {
  name: string;
  nameKey: string;
}

export function normalizeC360TagName(value: unknown): C360TagName {
  // String.prototype.isWellFormed ยังไม่อยู่ใน lib target ของ repo จึงตรวจ lone surrogate เอง
  if (typeof value !== 'string' || /\p{Cs}/u.test(value) || /[\r\n]/.test(value))
    throw new C360TagNameError('TAG_NAME_INVALID');
  const name = value.trim().normalize('NFC');
  if (name.length === 0) throw new C360TagNameError('TAG_NAME_INVALID');
  if (name.length > C360_TAG_NAME_MAX) throw new C360TagNameError('TAG_NAME_TOO_LONG');
  return { name, nameKey: caseFold(name).normalize('NFC') };
}
