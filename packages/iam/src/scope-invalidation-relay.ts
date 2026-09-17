import { assertTeamSegmentScopeChangedEnvelope } from '@d-contact/cxa-contracts';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';

export class IamScopeInvalidationRelay {
  constructor(
    private readonly database: PrismaClient,
    private readonly producer: DcProducer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publishNext(tenantId: string): Promise<'PUBLISHED' | 'FAILED' | undefined> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const [candidate] = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id FROM iam_scope_invalidation_outbox
        WHERE tenant_id = ${tenantId}::uuid AND state IN ('PENDING', 'FAILED')
          AND available_at <= ${this.now()}
        ORDER BY created_at, id LIMIT 1 FOR UPDATE SKIP LOCKED
      `);
      if (!candidate) return undefined;
      const row = await transaction.iamScopeInvalidationOutbox.findFirstOrThrow({
        where: { tenantId, id: candidate.id },
      });
      const attempts = row.attempts + 1;
      try {
        const payload = row.payload as Record<string, unknown>;
        const event = assertTeamSegmentScopeChangedEnvelope({
          schemaVersion: 2,
          eventKind: 'CANONICAL',
          eventId: row.eventId,
          type: 'team.segment-scope.changed',
          tenantId,
          occurredAt: payload.occurredAt,
          correlationId: payload.correlationId,
          orderingKey: row.teamId,
          aggregateType: 'iam_team_scope',
          aggregateId: row.teamId,
          aggregateVersion: row.scopeVersion,
          payload: {
            contractVersion: 1,
            teamId: row.teamId,
            grantId: payload.grantId,
            scopeVersion: row.scopeVersion,
            kind: row.kind,
          },
        });
        await this.producer.send(KAFKA_TOPICS.ADMIN_EVENTS, event);
        await transaction.iamScopeInvalidationOutbox.update({
          where: { id: row.id },
          data: { state: 'PUBLISHED', attempts, publishedAt: this.now() },
        });
        return 'PUBLISHED' as const;
      } catch (error) {
        await transaction.iamScopeInvalidationOutbox.update({
          where: { id: row.id },
          data: {
            state: 'FAILED',
            attempts,
            availableAt: new Date(this.now().getTime() + 1_000),
          },
        });
        return 'FAILED' as const;
      }
    });
  }
}
