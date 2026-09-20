import {
  Prisma,
  withTenantDatabaseTransaction,
  type CgEventOutboxState,
  type PrismaClient,
} from '@d-contact/db';
import type { DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import type { Cg4Cache } from './cg4-cache.js';
import {
  isCg4ProducerSideRejection,
  parseCg4CanonicalEvent,
  type Cg4EnvelopeRejection,
} from './cg4-event-envelope.js';

/**
 * CG4.6 (#189): the single Contact Governance outbox relay.
 *
 * Supersedes `Cg3EventRelay` — both drain `cg_event_outbox`, so exactly one of them runs
 * in a deployment. On top of the CG3 behaviour this adds the three things #179 §4/§5 ask
 * for: a worker lease so a crashed relay's row is recoverable instead of stuck, a
 * contract guard that quarantines an uninterpretable payload rather than retrying it
 * forever, and CG4 cache invalidation keyed the way readers actually look things up.
 *
 * Delivery stays at-least-once with a stable `eventId` (the outbox row id), so a publish
 * that succeeded but failed to commit is republished and de-duplicated by the consumer's
 * inbox rather than being papered over here.
 */

export interface Cg4EventPublishAttempt {
  outboxId: string;
  state: CgEventOutboxState;
  attempts: number;
  /** Set when the row was quarantined instead of published. */
  rejection?: Cg4EnvelopeRejection;
}

export interface Cg4EventRelayOptions {
  now?: () => Date;
  /** Exponential backoff per attempt before retry (ms); default 2^attempts s, capped at 5m. */
  backoffMs?: (attempts: number) => number;
  cache?: Cg4Cache;
  /** Identifies the worker holding a row's lease; defaults to the process id. */
  leaseOwner?: string;
  leaseSeconds?: number;
  /** Non-CG4 event types the CG3 paths still emit; published without the CG4 guard. */
  legacyEventTypes?: readonly string[];
  onQuarantine?: (input: {
    tenantId: string;
    outboxId: string;
    eventType: string;
    reason: Cg4EnvelopeRejection;
    detail: string;
  }) => void;
}

function defaultBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1_000, 5 * 60_000);
}

const AGGREGATE_TYPE_MAP = {
  CONTACT: 'contact_governance_contact',
  POLICY: 'contact_governance_policy',
  ALERT: 'contact_governance_alert',
} as const;

/** CG3 emits `policy.changed` from its own writer; those rows predate the CG4 contract. */
const DEFAULT_LEGACY_EVENT_TYPES: readonly string[] = Object.freeze([]);

export class Cg4EventRelay {
  private readonly now: () => Date;
  private readonly backoffMs: (attempts: number) => number;
  private readonly cache: Cg4Cache | undefined;
  private readonly leaseOwner: string;
  private readonly leaseSeconds: number;
  private readonly legacyEventTypes: ReadonlySet<string>;
  private readonly onQuarantine: Cg4EventRelayOptions['onQuarantine'];

  constructor(
    private readonly database: PrismaClient,
    private readonly producer: DcProducer,
    options: Cg4EventRelayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.cache = options.cache;
    this.leaseOwner = options.leaseOwner ?? `relay-${process.pid}`;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.legacyEventTypes = new Set(options.legacyEventTypes ?? DEFAULT_LEGACY_EVENT_TYPES);
    this.onQuarantine = options.onQuarantine;
  }

  /**
   * Publishes the next ready row, or returns undefined when there is nothing due. Rows are
   * claimed with `FOR UPDATE SKIP LOCKED` inside the tenant transaction, so parallel
   * relays never contend on the same row; the persisted lease is what lets an operator see
   * which worker last held a row that is still in flight.
   */
  async publishNext(tenantId: string): Promise<Cg4EventPublishAttempt | undefined> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM cg_event_outbox
        WHERE tenant_id = ${tenantId}::uuid
          AND state IN ('PENDING', 'FAILED')
          AND available_at <= ${now}
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;

      const row = await transaction.cgEventOutbox.findFirstOrThrow({
        where: { id: candidate.id, tenantId },
      });
      const attempts = row.attempts + 1;

      if (!this.legacyEventTypes.has(row.eventType)) {
        const parsed = parseCg4CanonicalEvent({
          eventType: row.eventType,
          payload: row.payload,
        });
        if (!parsed.ok && isCg4ProducerSideRejection(parsed.reason)) {
          // Retrying would republish the same bad payload forever, and publishing it once
          // would put it in front of every consumer. Hold it for a forward fix instead.
          await transaction.cgEventOutbox.update({
            where: { id: row.id },
            data: { state: 'QUARANTINED', attempts, leaseOwner: null, leaseExpiresAt: null },
          });
          this.onQuarantine?.({
            tenantId,
            outboxId: row.id,
            eventType: row.eventType,
            reason: parsed.reason,
            detail: parsed.detail,
          });
          return {
            outboxId: row.id,
            state: 'QUARANTINED' as CgEventOutboxState,
            attempts,
            rejection: parsed.reason,
          };
        }
        // A version this build cannot interpret is still published: the contract is
        // forward-compatible by design, and it is the consumer that decides to DLQ it.
      }

      await transaction.cgEventOutbox.update({
        where: { id: row.id },
        data: {
          state: 'PUBLISHING',
          leaseOwner: this.leaseOwner,
          leaseExpiresAt: new Date(now.getTime() + this.leaseSeconds * 1_000),
        },
      });

      try {
        await this.producer.send(KAFKA_TOPICS.CONTACT_GOVERNANCE_EVENTS, {
          eventId: row.id,
          type: row.eventType,
          tenantId,
          occurredAt: now.toISOString(),
          correlationId: row.mutationId,
          orderingKey: row.orderingKey,
          schemaVersion: 2,
          eventKind: 'CANONICAL',
          aggregateType: AGGREGATE_TYPE_MAP[row.aggregateType],
          aggregateId: row.aggregateId,
          aggregateVersion: row.aggregateVersion,
          payload: row.payload as unknown as Record<string, unknown>,
        });
        await transaction.cgEventOutbox.update({
          where: { id: row.id },
          data: {
            state: 'PUBLISHED',
            attempts,
            publishedAt: now,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        await this.invalidate(tenantId, row);
        return { outboxId: row.id, state: 'PUBLISHED' as CgEventOutboxState, attempts };
      } catch {
        await transaction.cgEventOutbox.update({
          where: { id: row.id },
          data: {
            state: 'FAILED',
            attempts,
            availableAt: new Date(now.getTime() + this.backoffMs(attempts)),
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        return { outboxId: row.id, state: 'FAILED' as CgEventOutboxState, attempts };
      }
    });
  }

  /**
   * Invalidation runs after the publish, never before: dropping a head first would let a
   * reader repopulate it from canonical state and then have the publish fail, leaving the
   * cache correct but the stream behind. Failing to invalidate only costs a stale head
   * until its `validUntil`, which readers already refuse to use.
   */
  private async invalidate(
    tenantId: string,
    row: { aggregateType: 'CONTACT' | 'POLICY' | 'ALERT'; aggregateId: string; payload: unknown },
  ): Promise<void> {
    if (!this.cache) return;
    if (row.aggregateType === 'CONTACT') {
      await this.cache.invalidateContactHead(tenantId, row.aggregateId);
      const subjectId = (row.payload as { subjectId?: unknown } | null)?.subjectId;
      if (typeof subjectId === 'string') {
        await this.cache.invalidateExceptionHead(tenantId, subjectId);
      }
      return;
    }
    await this.cache.invalidatePolicyHead(tenantId, row.aggregateId);
  }

  /**
   * Returns rows whose lease expired while `PUBLISHING` — a relay that died mid-publish.
   * They are made available again rather than assumed failed, because the publish may
   * well have reached the broker; the consumer inbox is what makes the replay a no-op.
   */
  async recoverExpiredLeases(tenantId: string): Promise<number> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const recovered = await transaction.cgEventOutbox.updateMany({
        where: { tenantId, state: 'PUBLISHING', leaseExpiresAt: { lte: now } },
        data: { state: 'PENDING', availableAt: now, leaseOwner: null, leaseExpiresAt: null },
      });
      return recovered.count;
    });
  }
}
