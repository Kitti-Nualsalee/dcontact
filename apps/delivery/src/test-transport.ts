/**
 * Owner: Channels/Dialer — transport ของ TEST_ADAPTER
 *
 * C1 ไม่เปิด provider traffic: transport นี้ไม่มี credential, ไม่เปิด socket และไม่
 * import provider SDK ใด ๆ ผลลัพธ์มาจาก script ที่ test ป้อนเข้ามาเท่านั้น ทุก request
 * ต้องประกาศ `adapter: 'TEST_ADAPTER'` — ถ้ามีคนต่อ transport นี้เข้ากับ adapter อื่น
 * ในอนาคต จะพังทันทีแทนที่จะเงียบแล้วส่งของจริง
 */
import type { ContactChannel } from '@d-contact/cxa-contracts';

export type DeliveryAdapterName = 'TEST_ADAPTER';

export const TEST_ADAPTER: DeliveryAdapterName = 'TEST_ADAPTER';

export interface TransportRequest {
  adapter: DeliveryAdapterName;
  deliveryId: string;
  providerRequestKey: string;
  channel: ContactChannel;
  /** reference เท่านั้น — transport ไม่เคยเห็นเนื้อหาหรือปลายทางจริง */
  contentRef: string;
}

/** ผลจาก provider ที่ยังไม่ normalize; `TIMEOUT` แปลว่าไม่รู้ผล ห้ามเดาว่าไม่ได้ส่ง */
export type TransportResponse =
  { status: 'ACCEPTED' } | { status: 'REJECTED'; reasonCode: string } | { status: 'TIMEOUT' };

export interface DeliveryTransport {
  submit(request: TransportRequest): Promise<TransportResponse>;
}

export class ProviderTrafficNotAllowedError extends Error {
  readonly code = 'PROVIDER_TRAFFIC_NOT_ALLOWED';

  constructor(adapter: string) {
    super(`transport นี้รับได้เฉพาะ TEST_ADAPTER ไม่ใช่ ${adapter}`);
    this.name = 'ProviderTrafficNotAllowedError';
  }
}

/**
 * บันทึกทุก request ที่เข้ามาเพื่อให้ test ยืนยันได้ว่า retry/crash ไม่ทำให้ส่งซ้ำ
 * ค่า default คือ ACCEPTED; `script` ป้อนผลรายครั้งตามลำดับ
 */
export class ScriptedTestTransport implements DeliveryTransport {
  readonly requests: TransportRequest[] = [];
  private readonly script: TransportResponse[];

  constructor(script: TransportResponse[] = []) {
    this.script = [...script];
  }

  /** จำนวนครั้งที่ providerRequestKey นี้ถูกส่งเข้า transport — ต้องไม่เกิน 1 เสมอ */
  submissionsFor(providerRequestKey: string): number {
    return this.requests.filter((request) => request.providerRequestKey === providerRequestKey)
      .length;
  }

  async submit(request: TransportRequest): Promise<TransportResponse> {
    if (request.adapter !== TEST_ADAPTER) throw new ProviderTrafficNotAllowedError(request.adapter);
    this.requests.push(request);
    return this.script.shift() ?? { status: 'ACCEPTED' };
  }
}
