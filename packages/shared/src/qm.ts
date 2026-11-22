export type QmTranscriptionTrigger = 'AUTOMATIC' | 'MANUAL';
export type QmTranscriptionStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

/**
 * failureCode ที่ QM worker ตั้งเองเมื่อทำต่อไม่ได้เพราะ recording (ไม่นับ attempt ของ provider)
 * - RECORDING_NOT_ARCHIVED: ระหว่างรอ archive (job ยัง PENDING) หรือรอครบเพดานแล้ว (FAILED) เปิดใหม่ผ่าน manual request ได้เมื่อ archive แล้ว
 * - RECORDING_DELETED: recording ถูกลบหรือ Telephony เลิกลอง archive (FAILED ถาวร)
 */
export const QM_RECORDING_FAILURE_CODES = {
  RECORDING_NOT_ARCHIVED: 'RECORDING_NOT_ARCHIVED',
  RECORDING_DELETED: 'RECORDING_DELETED',
} as const;

export interface QmInteractionEndedPayload extends Record<string, unknown> {
  interactionId: string;
  channel: 'VOICE' | 'WEBCHAT' | 'LINE' | 'FACEBOOK' | 'WHATSAPP' | 'EMAIL';
  state: 'WRAPUP' | 'COMPLETED';
  queueId?: string;
  agentId?: string;
}

export interface QmTranscriptionJobMessage extends Record<string, unknown> {
  kind: 'TRANSCRIBE';
  jobId: string;
  interactionId: string;
  recordingId: string;
  languageHint: string;
  trigger: QmTranscriptionTrigger;
  attempt: number;
}
