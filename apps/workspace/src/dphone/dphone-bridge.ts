/**
 * D1.15 (#454): สะพานระหว่าง working tab (เจ้าของ SIP session) กับหน้าต่าง dphone ที่แยกออกไป
 *
 * - SIP/WebRTC session อยู่ใน working tab เสมอ — หน้าต่างแยกเป็นแค่ UI ที่ส่ง intent กลับมาผ่าน
 *   BroadcastChannel (same-origin เท่านั้น) จึงแยก/รวมหน้าต่างได้โดยไม่ตัดสายและไม่สร้าง session ใหม่
 * - อยู่ใต้ leader election เดิม: เฉพาะ working tab เป็น host และรับคำสั่ง
 * - ข้อความทุกชนิดมี `v: 1` และถูกตรวจรูปก่อนใช้ — ข้อความแปลกปลอมถูกทิ้งเงียบ ๆ
 * - หน้าต่างแยกมี `remote` id ที่ working tab สร้างตอนกดแยก: host ฟังเฉพาะ id นั้น หน้า `/dphone` ที่เปิดเอง
 *   (bookmark) หรือหน้าต่างอื่นจึงไม่สลับสถานะ detached และสั่งสายไม่ได้
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
  | { v: 1; kind: 'state'; remote: string; view: DphoneView }
  | { v: 1; kind: 'command'; remote: string; command: DphoneCommand }
  | { v: 1; kind: 'hello'; remote: string }
  | { v: 1; kind: 'bye'; remote: string }
  | { v: 1; kind: 'closed'; remote: string };

const COMMANDS = new Set(['accept', 'toggleMute', 'toggleHold', 'hangup', 'dtmf']);

function isMessage(value: unknown): value is BridgeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as {
    v?: unknown;
    kind?: unknown;
    remote?: unknown;
    command?: { type?: unknown; value?: unknown };
  };
  if (message.v !== 1 || typeof message.remote !== 'string' || message.remote.length === 0)
    return false;
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

/** ฝั่ง working tab: ส่ง view ล่าสุดให้หน้าต่างแยกของตัวเอง และรับคำสั่งจากหน้าต่างนั้นเท่านั้น */
export function createDphoneHost(handlers: {
  onCommand(command: DphoneCommand): void;
  /** หน้าต่างแยกที่ working tab เปิด (`hello`) หรือปิดไป (`bye`) */
  onRemotePresence(present: boolean): void;
  /** id ของหน้าต่างแยกที่ working tab เปิดอยู่ — ไม่มี = ไม่รับหน้าต่างใดเลย */
  expectedRemote(): string | undefined;
  channel?: ChannelLike;
}) {
  const channel = handlers.channel ?? openChannel();
  let latest: DphoneView | undefined;
  const listener = (event: MessageEvent) => {
    if (!isMessage(event.data)) return;
    const remote = handlers.expectedRemote();
    if (!remote || event.data.remote !== remote) return;
    if (event.data.kind === 'command') handlers.onCommand(event.data.command);
    if (event.data.kind === 'hello') {
      handlers.onRemotePresence(true);
      if (latest) channel.postMessage({ v: 1, kind: 'state', remote, view: latest });
    }
    if (event.data.kind === 'bye') handlers.onRemotePresence(false);
  };
  channel.addEventListener('message', listener);
  return {
    publish(view: DphoneView) {
      latest = view;
      const remote = handlers.expectedRemote();
      if (remote) channel.postMessage({ v: 1, kind: 'state', remote, view });
    },
    /** working tab ดึง dphone กลับ — บอกหน้าต่างแยกของตัวเองให้ปิดตัวเอง */
    recall() {
      const remote = handlers.expectedRemote();
      if (remote) channel.postMessage({ v: 1, kind: 'closed', remote });
    },
    close() {
      channel.removeEventListener('message', listener);
      channel.close();
    },
  };
}

/** ฝั่งหน้าต่างแยก (`/dphone?remote=<id>`): รับ view ของ id ตัวเองและส่งคำสั่งกลับ */
export function createDphoneRemote(handlers: {
  remote: string;
  onView(view: DphoneView): void;
  onClosed(): void;
  channel?: ChannelLike;
}) {
  const channel = handlers.channel ?? openChannel();
  const { remote } = handlers;
  const listener = (event: MessageEvent) => {
    if (!isMessage(event.data) || event.data.remote !== remote) return;
    if (event.data.kind === 'state') handlers.onView(event.data.view);
    if (event.data.kind === 'closed') handlers.onClosed();
  };
  channel.addEventListener('message', listener);
  channel.postMessage({ v: 1, kind: 'hello', remote });
  return {
    send(command: DphoneCommand) {
      channel.postMessage({ v: 1, kind: 'command', remote, command });
    },
    close() {
      channel.postMessage({ v: 1, kind: 'bye', remote });
      channel.removeEventListener('message', listener);
      channel.close();
    },
  };
}
