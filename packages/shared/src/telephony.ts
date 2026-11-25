export type TelephonyVendor = 'freeswitch' | 'asterisk';

export type TelephonyCallEventType =
  'call.created' | 'call.answered' | 'call.hangup' | 'call.input';

export interface TelephonyCallEvent extends Record<string, unknown> {
  callUuid: string;
  vendor: TelephonyVendor;
  /** the node that owns this media session; the tenant is not bound to a node */
  telephonyNodeId: string;
  caller: string;
  destination: string;
  /** only for outbound calls that Delivery ordered to originate; opaque identifiers */
  deliveryId?: string;
  providerRequestKey?: string;
  hangupCause?: string;
  inputMode?: 'VOICE' | 'DTMF' | 'TIMEOUT';
  inputValue?: string;
}

interface TelephonyCallCommandBase extends Record<string, unknown> {
  callUuid: string;
  vendor: TelephonyVendor;
  /** the command must return to the same node as the originating event */
  telephonyNodeId: string;
}

export interface TelephonyBridgeCommand extends TelephonyCallCommandBase {
  type: 'call.bridge';
  agentExtension: string;
}

export interface TelephonyCollectCommand extends TelephonyCallCommandBase {
  type: 'call.collect';
  inputMode: 'VOICE' | 'DTMF';
  prompt: string;
  timeoutSec: number;
}

export interface TelephonyRecordingControlCommand extends TelephonyCallCommandBase {
  type: 'recording.pause' | 'recording.resume';
  recordingPath: string;
}

export interface TelephonyRecordingAnnouncementCommand extends TelephonyCallCommandBase {
  type: 'recording.announce';
  announcement: string;
  language: string;
}

export interface TelephonyRecordingStartCommand extends TelephonyCallCommandBase {
  type: 'recording.start';
  recordingPath: string;
  channelLayout: 'PER_LEG' | 'STEREO';
}

export interface TelephonySipRegistrationFlushCommand extends Record<string, unknown> {
  type: 'sip.registration.flush';
  vendor: TelephonyVendor;
  telephonyNodeId: string;
  extension: string;
  sipDomain: string;
  workSessionLeaseId: string;
}

/** E1.18 (#520): the command carries no destination number — Telephony resolves `targetIdentityId` inside the tenant itself */
export interface TelephonyOriginateCommand extends Record<string, unknown> {
  type: 'call.originate';
  vendor: TelephonyVendor;
  telephonyNodeId: string;
  deliveryId: string;
  /** opaque correlation for the provider-submission barrier and terminal outcome */
  providerRequestKey: string;
  originationUuid: string;
  agentExtension: string;
  targetIdentityId: string;
}

/** E1.18: asks to stop originate after the submission barrier; the real outcome still comes only from ESL */
export interface TelephonyCancelCommand extends Record<string, unknown> {
  type: 'call.cancel';
  vendor: TelephonyVendor;
  telephonyNodeId: string;
  callUuid: string;
  deliveryId: string;
  providerRequestKey: string;
}

export type TelephonyCommand =
  | TelephonyBridgeCommand
  | TelephonyCollectCommand
  | TelephonyRecordingControlCommand
  | TelephonyRecordingAnnouncementCommand
  | TelephonyRecordingStartCommand
  | TelephonySipRegistrationFlushCommand
  | TelephonyOriginateCommand
  | TelephonyCancelCommand;
