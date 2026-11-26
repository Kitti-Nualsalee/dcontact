import {
  Prisma,
  withTenantDatabaseTransaction,
  type CgEventOutboxState,
  type PrismaClient,
} from '@d-contact/db';
import type { DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import type { Cg3Cache } from './cg3-cache.js';

/**
 * Relay for cg_event_outbox -> dc.contact-governance.events (#104 "Kafka, cache,
 * realtime and submission race"). The same logic as apps/journey/src/event-inbox.ts:
 * FOR UPDATE SKIP LOCKED inside a single tenant transaction: if the publish succeeds but
 * the commit does not land in time (crash) it retries as at-least-once; the receiving consumer must have
 * its own idempotency boundary (see cg3-acknowledgement-consumer.ts)
 */

export interface EventPublishAttempt {
  outboxId: string;
  state: CgEventOutboxState;
  attempts: number;
}

export interface Cg3EventRelayOptions {
  now?: () => Date;
  /** exponential backoff per attempt before retry (ms); default 2^attempts*1s up to 5 minutes */
  backoffMs?: (attempts: number) => number;
  /** invalidate the mutable head cache after a successful publish (#104 "invalidate when a new event arrives") */
  cache?: Cg3Cache;
}

function defaultBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1_000, 5 * 60_000);
}

const AGGREGATE_TYPE_MAP = {
  CONTACT: 'contact_governance_contact',
  POLICY: 'contact_governance_policy',
  ALERT: 'contact_governance_alert',
  EXPORT: 'contact_governance_export',
} as const;

export class Cg3EventRelay {
  private readonly now: () => Date;
  private readonly backoffMs: (attempts: number) => number;
  private readonly cache: Cg3Cache | undefined;

  constructor(
    private readonly database: PrismaClient,
    private readonly producer: DcProducer,
    options: Cg3EventRelayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
    this.cache = options.cache;
  }

  /** publish a single ready outbox row (PENDING/FAILED and past its retry time); undefined if there is none */
  async publishNext(tenantId: string): Promise<EventPublishAttempt | undefined> {
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
        if (row.aggregateType === 'CONTACT') {
          await this.cache?.invalidateContactHead(tenantId, row.aggregateId);
        } else {
          await this.cache?.invalidatePolicyHead(tenantId, row.aggregateId);
        }
        return { outboxId: row.id, state: 'PUBLISHED', attempts };
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
        return { outboxId: row.id, state: 'FAILED', attempts };
      }
    });
  }
}
