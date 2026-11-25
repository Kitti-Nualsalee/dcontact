/**
 * Owner: Delivery/Channels — deterministic virtual clock of the LINE simulation (S1.6)
 *
 * There is no real `setTimeout`/`Date.now()` anywhere in the whole LINE simulation module — time can move
 * only through `advanceTo`/`advanceBy` that the test calls itself, so that the same scenario replays
 * the same trace every time. The tie-break order of events at the same time uses `nextSequence()`
 */
export class ManualClock {
  private currentMs: number;
  private sequenceCounter = 0;

  constructor(startAt: string | number) {
    this.currentMs = typeof startAt === 'string' ? Date.parse(startAt) : startAt;
    if (!Number.isFinite(this.currentMs)) {
      throw new TypeError(`ManualClock: startAt is not a valid time: ${startAt}`);
    }
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  advanceTo(target: string | number): void {
    const ms = typeof target === 'string' ? Date.parse(target) : target;
    if (!Number.isFinite(ms) || ms < this.currentMs) {
      throw new TypeError(`ManualClock: cannot move time back to ${target}`);
    }
    this.currentMs = ms;
  }

  advanceBy(deltaMs: number): void {
    if (deltaMs < 0) throw new TypeError('ManualClock: deltaMs must not be negative');
    this.currentMs += deltaMs;
  }

  /** monotonic, not tied to time — used to decide the ordering of events whose virtual timestamps collide */
  nextSequence(): number {
    this.sequenceCounter += 1;
    return this.sequenceCounter;
  }
}
