/**
 * Owner: Delivery/Channels — shared in-memory durable store of the LINE simulation (S1.6)
 *
 * "durable" in the S1 sense means: all state lives in this single instance, not in a private field
 * of `LineDeliveryPort` — a restart can be simulated by creating a new `LineDeliveryPort` bound to the same
 * store (see `line-delivery-port.ts`), then replaying from the event log back to the same state every time.
 * No Prisma, no real process — it is only a boundary that makes "restart" meaningful to test
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
  /** leaseVersion of the reservation at the successful claim — used as the CAS at beginProviderSubmission */
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
   * true when entering UNKNOWN_RECONCILING after the provider had already ACCEPTED (Governance
   * already confirmed) — decides that this reconcile can end only with DELIVERED/DELIVERY_FAILED,
   * while a reconcile that timed out before reaching ACCEPTED can end only with PROVIDER_REJECTED, matching the
   * reservation state on the Governance side (CONFIRMED vs RESERVED) that `settleDelivery` relies on
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

/** The same key of a record/callback/event must stay unchanged across every restart so replay matches */
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
    if (!current) throw new Error(`LINE delivery record not found: ${key}`);
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

  /** A new item whose outcomeRef repeats an earlier one is the same no-op; a different payload is a conflict — see #102 §3 */
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

  /** Process by (virtual timestamp, sequence) always, regardless of the order the test enqueued */
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
    super(`outcomeRef ${outcomeRef} was already used with a different payload`);
    this.name = 'OutcomeRefConflictError';
  }
}
