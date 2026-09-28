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

/** key ของข้อความ error จาก API — rejection ของ origin ใช้ข้อความเดียวกับการตรวจทันที */
export function apiErrorKey(error: EmbedOriginApiError): string {
  if (error.code === 'VALIDATION_FAILED' && error.field === 'origin' && error.reason) {
    return `dphoneEmbedding.rejections.${error.reason}`;
  }
  if (error.code && API_ERRORS.has(error.code)) return `dphoneEmbedding.errors.${error.code}`;
  if (error.status === 403) return 'dphoneEmbedding.errors.FORBIDDEN';
  return 'dphoneEmbedding.errors.UNKNOWN';
}

/**
 * snippet ที่ host ต้องใส่ (E1.2/E1.5): iframe ของ `/dphone/embed` + `allow` ไมค์ + sandbox ที่มี
 * `allow-popups` (login popup) และ CSP `frame-src` ฝั่ง host
 */
export function hostSnippet(input: { embedBaseUrl: string; tenantAlias: string }): string {
  const base = input.embedBaseUrl.replace(/\/$/, '');
  const src = `${base}/dphone/embed?tenant=${encodeURIComponent(input.tenantAlias)}`;
  return [
    `<!-- Host page Content-Security-Policy: frame-src ${new URL(base).origin} -->`,
    `<iframe`,
    `  src="${src}"`,
    `  title="dphone"`,
    `  allow="microphone; autoplay"`,
    `  sandbox="allow-scripts allow-same-origin allow-popups allow-forms"`,
    `  style="width: 360px; height: 640px; border: 0"`,
    `></iframe>`,
  ].join('\n');
}
