/**
 * E1.14 (#488): queue of `dphone.activity` awaiting the host ack (E1.6 #462 item 4)
 *
 * - stored in the tab's `sessionStorage` (partitioned by host) so it survives reload and can be resent
 * - `interactionId` is the idempotency key: enqueuing again with the same id replaces the existing entry (no addition) and
 *   `requestId` stays the same across every resend — the host always sees the same message
 * - resent with backoff until `dphone.activity.ack`; messages carry no audio file, transcript or note
 *   because they are built from the `ActivityMessage` type, which has no such fields, and copy only known fields
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

  /** enqueue then send immediately — the same interactionId reuses the same requestId (a resend, not a new message) */
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

  /** after reload or when the host sends ready again: send every pending entry */
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
      // storage full/disabled — the in-memory queue can still resend until the tab closes
    }
  }
}
