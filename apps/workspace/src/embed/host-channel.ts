/**
 * E1.14 (#488): ช่องทาง postMessage v1 ระหว่าง dphone ที่ถูกฝังกับ host (E1.5 #461 ข้อ 5, E1.7 #463 ข้อ 2)
 *
 * - ขาเข้า: รับเฉพาะ `lock.accepts()` (origin ที่ล็อก + `source === window.parent` + ยังไม่ถูกเพิกถอน)
 *   แล้ว parse ตาม schema v1 — type ที่ไม่รู้จักไม่สนใจ, `v` ไม่รองรับตอบ `unsupported_version`
 * - ขาออก: `targetOrigin` = origin ที่ล็อกไว้แบบ exact เสมอ (ไม่มี `*`) และหยุดส่งเมื่อ origin ถูกเพิกถอน
 * - `dphone.call` จาก host ถูกจำกัดอัตรา; channel ไม่โทรออกเอง — ส่งให้ `onCall` ไปกรอกเบอร์ใน dphone
 */
import {
  DPHONE_EMBED_PROTOCOL_VERSION,
  parseHostMessage,
  type CallRequestMessage,
  type DphoneCapabilities,
  type DphoneToHostMessage,
  type ScreenPopSetting,
} from '@d-contact/dphone-embed';
import type { HostOriginLock } from './origin-lock.js';

export interface HostWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface HostChannelOptions {
  lock: HostOriginLock;
  host: HostWindow;
  now(): number;
  onCall(request: CallRequestMessage): void;
  onActivityAck(interactionId: string): void;
  /** จำนวน `dphone.call` สูงสุดต่อหน้าต่างเวลา (ค่าเริ่มต้น 5 ครั้ง / 10 วินาที) */
  callRate?: { limit: number; windowMs: number };
}

export class HostChannel {
  private readonly callTimes: number[] = [];

  constructor(private readonly options: HostChannelOptions) {}

  /** ส่งไป host ที่ล็อกไว้ — คืน false เมื่อ origin ถูกเพิกถอนแล้ว (ไม่ส่ง) */
  send(message: DphoneToHostMessage): boolean {
    if (this.options.lock.revoked) return false;
    this.options.host.postMessage(message, this.options.lock.origin);
    return true;
  }

  ready(capabilities: DphoneCapabilities, screenPopLevel: ScreenPopSetting): boolean {
    return this.send({ v: 1, type: 'dphone.ready', capabilities, screenPopLevel });
  }

  /** handler ของ `message` event บน window ของ iframe — คืน true เมื่อข้อความถูกรับ */
  handle(event: { origin: string; source: unknown; data: unknown }): boolean {
    if (!this.options.lock.accepts(event)) return false;
    const parsed = parseHostMessage(event.data);
    if (parsed.kind === 'ignore') return false;
    if (parsed.kind === 'error') {
      this.send({
        v: 1,
        type: 'dphone.error',
        code: parsed.code,
        supportedVersions: [DPHONE_EMBED_PROTOCOL_VERSION],
        ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
      });
      return true;
    }
    const { message } = parsed;
    if (message.type === 'dphone.activity.ack') {
      this.options.onActivityAck(message.interactionId);
      return true;
    }
    if (!this.allowCall()) {
      this.send({
        v: 1,
        type: 'dphone.call.result',
        requestId: message.requestId,
        status: 'rate_limited',
        blocked: true,
        reasonCode: 'RATE_LIMITED',
      });
      return true;
    }
    this.options.onCall(message);
    return true;
  }

  private allowCall(): boolean {
    const { limit, windowMs } = this.options.callRate ?? { limit: 5, windowMs: 10_000 };
    const now = this.options.now();
    while (this.callTimes.length && now - this.callTimes[0]! >= windowMs) this.callTimes.shift();
    if (this.callTimes.length >= limit) return false;
    this.callTimes.push(now);
    return true;
  }
}
