/**
 * E1.14 (#488): postMessage v1 channel between the embedded dphone and the host (E1.5 #461 item 5, E1.7 #463 item 2)
 *
 * - inbound: accept only `lock.accepts()` (locked origin + `source === window.parent` + not yet revoked)
 *   then parse per schema v1 — unknown types are ignored, an unsupported `v` is answered with `unsupported_version`
 * - outbound: `targetOrigin` = the locked origin exactly, always (never `*`), and stops sending once the origin is revoked
 * - `dphone.call` from the host is rate limited; the channel does not dial itself — it passes to `onCall` to fill in the number in dphone
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
  /** max `dphone.call` per time window (default 5 times / 10 seconds) */
  callRate?: { limit: number; windowMs: number };
}

export class HostChannel {
  private readonly callTimes: number[] = [];

  constructor(private readonly options: HostChannelOptions) {}

  /** send to the locked host — returns false when the origin has been revoked (not sent) */
  send(message: DphoneToHostMessage): boolean {
    if (this.options.lock.revoked) return false;
    this.options.host.postMessage(message, this.options.lock.origin);
    return true;
  }

  ready(capabilities: DphoneCapabilities, screenPopLevel: ScreenPopSetting): boolean {
    return this.send({ v: 1, type: 'dphone.ready', capabilities, screenPopLevel });
  }

  /** handler of the `message` event on the iframe's window — returns true when the message was accepted */
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
