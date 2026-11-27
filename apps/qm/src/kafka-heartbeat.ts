/**
 * Keeps a Kafka consumer group member alive while a slow handler runs.
 *
 * KafkaJS heartbeats only between messages. A transcription job waits for the provider for up to
 * QM_TRANSCRIPTION_TIMEOUT_MS (5 minutes by default), far longer than the 30 s session timeout, so
 * without this the coordinator evicts the worker mid-job, rebalances the partition and the offset
 * commit fails. The job row makes the redelivery a no-op, but every slow job would still stall the
 * group and churn rebalances.
 */
export const QM_HEARTBEAT_INTERVAL_MS = 5_000;

export interface HeartbeatTimer {
  setInterval(callback: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const systemTimer: HeartbeatTimer = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

export async function whileHeartbeating<T>(
  heartbeat: (() => Promise<void>) | undefined,
  run: () => Promise<T>,
  options: {
    intervalMs?: number;
    timer?: HeartbeatTimer;
    onError?: (error: unknown) => void;
  } = {},
): Promise<T> {
  if (!heartbeat) return run();
  const timer = options.timer ?? systemTimer;
  let reported = false;
  const handle = timer.setInterval(() => {
    // a failed heartbeat (e.g. REBALANCE_IN_PROGRESS) must not abort the job: the job row is the
    // source of truth and a redelivered message is a no-op. Report only the first failure per job.
    heartbeat().catch((error: unknown) => {
      if (reported) return;
      reported = true;
      options.onError?.(error);
    });
  }, options.intervalMs ?? QM_HEARTBEAT_INTERVAL_MS);
  try {
    return await run();
  } finally {
    timer.clearInterval(handle);
  }
}

/**
 * The rebalance timeout must outlast one whole job (provider calls plus media signing and the DB
 * writes), otherwise a rebalance during a slow job evicts the worker before it can rejoin.
 */
export function jobRebalanceTimeoutMs(providerTimeoutsMs: number[]): number {
  return providerTimeoutsMs.reduce((sum, ms) => sum + ms, 0) + 60_000;
}
