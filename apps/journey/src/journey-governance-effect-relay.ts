/**
 * S1.5 relay for side effects arising from CG3 invalidation.
 * Splits the cross-owner call out of the consumer transaction: an APPLIED acknowledgement therefore proves
 * that the action cursor and the durable command were committed, even if the relay must retry.
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { JourneyRealtimeSettlementPort } from './journey-governance-invalidation.js';
import {
  noOpJourneyGovernanceMetrics,
  type JourneyGovernanceMetrics,
} from './journey-governance-metrics.js';

export interface JourneyGovernanceEffectRelayOptions {
  now?: () => Date;
  retryDelayMs?: number;
  metrics?: JourneyGovernanceMetrics;
}

export class JourneyGovernanceEffectRelay {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly metrics: JourneyGovernanceMetrics;

  constructor(
    private readonly database: PrismaClient,
    private readonly settlement: JourneyRealtimeSettlementPort,
    options: JourneyGovernanceEffectRelayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.metrics = options.metrics ?? noOpJourneyGovernanceMetrics;
  }

  /** Sends at most one command; the caller decides polling/backoff itself. */
  async executeNext(tenantId: string): Promise<'SUCCEEDED' | 'RETRY' | undefined> {
    const claimed = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      async (transaction) => {
        const candidates = await transaction.$queryRaw<
          Array<{
            id: string;
            action_id: string;
            action_key: string;
            reservation_id: string;
            delivery_id: string | null;
            provider_request_key: string | null;
            correlation_id: string;
            created_at: Date;
            kind: 'RELEASE_BEFORE_BARRIER' | 'REQUEST_RECONCILE';
          }>
        >(Prisma.sql`
        SELECT id, action_id, action_key, reservation_id, delivery_id, provider_request_key, correlation_id, created_at, kind
        FROM jr_governance_effect_outbox
        WHERE tenant_id = ${tenantId}::uuid
          AND state = 'PENDING'
          AND available_at <= ${this.now()}
        ORDER BY available_at, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
        const effect = candidates[0];
        if (!effect) return undefined;
        await transaction.jrGovernanceEffectOutbox.update({
          where: { id: effect.id },
          data: { state: 'PROCESSING', attempts: { increment: 1 } },
        });
        return effect;
      },
    );
    if (!claimed) return undefined;
    if (claimed.kind === 'REQUEST_RECONCILE') {
      this.metrics.observe(
        'journey_cg3_reconcile_age_ms',
        this.now().getTime() - claimed.created_at.getTime(),
      );
    }

    try {
      if (claimed.kind === 'RELEASE_BEFORE_BARRIER') {
        await this.settlement.releaseBeforeBarrier({
          tenantId,
          reservationId: claimed.reservation_id,
          actionKey: claimed.action_key,
          ...(claimed.delivery_id ? { deliveryId: claimed.delivery_id } : {}),
          correlationId: claimed.correlation_id,
        });
      } else {
        await this.settlement.requestReconcile({
          tenantId,
          reservationId: claimed.reservation_id,
          actionKey: claimed.action_key,
          ...(claimed.delivery_id ? { deliveryId: claimed.delivery_id } : {}),
          ...(claimed.provider_request_key
            ? { providerRequestKey: claimed.provider_request_key }
            : {}),
          correlationId: claimed.correlation_id,
        });
      }
      await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.jrGovernanceEffectOutbox.update({
          where: { id: claimed.id },
          data: { state: 'SUCCEEDED', completedAt: this.now(), lastError: null },
        }),
      );
      return 'SUCCEEDED';
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (
        claimed.kind === 'RELEASE_BEFORE_BARRIER' &&
        code === 'DELIVERY_RECONCILIATION_REQUIRED'
      ) {
        const recovered = await withTenantDatabaseTransaction(
          this.database,
          tenantId,
          async (transaction) => {
            const action = await transaction.jrAction.findFirst({
              where: { id: claimed.action_id, tenantId },
              select: { deliveryId: true, providerRequestKey: true },
            });
            if (!action?.deliveryId || !action.providerRequestKey) {
              await transaction.jrAction.updateMany({
                where: { id: claimed.action_id, tenantId },
                data: { realtimeState: 'HELD' },
              });
              return false;
            }
            await transaction.jrAction.update({
              where: { id: claimed.action_id },
              data: { realtimeState: 'CANCEL_REQUESTED', cancelRequestedAt: this.now() },
            });
            await transaction.jrGovernanceEffectOutbox.upsert({
              where: {
                tenantId_eventId_actionId_kind: {
                  tenantId,
                  eventId: claimed.id,
                  actionId: claimed.action_id,
                  kind: 'REQUEST_RECONCILE',
                },
              },
              create: {
                id: randomUUID(),
                tenantId,
                eventId: claimed.id,
                actionId: claimed.action_id,
                actionKey: claimed.action_key,
                reservationId: claimed.reservation_id,
                deliveryId: action.deliveryId,
                providerRequestKey: action.providerRequestKey,
                correlationId: claimed.correlation_id,
                kind: 'REQUEST_RECONCILE',
                state: 'PENDING',
                availableAt: this.now(),
              },
              update: {},
            });
            return true;
          },
        );
        if (recovered) {
          await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
            transaction.jrGovernanceEffectOutbox.update({
              where: { id: claimed.id },
              data: { state: 'SUCCEEDED', completedAt: this.now(), lastError: 'barrier won' },
            }),
          );
          return 'SUCCEEDED';
        }
      }
      const message =
        error instanceof Error ? error.message.slice(0, 1_000) : 'unknown effect failure';
      await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.jrGovernanceEffectOutbox.update({
          where: { id: claimed.id },
          data: {
            state: 'PENDING',
            availableAt: new Date(this.now().getTime() + this.retryDelayMs),
            lastError: message,
          },
        }),
      );
      return 'RETRY';
    }
  }

  /** Used by the monitor loop to report commands waiting for reconcile without any identifier or PII. */
  async observeReconcileBacklog(tenantId: string): Promise<void> {
    const pending = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrGovernanceEffectOutbox.count({
        where: { tenantId, kind: 'REQUEST_RECONCILE', state: { in: ['PENDING', 'PROCESSING'] } },
      }),
    );
    this.metrics.observe('journey_cg3_reconcile_backlog', pending);
  }
}
