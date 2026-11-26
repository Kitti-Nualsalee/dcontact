/**
 * Owner: Delivery/Channels — continuous loop of the webhook worker (#567 T4)
 *
 * `LineWebhookWorker.runOnce` + `resolvePending` already use the inbox lease (`lease_owner`, `lease_expires_at`)
 * so it can run alongside `pilot await-touch` or another loop instance without processing the same row twice.
 * this loop adds only the rhythm: rest when there is no work, bounded backoff when the DB/destination is down, and a graceful stop
 * (`stop()` waits for the current batch to finish and does not cut a transaction midway)
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
  /** data for logs — numbers and codes only, no payload */
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

  /** stop accepting new rounds and wait for the round in progress to finish */
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
        // a full batch of work = continue immediately; no work = rest
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
