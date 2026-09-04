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
  inputMode?: 'VOICE' | 'DTMF' | 'TIMEOUT';
  inputValue?: string;
}

interface TelephonyCommandBase extends Record<string, unknown> {
  callUuid: string;
  vendor: TelephonyVendor;
  /** command ต้องกลับไป node เดียวกับ event ต้นทาง */
  telephonyNodeId: string;
}

export interface TelephonyBridgeCommand extends TelephonyCommandBase {
  type: 'call.bridge';
  agentExtension: string;
}

export interface TelephonyCollectCommand extends TelephonyCommandBase {
  type: 'call.collect';
  inputMode: 'VOICE' | 'DTMF';
  prompt: string;
  timeoutSec: number;
}

export interface TelephonyRecordingControlCommand extends TelephonyCommandBase {
  type: 'recording.pause' | 'recording.resume';
  recordingPath: string;
}

export interface TelephonyRecordingAnnouncementCommand extends TelephonyCommandBase {
  type: 'recording.announce';
  announcement: string;
  language: string;
}

export interface TelephonyRecordingStartCommand extends TelephonyCommandBase {
  type: 'recording.start';
  recordingPath: string;
  channelLayout: 'PER_LEG' | 'STEREO';
}

export type TelephonyCommand =
  | TelephonyBridgeCommand
  | TelephonyCollectCommand
  | TelephonyRecordingControlCommand
  | TelephonyRecordingAnnouncementCommand
  | TelephonyRecordingStartCommand;
