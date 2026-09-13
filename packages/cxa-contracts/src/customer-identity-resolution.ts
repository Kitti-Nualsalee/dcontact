import type { SegmentMembershipSnapshot } from './customer-context.js';
import type { ContactId, TenantId } from './identifiers.js';

/**
 * Additive for J2 (#122): canonical owner facts (e.g. an interaction outcome) carry
 * an internal `contactId` already, unlike C1's `CustomerContextReader` which resolves
 * an unauthenticated caller-supplied `ContactReference` (phone/email/LINE/CRM ID).
 * This port answers a different question — "what is this internal contactId's
 * current survivor and membership right now" — and does not change what the
 * `CONTACT` reference-resolution port means or how existing C1 callers use it.
 */
export interface ResolveContactIdentityInput {
  tenantId: TenantId;
  contactId: ContactId;
  at: string;
}

export interface ResolvedContactIdentity {
  status: 'RESOLVED';
  /** Survivor contactId within the same tenant; equals the input when no merge applies. */
  contactId: ContactId;
  /** Present only when the input contactId was merged into a different survivor. */
  originalContactId?: ContactId;
  segmentMemberships: readonly SegmentMembershipSnapshot[];
  snapshotVersion: number;
  evaluatedAt: string;
}

export interface AmbiguousContactIdentity {
  status: 'AMBIGUOUS';
  reasonCode: 'IDENTITY_AMBIGUOUS';
}

export interface UnresolvedContactIdentity {
  status: 'NOT_FOUND';
  reasonCode: 'IDENTITY_NOT_FOUND';
}

export type ContactIdentityResolution =
  ResolvedContactIdentity | AmbiguousContactIdentity | UnresolvedContactIdentity;

/**
 * Customer 360 owns this read boundary, same as `CustomerContextReader`. Callers
 * never supply a survivor/merge decision for this port to trust; a cross-tenant
 * contactId must resolve as `NOT_FOUND`, never leak the foreign object's existence.
 */
export interface CustomerIdentityResolver<TContext = undefined> {
  resolveByContactId(
    input: ResolveContactIdentityInput,
    context?: TContext,
  ): Promise<ContactIdentityResolution>;
}
