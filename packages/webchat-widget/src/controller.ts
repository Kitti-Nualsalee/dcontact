import {
  ChatApiError,
  type ChatApi,
  type ChatMessage,
  type ServerState,
  type StoredSession,
} from './client.js';

/**
 * #1044: the widget's state, free of the DOM so it can be tested.
 *
 * - A session is created with the first message, not when the widget opens, so a page view leaves nothing behind.
 * - The stored session lets a refreshed page return to the same chat while it is still open; an ended or
 *   unknown one is dropped and the visitor starts fresh.
 * - While a chat is open one long poll at a time waits for changes; a failed poll retries with a growing delay
 *   and the view says the connection is being restored.
 */
export type ChatPhase =
  'loading' | 'unavailable' | 'offline' | 'ready' | 'waiting' | 'active' | 'ended';
export type ChatNotice = 'queueFull' | 'rate' | 'limit';

export interface ViewMessage extends ChatMessage {
  pending?: 'sending' | 'failed';
}

export interface ChatView {
  phase: ChatPhase;
  endReason: string | null;
  tenantName: string;
  greeting: { th: string; en: string };
  idleTimeoutSec: number;
  messages: ViewMessage[];
  reconnecting: boolean;
  notice: ChatNotice | null;
}

export interface SessionStore {
  load(): StoredSession | null;
  save(session: StoredSession | null): void;
}

export interface ChatControllerDeps {
  api: ChatApi;
  store: SessionStore;
  origin: string;
  locale: string;
  newId: () => string;
  now: () => Date;
  delay: (ms: number) => Promise<void>;
}

const PHASE: Record<ServerState['status'], ChatPhase> = {
  NEW: 'ready',
  WAITING: 'waiting',
  ACTIVE: 'active',
  ENDED: 'ended',
};

const NOTICE: Record<string, ChatNotice> = {
  QUEUE_FULL: 'queueFull',
  RATE_LIMITED: 'rate',
  MESSAGE_LIMIT: 'limit',
};

export class ChatController {
  private view: ChatView = {
    phase: 'loading',
    endReason: null,
    tenantName: '',
    greeting: { th: '', en: '' },
    idleTimeoutSec: 600,
    messages: [],
    reconnecting: false,
    notice: null,
  };
  private session: StoredSession | null = null;
  /** the session being created; every message sent meanwhile waits for this one instead of making another */
  private creating: Promise<StoredSession> | null = null;
  private cursor: string | null = null;
  private version = '';
  private poll: AbortController | null = null;
  private disposed = false;
  private readonly listeners = new Set<(view: ChatView) => void>();

  constructor(private readonly deps: ChatControllerDeps) {}

  subscribe(listener: (view: ChatView) => void): () => void {
    this.listeners.add(listener);
    listener(this.view);
    return () => this.listeners.delete(listener);
  }

  current(): ChatView {
    return this.view;
  }

  private set(patch: Partial<ChatView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener(this.view);
  }

  async init(): Promise<void> {
    let staffed: boolean;
    try {
      const boot = await this.deps.api.bootstrap();
      staffed = boot.staffed;
      this.set({
        tenantName: boot.tenantName,
        greeting: boot.greeting,
        idleTimeoutSec: boot.idleTimeoutSec,
      });
    } catch {
      this.set({ phase: 'unavailable' });
      return;
    }
    const stored = this.deps.store.load();
    if (stored) {
      try {
        const state = await this.deps.api.state(stored, {});
        // a chat that ended before this page load is history: the visitor starts fresh
        if (state.status !== 'ENDED') {
          this.session = stored;
          this.apply(state);
          if (state.status !== 'NEW') this.startPolling();
          else this.set({ phase: state.staffed ? 'ready' : 'offline' });
          return;
        }
      } catch {
        // unknown or expired session: fall through to a fresh start
      }
      this.deps.store.save(null);
    }
    this.set({ phase: staffed ? 'ready' : 'offline' });
  }

  /** Asks again whether an Agent is online (the "check again" button of the offline view). */
  async recheck(): Promise<void> {
    if (this.view.phase !== 'offline') return;
    try {
      const boot = await this.deps.api.bootstrap();
      if (boot.staffed) this.set({ phase: 'ready', notice: null });
    } catch {
      // stay offline; the visitor can press again
    }
  }

  private apply(state: ServerState) {
    const known = new Map(this.view.messages.map((message) => [message.id, message]));
    const byClient = new Set(state.messages.flatMap((message) => message.clientId ?? []));
    const messages = this.view.messages.filter(
      // the server copy of a message replaces the copy this page was still showing as pending
      (message) => !(message.pending && message.clientId && byClient.has(message.clientId)),
    );
    for (const message of state.messages) if (!known.has(message.id)) messages.push(message);
    messages.sort((left, right) =>
      left.pending && !right.pending
        ? 1
        : !left.pending && right.pending
          ? -1
          : left.at.localeCompare(right.at),
    );
    this.cursor = state.cursor;
    this.version = state.version;
    this.set({
      phase: PHASE[state.status],
      endReason: state.endReason,
      messages,
      reconnecting: false,
    });
  }

  private startPolling() {
    if (this.poll || this.disposed) return;
    const controller = new AbortController();
    this.poll = controller;
    void this.pollLoop(controller);
  }

  private async pollLoop(controller: AbortController) {
    let failures = 0;
    while (!controller.signal.aborted && this.session) {
      try {
        const state = await this.deps.api.state(this.session, {
          after: this.cursor,
          known: this.version,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        failures = 0;
        this.apply(state);
        if (state.status === 'ENDED') {
          this.deps.store.save(null);
          break;
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof ChatApiError && (error.status === 401 || error.status === 404)) {
          this.reset('ready');
          break;
        }
        failures += 1;
        this.set({ reconnecting: true });
        await this.deps.delay(Math.min(10_000, 1_000 * 2 ** Math.min(failures, 4)));
      }
    }
    if (this.poll === controller) this.poll = null;
  }

  private reset(phase: ChatPhase) {
    this.poll?.abort();
    this.poll = null;
    this.session = null;
    this.creating = null;
    this.cursor = null;
    this.version = '';
    this.deps.store.save(null);
    this.set({ phase, endReason: null, messages: [], reconnecting: false });
  }

  async send(text: string): Promise<void> {
    const body = text.replace(/\r\n?/g, '\n').trim();
    if (!body || [...body].length > 2000) return;
    if (!['ready', 'waiting', 'active'].includes(this.view.phase)) return;
    const clientId = this.deps.newId();
    const pending: ViewMessage = {
      id: `local:${clientId}`,
      at: this.deps.now().toISOString(),
      from: 'visitor',
      text: body,
      clientId,
      pending: 'sending',
    };
    this.set({ messages: [...this.view.messages, pending], notice: null });
    await this.deliver(clientId, body);
  }

  async retry(localId: string): Promise<void> {
    const message = this.view.messages.find((entry) => entry.id === localId);
    if (!message?.clientId || message.pending !== 'failed' || !message.text) return;
    this.mark(message.clientId, 'sending');
    await this.deliver(message.clientId, message.text);
  }

  private mark(clientId: string, pending: 'sending' | 'failed') {
    this.set({
      messages: this.view.messages.map((message) =>
        message.pending && message.clientId === clientId ? { ...message, pending } : message,
      ),
    });
  }

  private async deliver(clientId: string, text: string) {
    try {
      if (!this.session) {
        // Two messages sent before the session exists must share it: otherwise each opens its own chat.
        this.creating ??= this.deps.api
          .startSession({ origin: this.deps.origin, locale: this.deps.locale })
          .then((session) => {
            this.session = session;
            this.deps.store.save(session);
            return session;
          })
          .finally(() => {
            this.creating = null;
          });
        await this.creating;
      }
      const sent = await this.deps.api.send(this.session!, { clientMessageId: clientId, text });
      const exists = this.view.messages.some((message) => message.id === sent.id);
      this.set({
        messages: this.view.messages.flatMap((message) =>
          message.pending && message.clientId === clientId ? (exists ? [] : [sent]) : [message],
        ),
        ...(this.view.phase === 'ready' ? { phase: 'waiting' as const } : {}),
      });
      this.startPolling();
    } catch (error) {
      const code = error instanceof ChatApiError ? error.code : '';
      if (code === 'NO_AGENT_ONLINE') {
        this.set({
          phase: 'offline',
          messages: this.view.messages.filter((message) => message.clientId !== clientId),
        });
        return;
      }
      if (code === 'CHAT_ENDED' || code === 'SESSION_INVALID') {
        // the chat closed while the visitor was typing: show what the server has
        this.mark(clientId, 'failed');
        if (this.session && code === 'CHAT_ENDED') this.startPolling();
        else this.reset('ready');
        return;
      }
      this.mark(clientId, 'failed');
      if (NOTICE[code]) this.set({ notice: NOTICE[code] });
    }
  }

  async end(): Promise<void> {
    if (!this.session || !['waiting', 'active'].includes(this.view.phase)) return;
    try {
      await this.deps.api.end(this.session);
    } catch {
      // the poll will show the real state; ending is safe to press again
    }
  }

  /** After a chat ended: clear it and get ready for a new one. */
  async restart(): Promise<void> {
    this.reset('loading');
    await this.init();
  }

  dispose() {
    this.disposed = true;
    this.poll?.abort();
    this.listeners.clear();
  }
}
