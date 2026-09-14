/**
 * J2.8 — relay `jr_owner_command_outbox` (J2.3) commands to the real Cases/
 * Dialer owner ports (J2.1/J2.4/J2.5/J2.6). Claims exactly one command per
 * call via `SKIP LOCKED` + a `PROCESSING` marker so a crash between claim and
 * settle leaves the row visible to the next worker instead of stuck forever;
 * the owner port call itself happens outside any Journey transaction per the
 * cross-owner boundary confirmed in #121/#123.
 */
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  tenantId as toTenantId,
  validateOwnerCommandPayload,
  type J2CaseOwnerPort,
  type J2DialerOwnerPort,
} from '@d-contact/cxa-contracts';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { noOpJourneyOwnerMetrics, type JourneyOwnerMetrics } from './journey-owner-metrics.js';

export interface JourneyOwnerCommandRelayOptions {
  now?: () => Date;
  retryDelayMs?: number;
  metrics?: JourneyOwnerMetrics;
}

export type JourneyOwnerCommandRelayResult = 'SENT' | 'RETRY' | undefined;

export class JourneyOwnerCommandRelay {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly actions: JourneyOwnerActionRepository;
  private readonly metrics: JourneyOwnerMetrics;

  constructor(
    private readonly database: PrismaClient,
    private readonly casePort: J2CaseOwnerPort,
    private readonly dialerPort: J2DialerOwnerPort,
    options: JourneyOwnerCommandRelayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.actions = new JourneyOwnerActionRepository(database);
    this.metrics = options.metrics ?? noOpJourneyOwnerMetrics;
  }

  /** relay ได้สูงสุดหนึ่ง command ต่อครั้ง; caller กำหนด polling/backoff เอง */
  async executeNext(tenantId: string): Promise<JourneyOwnerCommandRelayResult> {
    const claimed = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      async (transaction) => {
        const candidates = await transaction.$queryRaw<
          Array<{ id: string; command_id: string; payload: unknown }>
        >(Prisma.sql`
          SELECT id, command_id, payload
          FROM jr_owner_command_outbox
          WHERE tenant_id = ${tenantId}::uuid
            AND state = 'PENDING'
            AND payload IS NOT NULL
            AND available_at <= ${this.now()}
          ORDER BY available_at, created_at
          LIMIT 1
          FOR UPDATE SKIP LOCKED
        `);
        const row = candidates[0];
        if (!row) return undefined;
        await transaction.jrOwnerCommandOutbox.update({
          where: { id: row.id },
          data: { state: 'PROCESSING' },
        });
        return row;
      },
    );
    if (!claimed) return undefined;

    let payload: ReturnType<typeof validateOwnerCommandPayload>;
    try {
      payload = validateOwnerCommandPayload(claimed.payload);
    } catch (error) {
      await this.actions.markCommandFailed(
        tenantId,
        claimed.command_id,
        this.retryDelayMs,
        error instanceof Error ? error.message : 'invalid staged payload',
      );
      this.metrics.increment('journey_owner_command_dispatch_failed_total');
      return 'RETRY';
    }

    try {
      const tenant = toTenantId(tenantId);
      if (payload.commandType === 'ENSURE_CASE') {
        await this.casePort.persistCommand(tenant, payload);
      } else {
        await this.dialerPort.persistCommand(tenant, payload);
      }
      await this.actions.markCommandDispatched(tenantId, claimed.command_id);
      this.metrics.increment('journey_owner_command_dispatched_total');
      return 'SENT';
    } catch (error) {
      const message =
        error instanceof Error ? error.message.slice(0, 1_000) : 'unknown dispatch failure';
      await this.actions.markCommandFailed(
        tenantId,
        claimed.command_id,
        this.retryDelayMs,
        message,
      );
      this.metrics.increment('journey_owner_command_dispatch_failed_total');
      return 'RETRY';
    }
  }
}
