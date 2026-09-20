import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';

const aggregateTypeName = {
  CONTACT: 'contact_governance_contact',
  POLICY: 'contact_governance_policy',
  ALERT: 'contact_governance_alert',
} as const;

export class DialerGovernanceAcknowledgementRelay {
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly producer: DcProducer,
    options: { now?: () => Date; backoffMs?: (attempt: number) => number } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.backoffMs = options.backoffMs ?? ((attempt) => Math.min(2 ** attempt * 1_000, 300_000));
  }

  private readonly backoffMs: (attempt: number) => number;

  async publishNext(tenantId: string): Promise<'PUBLISHED' | 'FAILED' | undefined> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM ob_governance_acknowledgement_outbox
        WHERE tenant_id = ${tenantId}::uuid AND state IN ('PENDING', 'FAILED') AND available_at <= ${now}
        ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;
      const row = await transaction.obGovernanceAcknowledgementOutbox.findFirstOrThrow({
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
            outcome: row.outcome,
            affectedCount: row.affectedCount,
            sourcePayloadHash: row.sourcePayloadHash,
            ...(row.appliedStateDigest ? { appliedStateDigest: row.appliedStateDigest } : {}),
          },
        });
        await transaction.obGovernanceAcknowledgementOutbox.update({
          where: { id: row.id },
          data: { state: 'PUBLISHED', attempts, publishedAt: now, lastError: null },
        });
        return 'PUBLISHED' as const;
      } catch (error) {
        await transaction.obGovernanceAcknowledgementOutbox.update({
          where: { id: row.id },
          data: {
            state: 'FAILED',
            attempts,
            availableAt: new Date(now.getTime() + this.backoffMs(attempts)),
            lastError:
              error instanceof Error
                ? error.message.slice(0, 1_000)
                : 'unknown acknowledgement failure',
          },
        });
        return 'FAILED' as const;
      }
    });
  }
}
