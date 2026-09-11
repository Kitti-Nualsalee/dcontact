import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgCallbackMode,
  type CgDecision,
  type CgReservationState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import { evaluateContactPolicy, type ContactPolicyTraceEntry } from './contact-policy.js';
import { evaluateCg3Policy } from './cg3-policy-evaluator.js';
import { loadCg3Facts } from './cg3-fact-loader.js';
import { transitionReservation, type ReservationCommand } from './reservation.js';
import { ReservationRuntime, type ReservationRuntimeOptions } from './reservation-runtime.js';

import {
  IdempotencyConflictError,
  ReservationBindingError,
  ReservationNotFoundError,
  ReservationNotUsableError,
  type AuthorizeAndReserveInput,
  type AuthorizationOutcome,
  type ContactAuthorizationPort,
  type ContactGovernancePort,
  type ClaimReservationForDeliveryInput,
  type RenewReservationLeaseInput,
  type BeginProviderSubmissionInput,
  type ConfirmProviderAcceptanceInput,
  type ReleaseBeforeSubmitInput,
  type SettleDeliveryInput,
  type ReservationSettlementView,
  type ReservationView,
} from '@d-contact/cxa-contracts';
export {
  IdempotencyConflictError,
  ReservationNotFoundError,
  ReservationNotUsableError,
  type AuthorizeAndReserveInput,
  type AuthorizationOutcome,
  type ReservationNotUsableCode,
  type ReservationView,
} from '@d-contact/cxa-contracts';

const RESERVATION_TTL_MS = 15 * 60 * 1_000;

export interface ContactGovernanceServiceOptions extends ReservationRuntimeOptions {}

const decisionSelection = {
  id: true,
  inputHash: true,
  decision: true,
  reasonCode: true,
  policyVersion: true,
  trace: true,
  aggregateVersion: true,
  preferenceVersion: true,
  nextEligibleAt: true,
  timezoneSource: true,
  matchedScope: true,
  matchedWindowRef: true,
  exceptionMode: true,
  exceptionRef: true,
  reservation: {
    select: {
      id: true,
      expiresAt: true,
    },
  },
} as const;

const reservationSelection = {
  id: true,
  state: true,
  expiresAt: true,
  confirmedAt: true,
  releasedAt: true,
  refundedAt: true,
  deliveryId: true,
  providerRequestKey: true,
  submissionStartedAt: true,
} as const;

function hashAuthorizationInput(input: AuthorizeAndReserveInput): string {
  const canonicalInput = JSON.stringify({
    actionKey: input.actionKey,
    channel: input.channel,
    contactId: input.contactId,
    identityId: input.identityId ?? null,
    policyVersion: input.policyVersion,
    purpose: input.purpose,
    source: input.source,
    sourceId: input.sourceId,
    teamId: input.teamId ?? null,
    contactKind: input.contactKind ?? null,
    senderIdentityId: input.senderIdentityId ?? null,
    ...(input.identityResolution ? { identityResolution: input.identityResolution } : {}),
  });
  return createHash('sha256').update(canonicalInput).digest('hex');
}

function toOutcome(decision: {
  id: string;
  decision: CgDecision;
  reasonCode: string;
  policyVersion: number;
  trace: Prisma.JsonValue;
  aggregateVersion: number | null;
  preferenceVersion: number | null;
  nextEligibleAt: Date | null;
  timezoneSource: string | null;
  matchedScope: Prisma.JsonValue;
  matchedWindowRef: string | null;
  exceptionMode: string | null;
  exceptionRef: string | null;
  reservation: { id: string; expiresAt: Date } | null;
}): AuthorizationOutcome {
  return {
    decisionId: decision.id,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    policyVersion: decision.policyVersion,
    trace: decision.trace as unknown as ContactPolicyTraceEntry[],
    ...(decision.aggregateVersion !== null ? { aggregateVersion: decision.aggregateVersion } : {}),
    ...(decision.preferenceVersion !== null
      ? { preferenceVersion: decision.preferenceVersion }
      : {}),
    ...(decision.nextEligibleAt ? { nextEligibleAt: decision.nextEligibleAt.toISOString() } : {}),
    ...(decision.timezoneSource ? { timezoneSource: decision.timezoneSource } : {}),
    ...(decision.matchedScope
      ? { matchedScope: decision.matchedScope as unknown as Record<string, string | null> }
      : {}),
    ...(decision.matchedWindowRef ? { matchedWindowRef: decision.matchedWindowRef } : {}),
    ...(decision.exceptionMode
      ? { exceptionMode: decision.exceptionMode as AuthorizationOutcome['exceptionMode'] }
      : {}),
    ...(decision.exceptionRef ? { exceptionRef: decision.exceptionRef } : {}),
    ...(decision.reservation
      ? {
          reservationId: decision.reservation.id,
          reservationExpiresAt: decision.reservation.expiresAt.toISOString(),
        }
      : {}),
  };
}

function toReservationView(reservation: {
  id: string;
  state: CgReservationState;
  expiresAt: Date;
  confirmedAt: Date | null;
  releasedAt: Date | null;
  refundedAt: Date | null;
}): ReservationView {
  return {
    id: reservation.id,
    state: reservation.state,
    expiresAt: reservation.expiresAt.toISOString(),
    ...(reservation.confirmedAt ? { confirmedAt: reservation.confirmedAt.toISOString() } : {}),
    ...(reservation.releasedAt ? { releasedAt: reservation.releasedAt.toISOString() } : {}),
    ...(reservation.refundedAt ? { refundedAt: reservation.refundedAt.toISOString() } : {}),
  };
}

export class ContactGovernanceService
  implements ContactAuthorizationPort<Prisma.TransactionClient>, ContactGovernancePort
{
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly reservationRuntime: ReservationRuntime;

  constructor(
    private readonly database: PrismaClient,
    options: ContactGovernanceServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.reservationRuntime = new ReservationRuntime(database, {
      ...options,
      now: this.now,
      id: this.id,
    });
  }

  claimReservationForDelivery(
    input: ClaimReservationForDeliveryInput,
  ): Promise<ReservationSettlementView> {
    return this.reservationRuntime.claim(input);
  }

  renewReservationLease(input: RenewReservationLeaseInput): Promise<ReservationSettlementView> {
    return this.reservationRuntime.renew(input);
  }

  beginProviderSubmission(input: BeginProviderSubmissionInput): Promise<ReservationSettlementView> {
    return this.reservationRuntime.beginSubmission(input);
  }

  confirmProviderAcceptance(
    input: ConfirmProviderAcceptanceInput,
  ): Promise<ReservationSettlementView> {
    return this.reservationRuntime.confirm(input);
  }

  releaseBeforeSubmit(input: ReleaseBeforeSubmitInput): Promise<ReservationSettlementView> {
    return this.reservationRuntime.release(input);
  }

  settleDelivery(input: SettleDeliveryInput): Promise<ReservationSettlementView> {
    return this.reservationRuntime.settle(input);
  }

  async authorizeAndReserve(
    tenantId: string,
    input: AuthorizeAndReserveInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<AuthorizationOutcome> {
    const inputHash = hashAuthorizationInput(input);

    const authorize = async (transactionClient: Prisma.TransactionClient) => {
      const transaction = transactionClient;
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`action:${tenantId}:${input.actionKey}`}))`,
      );
      if (input.contactId) {
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`contact:${tenantId}:${input.contactId}`}))`,
        );
        // ล็อกเดียวกับ Cg3PreferenceRepository.append() เพื่อไม่ให้ preference/callback mutation
        // แทรกระหว่างที่ authorizeAndReserve กำลังโหลด CG3 facts มาประเมิน (S1-CG3-CC01)
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg3-contact:${tenantId}:${input.contactId}`}))`,
        );
      }

      const existing = await transaction.cgDecisionLog.findFirst({
        where: { tenantId, actionKey: input.actionKey },
        orderBy: { decidedAt: 'desc' },
        select: decisionSelection,
      });
      if (existing) {
        if (existing.inputHash !== inputHash) {
          throw new IdempotencyConflictError(input.actionKey);
        }
        return toOutcome(existing);
      }

      const now = this.now();
      const contact = input.contactId
        ? await transaction.contact.findFirst({
            where: { id: input.contactId, tenantId },
            select: { id: true },
          })
        : null;
      const identity = input.identityId
        ? await transaction.contactIdentity.findFirst({
            where: { id: input.identityId, contactId: input.contactId, tenantId },
            select: { id: true },
          })
        : undefined;
      const identityResolution =
        input.identityResolution ??
        (!contact || (input.identityId && !identity) ? 'NOT_FOUND' : 'RESOLVED');

      const restriction = contact
        ? await transaction.cgRestriction.findFirst({
            where: {
              tenantId,
              startsAt: { lte: now },
              AND: [
                { OR: [{ contactId: null }, { contactId: input.contactId }] },
                {
                  OR: input.identityId
                    ? [{ identityId: null }, { identityId: input.identityId }]
                    : [{ identityId: null }],
                },
                { OR: [{ channel: null }, { channel: input.channel }] },
                { OR: [{ purpose: null }, { purpose: input.purpose }] },
                { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
              ],
            },
            orderBy: { startsAt: 'desc' },
            select: { type: true, reasonCode: true, overridable: true },
          })
        : null;

      const consent =
        contact && identityResolution === 'RESOLVED'
          ? await transaction.cgConsent.findFirst({
              where: {
                tenantId,
                contactId: input.contactId,
                purpose: input.purpose,
                channel: input.channel,
                OR: input.identityId
                  ? [{ identityId: null }, { identityId: input.identityId }]
                  : [{ identityId: null }],
              },
              orderBy: { createdAt: 'desc' },
              select: { status: true, lawfulBasis: true, expiresAt: true },
            })
          : null;

      const policyResult = evaluateContactPolicy({
        policyVersion: input.policyVersion,
        identityResolution,
        ...(restriction
          ? {
              activeRestriction: {
                type: restriction.type,
                reasonCode: restriction.reasonCode,
                overridable: restriction.overridable,
              },
            }
          : {}),
        ...(consent
          ? {
              consent: {
                status:
                  consent.status === 'GRANTED' && consent.expiresAt && consent.expiresAt <= now
                    ? ('EXPIRED' as const)
                    : consent.status,
                lawfulBasis: consent.lawfulBasis,
              },
            }
          : {}),
      });
      const decisionId = this.id();

      let trace: ContactPolicyTraceEntry[] = policyResult.trace;
      let decision = policyResult.decision;
      let reasonCode = policyResult.reasonCode;
      let cg3AggregateVersion: number | undefined;
      let cg3PolicyVersion: number | undefined;
      let cg3PreferenceVersion: number | undefined;
      let cg3NextEligibleAt: Date | undefined;
      let cg3TimezoneSource: string | undefined;
      let cg3MatchedScope: Record<string, string | null> | undefined;
      let cg3MatchedWindowRef: string | undefined;
      let cg3ExceptionMode: string | undefined;
      let cg3ExceptionRef: string | undefined;

      if (policyResult.decision === 'ALLOW' && input.contactId) {
        const facts = await loadCg3Facts(transaction, {
          tenantId,
          contactId: input.contactId,
          identityId: input.identityId,
          channel: input.channel,
          purpose: input.purpose,
          contactKind: input.contactKind,
          now,
        });
        const cg3 = evaluateCg3Policy({
          now,
          identityId: input.identityId,
          channel: input.channel,
          purpose: input.purpose,
          contactKind: input.contactKind,
          senderIdentityId: input.senderIdentityId,
          preferences: facts.preferences,
          policy: facts.policy,
          activeCallback: facts.activeCallback,
        });
        trace = [
          ...policyResult.trace.map((entry, index) =>
            index === policyResult.trace.length - 1 && entry.outcome === 'ALLOW'
              ? { gate: entry.gate, outcome: 'PASS' as const }
              : entry,
          ),
          ...cg3.trace,
        ];
        cg3AggregateVersion = facts.aggregateVersion;
        cg3PolicyVersion = facts.policy?.version;
        cg3PreferenceVersion = cg3.preferenceVersion;
        cg3NextEligibleAt = cg3.nextEligibleAt ? new Date(cg3.nextEligibleAt) : undefined;
        cg3TimezoneSource = cg3.timezoneSource;
        cg3MatchedScope = cg3.matchedScope;
        cg3MatchedWindowRef = cg3.matchedWindowRef;
        cg3ExceptionMode = cg3.exceptionMode;
        cg3ExceptionRef = cg3.exceptionRef;

        if (cg3.decision) {
          decision = cg3.decision;
          reasonCode = cg3.reasonCode!;
        } else {
          decision = 'ALLOW';
          reasonCode = 'POLICY_PASSED';
        }

        if (cg3.consumedCallbackRequestId) {
          const original = await transaction.cgCallbackRequest.findUniqueOrThrow({
            where: { tenantId_id: { tenantId, id: cg3.consumedCallbackRequestId } },
          });
          await transaction.cgCallbackRequest.create({
            data: {
              id: this.id(),
              tenantId,
              seriesId: original.seriesId,
              version: original.version + 1,
              contactId: original.contactId,
              identityId: original.identityId,
              channel: original.channel,
              purpose: original.purpose,
              requestedAt: original.requestedAt,
              requestedTimezone: original.requestedTimezone,
              expiresAt: original.expiresAt,
              sourceKind: original.sourceKind,
              sourceVersion: original.sourceVersion,
              oneUseTokenHash: createHash('sha256')
                .update(`consume:${original.id}:${decisionId}`)
                .digest('hex'),
              approvedExceptionId: original.approvedExceptionId,
              mutationKind: 'CONSUME',
              supersedesId: original.id,
              evidenceRef: `system:authorizeAndReserve:${decisionId}`,
              requestHash: createHash('sha256')
                .update(`consume:${original.id}:${original.version + 1}`)
                .digest('hex'),
              actorClass: 'SYSTEM',
            },
          });
        }
      }

      let reservationId: string | undefined;
      let reservationExpiresAt: Date | undefined;

      if (decision === 'ALLOW') {
        if (!input.contactId) {
          throw new Error('ผล ALLOW ต้องมี contact ที่ resolve แล้ว');
        }
        reservationId = this.id();
        reservationExpiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
        await transaction.cgReservation.create({
          data: {
            id: reservationId,
            tenantId,
            contactId: input.contactId,
            identityId: input.identityId,
            channel: input.channel,
            purpose: input.purpose,
            source: input.source,
            sourceId: input.sourceId,
            teamId: input.teamId,
            actionKey: input.actionKey,
            inputHash,
            expiresAt: reservationExpiresAt,
            settlementStatus: 'UNCLAIMED',
            authorizationAggregateVersion: cg3AggregateVersion,
            authorizationPolicyVersion: cg3PolicyVersion,
          },
        });
      }

      const created = await transaction.cgDecisionLog.create({
        data: {
          id: decisionId,
          tenantId,
          contactId: contact?.id,
          identityId: identity?.id,
          channel: input.channel,
          purpose: input.purpose,
          source: input.source,
          sourceId: input.sourceId,
          teamId: input.teamId,
          actionKey: input.actionKey,
          inputHash,
          decision,
          reasonCode,
          policyVersion: policyResult.policyVersion,
          gate: trace.at(-1)?.gate ?? 'IDENTITY',
          trace: trace as unknown as Prisma.InputJsonValue,
          reservationId,
          decidedAt: now,
          aggregateVersion: cg3AggregateVersion,
          preferenceVersion: cg3PreferenceVersion,
          nextEligibleAt: cg3NextEligibleAt,
          timezoneSource: cg3TimezoneSource,
          matchedScope: cg3MatchedScope as unknown as Prisma.InputJsonValue | undefined,
          matchedWindowRef: cg3MatchedWindowRef,
          exceptionMode: cg3ExceptionMode as CgCallbackMode | undefined,
          exceptionRef: cg3ExceptionRef,
        },
        select: decisionSelection,
      });

      if (reservationId) {
        await transaction.cgReservation.update({
          where: { id: reservationId },
          data: { authorizationDecisionId: decisionId },
        });
      }

      return toOutcome(created);
    };
    return transaction
      ? authorize(transaction)
      : withTenantDatabaseTransaction(this.database, tenantId, authorize);
  }

  async changeReservationState(
    tenantId: string,
    reservationId: string,
    command: ReservationCommand,
  ): Promise<ReservationView> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`reservation:${tenantId}:${reservationId}`}))`,
      );
      const current = await transaction.cgReservation.findFirst({
        where: { id: reservationId, tenantId },
        select: reservationSelection,
      });
      if (!current) throw new ReservationNotFoundError(reservationId);
      if (current.deliveryId) {
        throw new ReservationBindingError(
          current.submissionStartedAt || current.providerRequestKey
            ? 'DELIVERY_RECONCILIATION_REQUIRED'
            : 'INVALID_RESERVATION_TRANSITION',
        );
      }

      const next = transitionReservation({ id: current.id, state: current.state }, command);
      if (next.state === current.state) return toReservationView(current);

      const now = this.now();
      const updated = await transaction.cgReservation.update({
        where: { id: current.id },
        data: {
          state: next.state,
          ...(next.state === 'CONFIRMED' ? { confirmedAt: now } : {}),
          ...(next.state === 'RELEASED' ? { releasedAt: now } : {}),
          ...(next.state === 'REFUNDED' ? { refundedAt: now } : {}),
        },
        select: reservationSelection,
      });
      return toReservationView(updated);
    });
  }

  async validateReservationForDelivery(
    tenantId: string,
    reservationId: string,
  ): Promise<ReservationView> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const reservation = await transaction.cgReservation.findFirst({
        where: { id: reservationId, tenantId },
        select: reservationSelection,
      });
      if (!reservation) {
        throw new ReservationNotUsableError('RESERVATION_NOT_FOUND', reservationId);
      }
      if (reservation.state !== 'RESERVED') {
        throw new ReservationNotUsableError('RESERVATION_NOT_RESERVED', reservationId);
      }
      if (reservation.expiresAt <= this.now()) {
        throw new ReservationNotUsableError('RESERVATION_EXPIRED', reservationId);
      }
      return toReservationView(reservation);
    });
  }

  async releaseExpiredReservations(tenantId: string, limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('reservation sweep limit must be an integer between 1 and 500');
    }
    const now = this.now();

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const released = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH expired AS (
          SELECT id
          FROM cg_reservations
          WHERE tenant_id = ${tenantId}::uuid
            AND state = 'RESERVED'
            AND submission_started_at IS NULL
            AND provider_request_key IS NULL
            AND (settlement_status IS NULL OR settlement_status IN ('UNCLAIMED', 'CLAIMED'))
            AND COALESCE(lease_expires_at, expires_at) <= ${now}
          ORDER BY COALESCE(lease_expires_at, expires_at), id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE cg_reservations AS reservation
        SET state = 'RELEASED',
            settlement_status = 'SETTLED',
            released_at = ${now},
            settled_at = ${now},
            updated_at = ${now}
        FROM expired
        WHERE reservation.id = expired.id
        RETURNING reservation.id
      `);
      return released.length;
    });
  }
}
