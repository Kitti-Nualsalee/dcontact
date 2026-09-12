import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { DialerGovernanceMetrics, DialerRealtimeSettlementPort } from './dialer-governance.js';

export class DialerGovernanceEffectRelay {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly metrics: DialerGovernanceMetrics;

  constructor(
    private readonly database: PrismaClient,
    private readonly settlement: DialerRealtimeSettlementPort,
    options: { now?: () => Date; retryDelayMs?: number; metrics?: DialerGovernanceMetrics } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    this.metrics = options.metrics ?? { increment() {}, observe() {} };
  }

  async executeNext(tenantId: string): Promise<'SUCCEEDED' | 'RETRY' | undefined> {
    const effect = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      async (transaction) => {
        const candidates = await transaction.$queryRaw<
          Array<{
            id: string;
            attempt_id: string;
            action_key: string;
            reservation_id: string;
            delivery_id: string | null;
            provider_request_key: string | null;
            correlation_id: string;
            kind: 'RELEASE_BEFORE_BARRIER' | 'REQUEST_RECONCILE';
            created_at: Date;
          }>
        >(Prisma.sql`
        SELECT id, attempt_id, action_key, reservation_id, delivery_id, provider_request_key, correlation_id, kind, created_at
        FROM ob_governance_effect_outbox WHERE tenant_id = ${tenantId}::uuid
          AND state = 'PENDING' AND available_at <= ${this.now()}
        ORDER BY available_at, created_at LIMIT 1 FOR UPDATE SKIP LOCKED
      `);
        const row = candidates[0];
        if (!row) return undefined;
        await transaction.obGovernanceEffectOutbox.update({
          where: { id: row.id },
          data: { state: 'PROCESSING', attempts: { increment: 1 } },
        });
        return row;
      },
    );
    if (!effect) return undefined;
    try {
      if (effect.kind === 'RELEASE_BEFORE_BARRIER') {
        await this.settlement.releaseBeforeBarrier({
          tenantId,
          reservationId: effect.reservation_id,
          actionKey: effect.action_key,
          correlationId: effect.correlation_id,
        });
      } else {
        if (!effect.delivery_id || !effect.provider_request_key)
          throw new Error('post-barrier Dialer attempt ไม่มี immutable binding');
        this.metrics.observe(
          'dialer_cg3_reconcile_age_ms',
          this.now().getTime() - effect.created_at.getTime(),
        );
        await this.settlement.requestReconcile({
          tenantId,
          reservationId: effect.reservation_id,
          actionKey: effect.action_key,
          deliveryId: effect.delivery_id,
          providerRequestKey: effect.provider_request_key,
          correlationId: effect.correlation_id,
        });
      }
      await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.obGovernanceEffectOutbox.update({
          where: { id: effect.id },
          data: { state: 'SUCCEEDED', completedAt: this.now(), lastError: null },
        }),
      );
      return 'SUCCEEDED';
    } catch (error) {
      await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.obGovernanceEffectOutbox.update({
          where: { id: effect.id },
          data: {
            state: 'PENDING',
            availableAt: new Date(this.now().getTime() + this.retryDelayMs),
            lastError:
              error instanceof Error ? error.message.slice(0, 1_000) : 'unknown effect failure',
          },
        }),
      );
      return 'RETRY';
    }
  }

  async observeReconcileBacklog(tenantId: string): Promise<void> {
    const count = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obGovernanceEffectOutbox.count({
        where: { tenantId, kind: 'REQUEST_RECONCILE', state: { in: ['PENDING', 'PROCESSING'] } },
      }),
    );
    this.metrics.observe('dialer_cg3_reconcile_backlog', count);
  }
}
