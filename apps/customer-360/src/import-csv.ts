import { isC360SupportedPhoneCountry } from '@d-contact/contact-points';
import {
  normalizeC360CreateProfile,
  C360WriteValidationError,
  type C360CreateProfile,
} from './profile-write.js';

/** ขอบเขต transport ของ M2 CSV; ไม่มี raw cell ใน error */
export const C360_IMPORT_MAX_BYTES = 5 * 1024 * 1024;
export const C360_IMPORT_MAX_ROWS = 10_000;
export const C360_IMPORT_MAX_COLUMNS = 32;
export const C360_IMPORT_MAX_HEADER = 160;
export const C360_IMPORT_MAX_CELL = 2_048;

export class C360ImportCsvError extends Error {
  constructor(readonly code: 'CSV_INVALID' | 'IMPORT_LIMIT_EXCEEDED') {
    super(code);
    this.name = 'C360ImportCsvError';
  }
}

export interface C360ImportCsv {
  headers: string[];
  /** หนึ่งรายการต่อ CSV record; เลขแถวเริ่ม 1 หลัง header ไม่ใช่เลขบรรทัด */
  rows: string[][];
}

/** Parse RFC-style comma/quote records จาก UTF-8 จริง โดยจำกัดขนาดก่อนส่งต่อ core validator */
export function parseC360ImportCsv(bytes: Uint8Array): C360ImportCsv {
  if (bytes.byteLength > C360_IMPORT_MAX_BYTES)
    throw new C360ImportCsvError('IMPORT_LIMIT_EXCEEDED');
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new C360ImportCsvError('CSV_INVALID');
  }
  if (text.includes('\0')) throw new C360ImportCsvError('CSV_INVALID');

  const records: string[][] = [];
  let row: string[] = [];
  let value = '';
  let state: 'start' | 'plain' | 'quoted' | 'closed' = 'start';
  let afterRecord = false;
  const limit = () => (records.length === 0 ? C360_IMPORT_MAX_HEADER : C360_IMPORT_MAX_CELL);
  const append = (part: string) => {
    value += part;
    if (value.length > limit()) throw new C360ImportCsvError('IMPORT_LIMIT_EXCEEDED');
  };
  const endField = () => {
    row.push(value);
    if (row.length > C360_IMPORT_MAX_COLUMNS) throw new C360ImportCsvError('IMPORT_LIMIT_EXCEEDED');
    value = '';
    state = 'start';
  };
  const endRecord = () => {
    endField();
    if (records.length > 0 && row.length !== records[0]!.length)
      throw new C360ImportCsvError('CSV_INVALID');
    records.push(row);
    if (records.length > C360_IMPORT_MAX_ROWS + 1)
      throw new C360ImportCsvError('IMPORT_LIMIT_EXCEEDED');
    row = [];
    afterRecord = true;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    afterRecord = false;
    if (state === 'quoted') {
      if (char === '"') {
        if (text[i + 1] === '"') {
          append('"');
          i++;
        } else state = 'closed';
      } else if (char === '\r') {
        if (text[i + 1] !== '\n') throw new C360ImportCsvError('CSV_INVALID');
        append('\r\n');
        i++;
      } else append(char);
      continue;
    }
    if (char === ',') {
      endField();
    } else if (char === '\n' || char === '\r') {
      if (char === '\r') {
        if (text[i + 1] !== '\n') throw new C360ImportCsvError('CSV_INVALID');
        i++;
      }
      endRecord();
    } else if (char === '"') {
      if (state !== 'start') throw new C360ImportCsvError('CSV_INVALID');
      state = 'quoted';
    } else {
      if (state === 'closed') throw new C360ImportCsvError('CSV_INVALID');
      state = 'plain';
      append(char);
    }
  }
  if (state === 'quoted') throw new C360ImportCsvError('CSV_INVALID');
  if (!afterRecord && (text.length > 0 || row.length > 0)) endRecord();
  const headers = records.shift();
  if (
    !headers ||
    headers.some((header) => !header.trim()) ||
    new Set(headers).size !== headers.length
  )
    throw new C360ImportCsvError('CSV_INVALID');
  return { headers, rows: records };
}

export type C360ImportField =
  'displayName' | 'company' | 'phone' | 'email' | 'vip' | 'phoneCountry';
export interface C360ImportMapping {
  version: 1;
  columns: { displayName: string } & Partial<
    Record<Exclude<C360ImportField, 'displayName'>, string>
  >;
  defaultPhoneCountry?: string;
}

const IMPORT_FIELDS = ['displayName', 'company', 'phone', 'email', 'vip', 'phoneCountry'] as const;
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Mapping เป็นข้อมูลจาก client ต้อง validate ทั้ง shape, ชื่อ header และประเทศก่อนบันทึก */
export function validateC360ImportMapping(
  value: unknown,
  headers: readonly string[],
): C360ImportMapping {
  if (
    !object(value) ||
    Object.keys(value).some(
      (key) => !['version', 'columns', 'defaultPhoneCountry'].includes(key),
    ) ||
    value.version !== 1 ||
    !object(value.columns) ||
    Object.keys(value.columns).some((key) => !IMPORT_FIELDS.includes(key as C360ImportField)) ||
    typeof value.columns.displayName !== 'string' ||
    Object.values(value.columns).some(
      (header) => typeof header !== 'string' || !header.trim() || !headers.includes(header),
    ) ||
    (value.defaultPhoneCountry !== undefined &&
      !isC360SupportedPhoneCountry(value.defaultPhoneCountry))
  )
    throw new C360ImportMappingError();
  return value as unknown as C360ImportMapping;
}

export class C360ImportMappingError extends Error {
  readonly code = 'MAPPING_INVALID';
  constructor() {
    super('MAPPING_INVALID');
    this.name = 'C360ImportMappingError';
  }
}

/** ผล invalid มีเฉพาะ field/code ไม่มี raw cell หรือข้อความที่มาจาก parser */
export type C360ImportRowValidation =
  | { valid: true; profile: C360CreateProfile }
  | { valid: false; fieldErrors: readonly { field: string; code: string }[] };

/** ใช้ normalizer เดียวกับ C4; ผล profile ถือเป็น private data ห้ามใส่ audit/receipt/log */
export function normalizeC360ImportRow(
  headers: readonly string[],
  cells: readonly string[],
  mapping: C360ImportMapping,
): C360ImportRowValidation {
  if (headers.length !== cells.length) throw new C360ImportCsvError('CSV_INVALID');
  validateC360ImportMapping(mapping, headers);
  const get = (field: C360ImportField): string | undefined => {
    const header = mapping.columns[field];
    return header === undefined ? undefined : cells[headers.indexOf(header)];
  };
  const vip = get('vip')?.trim() ?? '';
  if (vip !== '' && vip !== 'true' && vip !== 'false')
    return { valid: false, fieldErrors: [{ field: 'vip', code: 'FIELD_INVALID' }] };
  const phone = get('phone');
  const email = get('email');
  const country = get('phoneCountry')?.trim() || mapping.defaultPhoneCountry;
  if (country && !isC360SupportedPhoneCountry(country))
    return {
      valid: false,
      fieldErrors: [{ field: 'phoneCountry', code: 'PHONE_COUNTRY_UNSUPPORTED' }],
    };
  const points: Record<string, unknown>[] = [];
  if (phone?.trim())
    points.push({ kind: 'PHONE', value: phone, ...(country ? { explicitCountry: country } : {}) });
  if (email?.trim()) points.push({ kind: 'EMAIL', value: email });
  try {
    return {
      valid: true,
      profile: normalizeC360CreateProfile({
        displayName: get('displayName'),
        company: get('company') ?? null,
        vip: vip === 'true',
        points,
      }),
    };
  } catch (error) {
    if (error instanceof C360WriteValidationError)
      return {
        valid: false,
        fieldErrors: error.fieldErrors.map(({ field, code }) => {
          const match = /^points\.(\d+)$/.exec(field);
          const kind = match ? points[Number(match[1])]?.kind : undefined;
          return { field: kind === 'PHONE' ? 'phone' : kind === 'EMAIL' ? 'email' : field, code };
        }),
      };
    throw error;
  }
}
