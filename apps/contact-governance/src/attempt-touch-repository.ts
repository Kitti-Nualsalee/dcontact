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
   * vocabulary ที่เก็บจริง — กว้างกว่า write input เพราะ S2 (#365) เพิ่ม PROVIDER_ACCEPTED ใน DB
   * ก่อนที่ S2.2 จะเปิดให้ settle ผ่าน port; read path ต้องไม่ตีความแถวใหม่ผิดเป็นค่าเดิม
   */
  outcome: CgFactOutcome;
  occurredAt: string;
  correlationId: string;
  causationId?: string;
  /** S2.2: มีเฉพาะ Touch ที่มาจาก explicit response — Attempt และ Touch ของ S1 ไม่มีทั้งคู่ */
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
        // Touch ที่ correlate มาทีหลัง (มี evidence) ไม่ใช่ผลของ settle ใบนี้ จึงไม่นับเป็น
        // canonical mismatch — ไม่งั้น replay ของ settle เดิมจะกลายเป็น conflict หลัง Touch มา
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
   * S2.2 (#362 §8): append Touch 1 ให้ accepted Attempt เดิมจาก explicit response เท่านั้น
   *
   * ไม่แตะ reservation, ไม่แตะ Attempt และไม่เขียน `dl_*` ใด ๆ — correlation row เป็นของ Channels
   *
   * ความปลอดภัยของ race มาจากฝั่ง database ไม่ใช่การเช็คในโค้ด: advisory xact lock ต่อ Attempt
   * (row lock ใช้ไม่ได้เพราะ `dcontact_app` ไม่มีสิทธิ์ UPDATE บน cg_attempts ซึ่งเป็น append-only)
   * บวก unique `cg_touches (tenant_id, attempt_id)` กับ partial unique
   * `(tenant_id, response_evidence_ref)` ที่เป็นด่านสุดท้ายแม้ lock จะพลาด
   */
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
    // attemptId เป็น UUID ของ cg_attempts; ค่าที่ cast ไม่ได้คือ "ยังไม่มี Attempt" ไม่ใช่ error ของ DB
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
      // acceptance เท่านั้นที่รับ Touch ได้; DELIVERED/DELIVERY_FAILED/PROVIDER_REJECTED ไม่ใช่ (#361 §D)
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
            // Touch อยู่กับ canonical outcome ใบเดิม; identity ของ response อยู่ที่ evidence ref
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
        // evidence ref เดิมผูกกับ Attempt อื่น หรือมีผู้ชนะ race นอก lock ของแถวนี้
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
