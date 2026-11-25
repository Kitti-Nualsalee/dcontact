/**
 * Owner: Delivery/Channels — synthetic pilot tuple of the LINE in-memory simulation (S1.6)
 *
 * These values are frozen per decisions #100/#102: one synthetic pair of pilot tenant + guard tenant,
 * a synthetic sender identity in APPROVED state bound to the pilot tenant only, constant purpose/kind.
 * Must not be expanded to multiple tenants/senders/channels in S1 — adding a new scope needs a new decision
 */

export const LINE_SIMULATION_PROFILE = 's1-line-sim-v1';

export const PILOT_TENANT_ID = 'tenant-line-pilot';
export const GUARD_TENANT_ID = 'tenant-line-guard';

export const LINE_CHANNEL = 'LINE' as const;
export const LINE_PURPOSE = 'SERVICE_NOTIFICATION';
export const LINE_CONTACT_KIND = 'SERVICE';

export const PILOT_SENDER_IDENTITY_ID = 'line-sender-pilot-approved';
export const PILOT_SENDER_STATUS = 'APPROVED' as const;

/** allowlisted synthetic fixtures only — no real contact/content in any scenario */
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

/** fixture cap: the S1 test-harness contract, not the real LINE quota/SLA */
export const LINE_SIMULATION_CAPS = {
  windowMs: 15 * 60_000,
  maxSubmissionsPerWindow: 20,
  maxConcurrentSubmissions: 2,
  maxSubmissionsPerContactPerWindow: 1,
  maxConcurrentUnknownReconciling: 1,
  unknownReconcilingTimeoutMs: 30_000,
} as const;
