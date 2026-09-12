import {
  Prisma,
  withTenantDatabaseTransaction,
  type PrismaClient,
} from '@d-contact/db';
import type { DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';

export interface JourneyAcknowledgementPublishAttempt {
  acknowledgementId: string;
  state: 'PUBLISHED' | 'FAILED';
  attempts: number;
}

export interface JourneyAcknowledgementRelayOptions {
  now?: () => Date;
  backoffMs?: (attempts: number) => number;
}

function defaultBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1_000, 5 * 60_000);
}

const aggregateTypeName = {
  CONTACT: 'contact_governance_contact',
  POLICY: 'contact_governance_policy',
} as const;

/** Durable Journey outbox relay. It never re-applies an event and never emits raw contact data. */
export class JourneyGovernanceAcknowledgementRelay {
  private readonly now: () => Date;
  private readonly backoffMs: (attempts: number) => number;

  constructor(
    private readonly database: PrismaClient,
    private readonly producer: DcProducer,
    options: JourneyAcknowledgementRelayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
  }

  async publishNext(tenantId: string): Promise<JourneyAcknowledgementPublishAttempt | undefined> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM jr_governance_acknowledgement_outbox
        WHERE tenant_id = ${tenantId}::uuid
          AND state IN ('PENDING', 'FAILED')
          AND available_at <= ${now}
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      const row = await transaction.jrGovernanceAcknowledgementOutbox.findFirstOrThrow({
        where: { id: candidate.id, tenantId },
      });
      const attempts = row.attempts + 1;
      try {
        await this.producer.send(KAFKA_TOPICS.CONTACT_GOVERNANCE_ACKNOWLEDGEMENTS, {
          schemaVersion: 2,
          eventKind: 'CANONICAL',
          eventId: row.eventId,
          type: 'contact_governance.acknowledged',
          tenantId,
          occurredAt: now.toISOString(),
          correlationId: row.eventId,
          orderingKey: `${tenantId}:${row.aggregateId}`,
          aggregateType: aggregateTypeName[row.aggregateType],
          aggregateId: row.aggregateId,
          aggregateVersion: row.appliedVersion,
          payload: {
            contractVersion: 1,
            consumer: row.consumer,
            aggregateType: row.aggregateType,
            aggregateId: row.aggregateId,
            appliedVersion: row.appliedVersion,
            outcome: row.outcome === 'QUARANTINED' ? 'FAILED' : row.outcome,
            affectedCount: row.affectedCount,
            sourcePayloadHash: row.sourcePayloadHash,
          },
        });
        await transaction.jrGovernanceAcknowledgementOutbox.update({
          where: { id: row.id },
          data: { state: 'PUBLISHED', attempts, publishedAt: now, lastError: null },
        });
        return { acknowledgementId: row.id, state: 'PUBLISHED' as const, attempts };
      } catch (error) {
        await transaction.jrGovernanceAcknowledgementOutbox.update({
          where: { id: row.id },
          data: {
            state: 'FAILED',
            attempts,
            availableAt: new Date(now.getTime() + this.backoffMs(attempts)),
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
        return { acknowledgementId: row.id, state: 'FAILED' as const, attempts };
      }
    });
  }
}
