import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgAggregateType,
  type CgConsumerAckOutcome,
  type ObAttemptRealtimeState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import {
  actionKey as toActionKey,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactChannel,
  type ContactGovernancePort,
  type ContactGovernanceRevalidationPort,
} from '@d-contact/cxa-contracts';

const CONTACT_EVENTS = new Set(['restriction.changed', 'consent.changed', 'preference.changed']);
const ACTIVE_STATES: ObAttemptRealtimeState[] = [
  'QUEUED',
  'RESERVED',
  'PRE_BARRIER',
  'POST_BARRIER',
  'ACCEPTED',
  'IN_PROGRESS',
  'CANCEL_REQUESTED',
];
const PRE_BARRIER_STATES = new Set<ObAttemptRealtimeState>(['QUEUED', 'RESERVED', 'PRE_BARRIER']);
const POST_BARRIER_STATES = new Set<ObAttemptRealtimeState>([
  'POST_BARRIER',
  'ACCEPTED',
  'CANCEL_REQUESTED',
]);

export interface DialerCg3EventPayloadV1 {
  contractVersion: 1;
  mutationId: string;
  subjectVersion: number;
  affectedScope: {
    identityId: string | null;
    channel: ContactChannel | null;
    purpose: string | null;
    contactKind: string | null;
  };
  effectiveAt: string;
  policyVersion?: number;
  stateDigest: string;
}

export type DialerRevalidationDecision =
  | { decision: 'ALLOW' }
  | { decision: 'BLOCK'; reasonCode: string }
  | { decision: 'DEFER'; reasonCode: string; nextEligibleAt: string }
  | { decision: 'TIMEZONE_UNKNOWN'; reasonCode: string }
  | { decision: 'REVIEW'; reasonCode: string };

export interface DialerRealtimeAttempt {
  id: string;
  tenantId: string;
  actionKey: string;
  contactId: string;
  identityId: string;
  channel: ContactChannel;
  purpose: string;
  reservationId: string | null;
  realtimeState: ObAttemptRealtimeState;
  deliveryId: string | null;
  providerRequestKey: string | null;
}

/** Dialer อ่าน canonical แบบแคบจาก Governance และไม่สร้าง decision หรือ reservation ซ้ำเอง. */
export interface DialerCanonicalRevalidator {
  revalidate(input: {
    tenantId: string;
    attempt: DialerRealtimeAttempt;
    event: DialerCg3EventPayloadV1;
    source: {
      aggregateType: 'CONTACT' | 'POLICY';
      aggregateId: string;
      aggregateVersion: number;
      correlationId: string;
    };
  }): Promise<DialerRevalidationDecision>;
}

export function createDialerCanonicalRevalidator(
  governance: ContactGovernanceRevalidationPort,
): DialerCanonicalRevalidator {
  return {
    async revalidate({ tenantId, attempt, event, source }) {
      if (!attempt.reservationId) {
        return { decision: 'REVIEW', reasonCode: 'GOVERNANCE_CONTEXT_UNAVAILABLE' };
      }
      const result = await governance.revalidateAuthorizedAction({
        tenantId: toTenantId(tenantId),
        reservationId: toReservationId(attempt.reservationId),
        actionKey: toActionKey(attempt.actionKey),
        correlationId: source.correlationId,
        sourceAggregateType: source.aggregateType,
        sourceAggregateId: source.aggregateId,
        sourceAggregateVersion: source.aggregateVersion,
        ...(event.affectedScope.contactKind
          ? { contactKind: event.affectedScope.contactKind }
          : {}),
      });
      if (result.decision === 'ALLOW') return { decision: 'ALLOW' };
      if (result.decision === 'BLOCK') return { decision: 'BLOCK', reasonCode: result.reasonCode };
      if (result.decision === 'REVIEW')
        return { decision: 'REVIEW', reasonCode: result.reasonCode };
      return result.nextEligibleAt
        ? {
            decision: 'DEFER',
            reasonCode: result.reasonCode,
            nextEligibleAt: result.nextEligibleAt,
          }
        : { decision: 'TIMEZONE_UNKNOWN', reasonCode: result.reasonCode };
    },
  };
}

/** Effect relay เรียก port นี้หลัง durable owner-local commit เท่านั้น. */
export interface DialerRealtimeSettlementPort {
  releaseBeforeBarrier(input: {
    tenantId: string;
    reservationId: string;
    actionKey: string;
    correlationId: string;
  }): Promise<void>;
  requestReconcile(input: {
    tenantId: string;
    reservationId: string;
    actionKey: string;
    deliveryId: string;
    providerRequestKey: string;
    correlationId: string;
  }): Promise<void>;
}

export function createDialerRealtimeSettlementPort(
  governance: ContactGovernancePort,
  reconcile: Pick<DialerRealtimeSettlementPort, 'requestReconcile'>,
): DialerRealtimeSettlementPort {
  return {
    async releaseBeforeBarrier(input) {
      await governance.releaseBeforeSubmit({
        tenantId: toTenantId(input.tenantId),
        reservationId: toReservationId(input.reservationId),
        actionKey: toActionKey(input.actionKey),
        correlationId: input.correlationId,
        reason: 'CANCELLED_BEFORE_SUBMIT',
      });
    },
    requestReconcile: reconcile.requestReconcile,
  };
}

export interface DialerGovernanceMetrics {
  increment(name: string): void;
  observe(name: string, value: number): void;
}

const noOpMetrics: DialerGovernanceMetrics = { increment() {}, observe() {} };

export interface DialerGovernanceInvalidationOptions {
  consumer: string;
  now?: () => Date;
  metrics?: DialerGovernanceMetrics;
}

export type DialerGovernanceApplyResult = {
  outcome: CgConsumerAckOutcome;
  affectedCount: number;
  state: 'APPLIED' | 'NO_OP' | 'GAP' | 'QUARANTINED';
};

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${name} ต้องเป็น object`);
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError(`${name} ต้องเป็น string`);
  return value;
}

function canonicalHash(value: unknown): string {
  const encode = (item: unknown): string => {
    if (
      item === null ||
      typeof item === 'boolean' ||
      typeof item === 'number' ||
      typeof item === 'string'
    ) {
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(encode).join(',')}]`;
    return `{${Object.entries(asRecord(item, 'payload'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => `${JSON.stringify(key)}:${encode(nested)}`)
      .join(',')}}`;
  };
  return createHash('sha256').update(encode(value)).digest('hex');
}

export function parseDialerCg3EventPayload(value: unknown): DialerCg3EventPayloadV1 {
  const payload = asRecord(value, 'CG3 payload');
  if (payload.contractVersion !== 1) throw new TypeError('CG3 contractVersion ต้องเป็น 1');
  if (!Number.isInteger(payload.subjectVersion) || (payload.subjectVersion as number) < 1) {
    throw new TypeError('CG3 subjectVersion ต้องเป็น positive integer');
  }
  const mutationId = optionalString(payload.mutationId, 'mutationId');
  const stateDigest = optionalString(payload.stateDigest, 'stateDigest');
  const effectiveAt = optionalString(payload.effectiveAt, 'effectiveAt');
  if (!mutationId || !stateDigest || !/^[a-f0-9]{64}$/.test(stateDigest)) {
    throw new TypeError('CG3 mutationId หรือ stateDigest ไม่ถูกต้อง');
  }
  if (!effectiveAt || Number.isNaN(Date.parse(effectiveAt)))
    throw new TypeError('CG3 effectiveAt ต้องเป็น ISO-8601');
  const scope = asRecord(payload.affectedScope, 'affectedScope');
  const channel = optionalString(scope.channel, 'affectedScope.channel') as
    ContactChannel | undefined;
  const policyVersion = payload.policyVersion;
  if (
    policyVersion !== undefined &&
    (!Number.isInteger(policyVersion) || (policyVersion as number) < 1)
  ) {
    throw new TypeError('CG3 policyVersion ต้องเป็น positive integer');
  }
  return {
    contractVersion: 1,
    mutationId,
    subjectVersion: payload.subjectVersion as number,
    affectedScope: {
      identityId: optionalString(scope.identityId, 'affectedScope.identityId') ?? null,
      channel: channel ?? null,
      purpose: optionalString(scope.purpose, 'affectedScope.purpose') ?? null,
      contactKind: optionalString(scope.contactKind, 'affectedScope.contactKind') ?? null,
    },
    effectiveAt: new Date(effectiveAt).toISOString(),
    ...(policyVersion === undefined ? {} : { policyVersion: policyVersion as number }),
    stateDigest,
  };
}

function targetState(decision: DialerRevalidationDecision): ObAttemptRealtimeState | undefined {
  if (decision.decision === 'BLOCK') return 'CANCELLED';
  if (decision.decision === 'DEFER') return 'DEFERRED';
  if (decision.decision === 'TIMEZONE_UNKNOWN') return 'PARKED';
  if (decision.decision === 'REVIEW') return 'HELD';
  return undefined;
}

function matchesScope(attempt: DialerRealtimeAttempt, payload: DialerCg3EventPayloadV1): boolean {
  const scope = payload.affectedScope;
  return (
    (!scope.identityId || scope.identityId === attempt.identityId) &&
    (!scope.channel || scope.channel === attempt.channel) &&
    (!scope.purpose || scope.purpose === attempt.purpose)
  );
}

export class DialerGovernanceInvalidationService {
  private readonly now: () => Date;
  private readonly metrics: DialerGovernanceMetrics;

  constructor(
    private readonly database: PrismaClient,
    private readonly revalidator: DialerCanonicalRevalidator,
    private readonly options: DialerGovernanceInvalidationOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.metrics = options.metrics ?? noOpMetrics;
  }

  async apply(
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    transaction?: Prisma.TransactionClient,
  ): Promise<DialerGovernanceApplyResult> {
    const execute = (client: Prisma.TransactionClient) => this.applyInTransaction(event, client);
    return transaction
      ? execute(transaction)
      : withTenantDatabaseTransaction(this.database, event.tenantId, execute);
  }

  private async applyInTransaction(
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    transaction: Prisma.TransactionClient,
  ): Promise<DialerGovernanceApplyResult> {
    if (event.eventKind !== 'CANONICAL') throw new TypeError('Dialer รับเฉพาะ CG3 canonical event');
    const aggregateType = this.aggregateType(event.aggregateType);
    if (
      (aggregateType === 'CONTACT' && !CONTACT_EVENTS.has(event.type)) ||
      (aggregateType === 'POLICY' && event.type !== 'policy.changed')
    ) {
      throw new TypeError(`CG3 event type ไม่รองรับ: ${event.type}`);
    }
    const payload = parseDialerCg3EventPayload(event.payload);
    if (payload.subjectVersion !== event.aggregateVersion)
      throw new TypeError('CG3 subjectVersion ต้องตรงกับ aggregateVersion');
    const payloadHash = canonicalHash(event.payload);
    const now = this.now();
    const existing = await transaction.obGovernanceConsumerInbox.findUnique({
      where: {
        consumer_tenantId_eventId: {
          consumer: this.options.consumer,
          tenantId: event.tenantId,
          eventId: event.eventId,
        },
      },
      select: { id: true, state: true },
    });
    if (existing && existing.state !== 'GAP') {
      return {
        outcome:
          existing.state === 'QUARANTINED'
            ? 'FAILED'
            : existing.state === 'NO_OP'
              ? 'NO_OP'
              : 'APPLIED',
        affectedCount: 0,
        state: existing.state,
      };
    }
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`dialer-cg3:${this.options.consumer}:${event.tenantId}:${event.aggregateType}:${event.aggregateId}`}))`,
    );
    const prior = await transaction.obGovernanceConsumerInbox.findFirst({
      where: {
        consumer: this.options.consumer,
        tenantId: event.tenantId,
        aggregateType,
        aggregateId: event.aggregateId,
        state: { in: ['APPLIED', 'NO_OP'] },
      },
      orderBy: { aggregateVersion: 'desc' },
      select: { aggregateVersion: true, payloadHash: true },
    });
    if (prior && event.aggregateVersion < prior.aggregateVersion)
      return this.complete(
        transaction,
        existing?.id,
        event,
        aggregateType,
        payloadHash,
        'NO_OP',
        0,
        now,
      );
    if (prior && event.aggregateVersion === prior.aggregateVersion) {
      if (prior.payloadHash === payloadHash)
        return this.complete(
          transaction,
          existing?.id,
          event,
          aggregateType,
          payloadHash,
          'NO_OP',
          0,
          now,
        );
      this.metrics.increment('dialer_cg3_hash_conflict_total');
      await this.holdMatchingAttempts(transaction, event, payload, now);
      return this.complete(
        transaction,
        existing?.id,
        event,
        aggregateType,
        payloadHash,
        'FAILED',
        0,
        now,
        'QUARANTINED',
      );
    }
    if (
      (!prior && event.aggregateVersion > 1) ||
      (prior && event.aggregateVersion > prior.aggregateVersion + 1)
    ) {
      this.metrics.increment('dialer_cg3_version_gap_total');
      await this.holdMatchingAttempts(transaction, event, payload, now);
      await this.recordGap(transaction, existing?.id, event, aggregateType, payloadHash, now);
      return { outcome: 'FAILED', affectedCount: 0, state: 'GAP' };
    }

    let affectedCount = 0;
    let bindingMissing = false;
    for (const attempt of await this.attemptsFor(transaction, event, payload)) {
      const decision = await this.revalidator.revalidate({
        tenantId: event.tenantId,
        attempt,
        event: payload,
        source: {
          aggregateType,
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion,
          correlationId: event.correlationId,
        },
      });
      if ('reasonCode' in decision && decision.reasonCode === 'GOVERNANCE_VERSION_STALE')
        this.metrics.increment('dialer_cg3_stale_revalidation_total');
      const state = targetState(decision);
      if (!state) {
        await transaction.obAttempt.update({
          where: { id: attempt.id },
          data: {
            appliedAggregateVersion: event.aggregateVersion,
            appliedPayloadHash: payloadHash,
          },
        });
        continue;
      }
      affectedCount += 1;
      if (attempt.realtimeState === 'IN_PROGRESS') {
        await transaction.obAttempt.update({
          where: { id: attempt.id },
          data: {
            nextOutboundBlocked: true,
            appliedAggregateVersion: event.aggregateVersion,
            appliedPayloadHash: payloadHash,
          },
        });
        continue;
      }
      if (PRE_BARRIER_STATES.has(attempt.realtimeState)) {
        if (attempt.realtimeState !== 'QUEUED' && attempt.reservationId) {
          await this.stageEffect(transaction, event, attempt, 'RELEASE_BEFORE_BARRIER', now);
        } else if (attempt.realtimeState !== 'QUEUED') {
          bindingMissing = true;
          await transaction.obAttempt.update({
            where: { id: attempt.id },
            data: {
              realtimeState: 'HELD',
              nextOutboundBlocked: true,
              appliedAggregateVersion: event.aggregateVersion,
              appliedPayloadHash: payloadHash,
            },
          });
          continue;
        }
        await transaction.obAttempt.update({
          where: { id: attempt.id },
          data: {
            realtimeState: state,
            nextOutboundBlocked: true,
            ...(decision.decision === 'DEFER'
              ? { nextEligibleAt: new Date(decision.nextEligibleAt) }
              : {}),
            appliedAggregateVersion: event.aggregateVersion,
            appliedPayloadHash: payloadHash,
          },
        });
        continue;
      }
      if (POST_BARRIER_STATES.has(attempt.realtimeState)) {
        if (!attempt.reservationId || !attempt.deliveryId || !attempt.providerRequestKey) {
          bindingMissing = true;
          await transaction.obAttempt.update({
            where: { id: attempt.id },
            data: {
              realtimeState: 'HELD',
              nextOutboundBlocked: true,
              appliedAggregateVersion: event.aggregateVersion,
              appliedPayloadHash: payloadHash,
            },
          });
          continue;
        }
        await this.stageEffect(transaction, event, attempt, 'REQUEST_RECONCILE', now);
        await transaction.obAttempt.update({
          where: { id: attempt.id },
          data: {
            realtimeState: 'CANCEL_REQUESTED',
            nextOutboundBlocked: true,
            cancelRequestedAt: now,
            appliedAggregateVersion: event.aggregateVersion,
            appliedPayloadHash: payloadHash,
          },
        });
      }
    }
    return this.complete(
      transaction,
      existing?.id,
      event,
      aggregateType,
      payloadHash,
      bindingMissing ? 'FAILED' : affectedCount ? 'APPLIED' : 'NO_OP',
      affectedCount,
      now,
    );
  }

  private aggregateType(value: string): CgAggregateType {
    if (value === 'contact_governance_contact') return 'CONTACT';
    if (value === 'contact_governance_policy') return 'POLICY';
    throw new TypeError(`CG3 aggregateType ไม่รองรับ: ${value}`);
  }

  private async attemptsFor(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    payload: DialerCg3EventPayloadV1,
  ): Promise<DialerRealtimeAttempt[]> {
    const rows = await transaction.obAttempt.findMany({
      where: {
        tenantId: event.tenantId,
        realtimeState: { in: ACTIVE_STATES },
        ...(event.aggregateType === 'contact_governance_contact'
          ? { contactId: event.aggregateId }
          : {}),
      },
      select: {
        id: true,
        tenantId: true,
        actionKey: true,
        contactId: true,
        identityId: true,
        channel: true,
        purpose: true,
        reservationId: true,
        realtimeState: true,
        deliveryId: true,
        providerRequestKey: true,
      },
    });
    return rows.filter((row) => matchesScope(row, payload));
  }

  private async holdMatchingAttempts(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    payload: DialerCg3EventPayloadV1,
    now: Date,
  ): Promise<void> {
    for (const attempt of await this.attemptsFor(transaction, event, payload)) {
      if (attempt.realtimeState === 'IN_PROGRESS') {
        await transaction.obAttempt.update({
          where: { id: attempt.id },
          data: { nextOutboundBlocked: true },
        });
      } else {
        await transaction.obAttempt.update({
          where: { id: attempt.id },
          data: { realtimeState: 'HELD', nextOutboundBlocked: true, cancelRequestedAt: now },
        });
      }
    }
  }

  private async stageEffect(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    attempt: DialerRealtimeAttempt,
    kind: 'RELEASE_BEFORE_BARRIER' | 'REQUEST_RECONCILE',
    now: Date,
  ): Promise<void> {
    if (!attempt.reservationId) throw new Error('effect ต้องมี reservation binding');
    await transaction.obGovernanceEffectOutbox.upsert({
      where: {
        tenantId_eventId_attemptId_kind: {
          tenantId: event.tenantId,
          eventId: event.eventId,
          attemptId: attempt.id,
          kind,
        },
      },
      create: {
        id: randomUUID(),
        tenantId: event.tenantId,
        eventId: event.eventId,
        attemptId: attempt.id,
        actionKey: attempt.actionKey,
        reservationId: attempt.reservationId,
        deliveryId: attempt.deliveryId,
        providerRequestKey: attempt.providerRequestKey,
        correlationId: event.correlationId,
        kind,
        availableAt: now,
      },
      update: {},
    });
  }

  private async recordGap(
    transaction: Prisma.TransactionClient,
    existingId: string | undefined,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    aggregateType: CgAggregateType,
    payloadHash: string,
    now: Date,
  ): Promise<void> {
    const data = {
      aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      payloadHash,
      state: 'GAP' as const,
      affectedCount: 0,
      appliedAt: now,
    };
    if (existingId)
      await transaction.obGovernanceConsumerInbox.update({ where: { id: existingId }, data });
    else
      await transaction.obGovernanceConsumerInbox.create({
        data: {
          id: randomUUID(),
          consumer: this.options.consumer,
          tenantId: event.tenantId,
          eventId: event.eventId,
          ...data,
        },
      });
  }

  private async complete(
    transaction: Prisma.TransactionClient,
    existingId: string | undefined,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    aggregateType: CgAggregateType,
    payloadHash: string,
    outcome: CgConsumerAckOutcome,
    affectedCount: number,
    now: Date,
    forcedState?: 'QUARANTINED',
  ): Promise<DialerGovernanceApplyResult> {
    const state: 'APPLIED' | 'NO_OP' | 'QUARANTINED' =
      forcedState ?? (outcome === 'NO_OP' ? 'NO_OP' : 'APPLIED');
    const inbox = {
      aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      payloadHash,
      state,
      affectedCount,
      appliedAt: now,
    };
    if (existingId)
      await transaction.obGovernanceConsumerInbox.update({
        where: { id: existingId },
        data: inbox,
      });
    else
      await transaction.obGovernanceConsumerInbox.create({
        data: {
          id: randomUUID(),
          consumer: this.options.consumer,
          tenantId: event.tenantId,
          eventId: event.eventId,
          ...inbox,
        },
      });
    await transaction.obGovernanceAcknowledgementOutbox.upsert({
      where: {
        tenantId_eventId_consumer_appliedVersion: {
          tenantId: event.tenantId,
          eventId: event.eventId,
          consumer: this.options.consumer,
          appliedVersion: event.aggregateVersion,
        },
      },
      create: {
        id: randomUUID(),
        tenantId: event.tenantId,
        eventId: event.eventId,
        consumer: this.options.consumer,
        aggregateType,
        aggregateId: event.aggregateId,
        appliedVersion: event.aggregateVersion,
        outcome,
        affectedCount,
        sourcePayloadHash: payloadHash,
        availableAt: now,
      },
      update: {},
    });
    return { outcome, affectedCount, state };
  }
}
