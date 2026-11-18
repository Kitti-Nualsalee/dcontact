import { CustomersApiError } from '../customers/api.js';
import type { ConfirmCounts, ConfirmState, ImportMapping, PreviewRowView } from './model.js';

export interface ImportPreview {
  rulesVersion: string;
  planHash: string;
  headers: string[];
  counts: { valid: number; invalid: number; warning: number };
  rows: PreviewRowView[];
}
export type ImportRowState =
  'APPLIED' | 'REJECTED' | 'PENDING' | 'UNKNOWN' | 'NOT_SELECTED' | 'NOT_ATTEMPTED';
export interface ImportRowResult {
  rowNo: number;
  state: ImportRowState;
  code?: string;
  contactId?: string;
  fieldErrors?: { field: string; code: string }[];
}
export interface ImportResult {
  state: ConfirmState;
  planHash: string;
  counts: ConfirmCounts;
  rows: ImportRowResult[];
}

/** ไฟล์และผลอยู่ในหน่วยความจำของหน้าเท่านั้น; client นี้ไม่เก็บอะไรลง storage หรือ URL */
export function createCustomerImportApi(options: {
  baseUrl: string;
  accessToken(): string | undefined;
}) {
  async function post<T>(
    path: 'preview' | 'confirm',
    file: Blob,
    fields: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<T> {
    const token = options.accessToken();
    if (!token) throw new CustomersApiError(401, 'SESSION_REQUIRED');
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    form.set('file', file, 'import.csv');
    let response: Response;
    try {
      response = await fetch(
        `${options.baseUrl.replace(/\/$/, '')}/api/v1/customer-360/imports/${path}`,
        {
          method: 'POST',
          cache: 'no-store',
          signal,
          headers: { authorization: `Bearer ${token}` },
          body: form,
        },
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new CustomersApiError(0, 'NETWORK_ERROR', true);
    }
    if (!response.ok) {
      let body: { error?: { code?: unknown; retryable?: unknown } } = {};
      try {
        body = (await response.json()) as typeof body;
      } catch {
        /* proxy อาจไม่ส่ง JSON */
      }
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new CustomersApiError(
        response.status,
        typeof body.error?.code === 'string' ? body.error.code : 'REQUEST_FAILED',
        body.error?.retryable === true || response.status >= 500,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined,
      );
    }
    return response.json() as Promise<T>;
  }
  return {
    preview: (file: Blob, mapping: ImportMapping, signal?: AbortSignal) =>
      post<ImportPreview>('preview', file, { mapping: JSON.stringify(mapping) }, signal),
    confirm: (
      file: Blob,
      input: { mapping: ImportMapping; planHash: string; commandId: string },
      signal?: AbortSignal,
    ) =>
      post<ImportResult>(
        'confirm',
        file,
        {
          mapping: JSON.stringify(input.mapping),
          planHash: input.planHash,
          commandId: input.commandId,
        },
        signal,
      ),
  };
}
export type CustomerImportApi = ReturnType<typeof createCustomerImportApi>;
