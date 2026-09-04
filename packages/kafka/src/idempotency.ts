export interface EventIdempotencyKey {
  /** consumer group ทำให้ service คนละตัวประมวลผล event เดียวกันได้อย่างอิสระ */
  consumerGroup: string;
  tenantId: string;
  eventId: string;
}

export type IdempotencyResult = 'processed' | 'duplicate';

/**
 * Adapter นี้เป็น idempotency boundary ของ consumer
 * production adapter ต้องเก็บ unique (consumerGroup, tenantId, eventId) ในฐานข้อมูลของ service ตนเอง
 * และทำ work ใน callback กับการบันทึก key ให้ atomic เท่าที่ business operation ต้องการ
 */
export interface EventIdempotencyStore {
  execute(key: EventIdempotencyKey, work: () => Promise<void>): Promise<IdempotencyResult>;
}

function serializeKey(key: EventIdempotencyKey): string {
  return `${key.consumerGroup}\u0000${key.tenantId}\u0000${key.eventId}`;
}

/** ใช้สำหรับ dev/test หรือ consumer ที่ไม่มี side effect เท่านั้น; restart แล้วข้อมูลจะหาย */
export function createInMemoryIdempotencyStore(): EventIdempotencyStore {
  const completed = new Set<string>();
  const inFlight = new Map<string, Promise<IdempotencyResult>>();

  return {
    async execute(key, work) {
      const serialized = serializeKey(key);
      if (completed.has(serialized)) return 'duplicate';

      const existing = inFlight.get(serialized);
      if (existing) {
        await existing;
        return 'duplicate';
      }

      const execution = (async (): Promise<IdempotencyResult> => {
        await work();
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
