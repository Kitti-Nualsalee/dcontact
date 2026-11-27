import { AgentApiError, type WrapupIntentV1, type WrapupResultV1 } from '../agent-api.js';
import type { WebchatApi, WebchatChannel, WebchatChat, WebchatMessage } from './webchat-api.js';

/**
 * #1044: the Agent's web chats in Workspace, free of React so the rules can be tested.
 *
 * - The server is the authority: every refresh replaces the list of chats, and the store keeps only what
 *   belongs to this page — the room in view, drafts, messages not yet sent, wrap-up forms being filled in.
 * - A refresh runs when the socket says the chats changed and on a slow timer, so a missed notice or a
 *   dropped socket delays an update instead of losing it. A failed refresh marks the store offline.
 * - Rooms keep the order they arrived in; a new message never moves a row (docs/ui-principles.md item 4).
 */
export const WEBCHAT_MAX_LENGTH = 2000;
export const WEBCHAT_POLL_MS = 4_000;

export interface RoomMessage extends WebchatMessage {
  pending?: 'sending' | 'failed';
}

export type WrapupDisposition = 'CUSTOMER_ASSISTED' | 'FOLLOW_UP_REQUIRED';

export interface RoomWrapup {
  disposition?: WrapupDisposition;
  note: string;
  pending: boolean;
  /** `failed` = the server refused it; `unknown` = no answer, so it may or may not have been saved */
  error?: 'failed' | 'unknown';
  /** kept across retries so a repeated save is the same command */
  commandId?: string;
}

export interface WebchatRoom {
  chat: WebchatChat;
  messages: RoomMessage[];
  cursor: string | null;
  loaded: boolean;
  historyFailed: boolean;
  draft: string;
  /** visitor messages the Agent has seen in this room */
  readCount: number;
  ending: boolean;
  wrapup: RoomWrapup;
}

export interface ClosedChat {
  interactionId: string;
  channel: WebchatChannel;
  visitorLabel: string;
  result: WrapupResultV1;
}

export interface WebchatState {
  /** false until the first successful load */
  ready: boolean;
  online: boolean;
  maxChats: number;
  offers: WebchatChat[];
  /** offers that went away without this Agent accepting them */
  missed: { interactionId: string; channel: WebchatChannel; visitorLabel: string }[];
  rooms: WebchatRoom[];
  closed: ClosedChat[];
  selectedId: string | null;
  /** an action the Agent just took failed; shown once and cleared by the next action */
  notice: 'offerTaken' | 'endFailed' | null;
}

export interface WebchatStoreDeps {
  api: WebchatApi;
  submitWrapup: (intent: WrapupIntentV1) => Promise<WrapupResultV1>;
  newId: () => string;
  now: () => Date;
  /** whether the Agent is looking at this page; unseen messages stay unread otherwise */
  visible?: () => boolean;
}

const emptyWrapup = (): RoomWrapup => ({ note: '', pending: false });

export function unreadOf(room: WebchatRoom): number {
  return Math.max(0, room.chat.visitorMessageCount - room.readCount);
}

/** The time the customer has waited for an answer: since their latest message, if it is the last one. */
export function waitingSince(room: WebchatRoom): string | null {
  const last = room.chat.lastMessage;
  return room.chat.state === 'ACTIVE' && last?.from === 'visitor' ? last.at : null;
}

export class WebchatStore {
  private state: WebchatState = {
    ready: false,
    online: true,
    maxChats: 3,
    offers: [],
    missed: [],
    rooms: [],
    closed: [],
    selectedId: null,
    notice: null,
  };
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> | undefined;
  private again = false;
  /** offers this Agent accepted, so their disappearance is not reported as missed */
  private readonly accepted = new Set<string>();

  constructor(private readonly deps: WebchatStoreDeps) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly snapshot = () => this.state;

  private set(patch: Partial<WebchatState>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  private patchRoom(interactionId: string, patch: (room: WebchatRoom) => Partial<WebchatRoom>) {
    this.set({
      rooms: this.state.rooms.map((room) =>
        room.chat.interactionId === interactionId ? { ...room, ...patch(room) } : room,
      ),
    });
  }

  private room(interactionId: string) {
    return this.state.rooms.find((room) => room.chat.interactionId === interactionId);
  }

  start() {
    if (this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), WEBCHAT_POLL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads the chats again. Calls made while one is running are folded into a single follow-up. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = this.load()
      .catch(() => this.set({ online: false }))
      .finally(() => {
        this.refreshing = undefined;
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      });
    return this.refreshing;
  }

  private async load() {
    const { maxChatsPerAgent, chats } = await this.deps.api.chats();
    const offers = chats.filter((chat) => chat.state === 'ASSIGNED');
    const held = chats.filter((chat) => chat.state !== 'ASSIGNED');
    const heldIds = new Set(held.map((chat) => chat.interactionId));
    const offerIds = new Set(offers.map((chat) => chat.interactionId));
    const missed = [
      ...this.state.missed,
      ...this.state.offers
        .filter(
          (offer) =>
            !offerIds.has(offer.interactionId) &&
            !heldIds.has(offer.interactionId) &&
            !this.accepted.has(offer.interactionId),
        )
        .map((offer) => ({
          interactionId: offer.interactionId,
          channel: offer.channel,
          visitorLabel: offer.visitorLabel,
        })),
    ];
    const rooms: WebchatRoom[] = [];
    for (const room of this.state.rooms) {
      const chat = held.find((entry) => entry.interactionId === room.chat.interactionId);
      // a room the server no longer lists is finished, unless its result is still on its way
      if (chat) rooms.push({ ...room, chat });
      else if (room.wrapup.pending || room.wrapup.error === 'unknown') rooms.push(room);
    }
    for (const chat of held)
      if (!rooms.some((room) => room.chat.interactionId === chat.interactionId))
        rooms.push({
          chat,
          messages: [],
          cursor: null,
          loaded: false,
          historyFailed: false,
          draft: '',
          readCount: 0,
          ending: false,
          wrapup: emptyWrapup(),
        });
    const { selectedId: previous } = this.state;
    const kept =
      previous &&
      (rooms.some((room) => room.chat.interactionId === previous) ||
        this.state.closed.some((chat) => chat.interactionId === previous));
    // The first room comes into view by itself, and so does the next one when the room in view is gone.
    // "No chat in view" chosen by the Agent (they opened a call or a closed item) is kept otherwise.
    const selectedId = kept
      ? previous
      : previous || this.state.rooms.length === 0
        ? (rooms[0]?.chat.interactionId ?? null)
        : null;
    this.set({
      ready: true,
      online: true,
      maxChats: maxChatsPerAgent,
      offers,
      missed,
      rooms,
      selectedId,
    });
    await Promise.all(
      rooms
        .filter(
          (room) =>
            !room.loaded ||
            (room.chat.lastMessage &&
              !room.messages.some((m) => m.id === room.chat.lastMessage!.id)),
        )
        .map((room) => this.loadMessages(room.chat.interactionId)),
    );
    await this.refreshDeliveries();
    this.markRead();
  }

  /**
   * LINE delivery changes create no new message, so the Agent's messages still on screen as "sending" are
   * asked about again. Only the room in view is read, and only while one of its messages is in that state.
   */
  private async refreshDeliveries() {
    const room = this.state.selectedId ? this.room(this.state.selectedId) : undefined;
    if (
      !room ||
      room.chat.channel !== 'LINE' ||
      !room.messages.some((message) => message.delivery === 'SENDING')
    )
      return;
    const interactionId = room.chat.interactionId;
    try {
      const { deliveries } = await this.deps.api.deliveries(interactionId);
      const settled = new Map(deliveries.map((entry) => [entry.id, entry.delivery]));
      this.patchRoom(interactionId, (current) => ({
        messages: current.messages.map((message) => {
          const delivery = settled.get(message.id);
          if (!delivery || !message.delivery) return message;
          const next = { ...message };
          if (delivery === 'SENT') delete next.delivery;
          else next.delivery = delivery;
          return next;
        }),
      }));
    } catch {
      // the next refresh asks again; the bubble keeps saying "sending" meanwhile
    }
  }

  private async loadMessages(interactionId: string) {
    const room = this.room(interactionId);
    if (!room) return;
    try {
      const page = await this.deps.api.messages(interactionId, room.cursor);
      this.patchRoom(interactionId, (current) => {
        const arrived = new Set(page.messages.flatMap((message) => message.clientId ?? []));
        const known = new Set(current.messages.map((message) => message.id));
        const merged: RoomMessage[] = [
          // the server copy replaces the copy this page was still showing as pending
          ...current.messages.filter(
            (message) => !(message.pending && message.clientId && arrived.has(message.clientId)),
          ),
          ...page.messages.filter((message) => !known.has(message.id)),
        ];
        // messages still on their way stay at the end, in the order they were written
        const messages = merged.sort((left, right) =>
          left.pending && !right.pending
            ? 1
            : !left.pending && right.pending
              ? -1
              : left.at.localeCompare(right.at),
        );
        return { messages, cursor: page.cursor, loaded: true, historyFailed: false };
      });
    } catch {
      this.patchRoom(interactionId, (current) => ({
        historyFailed: !current.loaded,
        loaded: current.loaded,
      }));
    }
  }

  retryHistory(interactionId: string) {
    return this.loadMessages(interactionId);
  }

  /** The room in view counts as read while the Agent is looking at the page. */
  markRead() {
    const selected = this.state.selectedId ? this.room(this.state.selectedId) : undefined;
    if (!selected || this.deps.visible?.() === false) return;
    if (selected.readCount !== selected.chat.visitorMessageCount)
      this.patchRoom(selected.chat.interactionId, (room) => ({
        readCount: room.chat.visitorMessageCount,
      }));
  }

  select(interactionId: string | null) {
    if (this.state.selectedId === interactionId) return;
    this.set({ selectedId: interactionId });
    this.markRead();
  }

  /** Moves to the room before or after the one in view (Alt+Up / Alt+Down). */
  selectRelative(step: 1 | -1) {
    const ids = this.state.rooms.map((room) => room.chat.interactionId);
    if (ids.length === 0) return;
    const index = this.state.selectedId ? ids.indexOf(this.state.selectedId) : -1;
    const next = index < 0 ? 0 : (index + step + ids.length) % ids.length;
    this.select(ids[next]!);
  }

  dismissMissed(interactionId: string) {
    this.set({
      missed: this.state.missed.filter((entry) => entry.interactionId !== interactionId),
    });
  }

  clearNotice() {
    if (this.state.notice) this.set({ notice: null });
  }

  /** Takes the offered chat. Returns whether the room is now this Agent's. */
  async accept(interactionId: string): Promise<boolean> {
    this.accepted.add(interactionId);
    this.set({ notice: null });
    try {
      await this.deps.api.accept(interactionId);
    } catch (error) {
      this.set({
        offers: this.state.offers.filter((offer) => offer.interactionId !== interactionId),
        // someone else has it, or it timed out a moment ago
        notice: error instanceof AgentApiError && error.status === 409 ? 'offerTaken' : null,
      });
      void this.refresh();
      return false;
    }
    await this.refresh();
    if (!this.room(interactionId)) return false;
    this.select(interactionId);
    return true;
  }

  setDraft(interactionId: string, draft: string) {
    this.patchRoom(interactionId, () => ({ draft }));
  }

  /** Sends the room's draft. The text leaves the composer at once and stays on screen until it is sent. */
  async send(interactionId: string): Promise<void> {
    const room = this.room(interactionId);
    const text = room?.draft.replace(/\r\n?/g, '\n').trim() ?? '';
    if (!room || room.chat.state !== 'ACTIVE' || !text || [...text].length > WEBCHAT_MAX_LENGTH)
      return;
    const clientId = this.deps.newId();
    const pending: RoomMessage = {
      id: `local:${clientId}`,
      at: this.deps.now().toISOString(),
      from: 'agent',
      text,
      clientId,
      pending: 'sending',
    };
    this.patchRoom(interactionId, (current) => ({
      draft: '',
      messages: [...current.messages, pending],
    }));
    await this.deliver(interactionId, clientId, text);
  }

  async retry(interactionId: string, localId: string): Promise<void> {
    const message = this.room(interactionId)?.messages.find((entry) => entry.id === localId);
    if (!message?.clientId || !message.text || message.pending !== 'failed') return;
    this.mark(interactionId, message.clientId, 'sending');
    await this.deliver(interactionId, message.clientId, message.text);
  }

  discard(interactionId: string, localId: string) {
    this.patchRoom(interactionId, (room) => ({
      messages: room.messages.filter((message) => message.id !== localId),
    }));
  }

  private mark(interactionId: string, clientId: string, pending: 'sending' | 'failed') {
    this.patchRoom(interactionId, (room) => ({
      messages: room.messages.map((message) =>
        message.pending && message.clientId === clientId ? { ...message, pending } : message,
      ),
    }));
  }

  private async deliver(interactionId: string, clientId: string, text: string) {
    try {
      const sent = await this.deps.api.send(interactionId, { commandId: clientId, text });
      this.patchRoom(interactionId, (room) => {
        const exists = room.messages.some((message) => message.id === sent.id);
        return {
          messages: room.messages.flatMap((message) =>
            message.pending && message.clientId === clientId ? (exists ? [] : [sent]) : [message],
          ),
        };
      });
    } catch (error) {
      this.mark(interactionId, clientId, 'failed');
      // the chat ended while the Agent was typing: show the room as the server has it
      if (error instanceof AgentApiError && error.status === 409) void this.refresh();
    }
  }

  async end(interactionId: string): Promise<void> {
    const room = this.room(interactionId);
    if (!room || room.chat.state !== 'ACTIVE' || room.ending) return;
    this.patchRoom(interactionId, () => ({ ending: true }));
    this.set({ notice: null });
    try {
      await this.deps.api.end(interactionId);
    } catch {
      this.set({ notice: 'endFailed' });
    }
    this.patchRoom(interactionId, () => ({ ending: false }));
    await this.refresh();
  }

  setWrapup(interactionId: string, patch: Pick<Partial<RoomWrapup>, 'disposition' | 'note'>) {
    this.patchRoom(interactionId, (room) =>
      // while the result of a save is unknown the form is locked: a retry must be the same command
      room.wrapup.pending || room.wrapup.error === 'unknown'
        ? {}
        : { wrapup: { ...room.wrapup, ...patch, error: undefined, commandId: undefined } },
    );
  }

  /** Saves the outcome and note of an ended chat. Returns the saved result, or null when it did not save. */
  async submitWrapup(interactionId: string): Promise<WrapupResultV1 | null> {
    const room = this.room(interactionId);
    const note = room?.wrapup.note.replace(/\r\n/g, '\n').trim() ?? '';
    if (
      !room ||
      room.chat.state !== 'WRAPUP' ||
      room.wrapup.pending ||
      !room.wrapup.disposition ||
      [...note].length < 1 ||
      [...note].length > WEBCHAT_MAX_LENGTH
    )
      return null;
    const commandId = room.wrapup.commandId ?? this.deps.newId();
    const intent: WrapupIntentV1 = {
      interactionId,
      disposition: room.wrapup.disposition,
      note,
      commandId,
    };
    this.patchRoom(interactionId, (current) => ({
      wrapup: { ...current.wrapup, pending: true, error: undefined, commandId },
    }));
    let result: WrapupResultV1;
    try {
      result = await this.deps.submitWrapup(intent);
    } catch (error) {
      // an answer from the server is final for this command; silence may still mean it was saved
      const refused = error instanceof AgentApiError && error.status >= 400 && error.status < 500;
      this.patchRoom(interactionId, (current) => ({
        wrapup: {
          ...current.wrapup,
          pending: false,
          error: refused ? 'failed' : 'unknown',
          commandId: refused ? undefined : commandId,
        },
      }));
      if (refused) void this.refresh();
      return null;
    }
    const index = this.state.rooms.findIndex((entry) => entry.chat.interactionId === interactionId);
    const rooms = this.state.rooms.filter((entry) => entry.chat.interactionId !== interactionId);
    const next = rooms[Math.min(index, rooms.length - 1)]?.chat.interactionId ?? null;
    this.set({
      rooms,
      closed: [
        ...this.state.closed,
        { interactionId, channel: room.chat.channel, visitorLabel: room.chat.visitorLabel, result },
      ],
      selectedId: this.state.selectedId === interactionId ? next : this.state.selectedId,
    });
    void this.refresh();
    return result;
  }

  /** Chats in hand that would be lost by signing out: offers, open rooms and unsaved results. */
  inHand(): number {
    return this.state.rooms.length;
  }
}
