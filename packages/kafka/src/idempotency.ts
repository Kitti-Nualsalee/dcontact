export interface EventIdempotencyKey {
  /** the consumer group lets different services process the same event independently */
  consumerGroup: string;
  tenantId: string;
  eventId: string;
}

export type IdempotencyResult = 'processed' | 'duplicate';

export type EventIdempotencyDurability = 'DURABLE' | 'EPHEMERAL';
export type EventConsumerRuntime = 'production' | 'non-production';

/**
 * This adapter is the consumer's idempotency boundary.
 * A production adapter must keep a unique (consumerGroup, tenantId, eventId) in the service's own database
 * and make the work in the callback and the key recording atomic as far as the business operation requires.
 */
export interface EventIdempotencyStore<TContext = undefined> {
  /**
   * a new adapter should declare DURABLE and perform the business effect together with the dedupe record
   * in the same transaction boundary
   */
  readonly durability?: EventIdempotencyDurability;
  execute(
    key: EventIdempotencyKey,
    work: (context: TContext) => Promise<void>,
  ): Promise<IdempotencyResult>;
}

/** production must use an adapter that explicitly confirms a durable boundary. */
export function assertIdempotencyStoreAllowed<TContext>(
  store: EventIdempotencyStore<TContext>,
  runtime: EventConsumerRuntime,
): void {
  if (runtime === 'production' && store.durability !== 'DURABLE') {
    throw new Error(
      'production Kafka consumer must use an EventIdempotencyStore whose durability is DURABLE',
    );
  }
}

function serializeKey(key: EventIdempotencyKey): string {
  return `${key.consumerGroup}\u0000${key.tenantId}\u0000${key.eventId}`;
}

/** for dev/test or consumers without side effects only; the data is lost on restart */
export function createInMemoryIdempotencyStore(): EventIdempotencyStore {
  const completed = new Set<string>();
  const inFlight = new Map<string, Promise<IdempotencyResult>>();

  return {
    durability: 'EPHEMERAL',
    async execute(key, work) {
      const serialized = serializeKey(key);
      if (completed.has(serialized)) return 'duplicate';

      const existing = inFlight.get(serialized);
      if (existing) {
        await existing;
        return 'duplicate';
      }

      const execution = (async (): Promise<IdempotencyResult> => {
        await work(undefined);
        completed.add(serialized);
        return 'processed';
      })();
      inFlight.set(serialized, execution);

      try {
        return await execution;
      } finally {
        inFlight.delete(serialized);
      }
    },
  };
}
