/**
 * Owner: Channels/Dialer — durable ownership of the outbox
 *
 * Every write goes through `withTenantDatabaseTransaction` so the RLS of `dl_outbox_entries`
 * really works with the application role and no query can read across tenants.
 * The repository knows neither Governance nor a transport — it stores state only
 *
 * Mixed-version guard (S2.1 #365): one repository is bound to one adapter, and every read/claim/advance
 * that works with a delivery filters by that adapter, so the TEST_ADAPTER worker never picks up a
 * LINE_MESSAGING_API row to submit/reconcile and vice versa, except `findByActionKey` which must see every
 * adapter because `(tenant_id, action_key)` is the shared idempotency identity — the caller must reject
 * a row of another adapter itself
 */
import {
  Prisma,
  type CgFactOutcome,
  type DlDeliveryAdapter,
  type DlDeliveryState,
  type DlOutboxEntry,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { ContactChannel } from '@d-contact/cxa-contracts';

export interface CreateOutboxEntryInput {
  id: string;
  tenantId: string;
  actionKey: string;
  reservationId: string;
  deliveryId: string;
  providerRequestKey: string;
  channel: ContactChannel;
  contactId: string;
  identityId?: string;
  purpose: string;
  source: string;
  senderIdentityId: string;
  contentRef: string;
  inputHash: string;
  leaseVersion: number;
  leaseExpiresAt: Date;
  correlationId: string;
  causationId?: string;
}

export class OutboxEntryAlreadyExistsError extends Error {
  readonly code = 'OUTBOX_ENTRY_ALREADY_EXISTS';

  constructor(readonly actionKey: string) {
    super(`an outbox entry for actionKey ${actionKey} already exists`);
    this.name = 'OutboxEntryAlreadyExistsError';
  }
}

function isUniqueViolation(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class OutboxRepository {
  constructor(
    private readonly database: PrismaClient,
    readonly adapter: DlDeliveryAdapter = 'TEST_ADAPTER',
  ) {}

  /** deliberately does not filter by adapter — see the mixed-version guard note above */
  findByActionKey(tenantId: string, actionKey: string): Promise<DlOutboxEntry | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlOutboxEntry.findFirst({ where: { tenantId, actionKey } }),
    );
  }

  findByDeliveryId(tenantId: string, deliveryId: string): Promise<DlOutboxEntry | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlOutboxEntry.findFirst({
        where: { tenantId, deliveryId, adapter: this.adapter },
      }),
    );
  }

  /**
   * the single insert that arbitrates racing concurrent enqueues: the unique index
   * `(tenant_id, action_key)` decides, not a read-before-write, so the loser knows
   * from P2002 instead of overwriting the winner's delivery
   */
  async create(input: CreateOutboxEntryInput): Promise<DlOutboxEntry> {
    return this.createWith(input, async (_transaction, entry) => entry).then(({ entry }) => entry);
  }

  /** write the adapter's extension in the same transaction as the generic outbox so no delivery is orphaned */
  async createWith<T>(
    input: CreateOutboxEntryInput,
    afterCreate: (transaction: Prisma.TransactionClient, entry: DlOutboxEntry) => Promise<T>,
  ): Promise<{ entry: DlOutboxEntry; result: T }> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      let entry: DlOutboxEntry;
      try {
        entry = await transaction.dlOutboxEntry.create({
          data: {
            id: input.id,
            tenantId: input.tenantId,
            actionKey: input.actionKey,
            reservationId: input.reservationId,
            deliveryId: input.deliveryId,
            providerRequestKey: input.providerRequestKey,
            adapter: this.adapter,
            channel: input.channel,
            contactId: input.contactId,
            ...(input.identityId ? { identityId: input.identityId } : {}),
            purpose: input.purpose,
            source: input.source,
            senderIdentityId: input.senderIdentityId,
            contentRef: input.contentRef,
            inputHash: input.inputHash,
            state: 'QUEUED',
            leaseVersion: input.leaseVersion,
            leaseExpiresAt: input.leaseExpiresAt,
            correlationId: input.correlationId,
            ...(input.causationId ? { causationId: input.causationId } : {}),
          },
        });
      } catch (error) {
        if (isUniqueViolation(error)) throw new OutboxEntryAlreadyExistsError(input.actionKey);
        throw error;
      }
      return { entry, result: await afterCreate(transaction, entry) };
    });
  }

  /**
   * conditional state advance: `expected` is the state the caller read; if the row has already been moved
   * by another worker the update hits no row and returns null so the caller re-reads
   */
  async advance(
    tenantId: string,
    deliveryId: string,
    expected: DlDeliveryState[],
    data: {
      state: DlDeliveryState;
      submittedAt?: Date;
      settledAt?: Date;
      outcome?: CgFactOutcome;
      outcomeRef?: string;
    },
  ): Promise<DlOutboxEntry | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlOutboxEntry.updateMany({
        where: { tenantId, deliveryId, adapter: this.adapter, state: { in: expected } },
        data,
      });
      if (updated.count === 0) return null;
      return transaction.dlOutboxEntry.findFirst({
        where: { tenantId, deliveryId, adapter: this.adapter },
      });
    });
  }

  /** jobs that passed the submission barrier but whose lease expired — must reconcile, never resend */
  findReconcilable(tenantId: string, notAfter: Date): Promise<DlOutboxEntry[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlOutboxEntry.findMany({
        where: {
          tenantId,
          adapter: this.adapter,
          state: { in: ['SUBMITTING', 'SUBMITTED'] },
          leaseExpiresAt: { lte: notAfter },
        },
        orderBy: { leaseExpiresAt: 'asc' },
      }),
    );
  }
}
