/**
 * Cross-domain identifiers for CX Automation.
 *
 * This module intentionally has no database, framework, or service dependency.
 * The brand prevents accidentally interchanging identifiers within TypeScript while
 * preserving their JSON representation as a string at process boundaries.
 */
declare const identifierBrand: unique symbol;
declare const positiveIntegerBrand: unique symbol;

type IdentifierKind =
  | 'TenantId'
  | 'ContactId'
  | 'IdentityId'
  | 'TeamId'
  | 'SegmentId'
  | 'SegmentMembershipStreamId'
  | 'SegmentEntryId'
  | 'SegmentEvidenceRef'
  | 'ActionKey'
  | 'ReservationId'
  | 'DeliveryId'
  | 'ProviderRequestKey'
  | 'OutcomeRef'
  | 'InteractionId'
  | 'OutcomeId'
  | 'CommandId'
  | 'JourneyId'
  | 'EnrollmentId'
  | 'CaseId'
  | 'CampaignId'
  | 'RecordId'
  | 'CallbackId'
  | 'ContactPolicyId'
  | 'ContactPolicyVersionId'
  | 'ContactExceptionSeriesId'
  | 'ContactExceptionRevisionId'
  | 'ContactMutationId'
  | 'Cg4SubjectId'
  | 'Cg4DelegationId';

type PositiveIntegerKind =
  'SegmentDefinitionVersion' | 'MembershipRevision' | 'CustomerSnapshotVersion';

export type BrandedIdentifier<TKind extends IdentifierKind> = string & {
  readonly [identifierBrand]: TKind;
};

export type BrandedPositiveInteger<TKind extends PositiveIntegerKind> = number & {
  readonly [positiveIntegerBrand]: TKind;
};

export type TenantId = BrandedIdentifier<'TenantId'>;
export type ContactId = BrandedIdentifier<'ContactId'>;
export type IdentityId = BrandedIdentifier<'IdentityId'>;
export type TeamId = BrandedIdentifier<'TeamId'>;
export type SegmentId = BrandedIdentifier<'SegmentId'>;
export type SegmentMembershipStreamId = BrandedIdentifier<'SegmentMembershipStreamId'>;
export type SegmentEntryId = BrandedIdentifier<'SegmentEntryId'>;
export type SegmentEvidenceRef = BrandedIdentifier<'SegmentEvidenceRef'>;
export type SegmentDefinitionVersion = BrandedPositiveInteger<'SegmentDefinitionVersion'>;
export type MembershipRevision = BrandedPositiveInteger<'MembershipRevision'>;
export type CustomerSnapshotVersion = BrandedPositiveInteger<'CustomerSnapshotVersion'>;
export type ActionKey = BrandedIdentifier<'ActionKey'>;
export type ReservationId = BrandedIdentifier<'ReservationId'>;
export type DeliveryId = BrandedIdentifier<'DeliveryId'>;
export type ProviderRequestKey = BrandedIdentifier<'ProviderRequestKey'>;
export type OutcomeRef = BrandedIdentifier<'OutcomeRef'>;
export type InteractionId = BrandedIdentifier<'InteractionId'>;
export type OutcomeId = BrandedIdentifier<'OutcomeId'>;
export type CommandId = BrandedIdentifier<'CommandId'>;
export type JourneyId = BrandedIdentifier<'JourneyId'>;
export type EnrollmentId = BrandedIdentifier<'EnrollmentId'>;
export type CaseId = BrandedIdentifier<'CaseId'>;
export type CampaignId = BrandedIdentifier<'CampaignId'>;
export type RecordId = BrandedIdentifier<'RecordId'>;
export type CallbackId = BrandedIdentifier<'CallbackId'>;
export type ContactPolicyId = BrandedIdentifier<'ContactPolicyId'>;
export type ContactPolicyVersionId = BrandedIdentifier<'ContactPolicyVersionId'>;
export type ContactExceptionSeriesId = BrandedIdentifier<'ContactExceptionSeriesId'>;
export type ContactExceptionRevisionId = BrandedIdentifier<'ContactExceptionRevisionId'>;
export type ContactMutationId = BrandedIdentifier<'ContactMutationId'>;
/** Stable, immutable IAM subject id of a human — never email, display name, session or role. */
export type Cg4SubjectId = BrandedIdentifier<'Cg4SubjectId'>;
export type Cg4DelegationId = BrandedIdentifier<'Cg4DelegationId'>;

function identifier<TKind extends IdentifierKind>(
  value: string,
  kind: TKind,
): BrandedIdentifier<TKind> {
  if (value.trim().length === 0) {
    throw new TypeError(`${kind} ต้องเป็น string ที่ไม่ว่าง`);
  }
  return value as BrandedIdentifier<TKind>;
}

function positiveInteger<TKind extends PositiveIntegerKind>(
  value: number,
  kind: TKind,
): BrandedPositiveInteger<TKind> {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${kind} ต้องเป็นจำนวนเต็มตั้งแต่ 1`);
  }
  return value as BrandedPositiveInteger<TKind>;
}

export function tenantId(value: string): TenantId {
  return identifier(value, 'TenantId');
}

export function contactId(value: string): ContactId {
  return identifier(value, 'ContactId');
}

export function identityId(value: string): IdentityId {
  return identifier(value, 'IdentityId');
}

export function teamId(value: string): TeamId {
  return identifier(value, 'TeamId');
}

export function segmentId(value: string): SegmentId {
  return identifier(value, 'SegmentId');
}

export function segmentMembershipStreamId(value: string): SegmentMembershipStreamId {
  return identifier(value, 'SegmentMembershipStreamId');
}

export function segmentEntryId(value: string): SegmentEntryId {
  return identifier(value, 'SegmentEntryId');
}

export function segmentEvidenceRef(value: string): SegmentEvidenceRef {
  return identifier(value, 'SegmentEvidenceRef');
}

export function segmentDefinitionVersion(value: number): SegmentDefinitionVersion {
  return positiveInteger(value, 'SegmentDefinitionVersion');
}

export function membershipRevision(value: number): MembershipRevision {
  return positiveInteger(value, 'MembershipRevision');
}

export function customerSnapshotVersion(value: number): CustomerSnapshotVersion {
  return positiveInteger(value, 'CustomerSnapshotVersion');
}

export function actionKey(value: string): ActionKey {
  return identifier(value, 'ActionKey');
}

export function reservationId(value: string): ReservationId {
  return identifier(value, 'ReservationId');
}

export function deliveryId(value: string): DeliveryId {
  return identifier(value, 'DeliveryId');
}

export function providerRequestKey(value: string): ProviderRequestKey {
  return identifier(value, 'ProviderRequestKey');
}

export function outcomeRef(value: string): OutcomeRef {
  return identifier(value, 'OutcomeRef');
}

export function interactionId(value: string): InteractionId {
  return identifier(value, 'InteractionId');
}

export function outcomeId(value: string): OutcomeId {
  return identifier(value, 'OutcomeId');
}

export function commandId(value: string): CommandId {
  return identifier(value, 'CommandId');
}

export function journeyId(value: string): JourneyId {
  return identifier(value, 'JourneyId');
}

export function enrollmentId(value: string): EnrollmentId {
  return identifier(value, 'EnrollmentId');
}

export function caseId(value: string): CaseId {
  return identifier(value, 'CaseId');
}

export function campaignId(value: string): CampaignId {
  return identifier(value, 'CampaignId');
}

export function recordId(value: string): RecordId {
  return identifier(value, 'RecordId');
}

export function callbackId(value: string): CallbackId {
  return identifier(value, 'CallbackId');
}

export function contactPolicyId(value: string): ContactPolicyId {
  return identifier(value, 'ContactPolicyId');
}

export function contactPolicyVersionId(value: string): ContactPolicyVersionId {
  return identifier(value, 'ContactPolicyVersionId');
}

export function contactExceptionSeriesId(value: string): ContactExceptionSeriesId {
  return identifier(value, 'ContactExceptionSeriesId');
}

export function contactExceptionRevisionId(value: string): ContactExceptionRevisionId {
  return identifier(value, 'ContactExceptionRevisionId');
}

export function contactMutationId(value: string): ContactMutationId {
  return identifier(value, 'ContactMutationId');
}

export function cg4SubjectId(value: string): Cg4SubjectId {
  return identifier(value, 'Cg4SubjectId');
}

export function cg4DelegationId(value: string): Cg4DelegationId {
  return identifier(value, 'Cg4DelegationId');
}
