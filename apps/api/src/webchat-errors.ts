/** #1044: a web chat failure with the HTTP status and the stable code the clients translate. */
export type WebchatErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'WEBCHAT_DISABLED'
  | 'REVISION_CONFLICT'
  | 'SESSION_INVALID'
  | 'CHAT_ENDED'
  | 'CHAT_NOT_ACTIVE'
  | 'OFFER_GONE'
  | 'NO_AGENT_ONLINE'
  | 'QUEUE_FULL'
  | 'MESSAGE_LIMIT'
  | 'COMMAND_ID_REUSED'
  | 'RATE_LIMITED';

const STATUS: Record<WebchatErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  FORBIDDEN: 403,
  WEBCHAT_DISABLED: 404,
  REVISION_CONFLICT: 409,
  SESSION_INVALID: 401,
  CHAT_ENDED: 409,
  CHAT_NOT_ACTIVE: 409,
  OFFER_GONE: 409,
  NO_AGENT_ONLINE: 409,
  QUEUE_FULL: 429,
  MESSAGE_LIMIT: 429,
  COMMAND_ID_REUSED: 409,
  RATE_LIMITED: 429,
};

export class WebchatError extends Error {
  readonly status: number;
  constructor(
    readonly code: WebchatErrorCode,
    readonly detail: { field?: string; retryAfterSeconds?: number } = {},
  ) {
    super(code);
    this.status = STATUS[code];
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function webchatUuid(value: unknown, code: WebchatErrorCode = 'NOT_FOUND'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new WebchatError(code);
  return value.toLowerCase();
}

/** Message text from a visitor or an Agent: 1-2000 characters after trimming, no control characters. */
export function webchatText(value: unknown): string {
  if (typeof value !== 'string') throw new WebchatError('VALIDATION_FAILED', { field: 'text' });
  const text = value.replace(/\r\n?/g, '\n').trim();
  const length = [...text].length;
  if (
    length < 1 ||
    length > 2000 ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text)
  )
    throw new WebchatError('VALIDATION_FAILED', { field: 'text' });
  return text;
}
