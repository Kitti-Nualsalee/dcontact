import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgDeliverySettlementStatus,
  type CgFactOutcome,
  type CgReservationCommandOperation,
  type CgReservationState,
  type ChannelType,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  actionKey,
  deliveryId,
  reservationId,
  ReservationBindingError,
  type BeginProviderSubmissionInput,
  type ClaimReservationForDeliveryInput,
  type ConfirmProviderAcceptanceInput,
  type ReleaseBeforeSubmitInput,
  type ReservationDeliveryCommand,
  type ReservationSettlementView,
  type RenewReservationLeaseInput,
  type SettleDeliveryInput,
} from '@d-contact/cxa-contracts';
import {
  AttemptTouchRepository,
  type RecordAttemptTouchInput,
} from './attempt-touch-repository.js';

const reservationRuntimeSelection = {
  id: true,
  tenantId: true,
  contactId: true,
  identityId: true,
  channel: true,
  purpose: true,
  source: true,
  actionKey: true,
  state: true,
  expiresAt: true,
  confirmedAt: true,
  releasedAt: true,
  refundedAt: true,
  deliveryId: true,
  senderIdentityId: true,
  providerRequestKey: true,
  leaseVersion: true,
  leaseExpiresAt: true,
  submissionStartedAt: true,
  settlementStatus: true,
  terminalOutcome: true,
  terminalOutcomeRef: true,
  settledAt: true,
  authorizationAggregateVersion: true,
} as const;

type ReservationRuntimeRow = {
  id: string;
  tenantId: string;
  contactId: string;
  identityId: string | null;
  channel: ChannelType;
  purpose: string;
  source: string;
  actionKey: string;
  state: CgReservationState;
  expiresAt: Date;
  confirmedAt: Date | null;
  releasedAt: Date | null;
  refundedAt: Date | null;
  deliveryId: string | null;
  senderIdentityId: string | null;
  providerRequestKey: string | null;
  leaseVersion: number | null;
  leaseExpiresAt: Date | null;
  submissionStartedAt: Date | null;
  settlementStatus: CgDeliverySettlementStatus | null;
  terminalOutcome: CgFactOutcome | null;
  terminalOutcomeRef: string | null;
  settledAt: Date | null;
  authorizationAggregateVersion: number | null;
};

export interface SettlementPolicyDecision {
  countsAsSuccessfulTouch: boolean;
  refundOnFailure: boolean;
}

export type SettlementPolicy = (
  input: SettleDeliveryInput,
  reservation: Readonly<ReservationRuntimeRow>,
) => SettlementPolicyDecision;

export interface ReservationRuntimeOptions {
  now?: () => Date;
  id?: () => string;
  settlementPolicy?: SettlementPolicy;
}

function defaultSettlementPolicy(input: SettleDeliveryInput): SettlementPolicyDecision {
  return {
    countsAsSuccessfulTouch: input.outcome === 'DELIVERED',
    refundOnFailure: input.outcome === 'DELIVERY_FAILED',
  };
}

function status(row: ReservationRuntimeRow): CgDeliverySettlementStatus {
  return row.settlementStatus ?? 'UNCLAIMED';
}

function view(row: ReservationRuntimeRow): ReservationSettlementView {
  return {
    reservationId: reservationId(row.id),
    actionKey: actionKey(row.actionKey),
    ...(row.deliveryId ? { deliveryId: deliveryId(row.deliveryId) } : {}),
    state: row.state,
    status: status(row),
    ...(row.leaseVersion ? { leaseVersion: row.leaseVersion } : {}),
    ...(row.leaseExpiresAt ? { leaseExpiresAt: row.leaseExpiresAt.toISOString() } : {}),
  };
}

function responseFromJson(value: Prisma.JsonValue): ReservationSettlementView {
  const response = value as unknown as ReservationSettlementView;
  return {
    reservationId: reservationId(response.reservationId),
    actionKey: actionKey(response.actionKey),
    ...(response.deliveryId ? { deliveryId: deliveryId(response.deliveryId) } : {}),
    state: response.state,
    status: response.status,
    ...(response.leaseVersion ? { leaseVersion: response.leaseVersion } : {}),
    ...(response.leaseExpiresAt ? { leaseExpiresAt: response.leaseExpiresAt } : {}),
  };
}

function canonicalHash(input: object): string {
  const canonical = Object.fromEntries(
    Object.entries(input)
      .filter(([key, value]) => key !== 'correlationId' && value !== undefined)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function parseTimestamp(value: string, field: string): Date {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new TypeError(`${field} ต้องเป็น ISO-8601 timestamp`);
  return result;
}

function fail(code: ConstructorParameters<typeof ReservationBindingError>[0]): never {
  throw new ReservationBindingError(code);
}

function assertActionBinding(row: ReservationRuntimeRow, input: ReservationDeliveryCommand): void {
  if (row.actionKey !== input.actionKey) fail('RESERVATION_BINDING_CONFLICT');
}

function assertDeliveryBinding(
  row: ReservationRuntimeRow,
  input: ReservationDeliveryCommand & { deliveryId: string },
): void {
  assertActionBinding(row, input);
  if (!row.deliveryId || row.deliveryId !== input.deliveryId) {
    fail('RESERVATION_BINDING_CONFLICT');
  }
}

function assertProviderBinding(
  row: ReservationRuntimeRow,
  input: ReservationDeliveryCommand & { deliveryId: string; providerRequestKey: string },
): void {
  assertDeliveryBinding(row, input);
  if (!row.submissionStartedAt || !row.providerRequestKey) {
    fail('INVALID_RESERVATION_TRANSITION');
  }
  if (row.providerRequestKey !== input.providerRequestKey) fail('RESERVATION_BINDING_CONFLICT');
}

type CommandHandler = (
  transaction: Prisma.TransactionClient,
  reservation: ReservationRuntimeRow,
) => Promise<ReservationSettlementView>;

export class ReservationRuntime {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly facts: AttemptTouchRepository;
  private readonly settlementPolicy: SettlementPolicy;

  constructor(
    private readonly database: PrismaClient,
    options: ReservationRuntimeOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.facts = new AttemptTouchRepository(database, { id: this.id });
    this.settlementPolicy = options.settlementPolicy ?? defaultSettlementPolicy;
  }

  private async command(
    operation: CgReservationCommandOperation,
    idempotencyKey: string,
    input: ReservationDeliveryCommand,
    locks: string[],
    handler: CommandHandler,
  ): Promise<ReservationSettlementView> {
    const inputHash = canonicalHash(input);
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      for (const lock of [`reservation:${input.tenantId}:${input.reservationId}`, ...locks]) {
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${lock}))`,
        );
      }

      const receipt = await transaction.cgReservationCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId: input.tenantId,
            operation,
            idempotencyKey,
          },
        },
        select: { reservationId: true, inputHash: true, response: true },
      });
      if (receipt) {
        if (receipt.reservationId !== input.reservationId || receipt.inputHash !== inputHash) {
          fail('IDEMPOTENCY_CONFLICT');
        }
        return responseFromJson(receipt.response);
      }

      const reservation = await transaction.cgReservation.findFirst({
        where: { id: input.reservationId, tenantId: input.tenantId },
        select: reservationRuntimeSelection,
      });
      if (!reservation) fail('RESERVATION_NOT_FOUND');
      assertActionBinding(reservation, input);

      const response = await handler(transaction, reservation);
      await transaction.cgReservationCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          reservationId: input.reservationId,
          operation,
          idempotencyKey,
          inputHash,
          response: response as unknown as Prisma.InputJsonValue,
        },
      });
      return response;
    });
  }

  claim(input: ClaimReservationForDeliveryInput): Promise<ReservationSettlementView> {
    const leaseExpiresAt = parseTimestamp(input.leaseExpiresAt, 'leaseExpiresAt');
    return this.command(
      'CLAIM',
      input.reservationId,
      input,
      [`delivery:${input.tenantId}:${input.deliveryId}`],
      async (transaction, reservation) => {
        const now = this.now();
        if (reservation.state !== 'RESERVED' || status(reservation) !== 'UNCLAIMED') {
          fail('RESERVATION_NOT_RESERVED');
        }
        if (reservation.expiresAt <= now) fail('RESERVATION_EXPIRED');
        if (
          reservation.contactId !== input.contactId ||
          reservation.identityId !== (input.identityId ?? null) ||
          reservation.channel !== input.channel ||
          reservation.purpose !== input.purpose ||
          reservation.senderIdentityId ||
          reservation.deliveryId
        ) {
          fail('RESERVATION_BINDING_CONFLICT');
        }
        if (leaseExpiresAt <= now || leaseExpiresAt > reservation.expiresAt) {
          fail('INVALID_RESERVATION_LEASE');
        }
        const competingDelivery = await transaction.cgReservation.findFirst({
          where: {
            tenantId: input.tenantId,
            deliveryId: input.deliveryId,
            NOT: { id: reservation.id },
          },
          select: { id: true },
        });
        if (competingDelivery) fail('RESERVATION_BINDING_CONFLICT');

        const updated = await transaction.cgReservation.update({
          where: { id: reservation.id },
          data: {
            deliveryId: input.deliveryId,
            senderIdentityId: input.senderIdentityId,
            leaseVersion: 1,
            leaseExpiresAt,
            settlementStatus: 'CLAIMED',
          },
          select: reservationRuntimeSelection,
        });
        return view(updated);
      },
    );
  }

  renew(input: RenewReservationLeaseInput): Promise<ReservationSettlementView> {
    const leaseExpiresAt = parseTimestamp(input.leaseExpiresAt, 'leaseExpiresAt');
    return this.command(
      'RENEW',
      `${input.reservationId}:${input.expectedLeaseVersion}`,
      input,
      [],
      async (transaction, reservation) => {
        assertDeliveryBinding(reservation, input);
        const now = this.now();
        if (reservation.state !== 'RESERVED' || status(reservation) === 'SETTLED') {
          fail('INVALID_RESERVATION_TRANSITION');
        }
        if (reservation.submissionStartedAt || reservation.providerRequestKey) {
          fail('DELIVERY_RECONCILIATION_REQUIRED');
        }
        if (status(reservation) !== 'CLAIMED') fail('INVALID_RESERVATION_TRANSITION');
        if (
          reservation.leaseVersion !== input.expectedLeaseVersion ||
          !reservation.leaseExpiresAt
        ) {
          fail('STALE_RESERVATION_LEASE');
        }
        if (reservation.leaseExpiresAt <= now || reservation.expiresAt <= now) {
          fail('RESERVATION_EXPIRED');
        }
        if (
          leaseExpiresAt <= reservation.leaseExpiresAt ||
          leaseExpiresAt > reservation.expiresAt
        ) {
          fail('INVALID_RESERVATION_LEASE');
        }

        const updated = await transaction.cgReservation.update({
          where: { id: reservation.id },
          data: {
            leaseVersion: input.expectedLeaseVersion + 1,
            leaseExpiresAt,
          },
          select: reservationRuntimeSelection,
        });
        return view(updated);
      },
    );
  }

  beginSubmission(input: BeginProviderSubmissionInput): Promise<ReservationSettlementView> {
    return this.command(
      'BEGIN_SUBMISSION',
      input.reservationId,
      input,
      [`provider-request:${input.tenantId}:${input.providerRequestKey}`],
      async (transaction, reservation) => {
        assertDeliveryBinding(reservation, input);
        const now = this.now();
        if (reservation.state !== 'RESERVED' || status(reservation) !== 'CLAIMED') {
          fail('INVALID_RESERVATION_TRANSITION');
        }
        if (
          reservation.leaseVersion !== input.expectedLeaseVersion ||
          !reservation.leaseExpiresAt
        ) {
          fail('STALE_RESERVATION_LEASE');
        }
        if (reservation.leaseExpiresAt <= now || reservation.expiresAt <= now) {
          fail('RESERVATION_EXPIRED');
        }
        if (reservation.submissionStartedAt || reservation.providerRequestKey) {
          fail('DELIVERY_RECONCILIATION_REQUIRED');
        }
        // revalidate CG3 authorization ก่อนข้าม submission barrier (#98 §3: GOVERNANCE_VERSION_STALE)
        if (reservation.authorizationAggregateVersion !== null) {
          const head = await transaction.cgContactStateHead.findUnique({
            where: {
              tenantId_contactId: { tenantId: input.tenantId, contactId: reservation.contactId },
            },
            select: { aggregateVersion: true },
          });
          const currentAggregateVersion = head?.aggregateVersion ?? 0;
          if (currentAggregateVersion !== reservation.authorizationAggregateVersion) {
            fail('GOVERNANCE_VERSION_STALE');
          }
        }
        const competingRequest = await transaction.cgReservation.findFirst({
          where: {
            tenantId: input.tenantId,
            providerRequestKey: input.providerRequestKey,
            NOT: { id: reservation.id },
          },
          select: { id: true },
        });
        if (competingRequest) fail('RESERVATION_BINDING_CONFLICT');

        const updated = await transaction.cgReservation.update({
          where: { id: reservation.id },
          data: {
            providerRequestKey: input.providerRequestKey,
            submissionStartedAt: now,
            settlementStatus: 'UNKNOWN_RECONCILING',
          },
          select: reservationRuntimeSelection,
        });
        return view(updated);
      },
    );
  }

  confirm(input: ConfirmProviderAcceptanceInput): Promise<ReservationSettlementView> {
    return this.command(
      'CONFIRM',
      input.reservationId,
      input,
      [],
      async (transaction, reservation) => {
        assertProviderBinding(reservation, input);
        if (reservation.terminalOutcome || status(reservation) === 'SETTLED') {
          fail('INVALID_RESERVATION_TRANSITION');
        }
        if (reservation.state !== 'RESERVED') fail('INVALID_RESERVATION_TRANSITION');

        const now = this.now();
        const updated = await transaction.cgReservation.update({
          where: { id: reservation.id },
          data: {
            state: 'CONFIRMED',
            settlementStatus: 'ACCEPTED',
            confirmedAt: now,
          },
          select: reservationRuntimeSelection,
        });
        return view(updated);
      },
    );
  }

  release(input: ReleaseBeforeSubmitInput): Promise<ReservationSettlementView> {
    return this.command(
      'RELEASE',
      input.reservationId,
      input,
      [],
      async (transaction, reservation) => {
        if (reservation.deliveryId) {
          if (!input.deliveryId || reservation.deliveryId !== input.deliveryId) {
            fail('RESERVATION_BINDING_CONFLICT');
          }
        } else if (input.deliveryId) {
          fail('RESERVATION_BINDING_CONFLICT');
        }
        if (reservation.state !== 'RESERVED' || status(reservation) === 'SETTLED') {
          fail('INVALID_RESERVATION_TRANSITION');
        }
        if (reservation.submissionStartedAt || reservation.providerRequestKey) {
          fail('DELIVERY_RECONCILIATION_REQUIRED');
        }

        const now = this.now();
        const expiry = reservation.leaseExpiresAt ?? reservation.expiresAt;
        if (input.reason === 'LEASE_EXPIRED' && expiry > now) {
          fail('INVALID_RESERVATION_LEASE');
        }
        const updated = await transaction.cgReservation.update({
          where: { id: reservation.id },
          data: {
            state: 'RELEASED',
            settlementStatus: 'SETTLED',
            releasedAt: now,
            settledAt: now,
          },
          select: reservationRuntimeSelection,
        });
        return view(updated);
      },
    );
  }

  settle(input: SettleDeliveryInput): Promise<ReservationSettlementView> {
    parseTimestamp(input.occurredAt, 'occurredAt');
    return this.command(
      'SETTLE',
      input.outcomeRef,
      input,
      [`cg-outcome:${input.tenantId}:${input.outcomeRef}`],
      async (transaction, reservation) => {
        assertProviderBinding(reservation, input);
        if (reservation.terminalOutcome || status(reservation) === 'SETTLED') {
          return view(reservation);
        }

        if (input.outcome === 'UNKNOWN_RECONCILING') {
          if (status(reservation) === 'ACCEPTED') return view(reservation);
          const reconciling = await transaction.cgReservation.update({
            where: { id: reservation.id },
            data: { settlementStatus: 'UNKNOWN_RECONCILING' },
            select: reservationRuntimeSelection,
          });
          return view(reconciling);
        }

        const now = this.now();
        const policy = this.settlementPolicy(input, reservation);
        let nextState: CgReservationState;
        if (input.outcome === 'PROVIDER_REJECTED') {
          if (reservation.state === 'CONFIRMED') fail('INVALID_RESERVATION_TRANSITION');
          nextState = 'RELEASED';
        } else if (input.outcome === 'DELIVERY_FAILED') {
          if (reservation.state !== 'CONFIRMED') fail('DELIVERY_RECONCILIATION_REQUIRED');
          nextState = policy.refundOnFailure ? 'REFUNDED' : 'CONFIRMED';
        } else {
          nextState = 'CONFIRMED';
        }

        const updated = await transaction.cgReservation.update({
          where: { id: reservation.id },
          data: {
            state: nextState,
            settlementStatus: 'SETTLED',
            terminalOutcome: input.outcome,
            terminalOutcomeRef: input.outcomeRef,
            settledAt: now,
            ...(nextState === 'CONFIRMED' && !reservation.confirmedAt ? { confirmedAt: now } : {}),
            ...(nextState === 'RELEASED' ? { releasedAt: now } : {}),
            ...(nextState === 'REFUNDED' ? { refundedAt: now } : {}),
          },
          select: reservationRuntimeSelection,
        });

        await this.facts.record(
          {
            tenantId: input.tenantId,
            reservationId: input.reservationId,
            deliveryId: input.deliveryId,
            outcomeRef: input.outcomeRef,
            contactId: reservation.contactId as RecordAttemptTouchInput['contactId'],
            ...(reservation.identityId
              ? { identityId: reservation.identityId as RecordAttemptTouchInput['identityId'] }
              : {}),
            channel: reservation.channel,
            purpose: reservation.purpose,
            source: reservation.source,
            outcome: input.outcome,
            occurredAt: input.occurredAt,
            correlationId: input.correlationId,
            countsAsSuccessfulTouch: policy.countsAsSuccessfulTouch,
          },
          transaction,
        );
        return view(updated);
      },
    );
  }
}
