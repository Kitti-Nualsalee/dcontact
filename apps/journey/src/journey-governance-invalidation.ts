/**
 * S1.5 — ขอบเขต CG3 realtime invalidation ที่ Journey เป็น owner
 * CG4.8 (#191) — ขยายให้รับ CG4 exception/policy/kill-switch events บน stream เดียวกัน
 *
 * Contact Governance ยังคงเป็นผู้เขียน policy/exception/reservation facts แต่เพียงผู้เดียว
 * Journey เก็บเฉพาะ action cursor ของตน apply event แบบ at-least-once และใส่ effect กับ
 * acknowledgement ใน owner-local outbox transaction เดียวกัน จึง replay restrictive event ได้
 * โดยไม่ resurrect action ที่ cancel หรือส่ง reconcile ไปแล้ว
 *
 * กติกา CG4 (#179 §4/§5, #124):
 * - tightening/neutral ขอ canonical re-authorization; kill switch hold ทันที
 * - relaxation (approve exception, clear kill switch, policy ผ่อนลง) ไม่ resume หรือ retry งานเดิม
 * - contract/version ที่ไม่รู้จัก quarantine และ hold scope ของ aggregate นั้นแบบ fail closed
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgAggregateType,
  type CgConsumerAckOutcome,
  type JrGovernanceConsumerState,
  type JrRealtimeActionState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { DcProducer, KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  noOpJourneyGovernanceMetrics,
  type JourneyGovernanceMetrics,
} from './journey-governance-metrics.js';
import {
  actionKey as toActionKey,
  classifyGovernanceEvent,
  classifyGovernanceStreamPosition,
  isGovernanceContractRejection,
  deliveryId as toDeliveryId,
  GOVERNANCE_KILL_SWITCH_ACTIVE,
  governancePayloadDigest,
  governanceScopeCovers,
  providerRequestKey as toProviderRequestKey,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactChannel,
  type ContactGovernancePort,
  type ContactGovernanceRevalidationPort,
  type GovernanceDownstreamEvent,
  type GovernanceDownstreamRejection,
  type GovernanceDownstreamScope,
  type JourneyDeliveryReconcilePort,
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
/** แถว inbox ที่ขยับ cursor ของ stream */
const CURSOR_STATES: JrGovernanceConsumerState[] = ['APPLIED', 'NO_OP'];
/** Journey-owned direct SEND เป็น source เดียวที่ Journey ถือ reservation */
const JOURNEY_SOURCE_TYPES = Object.freeze(['JOURNEY']);
export const CANONICAL_RELOAD_REASON = 'CANONICAL_RELOAD' as const;

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

/** narrow port ที่ Journey ใช้ขอ canonical current facts จาก Governance owner */
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
      /** CG4.8: ให้ Governance ใช้ version authority ของ event family นั้น */
      contract?: 'CG3' | 'CG4';
      eventType?: string;
      scopeKey?: string;
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
        ...(event.affectedScope.contactKind
          ? { contactKind: event.affectedScope.contactKind }
          : {}),
        ...(source.contract ? { sourceContract: source.contract } : {}),
        ...(source.eventType ? { sourceEventType: source.eventType } : {}),
        ...(source.scopeKey ? { sourceScopeKey: source.scopeKey } : {}),
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
 * side effect ของ Delivery/Governance อยู่นอกฐานข้อมูล Journey และต้อง idempotent ต่อ
 * action key; effect relay จะเรียกหลัง commit
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
  delivery: JourneyDeliveryReconcilePort,
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
        throw new Error(
          'post-barrier Journey action ต้องมี deliveryId และ providerRequestKey ก่อน reconcile',
        );
      }
      await delivery.requestReconcile({
        tenantId: toTenantId(input.tenantId),
        correlationId: input.correlationId,
        reservationId: toReservationId(input.reservationId),
        actionKey: toActionKey(input.actionKey),
        deliveryId: toDeliveryId(input.deliveryId),
        providerRequestKey: toProviderRequestKey(input.providerRequestKey),
      });
    },
  };
}

/** Journey เพียง publish command; Delivery owner เป็นผู้ reconcile provider/reservation เอง. */
export function createJourneyKafkaReconcilePort(
  producer: DcProducer,
): JourneyDeliveryReconcilePort {
  return {
    async requestReconcile(input) {
      await producer.send(KAFKA_TOPICS.DELIVERY_COMMANDS, {
        schemaVersion: 2,
        eventKind: 'CANONICAL',
        eventId: `journey-reconcile:${input.actionKey}`,
        type: 'delivery.reconcile_requested',
        tenantId: input.tenantId,
        occurredAt: new Date().toISOString(),
        correlationId: input.correlationId,
        orderingKey: input.actionKey,
        aggregateType: 'journey_action',
        aggregateId: input.actionKey,
        aggregateVersion: 1,
        payload: {
          contractVersion: 1,
          actionKey: input.actionKey,
          reservationId: input.reservationId,
          deliveryId: input.deliveryId,
          providerRequestKey: input.providerRequestKey,
        },
      });
    },
  };
}

export interface JourneyGovernanceInvalidationOptions {
  consumer: string;
  now?: () => Date;
  metrics?: JourneyGovernanceMetrics;
}

export type JourneyGovernanceApplyResult = {
  outcome: CgConsumerAckOutcome;
  affectedCount: number;
  state: 'APPLIED' | 'NO_OP' | 'GAP' | 'QUARANTINED' | 'DUPLICATE';
  /** controlled reason เมื่อ quarantine ไม่มี payload หรือ PII */
  reasonCode?: string;
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
  constructor(
    readonly aggregateId: string,
    readonly aggregateVersion: number,
  ) {
    super(`CG3 event hash conflict สำหรับ ${aggregateId} version ${aggregateVersion}`);
  }
}

export class JourneyCanonicalReloadConflictError extends Error {
  readonly code = 'CANONICAL_RELOAD_CONFLICT' as const;
  constructor(
    readonly aggregateId: string,
    readonly aggregateVersion: number,
  ) {
    super(
      `canonical reload ขัดกับ digest ที่ apply แล้วที่ ${aggregateId} version ${aggregateVersion}`,
    );
  }
}

/** คงไว้สำหรับ caller เดิม; การตีความ event จริงอยู่ที่ `classifyGovernanceEvent` */
export function parseJourneyCg3EventPayload(value: unknown): JourneyCg3EventPayloadV1 {
  const classification = classifyGovernanceEvent({
    type: 'preference.changed',
    aggregateType: 'contact_governance_contact',
    aggregateId: 'payload-only',
    aggregateVersion:
      value &&
      typeof value === 'object' &&
      Number.isInteger((value as Record<string, unknown>).subjectVersion)
        ? ((value as Record<string, unknown>).subjectVersion as number)
        : 0,
    payload: value,
  });
  if (!classification?.ok) {
    throw new TypeError(classification?.detail ?? 'CG3 payload ไม่ถูกต้อง');
  }
  const payload = value as Record<string, unknown>;
  return {
    ...toRevalidationPayload(classification.event),
    ...(typeof payload.identityId === 'string' ? { identityId: payload.identityId } : {}),
  };
}

function toRevalidationPayload(event: GovernanceDownstreamEvent): JourneyCg3EventPayloadV1 {
  return {
    contractVersion: 1,
    mutationId: event.mutationId,
    subjectVersion: event.subjectVersion,
    affectedScope: {
      identityId: event.scope.identityId,
      channel: event.scope.channel,
      purpose: event.scope.purpose,
      contactKind: event.scope.contactKind,
    },
    effectiveAt: event.effectiveAt,
    ...(event.policyVersion === undefined ? {} : { policyVersion: event.policyVersion }),
    stateDigest: event.stateDigest,
  };
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

type CursorRow = { aggregateVersion: number; payloadHash: string; reasonCode: string | null };

interface CompleteOptions {
  reasonCode?: string;
  appliedStateDigest?: string;
}

export class JourneyGovernanceInvalidationService {
  private readonly now: () => Date;
  private readonly metrics: JourneyGovernanceMetrics;

  constructor(
    private readonly database: PrismaClient,
    private readonly revalidator: JourneyCanonicalRevalidator,
    private readonly settlement: JourneyRealtimeSettlementPort,
    private readonly options: JourneyGovernanceInvalidationOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.metrics = options.metrics ?? noOpJourneyGovernanceMetrics;
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
    if (event.eventKind !== 'CANONICAL') {
      throw new TypeError('Journey รับเฉพาะ Contact Governance canonical event');
    }
    const classification = classifyGovernanceEvent({
      type: event.type,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      payload: event.payload,
    });
    if (!classification) {
      throw new TypeError(`Contact Governance aggregateType ไม่รองรับ: ${event.aggregateType}`);
    }
    const aggregateType: CgAggregateType = classification.ok
      ? classification.event.aggregate
      : classification.aggregate;
    const payloadHash = classification.ok
      ? classification.event.payloadDigest
      : classification.payloadDigest;
    const now = this.now();
    const inbox = await transaction.jrGovernanceConsumerInbox.findUnique({
      where: {
        consumer_tenantId_eventId: {
          consumer: this.options.consumer,
          tenantId: event.tenantId,
          eventId: event.eventId,
        },
      },
      select: { id: true, state: true, reasonCode: true },
    });
    if (inbox && inbox.state !== 'GAP') {
      return {
        outcome:
          inbox.state === 'QUARANTINED'
            ? 'QUARANTINED'
            : inbox.state === 'APPLIED'
              ? 'APPLIED'
              : 'NO_OP',
        affectedCount: 0,
        state: inbox.state,
        ...(isGovernanceContractRejection(inbox.reasonCode ?? undefined)
          ? { reasonCode: inbox.reasonCode as string }
          : {}),
      };
    }

    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`journey-cg3:${this.options.consumer}:${event.tenantId}:${event.aggregateType}:${event.aggregateId}`}))`,
    );

    if (!classification.ok) {
      return this.quarantineUnsupported(transaction, inbox?.id, event, classification, now);
    }
    const stream = classification.event;

    const prior = await this.cursorRow(
      transaction,
      event.tenantId,
      aggregateType,
      event.aggregateId,
    );
    const appliedAtIncoming =
      prior && event.aggregateVersion < prior.aggregateVersion
        ? await this.cursorRow(
            transaction,
            event.tenantId,
            aggregateType,
            event.aggregateId,
            event.aggregateVersion,
          )
        : undefined;
    const position = classifyGovernanceStreamPosition({
      ...(prior
        ? {
            cursor: {
              version: prior.aggregateVersion,
              digest: comparable(prior, stream, payloadHash),
            },
          }
        : {}),
      ...(appliedAtIncoming
        ? {
            appliedAtIncomingVersion: {
              digest: comparable(appliedAtIncoming, stream, payloadHash),
            },
          }
        : {}),
      incoming: { version: event.aggregateVersion, digest: payloadHash },
    });

    switch (position.kind) {
      case 'DUPLICATE':
      case 'SUPERSEDED':
        // version นี้ apply แล้ว (หรือถูก canonical reload ข้ามไป) — บันทึก completion ของ eventId
        // นี้โดยไม่ขยับ cursor และไม่ส่ง acknowledgement ซ้ำ
        this.metrics.increment('journey_cg4_duplicate_total');
        await this.recordInbox(transaction, inbox?.id, event, aggregateType, payloadHash, {
          state: 'DUPLICATE',
          affectedCount: 0,
          now,
          ...(position.kind === 'SUPERSEDED' ? { reasonCode: 'SUPERSEDED_BY_RELOAD' } : {}),
        });
        return { outcome: 'NO_OP', affectedCount: 0, state: 'DUPLICATE' };
      case 'HASH_CONFLICT': {
        this.metrics.increment('journey_cg3_hash_conflict_total');
        const held = await this.holdMatchingActions(
          transaction,
          event,
          stream.scope,
          payloadHash,
          now,
        );
        return this.complete(
          transaction,
          inbox?.id,
          event,
          aggregateType,
          payloadHash,
          'QUARANTINED',
          held,
          now,
          {
            reasonCode: 'EVENT_HASH_CONFLICT',
          },
        );
      }
      case 'GAP':
        this.metrics.increment('journey_cg3_version_gap_total');
        await this.holdMatchingActions(transaction, event, stream.scope, payloadHash, now);
        await this.recordInbox(transaction, inbox?.id, event, aggregateType, payloadHash, {
          state: 'GAP',
          affectedCount: 0,
          now,
          reasonCode: 'EVENT_GAP',
        });
        return { outcome: 'FAILED', affectedCount: 0, state: 'GAP' };
      case 'APPLY':
        break;
    }

    if (stream.effect === 'NO_OP') {
      // relaxation และ activation ที่ยังไม่ถึงเวลาไม่แตะงานใดเลย: งานที่ HELD/DEFERRED/CANCELLED
      // ต้องรอ owner ตัดสินใหม่ ไม่ถูก resume หรือ retry จาก event ที่ผ่อนลง
      if (stream.restrictiveness === 'RELAXATION') {
        this.metrics.increment('journey_cg4_relaxation_noop_total');
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
        {
          appliedStateDigest: stream.stateDigest,
        },
      );
    }

    const actions = await this.actionsFor(transaction, event, stream.scope);
    const revalidationPayload = toRevalidationPayload(stream);
    let affectedCount = 0;
    let bindingMissing = false;
    for (const action of actions) {
      let decision: JourneyRevalidationDecision;
      if (stream.effect === 'HOLD_SCOPE') {
        this.metrics.increment('journey_cg4_kill_switch_hold_total');
        decision = { decision: 'REVIEW', reasonCode: GOVERNANCE_KILL_SWITCH_ACTIVE };
      } else {
        decision = await this.revalidator.revalidate({
          tenantId: event.tenantId,
          action,
          event: revalidationPayload,
          source: {
            aggregateType,
            aggregateId: event.aggregateId,
            aggregateVersion: event.aggregateVersion,
            correlationId: event.correlationId,
            contract: stream.family,
            eventType: stream.eventType,
            ...(stream.scope.scopeKey ? { scopeKey: stream.scope.scopeKey } : {}),
          },
        });
      }
      const state = targetState(decision);
      if ('reasonCode' in decision && decision.reasonCode === 'GOVERNANCE_VERSION_STALE') {
        this.metrics.increment('journey_cg3_stale_revalidation_total');
      }
      if (!state) {
        await transaction.jrAction.update({
          where: { id: action.id },
          data: {
            appliedAggregateVersion: event.aggregateVersion,
            appliedPayloadHash: payloadHash,
          },
        });
        continue;
      }
      affectedCount += 1;
      if (PRE_BARRIER_STATES.has(action.realtimeState)) {
        this.metrics.increment('journey_cg3_pre_barrier_cancellation_total');
        await this.stageEffect(transaction, event, action, 'RELEASE_BEFORE_BARRIER', now);
        await transaction.jrAction.update({
          where: { id: action.id },
          data: {
            realtimeState: state,
            ...(decision.decision === 'DEFER'
              ? { nextEligibleAt: new Date(decision.nextEligibleAt) }
              : {}),
            appliedAggregateVersion: event.aggregateVersion,
            appliedPayloadHash: payloadHash,
          },
        });
      } else if (POST_BARRIER_STATES.has(action.realtimeState)) {
        this.metrics.increment('journey_cg3_post_barrier_cancellation_total');
        if (!action.deliveryId || !action.providerRequestKey) {
          bindingMissing = true;
          await transaction.jrAction.update({
            where: { id: action.id },
            data: {
              realtimeState: 'HELD',
              appliedAggregateVersion: event.aggregateVersion,
              appliedPayloadHash: payloadHash,
            },
          });
          continue;
        }
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
      bindingMissing ? 'FAILED' : affectedCount === 0 ? 'NO_OP' : 'APPLIED',
      affectedCount,
      now,
      { appliedStateDigest: stream.stateDigest },
    );
  }

  /**
   * Canonical reload หลัง gap หรือ quarantine (#179 §4 "canonical reload/replay แล้วค่อย ack")
   *
   * ผู้เรียกอ่าน version/state digest ปัจจุบันจาก Contact Governance query API แล้วส่งเข้ามา
   * Journey บันทึก cursor ใหม่, audit และ acknowledgement ของ reload เท่านั้น — งานที่ถูก HELD
   * ระหว่างช่องว่างยังคง HELD เพราะ reload ไม่ใช่ approved result ของงานนั้น (#124 REVIEW)
   */
  async resumeFromCanonical(input: {
    tenantId: string;
    aggregateType: CgAggregateType;
    aggregateId: string;
    canonicalVersion: number;
    canonicalStateDigest: string;
    actorId: string;
    reasonCode: string;
    evidenceRef?: string;
  }): Promise<{ cursorVersion: number; reloaded: boolean; heldActions: number }> {
    if (!Number.isInteger(input.canonicalVersion) || input.canonicalVersion < 1) {
      throw new TypeError('canonicalVersion ต้องเป็น positive integer');
    }
    if (!/^[a-f0-9]{64}$/.test(input.canonicalStateDigest)) {
      throw new TypeError('canonicalStateDigest ต้องเป็น SHA-256 lowercase');
    }
    const aggregateTypeName =
      input.aggregateType === 'CONTACT'
        ? 'contact_governance_contact'
        : 'contact_governance_policy';
    const result = await withTenantDatabaseTransaction(
      this.database,
      input.tenantId,
      async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`journey-cg3:${this.options.consumer}:${input.tenantId}:${aggregateTypeName}:${input.aggregateId}`}))`,
        );
        const heldActions = await transaction.jrAction.count({
          where: {
            tenantId: input.tenantId,
            realtimeState: 'HELD',
            ...(input.aggregateType === 'CONTACT' ? { contactId: input.aggregateId } : {}),
          },
        });
        const prior = await this.cursorRow(
          transaction,
          input.tenantId,
          input.aggregateType,
          input.aggregateId,
        );
        if (prior && prior.aggregateVersion >= input.canonicalVersion) {
          const atVersion =
            prior.aggregateVersion === input.canonicalVersion
              ? prior
              : await this.cursorRow(
                  transaction,
                  input.tenantId,
                  input.aggregateType,
                  input.aggregateId,
                  input.canonicalVersion,
                );
          if (
            atVersion?.reasonCode === CANONICAL_RELOAD_REASON &&
            atVersion.payloadHash !== input.canonicalStateDigest
          ) {
            throw new JourneyCanonicalReloadConflictError(
              input.aggregateId,
              input.canonicalVersion,
            );
          }
          return {
            cursorVersion: prior.aggregateVersion,
            reloaded: false,
            heldActions,
          };
        }
        const eventId = randomUUID();
        const now = this.now();
        await transaction.jrGovernanceConsumerInbox.create({
          data: {
            id: randomUUID(),
            consumer: this.options.consumer,
            tenantId: input.tenantId,
            eventId,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            aggregateVersion: input.canonicalVersion,
            // reload รู้เพียง canonical state digest ไม่รู้ payload digest ของ event ที่หาย จึงเก็บ
            // state digest และเทียบกับ stateDigest ของ event ที่ส่งซ้ำภายหลัง
            payloadHash: input.canonicalStateDigest,
            state: 'NO_OP',
            reasonCode: CANONICAL_RELOAD_REASON,
            affectedCount: 0,
            appliedAt: now,
          },
        });
        await transaction.jrGovernanceAcknowledgementOutbox.create({
          data: {
            id: randomUUID(),
            tenantId: input.tenantId,
            eventId,
            consumer: this.options.consumer,
            aggregateType: input.aggregateType,
            aggregateId: input.aggregateId,
            appliedVersion: input.canonicalVersion,
            outcome: 'NO_OP',
            affectedCount: 0,
            sourcePayloadHash: input.canonicalStateDigest,
            appliedStateDigest: input.canonicalStateDigest,
            state: 'PENDING',
            availableAt: now,
          },
        });
        // audit อยู่ใน transaction เดียวกับ cursor/ack: reload ที่ไม่มีบันทึกว่าใครทำและเพราะอะไร
        // ต้องเกิดขึ้นไม่ได้ (J2-RC02 audited replay/reconcile)
        await transaction.jrRecoveryAudit.create({
          data: {
            id: randomUUID(),
            tenantId: input.tenantId,
            operation: 'RECONCILE',
            targetKind: 'RECEIPT',
            targetRef: eventId,
            reasonCode: input.reasonCode,
            actorId: input.actorId,
            ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
          },
        });
        return { cursorVersion: input.canonicalVersion, reloaded: true, heldActions };
      },
    );
    if (result.reloaded) this.metrics.increment('journey_cg4_canonical_reload_total');
    return result;
  }

  private async cursorRow(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    aggregateType: CgAggregateType,
    aggregateId: string,
    aggregateVersion?: number,
  ): Promise<CursorRow | undefined> {
    const row = await transaction.jrGovernanceConsumerInbox.findFirst({
      where: {
        consumer: this.options.consumer,
        tenantId,
        aggregateType,
        aggregateId,
        state: { in: CURSOR_STATES },
        ...(aggregateVersion === undefined ? {} : { aggregateVersion }),
      },
      orderBy: { aggregateVersion: 'desc' },
      select: { aggregateVersion: true, payloadHash: true, reasonCode: true },
    });
    return row ?? undefined;
  }

  /**
   * contract/version ที่ build นี้ตีความไม่ได้: ไม่มี scope ที่เชื่อถือได้ จึง hold งานทั้ง
   * aggregate (contact เดียว หรือทั้ง tenant สำหรับ policy stream) และไม่ขยับ cursor ทำให้
   * event ถัดไปเป็น gap จนกว่าจะ canonical reload
   */
  private async quarantineUnsupported(
    transaction: Prisma.TransactionClient,
    existingInboxId: string | undefined,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    rejection: GovernanceDownstreamRejection,
    now: Date,
  ): Promise<JourneyGovernanceApplyResult> {
    this.metrics.increment('journey_cg4_unsupported_contract_total');
    const held = await this.holdMatchingActions(
      transaction,
      event,
      null,
      rejection.payloadDigest,
      now,
    );
    return this.complete(
      transaction,
      existingInboxId,
      event,
      rejection.aggregate,
      rejection.payloadDigest,
      'QUARANTINED',
      held,
      now,
      { reasonCode: rejection.reason },
    );
  }

  private async actionsFor(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    scope: GovernanceDownstreamScope | null,
  ): Promise<JourneyRealtimeAction[]> {
    const rows = await transaction.jrAction.findMany({
      where: {
        tenantId: event.tenantId,
        realtimeState: { in: ACTIVE_ACTION_STATES },
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
    return rows
      .map((row): JourneyRealtimeAction => ({
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
      }))
      .filter(
        (action) =>
          !scope ||
          governanceScopeCovers(scope, {
            identityId: action.identityId,
            channel: action.channel,
            purpose: action.purpose,
            sourceTypes: JOURNEY_SOURCE_TYPES,
          }),
      );
  }

  private async holdMatchingActions(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    scope: GovernanceDownstreamScope | null,
    payloadHash: string,
    now: Date,
  ): Promise<number> {
    const actions = await this.actionsFor(transaction, event, scope);
    if (actions.length === 0) return 0;
    await transaction.jrAction.updateMany({
      where: { id: { in: actions.map((action) => action.id) } },
      data: {
        realtimeState: 'HELD',
        appliedAggregateVersion: event.aggregateVersion,
        appliedPayloadHash: payloadHash,
        cancelRequestedAt: now,
      },
    });
    return actions.length;
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

  private async recordInbox(
    transaction: Prisma.TransactionClient,
    existingInboxId: string | undefined,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    aggregateType: CgAggregateType,
    payloadHash: string,
    row: {
      state: JrGovernanceConsumerState;
      affectedCount: number;
      now: Date;
      reasonCode?: string;
    },
  ): Promise<void> {
    const data = {
      consumer: this.options.consumer,
      tenantId: event.tenantId,
      eventId: event.eventId,
      aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      payloadHash,
      state: row.state,
      affectedCount: row.affectedCount,
      appliedAt: row.now,
      reasonCode: row.reasonCode ?? null,
    };
    if (existingInboxId) {
      await transaction.jrGovernanceConsumerInbox.update({ where: { id: existingInboxId }, data });
    } else {
      await transaction.jrGovernanceConsumerInbox.create({ data: { id: randomUUID(), ...data } });
    }
  }

  private async complete(
    transaction: Prisma.TransactionClient,
    existingInboxId: string | undefined,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    aggregateType: CgAggregateType,
    payloadHash: string,
    outcome: Extract<CgConsumerAckOutcome, 'APPLIED' | 'NO_OP' | 'FAILED' | 'QUARANTINED'>,
    affectedCount: number,
    now: Date,
    options: CompleteOptions = {},
  ): Promise<JourneyGovernanceApplyResult> {
    const eventAt = new Date(event.occurredAt).getTime();
    if (!Number.isNaN(eventAt)) {
      this.metrics.observe('journey_cg3_mutation_to_apply_ms', now.getTime() - eventAt);
    }
    const state = outcome === 'APPLIED' ? 'APPLIED' : outcome === 'NO_OP' ? 'NO_OP' : 'QUARANTINED';
    await this.recordInbox(transaction, existingInboxId, event, aggregateType, payloadHash, {
      state,
      affectedCount,
      now,
      ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
    });
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
        ...(options.appliedStateDigest ? { appliedStateDigest: options.appliedStateDigest } : {}),
        state: 'PENDING',
        availableAt: now,
      },
      update: {},
    });
    return {
      outcome,
      affectedCount,
      state,
      ...(isGovernanceContractRejection(options.reasonCode)
        ? { reasonCode: options.reasonCode }
        : {}),
    };
  }
}

/**
 * แถวที่มาจาก canonical reload เก็บ state digest ไว้แทน payload digest จึงต้องเทียบกับ
 * stateDigest ของ event ที่เข้ามา; แถวปกติเทียบ payload digest ตามเดิม
 */
function comparable(
  row: CursorRow,
  stream: GovernanceDownstreamEvent,
  payloadHash: string,
): string {
  if (row.reasonCode !== CANONICAL_RELOAD_REASON) return row.payloadHash;
  return row.payloadHash === stream.stateDigest ? payloadHash : row.payloadHash;
}

/** คงไว้ให้ test/tooling เดิมคำนวณ digest แบบเดียวกับ inbox */
export const journeyGovernancePayloadDigest = governancePayloadDigest;
