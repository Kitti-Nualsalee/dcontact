/**
 * D1.15 (#454): bridge between the working tab (owner of the SIP session) and the detached dphone window
 *
 * - the SIP/WebRTC session always lives in the working tab — the detached window is only a UI that sends intents back through
 *   BroadcastChannel (same-origin only), so the window can be detached/merged without cutting the call or creating a new session
 * - only the work point is the host and accepts commands: the tab that holds the work-session lease (or still has a call in hand after losing the lease)
 *   — E1.12 #486; #583 enforces the lease for every tenant
 * - every message has `v: 1` and is shape-checked before use — foreign messages are silently dropped
 * - the detached window has a `remote` id that the working tab creates when detaching: the host listens only to that id, so a `/dphone` page opened by itself
 *   (bookmark) or another window does not switch the detached state and cannot control calls
 * - embedding in an external system (iframe + postMessage + allowlist) belongs to map E1, not this channel
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

/** working tab side: send the latest view to its own detached window and accept commands only from that window */
export function createDphoneHost(handlers: {
  onCommand(command: DphoneCommand): void;
  /** the detached window the working tab opened (`hello`) or closed (`bye`) */
  onRemotePresence(present: boolean): void;
  /** id of the detached window the working tab has open — none = accept no window at all */
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
    /** the working tab pulls dphone back — tells its own detached window to close itself */
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

/** detached window side (`/dphone?remote=<id>`): receives the view for its own id and sends commands back */
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
