export type TelephonyVendor = 'freeswitch' | 'asterisk';

export type TelephonyCallEventType = 'call.created' | 'call.answered' | 'call.hangup';

export interface TelephonyCallEvent extends Record<string, unknown> {
  callUuid: string;
  vendor: TelephonyVendor;
  caller: string;
  destination: string;
}

export interface TelephonyCommand extends Record<string, unknown> {
  callUuid: string;
  vendor: TelephonyVendor;
  type: 'call.bridge';
  agentExtension: string;
}
