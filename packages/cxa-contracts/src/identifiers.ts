/**
 * Cross-domain identifiers for CX Automation.
 *
 * This module intentionally has no database, framework, or service dependency.
 * The brand prevents accidentally interchanging identifiers within TypeScript while
 * preserving their JSON representation as a string at process boundaries.
 */
declare const identifierBrand: unique symbol;

type IdentifierKind =
  | 'TenantId'
  | 'ContactId'
  | 'IdentityId'
  | 'TeamId'
  | 'SegmentId'
  | 'ActionKey'
  | 'ReservationId'
  | 'DeliveryId'
  | 'ProviderRequestKey'
  | 'OutcomeRef';

export type BrandedIdentifier<TKind extends IdentifierKind> = string & {
  readonly [identifierBrand]: TKind;
};

export type TenantId = BrandedIdentifier<'TenantId'>;
export type ContactId = BrandedIdentifier<'ContactId'>;
export type IdentityId = BrandedIdentifier<'IdentityId'>;
export type TeamId = BrandedIdentifier<'TeamId'>;
export type SegmentId = BrandedIdentifier<'SegmentId'>;
export type ActionKey = BrandedIdentifier<'ActionKey'>;
export type ReservationId = BrandedIdentifier<'ReservationId'>;
export type DeliveryId = BrandedIdentifier<'DeliveryId'>;
export type ProviderRequestKey = BrandedIdentifier<'ProviderRequestKey'>;
export type OutcomeRef = BrandedIdentifier<'OutcomeRef'>;

function identifier<TKind extends IdentifierKind>(
  value: string,
  kind: TKind,
): BrandedIdentifier<TKind> {
  if (value.trim().length === 0) {
    throw new TypeError(`${kind} ต้องเป็น string ที่ไม่ว่าง`);
  }
  return value as BrandedIdentifier<TKind>;
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
