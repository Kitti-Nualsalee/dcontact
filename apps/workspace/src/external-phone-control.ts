export type WorkspacePhoneControlMode = 'browser' | 'external-simulator';

export function resolvePhoneControlMode(value: unknown): WorkspacePhoneControlMode {
  return value === 'external-simulator' ? value : 'browser';
}

/** Local control simulator only: never produces Interaction, SIP or routing events. */
export type ExternalPhonePhase = 'DISCONNECTED' | 'IDLE' | 'RINGING' | 'ACTIVE' | 'ENDED';
export type ExternalPhoneAction = 'connect' | 'incoming' | 'accept' | 'hangup' | 'disconnect';

export function reduceExternalPhone(
  phase: ExternalPhonePhase,
  action: ExternalPhoneAction,
): ExternalPhonePhase {
  if (action === 'disconnect') return 'DISCONNECTED';
  if (action === 'connect' && phase === 'DISCONNECTED') return 'IDLE';
  if (action === 'incoming' && (phase === 'IDLE' || phase === 'ENDED')) return 'RINGING';
  if (action === 'accept' && phase === 'RINGING') return 'ACTIVE';
  if (action === 'hangup' && (phase === 'RINGING' || phase === 'ACTIVE')) return 'ENDED';
  return phase;
}
