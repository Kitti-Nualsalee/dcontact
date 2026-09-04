export interface DirectVoiceQueueAdmissionAccepted {
  status: 'ACCEPTED';
  entryMode: 'DIRECT_QUEUE';
  destinationId: string;
  queueId: string;
}

export interface DirectVoiceQueueAdmissionRejected {
  status: 'REJECTED';
  reason: 'DESTINATION_NOT_FOUND' | 'DESTINATION_DISABLED' | 'QUEUE_DISABLED';
}

export type DirectVoiceQueueAdmissionDecision =
  DirectVoiceQueueAdmissionAccepted | DirectVoiceQueueAdmissionRejected;
