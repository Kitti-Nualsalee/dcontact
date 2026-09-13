/**
 * J2.9 — synthetic, TEST_ADAPTER-only telephony transport for the Dialer
 * originate barrier. Hard boundary: `actualProviderTraffic=false` — this file
 * (and `dialer-originate-barrier.ts`) must never gain a real ESL client,
 * telephony provider SDK, socket, DNS or HTTP dependency. `dialer-telephony-
 * evidence.test.ts` negative-scans this module's own source text to prove it.
 */
export const TELEPHONY_TEST_ADAPTER = 'TEST_ADAPTER' as const;

export interface TelephonyOriginateRequest {
  adapter: string;
  targetKind: 'campaign_target' | 'callback';
  targetId: string;
  providerRequestKey: string;
}

export type TelephonyOriginateResponse =
  | { status: 'ACCEPTED' }
  | { status: 'REJECTED'; reasonCode: string };

export interface TelephonyTransport {
  originate(request: TelephonyOriginateRequest): Promise<TelephonyOriginateResponse>;
}

export class ProviderTrafficNotAllowedError extends Error {
  readonly code = 'PROVIDER_TRAFFIC_NOT_ALLOWED';

  constructor(readonly adapter: string) {
    super(`Dialer originate barrier ไม่รับ adapter อื่นนอกจาก ${TELEPHONY_TEST_ADAPTER}: ${adapter}`);
    this.name = 'ProviderTrafficNotAllowedError';
  }
}

export type ScriptedTelephonyResponse = TelephonyOriginateResponse;

/**
 * ตอบตามสคริปต์ที่ตั้งไว้ล่วงหน้าต่อ `targetId` (default `ACCEPTED`) — ไม่มี network I/O,
 * ไม่มี timer จริง เพื่อให้ test deterministic
 */
export class ScriptedTelephonyTransport implements TelephonyTransport {
  private readonly scripted = new Map<string, ScriptedTelephonyResponse>();

  script(targetId: string, response: ScriptedTelephonyResponse): void {
    this.scripted.set(targetId, response);
  }

  async originate(request: TelephonyOriginateRequest): Promise<TelephonyOriginateResponse> {
    if (request.adapter !== TELEPHONY_TEST_ADAPTER) {
      throw new ProviderTrafficNotAllowedError(request.adapter);
    }
    return this.scripted.get(request.targetId) ?? { status: 'ACCEPTED' };
  }
}
