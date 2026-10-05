/**
 * E1.15 (#489): แกนของ `<dphone-launcher>` ที่ไม่พึ่ง DOM (E1.7 #463 ข้อ 3)
 *
 * host ไม่ต้องเขียนการตรวจ origin/source และ ack เอง:
 * - รับเฉพาะข้อความที่ `origin` = dphone origin แบบ exact และ `source` = iframe ของ launcher นี้
 * - ส่งออกด้วย `targetOrigin` = dphone origin แบบ exact เท่านั้น
 * - `dphone.activity` → เรียก handler ของ host แล้ว ack ให้อัตโนมัติเมื่อ handler ทุกตัวจบสำเร็จ
 *   (handler ล้ม = ไม่ ack → dphone ส่งซ้ำด้วย interactionId เดิม)
 * - `call()` ก่อน `dphone.ready` เข้าคิวไว้ส่งหลัง ready; resolve เมื่อได้ผลที่ไม่ใช่ `prefilled`
 * - ข้อความ `v` อื่น/type ที่ไม่รู้จักไม่สนใจ (v1 เพิ่มได้อย่างเดียว)
 */
import {
  DPHONE_EMBED_PROTOCOL_VERSION,
  type ActivityMessage,
  type CallResultMessage,
  type DphoneErrorMessage,
  type DphoneReadyMessage,
  type DphoneToHostMessage,
  type HostToDphoneMessage,
  type ScreenPopMessage,
} from './protocol.js';

const KNOWN = new Set([
  'dphone.ready',
  'dphone.screenpop',
  'dphone.call.result',
  'dphone.activity',
  'dphone.error',
]);

/** ข้อความจาก dphone (ผ่านการตรวจ origin/source แล้ว) — รูปแบบผิด/ไม่รู้จัก = null */
export function parseDphoneMessage(data: unknown): DphoneToHostMessage | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const message = data as { v?: unknown; type?: unknown };
  if (message.v !== DPHONE_EMBED_PROTOCOL_VERSION || typeof message.type !== 'string') return null;
  if (!KNOWN.has(message.type)) return null;
  if (message.type === 'dphone.activity') {
    const activity = data as Partial<ActivityMessage>;
    if (typeof activity.interactionId !== 'string') return null;
  }
  if (message.type === 'dphone.call.result') {
    const result = data as Partial<CallResultMessage>;
    if (typeof result.requestId !== 'string' || typeof result.status !== 'string') return null;
  }
  return data as DphoneToHostMessage;
}

export interface LauncherEvents {
  ready(message: DphoneReadyMessage): void;
  screenpop(message: ScreenPopMessage): void;
  /** handler คืน Promise ได้ — ack เมื่อทุก handler resolve */
  activity(message: ActivityMessage): unknown;
  callresult(message: CallResultMessage): void;
  error(message: DphoneErrorMessage): void;
}

export interface LauncherCoreOptions {
  dphoneOrigin: string;
  /** window ของ iframe (ใช้เทียบ `event.source` และส่งข้อความ) */
  target(): { postMessage(message: unknown, targetOrigin: string): void } | null;
  emit<K extends keyof LauncherEvents>(
    type: K,
    message: Parameters<LauncherEvents[K]>[0],
  ): unknown[];
  requestId(): string;
}

export interface CallOptions {
  contactId?: string;
}

export class LauncherCore {
  private ready: DphoneReadyMessage | null = null;
  private activeCall = false;
  private readonly queue: HostToDphoneMessage[] = [];
  private readonly calls = new Map<
    string,
    { resolve(result: CallResultMessage): void; reject(error: Error): void }
  >();

  constructor(private readonly options: LauncherCoreOptions) {}

  get capabilities(): DphoneReadyMessage['capabilities'] | null {
    return this.ready?.capabilities ?? null;
  }

  get hasActiveCall(): boolean {
    return this.activeCall;
  }

  /** handler ของ `message` บน window ของ host — คืน true เมื่อเป็นข้อความของ dphone นี้ */
  handle(event: { origin: string; source: unknown; data: unknown }): boolean {
    const target = this.options.target();
    if (!target || event.origin !== this.options.dphoneOrigin || event.source !== target) {
      return false;
    }
    const message = parseDphoneMessage(event.data);
    if (!message) return false;
    switch (message.type) {
      case 'dphone.ready':
        this.ready = message;
        this.options.emit('ready', message);
        for (const queued of this.queue.splice(0)) this.post(queued);
        break;
      case 'dphone.screenpop':
        if (message.callState === 'ACTIVE' || message.callState === 'HELD') this.activeCall = true;
        if (message.callState === 'ENDED') this.activeCall = false;
        this.options.emit('screenpop', message);
        break;
      case 'dphone.activity':
        this.activeCall = false;
        void this.activity(message);
        break;
      case 'dphone.call.result': {
        this.options.emit('callresult', message);
        const pending = this.calls.get(message.requestId);
        if (pending && message.status !== 'prefilled') {
          this.calls.delete(message.requestId);
          pending.resolve(message);
        }
        break;
      }
      case 'dphone.error': {
        this.options.emit('error', message);
        const pending = message.requestId ? this.calls.get(message.requestId) : undefined;
        if (pending && message.requestId) {
          this.calls.delete(message.requestId);
          pending.reject(new Error(message.code));
        }
        break;
      }
    }
    return true;
  }

  /** กรอกเบอร์ใน dphone — agent ต้องกดโทรเอง; resolve ด้วยผลสุดท้าย (ไม่ใช่ `prefilled`) */
  call(number: string, options: CallOptions = {}): Promise<CallResultMessage> {
    const requestId = this.options.requestId();
    const message: HostToDphoneMessage = {
      v: 1,
      type: 'dphone.call',
      requestId,
      number,
      ...(options.contactId ? { contactId: options.contactId } : {}),
    };
    const result = new Promise<CallResultMessage>((resolve, reject) => {
      this.calls.set(requestId, { resolve, reject });
    });
    if (this.ready) this.post(message);
    else this.queue.push(message);
    return result;
  }

  private async activity(message: ActivityMessage) {
    const results = this.options.emit('activity', message);
    try {
      await Promise.all(results);
    } catch {
      return; // handler ของ host ล้ม → ไม่ ack ให้ dphone ส่งซ้ำ
    }
    this.post({ v: 1, type: 'dphone.activity.ack', interactionId: message.interactionId });
  }

  private post(message: HostToDphoneMessage) {
    this.options.target()?.postMessage(message, this.options.dphoneOrigin);
  }
}
