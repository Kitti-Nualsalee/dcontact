/**
 * Owner: Channels/Dialer — durable test adapter ของ DeliveryPort (C1.3)
 *
 * ขอบเขต C1: ไม่มี provider credential, ไม่มี network I/O และไม่มี traffic จริง
 * adapter ถือ durable outbox เป็นของตัวเอง ส่วน reservation, Attempt และ Touch ยังเป็น
 * ของ Governance ทั้งหมด — ที่นี่ไม่เคยเขียน state เหล่านั้นเองและไม่ import
 * contact-governance โดยตรง มีแต่ `ContactGovernancePort` ที่ถูก inject เข้ามา
 *
 * ลำดับที่ห้ามสลับ:
 *   1. claim ผ่าน Governance ก่อน แล้วจึง persist outbox ก่อนตอบ QUEUED
 *   2. beginProviderSubmission (durable barrier) ก่อนแตะ transport เสมอ
 *   3. หลัง barrier ห้าม release/refund/blind retry — timeout ต้องไป reconcile
 */
import { randomUUID, createHash } from 'node:crypto';
import type { DlOutboxEntry, PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  outcomeRef as toOutcomeRef,
  providerRequestKey as toProviderRequestKey,
  reservationId as toReservationId,
  tenantId as toTenantId,
  ReservationBindingError,
  type ContactGovernancePort,
  type DeliveryEnqueueErrorCode,
  type DeliveryPort,
  type EnqueueDeliveryCommand,
  type EnqueueDeliveryResult,
  type NormalizedDeliveryOutcome,
} from '@d-contact/cxa-contracts';
import {
  assertOpaqueContentRef,
  canonicalInputHash,
  deliveryEvidence,
  mintOpaqueKey,
  type DeliveryEvidence,
} from './evidence.js';
import {
  OutboxEntryAlreadyExistsError,
  OutboxRepository,
  type CreateOutboxEntryInput,
} from './outbox-repository.js';
import { TEST_ADAPTER, ScriptedTestTransport, type DeliveryTransport } from './test-transport.js';

/** code ที่ `enqueue` ห้ามคืน — ถ้าโผล่มาแปลว่า Governance เปลี่ยนสัญญา ต้อง fail closed */
const ENQUEUE_FORBIDDEN_CODES = new Set([
  'STALE_RESERVATION_LEASE',
  'DELIVERY_RECONCILIATION_REQUIRED',
  'INVALID_RESERVATION_TRANSITION',
]);

export interface DeliveryTestAdapterOptions {
  now?: () => Date;
  id?: () => string;
  transport?: DeliveryTransport;
}

export interface DeliveryWorkItem {
  tenantId: string;
  deliveryId: string;
  correlationId: string;
}

export type DeliverySubmissionResult =
  | { status: 'SUBMITTED'; evidence: DeliveryEvidence }
  | { status: 'SETTLED'; evidence: DeliveryEvidence }
  | { status: 'RECONCILE_REQUIRED'; evidence: DeliveryEvidence }
  | { status: 'BLOCKED'; code: string; evidence: DeliveryEvidence };

export interface RecordOutcomeInput extends DeliveryWorkItem {
  outcome: Exclude<NormalizedDeliveryOutcome, 'UNKNOWN_RECONCILING'>;
  outcomeRef: string;
  occurredAt: string;
}

export class DeliveryNotFoundError extends Error {
  readonly code = 'DELIVERY_NOT_FOUND';

  constructor(readonly deliveryId: string) {
    super(`ไม่พบ delivery ${deliveryId} ใน outbox`);
    this.name = 'DeliveryNotFoundError';
  }
}

function outcomeRefFor(providerRequestKey: string, reason: string): string {
  const digest = createHash('sha256').update([providerRequestKey, reason].join('|')).digest('hex');
  return `ocr_${digest.slice(0, 32)}`;
}

export class DeliveryTestAdapter implements DeliveryPort {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly transport: DeliveryTransport;
  private readonly outbox: OutboxRepository;

  constructor(
    database: PrismaClient,
    private readonly governance: ContactGovernancePort,
    options: DeliveryTestAdapterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.transport = options.transport ?? new ScriptedTestTransport();
    this.outbox = new OutboxRepository(database);
  }

  /**
   * duplicate ที่ commit แล้วจะ replay delivery เดิม ส่วน duplicate ที่ยังบินอยู่พร้อมกัน
   * จะแพ้ unique index แล้วได้ IDEMPOTENCY_CONFLICT ตามสัญญาของ #67 — ผู้เรียกที่ลอง
   * ใหม่หลังจากนั้นจะได้ replay ปกติ
   */
  async enqueue(command: EnqueueDeliveryCommand): Promise<EnqueueDeliveryResult> {
    assertOpaqueContentRef(command.contentRef);
    const inputHash = canonicalInputHash({ ...command });

    const existing = await this.outbox.findByActionKey(command.tenantId, command.actionKey);
    if (existing) return this.replay(existing, inputHash);

    const mintedDeliveryId = mintOpaqueKey(
      'delivery',
      command.tenantId,
      command.actionKey,
      inputHash,
    );
    const mintedProviderRequestKey = mintOpaqueKey(
      'provider-request',
      command.tenantId,
      command.actionKey,
      inputHash,
    );

    let leaseVersion: number;
    try {
      const claimed = await this.governance.claimReservationForDelivery({
        tenantId: command.tenantId,
        correlationId: command.correlationId,
        reservationId: command.reservationId,
        actionKey: command.actionKey,
        deliveryId: toDeliveryId(mintedDeliveryId),
        contactId: command.contactId,
        ...(command.identityId ? { identityId: command.identityId } : {}),
        channel: command.channel,
        purpose: command.purpose,
        senderIdentityId: command.senderIdentityId,
        leaseExpiresAt: command.leaseExpiresAt,
      });
      leaseVersion = claimed.leaseVersion ?? 1;
    } catch (error) {
      if (!(error instanceof ReservationBindingError)) throw error;
      if (ENQUEUE_FORBIDDEN_CODES.has(error.code)) throw error;
      return { status: 'ERROR', code: error.code as DeliveryEnqueueErrorCode };
    }

    const entry: CreateOutboxEntryInput = {
      id: this.id(),
      tenantId: command.tenantId,
      actionKey: command.actionKey,
      reservationId: command.reservationId,
      deliveryId: mintedDeliveryId,
      providerRequestKey: mintedProviderRequestKey,
      channel: command.channel,
      contactId: command.contactId,
      ...(command.identityId ? { identityId: command.identityId } : {}),
      purpose: command.purpose,
      source: command.source,
      senderIdentityId: command.senderIdentityId,
      contentRef: command.contentRef,
      inputHash,
      leaseVersion,
      leaseExpiresAt: new Date(command.leaseExpiresAt),
      correlationId: command.correlationId,
      ...(command.causationId ? { causationId: command.causationId } : {}),
    };

    try {
      await this.outbox.create(entry);
    } catch (error) {
      if (!(error instanceof OutboxEntryAlreadyExistsError)) throw error;
      return { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
    }

    return {
      status: 'QUEUED',
      deliveryId: toDeliveryId(mintedDeliveryId),
      providerRequestKey: toProviderRequestKey(mintedProviderRequestKey),
    };
  }

  private replay(entry: DlOutboxEntry, inputHash: string): EnqueueDeliveryResult {
    if (entry.inputHash !== inputHash) return { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
    return {
      status: 'QUEUED',
      deliveryId: toDeliveryId(entry.deliveryId),
      providerRequestKey: toProviderRequestKey(entry.providerRequestKey),
    };
  }

  private async require(tenantId: string, deliveryId: string): Promise<DlOutboxEntry> {
    const entry = await this.outbox.findByDeliveryId(tenantId, deliveryId);
    if (!entry) throw new DeliveryNotFoundError(deliveryId);
    return entry;
  }

  private governanceCommand(entry: DlOutboxEntry, correlationId: string) {
    return {
      tenantId: toTenantId(entry.tenantId),
      correlationId,
      reservationId: toReservationId(entry.reservationId),
      actionKey: toActionKey(entry.actionKey),
      deliveryId: toDeliveryId(entry.deliveryId),
    };
  }

  /**
   * ขั้นตอนที่แตะ transport ได้ขั้นเดียว แถวที่อยู่ใน SUBMITTING แปลว่าเคยผ่าน barrier
   * และอาจส่งไปแล้ว — ห้ามส่งซ้ำเด็ดขาด ต้องไป reconcile อย่างเดียว
   */
  async submit(work: DeliveryWorkItem): Promise<DeliverySubmissionResult> {
    const entry = await this.require(work.tenantId, work.deliveryId);
    if (entry.state === 'SUBMITTED')
      return { status: 'SUBMITTED', evidence: deliveryEvidence(entry) };
    if (entry.state === 'SETTLED') return { status: 'SETTLED', evidence: deliveryEvidence(entry) };
    if (entry.state === 'SUBMITTING' || entry.state === 'RECONCILING') {
      return { status: 'RECONCILE_REQUIRED', evidence: deliveryEvidence(entry) };
    }

    try {
      await this.governance.beginProviderSubmission({
        ...this.governanceCommand(entry, work.correlationId),
        expectedLeaseVersion: entry.leaseVersion,
        providerRequestKey: toProviderRequestKey(entry.providerRequestKey),
      });
    } catch (error) {
      if (!(error instanceof ReservationBindingError)) throw error;
      if (error.code === 'DELIVERY_RECONCILIATION_REQUIRED') {
        const reconciling = await this.markReconciling(entry, work.correlationId);
        return { status: 'RECONCILE_REQUIRED', evidence: deliveryEvidence(reconciling) };
      }
      return { status: 'BLOCKED', code: error.code, evidence: deliveryEvidence(entry) };
    }

    // barrier ผ่านแล้ว: บันทึกก่อนแตะ transport เพื่อให้ crash ระหว่างส่งยังอ่านเจอว่า
    // งานนี้ "อาจส่งไปแล้ว" แทนที่จะดูเหมือนงานที่ยังไม่เริ่ม
    const submitting = await this.outbox.advance(entry.tenantId, entry.deliveryId, ['QUEUED'], {
      state: 'SUBMITTING',
      submittedAt: this.now(),
    });
    if (!submitting) {
      const current = await this.require(work.tenantId, work.deliveryId);
      return { status: 'RECONCILE_REQUIRED', evidence: deliveryEvidence(current) };
    }

    const response = await this.transport.submit({
      adapter: TEST_ADAPTER,
      deliveryId: submitting.deliveryId,
      providerRequestKey: submitting.providerRequestKey,
      channel: submitting.channel,
      contentRef: submitting.contentRef,
    });

    if (response.status === 'ACCEPTED') {
      await this.governance.confirmProviderAcceptance({
        ...this.governanceCommand(submitting, work.correlationId),
        providerRequestKey: toProviderRequestKey(submitting.providerRequestKey),
      });
      const accepted = await this.outbox.advance(
        submitting.tenantId,
        submitting.deliveryId,
        ['SUBMITTING'],
        { state: 'SUBMITTED' },
      );
      return {
        status: 'SUBMITTED',
        evidence: deliveryEvidence(accepted ?? submitting),
      };
    }

    if (response.status === 'REJECTED') {
      const settled = await this.settle(submitting, work.correlationId, {
        outcome: 'PROVIDER_REJECTED',
        outcomeRef: outcomeRefFor(submitting.providerRequestKey, response.reasonCode),
        occurredAt: this.now().toISOString(),
      });
      return { status: 'SETTLED', evidence: deliveryEvidence(settled) };
    }

    const reconciling = await this.markReconciling(submitting, work.correlationId);
    return { status: 'RECONCILE_REQUIRED', evidence: deliveryEvidence(reconciling) };
  }

  /**
   * ผลลัพธ์ที่ normalize แล้วจาก provider หนึ่งใบต่อหนึ่ง outcomeRef; terminal outcome
   * แรกชนะ ใบที่มาทีหลังคืน snapshot เดิมโดยไม่ settle ซ้ำและไม่สร้าง Attempt/Touch เพิ่ม
   */
  async recordOutcome(input: RecordOutcomeInput): Promise<DeliveryEvidence> {
    const entry = await this.require(input.tenantId, input.deliveryId);
    if (entry.state === 'SETTLED') return deliveryEvidence(entry);
    if (entry.state === 'QUEUED') {
      throw new ReservationBindingError('INVALID_RESERVATION_TRANSITION');
    }
    const settled = await this.settle(entry, input.correlationId, {
      outcome: input.outcome,
      outcomeRef: input.outcomeRef,
      occurredAt: input.occurredAt,
    });
    return deliveryEvidence(settled);
  }

  private async settle(
    entry: DlOutboxEntry,
    correlationId: string,
    outcome: {
      outcome: Exclude<NormalizedDeliveryOutcome, 'UNKNOWN_RECONCILING'>;
      outcomeRef: string;
      occurredAt: string;
    },
  ): Promise<DlOutboxEntry> {
    await this.governance.settleDelivery({
      ...this.governanceCommand(entry, correlationId),
      providerRequestKey: toProviderRequestKey(entry.providerRequestKey),
      outcomeRef: toOutcomeRef(outcome.outcomeRef),
      outcome: outcome.outcome,
      occurredAt: outcome.occurredAt,
    });
    const settled = await this.outbox.advance(
      entry.tenantId,
      entry.deliveryId,
      ['SUBMITTING', 'SUBMITTED', 'RECONCILING'],
      {
        state: 'SETTLED',
        outcome: outcome.outcome,
        outcomeRef: outcome.outcomeRef,
        settledAt: this.now(),
      },
    );
    return settled ?? this.require(entry.tenantId, entry.deliveryId);
  }

  private async markReconciling(
    entry: DlOutboxEntry,
    correlationId: string,
  ): Promise<DlOutboxEntry> {
    // outcomeRef และ occurredAt ของ reconcile ต้องคงที่ต่อ delivery: sweeper รันซ้ำได้
    // ทุกกี่รอบก็ยังเป็น replay ของ settle ใบเดิม ไม่ใช่ใบใหม่ที่ input ไม่ตรงกัน
    await this.governance.settleDelivery({
      ...this.governanceCommand(entry, correlationId),
      providerRequestKey: toProviderRequestKey(entry.providerRequestKey),
      outcomeRef: toOutcomeRef(outcomeRefFor(entry.providerRequestKey, 'reconcile')),
      outcome: 'UNKNOWN_RECONCILING',
      occurredAt: (entry.submittedAt ?? entry.leaseExpiresAt).toISOString(),
    });
    const reconciling = await this.outbox.advance(
      entry.tenantId,
      entry.deliveryId,
      ['QUEUED', 'SUBMITTING', 'SUBMITTED'],
      { state: 'RECONCILING' },
    );
    return reconciling ?? this.require(entry.tenantId, entry.deliveryId);
  }

  /**
   * งานที่ผ่าน barrier แล้วแต่ lease หมดโดยไม่มีผล — รายงาน UNKNOWN_RECONCILING
   * เข้าหา Governance ห้าม release, refund หรือส่งใหม่
   */
  async reconcileExpired(tenantId: string, correlationId: string): Promise<DeliveryEvidence[]> {
    const stale = await this.outbox.findReconcilable(tenantId, this.now());
    const evidence: DeliveryEvidence[] = [];
    for (const entry of stale) {
      evidence.push(deliveryEvidence(await this.markReconciling(entry, correlationId)));
    }
    return evidence;
  }

  /** view สำหรับ test/evidence — ไม่เคยคืน contentRef หรือ binding ที่เป็น PII boundary */
  async evidenceFor(tenantId: string, deliveryId: string): Promise<DeliveryEvidence> {
    return deliveryEvidence(await this.require(tenantId, deliveryId));
  }
}
