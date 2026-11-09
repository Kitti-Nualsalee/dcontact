import type { BrowserSipTransport, SipCredentialLease } from './dphone.js';
import { PORT_NAME, parseExtensionMessage, type ExtensionRequest } from './extension-protocol.js';
import type { SipJsTransportCallbacks } from './sip-js-transport.js';

export interface ExtensionPort {
  postMessage(value: ExtensionRequest): void;
  disconnect(): void;
  onMessage: { addListener(listener: (value: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export function connectDPhoneExtension(extensionId: unknown): ExtensionPort {
  if (typeof extensionId !== 'string' || !/^[a-p]{32}$/.test(extensionId))
    throw new Error('D-Phone extension ID is invalid');
  const { chrome } = globalThis as typeof globalThis & {
    chrome?: { runtime?: { connect(id: string, options: { name: string }): ExtensionPort } };
  };
  if (!chrome?.runtime?.connect) throw new Error('D-Phone extension is unavailable');
  return chrome.runtime.connect(extensionId, { name: PORT_NAME });
}

type WithoutEnvelope<T> = T extends ExtensionRequest ? Omit<T, 'type' | 'id'> : never;
type Request = WithoutEnvelope<ExtensionRequest>;
type Pending = (error?: Error) => void;

/** Workspace controls media through a Chrome port. It never constructs a WebRTC session. */
export class DPhoneExtensionTransport implements BrowserSipTransport {
  private port?: ExtensionPort;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private ready?: Pending;
  private stopping = false;
  private callId?: number;

  constructor(
    private readonly connect: () => ExtensionPort,
    private readonly callbacks: SipJsTransportCallbacks,
    private readonly timeoutMs = 15_000,
  ) {}

  private close(port: ExtensionPort, error: Error, notify = false): void {
    if (this.port !== port) return;
    this.port = undefined;
    this.callId = undefined;
    this.ready?.(error);
    for (const finish of this.pending.values()) finish(error);
    port.disconnect();
    if (notify && !this.stopping) this.callbacks.onControlDisconnected?.();
  }

  async configure(lease: SipCredentialLease): Promise<void> {
    if (this.port) await this.unregister();
    const port = this.connect();
    this.port = port;
    this.stopping = false;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => this.close(port, new Error('D-Phone connection timed out')),
        this.timeoutMs,
      );
      this.ready = (error) => {
        clearTimeout(timeout);
        this.ready = undefined;
        if (error) reject(error);
        else resolve();
      };
      port.onDisconnect.addListener(() =>
        this.close(port, new Error('D-Phone disconnected'), true),
      );
      port.onMessage.addListener((raw) => {
        if (this.port !== port) return;
        const message = parseExtensionMessage(raw);
        if (!message) return;
        if (message.type === 'ready') this.ready?.();
        if (message.type === 'reply') {
          this.pending.get(message.id)?.(
            message.ok ? undefined : new Error('D-Phone command rejected'),
          );
        }
        if (message.type !== 'event' || this.stopping) return;
        switch (message.event) {
          case 'invitation':
            this.callId = message.callId;
            this.callbacks.onInvitation?.();
            break;
          case 'established':
            if (message.callId === this.callId) this.callbacks.onSessionEstablished?.();
            break;
          case 'terminated':
            if (message.callId !== this.callId) break;
            this.callId = undefined;
            this.callbacks.onSessionTerminated?.();
            break;
          case 'registrationLost':
            this.close(port, new Error('D-Phone registration lost'), true);
            break;
          case 'autoplayBlocked':
            this.callbacks.onAutoplayBlocked?.();
            break;
        }
      });
    });
    try {
      await this.request({ command: 'configure', lease });
    } catch (error) {
      this.close(port, new Error('D-Phone configuration failed'));
      throw error;
    }
  }

  private request(request: Request): Promise<void> {
    const port = this.port;
    if (!port) return Promise.reject(new Error('D-Phone is not connected'));
    const id = ++this.sequence;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => this.close(port, new Error('D-Phone command timed out'), true),
        this.timeoutMs,
      );
      this.pending.set(id, (error) => {
        clearTimeout(timeout);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve();
      });
      try {
        port.postMessage({ type: 'request', id, ...request });
      } catch {
        this.close(port, new Error('D-Phone command failed'), true);
      }
    });
  }

  async register(): Promise<void> {
    await this.request({ command: 'register' });
  }

  async unregister(): Promise<void> {
    const port = this.port;
    if (!port) return;
    this.stopping = true;
    try {
      await this.request({ command: 'unregister' });
    } catch {
      // The phone document also releases its transport when the port closes.
    } finally {
      this.close(port, new Error('D-Phone stopped'));
    }
  }

  private callCommand(command: 'accept' | 'reject' | 'hangup'): Promise<void> {
    const callId = this.callId;
    if (!callId) return Promise.reject(new Error('D-Phone has no current call'));
    return this.request({ command, callId });
  }

  accept() {
    return this.callCommand('accept');
  }
  reject() {
    return this.callCommand('reject');
  }
  hangup() {
    return this.callCommand('hangup');
  }
  hold() {
    return Promise.reject(new Error('D-Phone hold is not supported'));
  }
  resume() {
    return Promise.reject(new Error('D-Phone resume is not supported'));
  }
  sendDtmf() {
    return Promise.reject(new Error('D-Phone DTMF is not supported'));
  }
  setMuted() {}
}
