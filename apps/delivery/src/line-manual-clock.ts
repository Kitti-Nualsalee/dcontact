/**
 * Owner: Delivery/Channels — deterministic virtual clock ของ LINE simulation (S1.6)
 *
 * ไม่มี `setTimeout`/`Date.now()` จริงที่ใดในโมดูล LINE simulation ทั้งหมด — เวลาขยับ
 * ได้เฉพาะผ่าน `advanceTo`/`advanceBy` ที่ test เรียกเอง เพื่อให้ scenario เดิม replay
 * ได้ trace เดิมเสมอ ลำดับ tie-break ของ event เวลาเท่ากันใช้ `nextSequence()`
 */
export class ManualClock {
  private currentMs: number;
  private sequenceCounter = 0;

  constructor(startAt: string | number) {
    this.currentMs = typeof startAt === 'string' ? Date.parse(startAt) : startAt;
    if (!Number.isFinite(this.currentMs)) {
      throw new TypeError(`ManualClock: startAt ไม่ใช่เวลาที่ถูกต้อง: ${startAt}`);
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
      throw new TypeError(`ManualClock: ไม่สามารถย้อนเวลาไป ${target}`);
    }
    this.currentMs = ms;
  }

  advanceBy(deltaMs: number): void {
    if (deltaMs < 0) throw new TypeError('ManualClock: deltaMs ต้องไม่เป็นลบ');
    this.currentMs += deltaMs;
  }

  /** monotonic, ไม่ผูกกับเวลา — ใช้ตัดสิน ordering ของ event ที่ virtual timestamp ชนกัน */
  nextSequence(): number {
    this.sequenceCounter += 1;
    return this.sequenceCounter;
  }
}
