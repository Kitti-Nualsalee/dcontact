import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgFactOutcome,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  ReservationBindingError,
  ReservationNotFoundError,
  type ContactChannel,
  type ContactId,
  type DeliveryId,
  type IdentityId,
  type NormalizedDeliveryOutcome,
  type OutcomeRef,
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
  outcome: CanonicalFactOutcome;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
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
  createdAt: Date;
}

function nonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) throw new TypeError(`${field} ต้องเป็น string ที่ไม่ว่าง`);
}

function timestamp(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} ต้องเป็น ISO-8601 timestamp`);
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
    createdAt: fact.createdAt.toISOString(),
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
        if (!matchesCanonicalInput(existing, Boolean(existing.touch), input, occurredAt)) {
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

  async history(
    query: ContactFactQuery,
    transaction?: Prisma.TransactionClient,
  ): Promise<ContactFactHistory> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('contact fact limit ต้องเป็น integer ระหว่าง 1 ถึง 500');
    }
    const from = query.from ? timestamp(query.from, 'from') : undefined;
    const to = query.to ? timestamp(query.to, 'to') : undefined;
    if (from && to && from > to) throw new RangeError('from ต้องไม่อยู่หลัง to');

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
