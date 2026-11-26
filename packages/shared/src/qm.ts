export type QmTranscriptionTrigger = 'AUTOMATIC' | 'MANUAL';
export type QmTranscriptionStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

/**
 * failureCode that the QM worker sets itself when it cannot continue because of the recording (does not count provider attempts)
 * - RECORDING_NOT_ARCHIVED: while waiting for the archive (job still PENDING) or after waiting the full limit (FAILED); can be reopened via a manual request once archived
 * - RECORDING_DELETED: the recording was deleted or Telephony stopped trying to archive (permanently FAILED)
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
