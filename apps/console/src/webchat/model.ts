/**
 * #1044: rules of the Web Chat settings page that do not depend on React
 *
 * the server still makes the final decision; these checks only save a round trip and place the message under the field
 */
import { normalizeEmbedOrigin } from '@d-contact/shared/src/embed-origin.js';
import type { WebchatApiError, WebchatSaveInput, WebchatWidget } from './api.js';

export const MAX_ORIGINS = 10;
export const MAX_GREETING = 500;
export const CAPACITY_RANGE = { min: 1, max: 10 } as const;
export const IDLE_MINUTES_RANGE = { min: 1, max: 60 } as const;
export const DEFAULT_CAPACITY = 3;
export const DEFAULT_IDLE_MINUTES = 10;

/** what the form holds: numbers stay text while typing so "" and "1e" can be reported instead of coerced */
export interface WebchatDraft {
  enabled: boolean;
  queueId: string | null;
  origins: string[];
  greetingTh: string;
  greetingEn: string;
  capacity: string;
  idleMinutes: string;
}

export type FieldKey = 'queue' | 'capacity' | 'idle' | 'origins' | 'greetingTh' | 'greetingEn';
/** order the page reads and the order focus goes to on a failed save */
export const FIELD_ORDER: readonly FieldKey[] = [
  'queue',
  'capacity',
  'idle',
  'origins',
  'greetingTh',
  'greetingEn',
];

export type FieldErrors = Partial<Record<FieldKey, string>>;

const inRange = (value: number, range: { min: number; max: number }) =>
  Number.isInteger(value) && value >= range.min && value <= range.max;

export function draftFrom(widget: WebchatWidget): WebchatDraft {
  const first = widget.id === null;
  const capacity = inRange(widget.maxChatsPerAgent, CAPACITY_RANGE)
    ? widget.maxChatsPerAgent
    : DEFAULT_CAPACITY;
  const minutes = widget.idleTimeoutSec / 60;
  return {
    enabled: widget.enabled,
    queueId: widget.queueId,
    origins: [...widget.allowedOrigins],
    greetingTh: widget.greetingTh,
    greetingEn: widget.greetingEn,
    capacity: String(first ? DEFAULT_CAPACITY : capacity),
    idleMinutes: String(
      first || !inRange(minutes, IDLE_MINUTES_RANGE) ? DEFAULT_IDLE_MINUTES : minutes,
    ),
  };
}

export function isDirty(draft: WebchatDraft, base: WebchatDraft): boolean {
  return (
    draft.enabled !== base.enabled ||
    draft.queueId !== base.queueId ||
    draft.greetingTh !== base.greetingTh ||
    draft.greetingEn !== base.greetingEn ||
    draft.capacity.trim() !== base.capacity.trim() ||
    draft.idleMinutes.trim() !== base.idleMinutes.trim() ||
    draft.origins.length !== base.origins.length ||
    draft.origins.some((origin, index) => origin !== base.origins[index])
  );
}

const wholeNumber = (text: string): number | undefined =>
  /^\d{1,4}$/.test(text.trim()) ? Number(text.trim()) : undefined;

/** message keys are relative to the `webchat` namespace */
export function validateDraft(draft: WebchatDraft): FieldErrors {
  const errors: FieldErrors = {};
  if (draft.enabled && !draft.queueId) errors.queue = 'errors.queueRequired';
  const capacity = wholeNumber(draft.capacity);
  if (capacity === undefined || !inRange(capacity, CAPACITY_RANGE))
    errors.capacity = 'errors.capacityRange';
  const minutes = wholeNumber(draft.idleMinutes);
  if (minutes === undefined || !inRange(minutes, IDLE_MINUTES_RANGE))
    errors.idle = 'errors.idleRange';
  if (draft.enabled && draft.origins.length === 0) errors.origins = 'errors.originRequired';
  if (draft.greetingTh.length > MAX_GREETING) errors.greetingTh = 'errors.welcomeTooLong';
  if (draft.greetingEn.length > MAX_GREETING) errors.greetingEn = 'errors.welcomeTooLong';
  return errors;
}

/** the two things the switch needs, for the checklist next to it */
export function enableRequirements(draft: WebchatDraft): { queue: boolean; origin: boolean } {
  return { queue: draft.queueId !== null, origin: draft.origins.length > 0 };
}

/** call only after `validateDraft` returned no errors */
export function saveInput(draft: WebchatDraft, expectedRevision: number): WebchatSaveInput {
  return {
    expectedRevision,
    enabled: draft.enabled,
    queueId: draft.queueId,
    allowedOrigins: draft.origins,
    greetingTh: draft.greetingTh,
    greetingEn: draft.greetingEn,
    maxChatsPerAgent: Number(draft.capacity.trim()),
    idleTimeoutSec: Number(draft.idleMinutes.trim()) * 60,
  };
}

export type OriginCheck =
  | { ok: true; origin: string }
  | { ok: false; messageKey: 'origins.invalid' | 'origins.duplicate' | 'origins.limit' };

/** the same origin rules as the server; `http` is accepted for localhost only, as there */
export function checkOrigin(value: string, existing: readonly string[]): OriginCheck | null {
  if (!value.trim()) return null;
  const result = normalizeEmbedOrigin(value, { allowLocalhost: true });
  if (!result.ok) return { ok: false, messageKey: 'origins.invalid' };
  if (existing.includes(result.origin)) return { ok: false, messageKey: 'origins.duplicate' };
  if (existing.length >= MAX_ORIGINS) return { ok: false, messageKey: 'origins.limit' };
  return { ok: true, origin: result.origin };
}

/** which field a server rejection belongs to, and the message to show there */
export function serverFieldError(
  error: Pick<WebchatApiError, 'field'>,
  draft: WebchatDraft,
): { field: FieldKey; messageKey: string } | undefined {
  switch (error.field) {
    case 'queueId':
      return {
        field: 'queue',
        messageKey: draft.queueId ? 'errors.queueInvalid' : 'errors.queueRequired',
      };
    case 'allowedOrigins':
      return {
        field: 'origins',
        messageKey: draft.origins.length === 0 ? 'errors.originRequired' : 'origins.invalid',
      };
    case 'maxChatsPerAgent':
      return { field: 'capacity', messageKey: 'errors.capacityRange' };
    case 'idleTimeoutSec':
      return { field: 'idle', messageKey: 'errors.idleRange' };
    case 'greetingTh':
      return { field: 'greetingTh', messageKey: 'errors.welcomeTooLong' };
    case 'greetingEn':
      return { field: 'greetingEn', messageKey: 'errors.welcomeTooLong' };
    default:
      return undefined;
  }
}

/** base URL of the API as visitors' browsers must reach it; a relative base resolves against this page */
export function resolveApiBase(apiBaseUrl: string, pageOrigin: string): string {
  const base = new URL(apiBaseUrl.trim() || '/', pageOrigin);
  return `${base.origin}${base.pathname}`.replace(/\/+$/, '');
}

export function embedSnippet(input: { apiBase: string; tenantId: string; widgetId: string }) {
  const attribute = (value: string) => value.replace(/[^A-Za-z0-9_.:-]/g, '');
  return `<script src="${input.apiBase}/api/v1/webchat/widget.js" data-tenant="${attribute(input.tenantId)}" data-widget="${attribute(input.widgetId)}" async></script>`;
}

export function previewUrl(input: { apiBase: string; tenantId: string; widgetId: string }) {
  const query = new URLSearchParams({ tenant: input.tenantId, widget: input.widgetId });
  return `${input.apiBase}/api/v1/webchat/demo?${query.toString()}`;
}
