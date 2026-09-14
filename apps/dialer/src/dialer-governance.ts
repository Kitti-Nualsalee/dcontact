/**
 * S1.7 — Dialer consumer ของ CG3 realtime invalidation
 * CG4.8 (#191) — ขยายให้รับ CG4 exception/policy/kill-switch events บน stream เดียวกัน
 *
 * Dialer เป็นเจ้าของ Campaign/Callback attempt และเป็นผู้ cancel/defer/park/hold ก่อน barrier
 * หรือขอ reconcile หลัง barrier (#124) โดยไม่สร้าง decision หรือ reservation เอง; relaxation
 * ไม่ resume หรือ retry attempt เดิม และสายที่กำลังคุยไม่ถูกตัดเพียงแต่ block outbound ถัดไป
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgAggregateType,
  type CgConsumerAckOutcome,
  type ObAttemptRealtimeState,
  type ObGovernanceConsumerState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import {
  actionKey as toActionKey,
  classifyGovernanceEvent,
  classifyGovernanceStreamPosition,
  isGovernanceContractRejection,
  GOVERNANCE_KILL_SWITCH_ACTIVE,
  governanceScopeCovers,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactChannel,
  type ContactGovernancePort,
  type ContactGovernanceRevalidationPort,
  type GovernanceDownstreamEvent,
  type GovernanceDownstreamScope,
} from '@d-contact/cxa-contracts';

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
const CURSOR_STATES: ObGovernanceConsumerState[] = ['APPLIED', 'NO_OP'];
/** attempt ของ Dialer มาจาก campaign หรือ callback ที่ Dialer originate */
const DIALER_SOURCE_TYPES = Object.freeze(['DIALER', 'CAMPAIGN']);
export const DIALER_CANONICAL_RELOAD_REASON = 'CANONICAL_RELOAD' as const;

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
      /** CG4.8: ให้ Governance ใช้ version authority ของ event family นั้น */
      contract?: 'CG3' | 'CG4';
      eventType?: string;
      scopeKey?: string;
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
        ...(source.contract ? { sourceContract: source.contract } : {}),
        ...(source.eventType ? { sourceEventType: source.eventType } : {}),
        ...(source.scopeKey ? { sourceScopeKey: source.scopeKey } : {}),
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
  state: 'APPLIED' | 'NO_OP' | 'GAP' | 'QUARANTINED' | 'DUPLICATE';
  /** controlled reason เมื่อ quarantine ไม่มี payload หรือ PII */
  reasonCode?: string;
};

export class DialerCanonicalReloadConflictError extends Error {
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
export function parseDialerCg3EventPayload(value: unknown): DialerCg3EventPayloadV1 {
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
  if (!classification?.ok) throw new TypeError(classification?.detail ?? 'CG3 payload ไม่ถูกต้อง');
  return toRevalidationPayload(classification.event);
}

function toRevalidationPayload(event: GovernanceDownstreamEvent): DialerCg3EventPayloadV1 {
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

function targetState(decision: DialerRevalidationDecision): ObAttemptRealtimeState | undefined {
  if (decision.decision === 'BLOCK') return 'CANCELLED';
  if (decision.decision === 'DEFER') return 'DEFERRED';
  if (decision.decision === 'TIMEZONE_UNKNOWN') return 'PARKED';
  if (decision.decision === 'REVIEW') return 'HELD';
  return undefined;
}

type CursorRow = { aggregateVersion: number; payloadHash: string; reasonCode: string | null };

/** แถวจาก canonical reload เก็บ state digest จึงเทียบกับ stateDigest ของ event ที่ส่งซ้ำ */
function comparable(
  row: CursorRow,
  stream: GovernanceDownstreamEvent,
  payloadHash: string,
): string {
  if (row.reasonCode !== DIALER_CANONICAL_RELOAD_REASON) return row.payloadHash;
  return row.payloadHash === stream.stateDigest ? payloadHash : row.payloadHash;
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
    if (event.eventKind !== 'CANONICAL') {
      throw new TypeError('Dialer รับเฉพาะ Contact Governance canonical event');
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
    const existing = await transaction.obGovernanceConsumerInbox.findUnique({
      where: {
        consumer_tenantId_eventId: {
          consumer: this.options.consumer,
          tenantId: event.tenantId,
          eventId: event.eventId,
        },
      },
      select: { id: true, state: true, reasonCode: true },
    });
    if (existing && existing.state !== 'GAP') {
      return {
        outcome:
          existing.state === 'QUARANTINED'
            ? 'FAILED'
            : existing.state === 'APPLIED'
              ? 'APPLIED'
              : 'NO_OP',
        affectedCount: 0,
        state: existing.state,
        ...(isGovernanceContractRejection(existing.reasonCode ?? undefined)
          ? { reasonCode: existing.reasonCode as string }
          : {}),
      };
    }
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`dialer-cg3:${this.options.consumer}:${event.tenantId}:${event.aggregateType}:${event.aggregateId}`}))`,
    );

    if (!classification.ok) {
      // contract ที่ตีความไม่ได้ไม่มี scope ที่เชื่อถือได้: hold ทั้ง aggregate และไม่ขยับ cursor
      this.metrics.increment('dialer_cg4_unsupported_contract_total');
      const held = await this.holdMatchingAttempts(transaction, event, null, now);
      return this.complete(
        transaction,
        existing?.id,
        event,
        aggregateType,
        payloadHash,
        'FAILED',
        held,
        now,
        {
          state: 'QUARANTINED',
          reasonCode: classification.reason,
        },
      );
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
        this.metrics.increment('dialer_cg4_duplicate_total');
        await this.recordInbox(transaction, existing?.id, event, aggregateType, payloadHash, {
          state: 'DUPLICATE',
          affectedCount: 0,
          now,
          ...(position.kind === 'SUPERSEDED' ? { reasonCode: 'SUPERSEDED_BY_RELOAD' } : {}),
        });
        return { outcome: 'NO_OP', affectedCount: 0, state: 'DUPLICATE' };
      case 'HASH_CONFLICT':
        this.metrics.increment('dialer_cg3_hash_conflict_total');
        await this.holdMatchingAttempts(transaction, event, stream.scope, now);
        return this.complete(
          transaction,
          existing?.id,
          event,
          aggregateType,
          payloadHash,
          'FAILED',
          0,
          now,
          {
            state: 'QUARANTINED',
            reasonCode: 'EVENT_HASH_CONFLICT',
          },
        );
      case 'GAP':
        this.metrics.increment('dialer_cg3_version_gap_total');
        await this.holdMatchingAttempts(transaction, event, stream.scope, now);
        await this.recordInbox(transaction, existing?.id, event, aggregateType, payloadHash, {
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
      // relaxation ไม่แตะ attempt ใดเลย: HELD/DEFERRED/CANCELLED และ nextOutboundBlocked คงเดิม
      if (stream.restrictiveness === 'RELAXATION') {
        this.metrics.increment('dialer_cg4_relaxation_noop_total');
      }
      return this.complete(
        transaction,
        existing?.id,
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

    const revalidationPayload = toRevalidationPayload(stream);
    let affectedCount = 0;
    let bindingMissing = false;
    for (const attempt of await this.attemptsFor(transaction, event, stream.scope)) {
      let decision: DialerRevalidationDecision;
      if (stream.effect === 'HOLD_SCOPE') {
        this.metrics.increment('dialer_cg4_kill_switch_hold_total');
        decision = { decision: 'REVIEW', reasonCode: GOVERNANCE_KILL_SWITCH_ACTIVE };
      } else {
        decision = await this.revalidator.revalidate({
          tenantId: event.tenantId,
          attempt,
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
      { appliedStateDigest: stream.stateDigest },
    );
  }

  /**
   * Canonical reload หลัง gap หรือ quarantine: ขยับ cursor ไปยัง version ที่อ่านจาก Contact
   * Governance แล้วส่ง acknowledgement ของ reload; attempt ที่ HELD ยังคง HELD (ไม่ auto-resume)
   */
  async resumeFromCanonical(input: {
    tenantId: string;
    aggregateType: CgAggregateType;
    aggregateId: string;
    canonicalVersion: number;
    canonicalStateDigest: string;
  }): Promise<{ cursorVersion: number; reloaded: boolean; heldAttempts: number }> {
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
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`dialer-cg3:${this.options.consumer}:${input.tenantId}:${aggregateTypeName}:${input.aggregateId}`}))`,
      );
      const heldAttempts = await transaction.obAttempt.count({
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
          atVersion?.reasonCode === DIALER_CANONICAL_RELOAD_REASON &&
          atVersion.payloadHash !== input.canonicalStateDigest
        ) {
          throw new DialerCanonicalReloadConflictError(input.aggregateId, input.canonicalVersion);
        }
        return { cursorVersion: prior.aggregateVersion, reloaded: false, heldAttempts };
      }
      const eventId = randomUUID();
      const now = this.now();
      await transaction.obGovernanceConsumerInbox.create({
        data: {
          id: randomUUID(),
          consumer: this.options.consumer,
          tenantId: input.tenantId,
          eventId,
          aggregateType: input.aggregateType,
          aggregateId: input.aggregateId,
          aggregateVersion: input.canonicalVersion,
          payloadHash: input.canonicalStateDigest,
          state: 'NO_OP',
          reasonCode: DIALER_CANONICAL_RELOAD_REASON,
          affectedCount: 0,
          appliedAt: now,
        },
      });
      await transaction.obGovernanceAcknowledgementOutbox.create({
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
          availableAt: now,
        },
      });
      this.metrics.increment('dialer_cg4_canonical_reload_total');
      return { cursorVersion: input.canonicalVersion, reloaded: true, heldAttempts };
    });
  }

  private async cursorRow(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    aggregateType: CgAggregateType,
    aggregateId: string,
    aggregateVersion?: number,
  ): Promise<CursorRow | undefined> {
    const row = await transaction.obGovernanceConsumerInbox.findFirst({
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

  private async attemptsFor(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    scope: GovernanceDownstreamScope | null,
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
    return rows.filter(
      (row) =>
        !scope ||
        governanceScopeCovers(scope, {
          identityId: row.identityId,
          channel: row.channel,
          purpose: row.purpose,
          sourceTypes: DIALER_SOURCE_TYPES,
        }),
    );
  }

  private async holdMatchingAttempts(
    transaction: Prisma.TransactionClient,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    scope: GovernanceDownstreamScope | null,
    now: Date,
  ): Promise<number> {
    const attempts = await this.attemptsFor(transaction, event, scope);
    for (const attempt of attempts) {
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
    return attempts.length;
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

  private async recordInbox(
    transaction: Prisma.TransactionClient,
    existingId: string | undefined,
    event: KafkaEventEnvelopeV2<Record<string, unknown>>,
    aggregateType: CgAggregateType,
    payloadHash: string,
    row: {
      state: ObGovernanceConsumerState;
      affectedCount: number;
      now: Date;
      reasonCode?: string;
    },
  ): Promise<void> {
    const data = {
      aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: event.aggregateVersion,
      payloadHash,
      state: row.state,
      affectedCount: row.affectedCount,
      appliedAt: row.now,
      reasonCode: row.reasonCode ?? null,
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
    options: { state?: 'QUARANTINED'; reasonCode?: string; appliedStateDigest?: string } = {},
  ): Promise<DialerGovernanceApplyResult> {
    const state: 'APPLIED' | 'NO_OP' | 'QUARANTINED' =
      options.state ?? (outcome === 'NO_OP' ? 'NO_OP' : 'APPLIED');
    await this.recordInbox(transaction, existingId, event, aggregateType, payloadHash, {
      state,
      affectedCount,
      now,
      ...(options.reasonCode ? { reasonCode: options.reasonCode } : {}),
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
        ...(options.appliedStateDigest ? { appliedStateDigest: options.appliedStateDigest } : {}),
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
