/**
 * Owner: Delivery/Channels — loop ต่อเนื่องของ webhook worker (#567 T4)
 *
 * `LineWebhookWorker.runOnce` + `resolvePending` ใช้ lease ของ inbox (`lease_owner`, `lease_expires_at`) อยู่แล้ว
 * จึงรันพร้อมกับ `pilot await-touch` หรือ loop อีก instance ได้โดยไม่ประมวลผลแถวเดียวกันซ้ำ
 * loop นี้เพิ่มแค่จังหวะ: พักเมื่อไม่มีงาน, backoff แบบมีเพดานเมื่อ DB/ปลายทางล่ม และหยุดแบบ graceful
 * (`stop()` รอ batch ปัจจุบันจบ ไม่ตัดกลาง transaction)
 */
import type { LineWebhookWorkerResult } from './line-webhook-worker.js';

export interface LineWebhookWorkerTick {
  runOnce(tenantId: string): Promise<LineWebhookWorkerResult>;
  resolvePending(tenantId: string): Promise<LineWebhookWorkerResult>;
}

export interface LineWebhookWorkerLoopOptions {
  worker: LineWebhookWorkerTick;
  tenantId: string;
  idleMs?: number;
  maxBackoffMs?: number;
  /** ข้อมูลสำหรับ log — เฉพาะตัวเลขและ code ไม่มี payload */
  onTick?: (event: {
    kind: 'processed' | 'failed';
    processed?: number;
    backoffMs?: number;
  }) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export class LineWebhookWorkerLoop {
  private readonly controller = new AbortController();
  private running: Promise<void> | undefined;

  constructor(private readonly options: LineWebhookWorkerLoopOptions) {}

  start(): void {
    this.running ??= this.loop();
  }

  /** หยุดรับรอบใหม่และรอรอบที่กำลังทำจบ */
  async stop(): Promise<void> {
    this.controller.abort();
    await this.running;
  }

  private async loop(): Promise<void> {
    const idleMs = this.options.idleMs ?? 2_000;
    const maxBackoffMs = this.options.maxBackoffMs ?? 60_000;
    const sleep = this.options.sleep ?? defaultSleep;
    let failures = 0;
    while (!this.controller.signal.aborted) {
      try {
        const projected = await this.options.worker.runOnce(this.options.tenantId);
        const resolved = await this.options.worker.resolvePending(this.options.tenantId);
        failures = 0;
        const processed = projected.processed + resolved.processed;
        this.options.onTick?.({ kind: 'processed', processed });
        // มีงานเต็ม batch = ทำต่อทันที; ไม่มีงาน = พัก
        if (processed === 0) await sleep(idleMs, this.controller.signal);
      } catch {
        failures += 1;
        const backoffMs = Math.min(idleMs * 2 ** failures, maxBackoffMs);
        this.options.onTick?.({ kind: 'failed', backoffMs });
        await sleep(backoffMs, this.controller.signal);
      }
    }
  }
}
