/**
 * E1.11 (#485): rules of the Integrations › dphone embedding page that do not depend on React
 *
 * the origin format is checked with the same function as the API (`normalizeEmbedOrigin`) — the API still makes the final decision
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

/** E1.14: selectable levels in order — `custom` is shown but disabled until the field list is decided */
export const SCREEN_POP_OPTIONS = ['off', 'ids', 'contact', 'custom'] as const;
export const SCREEN_POP_REASON_MIN = 3;

/** key of the error message from the API — an origin rejection uses the same message as the immediate check */
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
 * snippet the host must add (E1.2/E1.5/E1.7): `<dphone-launcher>` from the `v1` alias of the dphone origin
 * (the launcher creates the iframe `/dphone/embed` with `allow` for the mic and a sandbox with `allow-popups` itself)
 * + the host-side CSP that must allow the same origin in both `script-src` and `frame-src`
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

/** E1.15: host guide in Thai (`docs/dphone-embed/`) — set a customer-reachable URL with `VITE_DPHONE_EMBED_DOCS_URL` */
export const DEFAULT_DPHONE_EMBED_DOCS_URL =
  'https://github.com/Kitti-Nualsalee/dcontact/blob/main/docs/dphone-embed/README.md';
