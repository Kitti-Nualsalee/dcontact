/**
 * E1.11 (#485): กติกาของหน้า Integrations › dphone embedding ที่ไม่ขึ้นกับ React
 *
 * ตรวจรูปแบบ origin ด้วยฟังก์ชันเดียวกับ API (`normalizeEmbedOrigin`) — API ยังเป็นตัวตัดสินสุดท้าย
 */
import {
  normalizeEmbedOrigin,
  type EmbedOriginRejection,
} from '@d-contact/shared/src/embed-origin.js';
import type { EmbedOriginApiError } from './api.js';

export type OriginCheck =
  | { ok: true; origin: string }
  | { ok: false; messageKey: `dphoneEmbedding.rejections.${EmbedOriginRejection}` };

export function checkOriginInput(value: string, options: { dev: boolean }): OriginCheck | null {
  if (!value.trim()) return null;
  const result = normalizeEmbedOrigin(value, { allowLocalhost: options.dev });
  return result.ok
    ? { ok: true, origin: result.origin }
    : { ok: false, messageKey: `dphoneEmbedding.rejections.${result.reason}` };
}

const API_ERRORS = new Set([
  'VALIDATION_FAILED',
  'ENTITLEMENT_REQUIRED',
  'EMBED_ORIGIN_LIMIT_REACHED',
  'EMBED_ORIGIN_DUPLICATE',
  'REVISION_CONFLICT',
  'NOT_FOUND',
]);

/** E1.14: ระดับที่เลือกได้ตามลำดับ — `custom` แสดงแต่ปิดไว้จนกว่ารายการ field จะถูกตัดสิน */
export const SCREEN_POP_OPTIONS = ['off', 'ids', 'contact', 'custom'] as const;
export const SCREEN_POP_REASON_MIN = 3;

/** key ของข้อความ error จาก API — rejection ของ origin ใช้ข้อความเดียวกับการตรวจทันที */
export function apiErrorKey(error: EmbedOriginApiError): string {
  if (error.code === 'VALIDATION_FAILED' && error.field === 'origin' && error.reason) {
    return `dphoneEmbedding.rejections.${error.reason}`;
  }
  if (error.code === 'VALIDATION_FAILED' && error.field === 'screenPopLevel') {
    return 'dphoneEmbedding.errors.SCREEN_POP_LEVEL_UNAVAILABLE';
  }
  if (error.code === 'VALIDATION_FAILED' && error.field === 'reason') {
    return 'dphoneEmbedding.errors.REASON_REQUIRED';
  }
  if (error.code && API_ERRORS.has(error.code)) return `dphoneEmbedding.errors.${error.code}`;
  if (error.status === 403) return 'dphoneEmbedding.errors.FORBIDDEN';
  return 'dphoneEmbedding.errors.UNKNOWN';
}

/**
 * snippet ที่ host ต้องใส่ (E1.2/E1.5/E1.7): `<dphone-launcher>` จาก alias `v1` ของ dphone origin
 * (launcher สร้าง iframe `/dphone/embed` พร้อม `allow` ไมค์และ sandbox ที่มี `allow-popups` ให้เอง)
 * + CSP ฝั่ง host ที่ต้องอนุญาต origin เดียวกันทั้ง `script-src` และ `frame-src`
 */
export function hostSnippet(input: { embedBaseUrl: string; tenantAlias: string }): string {
  const origin = new URL(input.embedBaseUrl).origin;
  const tenant = input.tenantAlias.replace(/[^a-z0-9-]/gi, '');
  return [
    `<!-- Host page Content-Security-Policy: script-src ${origin}; frame-src ${origin} -->`,
    `<script type="module" src="${origin}/embed/v1/dphone-launcher.js"></script>`,
    `<dphone-launcher tenant="${tenant}" style="width: 360px; height: 640px"></dphone-launcher>`,
  ].join('\n');
}

/** E1.15: คู่มือ host ภาษาไทย (`docs/dphone-embed/`) — ตั้ง URL ที่ลูกค้าเข้าถึงได้ด้วย `VITE_DPHONE_EMBED_DOCS_URL` */
export const DEFAULT_DPHONE_EMBED_DOCS_URL =
  'https://github.com/Kitti-Nualsalee/dcontact/blob/main/docs/dphone-embed/README.md';
