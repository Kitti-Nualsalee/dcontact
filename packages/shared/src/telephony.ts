export type TelephonyVendor = 'freeswitch' | 'asterisk';

export type TelephonyCallEventType = 'call.created' | 'call.answered' | 'call.hangup';

export interface TelephonyCallEvent extends Record<string, unknown> {
  callUuid: string;
  vendor: TelephonyVendor;
  /** node ที่ครอบครอง media session นี้; tenant ไม่ได้ผูกกับ node */
  telephonyNodeId: string;
  caller: string;
  destination: string;
}

export interface TelephonyCommand extends Record<string, unknown> {
  callUuid: string;
  vendor: TelephonyVendor;
  /** command ต้องกลับไป node เดียวกับ event ต้นทาง */
  telephonyNodeId: string;
  type: 'call.bridge';
  agentExtension: string;
}
