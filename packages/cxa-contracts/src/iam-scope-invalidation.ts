import type { TeamId, TenantId } from './identifiers.js';

export const IAM_SCOPE_INVALIDATION_KINDS = [
  'GRANTED',
  'REVOKED',
  'TEAM_DEACTIVATED',
  'DELEGATION_REVOKED',
] as const;

export type IamScopeInvalidationKind = (typeof IAM_SCOPE_INVALIDATION_KINDS)[number];

/** Opaque-only event emitted from IAM's transactional outbox. */
export type TeamSegmentScopeChangedPayloadV1 = Readonly<{
  contractVersion: 1;
  teamId: TeamId;
  grantId: string;
  scopeVersion: number;
  kind: IamScopeInvalidationKind;
}>;

export type TeamSegmentScopeChangedEnvelopeV2 = Readonly<{
  schemaVersion: 2;
  eventKind: 'CANONICAL';
  eventId: string;
  type: 'team.segment-scope.changed';
  tenantId: TenantId;
  occurredAt: string;
  correlationId: string;
  orderingKey: string;
  aggregateType: 'iam_team_scope';
  aggregateId: string;
  aggregateVersion: number;
  payload: TeamSegmentScopeChangedPayloadV1;
}>;

export function assertTeamSegmentScopeChangedEnvelope(
  value: unknown,
): TeamSegmentScopeChangedEnvelopeV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('IAM event ต้องเป็น object');
  const event = value as Record<string, unknown>;
  const payload = event.payload as Record<string, unknown> | undefined;
  if (
    event.schemaVersion !== 2 ||
    event.eventKind !== 'CANONICAL' ||
    event.type !== 'team.segment-scope.changed' ||
    event.aggregateType !== 'iam_team_scope' ||
    !payload ||
    payload.contractVersion !== 1 ||
    typeof payload.teamId !== 'string' ||
    typeof payload.grantId !== 'string' ||
    !Number.isInteger(payload.scopeVersion) ||
    !IAM_SCOPE_INVALIDATION_KINDS.includes(payload.kind as IamScopeInvalidationKind) ||
    event.orderingKey !== payload.teamId ||
    event.aggregateId !== payload.teamId ||
    event.aggregateVersion !== payload.scopeVersion ||
    typeof event.tenantId !== 'string' ||
    typeof event.eventId !== 'string' ||
    typeof event.occurredAt !== 'string' ||
    typeof event.correlationId !== 'string'
  )
    throw new TypeError('IAM team scope event ไม่ผ่าน closed contract');
  return event as unknown as TeamSegmentScopeChangedEnvelopeV2;
}
