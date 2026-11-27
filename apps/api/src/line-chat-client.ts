import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * #1054: the few LINE Messaging API calls LINE chat needs, with the channel's own access token.
 *
 * The base URL comes from `LINE_API_BASE_URL` so a dev stack and the trial can point at the LINE
 * simulator; production leaves it unset. Every call has a timeout, and the token is never logged.
 */

export const LINE_API_DEFAULT_BASE_URL = 'https://api.line.me';
const TIMEOUT_MS = 10_000;

/** Whether `signature` (the `x-line-signature` header) is the HMAC of these exact bytes with the secret. */
export function verifyLineSignature(rawBody: Buffer, signature: unknown, channelSecret: string) {
  if (typeof signature !== 'string' || signature.length === 0 || signature.length > 128)
    return false;
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export type LineCallOutcome =
  | { kind: 'OK'; body: unknown }
  /** the push with this retry key was already accepted earlier: the message reached LINE */
  | { kind: 'ALREADY_ACCEPTED' }
  /** worth trying again later: rate limited, LINE failed, or the network did */
  | { kind: 'RETRY'; status: number | null; retryAfterSec: number | null }
  /** LINE refused the request; trying again changes nothing (bad token, blocked user, bad input) */
  | { kind: 'REJECTED'; status: number };

export interface LineBotInfo {
  userId: string;
  displayName: string;
}

export interface LineProfile {
  displayName: string;
}

export class LineChatClient {
  constructor(
    private readonly baseUrl: string = LINE_API_DEFAULT_BASE_URL,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async call(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<LineCallOutcome> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return { kind: 'RETRY', status: null, retryAfterSec: null };
    }
    const text = await response.text().catch(() => '');
    if (response.ok) {
      try {
        return { kind: 'OK', body: text ? JSON.parse(text) : {} };
      } catch {
        return { kind: 'OK', body: {} };
      }
    }
    // LINE answers 409 to a retry key it has already accepted, and names the accepted request
    if (response.status === 409 && response.headers.get('x-line-accepted-request-id'))
      return { kind: 'ALREADY_ACCEPTED' };
    if (response.status === 429 || response.status >= 500) {
      const after = Number(response.headers.get('retry-after'));
      return {
        kind: 'RETRY',
        status: response.status,
        retryAfterSec: Number.isFinite(after) && after > 0 ? after : null,
      };
    }
    return { kind: 'REJECTED', status: response.status };
  }

  /** The bot of this token, or null when LINE does not accept the token. */
  async botInfo(token: string): Promise<LineBotInfo | null | 'UNAVAILABLE'> {
    const outcome = await this.call('GET', '/v2/bot/info', token);
    if (outcome.kind === 'RETRY') return 'UNAVAILABLE';
    if (outcome.kind !== 'OK') return null;
    const body = outcome.body as { userId?: unknown; displayName?: unknown };
    if (typeof body.userId !== 'string' || !body.userId) return null;
    return {
      userId: body.userId,
      displayName: typeof body.displayName === 'string' ? body.displayName.slice(0, 100) : '',
    };
  }

  async profile(token: string, userId: string): Promise<LineProfile | null> {
    const outcome = await this.call('GET', `/v2/bot/profile/${encodeURIComponent(userId)}`, token);
    if (outcome.kind !== 'OK') return null;
    const name = (outcome.body as { displayName?: unknown }).displayName;
    return typeof name === 'string' ? { displayName: name.slice(0, 100) } : null;
  }

  /** Sends text to a user. `retryKey` makes a repeated send safe: LINE delivers it once. */
  push(token: string, to: string, text: string, retryKey: string): Promise<LineCallOutcome> {
    return this.call(
      'POST',
      '/v2/bot/message/push',
      token,
      { to, messages: [{ type: 'text', text }] },
      { 'x-line-retry-key': retryKey },
    );
  }

  /** Answers with the reply token of an event; free of the push quota, valid only briefly and once. */
  reply(token: string, replyToken: string, text: string): Promise<LineCallOutcome> {
    return this.call('POST', '/v2/bot/message/reply', token, {
      replyToken,
      messages: [{ type: 'text', text }],
    });
  }
}
