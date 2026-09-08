export interface EventIdempotencyKey {
  /** consumer group ทำให้ service คนละตัวประมวลผล event เดียวกันได้อย่างอิสระ */
  consumerGroup: string;
  tenantId: string;
  eventId: string;
}

export type IdempotencyResult = 'processed' | 'duplicate';

export type EventIdempotencyDurability = 'DURABLE' | 'EPHEMERAL';
export type EventConsumerRuntime = 'production' | 'non-production';

/**
 * Adapter นี้เป็น idempotency boundary ของ consumer
 * production adapter ต้องเก็บ unique (consumerGroup, tenantId, eventId) ในฐานข้อมูลของ service ตนเอง
 * และทำ work ใน callback กับการบันทึก key ให้ atomic เท่าที่ business operation ต้องการ
 */
export interface EventIdempotencyStore<TContext = undefined> {
  /**
   * adapter ใหม่ควรประกาศ DURABLE และทำ business effect กับ dedupe record
   * ใน transaction boundary เดียวกัน
   */
  readonly durability?: EventIdempotencyDurability;
  execute(
    key: EventIdempotencyKey,
    work: (context: TContext) => Promise<void>,
  ): Promise<IdempotencyResult>;
}

/** production ต้องใช้ adapter ที่ยืนยัน durable boundary อย่างชัดเจน. */
export function assertIdempotencyStoreAllowed<TContext>(
  store: EventIdempotencyStore<TContext>,
  runtime: EventConsumerRuntime,
): void {
  if (runtime === 'production' && store.durability !== 'DURABLE') {
    throw new Error(
      'production Kafka consumer ต้องใช้ EventIdempotencyStore ที่ประกาศ durability เป็น DURABLE',
    );
  }
}

function serializeKey(key: EventIdempotencyKey): string {
  return `${key.consumerGroup}\u0000${key.tenantId}\u0000${key.eventId}`;
}

/** ใช้สำหรับ dev/test หรือ consumer ที่ไม่มี side effect เท่านั้น; restart แล้วข้อมูลจะหาย */
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
