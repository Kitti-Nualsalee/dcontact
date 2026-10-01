/**
 * #566: client ของ `GET /api/v1/line-pilot/inbound` — read-only ของ LINE pilot บน UAT
 *
 * route อยู่ใน service `line-webhook` ของ overlay `uat-line` เท่านั้น: ไม่มี overlay = 404
 * (`ROUTE_NOT_AVAILABLE_IN_PROFILE` จาก api ของ UAT) → Console ซ่อนหน้า/ลิงก์ทั้งหมด
 * tenant/actor มาจาก bearer token; response ไม่มี LINE ID ดิบ (server ตัดออกแล้ว)
 */
const INBOUND = '/api/v1/line-pilot/inbound';

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

export interface LineInboundApi {
  list(input?: { limit?: number; before?: string }): Promise<LineInboundPage>;
  /** 404 = ไม่มี overlay, 403 = มี overlay แต่บัญชีนี้ไม่มีสิทธิ์ */
  availability(): Promise<LineInboundAvailability>;
}

export function createLineInboundApi(options: {
  baseUrl: string;
  accessToken: () => string | undefined;
  fetch?: typeof globalThis.fetch;
}): LineInboundApi {
  const http = options.fetch ?? globalThis.fetch.bind(globalThis);
  async function get(query: URLSearchParams): Promise<Response> {
    const token = options.accessToken();
    const suffix = query.size > 0 ? `?${query.toString()}` : '';
    return http(`${options.baseUrl}${INBOUND}${suffix}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
  }
  return {
    async list(input = {}) {
      const query = new URLSearchParams({ limit: String(input.limit ?? 50) });
      if (input.before) query.set('before', input.before);
      const response = await get(query);
      if (!response.ok) throw new LineInboundApiError(response.status);
      return (await response.json()) as LineInboundPage;
    },
    async availability() {
      const response = await get(new URLSearchParams({ limit: '1' }));
      if (response.status === 404) return 'UNAVAILABLE';
      if (response.status === 403) return 'FORBIDDEN';
      if (!response.ok) throw new LineInboundApiError(response.status);
      return 'AVAILABLE';
    },
  };
}
