import { randomUUID } from 'node:crypto';
import {
  Prisma,
  withTenantDatabaseTransaction,
  type CgAggregateType,
  type CgInboxState,
  type CgScopePauseKind,
  type CgScopePauseReason,
  type PrismaClient,
} from '@d-contact/db';
import { parseCg4CanonicalEvent } from './cg4-event-envelope.js';
import {
  cg4InboxDecisionPausesScope,
  cg4PauseReasonFor,
  classifyCg4InboundEvent,
  type Cg4InboxCursor,
  type Cg4InboxDecision,
} from './cg4-inbox.js';

/**
 * CG4.6 (#189): the consumer-side inbox from #179 §4.
 *
 * The inbox is the projection and the completion record at once — rows are insert-only,
 * and the cursor for a consumer group is simply its highest APPLIED version for that
 * aggregate. Anything that is not a clean, contiguous apply opens a scope pause, and the
 * pause is what makes a reader fail closed for that exact scope instead of serving a
 * projection built on a hole.
 */

const INBOX_STATE: Readonly<Record<Cg4InboxDecision['kind'], CgInboxState>> = Object.freeze({
  APPLY: 'APPLIED',
  DUPLICATE: 'DUPLICATE',
  GAP: 'GAP_HELD',
  OUT_OF_ORDER: 'OUT_OF_ORDER',
  QUARANTINE: 'QUARANTINED',
  UNSUPPORTED: 'UNSUPPORTED',
});

function detailOf(decision: Cg4InboxDecision): string | undefined {
  switch (decision.kind) {
    case 'GAP':
      return `คาด version ${decision.expectedVersion} แต่ได้รับ ${decision.receivedVersion}`;
    case 'OUT_OF_ORDER':
      return `apply ถึง version ${decision.appliedVersion} แล้ว แต่ได้รับ ${decision.receivedVersion}`;
    case 'QUARANTINE':
      return decision.detail;
    case 'UNSUPPORTED':
      return `${decision.reason}: ${decision.detail}`;
    default:
      return undefined;
  }
}

export interface Cg4InboundEvent {
  tenantId: string;
  eventId: string;
  eventType: string;
  aggregateType: CgAggregateType;
  aggregateId: string;
  aggregateVersion: number;
  payloadHash: string;
  payload: unknown;
  receivedAt: Date;
}

export interface Cg4InboxOutcome {
  decision: Cg4InboxDecision;
  /** False when the eventId was already recorded — nothing was re-evaluated. */
  recorded: boolean;
  inboxId: string;
  pauseId?: string;
  /** True when this event applied cleanly and the projection may advance. */
  applied: boolean;
}

export interface Cg4ScopeRef {
  kind: CgScopePauseKind;
  ref: string;
}

/**
 * A contact aggregate pauses by contact id; a policy aggregate pauses by the scope key
 * carried in the payload, because that is the unit a reader resolves against — pausing a
 * whole policy series would hold scopes the anomaly never touched.
 */
export function cg4ScopeRefFor(event: {
  aggregateType: CgAggregateType;
  aggregateId: string;
  payload: unknown;
}): Cg4ScopeRef {
  if (event.aggregateType === 'CONTACT') return { kind: 'CONTACT', ref: event.aggregateId };
  const scopeKey = (event.payload as { affectedScope?: { scopeKey?: unknown } } | null)
    ?.affectedScope?.scopeKey;
  return {
    kind: 'POLICY_SCOPE',
    ref: typeof scopeKey === 'string' && scopeKey ? scopeKey : event.aggregateId,
  };
}

export interface Cg4ConsumerInboxOptions {
  id?: () => string;
  now?: () => Date;
}

export class Cg4ConsumerInbox {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly consumerGroup: string,
    options: Cg4ConsumerInboxOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Records one inbound event and returns what the consumer should do with it. The whole
   * decision runs inside one tenant transaction under an advisory lock on the aggregate,
   * so two partitions delivering neighbouring versions concurrently cannot both read the
   * same cursor and both decide they are contiguous.
   */
  async record(event: Cg4InboundEvent): Promise<Cg4InboxOutcome> {
    return withTenantDatabaseTransaction(this.database, event.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cg4-inbox:${this.consumerGroup}:${event.tenantId}:${event.aggregateId}`}))`,
      );

      const existing = await transaction.cgConsumerInbox.findUnique({
        where: {
          tenantId_consumerGroup_eventId: {
            tenantId: event.tenantId,
            consumerGroup: this.consumerGroup,
            eventId: event.eventId,
          },
        },
      });
      if (existing) {
        // Redelivery of an event already seen. It never reaches the version comparison,
        // so at-least-once delivery can never look like an ordering anomaly.
        return {
          decision: { kind: 'DUPLICATE' } as Cg4InboxDecision,
          recorded: false,
          inboxId: existing.id,
          applied: existing.state === 'APPLIED',
        };
      }

      const applied = await transaction.cgConsumerInbox.findFirst({
        where: {
          tenantId: event.tenantId,
          consumerGroup: this.consumerGroup,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          state: 'APPLIED',
        },
        orderBy: { aggregateVersion: 'desc' },
      });
      const cursor: Cg4InboxCursor | undefined = applied
        ? { aggregateVersion: applied.aggregateVersion, payloadHash: applied.payloadHash }
        : undefined;

      const decision = classifyCg4InboundEvent({
        ...(cursor ? { cursor } : {}),
        incoming: {
          aggregateVersion: event.aggregateVersion,
          payloadHash: event.payloadHash,
        },
        parse: parseCg4CanonicalEvent({ eventType: event.eventType, payload: event.payload }),
      });

      const inboxId = this.id();
      await transaction.cgConsumerInbox.create({
        data: {
          id: inboxId,
          tenantId: event.tenantId,
          consumerGroup: this.consumerGroup,
          eventId: event.eventId,
          aggregateType: event.aggregateType,
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion,
          eventType: event.eventType,
          payloadHash: event.payloadHash,
          state: INBOX_STATE[decision.kind],
          ...(detailOf(decision) ? { detail: detailOf(decision) } : {}),
          receivedAt: event.receivedAt,
        },
      });

      let pauseId: string | undefined;
      if (cg4InboxDecisionPausesScope(decision)) {
        const reason = cg4PauseReasonFor(decision) as CgScopePauseReason;
        pauseId = await this.pauseScope(transaction, {
          tenantId: event.tenantId,
          scope: cg4ScopeRefFor(event),
          reason,
          ...(detailOf(decision) ? { detail: detailOf(decision) as string } : {}),
          eventId: event.eventId,
          observedVersion: event.aggregateVersion,
          ...(decision.kind === 'GAP' ? { expectedVersion: decision.expectedVersion } : {}),
        });
      }

      return {
        decision,
        recorded: true,
        inboxId,
        ...(pauseId ? { pauseId } : {}),
        applied: decision.kind === 'APPLY',
      };
    });
  }

  private async pauseScope(
    transaction: Prisma.TransactionClient,
    input: {
      tenantId: string;
      scope: Cg4ScopeRef;
      reason: CgScopePauseReason;
      detail?: string;
      eventId?: string;
      observedVersion?: number;
      expectedVersion?: number;
    },
  ): Promise<string> {
    const open = await transaction.cgScopePause.findFirst({
      where: {
        tenantId: input.tenantId,
        consumerGroup: this.consumerGroup,
        scopeKind: input.scope.kind,
        scopeRef: input.scope.ref,
        state: 'ACTIVE',
      },
    });
    if (open) {
      // A second anomaly on an already-held scope refreshes the reason rather than
      // stacking another hold: the scope is equally unusable either way.
      await transaction.cgScopePause.update({
        where: { id: open.id },
        data: {
          reason: input.reason,
          ...(input.detail ? { detail: input.detail } : {}),
          ...(input.eventId ? { eventId: input.eventId } : {}),
          ...(input.observedVersion !== undefined
            ? { observedVersion: input.observedVersion }
            : {}),
          ...(input.expectedVersion !== undefined
            ? { expectedVersion: input.expectedVersion }
            : {}),
        },
      });
      return open.id;
    }
    const created = await transaction.cgScopePause.create({
      data: {
        id: this.id(),
        tenantId: input.tenantId,
        consumerGroup: this.consumerGroup,
        scopeKind: input.scope.kind,
        scopeRef: input.scope.ref,
        state: 'ACTIVE',
        reason: input.reason,
        ...(input.detail ? { detail: input.detail } : {}),
        ...(input.eventId ? { eventId: input.eventId } : {}),
        ...(input.observedVersion !== undefined ? { observedVersion: input.observedVersion } : {}),
        ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
        pausedAt: this.now(),
      },
    });
    return created.id;
  }

  /** True while this consumer group must fail closed for the scope (#176 §5). */
  async isPaused(tenantId: string, scope: Cg4ScopeRef): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const open = await transaction.cgScopePause.findFirst({
        where: {
          tenantId,
          consumerGroup: this.consumerGroup,
          scopeKind: scope.kind,
          scopeRef: scope.ref,
          state: 'ACTIVE',
        },
        select: { id: true },
      });
      return open !== null;
    });
  }

  async activePauses(tenantId: string) {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.cgScopePause.findMany({
        where: { tenantId, consumerGroup: this.consumerGroup, state: 'ACTIVE' },
        orderBy: { pausedAt: 'asc' },
      }),
    );
  }

  /**
   * Clears a hold after the consumer reloaded canonical state for the scope. The reloaded
   * version is written into the inbox as an APPLIED row so the cursor jumps forward — a
   * pause cleared without moving the cursor would re-open on the very next event.
   */
  async resumeFromCanonical(input: {
    tenantId: string;
    scope: Cg4ScopeRef;
    aggregateType: CgAggregateType;
    aggregateId: string;
    canonicalVersion: number;
    canonicalDigest: string;
    eventType: string;
  }): Promise<{ cleared: number; cursorVersion: number }> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cg4-inbox:${this.consumerGroup}:${input.tenantId}:${input.aggregateId}`}))`,
      );
      const now = this.now();
      const existing = await transaction.cgConsumerInbox.findFirst({
        where: {
          tenantId: input.tenantId,
          consumerGroup: this.consumerGroup,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          aggregateVersion: input.canonicalVersion,
          state: 'APPLIED',
        },
        select: { id: true },
      });
      if (!existing) {
        await transaction.cgConsumerInbox.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            consumerGroup: this.consumerGroup,
            // A reload is not a delivered event, so it gets its own synthetic id rather
            // than borrowing one — the eventId key stays a delivery fact.
            eventId: this.id(),
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            aggregateVersion: input.canonicalVersion,
            eventType: input.eventType,
            payloadHash: input.canonicalDigest,
            state: 'APPLIED',
            detail: 'canonical reload',
            receivedAt: now,
          },
        });
      }
      const cleared = await transaction.cgScopePause.updateMany({
        where: {
          tenantId: input.tenantId,
          consumerGroup: this.consumerGroup,
          scopeKind: input.scope.kind,
          scopeRef: input.scope.ref,
          state: 'ACTIVE',
        },
        data: { state: 'CLEARED', clearedAt: now, clearedToVersion: input.canonicalVersion },
      });
      return { cleared: cleared.count, cursorVersion: input.canonicalVersion };
    });
  }
}
