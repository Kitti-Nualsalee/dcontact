/**
 * S1.5 — owner-local CG3 realtime invalidation boundary for Journey.
 *
 * Contact Governance remains the sole writer of policy/reservation facts. Journey
 * only stores its own action cursor, applies the CG3 event at-least-once, and puts
 * its effect plus acknowledgement in owner-local outboxes in the same transaction.
 * A restrictive event can therefore be replayed safely without resurrecting an
 * action that has already been cancelled or sent to reconciliation.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgAggregateType,
  type CgConsumerAckOutcome,
  type JrRealtimeActionState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import {
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  outcomeRef as toOutcomeRef,
  providerRequestKey as toProviderRequestKey,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactChannel,
  type ContactGovernancePort,
  type ContactGovernanceRevalidationPort,
} from '@d-contact/cxa-contracts';

const ACTIVE_ACTION_STATES: JrRealtimeActionState[] = [
  'QUEUED',
  'RESERVED',
  'PRE_BARRIER',
  'POST_BARRIER',
  'ACCEPTED',
  'CANCEL_REQUESTED',
];

const PRE_BARRIER_STATES = new Set<JrRealtimeActionState>(['QUEUED', 'RESERVED', 'PRE_BARRIER']);
const POST_BARRIER_STATES = new Set<JrRealtimeActionState>([
  'POST_BARRIER',
  'ACCEPTED',
  'CANCEL_REQUESTED',
]);
const CONTACT_EVENTS = new Set(['restriction.changed', 'consent.changed', 'preference.changed']);

export interface Cg3EventScope {
  identityId: string | null;
  channel: ContactChannel | null;
  purpose: string | null;
  contactKind: string | null;
}

export interface JourneyCg3EventPayloadV1 {
  contractVersion: 1;
  mutationId: string;
  subjectVersion: number;
  identityId?: string;
  affectedScope: Cg3EventScope;
  effectiveAt: string;
  policyVersion?: number;
  stateDigest: string;
}

export type JourneyRevalidationDecision =
  | { decision: 'ALLOW' }
  | { decision: 'BLOCK'; reasonCode: string }
  | { decision: 'DEFER'; reasonCode: string; nextEligibleAt: string }
  | { decision: 'TIMEZONE_UNKNOWN'; reasonCode: string }
  | { decision: 'REVIEW'; reasonCode: string };

export interface JourneyRealtimeAction {
  id: string;
  tenantId: string;
  actionKey: string;
  contactId: string;
  identityId: string;
  channel: ContactChannel;
  purpose: string;
  reservationId: string;
  realtimeState: JrRealtimeActionState;
  deliveryId?: string;
  providerRequestKey?: string;
}

/** Narrow port: Journey asks the Governance owner to evaluate canonical current facts. */
export interface JourneyCanonicalRevalidator {
  revalidate(input: {
    tenantId: string;
    action: JourneyRealtimeAction;
    event: JourneyCg3EventPayloadV1;
    source: {
      aggregateType: 'CONTACT' | 'POLICY';
      aggregateId: string;
      aggregateVersion: number;
      correlationId: string;
    };
  }): Promise<JourneyRevalidationDecision>;
}

/** แปลงผล canonical read-only ของ Governance เป็น state vocabulary ของ Journey เท่านั้น. */
export function createJourneyCanonicalRevalidator(
  governance: ContactGovernanceRevalidationPort,
): JourneyCanonicalRevalidator {
  return {
    async revalidate({ tenantId, action, event, source }) {
      const outcome = await governance.revalidateAuthorizedAction({
        tenantId: toTenantId(tenantId),
        reservationId: toReservationId(action.reservationId),
        actionKey: toActionKey(action.actionKey),
        correlationId: source.correlationId,
        sourceAggregateType: source.aggregateType,
        sourceAggregateId: source.aggregateId,
        sourceAggregateVersion: source.aggregateVersion,
        ...(event.affectedScope.contactKind ? { contactKind: event.affectedScope.contactKind } : {}),
      });
      if (outcome.decision === 'ALLOW') return { decision: 'ALLOW' };
      if (outcome.decision === 'BLOCK') {
        return { decision: 'BLOCK', reasonCode: outcome.reasonCode };
      }
      if (outcome.decision === 'REVIEW') {
        return { decision: 'REVIEW', reasonCode: outcome.reasonCode };
      }
      if (outcome.nextEligibleAt) {
        return {
          decision: 'DEFER',
          reasonCode: outcome.reasonCode,
          nextEligibleAt: outcome.nextEligibleAt,
        };
      }
      return { decision: 'TIMEZONE_UNKNOWN', reasonCode: outcome.reasonCode };
    },
  };
}

/**
 * Delivery/Governance side effects remain outside Journey's database. Both methods
 * must be idempotent for the action key; the effect relay calls them after commit.
 */
export interface JourneyRealtimeSettlementPort {
  releaseBeforeBarrier(input: {
    tenantId: string;
    reservationId: string;
    actionKey: string;
    deliveryId?: string;
    correlationId: string;
  }): Promise<void>;
  requestReconcile(input: {
    tenantId: string;
    reservationId: string;
    actionKey: string;
    deliveryId?: string;
    providerRequestKey?: string;
    correlationId: string;
  }): Promise<void>;
}

/**
 * Adapter ที่ Journey ใช้ได้ผ่าน contract เท่านั้น. หากไม่มี immutable post-barrier
 * binding ครบ จะ throw/fail closed แทนการ release หรือ resend แบบเดาเอง.
 */
export function createJourneyRealtimeSettlementPort(
  governance: ContactGovernancePort,
): JourneyRealtimeSettlementPort {
  return {
    async releaseBeforeBarrier(input) {
      await governance.releaseBeforeSubmit({
        tenantId: toTenantId(input.tenantId),
        correlationId: input.correlationId,
        reservationId: toReservationId(input.reservationId),
        actionKey: toActionKey(input.actionKey),
        ...(input.deliveryId ? { deliveryId: toDeliveryId(input.deliveryId) } : {}),
        reason: 'CANCELLED_BEFORE_SUBMIT',
      });
    },
    async requestReconcile(input) {
      if (!input.deliveryId || !input.providerRequestKey) {
        throw new Error('post-barrier Journey action ต้องมี deliveryId และ providerRequestKey ก่อน reconcile');
      }
      await governance.settleDelivery({
        tenantId: toTenantId(input.tenantId),
        correlationId: input.correlationId,
        reservationId: toReservationId(input.reservationId),
        actionKey: toActionKey(input.actionKey),
        deliveryId: toDeliveryId(input.deliveryId),
        providerRequestKey: toProviderRequestKey(input.providerRequestKey),
        outcomeRef: toOutcomeRef(`journey-cancel-request:${input.actionKey}`),
        outcome: 'UNKNOWN_RECONCILING',
        occurredAt: new Date().toISOString(),
      });
    },
  };
}

export interface JourneyGovernanceInvalidationOptions {
  consumer: string;
  now?: () => Date;
}

export type JourneyGovernanceApplyResult = {
  outcome: CgConsumerAckOutcome;
  affectedCount: number;
  state: 'APPLIED' | 'NO_OP' | 'GAP' | 'QUARANTINED';
};

export class JourneyGovernanceVersionGapError extends Error {
  readonly code = 'GOVERNANCE_VERSION_GAP' as const;
  constructor(
    readonly aggregateId: string,
    readonly expectedVersion: number,
    readonly receivedVersion: number,
  ) {
    super(
      `CG3 version gap สำหรับ ${aggregateId}: ต้องเป็น ${expectedVersion} แต่ได้รับ ${receivedVersion}`,
    );
  }
}

export class JourneyGovernanceHashConflictError extends Error {
  readonly code = 'EVENT_HASH_CONFLICT' as const;
  constructor(readonly aggregateId: string, readonly aggregateVersion: number) {
    super(`CG3 event hash conflict สำหรับ ${aggregateId} version ${aggregateVersion}`);
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} ต้องเป็น object`);
  }
  return value as Record<string, unknown>;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} ต้องเป็น string`);
  return value;
}

function hashPayload(value: unknown): string {
  const canonical = (item: unknown): string => {
    if (item === null || typeof item === 'boolean' || typeof item === 'number') {
      return JSON.stringify(item);
    }
    if (typeof item === 'string') return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(canonical).join(',')}]`;
    const fields = Object.entries(record(item, 'payload'))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonical(nested)}`);
    return `{${fields.join(',')}}`;
  };
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function parseJourneyCg3EventPayload(value: unknown): JourneyCg3EventPayloadV1 {
  const payload = record(value, 'CG3 payload');
  if (payload.contractVersion !== 1) throw new TypeError('CG3 contractVersion ต้องเป็น 1');
  if (!Number.isInteger(payload.subjectVersion) || (payload.subjectVersion as number) < 1) {
    throw new TypeError('CG3 subjectVersion ต้องเป็น positive integer');
  }
  const digest = optionalString(payload.stateDigest, 'stateDigest');
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError('CG3 stateDigest ต้องเป็น SHA-256 lowercase');
  }
  const effectiveAt = optionalString(payload.effectiveAt, 'effectiveAt');
  if (!effectiveAt || Number.isNaN(new Date(effectiveAt).getTime())) {
    throw new TypeError('CG3 effectiveAt ต้องเป็น ISO-8601');
  }
  const scope = record(payload.affectedScope, 'affectedScope');
  const identityId = optionalString(scope.identityId, 'affectedScope.identityId') ?? null;
  const channel = optionalString(scope.channel, 'affectedScope.channel') as ContactChannel | undefined;
  const purpose = optionalString(scope.purpose, 'affectedScope.purpose') ?? null;
  const contactKind = optionalString(scope.contactKind, 'affectedScope.contactKind') ?? null;
  const policyVersion = payload.policyVersion;
  if (policyVersion !== undefined && (!Number.isInteger(policyVersion) || (policyVersion as number) < 1)) {
    throw new TypeError('CG3 policyVersion ต้องเป็น positive integer');
  }
  return {
    contractVersion: 1,
    mutationId: optionalString(payload.mutationId, 'mutationId') ?? (() => { throw new TypeError('mutationId ต้องมีค่า'); })(),
    subjectVersion: payload.subjectVersion as number,
    ...(optionalString(payload.identityId, 'identityId') ? { identityId: optionalString(payload.identityId, 'identityId') } : {}),
    affectedScope: { identityId, channel: channel ?? null, purpose, contactKind },
    effectiveAt: new Date(effectiveAt).toISOString(),
    ...(policyVersion === undefined ? {} : { policyVersion: policyVersion as number }),
    stateDigest: digest,
  };
}

function matchesScope(action: JourneyRealtimeAction, scope: Cg3EventScope): boolean {
  return (
    (!scope.identityId || scope.identityId === action.identityId) &&
    (!scope.channel || scope.channel === action.channel) &&
    (!scope.purpose || scope.purpose === action.purpose)
  );
}

function targetState(decision: JourneyRevalidationDecision): JrRealtimeActionState | undefined {
  switch (decision.decision) {
    case 'BLOCK':
      return 'CANCELLED';
    case 'DEFER':
      return 'DEFERRED';
    case 'TIMEZONE_UNKNOWN':
      return 'PARKED';
    case 'REVIEW':
      return 'HELD';
    case 'ALLOW':
      return undefined;
  }
}

export class JourneyGovernanceInvalidationService {
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly revalidator: JourneyCanonicalRevalidator,
    private readonly settlement: JourneyRealtimeSettlementPort,
    private readonly options: JourneyGovernanceInvalidationOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async apply(
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    transaction?: Prisma.TransactionClient,
  ): Promise<JourneyGovernanceApplyResult> {
    const apply = (client: Prisma.TransactionClient) => this.applyInTransaction(event, client);
    return transaction
      ? apply(transaction)
      : withTenantDatabaseTransaction(this.database, event.tenantId, apply);
  }

  private async applyInTransaction(
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    transaction: Prisma.TransactionClient,
  ): Promise<JourneyGovernanceApplyResult> {
    if (event.eventKind !== 'CANONICAL') throw new TypeError('Journey รับเฉพาะ CG3 canonical event');
    const aggregateType = this.aggregateType(event.aggregateType);
    if (
      (aggregateType === 'CONTACT' && !CONTACT_EVENTS.has(event.type)) ||
      (aggregateType === 'POLICY' && event.type !== 'policy.changed')
    ) {
      throw new TypeError(`CG3 event type ไม่รองรับ: ${event.type}`);
    }
    const payload = parseJourneyCg3EventPayload(event.payload);
    if (payload.subjectVersion !== event.aggregateVersion) {
      throw new TypeError('CG3 subjectVersion ต้องตรงกับ envelope aggregateVersion');
    }
    const payloadHash = hashPayload(event.payload);
    const now = this.now();
    const inbox = await transaction.jrGovernanceConsumerInbox.findUnique({
      where: {
        consumer_tenantId_eventId: {
          consumer: this.options.consumer,
          tenantId: event.tenantId,
          eventId: event.eventId,
        },
      },
      select: { id: true, state: true },
    });
    if (inbox && inbox.state !== 'GAP') {
      return {
        outcome: inbox.state === 'QUARANTINED' ? 'QUARANTINED' : inbox.state === 'NO_OP' ? 'NO_OP' : 'APPLIED',
        affectedCount: 0,
        state: inbox.state,
      };
    }

    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`journey-cg3:${this.options.consumer}:${event.tenantId}:${event.aggregateType}:${event.aggregateId}`}))`,
    );
    const prior = await transaction.jrGovernanceConsumerInbox.findFirst({
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

    if (prior && event.aggregateVersion < prior.aggregateVersion) {
      return this.complete(
        transaction,
        inbox?.id,
        event,
        aggregateType,
        payloadHash,
        'NO_OP',
        0,
        now,
      );
    }
    if (prior && event.aggregateVersion === prior.aggregateVersion) {
      if (prior.payloadHash !== payloadHash) {
        await this.holdMatchingActions(transaction, event, payload, payloadHash, now);
        return this.complete(
          transaction,
          inbox?.id,
          event,
          aggregateType,
          payloadHash,
          'QUARANTINED',
          0,
          now,
        );
      }
      return this.complete(
        transaction,
        inbox?.id,
        event,
        aggregateType,
        payloadHash,
        'NO_OP',
        0,
        now,
      );
    }
    if (
      (!prior && event.aggregateVersion > 1) ||
      (prior && event.aggregateVersion > prior.aggregateVersion + 1)
    ) {
      await this.holdMatchingActions(transaction, event, payload, payloadHash, now);
      if (inbox) {
        await transaction.jrGovernanceConsumerInbox.update({
          where: { id: inbox.id },
          data: { state: 'GAP', affectedCount: 0, appliedAt: now },
        });
      } else {
        await transaction.jrGovernanceConsumerInbox.create({
          data: {
            id: randomUUID(),
            consumer: this.options.consumer,
            tenantId: event.tenantId,
            eventId: event.eventId,
            aggregateType,
            aggregateId: event.aggregateId,
            aggregateVersion: event.aggregateVersion,
            payloadHash,
            state: 'GAP',
            appliedAt: now,
          },
        });
      }
      return { outcome: 'FAILED', affectedCount: 0, state: 'GAP' };
    }

    const actions = await this.actionsFor(transaction, event, payload);
    let affectedCount = 0;
    for (const action of actions) {
      const decision = await this.revalidator.revalidate({
        tenantId: event.tenantId,
        action,
        event: payload,
        source: {
          aggregateType,
          aggregateId: event.aggregateId,
          aggregateVersion: event.aggregateVersion,
          correlationId: event.correlationId,
        },
      });
      const state = targetState(decision);
      if (!state) {
        await transaction.jrAction.update({
          where: { id: action.id },
          data: { appliedAggregateVersion: event.aggregateVersion, appliedPayloadHash: payloadHash },
        });
        continue;
      }
      affectedCount += 1;
      if (PRE_BARRIER_STATES.has(action.realtimeState)) {
        await this.stageEffect(transaction, event, action, 'RELEASE_BEFORE_BARRIER', now);
        await transaction.jrAction.update({
          where: { id: action.id },
          data: {
            realtimeState: state,
            ...(decision.decision === 'DEFER' ? { nextEligibleAt: new Date(decision.nextEligibleAt) } : {}),
            appliedAggregateVersion: event.aggregateVersion,
            appliedPayloadHash: payloadHash,
          },
        });
      } else if (POST_BARRIER_STATES.has(action.realtimeState)) {
        await this.stageEffect(transaction, event, action, 'REQUEST_RECONCILE', now);
        await transaction.jrAction.update({
          where: { id: action.id },
          data: {
            realtimeState: 'CANCEL_REQUESTED',
            cancelRequestedAt: now,
            appliedAggregateVersion: event.aggregateVersion,
            appliedPayloadHash: payloadHash,
          },
        });
      }
    }
    return this.complete(
      transaction,
      inbox?.id,
      event,
      aggregateType,
      payloadHash,
      affectedCount === 0 ? 'NO_OP' : 'APPLIED',
      affectedCount,
      now,
    );
  }

  private aggregateType(value: string): CgAggregateType {
    if (value === 'contact_governance_contact') return 'CONTACT';
    if (value === 'contact_governance_policy') return 'POLICY';
    throw new TypeError(`CG3 aggregateType ไม่รองรับ: ${value}`);
  }

  private async actionsFor(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    payload: JourneyCg3EventPayloadV1,
  ): Promise<JourneyRealtimeAction[]> {
    const rows = await transaction.jrAction.findMany({
      where: {
        tenantId: event.tenantId,
        realtimeState: { in: ACTIVE_ACTION_STATES },
        ...(event.aggregateType === 'contact_governance_contact' ? { contactId: event.aggregateId } : {}),
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
    return rows
      .map(
        (row): JourneyRealtimeAction => ({
          id: row.id,
          tenantId: row.tenantId,
          actionKey: row.actionKey,
          contactId: row.contactId,
          identityId: row.identityId,
          channel: row.channel,
          purpose: row.purpose,
          reservationId: row.reservationId,
          realtimeState: row.realtimeState,
          ...(row.deliveryId ? { deliveryId: row.deliveryId } : {}),
          ...(row.providerRequestKey ? { providerRequestKey: row.providerRequestKey } : {}),
        }),
      )
      .filter((action) => matchesScope(action, payload.affectedScope));
  }

  private async holdMatchingActions(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    payload: JourneyCg3EventPayloadV1,
    payloadHash: string,
    now: Date,
  ): Promise<void> {
    const actions = await this.actionsFor(transaction, event, payload);
    if (actions.length === 0) return;
    await transaction.jrAction.updateMany({
      where: { id: { in: actions.map((action) => action.id) } },
      data: {
        realtimeState: 'HELD',
        appliedAggregateVersion: event.aggregateVersion,
        appliedPayloadHash: payloadHash,
        cancelRequestedAt: now,
      },
    });
  }

  /** เก็บ command ใน Journey outbox ก่อน ack; ห้ามเรียก Governance/Delivery ระหว่าง transaction นี้. */
  private async stageEffect(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    action: JourneyRealtimeAction,
    kind: 'RELEASE_BEFORE_BARRIER' | 'REQUEST_RECONCILE',
    now: Date,
  ): Promise<void> {
    await transaction.jrGovernanceEffectOutbox.upsert({
      where: {
        tenantId_eventId_actionId_kind: {
          tenantId: action.tenantId,
          eventId: event.eventId,
          actionId: action.id,
          kind,
        },
      },
      create: {
        id: randomUUID(),
        tenantId: action.tenantId,
        eventId: event.eventId,
        actionId: action.id,
        actionKey: action.actionKey,
        reservationId: action.reservationId,
        ...(action.deliveryId ? { deliveryId: action.deliveryId } : {}),
        ...(action.providerRequestKey ? { providerRequestKey: action.providerRequestKey } : {}),
        correlationId: event.correlationId,
        kind,
        state: 'PENDING',
        availableAt: now,
      },
      update: {},
    });
  }

  private async complete(
    transaction: Prisma.TransactionClient,
    existingInboxId: string | undefined,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    aggregateType: CgAggregateType,
    payloadHash: string,
    outcome: Extract<CgConsumerAckOutcome, 'APPLIED' | 'NO_OP' | 'QUARANTINED'>,
    affectedCount: number,
    now: Date,
  ): Promise<JourneyGovernanceApplyResult> {
    const state = outcome === 'APPLIED' ? 'APPLIED' : outcome === 'NO_OP' ? 'NO_OP' : 'QUARANTINED';
    const inboxData = {
      consumer: this.options.consumer,
      tenantId: event.tenantId,
      eventId: event.eventId,
      aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      payloadHash,
      state,
      affectedCount,
      appliedAt: now,
    } as const;
    if (existingInboxId) {
      await transaction.jrGovernanceConsumerInbox.update({ where: { id: existingInboxId }, data: inboxData });
    } else {
      await transaction.jrGovernanceConsumerInbox.create({ data: { id: randomUUID(), ...inboxData } });
    }
    await transaction.jrGovernanceAcknowledgementOutbox.upsert({
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
        state: 'PENDING',
        availableAt: now,
      },
      update: {},
    });
    return { outcome, affectedCount, state };
  }
}
