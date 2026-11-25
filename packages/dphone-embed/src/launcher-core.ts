/**
 * E1.15 (#489): DOM-independent core of `<dphone-launcher>` (E1.7 #463 item 3)
 *
 * the host does not need to write origin/source checks and ack itself:
 * - accept only messages whose `origin` = the dphone origin exactly and whose `source` = this launcher's iframe
 * - send out only with `targetOrigin` = the dphone origin exactly
 * - `dphone.activity` → call the host's handlers, then ack automatically once every handler finishes successfully
 *   (a handler failure = no ack → dphone resends with the same interactionId)
 * - `call()` before `dphone.ready` is queued to send after ready; resolves when a result other than `prefilled` arrives
 * - messages with another `v`/unknown type are ignored (v1 is additive only)
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

/** message from dphone (already through the origin/source check) — malformed/unknown = null */
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
  /** a handler may return a Promise — ack when every handler resolves */
  activity(message: ActivityMessage): unknown;
  callresult(message: CallResultMessage): void;
  error(message: DphoneErrorMessage): void;
}

export interface LauncherCoreOptions {
  dphoneOrigin: string;
  /** the iframe's window (used to compare `event.source` and send messages) */
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

  /** handler of `message` on the host's window — returns true when it is a message from this dphone */
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

  /** fill in a number in dphone — the agent must press call themselves; resolves with the final result (not `prefilled`) */
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
      return; // the host's handler failed → no ack so dphone resends
    }
    this.post({ v: 1, type: 'dphone.activity.ack', interactionId: message.interactionId });
  }

  private post(message: HostToDphoneMessage) {
    this.options.target()?.postMessage(message, this.options.dphoneOrigin);
  }
}
