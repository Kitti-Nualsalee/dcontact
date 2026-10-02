export type TelephonyVendor = 'freeswitch' | 'asterisk';

export type TelephonyCallEventType =
  'call.created' | 'call.answered' | 'call.hangup' | 'call.input';

export interface TelephonyCallEvent extends Record<string, unknown> {
  callUuid: string;
  vendor: TelephonyVendor;
  /** node ที่ครอบครอง media session นี้; tenant ไม่ได้ผูกกับ node */
  telephonyNodeId: string;
  caller: string;
  destination: string;
  /** มีเฉพาะสาย outbound ที่ Delivery สั่ง originate; เป็น opaque identifiers */
  deliveryId?: string;
  providerRequestKey?: string;
  hangupCause?: string;
  inputMode?: 'VOICE' | 'DTMF' | 'TIMEOUT';
  inputValue?: string;
}

interface TelephonyCallCommandBase extends Record<string, unknown> {
  callUuid: string;
  vendor: TelephonyVendor;
  /** command ต้องกลับไป node เดียวกับ event ต้นทาง */
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

/** E1.18 (#520): command ไม่พาเบอร์ปลายทาง — Telephony resolve `targetIdentityId` ใน tenant เอง */
export interface TelephonyOriginateCommand extends Record<string, unknown> {
  type: 'call.originate';
  vendor: TelephonyVendor;
  telephonyNodeId: string;
  deliveryId: string;
  /** opaque correlation สำหรับ provider-submission barrier และ terminal outcome */
  providerRequestKey: string;
  originationUuid: string;
  agentExtension: string;
  targetIdentityId: string;
}

/** E1.18: ขอหยุด originate หลัง submission barrier; outcome จริงยังมาจาก ESL เท่านั้น */
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
