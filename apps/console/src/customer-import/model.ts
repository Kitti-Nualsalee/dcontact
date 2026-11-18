/** กติกาฝั่ง client ของการนำเข้า CSV (#909); server ตรวจซ้ำทุกข้อและเป็นผู้ตัดสินสุดท้าย */

export const IMPORT_MAX_BYTES = 1024 * 1024;
export const IMPORT_MAX_ROWS = 1000;

export type ImportField = 'displayName' | 'company' | 'phone' | 'email' | 'vip';
export const IMPORT_FIELDS: readonly ImportField[] = [
  'displayName',
  'company',
  'phone',
  'email',
  'vip',
];
export type ImportSelection = Partial<Record<ImportField, string>>;

export interface ImportMapping {
  version: 1;
  columns: { displayName: string } & Partial<Record<Exclude<ImportField, 'displayName'>, string>>;
  defaultPhoneCountry?: string;
}

/** ประเทศที่ใช้ตีความเบอร์ที่ไม่มี + นำหน้า; ว่าง = ต้องเป็นเบอร์สากลเท่านั้น (ไม่เดาจาก locale) */
export const PHONE_COUNTRIES = ['TH', 'US', 'GB', 'SG', 'JP', 'CN', 'MY', 'VN', 'ID'] as const;

/** อ่านเฉพาะ header (record แรก) แบบ strict UTF-8; null = ไฟล์อ่านไม่ได้เป็น CSV */
export function readCsvHeaders(bytes: Uint8Array): string[] | null {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.includes('\0')) return null;
  const headers: string[] = [];
  let value = '';
  let quoted = false;
  let closed = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          value += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else value += char;
      continue;
    }
    if (char === ',') {
      headers.push(value);
      value = '';
      closed = false;
      started = false;
    } else if (char === '\n' || char === '\r') {
      break;
    } else if (char === '"') {
      if (started || closed) return null;
      quoted = true;
      started = true;
    } else {
      if (closed) return null;
      started = true;
      value += char;
    }
  }
  if (quoted) return null;
  headers.push(value);
  if (headers.some((header) => !header.trim()) || new Set(headers).size !== headers.length)
    return null;
  return headers;
}

const GUESSES: Record<ImportField, RegExp> = {
  displayName: /^(display[\s_-]?name|full[\s_-]?name|name|ชื่อ(ลูกค้า)?|ชื่อ-?สกุล)$/i,
  company: /^(company|organi[sz]ation|บริษัท|องค์กร)$/i,
  phone: /^(phone|mobile|tel(ephone)?|เบอร์(โทร)?|โทรศัพท์|มือถือ)$/i,
  email: /^(e-?mail|อีเมล)$/i,
  vip: /^(vip)$/i,
};

/** เดาจากชื่อ header เพื่อลดงานผู้ใช้; ผู้ใช้แก้ได้ก่อนส่งทุกครั้ง */
export function suggestSelection(headers: readonly string[]): ImportSelection {
  const used = new Set<string>();
  const selection: ImportSelection = {};
  for (const field of IMPORT_FIELDS) {
    const match = headers.find((header) => !used.has(header) && GUESSES[field].test(header.trim()));
    if (match) {
      selection[field] = match;
      used.add(match);
    }
  }
  return selection;
}

/** คืน null เมื่อยังส่งไม่ได้ (ไม่มีคอลัมน์ชื่อ หรือ header ที่เลือกไม่อยู่ในไฟล์/ถูกใช้ซ้ำ) */
export function buildMapping(
  selection: ImportSelection,
  headers: readonly string[],
  country: string,
): ImportMapping | null {
  const chosen = IMPORT_FIELDS.flatMap((field) => {
    const header = selection[field];
    return header === undefined ? [] : [[field, header] as const];
  });
  if (
    !selection.displayName ||
    chosen.some(([, header]) => !headers.includes(header)) ||
    new Set(chosen.map(([, header]) => header)).size !== chosen.length ||
    (country !== '' && !(PHONE_COUNTRIES as readonly string[]).includes(country))
  )
    return null;
  return {
    version: 1,
    columns: Object.fromEntries(chosen) as ImportMapping['columns'],
    ...(country ? { defaultPhoneCountry: country } : {}),
  };
}

export type FileCheck = 'OK' | 'EMPTY' | 'TOO_LARGE' | 'NOT_CSV';
export function checkImportFile(size: number, headers: string[] | null): FileCheck {
  if (size === 0) return 'EMPTY';
  if (size > IMPORT_MAX_BYTES) return 'TOO_LARGE';
  return headers ? 'OK' : 'NOT_CSV';
}

export interface PreviewRowView {
  rowNo: number;
  cells: readonly string[];
  valid: boolean;
  fieldErrors: readonly { field: string; code: string }[];
  warnings: readonly string[];
}
export type RowFilter = 'ALL' | 'INVALID' | 'WARNING';
export function filterPreviewRows(
  rows: readonly PreviewRowView[],
  filter: RowFilter,
): PreviewRowView[] {
  return rows.filter((row) =>
    filter === 'INVALID' ? !row.valid : filter === 'WARNING' ? row.warnings.length > 0 : true,
  );
}

export type ConfirmState = 'COMPLETED' | 'INCOMPLETE';
export interface ConfirmCounts {
  applied: number;
  rejected: number;
  notSelected: number;
  pending: number;
  unknown: number;
  notAttempted: number;
}
/** ส่งซ้ำด้วย commandId เดิมได้เฉพาะเมื่อยังมีแถวที่ไม่ทราบผลหรือยังไม่เริ่ม; ไม่มี = จบแล้ว */
export function canResume(counts: ConfirmCounts): boolean {
  return counts.pending + counts.unknown + counts.notAttempted > 0;
}
