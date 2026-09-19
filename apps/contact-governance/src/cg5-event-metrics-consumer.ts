import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  CG5_EMPTY_DIMENSIONS,
  CG5_GRANULARITIES,
  cg5DimensionKey,
  type Cg5Granularity,
  type Cg5MetricDimensions,
  type Cg5MetricKey,
} from '@d-contact/cxa-contracts';
import { validateCgEventPayloadV1 } from './cg3-persistence.js';
import {
  Cg4ConsumerInbox,
  type Cg4ConsumerInboxOptions,
  type Cg4InboundEvent,
  type Cg4ScopeRef,
} from './cg4-consumer-inbox.js';
import { parseCg4CanonicalEvent, type Cg4EnvelopeParse } from './cg4-event-envelope.js';

/** CG5.3 (#287): state-event metrics use CG4's inbox and write only projection buckets. */
export const CG5_EVENT_METRICS_CONSUMER_GROUP = 'cg5-event-metrics-v1';

const EVENT_METRICS: Readonly<Record<string, readonly Cg5MetricKey[]>> = Object.freeze({
  'preference.changed': ['cg.restriction', 'cg.audit'],
  'restriction.changed': ['cg.restriction', 'cg.audit'],
  'consent.changed': ['cg.consent', 'cg.audit'],
  'exception.changed': ['cg.exception', 'cg.audit'],
  'policy.changed': ['cg.policy.health', 'cg.audit'],
  'governance.kill-switch.changed': ['cg.policy.health', 'cg.audit'],
});

const CG4_ALIASES = new Set(['restriction.changed', 'consent.changed']);

function malformed(detail: string): Cg4EnvelopeParse {
  return { ok: false, reason: 'MALFORMED_PAYLOAD', detail };
}

/** CG3 preference events have their own versioned contract; no raw identity reaches a bucket. */
export function parseCg5MetricEvent(event: {
  eventType: string;
  payload: unknown;
}): Cg4EnvelopeParse {
  if (event.eventType === 'preference.changed') {
    try {
      const payload = validateCgEventPayloadV1(event.payload);
      return { ok: true, eventType: 'policy.changed', payload: payload as never };
    } catch (error) {
      return malformed(error instanceof Error ? error.message : 'payload ไม่ถูกต้อง');
    }
  }
  if (CG4_ALIASES.has(event.eventType)) {
    return parseCg4CanonicalEvent({ ...event, eventType: 'policy.changed' });
  }
  return parseCg4CanonicalEvent(event);
}

export function cg5MetricKeysForEvent(eventType: string): readonly Cg5MetricKey[] {
  return EVENT_METRICS[eventType] ?? [];
}

function dimensionsFor(payload: unknown): Cg5MetricDimensions {
  const scope = (payload as { affectedScope?: Record<string, unknown> } | null)?.affectedScope;
  return {
    ...CG5_EMPTY_DIMENSIONS,
    channel:
      typeof scope?.channel === 'string' ? (scope.channel as Cg5MetricDimensions['channel']) : null,
    purpose: typeof scope?.purpose === 'string' ? scope.purpose : null,
  };
}

function occurredAt(event: Cg4InboundEvent): Date {
  const effectiveAt = (event.payload as { effectiveAt?: unknown } | null)?.effectiveAt;
  if (typeof effectiveAt === 'string') {
    const parsed = new Date(effectiveAt);
    if (!Number.isNaN(parsed.valueOf())) return parsed;
  }
  return event.receivedAt;
}

export function cg5BucketStart(date: Date, granularity: Cg5Granularity): Date {
  const milliseconds = { FIVE_MIN: 300_000, HOUR: 3_600_000, DAY: 86_400_000 }[granularity];
  return new Date(Math.floor(date.valueOf() / milliseconds) * milliseconds);
}

async function incrementBuckets(
  transaction: Prisma.TransactionClient,
  event: Cg4InboundEvent,
): Promise<void> {
  const dimensions = dimensionsFor(event.payload);
  const dimensionKey = cg5DimensionKey(dimensions);
  const timestamp = occurredAt(event);
  const metrics = cg5MetricKeysForEvent(event.eventType);

  for (const metricKey of metrics) {
    for (const granularity of CG5_GRANULARITIES) {
      const bucketStart = cg5BucketStart(timestamp, granularity);
      await transaction.cg5MetricBucket.upsert({
        where: {
          tenantId_metricKey_granularity_bucketStart_dimensionKey: {
            tenantId: event.tenantId,
            metricKey,
            granularity,
            bucketStart,
            dimensionKey,
          },
        },
        create: {
          tenantId: event.tenantId,
          metricKey,
          granularity,
          bucketStart,
          ...dimensions,
          dimensionKey,
          value: new Prisma.Decimal(1),
          sampleCount: 1n,
          updatedAt: timestamp,
        },
        update: {
          value: { increment: new Prisma.Decimal(1) },
          sampleCount: { increment: 1n },
          updatedAt: timestamp,
        },
      });
    }
  }
}

export interface Cg5EventMetricsConsumerOptions {
  consumerGroup?: string;
  id?: Cg4ConsumerInboxOptions['id'];
  now?: Cg4ConsumerInboxOptions['now'];
}

export class Cg5EventMetricsConsumer {
  private readonly inbox: Cg4ConsumerInbox;

  constructor(database: PrismaClient, options: Cg5EventMetricsConsumerOptions = {}) {
    this.inbox = new Cg4ConsumerInbox(
      database,
      options.consumerGroup ?? CG5_EVENT_METRICS_CONSUMER_GROUP,
      {
        ...(options.id ? { id: options.id } : {}),
        ...(options.now ? { now: options.now } : {}),
        parse: parseCg5MetricEvent,
      },
    );
  }

  consume(event: Cg4InboundEvent) {
    return this.inbox.record(event, incrementBuckets);
  }

  isPaused(tenantId: string, scope: Cg4ScopeRef) {
    return this.inbox.isPaused(tenantId, scope);
  }

  activePauses(tenantId: string) {
    return this.inbox.activePauses(tenantId);
  }
}
