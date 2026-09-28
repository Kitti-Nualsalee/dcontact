/**
 * E1.14 (#488): คิวของ `dphone.activity` ที่รอ host ack (E1.6 #462 ข้อ 4)
 *
 * - เก็บใน `sessionStorage` ของแท็บ (partition ตาม host) จึงอยู่รอด reload แล้วส่งซ้ำได้
 * - `interactionId` เป็น idempotency key: เข้าคิวซ้ำด้วย id เดิมแทนที่รายการเดิม (ไม่เพิ่ม) และ
 *   `requestId` คงเดิมตลอดการส่งซ้ำ — host เห็นข้อความเดิมเสมอ
 * - ส่งซ้ำตาม backoff จนได้ `dphone.activity.ack`; ข้อความไม่มีไฟล์เสียง, transcript หรือโน้ต
 *   เพราะสร้างจาก type `ActivityMessage` ซึ่งไม่มี field เหล่านั้น และคัดลอกเฉพาะ field ที่รู้จัก
 */
import type { ActivityMessage } from '@d-contact/dphone-embed';

export const ACTIVITY_RESEND_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

interface Entry {
  message: ActivityMessage;
  attempts: number;
}

export interface ActivityOutboxDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  storageKey: string;
  send(message: ActivityMessage): boolean;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

function pick(message: ActivityMessage): ActivityMessage {
  const copy: ActivityMessage = {
    v: 1,
    type: 'dphone.activity',
    requestId: message.requestId,
    interactionId: message.interactionId,
    direction: message.direction,
    startedAt: message.startedAt,
    endedAt: message.endedAt,
    durationSeconds: message.durationSeconds,
  };
  if (message.contactId) copy.contactId = message.contactId;
  if (message.disposition) copy.disposition = message.disposition;
  if (message.wrapUpCode) copy.wrapUpCode = message.wrapUpCode;
  if (message.queue) copy.queue = { id: message.queue.id, name: message.queue.name };
  return copy;
}

export class ActivityOutbox {
  private entries: Entry[];
  private readonly timers = new Map<string, unknown>();

  constructor(private readonly deps: ActivityOutboxDeps) {
    this.entries = this.load();
  }

  get pending(): readonly ActivityMessage[] {
    return this.entries.map((entry) => entry.message);
  }

  /** เข้าคิวแล้วส่งทันที — interactionId เดิมใช้ requestId เดิม (ส่งซ้ำ ไม่ใช่ข้อความใหม่) */
  enqueue(message: ActivityMessage): void {
    const existing = this.entries.find(
      (entry) => entry.message.interactionId === message.interactionId,
    );
    const next = pick({ ...message, requestId: existing?.message.requestId ?? message.requestId });
    if (existing) existing.message = next;
    else this.entries.push({ message: next, attempts: 0 });
    this.save();
    this.deliver(message.interactionId);
  }

  /** หลัง reload หรือ host ส่ง ready ใหม่: ส่งทุกรายการที่ค้าง */
  resendAll(): void {
    for (const entry of this.entries) this.deliver(entry.message.interactionId);
  }

  ack(interactionId: string): boolean {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => entry.message.interactionId !== interactionId);
    const timer = this.timers.get(interactionId);
    if (timer !== undefined) this.deps.clearTimeout(timer);
    this.timers.delete(interactionId);
    if (this.entries.length === before) return false;
    this.save();
    return true;
  }

  private deliver(interactionId: string) {
    const entry = this.entries.find(
      (candidate) => candidate.message.interactionId === interactionId,
    );
    if (!entry) return;
    const previous = this.timers.get(interactionId);
    if (previous !== undefined) this.deps.clearTimeout(previous);
    this.deps.send(entry.message);
    const delay = ACTIVITY_RESEND_MS[Math.min(entry.attempts, ACTIVITY_RESEND_MS.length - 1)]!;
    entry.attempts += 1;
    this.save();
    this.timers.set(
      interactionId,
      this.deps.setTimeout(() => {
        this.timers.delete(interactionId);
        this.deliver(interactionId);
      }, delay),
    );
  }

  private load(): Entry[] {
    try {
      const raw = this.deps.storage.getItem(this.deps.storageKey);
      const value = raw ? (JSON.parse(raw) as unknown) : [];
      if (!Array.isArray(value)) return [];
      return value
        .filter(
          (entry): entry is Entry =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as Entry).message?.interactionId === 'string' &&
            typeof (entry as Entry).message?.requestId === 'string',
        )
        .map((entry) => ({ message: pick(entry.message), attempts: 0 }));
    } catch {
      return [];
    }
  }

  private save() {
    try {
      if (this.entries.length) {
        this.deps.storage.setItem(this.deps.storageKey, JSON.stringify(this.entries));
      } else {
        this.deps.storage.removeItem(this.deps.storageKey);
      }
    } catch {
      // storage เต็ม/ถูกปิด — คิวใน memory ยังส่งซ้ำได้จนกว่าจะปิดแท็บ
    }
  }
}
