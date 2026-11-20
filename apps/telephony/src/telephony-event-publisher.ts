import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';
import type { TelephonyRecordingLifecycle } from './recording-lifecycle.js';

export interface TelephonyEventPublisherDependencies {
  recordings: Pick<TelephonyRecordingLifecycle, 'startForAnsweredCall' | 'finishForHungupCall'>;
  publish(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<void>;
  log?(message: string, details: Record<string, unknown>): void;
}

/**
 * #923: งานบันทึกเสียงเป็นงานเสริมของสาย ความล้มเหลวต้องไม่บล็อก call event
 * ถ้า `call.answered` ไม่ถึง Router จะเกิด offer timeout → BREAK ระหว่างที่ Agent คุยอยู่
 */
export async function publishTelephonyCallEvent(
  event: KafkaEventEnvelope<TelephonyCallEvent>,
  dependencies: TelephonyEventPublisherDependencies,
): Promise<void> {
  const log = dependencies.log ?? ((message, details) => console.error(message, details));
  if (event.type === 'call.hangup') {
    try {
      await dependencies.recordings.finishForHungupCall(event);
    } catch (error) {
      log('[telephony] recording archive deferred', describeFailure(event, error));
    }
  } else {
    try {
      await dependencies.recordings.startForAnsweredCall(event);
    } catch (error) {
      log('[telephony] recording start failed', describeFailure(event, error));
    }
  }
  await dependencies.publish(event);
}

function describeFailure(
  event: KafkaEventEnvelope<TelephonyCallEvent>,
  error: unknown,
): Record<string, unknown> {
  // log เฉพาะตัวระบุสายและสาเหตุ ไม่ส่ง error object ทั้งก้อนที่อาจพก config/credential ของ client
  const failure = error instanceof Error ? error : undefined;
  return {
    eventType: event.type,
    callUuid: event.payload.callUuid,
    tenantId: event.tenantId,
    errorName: failure?.name,
    errorCode: (failure as NodeJS.ErrnoException | undefined)?.code,
    reason: failure?.message ?? String(error),
  };
}
