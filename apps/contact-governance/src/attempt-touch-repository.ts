import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgFactOutcome,
  type CgTouchEvidenceKind,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  CorrelatedTouchError,
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  reservationId as toReservationId,
  type AcceptedAttemptView,
  ReservationBindingError,
  ReservationNotFoundError,
  isTouchEvidenceKind,
  type ContactChannel,
  type ContactId,
  type CorrelatedTouchView,
  type DeliveryId,
  type IdentityId,
  type NormalizedDeliveryOutcome,
  type OutcomeRef,
  type RecordCorrelatedTouchInput,
  type ReservationId,
  type TenantId,
} from '@d-contact/cxa-contracts';

export type CanonicalFactOutcome = Exclude<NormalizedDeliveryOutcome, 'UNKNOWN_RECONCILING'>;

export interface RecordAttemptTouchInput {
  tenantId: TenantId;
  reservationId: ReservationId;
  deliveryId: DeliveryId;
  outcomeRef: OutcomeRef;
  contactId: ContactId;
  identityId?: IdentityId;
  channel: ContactChannel;
  purpose: string;
  source: string;
  outcome: CanonicalFactOutcome;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  countsAsSuccessfulTouch: boolean;
}

export interface ContactFactView {
  id: string;
  tenantId: string;
  reservationId: string;
  deliveryId: string;
  outcomeRef: string;
  contactId: string;
  identityId?: string;
  channel: ContactChannel;
  purpose: string;
  source: string;
  /**
   * the vocabulary actually stored: wider than the write input because S2 (#365) added PROVIDER_ACCEPTED to the DB
   * before S2.2 opens settling through the port; the read path must not misread a new row as an old value
   */
  outcome: CgFactOutcome;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  /** S2.2: present only for a Touch that comes from an explicit response; S1 Attempts and Touches have neither */
  evidenceKind?: CgTouchEvidenceKind;
  responseEvidenceRef?: string;
  createdAt: string;
}

export interface AttemptTouchSnapshot {
  attempt: ContactFactView;
  touch?: ContactFactView;
}

export interface ContactFactQuery {
  tenantId: TenantId;
  contactId: ContactId;
  from?: string;
  to?: string;
  limit?: number;
}

export interface ContactFactHistory {
  attempts: ContactFactView[];
  touches: ContactFactView[];
}

export interface AttemptTouchRepositoryOptions {
  id?: () => string;
}

interface StoredFact {
  id: string;
  tenantId: string;
  reservationId: string;
  deliveryId: string;
  outcomeRef: string;
  contactId: string;
  identityId: string | null;
  channel: ContactChannel;
  purpose: string;
  source: string;
  outcome: CgFactOutcome;
  occurredAt: Date;
  correlationId: string;
  causationId: string | null;
  evidenceKind?: CgTouchEvidenceKind | null;
  responseEvidenceRef?: string | null;
  createdAt: Date;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} must be a non-empty string`);
}

function timestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} must be an ISO-8601 timestamp`);
  return parsed;
}

function view(fact: StoredFact): ContactFactView {
  return {
    id: fact.id,
    tenantId: fact.tenantId,
    reservationId: fact.reservationId,
    deliveryId: fact.deliveryId,
    outcomeRef: fact.outcomeRef,
    contactId: fact.contactId,
    ...(fact.identityId ? { identityId: fact.identityId } : {}),
    channel: fact.channel,
    purpose: fact.purpose,
    source: fact.source,
    outcome: fact.outcome,
    occurredAt: fact.occurredAt.toISOString(),
    correlationId: fact.correlationId,
    ...(fact.causationId ? { causationId: fact.causationId } : {}),
    ...(fact.evidenceKind ? { evidenceKind: fact.evidenceKind } : {}),
    ...(fact.responseEvidenceRef ? { responseEvidenceRef: fact.responseEvidenceRef } : {}),
    createdAt: fact.createdAt.toISOString(),
  };
}

function correlatedView(
  touch: { id: string; attemptId: string; occurredAt: Date },
  input: RecordCorrelatedTouchInput,
): CorrelatedTouchView {
  return {
    touchId: touch.id,
    attemptId: touch.attemptId,
    reservationId: input.reservationId,
    deliveryId: input.deliveryId,
    responseEvidenceRef: input.responseEvidenceRef,
    evidenceKind: input.evidenceKind,
    occurredAt: touch.occurredAt.toISOString(),
  };
}

function matchesCanonicalInput(
  attempt: StoredFact,
  hasTouch: boolean,
  input: RecordAttemptTouchInput,
  occurredAt: Date,
): boolean {
  return (
    attempt.reservationId === input.reservationId &&
    attempt.deliveryId === input.deliveryId &&
    attempt.contactId === input.contactId &&
    attempt.identityId === (input.identityId ?? null) &&
    attempt.channel === input.channel &&
    attempt.purpose === input.purpose &&
    attempt.source === input.source &&
    attempt.outcome === input.outcome &&
    attempt.occurredAt.getTime() === occurredAt.getTime() &&
    hasTouch === input.countsAsSuccessfulTouch
  );
}

function factData(input: RecordAttemptTouchInput, occurredAt: Date) {
  return {
    tenantId: input.tenantId,
    reservationId: input.reservationId,
    deliveryId: input.deliveryId,
    outcomeRef: input.outcomeRef,
    contactId: input.contactId,
    identityId: input.identityId,
    channel: input.channel,
    purpose: input.purpose,
    source: input.source,
    outcome: input.outcome,
    occurredAt,
    correlationId: input.correlationId,
    causationId: input.causationId,
  };
}

export class AttemptTouchRepository {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: AttemptTouchRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  async record(
    input: RecordAttemptTouchInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<AttemptTouchSnapshot> {
    nonEmpty(input.purpose, 'purpose');
    nonEmpty(input.source, 'source');
    nonEmpty(input.correlationId, 'correlationId');
    const occurredAt = timestamp(input.occurredAt, 'occurredAt');

    const persist = async (transactionClient: Prisma.TransactionClient) => {
      await transactionClient.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg-outcome:${input.tenantId}:${input.outcomeRef}`}))`,
      );

      const existing = await transactionClient.cgAttempt.findUnique({
        where: {
          tenantId_outcomeRef: {
            tenantId: input.tenantId,
            outcomeRef: input.outcomeRef,
          },
        },
        include: { touch: true },
      });
      if (existing) {
        // a Touch correlated later (with evidence) is not the result of this settle, so it does not count as a
        // canonical mismatch; otherwise a replay of the original settle would become a conflict after the Touch arrives
        const settlementTouch = existing.touch !== null && existing.touch.evidenceKind === null;
        if (!matchesCanonicalInput(existing, settlementTouch, input, occurredAt)) {
          throw new ReservationBindingError('IDEMPOTENCY_CONFLICT');
        }
        return {
          attempt: view(existing),
          ...(existing.touch ? { touch: view(existing.touch) } : {}),
        };
      }

      const reservation = await transactionClient.cgReservation.findFirst({
        where: {
          id: input.reservationId,
          tenantId: input.tenantId,
          contactId: input.contactId,
          channel: input.channel,
          purpose: input.purpose,
          source: input.source,
        },
        select: { id: true, identityId: true },
      });
      if (!reservation) throw new ReservationNotFoundError(input.reservationId);
      if (reservation.identityId !== (input.identityId ?? null)) {
        throw new ReservationBindingError('RESERVATION_BINDING_CONFLICT');
      }

      const attempt = await transactionClient.cgAttempt.create({
        data: { id: this.id(), ...factData(input, occurredAt) },
      });
      const touch = input.countsAsSuccessfulTouch
        ? await transactionClient.cgTouch.create({
            data: {
              id: this.id(),
              attemptId: attempt.id,
              ...factData(input, occurredAt),
            },
          })
        : undefined;

      return {
        attempt: view(attempt),
        ...(touch ? { touch: view(touch) } : {}),
      };
    };

    return transaction
      ? persist(transaction)
      : withTenantDatabaseTransaction(this.database, input.tenantId, persist);
  }

  /**
   * S2.2 (#362 §8): append Touch 1 to the original accepted Attempt from an explicit response only
   *
   * touches neither the reservation nor the Attempt and writes no `dl_*`: the correlation row belongs to Channels
   *
   * race safety comes from the database side, not a check in code: an advisory xact lock per Attempt
   * (a row lock cannot be used because `dcontact_app` has no UPDATE privilege on cg_attempts, which is append-only)
   * plus the unique `cg_touches (tenant_id, attempt_id)` and the partial unique
   * `(tenant_id, response_evidence_ref)`, which are the last line of defense even if the lock misses
   */
  /** S2.6b (#403): read-only; an Attempt other than an acceptance is not a Touch target, so it is not returned */
  async findAcceptedAttempt(input: {
    tenantId: TenantId;
    deliveryId: DeliveryId;
  }): Promise<AcceptedAttemptView | null> {
    const attempt = await withTenantDatabaseTransaction(
      this.database,
      input.tenantId,
      (transaction) =>
        transaction.cgAttempt.findFirst({
          where: {
            tenantId: input.tenantId,
            deliveryId: input.deliveryId,
            outcome: 'PROVIDER_ACCEPTED',
          },
          orderBy: { occurredAt: 'asc' },
          include: { reservation: { select: { actionKey: true } } },
        }),
    );
    if (!attempt) return null;
    return {
      attemptId: attempt.id,
      reservationId: toReservationId(attempt.reservationId),
      actionKey: toActionKey(attempt.reservation.actionKey),
      deliveryId: toDeliveryId(attempt.deliveryId),
      acceptedAt: attempt.occurredAt.toISOString(),
    };
  }

  async recordCorrelatedTouch(
    input: RecordCorrelatedTouchInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<CorrelatedTouchView> {
    nonEmpty(input.correlationId, 'correlationId');
    nonEmpty(input.responseEvidenceRef, 'responseEvidenceRef');
    if (!isTouchEvidenceKind(input.evidenceKind)) {
      throw new CorrelatedTouchError('TOUCH_EVIDENCE_KIND_UNSUPPORTED');
    }
    const occurredAt = timestamp(input.occurredAt, 'occurredAt');
    // attemptId is the UUID of cg_attempts; a value that cannot be cast means "no Attempt yet", not a DB error
    if (!UUID_PATTERN.test(input.attemptId)) throw new CorrelatedTouchError('ATTEMPT_NOT_FOUND');

    const persist = async (transactionClient: Prisma.TransactionClient) => {
      await transactionClient.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg-touch:${input.tenantId}:${input.attemptId}`}))`,
      );

      const attempt = await transactionClient.cgAttempt.findFirst({
        where: { tenantId: input.tenantId, id: input.attemptId },
        include: { touch: true, reservation: { select: { actionKey: true } } },
      });
      if (!attempt) throw new CorrelatedTouchError('ATTEMPT_NOT_FOUND');
      if (
        attempt.reservationId !== input.reservationId ||
        attempt.deliveryId !== input.deliveryId ||
        attempt.reservation.actionKey !== input.actionKey
      ) {
        throw new CorrelatedTouchError('TOUCH_BINDING_CONFLICT');
      }
      // only an acceptance can take a Touch; DELIVERED/DELIVERY_FAILED/PROVIDER_REJECTED cannot (#361 §D)
      if (attempt.outcome !== 'PROVIDER_ACCEPTED') {
        throw new CorrelatedTouchError('ATTEMPT_NOT_ACCEPTED');
      }

      if (attempt.touch) {
        const duplicate =
          attempt.touch.responseEvidenceRef === input.responseEvidenceRef &&
          attempt.touch.evidenceKind === input.evidenceKind &&
          attempt.touch.occurredAt.getTime() === occurredAt.getTime();
        if (!duplicate) throw new CorrelatedTouchError('TOUCH_EVIDENCE_CONFLICT');
        return correlatedView(attempt.touch, input);
      }

      try {
        const touch = await transactionClient.cgTouch.create({
          data: {
            id: this.id(),
            attemptId: attempt.id,
            tenantId: attempt.tenantId,
            reservationId: attempt.reservationId,
            deliveryId: attempt.deliveryId,
            // the Touch stays with the original canonical outcome; the identity of the response lives in the evidence ref
            outcomeRef: attempt.outcomeRef,
            contactId: attempt.contactId,
            identityId: attempt.identityId,
            channel: attempt.channel,
            purpose: attempt.purpose,
            source: attempt.source,
            outcome: attempt.outcome,
            occurredAt,
            correlationId: input.correlationId,
            causationId: attempt.outcomeRef,
            evidenceKind: input.evidenceKind,
            responseEvidenceRef: input.responseEvidenceRef,
          },
        });
        return correlatedView(touch, input);
      } catch (error) {
        // the original evidence ref is bound to another Attempt, or someone won a race outside this row's lock
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw new CorrelatedTouchError('TOUCH_EVIDENCE_CONFLICT');
        }
        throw error;
      }
    };

    return transaction
      ? persist(transaction)
      : withTenantDatabaseTransaction(this.database, input.tenantId, persist);
  }

  async history(
    query: ContactFactQuery,
    transaction?: Prisma.TransactionClient,
  ): Promise<ContactFactHistory> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('contact fact limit must be an integer between 1 and 500');
    }
    const from = query.from ? timestamp(query.from, 'from') : undefined;
    const to = query.to ? timestamp(query.to, 'to') : undefined;
    if (from && to && from > to) throw new RangeError('from must not be after to');

    const read = async (transactionClient: Prisma.TransactionClient) => {
      const where = {
        tenantId: query.tenantId,
        contactId: query.contactId,
        ...(from || to
          ? {
              occurredAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lte: to } : {}),
              },
            }
          : {}),
      };
      const [attempts, touches] = await Promise.all([
        transactionClient.cgAttempt.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: limit,
        }),
        transactionClient.cgTouch.findMany({
          where,
          orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
          take: limit,
        }),
      ]);
      return { attempts: attempts.map(view), touches: touches.map(view) };
    };

    return transaction
      ? read(transaction)
      : withTenantDatabaseTransaction(this.database, query.tenantId, read);
  }
}
