export interface ManagedVoiceDirectCommand {
  commandId: string;
  tenantId: string;
  telephonyNodeId: string;
  interactionId: string;
  callUuid: string;
  offerId: string | null;
  blegUuid: string;
  type: 'offer.create' | 'call.bridge' | 'call.hangup' | 'offer.cancel';
  agentId?: string;
  agentExtension?: string;
  expiresAt?: string;
  reason?: string;
}

export interface ManagedVoiceDirectPort {
  execute(command: ManagedVoiceDirectCommand): Promise<{ confirmed: boolean }>;
  readback?(
    command: ManagedVoiceDirectCommand,
  ): Promise<{ callerExists: boolean; blegExists: boolean }>;
}

export interface ManagedVoiceEvent {
  tenantId: string;
  telephonyNodeId: string;
  callUuid: string;
  type: 'call.created' | 'call.answered' | 'call.bridge' | 'call.hangup';
  destination?: string;
  caller?: string;
  offerId?: string;
  agentId?: string;
  blegUuid?: string;
}

export interface ManagedVoiceResult {
  interactionId: string;
  status: 'QUEUED' | 'ASSIGNED' | 'ACTIVE' | 'WRAPUP' | 'COMPLETED' | 'ABANDONED';
  agentId?: string;
}
