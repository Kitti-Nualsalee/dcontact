/**
 * #566: client of `GET /api/v1/line-pilot/inbound` — the read-only LINE pilot on UAT
 *
 * the route exists only in the `line-webhook` service of the `uat-line` overlay: no overlay = 404
 * (`ROUTE_NOT_AVAILABLE_IN_PROFILE` from the UAT api) → Console hides every page/link
 * tenant/actor come from the bearer token; the response has no raw LINE ID (the server strips it)
 */
const INBOUND = '/api/v1/line-pilot/inbound';
/** permission check only (204) — does not read messages and is not audited as a view */
const ACCESS = '/api/v1/line-pilot/access';

export interface LineInboundItem {
  id: string;
  receivedAt: string;
  eventType: string;
  messageType: string | null;
  text: string | null;
  senderFingerprint: string | null;
  state: string;
}

export interface LineInboundPage {
  items: LineInboundItem[];
  quarantined: number;
  nextCursor: string | null;
}

export type LineInboundAvailability = 'AVAILABLE' | 'FORBIDDEN' | 'UNAVAILABLE';

export class LineInboundApiError extends Error {
  constructor(readonly status: number) {
    super(`line inbound request failed: ${status}`);
    this.name = 'LineInboundApiError';
  }
}

/** #567: team trial status — no route (404) = trial not enabled */
export interface LineTrialStatus {
  active: boolean;
  killed: boolean;
  expiresAt: string | null;
  recipients: number;
  last24h: number;
  per24h: number | null;
  perRecipientPer24h: number | null;
}

export type LineReplyResult =
  { status: 'SENT' | 'PENDING'; deliveryId: string } | { status: 'FAILED'; code: string };

export interface LineInboundApi {
  list(input?: { limit?: number; before?: string }): Promise<LineInboundPage>;
  /** #567: null = trial not enabled */
  trialStatus(): Promise<LineTrialStatus | null>;
  /** the same idempotencyKey for a single intent — a retry with the same key does not resend */
  reply(inboxEntryId: string, text: string, idempotencyKey: string): Promise<LineReplyResult>;
  kill(): Promise<void>;
  /** 404 = no overlay, 403 = overlay present but this account has no permission */
  availability(): Promise<LineInboundAvailability>;
}

export function createLineInboundApi(options: {
  baseUrl: string;
  accessToken: () => string | undefined;
  fetch?: typeof globalThis.fetch;
}): LineInboundApi {
  const http = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/+$/, '');
  async function post(path: string, body: unknown): Promise<Response> {
    const token = options.accessToken();
    return http(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }
  async function get(path: string, query?: URLSearchParams): Promise<Response> {
    const token = options.accessToken();
    const suffix = query && query.size > 0 ? `?${query.toString()}` : '';
    return http(`${base}${path}${suffix}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }
  return {
    async list(input = {}) {
      const query = new URLSearchParams({ limit: String(input.limit ?? 50) });
      if (input.before) query.set('before', input.before);
      const response = await get(INBOUND, query);
      if (!response.ok) throw new LineInboundApiError(response.status);
      return (await response.json()) as LineInboundPage;
    },
    async trialStatus() {
      const response = await get('/api/v1/line-pilot/trial');
      if (response.status === 404) return null;
      if (!response.ok) throw new LineInboundApiError(response.status);
      return (await response.json()) as LineTrialStatus;
    },
    async reply(inboxEntryId, text, idempotencyKey) {
      const response = await post(
        `/api/v1/line-pilot/inbound/${encodeURIComponent(inboxEntryId)}/reply`,
        { text, idempotencyKey },
      );
      if (response.status === 401) throw new LineInboundApiError(401);
      const body = (await response.json().catch(() => ({}))) as {
        status?: string;
        code?: string;
        deliveryId?: string;
        message?: { code?: string };
      };
      if (response.ok && (body.status === 'SENT' || body.status === 'PENDING')) {
        return { status: body.status, deliveryId: body.deliveryId ?? '' };
      }
      // Nest wraps the HttpException body directly or inside message depending on the shape
      return {
        status: 'FAILED',
        code: body.code ?? body.message?.code ?? `HTTP_${response.status}`,
      };
    },
    async kill() {
      const response = await post('/api/v1/line-pilot/kill', {});
      if (!response.ok) throw new LineInboundApiError(response.status);
    },
    async availability() {
      const response = await get(ACCESS);
      if (response.status === 404) return 'UNAVAILABLE';
      if (response.status === 403) return 'FORBIDDEN';
      if (!response.ok) throw new LineInboundApiError(response.status);
      return 'AVAILABLE';
    },
  };
}
