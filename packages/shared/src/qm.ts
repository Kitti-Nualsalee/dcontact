export type QmTranscriptionTrigger = 'AUTOMATIC' | 'MANUAL';
export type QmTranscriptionStatus = 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';

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
