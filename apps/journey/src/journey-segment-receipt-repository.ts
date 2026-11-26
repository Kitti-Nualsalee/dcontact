/**
 * J3.6 (#217) — durable ingest/apply of the canonical `customer.segment.changed`
 *
 * Follows the same two-layer identity as J2.3: transport `(tenantId, source, eventId)` separate from logical
 * `(tenantId, contactId, segmentId, membershipRevision)` — the broker sending the same event again collides on the first,
 * while the same revision arriving as a different event collides on the second; neither may create a second receipt
 *
 * This does not decide permissions and does not read Customer 360 itself — the caller (the trigger processor) calls
 * `CustomerSegmentMembershipReader.resolveEntry` and `TeamContactScopeAuthorizer` and passes in the results
 * it gets. This repository is responsible only for writing atomically and keeping the stream's invariants
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrSegmentReceipt,
  type JrSegmentReceiptState,
  type JrSegmentRefilterCursor,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';

export interface IngestSegmentReceiptInput {
  tenantId: string;
  source: string;
  eventId: string;
  contactId: string;
  segmentId: string;
  membershipRevision: number;
  changeKind: string;
  entryId?: string;
  supersedesRevision?: number;
  segmentDefinitionVersion: number;
  payloadHash: string;
  evidenceRef?: string;
  correlationId: string;
  causationId?: string;
}

export type IngestSegmentReceiptOutcome =
  'DUPLICATE' | 'READY' | 'WAITING_FOR_GAP' | 'IGNORED_SUPERSEDED' | 'QUARANTINED';

export interface IngestSegmentReceiptResult {
  outcome: IngestSegmentReceiptOutcome;
  receipt: JrSegmentReceipt;
}

export class SegmentReceiptHashConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(
    readonly identity: string,
    readonly kind: 'TRANSPORT' | 'LOGICAL',
  ) {
    super(`Segment receipt hash conflicts with the existing one (${kind}): ${identity}`);
    this.name = 'SegmentReceiptHashConflictError';
  }
}

/**
 * an entry that has ended must not be revived into a new enrollment
 *
 * if let through, sending a backdated event or a replay would enroll the contact into the journey again
 * for a reason that has expired — a new entry into the segment must come with a new entryId only
 */
export class SegmentEntryTerminalError extends Error {
  readonly code = 'INVALID_MEMBERSHIP_TRANSITION' as const;

  constructor(readonly entryId: string) {
    super(
      `entry ${entryId} was already closed; cannot create a new enrollment from the existing entry`,
    );
    this.name = 'SegmentEntryTerminalError';
  }
}

/** one enrollment intent per (journey, version) — the reason can hold only a ref/version/digest */
export interface SegmentEnrollmentIntentInput {
  journeyId: string;
  journeyVersion: number;
  /** entry step of the published graph — the enrollment starts running from here */
  entryStepId: string;
  reasonMembershipRevision: number;
  reasonDefinitionVersion: number;
  reasonEvidenceRef?: string;
  reasonDigest: string;
}

export interface ApplySegmentEnrollmentInput {
  tenantId: string;
  receiptId: string;
  /** the entryId that resolveEntry confirmed as ELIGIBLE — not a value the caller sent itself */
  entryId: string;
  /** the survivor Customer 360 decided; differs from the contactId on the receipt when there was a merge */
  canonicalContactId: string;
  intents: readonly SegmentEnrollmentIntentInput[];
  correlationId: string;
  causationId?: string;
}

export interface ApplySegmentRefilterInput {
  tenantId: string;
  receiptId: string;
  reasonCode: string;
  /** closes this entry permanently (LEFT/invalidation) — only the first time takes effect */
  terminalEntryId?: string;
  correlationId: string;
}

export interface SegmentOutboxEventInput {
  eventType: string;
  orderingKey: string;
  payload: Record<string, unknown>;
  payloadHash: string;
}

/** a cursor already claimed together with its source receipt — read in the same transaction so it does not escape the RLS context */
export type ClaimedRefilterCursor = JrSegmentRefilterCursor & {
  receipt: { entryId: string | null; changeKind: string };
};

function streamLockKey(tenantId: string, contactId: string, segmentId: string): string {
  return `jr-segment-stream:${tenantId}:${contactId}:${segmentId}`;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class JourneySegmentReceiptRepository {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    options: { id?: () => string; now?: () => Date } = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * decides DUPLICATE/READY/WAITING_FOR_GAP/IGNORED_SUPERSEDED/QUARANTINED from
   * membershipRevision compared with the head — never applies as last-write-wins
   */
  async ingest(input: IngestSegmentReceiptInput): Promise<IngestSegmentReceiptResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const existingByTransport = await transaction.jrSegmentReceipt.findUnique({
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
          throw new SegmentReceiptHashConflictError(
            `${input.source}:${input.eventId}`,
            'TRANSPORT',
          );
        }
        return { outcome: 'DUPLICATE' as const, receipt: existingByTransport };
      }

      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(input.tenantId, input.contactId, input.segmentId)}))`,
      );

      const head = await transaction.jrSegmentHead.findUnique({
        where: {
          tenantId_contactId_segmentId: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            segmentId: input.segmentId,
          },
        },
      });
      const lastAppliedRevision = head?.lastAppliedRevision ?? 0;

      const state: JrSegmentReceiptState =
        input.membershipRevision <= lastAppliedRevision
          ? 'IGNORED_SUPERSEDED'
          : input.membershipRevision === lastAppliedRevision + 1
            ? 'READY'
            : 'WAITING_FOR_GAP';

      // a savepoint keeps the P2002 of this insert from aborting the whole transaction — Postgres rejects
      // every later statement until rollback if there is no separate savepoint beforehand
      await transaction.$executeRaw`SAVEPOINT segment_ingest`;
      try {
        const created = await transaction.jrSegmentReceipt.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            source: input.source,
            eventId: input.eventId,
            contactId: input.contactId,
            segmentId: input.segmentId,
            membershipRevision: input.membershipRevision,
            changeKind: input.changeKind,
            segmentDefinitionVersion: input.segmentDefinitionVersion,
            payloadHash: input.payloadHash,
            state,
            correlationId: input.correlationId,
            ...(input.entryId ? { entryId: input.entryId } : {}),
            ...(input.supersedesRevision !== undefined
              ? { supersedesRevision: input.supersedesRevision }
              : {}),
            ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
            ...(input.causationId ? { causationId: input.causationId } : {}),
          },
        });
        await transaction.$executeRaw`RELEASE SAVEPOINT segment_ingest`;
        return { outcome: state as IngestSegmentReceiptOutcome, receipt: created };
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT segment_ingest`;
        // race: another worker inserted the same revision first — read the real one and decide again
        const raced = await transaction.jrSegmentReceipt.findUniqueOrThrow({
          where: {
            tenantId_contactId_segmentId_membershipRevision: {
              tenantId: input.tenantId,
              contactId: input.contactId,
              segmentId: input.segmentId,
              membershipRevision: input.membershipRevision,
            },
          },
        });
        if (raced.payloadHash !== input.payloadHash) {
          const quarantined = await transaction.jrSegmentReceipt.update({
            where: { id: raced.id },
            data: {
              state: 'QUARANTINED',
              reviewReasonCode: 'EVENT_HASH_CONFLICT',
              version: { increment: 1 },
            },
          });
          return { outcome: 'QUARANTINED' as const, receipt: quarantined };
        }
        return { outcome: 'DUPLICATE' as const, receipt: raced };
      }
    });
  }

  /**
   * claims one receipt ready for processing with a lease/CAS
   *
   * includes PROCESSING whose lease expired, returning it to the queue — a worker that died midway must not leave a receipt
   * stuck forever, and because the whole apply is one transaction, claiming again does not apply twice
   */
  async claimNextReady(
    tenantId: string,
    workerId: string,
    leaseSeconds = 30,
  ): Promise<JrSegmentReceipt | undefined> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM jr_segment_receipts
        WHERE tenant_id = ${tenantId}::uuid
          AND (
            (state = 'READY' AND available_at <= ${now})
            OR (state = 'PROCESSING' AND lease_expires_at <= ${now})
          )
        ORDER BY available_at, membership_revision
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      return transaction.jrSegmentReceipt.update({
        where: { id: candidate.id },
        data: {
          state: 'PROCESSING',
          leaseOwner: workerId,
          leaseExpiresAt,
          version: { increment: 1 },
        },
      });
    });
  }

  /**
   * commits receipt + head + enrollment intent + outbox in a single transaction
   *
   * all four must always go together: an intent with no receipt is an enrollment with no reason,
   * and an outbox with no intent announces something that never happened
   */
  async applyEnrollment(
    input: ApplySegmentEnrollmentInput,
    event: SegmentOutboxEventInput,
  ): Promise<JrSegmentReceipt> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const receipt = await transaction.jrSegmentReceipt.findUniqueOrThrow({
        where: { id: input.receiptId },
      });
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(input.tenantId, receipt.contactId, receipt.segmentId)}))`,
      );

      const head = await this.advanceHead(transaction, receipt);
      if (head.terminalEntryId === input.entryId) {
        throw new SegmentEntryTerminalError(input.entryId);
      }

      for (const intent of input.intents) {
        // unique (tenant, journey, version, contact, segment, entry) makes one entry get
        // at most one enrollment per journey version even when several consumers fire at once
        await transaction.$executeRaw`SAVEPOINT segment_intent`;
        try {
          const intentId = this.id();
          await transaction.jrSegmentEnrollmentIntent.create({
            data: {
              id: intentId,
              tenantId: input.tenantId,
              journeyId: intent.journeyId,
              journeyVersion: intent.journeyVersion,
              contactId: input.canonicalContactId,
              segmentId: receipt.segmentId,
              entryId: input.entryId,
              receiptId: receipt.id,
              reasonMembershipRevision: intent.reasonMembershipRevision,
              reasonDefinitionVersion: intent.reasonDefinitionVersion,
              reasonDigest: intent.reasonDigest,
              correlationId: input.correlationId,
              ...(intent.reasonEvidenceRef ? { reasonEvidenceRef: intent.reasonEvidenceRef } : {}),
            },
          });
          /**
           * the real enrollment must happen in the same transaction as the intent
           *
           * the intent is the "reason" and the enrollment is the "work" — if written separately there would be a window with a reason
           * but no work (or the reverse), and cancelling during re-filter would not find the action to cancel
           */
          await transaction.jrEnrollment.create({
            data: {
              id: this.id(),
              tenantId: input.tenantId,
              segmentIntentId: intentId,
              journeyId: intent.journeyId,
              journeyVersion: intent.journeyVersion,
              contactId: input.canonicalContactId,
              currentStepId: intent.entryStepId,
              state: 'PENDING',
              runState: 'WAITING',
              correlationId: input.correlationId,
            },
          });
          await transaction.$executeRaw`RELEASE SAVEPOINT segment_intent`;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
          // an existing intent = a legitimate replay, not an error
          await transaction.$executeRaw`ROLLBACK TO SAVEPOINT segment_intent`;
        }
      }

      await this.enqueue(transaction, receipt, event, input.correlationId, input.causationId);
      return this.markApplied(transaction, receipt.id);
    });
  }

  /**
   * commits receipt + head + re-filter cursor + outbox in a single transaction
   *
   * used for changes that bring no new enrollment (LEFT, correction, invalidation) — the real work
   * of re-evaluation belongs to J3.7; this only records that something is waiting to be evaluated
   */
  async applyRefilter(
    input: ApplySegmentRefilterInput,
    event: SegmentOutboxEventInput,
  ): Promise<JrSegmentReceipt> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const receipt = await transaction.jrSegmentReceipt.findUniqueOrThrow({
        where: { id: input.receiptId },
      });
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(input.tenantId, receipt.contactId, receipt.segmentId)}))`,
      );

      const head = await this.advanceHead(transaction, receipt);

      /**
       * first-terminal protection: an entry can be closed only once
       *
       * if overwriting were allowed, the reason and revision that closed the entry would change with the latest event that
       * happened to arrive, leaving the audit unable to answer what actually closed that entry
       */
      if (input.terminalEntryId && head.terminalEntryId === null) {
        await transaction.jrSegmentHead.update({
          where: {
            tenantId_contactId_segmentId: {
              tenantId: input.tenantId,
              contactId: receipt.contactId,
              segmentId: receipt.segmentId,
            },
          },
          data: {
            terminalEntryId: input.terminalEntryId,
            terminalRevision: receipt.membershipRevision,
            terminalReasonCode: input.reasonCode,
          },
        });
      }

      await transaction.$executeRaw`SAVEPOINT segment_cursor`;
      try {
        await transaction.jrSegmentRefilterCursor.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            contactId: receipt.contactId,
            segmentId: receipt.segmentId,
            membershipRevision: receipt.membershipRevision,
            receiptId: receipt.id,
            reasonCode: input.reasonCode,
            correlationId: input.correlationId,
          },
        });
        await transaction.$executeRaw`RELEASE SAVEPOINT segment_cursor`;
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        await transaction.$executeRaw`ROLLBACK TO SAVEPOINT segment_cursor`;
      }

      await this.enqueue(transaction, receipt, event, input.correlationId);
      return this.markApplied(transaction, receipt.id);
    });
  }

  /**
   * closes a receipt without creating any further work — the head still has to advance
   *
   * used for a change no journey cares about, or a contact that is no longer eligible; without advancing the head,
   * the next revision of the same stream would be stuck in WAITING_FOR_GAP forever waiting for this revision, which would
   * never be applied, and no outbox is created because there is nothing to announce
   */
  async applyNoOp(tenantId: string, receiptId: string): Promise<JrSegmentReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const receipt = await transaction.jrSegmentReceipt.findUniqueOrThrow({
        where: { id: receiptId },
      });
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${streamLockKey(tenantId, receipt.contactId, receipt.segmentId)}))`,
      );
      await this.advanceHead(transaction, receipt);
      return this.markApplied(transaction, receipt.id);
    });
  }

  /**
   * claims one re-filter job with a lease/CAS
   *
   * includes REVALIDATING whose lease expired returning to the queue, and DEFERRED/HELD whose retry time has come
   * — work that is set aside must always have a day to come back, otherwise the contact would be stuck in a state nobody follows up
   */
  async claimNextRefilter(
    tenantId: string,
    workerId: string,
    leaseSeconds = 30,
  ): Promise<ClaimedRefilterCursor | undefined> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM jr_segment_refilter_cursors
        WHERE tenant_id = ${tenantId}::uuid
          AND (
            (state IN ('PENDING', 'DEFERRED', 'HELD', 'RECONCILING') AND available_at <= ${now})
            OR (state = 'REVALIDATING' AND lease_expires_at <= ${now})
          )
        ORDER BY available_at, membership_revision
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      /**
       * fetch the receipt in the same statement — reading later outside this transaction would escape the tenant
       * context that RLS uses (`current_setting('app.tenant_id')` becomes an empty string that cannot be cast
       * to uuid) and opening a new transaction would also let data change in between
       */
      return transaction.jrSegmentRefilterCursor.update({
        where: { id: candidate.id },
        data: {
          state: 'REVALIDATING',
          leaseOwner: workerId,
          leaseExpiresAt,
          version: { increment: 1 },
        },
        include: { receipt: { select: { entryId: true, changeKind: true } } },
      });
    });
  }

  /**
   * closes a re-filter job that can be decided — only NO_OP and CANCELLED are final
   *
   * the CHECK constraint of #216 requires settledAt to exist only for these two states, so here it is set to
   * match instead of leaving the caller to guess
   */
  async settleRefilter(
    tenantId: string,
    cursorId: string,
    state: 'NO_OP' | 'CANCELLED',
    reasonCode: string,
  ): Promise<JrSegmentRefilterCursor> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrSegmentRefilterCursor.update({
        where: { id: cursorId },
        data: {
          state,
          reasonCode,
          settledAt: this.now(),
          leaseOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      }),
    );
  }

  /**
   * puts a re-filter job aside without closing it — always releases the lease and delays the retry time
   *
   * DEFERRED is used when the context is not ready, HELD when owner-side work is pending, RECONCILING
   * when waiting for a new canonical fact from Customer 360; all three must come back on their own, not wait for a person to press a button
   */
  async holdRefilter(
    tenantId: string,
    cursorId: string,
    state: 'DEFERRED' | 'HELD' | 'RECONCILING',
    reasonCode: string,
    backoffMs: number,
  ): Promise<JrSegmentRefilterCursor> {
    const availableAt = new Date(this.now().getTime() + backoffMs);
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrSegmentRefilterCursor.update({
        where: { id: cursorId },
        data: {
          state,
          reasonCode,
          attempts: { increment: 1 },
          availableAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      }),
    );
  }

  async markReview(
    tenantId: string,
    receiptId: string,
    reasonCode: string,
  ): Promise<JrSegmentReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrSegmentReceipt.update({
        where: { id: receiptId },
        data: {
          state: 'REVIEW',
          reviewReasonCode: reasonCode,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      }),
    );
  }

  async markQuarantined(
    tenantId: string,
    receiptId: string,
    reasonCode: string,
  ): Promise<JrSegmentReceipt> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrSegmentReceipt.update({
        where: { id: receiptId },
        data: {
          state: 'QUARANTINED',
          reviewReasonCode: reasonCode,
          leaseOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      }),
    );
  }

  /**
   * releases the lease and delays the time to retry — for temporary causes only (STALE/unavailable)
   * not for a permanently broken payload, which must go to QUARANTINED
   */
  async markRetryableFailure(
    tenantId: string,
    receiptId: string,
    backoffMs: number,
    reason: string,
  ): Promise<JrSegmentReceipt> {
    const availableAt = new Date(this.now().getTime() + backoffMs);
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrSegmentReceipt.update({
        where: { id: receiptId },
        data: {
          state: 'READY',
          attempts: { increment: 1 },
          availableAt,
          lastError: reason.slice(0, 1_000),
          leaseOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      }),
    );
  }

  private async advanceHead(transaction: Prisma.TransactionClient, receipt: JrSegmentReceipt) {
    const key = {
      tenantId_contactId_segmentId: {
        tenantId: receipt.tenantId,
        contactId: receipt.contactId,
        segmentId: receipt.segmentId,
      },
    };
    const head = await transaction.jrSegmentHead.findUnique({ where: key });
    if (!head) {
      const created = await transaction.jrSegmentHead.create({
        data: {
          tenantId: receipt.tenantId,
          contactId: receipt.contactId,
          segmentId: receipt.segmentId,
          lastAppliedRevision: receipt.membershipRevision,
          lastAppliedReceiptId: receipt.id,
        },
      });
      await this.promoteWaiting(transaction, receipt, receipt.membershipRevision);
      return created;
    }
    if (head.lastAppliedRevision >= receipt.membershipRevision) return head;
    const updated = await transaction.jrSegmentHead.update({
      where: key,
      data: {
        lastAppliedRevision: receipt.membershipRevision,
        lastAppliedReceiptId: receipt.id,
      },
    });
    await this.promoteWaiting(transaction, receipt, receipt.membershipRevision);
    return updated;
  }

  /**
   * the head moved: a WAITING_FOR_GAP of this stream may be ready to apply because the gap was filled
   * or may have become stale and need no apply — otherwise it would wait forever
   */
  private async promoteWaiting(
    transaction: Prisma.TransactionClient,
    receipt: JrSegmentReceipt,
    lastAppliedRevision: number,
  ): Promise<void> {
    const waiting = await transaction.jrSegmentReceipt.findMany({
      where: {
        tenantId: receipt.tenantId,
        contactId: receipt.contactId,
        segmentId: receipt.segmentId,
        state: 'WAITING_FOR_GAP',
      },
      orderBy: { membershipRevision: 'asc' },
    });
    for (const pending of waiting) {
      if (pending.membershipRevision <= lastAppliedRevision) {
        await transaction.jrSegmentReceipt.update({
          where: { id: pending.id },
          data: { state: 'IGNORED_SUPERSEDED', version: { increment: 1 } },
        });
      } else if (pending.membershipRevision === lastAppliedRevision + 1) {
        await transaction.jrSegmentReceipt.update({
          where: { id: pending.id },
          data: { state: 'READY', version: { increment: 1 } },
        });
      }
    }
  }

  private async enqueue(
    transaction: Prisma.TransactionClient,
    receipt: JrSegmentReceipt,
    event: SegmentOutboxEventInput,
    correlationId: string,
    causationId?: string,
  ): Promise<void> {
    await transaction.$executeRaw`SAVEPOINT segment_outbox`;
    try {
      await transaction.jrSegmentOutbox.create({
        data: {
          id: this.id(),
          tenantId: receipt.tenantId,
          receiptId: receipt.id,
          eventId: this.id(),
          eventType: event.eventType,
          orderingKey: event.orderingKey,
          payloadHash: event.payloadHash,
          payload: event.payload as Prisma.InputJsonValue,
          correlationId,
          ...(causationId ? { causationId } : {}),
        },
      });
      await transaction.$executeRaw`RELEASE SAVEPOINT segment_outbox`;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      await transaction.$executeRaw`ROLLBACK TO SAVEPOINT segment_outbox`;
    }
  }

  private markApplied(
    transaction: Prisma.TransactionClient,
    receiptId: string,
  ): Promise<JrSegmentReceipt> {
    return transaction.jrSegmentReceipt.update({
      where: { id: receiptId },
      data: {
        state: 'APPLIED',
        appliedAt: this.now(),
        leaseOwner: null,
        leaseExpiresAt: null,
        version: { increment: 1 },
      },
    });
  }
}
