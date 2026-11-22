import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import { describeError, type TelephonyRecordingLifecycle } from './recording-lifecycle.js';

/**
 * งานบันทึกเสียงเรียงต่อสาย (เริ่มบันทึกของ answered ต้องเสร็จก่อนปิดบันทึกของ hangup)
 * แต่ไม่ขวางการส่ง call event และสายต่างกันทำพร้อมกันได้
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

  /** รองานที่ค้างตอนปิด process ไม่เกิน timeoutMs; คืน false ถ้ายังมีงานเหลือ */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.running.size === 0) return true;
    return waitAtMost(
      Promise.all([...this.running]).then(() => undefined),
      timeoutMs,
    );
  }
}

export interface TelephonyEventPublisherDependencies {
  recordings: Pick<TelephonyRecordingLifecycle, 'startForAnsweredCall' | 'finishForHungupCall'>;
  recordingTasks: RecordingTaskQueue;
  publish(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<void>;
  /**
   * เวลาที่ `call.hangup` รอปิดบันทึก (ตั้ง endedAt แล้ว archive) ก่อนส่ง ค่าเริ่มต้น 3 วินาที
   * QM อ่าน recording ที่มี endedAt ตอนได้ interaction.ended จึงรอแบบมีเพดานแทนการไม่รอเลย
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
  const { callUuid } = event.payload;
  if (event.type === 'call.answered') {
    // ไม่รอ: mkdir/ประกาศ/uuid_record ทำหลัง Router ได้ answered แล้ว
    void dependencies.recordingTasks.run(
      callUuid,
      () => dependencies.recordings.startForAnsweredCall(event),
      (error) => log('[telephony] recording start failed', describeFailure(event, error)),
    );
  } else if (event.type === 'call.hangup') {
    const finished = dependencies.recordingTasks.run(
      callUuid,
      () => dependencies.recordings.finishForHungupCall(event),
      (error) => log('[telephony] recording archive deferred', describeFailure(event, error)),
    );
    const budgetMs = dependencies.hangupRecordingBudgetMs ?? 3_000;
    if (!(await waitAtMost(finished, budgetMs))) {
      log('[telephony] call.hangup published before recording finished', {
        eventType: event.type,
        callUuid,
        tenantId: event.tenantId,
        budgetMs,
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
