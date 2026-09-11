/**
 * Owner: Delivery/Channels — shared in-memory durable store ของ LINE simulation (S1.6)
 *
 * "durable" ในความหมายของ S1 คือ: state ทั้งหมดอยู่ในอินสแตนซ์นี้เดียว ไม่ใช่ private field
 * ของ `LineDeliveryPort` — restart จำลองได้โดยสร้าง `LineDeliveryPort` ใหม่ผูกกับ store
 * เดิม (ดู `line-delivery-port.ts`), แล้ว replay จาก event log กลับสู่ state เดิมทุกครั้ง
 * ไม่มี Prisma, ไม่มี process จริง — เป็นแค่ boundary ที่ทำให้ "restart" มีความหมายทดสอบได้
 */

export type LineDeliveryState =
  | 'QUEUED'
  | 'CLAIMED'
  | 'SUBMISSION_INTENT_RECORDED'
  | 'ACCEPTED'
  | 'PROVIDER_REJECTED'
  | 'TIMEOUT'
  | 'DELIVERED'
  | 'DELIVERY_FAILED'
  | 'UNKNOWN_RECONCILING'
  | 'SETTLED'
  | 'CANCELLED'
  | 'RELEASED';

export interface LineDeliveryRecord {
  tenantId: string;
  deliveryId: string;
  providerRequestKey: string;
  actionKey: string;
  reservationId: string;
  contactId: string;
  identityId?: string;
  senderIdentityId: string;
  purpose: string;
  contactKind: string;
  contentRef: string;
  correlationId: string;
  causationId?: string;
  inputHash: string;
  /** leaseVersion ของ reservation ตอน claim สำเร็จ — ใช้เป็น CAS ตอน beginProviderSubmission */
  leaseVersion: number;
  state: LineDeliveryState;
  outcome?: 'DELIVERED' | 'DELIVERY_FAILED' | 'PROVIDER_REJECTED' | 'UNKNOWN_RECONCILING';
  outcomeRef?: string;
  dryRun: boolean;
  createdAtMs: number;
  claimedAtMs?: number;
  submittedAtMs?: number;
  settledAtMs?: number;
  /**
   * true เมื่อเข้า UNKNOWN_RECONCILING หลังจาก provider เคย ACCEPTED แล้ว (Governance
   * confirm ไปแล้ว) — ตัดสินว่า reconcile นี้จบได้ด้วย DELIVERED/DELIVERY_FAILED เท่านั้น
   * ส่วน reconcile ที่ timeout ก่อนถึง ACCEPTED จบได้ด้วย PROVIDER_REJECTED เท่านั้น ตรงกับ
   * reservation state ฝั่ง Governance (CONFIRMED vs RESERVED) ที่ `settleDelivery` ยึดอยู่
   */
  reconcilingFromAccepted?: boolean;
}

export type LineCallbackOutcome =
  | 'ACCEPTED'
  | 'PROVIDER_REJECTED'
  | 'TIMEOUT'
  | 'DELIVERED'
  | 'DELIVERY_FAILED'
  | 'UNKNOWN_RECONCILING';

export interface LineCallbackEnvelope {
  tenantId: string;
  deliveryId: string;
  outcome: LineCallbackOutcome;
  atMs: number;
  sequence: number;
  outcomeRef: string;
}

export interface LineStoreEvent {
  seq: number;
  atMs: number;
  tenantId: string;
  deliveryId: string;
  type: string;
  detail: string;
}

/** key เดียวกันของ record/callback/event ต้องคงเดิมทุก restart เพื่อให้ replay ตรงกัน */
function recordKey(tenantId: string, deliveryId: string): string {
  return `${tenantId}:${deliveryId}`;
}

export class LineSimulationStore {
  private readonly records = new Map<string, LineDeliveryRecord>();
  private readonly byActionKey = new Map<string, string>();
  private readonly callbackQueue: LineCallbackEnvelope[] = [];
  private readonly deliveredOutcomeRefs = new Map<string, string>();
  private readonly events: LineStoreEvent[] = [];
  private eventSeq = 0;

  create(record: LineDeliveryRecord): void {
    this.records.set(recordKey(record.tenantId, record.deliveryId), structuredClone(record));
    this.byActionKey.set(`${record.tenantId}:${record.actionKey}`, record.deliveryId);
    this.appendEvent(
      record.tenantId,
      record.deliveryId,
      'CREATED',
      record.state,
      record.createdAtMs,
    );
  }

  get(tenantId: string, deliveryId: string): LineDeliveryRecord | undefined {
    const record = this.records.get(recordKey(tenantId, deliveryId));
    return record ? structuredClone(record) : undefined;
  }

  findByActionKey(tenantId: string, actionKey: string): LineDeliveryRecord | undefined {
    const deliveryId = this.byActionKey.get(`${tenantId}:${actionKey}`);
    return deliveryId ? this.get(tenantId, deliveryId) : undefined;
  }

  update(
    tenantId: string,
    deliveryId: string,
    patch: Partial<LineDeliveryRecord>,
    eventType: string,
    nowMs: number,
  ): LineDeliveryRecord {
    const key = recordKey(tenantId, deliveryId);
    const current = this.records.get(key);
    if (!current) throw new Error(`ไม่พบ LINE delivery record: ${key}`);
    const next = { ...current, ...patch };
    this.records.set(key, next);
    this.appendEvent(tenantId, deliveryId, eventType, next.state, nowMs);
    return structuredClone(next);
  }

  appendEvent(
    tenantId: string,
    deliveryId: string,
    type: string,
    detail: string,
    atMs: number,
  ): void {
    this.eventSeq += 1;
    this.events.push({ seq: this.eventSeq, atMs, tenantId, deliveryId, type, detail });
  }

  eventLog(): readonly LineStoreEvent[] {
    return this.events;
  }

  /** ใบใหม่ที่ outcomeRef ซ้ำกับใบก่อนหน้าเป็น no-op เดิม; payload ต่างเป็น conflict — ดู #102 §3 */
  recordOutcomeRef(
    scopeKey: string,
    outcomeRef: string,
    canonicalPayload: string,
  ): 'NEW' | 'DUPLICATE_NOOP' {
    const key = `${scopeKey}:${outcomeRef}`;
    const previous = this.deliveredOutcomeRefs.get(key);
    if (previous === undefined) {
      this.deliveredOutcomeRefs.set(key, canonicalPayload);
      return 'NEW';
    }
    if (previous === canonicalPayload) return 'DUPLICATE_NOOP';
    throw new OutcomeRefConflictError(outcomeRef);
  }

  enqueueCallback(envelope: LineCallbackEnvelope): void {
    this.callbackQueue.push(structuredClone(envelope));
  }

  /** ประมวลผลตาม (virtual timestamp, sequence) เสมอ ไม่ว่า test จะ enqueue ลำดับไหนก็ตาม */
  popNextDueCallback(nowMs: number): LineCallbackEnvelope | undefined {
    const dueIndexes = this.callbackQueue
      .map((envelope, index) => ({ envelope, index }))
      .filter(({ envelope }) => envelope.atMs <= nowMs);
    if (dueIndexes.length === 0) return undefined;
    dueIndexes.sort(
      (a, b) => a.envelope.atMs - b.envelope.atMs || a.envelope.sequence - b.envelope.sequence,
    );
    const [next] = dueIndexes;
    this.callbackQueue.splice(next.index, 1);
    return next.envelope;
  }

  pendingCallbackCount(): number {
    return this.callbackQueue.length;
  }
}

export class OutcomeRefConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor(readonly outcomeRef: string) {
    super(`outcomeRef ${outcomeRef} ถูกใช้กับ payload อื่นแล้ว`);
    this.name = 'OutcomeRefConflictError';
  }
}
