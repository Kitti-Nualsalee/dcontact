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
  /** private data: return only to the owner whose permission was verified in the current request; never record in audit */
  cells: readonly string[];
  valid: boolean;
  fieldErrors: readonly { field: string; code: string }[];
  warnings: readonly 'READABLE_DUPLICATE'[];
}

/**
 * Hidden-duplicate protection: the implementer must query only Contacts the current actor can read;
 * if scope is unavailable it must throw rather than return false to stand in for uncertainty
 */
export interface C360ImportDuplicateAuthority {
  /** Returns results in input order; the implementation must limit its query budget and check the current scope */
  findReadableDuplicates(profiles: readonly C360CreateProfile[]): Promise<readonly boolean[]>;
}

/** Service-internal result only: the caller must authorize the owner before reading and before sending each page */
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
  // Bind the selection to source/mapping/rules without raw values in the plan
  // Warnings are advisory only and stay out of the plan: otherwise re-sending confirm after creation
  // would see the just-created customer as a duplicate and the plan would change (replay with the same commandId would fail)
  const plan = {
    version: 1,
    sourceDigest: digest,
    mapping,
    rules,
    rows: rows.map(({ rowNo, valid, fieldErrors }) => ({ rowNo, valid, fieldErrors })),
  };
  return {
    rulesVersion: rules.version,
    planHash: createHash('sha256').update(c360CanonicalJson(plan)).digest('hex'),
    headers: csv.headers,
    rows,
    counts,
  };
}
