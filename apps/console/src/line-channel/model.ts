/**
 * #1054: rules of the LINE settings page that do not depend on React
 *
 * the server still makes the final decision; these checks only save a round trip and place the message under the field
 */
import type { LineApiError, LineChannel, LineSaveInput } from './api.js';

export const MAX_AUTO_REPLY = 500;
export const IDLE_MINUTES_RANGE = { min: 1, max: 1440 } as const;
export const DEFAULT_IDLE_MINUTES = 30;

/**
 * what the form holds: numbers stay text while typing so "" and "1e" can be reported instead of coerced.
 * `channelSecret` and `accessToken` hold only what was typed now; a stored value is never loaded into the form
 */
export interface LineDraft {
  enabled: boolean;
  queueId: string | null;
  lineChannelId: string;
  channelSecret: string;
  accessToken: string;
  /** a stored secret or token is replaced only after the Admin asks to */
  replaceSecret: boolean;
  replaceToken: boolean;
  autoReplyText: string;
  idleMinutes: string;
}

export type FieldKey =
  'queue' | 'lineChannelId' | 'channelSecret' | 'accessToken' | 'autoReply' | 'idle';
/** order the page reads and the order focus goes to on a failed save */
export const FIELD_ORDER: readonly FieldKey[] = [
  'queue',
  'idle',
  'lineChannelId',
  'channelSecret',
  'accessToken',
  'autoReply',
];

export type FieldErrors = Partial<Record<FieldKey, string>>;

const inRange = (value: number, range: { min: number; max: number }) =>
  Number.isInteger(value) && value >= range.min && value <= range.max;

export function draftFrom(channel: LineChannel): LineDraft {
  const first = channel.id === null;
  const minutes = channel.idleTimeoutSec / 60;
  return {
    enabled: channel.enabled,
    queueId: channel.queueId,
    lineChannelId: channel.lineChannelId,
    channelSecret: '',
    accessToken: '',
    replaceSecret: false,
    replaceToken: false,
    autoReplyText: channel.autoReplyText,
    idleMinutes: String(
      first || !inRange(minutes, IDLE_MINUTES_RANGE) ? DEFAULT_IDLE_MINUTES : minutes,
    ),
  };
}

export function isDirty(draft: LineDraft, base: LineDraft): boolean {
  return (
    draft.enabled !== base.enabled ||
    draft.queueId !== base.queueId ||
    draft.lineChannelId.trim() !== base.lineChannelId.trim() ||
    draft.channelSecret.trim() !== '' ||
    draft.accessToken.trim() !== '' ||
    draft.autoReplyText !== base.autoReplyText ||
    draft.idleMinutes.trim() !== base.idleMinutes.trim()
  );
}

const wholeNumber = (text: string): number | undefined =>
  /^\d{1,5}$/.test(text.trim()) ? Number(text.trim()) : undefined;

export const isChannelSecret = (value: string) => /^[0-9a-f]{32}$/i.test(value.trim());
export const isAccessToken = (value: string) => /^[A-Za-z0-9+/=._-]{20,512}$/.test(value.trim());
export const isLineChannelId = (value: string) => /^\d{6,20}$/.test(value.trim());

/** whether the channel will have a secret and a token once this draft is saved */
export function enableRequirements(
  draft: LineDraft,
  channel: Pick<LineChannel, 'hasChannelSecret' | 'hasAccessToken'>,
): { queue: boolean; secret: boolean; token: boolean } {
  return {
    queue: draft.queueId !== null,
    secret: channel.hasChannelSecret || draft.channelSecret.trim() !== '',
    token: channel.hasAccessToken || draft.accessToken.trim() !== '',
  };
}

/** message keys are relative to the `lineChannel` namespace */
export function validateDraft(
  draft: LineDraft,
  channel: Pick<LineChannel, 'hasChannelSecret' | 'hasAccessToken'>,
): FieldErrors {
  const errors: FieldErrors = {};
  const need = enableRequirements(draft, channel);
  if (draft.enabled && !need.queue) errors.queue = 'errors.queueRequired';
  if (draft.lineChannelId.trim() && !isLineChannelId(draft.lineChannelId))
    errors.lineChannelId = 'errors.channelIdInvalid';
  if (draft.channelSecret.trim()) {
    if (!isChannelSecret(draft.channelSecret)) errors.channelSecret = 'errors.secretInvalid';
  } else if (draft.enabled && !need.secret) errors.channelSecret = 'errors.secretRequired';
  if (draft.accessToken.trim()) {
    if (!isAccessToken(draft.accessToken)) errors.accessToken = 'errors.tokenInvalid';
  } else if (draft.enabled && !need.token) errors.accessToken = 'errors.tokenRequired';
  if ([...draft.autoReplyText].length > MAX_AUTO_REPLY)
    errors.autoReply = 'errors.autoReplyTooLong';
  const minutes = wholeNumber(draft.idleMinutes);
  if (minutes === undefined || !inRange(minutes, IDLE_MINUTES_RANGE))
    errors.idle = 'errors.idleRange';
  return errors;
}

/** call only after `validateDraft` returned no errors; a secret or token is sent only when one was typed */
export function saveInput(draft: LineDraft, expectedRevision: number): LineSaveInput {
  const secret = draft.channelSecret.trim();
  const token = draft.accessToken.trim();
  return {
    expectedRevision,
    enabled: draft.enabled,
    queueId: draft.queueId,
    lineChannelId: draft.lineChannelId.trim(),
    ...(secret ? { channelSecret: secret } : {}),
    ...(token ? { accessToken: token } : {}),
    autoReplyText: draft.autoReplyText,
    idleTimeoutSec: Number(draft.idleMinutes.trim()) * 60,
  };
}

/** which field a server rejection belongs to, and the message to show there */
export function serverFieldError(
  error: Pick<LineApiError, 'code' | 'field'>,
  draft: LineDraft,
): { field: FieldKey; messageKey: string } | undefined {
  if (error.code === 'LINE_TOKEN_REJECTED')
    return { field: 'accessToken', messageKey: 'errors.tokenRejected' };
  switch (error.field) {
    case 'queueId':
      return {
        field: 'queue',
        messageKey: draft.queueId ? 'errors.queueInvalid' : 'errors.queueRequired',
      };
    case 'lineChannelId':
      return { field: 'lineChannelId', messageKey: 'errors.channelIdInvalid' };
    case 'channelSecret':
      return { field: 'channelSecret', messageKey: 'errors.secretInvalid' };
    case 'accessToken':
      return { field: 'accessToken', messageKey: 'errors.tokenInvalid' };
    case 'autoReplyText':
      return { field: 'autoReply', messageKey: 'errors.autoReplyTooLong' };
    case 'idleTimeoutSec':
      return { field: 'idle', messageKey: 'errors.idleRange' };
    default:
      return undefined;
  }
}

/** the public URL LINE calls: the API's own origin (a relative base resolves against the Console page) plus the saved path */
export function webhookUrl(
  webhookPath: string | null,
  apiBaseUrl: string,
  pageOrigin: string,
): string | undefined {
  if (!webhookPath) return undefined;
  const base = new URL(apiBaseUrl.trim() || '/', pageOrigin);
  return `${base.origin}${webhookPath}`;
}

/** "…abcd" for a stored value; the hint is the last characters the API keeps */
export const hintText = (hint: string | null) => (hint ? `…${hint}` : '…');
