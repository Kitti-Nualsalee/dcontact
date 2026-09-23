/**
 * Owner: Delivery/Channels — `POST /webhook/line` ของ S2 singleton profile (S2.5 #369)
 *
 * Authority: webhook decision #359 และ Phase Contract #362 §7
 *
 * ลำดับที่เปลี่ยนไม่ได้:
 * 1. ตรวจ method/content type/ขนาดก่อน — ยังไม่ดู body
 * 2. verify HMAC บน raw bytes ด้วย secret ของ trusted binding — ผิดคือ fixed `401` และจบทันที
 *    ไม่ parse, ไม่ process, ไม่ persist, ไม่ log body หรือ signature
 * 3. parse → เข้ารหัส event ทีละตัว → commit inbox + ciphertext แบบ atomic ใน transaction เดียว
 * 4. ตอบ `200` หลัง commit เท่านั้น; commit ล้มคือ `503` ให้ LINE redeliver
 *
 * งานที่ช้า (projection, correlation, Touch) อยู่ใน worker ทั้งหมด ingress จึงไม่รอ downstream
 *
 * **singleton เท่านั้น**: binding ผูกกับ test OA เดียวจาก deploy config — production หรือ
 * multi-account ต้องใช้ opaque endpoint binding ต่อ channel ก่อนเปิด traffic (#359 CONFIRMED)
 */
import { randomUUID } from 'node:crypto';
import type { LineWebhookCode } from '@d-contact/cxa-contracts';
import { parseLineWebhook } from './line-webhook-event.js';
import { sealLinePayload, type LinePayloadKeyring } from './line-protected-payload.js';
import type { LineWebhookRepository } from './line-webhook-repository.js';
import { verifyLineSignature, type LineChannelSecret } from './line-webhook-signature.js';

export const LINE_WEBHOOK_PATH = '/webhook/line';
/** LINE webhook จริงมีขนาดไม่กี่ KB; เพดานนี้กันการอ่าน body ใหญ่ก่อน verify */
export const LINE_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

export interface LineWebhookBinding {
  tenantId: string;
  /** LINE Channel ID ของ test OA (`2007056595`) */
  channelAccountId: string;
  /** bot user ID ที่ `destination` ต้องตรง — ตรวจหลัง signature ผ่านแล้วเท่านั้น */
  expectedDestination: string;
  secret: LineChannelSecret;
}

export interface LineWebhookRequest {
  method: string;
  contentType: string | undefined;
  signature: string | undefined;
  rawBody: Buffer;
  receivedAt: Date;
}

/** code ที่ไม่ใช่ของ #359 §G ใช้เฉพาะ request ที่ถูกปัดตกก่อนถึงขั้น signature */
export type LineWebhookIngressCode =
  | LineWebhookCode
  | 'WEBHOOK_METHOD_NOT_ALLOWED'
  | 'WEBHOOK_UNSUPPORTED_MEDIA_TYPE'
  | 'WEBHOOK_PAYLOAD_TOO_LARGE';

export interface LineWebhookResult {
  status: 200 | 400 | 401 | 405 | 413 | 415 | 503;
  code: LineWebhookIngressCode;
  /** จำนวนต่อผลลัพธ์ สำหรับ metric — ไม่มี event ID หรือ payload */
  counts?: Partial<Record<LineWebhookCode, number>>;
}

export interface LineWebhookIngressOptions {
  binding: LineWebhookBinding;
  repository: Pick<LineWebhookRepository, 'acceptBatch'>;
  keyring: LinePayloadKeyring;
  newId?: () => string;
}

/** opaque ref ที่ inbox, evidence และ `cg_touches` ใช้แทน event — ไม่มี PII */
export function lineWebhookPayloadRef(
  channelAccountId: string,
  webhookEventId: string,
  payloadHash: string,
): string {
  return `lwp:${channelAccountId}:${webhookEventId}:${payloadHash.slice(0, 16)}`;
}

export function lineResponseEvidenceRef(channelAccountId: string, webhookEventId: string): string {
  return `line-webhook:${channelAccountId}:${webhookEventId}`;
}

export class LineWebhookIngress {
  private readonly newId: () => string;

  constructor(private readonly options: LineWebhookIngressOptions) {
    this.newId = options.newId ?? randomUUID;
  }

  async handle(request: LineWebhookRequest): Promise<LineWebhookResult> {
    if (request.method !== 'POST') return { status: 405, code: 'WEBHOOK_METHOD_NOT_ALLOWED' };
    const mediaType = request.contentType?.split(';', 1)[0]?.trim().toLowerCase();
    if (mediaType !== 'application/json') {
      return { status: 415, code: 'WEBHOOK_UNSUPPORTED_MEDIA_TYPE' };
    }
    if (request.rawBody.length > LINE_WEBHOOK_MAX_BODY_BYTES) {
      return { status: 413, code: 'WEBHOOK_PAYLOAD_TOO_LARGE' };
    }

    const { binding } = this.options;
    if (!verifyLineSignature(request.rawBody, request.signature, binding.secret)) {
      return { status: 401, code: 'WEBHOOK_SIGNATURE_INVALID' };
    }

    const webhook = parseLineWebhook(request.rawBody);
    if (!webhook) return { status: 400, code: 'WEBHOOK_SCHEMA_INVALID' };
    if (webhook.events.length === 0) return { status: 200, code: 'WEBHOOK_EMPTY_VERIFICATION' };

    // destination ผิด = request ที่ลงนามถูกแต่ไม่ได้มาหา binding นี้ — เก็บ + กัก + ตอบ 2xx
    // เพื่อไม่ให้ LINE redeliver ซ้ำไม่รู้จบ (#359 §A)
    const destinationMismatch = webhook.destination !== binding.expectedDestination;

    const events = webhook.events.map((event) => ({
      id: this.newId(),
      webhookEventId: event.webhookEventId,
      payloadHash: event.payloadHash,
      eventType: event.eventType,
      deliveryMode: event.deliveryMode,
      isRedelivery: event.isRedelivery,
      providerTimestamp: event.providerTimestamp,
      protectedPayloadRef: lineWebhookPayloadRef(
        binding.channelAccountId,
        event.webhookEventId,
        event.payloadHash,
      ),
    }));
    const payloads = webhook.events.map((event, index) =>
      sealLinePayload(
        this.options.keyring,
        binding.tenantId,
        events[index]!.protectedPayloadRef,
        event.plaintext,
      ),
    );

    let accepted;
    try {
      accepted = await this.options.repository.acceptBatch({
        tenantId: binding.tenantId,
        channelAccountId: binding.channelAccountId,
        receivedAt: request.receivedAt,
        events,
        payloads,
        ...(destinationMismatch
          ? { quarantineAccepted: 'WEBHOOK_DESTINATION_MISMATCH' as const }
          : {}),
      });
    } catch {
      // ห้ามตอบ 2xx ก่อน durable commit — ไม่ส่ง error ต่อเพราะอาจมีรายละเอียดของ payload
      return { status: 503, code: 'WEBHOOK_DURABILITY_UNAVAILABLE' };
    }

    const counts: Partial<Record<LineWebhookCode, number>> = {};
    for (const result of accepted) {
      const code =
        destinationMismatch && result.code === 'WEBHOOK_ACCEPTED'
          ? 'WEBHOOK_DESTINATION_MISMATCH'
          : result.code;
      counts[code] = (counts[code] ?? 0) + 1;
    }
    return {
      status: 200,
      code: destinationMismatch ? 'WEBHOOK_DESTINATION_MISMATCH' : 'WEBHOOK_ACCEPTED',
      counts,
    };
  }
}
