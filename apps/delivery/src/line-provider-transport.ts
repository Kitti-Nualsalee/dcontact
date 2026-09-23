/**
 * Owner: Delivery/Channels — LINE Messaging API transport (S2.4 #370, #357 §1/§3)
 *
 * ขอบเขตของ S2: เรียกได้เฉพาะ `POST /v2/bot/message/push` แบบ one-to-one หนึ่งผู้รับต่อหนึ่ง
 * logical delivery — ไม่มี multicast/narrowcast/broadcast และไม่มี free text
 *
 * transport ชั้นนี้ "ไม่ตัดสินใจ" อะไรเลย: ไม่ retry เอง ไม่แปลผลเป็น business outcome และไม่
 * mint key ใหม่ หน้าที่มีแค่ยิง exact request ที่ผู้เรียกเตรียมไว้แล้วคืนสิ่งที่ provider ตอบ
 * การตีความอยู่ที่ `classifyLineResponse` เพื่อให้ mapping ตรวจได้ด้วย unit test โดยไม่ต้องมี network
 *
 * ค่าที่ห้ามหลุด: access token, raw recipient (`to`) และเนื้อหาข้อความ ไม่ถูก log หรือใส่ใน error
 */
import type { LineProviderOutcomeCode, LineRejectionScope } from '@d-contact/cxa-contracts';

export const LINE_PUSH_PATH = '/v2/bot/message/push';
export const LINE_API_BASE_URL = 'https://api.line.me';
/** LINE ตอบภายในไม่กี่วินาที; เกินกว่านี้ถือว่าไม่รู้ผลและต้อง reconcile ด้วย key เดิม */
export const LINE_REQUEST_TIMEOUT_MS = 10_000;

export interface LinePushRequest {
  /** opaque recipient ที่ resolve จาก protected binding แล้ว — ห้าม log */
  to: string;
  messages: ReadonlyArray<Record<string, unknown>>;
  /** ค่าเดิมของ delivery นี้เสมอ (#357 §2) — ห้าม mint ใหม่ตอน retry */
  retryKey: string;
  accessToken: string;
}

export interface LinePushResponse {
  httpStatus: number;
  /** `x-line-request-id` ของ request นี้ */
  requestId?: string;
  /** `x-line-accepted-request-id` ที่มากับ 409 เมื่อ request ก่อนหน้าถูก accept ไปแล้ว */
  acceptedRequestId?: string;
  sentMessageIds?: readonly string[];
  /** error code ของ provider แบบ machine-readable เท่านั้น ไม่ใช่ข้อความอิสระ */
  errorCode?: string;
}

/** ผลที่ transport คืนได้: มี response จริง หรือไม่รู้ผลเลย (timeout/socket/ผิด contract) */
export type LineTransportResult =
  | { kind: 'RESPONSE'; response: LinePushResponse }
  | { kind: 'NO_RESPONSE'; reason: 'TIMEOUT' | 'NETWORK' | 'INVALID_RESPONSE' };

export interface LineQuotaView {
  type: string;
  value: number | null;
}

export interface LineTokenVerification {
  valid: boolean;
  expiresInSeconds?: number;
}

/**
 * owner-local port (#362 §4) — implementation จริงคุยกับ LINE ส่วนเทสต์ใช้ double ที่ deterministic
 * ทั้งสองต้องเคารพข้อเดียวกัน: หนึ่งการเรียกคือหนึ่ง HTTP request ไม่มี retry ซ่อนอยู่ข้างใน
 */
export interface LineProviderTransport {
  verifyToken(accessToken: string): Promise<LineTokenVerification>;
  getQuota(accessToken: string): Promise<LineQuotaView>;
  getConsumption(accessToken: string): Promise<{ totalUsage: number }>;
  validatePush(
    request: Omit<LinePushRequest, 'retryKey'>,
  ): Promise<{ valid: boolean; errorCode?: string }>;
  push(request: LinePushRequest): Promise<LineTransportResult>;
}

export interface LineClassification {
  outcomeCode: LineProviderOutcomeCode;
  rejectionScope?: LineRejectionScope;
  /** true เมื่อ provider ยืนยันว่ารับ request ไว้แล้ว (2xx หรือ 409 replay) */
  accepted: boolean;
  /** true เมื่อผลยังไม่ทราบและต้อง reconcile ด้วย request เดิม */
  reconcile: boolean;
}

const ACCEPTED_2XX: LineClassification = {
  outcomeCode: 'LINE_ACCEPTED',
  accepted: true,
  reconcile: false,
};

/**
 * ตาราง #357 §3 ทั้งตารางอยู่ในฟังก์ชันเดียวเพื่อให้ mapping ตรวจซ้ำได้จากที่เดียว
 *
 * หลักที่ห้ามเพี้ยน:
 * - `2xx` และ `409 + accepted request id` = provider accepted (ไม่ใช่ delivered) และห้าม retry
 * - `4xx` อื่นเป็น terminal — LINE ระบุว่าไม่ควร retry; `401/403` เป็นสัญญาณ account-level
 * - `5xx`, timeout, network และ response ที่ผิด contract = ไม่รู้ผล ต้อง reconcile ด้วย key เดิม
 * - `409` ที่ไม่มี accepted request id ถือว่า response ผิด contract ไม่ใช่ acceptance
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
    // 2xx ที่ไม่มี sentMessages ถือว่าผิด contract — ห้ามเดาว่า accepted
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
    // 400/404 ผูกกับ recipient/payload ของ delivery ใบนี้ จึงนับเป็น Attempt (#361 §B)
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
 * implementation จริง — ไม่ถูกใช้ใน automated test ตาม stop condition ของ #370
 * (`ordinary tests/PR` ห้ามมี provider traffic) แต่ต้องมีอยู่เพื่อให้ pilot รันได้จริง
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
      // ไม่รู้ผล = อาจถูก accept ไปแล้ว ห้ามสรุปว่าไม่ได้ส่ง (#357 §3)
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
      { expires_in?: number } | undefined;
    return {
      valid: true,
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

  /** dry-run ของ LINE: ตรวจรูป payload โดยไม่ส่งจริง ใช้ตอน PROVIDER_CONFORMANCE (#358) */
  async validatePush(
    request: Omit<LinePushRequest, 'retryKey'>,
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

  private async get<T>(accessToken: string, path: string): Promise<T | undefined> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    return (await response.json().catch(() => undefined)) as T | undefined;
  }
}
