import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type ChannelType,
  type CgDecision,
  type CgReservationState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  evaluateContactPolicy,
  type ContactPolicyResult,
  type ContactPolicyTraceEntry,
} from './contact-policy.js';
import { transitionReservation, type ReservationCommand } from './reservation.js';

const RESERVATION_TTL_MS = 15 * 60 * 1_000;

export interface AuthorizeAndReserveInput {
  contactId: string;
  identityId?: string;
  channel: ChannelType;
  purpose: string;
  source: string;
  sourceId: string;
  actionKey: string;
  policyVersion: number;
  teamId?: string;
}

export interface AuthorizationOutcome {
  decisionId: string;
  decision: CgDecision;
  reasonCode: string;
  policyVersion: number;
  trace: ContactPolicyTraceEntry[];
  reservationId?: string;
  reservationExpiresAt?: string;
}

export interface ContactGovernanceServiceOptions {
  now?: () => Date;
  id?: () => string;
}

export interface ReservationView {
  id: string;
  state: CgReservationState;
  expiresAt: string;
  confirmedAt?: string;
  releasedAt?: string;
  refundedAt?: string;
}

export class IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly actionKey: string) {
    super(`actionKey was already used with different canonical input: ${actionKey}`);
    this.name = 'IdempotencyConflictError';
  }
}

export class ReservationNotFoundError extends Error {
  readonly code = 'RESERVATION_NOT_FOUND';

  constructor(readonly reservationId: string) {
    super(`reservation was not found in the active tenant: ${reservationId}`);
    this.name = 'ReservationNotFoundError';
  }
}

export type ReservationNotUsableCode =
  'RESERVATION_NOT_FOUND' | 'RESERVATION_NOT_RESERVED' | 'RESERVATION_EXPIRED';

export class ReservationNotUsableError extends Error {
  constructor(
    readonly code: ReservationNotUsableCode,
    readonly reservationId: string,
  ) {
    super(`reservation cannot be used for delivery: ${code}`);
    this.name = 'ReservationNotUsableError';
  }
}

const decisionSelection = {
  id: true,
  inputHash: true,
  decision: true,
  reasonCode: true,
  policyVersion: true,
  trace: true,
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
  });
  return createHash('sha256').update(canonicalInput).digest('hex');
}

function toOutcome(decision: {
  id: string;
  decision: CgDecision;
  reasonCode: string;
  policyVersion: number;
  trace: Prisma.JsonValue;
  reservation: { id: string; expiresAt: Date } | null;
}): AuthorizationOutcome {
  return {
    decisionId: decision.id,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    policyVersion: decision.policyVersion,
    trace: decision.trace as unknown as ContactPolicyTraceEntry[],
    ...(decision.reservation
      ? {
          reservationId: decision.reservation.id,
          reservationExpiresAt: decision.reservation.expiresAt.toISOString(),
        }
      : {}),
  };
}

function finalGate(result: ContactPolicyResult): string {
  return result.trace.at(-1)?.gate ?? 'IDENTITY';
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

export class ContactGovernanceService {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: ContactGovernanceServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async authorizeAndReserve(
    tenantId: string,
    input: AuthorizeAndReserveInput,
  ): Promise<AuthorizationOutcome> {
    const inputHash = hashAuthorizationInput(input);

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`action:${tenantId}:${input.actionKey}`}))`,
      );
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`contact:${tenantId}:${input.contactId}`}))`,
      );

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
      const contact = await transaction.contact.findFirst({
        where: { id: input.contactId, tenantId },
        select: { id: true },
      });
      const identity = input.identityId
        ? await transaction.contactIdentity.findFirst({
            where: { id: input.identityId, contactId: input.contactId, tenantId },
            select: { id: true },
          })
        : undefined;
      const identityResolution =
        !contact || (input.identityId && !identity) ? 'NOT_FOUND' : 'RESOLVED';

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
      let reservationId: string | undefined;
      let reservationExpiresAt: Date | undefined;

      if (policyResult.decision === 'ALLOW') {
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
          decision: policyResult.decision,
          reasonCode: policyResult.reasonCode,
          policyVersion: policyResult.policyVersion,
          gate: finalGate(policyResult),
          trace: policyResult.trace as unknown as Prisma.InputJsonValue,
          reservationId,
          decidedAt: now,
        },
        select: decisionSelection,
      });

      return toOutcome(created);
    });
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
            AND expires_at <= ${now}
          ORDER BY expires_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE cg_reservations AS reservation
        SET state = 'RELEASED',
            released_at = ${now},
            updated_at = ${now}
        FROM expired
        WHERE reservation.id = expired.id
        RETURNING reservation.id
      `);
      return released.length;
    });
  }
}
