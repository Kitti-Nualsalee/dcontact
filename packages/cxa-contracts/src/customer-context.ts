import type { ContactId, IdentityId, SegmentId, TenantId } from './identifiers.js';

/**
 * The reference supplied by a trusted caller to resolve a customer. Its value may
 * be PII, so it is input-only and must never be echoed in a resolution result.
 */
export interface ContactReference {
  kind: 'PHONE' | 'EMAIL' | 'LINE' | 'CRM_ID';
  value: string;
}

export interface SegmentMembershipSnapshot {
  segmentId: SegmentId;
  /** Version of the segment definition used for this membership evaluation. */
  membershipVersion: number;
  effectiveFrom: string;
}

export interface ResolveCurrentContextInput {
  tenantId: TenantId;
  contactRef: ContactReference;
  at: string;
}

export interface ResolvedCustomerContext {
  status: 'RESOLVED';
  contactId: ContactId;
  identityId?: IdentityId;
  segmentMemberships: readonly SegmentMembershipSnapshot[];
  /** Version of the returned membership snapshot, not an arbitrary caller value. */
  snapshotVersion: number;
  evaluatedAt: string;
}

export interface AmbiguousCustomerContext {
  status: 'AMBIGUOUS';
  reasonCode: 'IDENTITY_AMBIGUOUS';
}

export interface MissingCustomerContext {
  status: 'NOT_FOUND';
  reasonCode: 'IDENTITY_NOT_FOUND';
}

/**
 * Cus360 C3 (#793): identity เดิมยังไม่ถูก import เป็น contact point จึงตัดสินไม่ได้ในตอนนี้
 * ไม่ใช่ NOT_FOUND: consumer ต้องไม่บันทึกผลถาวร และ retry หลัง import ครบ (ไม่ fallback ไปค่า raw)
 */
export interface DeferredCustomerContext {
  status: 'DEFERRED';
  reasonCode: 'IDENTITY_MAPPING_PENDING';
}

export type CustomerContextResolution =
  | ResolvedCustomerContext
  | AmbiguousCustomerContext
  | MissingCustomerContext
  | DeferredCustomerContext;

/**
 * Customer 360 owns this read boundary. Implementations resolve current identity
 * and segment membership from authoritative data; consumers never supply a
 * membership snapshot for this port to trust.
 */
export interface CustomerContextReader<TContext = undefined> {
  resolveCurrentContext(
    input: ResolveCurrentContextInput,
    context?: TContext,
  ): Promise<CustomerContextResolution>;
}
