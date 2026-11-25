import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { describeError, type TelephonyRecordingLifecycle } from './recording-lifecycle.js';

/**
 * Recording work is ordered per key in queue order; different calls run concurrently and do not block sending call events.
 * The order between answered and hangup of the same call equals the order in which the caller invokes publishTelephonyCallEvent
 */
export class RecordingTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly running = new Set<Promise<void>>();

  /** The returned promise never rejects: the job must handle its own errors, and anything that escapes is logged */
  run(key: string, work: () => Promise<void>, onError: (error: unknown) => void): Promise<void> {
    const next = (this.tails.get(key) ?? Promise.resolve()).then(work).catch(onError);
    this.tails.set(key, next);
    this.running.add(next);
    void next.then(() => {
      this.running.delete(next);
      if (this.tails.get(key) === next) this.tails.delete(key);
    });
    return next;
  }

  get size(): number {
    return this.running.size;
  }

  /** Waits for pending work at process shutdown, including work queued while waiting, up to timeoutMs; returns false if work remains */
  async drain(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await waitAtMost(
        Promise.all([...this.running]).then(() => undefined),
        remaining,
      );
    }
    return true;
  }
}

export interface TelephonyEventPublisherDependencies {
  recordings: Pick<
    TelephonyRecordingLifecycle,
    'beginForAnsweredCall' | 'endForHungupCall' | 'archiveEndedRecording'
  >;
  recordingTasks: RecordingTaskQueue;
  publish(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<void>;
  /**
   * How long `call.hangup` waits for the recording to close (set endedAt then archive) before sending. Default 3 seconds.
   * QM reads the recording with endedAt when it gets interaction.ended, and normally the object should already be in storage,
   * so it waits with a cap instead of not waiting at all. The set-endedAt step is DB only and need not wait for the storage of the start-recording step.
   * 0 = do not wait (#991 managed calls have no Kafka event that must be ordered after archive); the work keeps running in recordingTasks
   */
  hangupRecordingBudgetMs?: number;
  log?(message: string, details: Record<string, unknown>): void;
}

/**
 * #923: recording work is auxiliary to the call; its failure or slowness must not block call events.
 * If `call.answered` does not reach the Router in time, the offer timeout sets the Agent to BREAK while they are on the call.
 * The order of sent events does not change, because the caller still awaits the publish of each event in the original order
 */
export async function publishTelephonyCallEvent(
  event: KafkaEventEnvelope<TelephonyCallEvent>,
  dependencies: TelephonyEventPublisherDependencies,
): Promise<void> {
  const log = dependencies.log ?? ((message, details) => console.error(message, details));
  const { recordings, recordingTasks } = dependencies;
  const { callUuid } = event.payload;
  // call key: DB work (create the row, set endedAt), which is fast
  // media key: storage work (prepare, uuid_record, archive), which may be slow, ordered after the DB work that submitted it
  const mediaKey = `${callUuid}:media`;
  if (event.type === 'call.answered') {
    // Do not wait: mkdir/announcement/uuid_record run after the Router has received answered
    const startFailed = (error: unknown) =>
      log('[telephony] recording start failed', describeFailure(event, error));
    void recordingTasks.run(
      callUuid,
      async () => {
        const start = await recordings.beginForAnsweredCall(event);
        if (start) void recordingTasks.run(mediaKey, start, startFailed);
      },
      startFailed,
    );
  } else if (event.type === 'call.hangup') {
    const deferred = (error: unknown) =>
      log('[telephony] recording archive deferred', describeFailure(event, error));
    const budgetMs = dependencies.hangupRecordingBudgetMs ?? 3_000;
    const startedAt = Date.now();
    const pending: { archive?: Promise<void> } = {};
    const ended = recordingTasks.run(
      callUuid,
      async () => {
        const recording = await recordings.endForHungupCall(event);
        if (!recording) return;
        pending.archive = recordingTasks.run(
          mediaKey,
          () => recordings.archiveEndedRecording(event.tenantId, recording),
          deferred,
        );
      },
      deferred,
    );
    if (budgetMs <= 0) return;
    const endedInTime = await waitAtMost(ended, budgetMs);
    const archivedInTime =
      endedInTime &&
      (!pending.archive ||
        (await waitAtMost(pending.archive, Math.max(0, budgetMs - (Date.now() - startedAt)))));
    if (!archivedInTime) {
      log('[telephony] call.hangup published before recording finished', {
        eventType: event.type,
        callUuid,
        tenantId: event.tenantId,
        budgetMs,
        pendingStage: endedInTime ? 'archive' : 'endedAt',
      });
    }
  }
  await dependencies.publish(event);
}

async function waitAtMost(work: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    return await Promise.race([work.then(() => true as const), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

function describeFailure(
  event: KafkaEventEnvelope<TelephonyCallEvent>,
  error: unknown,
): Record<string, unknown> {
  return {
    eventType: event.type,
    callUuid: event.payload.callUuid,
    tenantId: event.tenantId,
    ...describeError(error),
  };
}
