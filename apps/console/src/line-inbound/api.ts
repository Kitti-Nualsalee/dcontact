/**
 * #566: client ของ `GET /api/v1/line-pilot/inbound` — read-only ของ LINE pilot บน UAT
 *
 * route อยู่ใน service `line-webhook` ของ overlay `uat-line` เท่านั้น: ไม่มี overlay = 404
 * (`ROUTE_NOT_AVAILABLE_IN_PROFILE` จาก api ของ UAT) → Console ซ่อนหน้า/ลิงก์ทั้งหมด
 * tenant/actor มาจาก bearer token; response ไม่มี LINE ID ดิบ (server ตัดออกแล้ว)
 */
const INBOUND = '/api/v1/line-pilot/inbound';
/** ตรวจสิทธิ์อย่างเดียว (204) — ไม่อ่านข้อความและไม่ถูก audit เป็นการเปิดดู */
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

/** #567: สถานะของ team trial — ไม่มี route (404) = ไม่ได้เปิด trial */
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
  /** #567: null = trial ไม่ได้เปิด */
  trialStatus(): Promise<LineTrialStatus | null>;
  /** idempotencyKey เดิมตลอด intent เดียว — retry ด้วย key เดิมไม่ส่งซ้ำ */
  reply(inboxEntryId: string, text: string, idempotencyKey: string): Promise<LineReplyResult>;
  kill(): Promise<void>;
  /** 404 = ไม่มี overlay, 403 = มี overlay แต่บัญชีนี้ไม่มีสิทธิ์ */
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
      // Nest ห่อ body ของ HttpException ไว้ตรง ๆ หรือใน message แล้วแต่รูปแบบ
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
