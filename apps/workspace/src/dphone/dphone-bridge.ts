/**
 * D1.15 (#454): สะพานระหว่าง working tab (เจ้าของ SIP session) กับหน้าต่าง dphone ที่แยกออกไป
 *
 * - SIP/WebRTC session อยู่ใน working tab เสมอ — หน้าต่างแยกเป็นแค่ UI ที่ส่ง intent กลับมาผ่าน
 *   BroadcastChannel (same-origin เท่านั้น) จึงแยก/รวมหน้าต่างได้โดยไม่ตัดสายและไม่สร้าง session ใหม่
 * - อยู่ใต้ leader election เดิม: เฉพาะ working tab เป็น host และรับคำสั่ง
 * - ข้อความทุกชนิดมี `v: 1` และถูกตรวจรูปก่อนใช้ — ข้อความแปลกปลอมถูกทิ้งเงียบ ๆ
 * - การฝังในระบบภายนอก (iframe + postMessage + allowlist) เป็นงานของ map E1 ไม่ใช่ช่องทางนี้
 */
import type { DphoneState } from './dphone.js';

export const DPHONE_CHANNEL = 'dcontact.dphone';

export interface DphoneView {
  phase: DphoneState['phase'];
  caller: string | null;
  queueName: string | null;
  muted: boolean;
  locale: 'th' | 'en';
}

export type DphoneCommand =
  | { type: 'accept' }
  | { type: 'toggleMute' }
  | { type: 'toggleHold' }
  | { type: 'hangup' }
  | { type: 'dtmf'; value: string };

type BridgeMessage =
  | { v: 1; kind: 'state'; view: DphoneView }
  | { v: 1; kind: 'command'; command: DphoneCommand }
  | { v: 1; kind: 'hello' }
  | { v: 1; kind: 'bye' }
  | { v: 1; kind: 'closed' };

const COMMANDS = new Set(['accept', 'toggleMute', 'toggleHold', 'hangup', 'dtmf']);

function isMessage(value: unknown): value is BridgeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as {
    v?: unknown;
    kind?: unknown;
    command?: { type?: unknown; value?: unknown };
  };
  if (message.v !== 1) return false;
  if (message.kind === 'command') {
    const command = message.command;
    return (
      typeof command?.type === 'string' &&
      COMMANDS.has(command.type) &&
      (command.type !== 'dtmf' ||
        (typeof command.value === 'string' && /^[0-9*#]$/.test(command.value)))
    );
  }
  return ['state', 'hello', 'bye', 'closed'].includes(String(message.kind));
}

export interface ChannelLike {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

const openChannel = (): ChannelLike => new BroadcastChannel(DPHONE_CHANNEL);

/** ฝั่ง working tab: ส่ง view ล่าสุดให้หน้าต่างแยก และรับคำสั่งจากหน้าต่างนั้น */
export function createDphoneHost(handlers: {
  onCommand(command: DphoneCommand): void;
  /** หน้าต่างแยกเปิดขึ้น (`hello`) หรือปิดไป (`bye`) */
  onRemotePresence(present: boolean): void;
  channel?: ChannelLike;
}) {
  const channel = handlers.channel ?? openChannel();
  let latest: DphoneView | undefined;
  const listener = (event: MessageEvent) => {
    if (!isMessage(event.data)) return;
    if (event.data.kind === 'command') handlers.onCommand(event.data.command);
    if (event.data.kind === 'hello') {
      handlers.onRemotePresence(true);
      if (latest) channel.postMessage({ v: 1, kind: 'state', view: latest });
    }
    if (event.data.kind === 'bye') handlers.onRemotePresence(false);
  };
  channel.addEventListener('message', listener);
  return {
    publish(view: DphoneView) {
      latest = view;
      channel.postMessage({ v: 1, kind: 'state', view });
    },
    /** working tab ดึง dphone กลับ — บอกหน้าต่างแยกให้ปิดตัวเอง */
    recall() {
      channel.postMessage({ v: 1, kind: 'closed' });
    },
    close() {
      channel.removeEventListener('message', listener);
      channel.close();
    },
  };
}

/** ฝั่งหน้าต่างแยก (`/dphone`): รับ view จาก working tab และส่งคำสั่งกลับ */
export function createDphoneRemote(handlers: {
  onView(view: DphoneView): void;
  onClosed(): void;
  channel?: ChannelLike;
}) {
  const channel = handlers.channel ?? openChannel();
  const listener = (event: MessageEvent) => {
    if (!isMessage(event.data)) return;
    if (event.data.kind === 'state') handlers.onView(event.data.view);
    if (event.data.kind === 'closed') handlers.onClosed();
  };
  channel.addEventListener('message', listener);
  channel.postMessage({ v: 1, kind: 'hello' });
  return {
    send(command: DphoneCommand) {
      channel.postMessage({ v: 1, kind: 'command', command });
    },
    close() {
      channel.postMessage({ v: 1, kind: 'bye' });
      channel.removeEventListener('message', listener);
      channel.close();
    },
  };
}
