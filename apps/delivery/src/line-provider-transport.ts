/**
 * Owner: Delivery/Channels — LINE Messaging API transport (S2.4 #370, #357 §1/§3)
 *
 * S2 scope: may call only `POST /v2/bot/message/push` one-to-one, one recipient per
 * logical delivery — no multicast/narrowcast/broadcast and no free text
 *
 * This transport layer "decides" nothing: it never retries itself, never translates results into a business outcome and never
 * mints a new key. Its only job is to fire the exact request the caller prepared and return what the provider answered.
 * Interpretation lives in `classifyLineResponse` so the mapping can be checked by unit test without a network
 *
 * Values that must not leak: the access token, the raw recipient (`to`) and message content are never logged or put in an error
 */
import type { LineProviderOutcomeCode, LineRejectionScope } from '@d-contact/cxa-contracts';

export const LINE_PUSH_PATH = '/v2/bot/message/push';
export const LINE_API_BASE_URL = 'https://api.line.me';
/** LINE answers within a few seconds; beyond that the outcome is unknown and must be reconciled with the original key */
export const LINE_REQUEST_TIMEOUT_MS = 10_000;

export interface LinePushRequest {
  /** the opaque recipient already resolved from the protected binding — must not be logged */
  to: string;
  messages: ReadonlyArray<Record<string, unknown>>;
  /** always the original value of this delivery (#357 §2) — must not be minted anew on retry */
  retryKey: string;
  accessToken: string;
}

export interface LinePushResponse {
  httpStatus: number;
  /** the `x-line-request-id` of this request */
  requestId?: string;
  /** the `x-line-accepted-request-id` that comes with a 409 when the earlier request was already accepted */
  acceptedRequestId?: string;
  sentMessageIds?: readonly string[];
  /** the provider's machine-readable error code only, not free-form text */
  errorCode?: string;
}

/** The results the transport can return: a real response, or an entirely unknown outcome (timeout/socket/contract violation) */
export type LineTransportResult =
  | { kind: 'RESPONSE'; response: LinePushResponse }
  | { kind: 'NO_RESPONSE'; reason: 'TIMEOUT' | 'NETWORK' | 'INVALID_RESPONSE' };

export interface LineQuotaView {
  type: string;
  value: number | null;
}

export interface LineTokenVerification {
  valid: boolean;
  /** the `client_id` LINE binds to the token — must equal the Channel ID of the scope (#360 §D item 1) */
  clientId?: string;
  expiresInSeconds?: number;
}

/** the webhook configured on the LINE side — the endpoint is our own URL, not customer data */
export interface LineWebhookEndpointView {
  endpoint: string | null;
  active: boolean;
}

/**
 * revoke the token for RB01 (#360 §D item 10) — v2.1 must confirm with channel ID + secret while long-lived
 * revokes with the token itself. All values are only in the memory of the protected runner
 */
export type LineTokenRevocation =
  | {
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1';
      accessToken: string;
      channelId: string;
      channelSecret: string;
    }
  | { credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED'; accessToken: string };

/** Result of `POST /v2/bot/channel/webhook/test`: LINE fires a signed empty webhook at the real endpoint */
export interface LineWebhookTestResult {
  success: boolean;
  /** the status our endpoint answered LINE with */
  statusCode: number | null;
  reason?: string;
}

/**
 * owner-local port (#362 §4) — the real implementation talks to LINE while tests use a deterministic double
 * both must respect the same rule: one call is one HTTP request, with no hidden retry inside
 */
export interface LineProviderTransport {
  verifyToken(accessToken: string): Promise<LineTokenVerification>;
  getQuota(accessToken: string): Promise<LineQuotaView>;
  getConsumption(accessToken: string): Promise<{ totalUsage: number }>;
  /** validate has no recipient — LINE checks only the shape of messages so it never accepts `to` from the start */
  validatePush(
    request: Pick<LinePushRequest, 'messages' | 'accessToken'>,
  ): Promise<{ valid: boolean; errorCode?: string }>;
  push(request: LinePushRequest): Promise<LineTransportResult>;
  getWebhookEndpoint(accessToken: string): Promise<LineWebhookEndpointView>;
  testWebhookEndpoint(accessToken: string): Promise<LineWebhookTestResult>;
  revokeToken(
    request: LineTokenRevocation,
  ): Promise<{ revoked: boolean; httpStatus: number | null }>;
}

export interface LineClassification {
  outcomeCode: LineProviderOutcomeCode;
  rejectionScope?: LineRejectionScope;
  /** true when the provider confirmed it accepted the request (2xx or a 409 replay) */
  accepted: boolean;
  /** true when the outcome is not yet known and must be reconciled with the original request */
  reconcile: boolean;
}

const ACCEPTED_2XX: LineClassification = {
  outcomeCode: 'LINE_ACCEPTED',
  accepted: true,
  reconcile: false,
};

/**
 * The whole #357 §3 table lives in a single function so the mapping can be re-checked from one place
 *
 * Principles that must not drift:
 * - `2xx` and `409 + accepted request id` = provider accepted (not delivered) and must not be retried
 * - other `4xx` are terminal — LINE says do not retry; `401/403` are account-level signals
 * - `5xx`, timeout, network and a response that violates the contract = outcome unknown, must reconcile with the original key
 * - a `409` without an accepted request id counts as a contract-violating response, not acceptance
 */
export function classifyLineResponse(result: LineTransportResult): LineClassification {
  if (result.kind === 'NO_RESPONSE') {
    return {
      outcomeCode:
        result.reason === 'INVALID_RESPONSE' ? 'LINE_RESPONSE_INVALID' : 'LINE_UNKNOWN_OUTCOME',
      accepted: false,
      reconcile: true,
    };
  }

  const { httpStatus, acceptedRequestId, sentMessageIds, errorCode } = result.response;
  if (httpStatus >= 200 && httpStatus < 300) {
    // a 2xx without sentMessages counts as a contract violation — never guess it was accepted
    return sentMessageIds && sentMessageIds.length > 0
      ? ACCEPTED_2XX
      : { outcomeCode: 'LINE_RESPONSE_INVALID', accepted: false, reconcile: true };
  }
  if (httpStatus === 409) {
    return acceptedRequestId
      ? { outcomeCode: 'LINE_ACCEPTED_REPLAY', accepted: true, reconcile: false }
      : { outcomeCode: 'LINE_RESPONSE_INVALID', accepted: false, reconcile: true };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      outcomeCode: 'LINE_AUTH_INVALID',
      rejectionScope: 'OPERATIONAL',
      accepted: false,
      reconcile: false,
    };
  }
  if (httpStatus === 429) {
    const quota = errorCode === 'MONTHLY_QUOTA_EXHAUSTED';
    return {
      outcomeCode: quota ? 'LINE_MONTHLY_QUOTA_EXHAUSTED' : 'LINE_RATE_LIMITED',
      rejectionScope: 'OPERATIONAL',
      accepted: false,
      reconcile: false,
    };
  }
  if (httpStatus >= 400 && httpStatus < 500) {
    // 400/404 are bound to this delivery's recipient/payload so they count as an Attempt (#361 §B)
    return {
      outcomeCode: 'LINE_REQUEST_REJECTED',
      rejectionScope: 'RECIPIENT',
      accepted: false,
      reconcile: false,
    };
  }
  if (httpStatus >= 500) {
    return { outcomeCode: 'LINE_PROVIDER_UNAVAILABLE', accepted: false, reconcile: true };
  }
  return { outcomeCode: 'LINE_RESPONSE_INVALID', accepted: false, reconcile: true };
}

function header(headers: Headers, name: string): string | undefined {
  const value = headers.get(name);
  return value && value.length > 0 ? value : undefined;
}

/**
 * the real implementation — not used in automated tests per the stop condition of #370
 * (`ordinary tests/PR` must have no provider traffic) but must exist so the pilot can really run
 */
export class HttpLineProviderTransport implements LineProviderTransport {
  constructor(
    private readonly baseUrl: string = LINE_API_BASE_URL,
    private readonly timeoutMs: number = LINE_REQUEST_TIMEOUT_MS,
    private readonly fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async push(request: LinePushRequest): Promise<LineTransportResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${LINE_PUSH_PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${request.accessToken}`,
          'content-type': 'application/json',
          'x-line-retry-key': request.retryKey,
        },
        body: JSON.stringify({ to: request.to, messages: request.messages }),
        signal: controller.signal,
      });
      const payload = (await response.json().catch(() => undefined)) as
        { sentMessages?: Array<{ id?: unknown }>; message?: unknown } | undefined;
      const sentMessageIds = (payload?.sentMessages ?? [])
        .map((message) => message?.id)
        .filter((id): id is string => typeof id === 'string');
      return {
        kind: 'RESPONSE',
        response: {
          httpStatus: response.status,
          ...(header(response.headers, 'x-line-request-id')
            ? { requestId: header(response.headers, 'x-line-request-id')! }
            : {}),
          ...(header(response.headers, 'x-line-accepted-request-id')
            ? { acceptedRequestId: header(response.headers, 'x-line-accepted-request-id')! }
            : {}),
          ...(sentMessageIds.length > 0 ? { sentMessageIds } : {}),
        },
      };
    } catch (error) {
      // unknown outcome = it may already have been accepted, never conclude it was not sent (#357 §3)
      const aborted = error instanceof Error && error.name === 'AbortError';
      return { kind: 'NO_RESPONSE', reason: aborted ? 'TIMEOUT' : 'NETWORK' };
    } finally {
      clearTimeout(timer);
    }
  }

  async verifyToken(accessToken: string): Promise<LineTokenVerification> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/oauth/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: accessToken }),
    });
    if (!response.ok) return { valid: false };
    const payload = (await response.json().catch(() => undefined)) as
      { client_id?: unknown; expires_in?: number } | undefined;
    return {
      valid: true,
      ...(typeof payload?.client_id === 'string' ? { clientId: payload.client_id } : {}),
      ...(typeof payload?.expires_in === 'number' ? { expiresInSeconds: payload.expires_in } : {}),
    };
  }

  async getQuota(accessToken: string): Promise<LineQuotaView> {
    const payload = await this.get<{ type?: string; value?: number }>(
      accessToken,
      '/v2/bot/message/quota',
    );
    return {
      type: payload?.type ?? 'none',
      value: typeof payload?.value === 'number' ? payload.value : null,
    };
  }

  async getConsumption(accessToken: string): Promise<{ totalUsage: number }> {
    const payload = await this.get<{ totalUsage?: number }>(
      accessToken,
      '/v2/bot/message/quota/consumption',
    );
    return { totalUsage: typeof payload?.totalUsage === 'number' ? payload.totalUsage : 0 };
  }

  /** LINE dry-run: checks the payload shape without really sending, used at PROVIDER_CONFORMANCE (#358) */
  async validatePush(
    request: Pick<LinePushRequest, 'messages' | 'accessToken'>,
  ): Promise<{ valid: boolean; errorCode?: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/bot/message/validate/push`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${request.accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ messages: request.messages }),
    });
    if (response.ok) return { valid: true };
    return { valid: false, errorCode: `HTTP_${response.status}` };
  }

  async getWebhookEndpoint(accessToken: string): Promise<LineWebhookEndpointView> {
    const payload = await this.get<{ endpoint?: unknown; active?: unknown }>(
      accessToken,
      '/v2/bot/channel/webhook/endpoint',
    );
    return {
      endpoint: typeof payload?.endpoint === 'string' ? payload.endpoint : null,
      active: payload?.active === true,
    };
  }

  /** not sending `endpoint` in the body = LINE tests the endpoint already configured, not a URL the caller chose */
  async testWebhookEndpoint(accessToken: string): Promise<LineWebhookTestResult> {
    const response = await this.fetchImpl(`${this.baseUrl}/v2/bot/channel/webhook/test`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (!response.ok)
      return { success: false, statusCode: null, reason: `HTTP_${response.status}` };
    const payload = (await response.json().catch(() => undefined)) as
      { success?: unknown; statusCode?: unknown; reason?: unknown } | undefined;
    return {
      success: payload?.success === true,
      statusCode: typeof payload?.statusCode === 'number' ? payload.statusCode : null,
      ...(typeof payload?.reason === 'string' ? { reason: payload.reason } : {}),
    };
  }

  /** bot user ID = the webhook `destination` that ingress must bind (#359 §B) — not customer data */
  async getBotInfo(accessToken: string): Promise<{ userId: string | null }> {
    const payload = await this.get<{ userId?: unknown }>(accessToken, '/v2/bot/info');
    return { userId: typeof payload?.userId === 'string' ? payload.userId : null };
  }

  async revokeToken(
    request: LineTokenRevocation,
  ): Promise<{ revoked: boolean; httpStatus: number | null }> {
    const [path, form] =
      request.credentialKind === 'CHANNEL_ACCESS_TOKEN_V2_1'
        ? [
            '/oauth2/v2.1/revoke',
            {
              client_id: request.channelId,
              client_secret: request.channelSecret,
              access_token: request.accessToken,
            },
          ]
        : ['/v2/oauth/revoke', { access_token: request.accessToken }];
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form),
      });
      return { revoked: response.ok, httpStatus: response.status };
    } catch {
      return { revoked: false, httpStatus: null };
    }
  }

  private async get<T>(accessToken: string, path: string): Promise<T | undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    return (await response.json().catch(() => undefined)) as T | undefined;
  }
}
