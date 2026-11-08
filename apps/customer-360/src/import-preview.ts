import { createHash } from 'node:crypto';
import { c360CanonicalJson } from './profile-command.js';
import { c360ProfileFieldRules } from './profile-field-rules.js';
import {
  normalizeC360ImportRow,
  parseC360ImportCsv,
  validateC360ImportMapping,
} from './import-csv.js';
import type { C360CreateProfile } from './profile-write.js';

export class C360ImportPreviewError extends Error {
  constructor(readonly code: 'PREVIEW_STALE' | 'SCOPE_UNAVAILABLE') {
    super(code);
    this.name = 'C360ImportPreviewError';
  }
}

export interface C360ImportPreviewRow {
  rowNo: number;
  /** private data: คืนเฉพาะ owner ที่ตรวจสิทธิ์ใน request ปัจจุบัน ห้ามบันทึกใน audit */
  cells: readonly string[];
  valid: boolean;
  fieldErrors: readonly { field: string; code: string }[];
  warnings: readonly 'READABLE_DUPLICATE'[];
}

/**
 * ป้องกันข้อมูลซ้ำซ่อนเร้น: implementer ต้อง query เฉพาะ Contact ที่ actor ปัจจุบันอ่านได้;
 * หาก scope ไม่พร้อมต้อง throw ไม่คืน false แทนความไม่แน่นอน
 */
export interface C360ImportDuplicateAuthority {
  /** คืนผลตามลำดับ input; implementation ต้องจำกัด query budget และตรวจ scope ปัจจุบัน */
  findReadableDuplicates(profiles: readonly C360CreateProfile[]): Promise<readonly boolean[]>;
}

/** ผลภายใน service เท่านั้น: caller ต้อง authorize owner ก่อนอ่านและก่อนส่งแต่ละหน้า */
export async function prepareC360ImportPreview(input: {
  source: Uint8Array;
  sourceDigest: string;
  mapping: unknown;
  duplicateAuthority: C360ImportDuplicateAuthority;
}): Promise<{
  rulesVersion: string;
  planHash: string;
  headers: readonly string[];
  rows: readonly C360ImportPreviewRow[];
  counts: { valid: number; invalid: number; warning: number };
}> {
  const digest = createHash('sha256').update(input.source).digest('hex');
  if (digest !== input.sourceDigest) throw new C360ImportPreviewError('PREVIEW_STALE');
  const csv = parseC360ImportCsv(input.source);
  const mapping = validateC360ImportMapping(input.mapping, csv.headers);
  const rules = c360ProfileFieldRules();
  const rows: C360ImportPreviewRow[] = [];
  const validProfiles: C360CreateProfile[] = [];
  const validRowIndexes: number[] = [];
  const counts = { valid: 0, invalid: 0, warning: 0 };
  for (const [index, cells] of csv.rows.entries()) {
    const result = normalizeC360ImportRow(csv.headers, cells, mapping);
    if (!result.valid) {
      counts.invalid++;
      rows.push({
        rowNo: index + 1,
        cells,
        valid: false,
        fieldErrors: result.fieldErrors,
        warnings: [],
      });
      continue;
    }
    counts.valid++;
    validProfiles.push(result.profile);
    validRowIndexes.push(rows.length);
    rows.push({
      rowNo: index + 1,
      cells,
      valid: true,
      fieldErrors: [],
      warnings: [],
    });
  }
  {
    let matches: readonly boolean[];
    try {
      matches = await input.duplicateAuthority.findReadableDuplicates(validProfiles);
      if (
        !Array.isArray(matches) ||
        matches.length !== validProfiles.length ||
        matches.some((value) => typeof value !== 'boolean')
      )
        throw new Error('invalid duplicate authority result');
    } catch {
      throw new C360ImportPreviewError('SCOPE_UNAVAILABLE');
    }
    for (const [index, match] of matches.entries()) {
      if (!match) continue;
      counts.warning++;
      const rowIndex = validRowIndexes[index]!;
      rows[rowIndex] = { ...rows[rowIndex]!, warnings: ['READABLE_DUPLICATE'] };
    }
  }
  // ผูก selection และ warnings กับ source/mapping/rules โดยไม่มี raw values ใน plan
  const plan = {
    version: 1,
    sourceDigest: digest,
    mapping,
    rules,
    rows: rows.map(({ rowNo, valid, fieldErrors, warnings }) => ({
      rowNo,
      valid,
      fieldErrors,
      warnings,
    })),
  };
  return {
    rulesVersion: rules.version,
    planHash: createHash('sha256').update(c360CanonicalJson(plan)).digest('hex'),
    headers: csv.headers,
    rows,
    counts,
  };
}
