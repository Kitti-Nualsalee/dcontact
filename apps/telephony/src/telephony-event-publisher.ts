import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { describeError, type TelephonyRecordingLifecycle } from './recording-lifecycle.js';

/**
 * งานบันทึกเสียงเรียงตาม key ตามลำดับที่เข้าคิว สายต่างกันทำพร้อมกันได้ และไม่ขวางการส่ง call event
 * ลำดับระหว่าง answered กับ hangup ของสายเดียวกันเท่ากับลำดับที่ caller เรียก publishTelephonyCallEvent
 */
export class RecordingTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly running = new Set<Promise<void>>();

  /** promise ที่คืนไม่ reject: งานต้องจัดการ error ของตัวเอง ส่วนที่หลุดมาจะถูก log */
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

  /** รองานที่ค้างตอนปิด process รวมงานที่เข้าคิวระหว่างรอ ไม่เกิน timeoutMs; คืน false ถ้ายังมีงานเหลือ */
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
   * เวลาที่ `call.hangup` รอปิดบันทึก (ตั้ง endedAt แล้ว archive) ก่อนส่ง ค่าเริ่มต้น 3 วินาที
   * QM อ่าน recording ที่มี endedAt ตอนได้ interaction.ended และกรณีปกติ object ควรอยู่ใน storage แล้ว
   * จึงรอแบบมีเพดานแทนการไม่รอเลย ขั้นตั้ง endedAt เป็น DB อย่างเดียว ไม่ต้องรอ storage ของขั้นเริ่มบันทึก
   * 0 = ไม่รอเลย (#991 สาย managed ไม่มี Kafka event ที่ต้องเรียงหลัง archive) งานยังรันต่อใน recordingTasks
   */
  hangupRecordingBudgetMs?: number;
  log?(message: string, details: Record<string, unknown>): void;
}

/**
 * #923: งานบันทึกเสียงเป็นงานเสริมของสาย ความล้มเหลวหรือความช้าต้องไม่บล็อก call event
 * ถ้า `call.answered` ไม่ถึง Router ทัน offer timeout จะตั้ง Agent เป็น BREAK ระหว่างที่คุยอยู่
 * ลำดับ event ที่ส่งไม่เปลี่ยน เพราะ caller ยังรอ publish ของแต่ละ event ตามลำดับเดิม
 */
export async function publishTelephonyCallEvent(
  event: KafkaEventEnvelope<TelephonyCallEvent>,
  dependencies: TelephonyEventPublisherDependencies,
): Promise<void> {
  const log = dependencies.log ?? ((message, details) => console.error(message, details));
  const { recordings, recordingTasks } = dependencies;
  const { callUuid } = event.payload;
  // key ของสาย: งาน DB (สร้างแถว, ตั้ง endedAt) ซึ่งเร็ว
  // key ของ media: งาน storage (prepare, uuid_record, archive) ซึ่งอาจช้า เรียงหลังงาน DB ที่ส่งงานนั้นเข้ามา
  const mediaKey = `${callUuid}:media`;
  if (event.type === 'call.answered') {
    // ไม่รอ: mkdir/ประกาศ/uuid_record ทำหลัง Router ได้ answered แล้ว
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
