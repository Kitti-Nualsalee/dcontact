/**
 * Owner: Delivery/Channels — synthetic pilot tuple ของ LINE in-memory simulation (S1.6)
 *
 * ค่าเหล่านี้ freeze ตามคำตัดสิน #100/#102: pilot tenant + guard tenant สังเคราะห์ 1 คู่,
 * sender identity สังเคราะห์สถานะ APPROVED ผูก pilot tenant เท่านั้น, purpose/kind คงที่
 * ห้ามขยายเป็นหลาย tenant/sender/channel ใน S1 — เพิ่ม scope ใหม่ต้องเปิด decision ใหม่
 */

export const LINE_SIMULATION_PROFILE = 's1-line-sim-v1';

export const PILOT_TENANT_ID = 'tenant-line-pilot';
export const GUARD_TENANT_ID = 'tenant-line-guard';

export const LINE_CHANNEL = 'LINE' as const;
export const LINE_PURPOSE = 'SERVICE_NOTIFICATION';
export const LINE_CONTACT_KIND = 'SERVICE';

export const PILOT_SENDER_IDENTITY_ID = 'line-sender-pilot-approved';
export const PILOT_SENDER_STATUS = 'APPROVED' as const;

/** allowlisted synthetic fixtures เท่านั้น — ไม่มี contact/content จริงในทุก scenario */
export const ALLOWLISTED_CONTACT_IDS = ['line-contact-a', 'line-contact-b', 'line-contact-c'];
export const ALLOWLISTED_CONTENT_REFS = ['line-content-ref-a', 'line-content-ref-b'];

export interface LineScopeTuple {
  tenantId: string;
  channel: typeof LINE_CHANNEL;
  senderIdentityId: string;
}

export const PILOT_SCOPE: LineScopeTuple = {
  tenantId: PILOT_TENANT_ID,
  channel: LINE_CHANNEL,
  senderIdentityId: PILOT_SENDER_IDENTITY_ID,
};

export function scopeKey(scope: LineScopeTuple): string {
  return JSON.stringify([scope.tenantId, scope.channel, scope.senderIdentityId]);
}

export function isAllowlistedScope(scope: LineScopeTuple): boolean {
  return scopeKey(scope) === scopeKey(PILOT_SCOPE);
}

/** fixture cap: test-harness contract ของ S1 ไม่ใช่ LINE quota/SLA จริง */
export const LINE_SIMULATION_CAPS = {
  windowMs: 15 * 60_000,
  maxSubmissionsPerWindow: 20,
  maxConcurrentSubmissions: 2,
  maxSubmissionsPerContactPerWindow: 1,
  maxConcurrentUnknownReconciling: 1,
  unknownReconcilingTimeoutMs: 30_000,
} as const;
