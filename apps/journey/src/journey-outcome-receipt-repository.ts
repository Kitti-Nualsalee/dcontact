/**
 * J2.3 — durable foundation of the canonical interaction outcome receipt
 *
 * Follows the two-layer identity confirmed in #123: transport completion unique
 * `(tenantId, source, eventId)` separate from the logical stream identity unique
 * `(tenantId, outcomeType, outcomeId, outcomeVersion)`. This is only the schema/
 * primitive — no trigger matching, owner implementation or relay transport
 * (see #131 J2.3 scope)
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrOutcomeReceipt,
  type JrOutcomeReceiptState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';

export interface IngestOutcomeReceiptInput {
  tenantId: string;
  source: string;
  eventId: string;
  outcomeType: string;
  outcomeId: string;
  outcomeVersion: number;
  payloadHash: string;
  /** J2.7: the validated `InteractionOutcomePayloadV1` — internal ID/code only */
  payload: unknown;
  correlationId: string;
  causationId?: string;
}

export type IngestOutcomeReceiptOutcome =
  'DUPLICATE' | 'READY' | 'WAITING_FOR_GAP' | 'IGNORED_SUPERSEDED' | 'QUARANTINED';

export interface IngestOutcomeReceiptResult {
  outcome: IngestOutcomeReceiptOutcome;
  receipt: JrOutcomeReceipt;
}

export class OutcomeReceiptHashConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(
    readonly identity: string,
    readonly kind: 'TRANSPORT' | 'LOGICAL',
  ) {
    super(`Outcome receipt hash conflicts with the existing one (${kind}): ${identity}`);
    this.name = 'OutcomeReceiptHashConflictError';
  }
}

function streamLockKey(tenantId: string, outcomeType: string, outcomeId: string): string {
  return `jr-outcome-stream:${tenantId}:${outcomeType}:${outcomeId}`;
}

export class JourneyOutcomeReceiptRepository {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: { id?: () => string } = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  /**
   * Decides DUPLICATE/READY/WAITING_FOR_GAP/IGNORED_SUPERSEDED/QUARANTINED by comparing
   * outcomeVersion with the current head — never applies with last-write-wins
   */
  async ingest(input: IngestOutcomeReceiptInput): Promise<IngestOutcomeReceiptResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const existingByTransport = await transaction.jrOutcomeReceipt.findUnique({
        where: {
          tenantId_source_eventId: {
            tenantId: input.tenantId,
            source: input.source,
            eventId: input.eventId,
          },
        },
      });
      if (existingByTransport) {
        if (existingByTransport.payloadHash !== input.payloadHash) {
          throw new OutcomeReceiptHashConflictError(
            `${input.source}:${input.eventId}`,
            'TRANSPORT',
          );
        }
        return { outcome: 'DUPLICATE' as const, receipt: existingByTransport };
      }

      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(input.tenantId, input.outcomeType, input.outcomeId)}))`,
      );

      const head = await transaction.jrOutcomeHead.findUnique({
        where: {
          tenantId_outcomeType_outcomeId: {
            tenantId: input.tenantId,
            outcomeType: input.outcomeType,
            outcomeId: input.outcomeId,
          },
        },
      });
      const lastAppliedVersion = head?.lastAppliedVersion ?? 0;

      const state: JrOutcomeReceiptState =
        input.outcomeVersion <= lastAppliedVersion
          ? 'IGNORED_SUPERSEDED'
          : input.outcomeVersion === lastAppliedVersion + 1
            ? 'READY'
            : 'WAITING_FOR_GAP';

      // a savepoint keeps the P2002 of this insert from aborting the whole transaction — Postgres
      // rejects every later statement until rollback if there is no separate savepoint beforehand
      await transaction.$executeRaw`SAVEPOINT ingest_insert`;
      try {
        const created = await transaction.jrOutcomeReceipt.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            source: input.source,
            eventId: input.eventId,
            outcomeType: input.outcomeType,
            outcomeId: input.outcomeId,
            outcomeVersion: input.outcomeVersion,
            payloadHash: input.payloadHash,
            payload: input.payload as Prisma.InputJsonValue,
            state,
            correlationId: input.correlationId,
            ...(input.causationId ? { causationId: input.causationId } : {}),
          },
        });
        await transaction.$executeRaw`RELEASE SAVEPOINT ingest_insert`;
        return { outcome: state as IngestOutcomeReceiptOutcome, receipt: created };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT ingest_insert`;
        // race: another worker inserted the same version first — read the real one and decide again
        const raced = await transaction.jrOutcomeReceipt.findUniqueOrThrow({
          where: {
            tenantId_outcomeType_outcomeId_outcomeVersion: {
              tenantId: input.tenantId,
              outcomeType: input.outcomeType,
              outcomeId: input.outcomeId,
              outcomeVersion: input.outcomeVersion,
            },
          },
        });
        if (raced.payloadHash !== input.payloadHash) {
          const quarantined = await transaction.jrOutcomeReceipt.update({
            where: { id: raced.id },
            data: { state: 'QUARANTINED', reviewReasonCode: 'EVENT_HASH_CONFLICT' },
          });
          return { outcome: 'QUARANTINED' as const, receipt: quarantined };
        }
        return { outcome: 'DUPLICATE' as const, receipt: raced };
      }
    });
  }

  /**
   * Claims one receipt ready for processing with a lease/CAS; includes PROCESSING whose lease
   * has expired, returning it to the queue for another worker to claim without applying twice
   */
  async claimNextReady(
    tenantId: string,
    workerId: string,
    leaseSeconds = 30,
  ): Promise<JrOutcomeReceipt | undefined> {
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM jr_outcome_receipts
        WHERE tenant_id = ${tenantId}::uuid
          AND (
            (state = 'READY' AND available_at <= ${now})
            OR (state = 'PROCESSING' AND lease_expires_at <= ${now})
          )
        ORDER BY available_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      return transaction.jrOutcomeReceipt.update({
        where: { id: candidate.id },
        data: { state: 'PROCESSING', leaseOwner: workerId, leaseExpiresAt },
      });
    });
  }

  /**
   * applied successfully — takes the stream's existing advisory lock before moving the head so that
   * markApplied from different workers cannot race to move the head together; moves only if
   * this version is still greater than the current head (CAS by read-then-write under one lock)
   */
  async markApplied(
    tenantId: string,
    receiptId: string,
    transaction?: Prisma.TransactionClient,
  ): Promise<JrOutcomeReceipt> {
    const run = async (transaction: Prisma.TransactionClient) => {
      const receipt = await transaction.jrOutcomeReceipt.update({
        where: { id: receiptId },
        data: { state: 'APPLIED', appliedAt: new Date() },
      });
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(tenantId, receipt.outcomeType, receipt.outcomeId)}))`,
      );
      const headKey = {
        tenantId_outcomeType_outcomeId: {
          tenantId,
          outcomeType: receipt.outcomeType,
          outcomeId: receipt.outcomeId,
        },
      };
      const head = await transaction.jrOutcomeHead.findUnique({
        where: headKey,
        select: { lastAppliedVersion: true },
      });
      const advancedVersion = !head || head.lastAppliedVersion < receipt.outcomeVersion;
      if (!head) {
        await transaction.jrOutcomeHead.create({
          data: {
            tenantId,
            outcomeType: receipt.outcomeType,
            outcomeId: receipt.outcomeId,
            lastAppliedVersion: receipt.outcomeVersion,
            lastAppliedReceiptId: receipt.id,
          },
        });
      } else if (advancedVersion) {
        await transaction.jrOutcomeHead.update({
          where: headKey,
          data: { lastAppliedVersion: receipt.outcomeVersion, lastAppliedReceiptId: receipt.id },
        });
      }

      // the head moved: an existing WAITING_FOR_GAP of this stream may be ready to apply (the gap
      // was filled) or may have become stale and need no apply — otherwise it would be stuck forever
      if (advancedVersion) {
        const lastAppliedVersion = receipt.outcomeVersion;
        const waiting = await transaction.jrOutcomeReceipt.findMany({
          where: {
            tenantId,
            outcomeType: receipt.outcomeType,
            outcomeId: receipt.outcomeId,
            state: 'WAITING_FOR_GAP',
          },
        });
        for (const pending of waiting) {
          if (pending.outcomeVersion <= lastAppliedVersion) {
            await transaction.jrOutcomeReceipt.update({
              where: { id: pending.id },
              data: { state: 'IGNORED_SUPERSEDED' },
            });
          } else if (pending.outcomeVersion === lastAppliedVersion + 1) {
            await transaction.jrOutcomeReceipt.update({
              where: { id: pending.id },
              data: { state: 'READY' },
            });
          }
        }
      }
      return receipt;
    };
    return transaction
      ? run(transaction)
      : withTenantDatabaseTransaction(this.database, tenantId, run);
  }

  async markReview(
    tenantId: string,
    receiptId: string,
    reasonCode: string,
  ): Promise<JrOutcomeReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.update({
        where: { id: receiptId },
        data: { state: 'REVIEW', reviewReasonCode: reasonCode },
      }),
    );
  }

  async markQuarantined(
    tenantId: string,
    receiptId: string,
    reasonCode: string,
  ): Promise<JrOutcomeReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.update({
        where: { id: receiptId },
        data: { state: 'QUARANTINED', reviewReasonCode: reasonCode },
      }),
    );
  }

  /** a retryable failure returns to READY with bounded backoff — not persisted as a separate state */
  async markRetryableFailure(
    tenantId: string,
    receiptId: string,
    backoffMs: number,
    errorMessage: string,
  ): Promise<JrOutcomeReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.update({
        where: { id: receiptId },
        data: {
          state: 'READY',
          attempts: { increment: 1 },
          availableAt: new Date(Date.now() + backoffMs),
          lastError: errorMessage.slice(0, 1_000),
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  /** WAITING_FOR_GAP stuck past the timeout — the caller decides to reconcile/escalate */
  findStaleGaps(tenantId: string, olderThan: Date): Promise<JrOutcomeReceipt[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.findMany({
        where: { tenantId, state: 'WAITING_FOR_GAP', receivedAt: { lte: olderThan } },
        orderBy: { receivedAt: 'asc' },
      }),
    );
  }

  findByOutcome(
    tenantId: string,
    outcomeType: string,
    outcomeId: string,
  ): Promise<JrOutcomeReceipt[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrOutcomeReceipt.findMany({
        where: { tenantId, outcomeType, outcomeId },
        orderBy: { outcomeVersion: 'asc' },
      }),
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
