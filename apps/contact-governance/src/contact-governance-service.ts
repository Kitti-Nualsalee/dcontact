import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgCallbackMode,
  type CgDecision,
  type CgReservationState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import { evaluateContactPolicy, type ContactPolicyTraceEntry } from './contact-policy.js';
import {
  evaluateCg3Policy,
  type Cg3GateOutcome,
  type Cg3PolicyFacts,
} from './cg3-policy-evaluator.js';
import { loadCg3Facts } from './cg3-fact-loader.js';
import { toCg4PolicyBinding } from './cg4-exception-evaluation.js';
import { buildCg4PolicyScopeKey, parseCg4PolicyScopeKey } from './cg4-policy-compiler.js';
import {
  cg4PolicyFailClosedOutcome,
  cg4ShadowDecisionDigest,
  loadCg4PolicyFacts,
  type Cg4PolicyReadResult,
} from './cg4-policy-reader.js';
import type { Cg4PolicyRequestScope } from './cg4-policy-resolution.js';
import {
  cg4PolicyReaderFor,
  cg4PolicyRequestScope,
  GOVERNANCE_SHADOW_MISMATCH,
  loadCg4RolloutState,
} from './cg4-rollout.js';
import {
  CG4_CONTRACT_VERSION,
  CG4_EVENT_TYPES,
  GOVERNANCE_KILL_SWITCH_ACTIVE,
  type Cg4PolicyBinding,
} from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';
import { transitionReservation, type ReservationCommand } from './reservation.js';
import { ReservationRuntime, type ReservationRuntimeOptions } from './reservation-runtime.js';

import {
  IdempotencyConflictError,
  ReservationBindingError,
  ReservationNotFoundError,
  ReservationNotUsableError,
  type AuthorizeAndReserveInput,
  type AuthorizationOutcome,
  type Cg4DecisionTracePinsV1,
  type ContactAuthorizationPort,
  type ContactGovernancePort,
  type ContactGovernanceRevalidationPort,
  type ContactTouchCorrelationPort,
  type AcceptedAttemptView,
  type CorrelatedTouchView,
  type DeliveryId,
  type TenantId,
  type RecordCorrelatedTouchInput,
  type ClaimReservationForDeliveryInput,
  type RenewReservationLeaseInput,
  type BeginProviderSubmissionInput,
  type ConfirmProviderAcceptanceInput,
  type ReleaseBeforeSubmitInput,
  type SettleDeliveryInput,
  type ReservationSettlementView,
  type ReservationView,
  type RevalidateAuthorizedActionInput,
  type RevalidateAuthorizedActionOutcome,
} from '@d-contact/cxa-contracts';
export {
  IdempotencyConflictError,
  ReservationNotFoundError,
  ReservationNotUsableError,
  type AuthorizeAndReserveInput,
  type AuthorizationOutcome,
  type ReservationNotUsableCode,
  type ReservationView,
} from '@d-contact/cxa-contracts';

const RESERVATION_TTL_MS = 15 * 60 * 1_000;

/**
 * CG4.8 (#191): kill switch ครอบ reservation เมื่อทุก dimension ที่ scope ผูกไว้ตรงกัน
 * scopeKey ที่อ่านไม่ออก หรือ dimension ที่ reservation ไม่มีค่า ถือว่าครอบแบบ fail closed
 */
function killSwitchCoversReservation(
  scopeKey: string,
  reservation: {
    contactId: string;
    channel: string;
    purpose: string;
    source: string;
    authorizationContactKind: string | null;
  },
): boolean {
  if (scopeKey.startsWith('contact:')) return scopeKey === `contact:${reservation.contactId}`;
  let dimensions: Readonly<Record<string, string | undefined>>;
  try {
    dimensions = parseCg4PolicyScopeKey(scopeKey);
  } catch {
    return true;
  }
  const request: Readonly<Record<string, string | undefined>> = {
    channel: reservation.channel,
    purpose: reservation.purpose,
    sourceType: reservation.source,
    contactKind: reservation.authorizationContactKind ?? undefined,
  };
  return Object.entries(dimensions).every(
    ([dimension, value]) => request[dimension] === undefined || request[dimension] === value,
  );
}

/** ผลฝั่ง CG4 ของ shadow evaluation: reader ที่ fail closed ถือเป็นผล REVIEW ที่นำมาเทียบได้ */
function shadowOutcome(
  read: Cg4PolicyReadResult,
  evaluate: (policy: Cg3PolicyFacts | undefined) => Cg3GateOutcome,
): Cg3GateOutcome {
  if (read.outcome === 'FAIL_CLOSED') return cg4PolicyFailClosedOutcome('POLICY_HEAD', read.reason);
  return evaluate(read.outcome === 'RESOLVED' ? read.facts : undefined);
}

/** scope ของ request เป็น opaque dimension key สำหรับหลักฐาน mismatch (ไม่มี contact identity) */
function requestScopeKey(request: Cg4PolicyRequestScope): string {
  try {
    return buildCg4PolicyScopeKey({ ...request });
  } catch {
    return `channel=${request.channel ?? '*'}|purpose=${request.purpose ?? '*'}`;
  }
}

export interface ContactGovernanceServiceOptions extends ReservationRuntimeOptions {}

const decisionSelection = {
  id: true,
  inputHash: true,
  decision: true,
  reasonCode: true,
  policyVersion: true,
  trace: true,
  aggregateVersion: true,
  preferenceVersion: true,
  nextEligibleAt: true,
  timezoneSource: true,
  matchedScope: true,
  matchedWindowRef: true,
  exceptionMode: true,
  exceptionRef: true,
  cg4: true,
  reservation: {
    select: {
      id: true,
      expiresAt: true,
    },
  },
} as const;

const reservationSelection = {
  id: true,
  state: true,
  expiresAt: true,
  confirmedAt: true,
  releasedAt: true,
  refundedAt: true,
  deliveryId: true,
  providerRequestKey: true,
  submissionStartedAt: true,
} as const;

function hashAuthorizationInput(input: AuthorizeAndReserveInput): string {
  const canonicalInput = JSON.stringify({
    actionKey: input.actionKey,
    channel: input.channel,
    contactId: input.contactId,
    identityId: input.identityId ?? null,
    policyVersion: input.policyVersion,
    purpose: input.purpose,
    source: input.source,
    sourceId: input.sourceId,
    teamId: input.teamId ?? null,
    contactKind: input.contactKind ?? null,
    senderIdentityId: input.senderIdentityId ?? null,
    ...(input.identityResolution ? { identityResolution: input.identityResolution } : {}),
  });
  return createHash('sha256').update(canonicalInput).digest('hex');
}

function toOutcome(decision: {
  id: string;
  decision: CgDecision;
  reasonCode: string;
  policyVersion: number;
  trace: Prisma.JsonValue;
  aggregateVersion: number | null;
  preferenceVersion: number | null;
  nextEligibleAt: Date | null;
  timezoneSource: string | null;
  matchedScope: Prisma.JsonValue;
  matchedWindowRef: string | null;
  exceptionMode: string | null;
  exceptionRef: string | null;
  cg4: Prisma.JsonValue;
  reservation: { id: string; expiresAt: Date } | null;
}): AuthorizationOutcome {
  return {
    decisionId: decision.id,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    policyVersion: decision.policyVersion,
    trace: decision.trace as unknown as ContactPolicyTraceEntry[],
    ...(decision.aggregateVersion !== null ? { aggregateVersion: decision.aggregateVersion } : {}),
    ...(decision.preferenceVersion !== null
      ? { preferenceVersion: decision.preferenceVersion }
      : {}),
    ...(decision.nextEligibleAt ? { nextEligibleAt: decision.nextEligibleAt.toISOString() } : {}),
    ...(decision.timezoneSource ? { timezoneSource: decision.timezoneSource } : {}),
    ...(decision.matchedScope
      ? { matchedScope: decision.matchedScope as unknown as Record<string, string | null> }
      : {}),
    ...(decision.matchedWindowRef ? { matchedWindowRef: decision.matchedWindowRef } : {}),
    ...(decision.exceptionMode
      ? { exceptionMode: decision.exceptionMode as AuthorizationOutcome['exceptionMode'] }
      : {}),
    ...(decision.exceptionRef ? { exceptionRef: decision.exceptionRef } : {}),
    ...(decision.cg4 ? { cg4: decision.cg4 as unknown as Cg4DecisionTracePinsV1 } : {}),
    ...(decision.reservation
      ? {
          reservationId: decision.reservation.id,
          reservationExpiresAt: decision.reservation.expiresAt.toISOString(),
        }
      : {}),
  };
}

function toReservationView(reservation: {
  id: string;
  state: CgReservationState;
  expiresAt: Date;
  confirmedAt: Date | null;
  releasedAt: Date | null;
  refundedAt: Date | null;
}): ReservationView {
  return {
    id: reservation.id,
    state: reservation.state,
    expiresAt: reservation.expiresAt.toISOString(),
    ...(reservation.confirmedAt ? { confirmedAt: reservation.confirmedAt.toISOString() } : {}),
    ...(reservation.releasedAt ? { releasedAt: reservation.releasedAt.toISOString() } : {}),
    ...(reservation.refundedAt ? { refundedAt: reservation.refundedAt.toISOString() } : {}),
  };
}

export class ContactGovernanceService
  implements
    ContactAuthorizationPort<Prisma.TransactionClient>,
    ContactGovernancePort,
    ContactTouchCorrelationPort,
    ContactGovernanceRevalidationPort
{
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly reservationRuntime: ReservationRuntime;

  constructor(
    private readonly database: PrismaClient,
    options: ContactGovernanceServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.reservationRuntime = new ReservationRuntime(database, {
      ...options,
      now: this.now,
      id: this.id,
    });
  }

  claimReservationForDelivery(
    input: ClaimReservationForDeliveryInput,
  ): Promise<ReservationSettlementView> {
    return this.reservationRuntime.claim(input);
  }

  renewReservationLease(input: RenewReservationLeaseInput): Promise<ReservationSettlementView> {
    return this.reservationRuntime.renew(input);
  }

  beginProviderSubmission(input: BeginProviderSubmissionInput): Promise<ReservationSettlementView> {
    return this.reservationRuntime.beginSubmission(input);
  }

  confirmProviderAcceptance(
    input: ConfirmProviderAcceptanceInput,
  ): Promise<ReservationSettlementView> {
    return this.reservationRuntime.confirm(input);
  }

  releaseBeforeSubmit(input: ReleaseBeforeSubmitInput): Promise<ReservationSettlementView> {
    return this.reservationRuntime.release(input);
  }

  settleDelivery(input: SettleDeliveryInput): Promise<ReservationSettlementView> {
    return this.reservationRuntime.settle(input);
  }

  /**
   * S2.2 (#364): Contact Governance เป็นผู้เขียน Touch จาก explicit response แต่ผู้เดียว
   * Channels ส่ง binding + evidence ref เข้ามาเท่านั้น ห้ามส่ง Boolean หรือเขียน cg_* เอง
   */
  recordCorrelatedTouch(input: RecordCorrelatedTouchInput): Promise<CorrelatedTouchView> {
    return this.reservationRuntime.recordCorrelatedTouch(input);
  }

  /** S2.6b (#403): Channels ใช้ประกอบ binding ของ Touch โดยไม่อ่าน `cg_*` เอง */
  findAcceptedAttempt(input: {
    tenantId: TenantId;
    deliveryId: DeliveryId;
  }): Promise<AcceptedAttemptView | null> {
    return this.reservationRuntime.findAcceptedAttempt(input);
  }

  /**
   * ประเมินสิทธิ์ของ reservation เดิมกับ canonical facts ปัจจุบันโดยไม่สร้าง fact ใหม่
   * Journey เป็นเจ้าของผล at-least-once และ acknowledgement ของการเรียกนี้เอง
   */
  async revalidateAuthorizedAction(
    input: RevalidateAuthorizedActionInput,
  ): Promise<RevalidateAuthorizedActionOutcome> {
    const tenantId = input.tenantId;
    const digest = (
      decision: RevalidateAuthorizedActionOutcome['decision'],
      reasonCode: string,
      aggregateVersion: number,
      policyVersion?: number,
    ) =>
      createHash('sha256')
        .update(
          JSON.stringify({
            decision,
            reasonCode,
            aggregateVersion,
            policyVersion: policyVersion ?? null,
          }),
        )
        .digest('hex');
    const review = (
      reasonCode: string,
      aggregateVersion: number,
      policyVersion?: number,
    ): RevalidateAuthorizedActionOutcome => ({
      decision: 'REVIEW',
      reasonCode,
      observedAggregateVersion: aggregateVersion,
      ...(policyVersion !== undefined ? { observedPolicyVersion: policyVersion } : {}),
      decisionDigest: digest('REVIEW', reasonCode, aggregateVersion, policyVersion),
    });

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const reservation = await transaction.cgReservation.findFirst({
        where: { id: input.reservationId, tenantId, actionKey: input.actionKey },
        select: {
          source: true,
          sourceId: true,
          contactId: true,
          identityId: true,
          channel: true,
          purpose: true,
          senderIdentityId: true,
          authorizationContactKind: true,
          authorizationContextVersion: true,
        },
      });
      if (!reservation) return review('GOVERNANCE_CONTEXT_UNAVAILABLE', 0);
      // context ที่ไม่มี version คือข้อมูลก่อน S1.5: หยุดไว้เพื่อไม่อนุญาตจาก binding ที่พิสูจน์ไม่ได้.
      // contactKind=null ที่ถูกบันทึกพร้อม version 1 เป็น wildcard ที่มีความหมายชัดเจน.
      if (
        reservation.authorizationContextVersion !== 1 ||
        (input.contactKind ?? null) !== reservation.authorizationContactKind
      ) {
        return review('GOVERNANCE_CONTEXT_UNAVAILABLE', 0);
      }
      if (
        input.sourceAggregateVersion < 1 ||
        (input.sourceAggregateType === 'CONTACT' &&
          input.sourceAggregateId !== reservation.contactId)
      ) {
        return review('GOVERNANCE_CONTEXT_UNAVAILABLE', 0);
      }

      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`contact:${tenantId}:${reservation.contactId}`}))`,
      );
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg3-contact:${tenantId}:${reservation.contactId}`}))`,
      );
      // CG4.8 (#191): ลำดับ lock เดียวกับ authorizeAndReserve เพื่อ serialize กับ revoke/expiry
      // ของ exception และไม่สร้างลำดับ lock ใหม่ที่ deadlock ได้
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg4-contact:${tenantId}:${reservation.contactId}`}))`,
      );
      const now = this.now();
      const [identity, restriction, consent, facts] = await Promise.all([
        reservation.identityId
          ? transaction.contactIdentity.findFirst({
              where: { id: reservation.identityId, contactId: reservation.contactId, tenantId },
              select: { id: true },
            })
          : Promise.resolve({ id: reservation.contactId }),
        transaction.cgRestriction.findFirst({
          where: {
            tenantId,
            startsAt: { lte: now },
            AND: [
              { OR: [{ contactId: null }, { contactId: reservation.contactId }] },
              reservation.identityId
                ? { OR: [{ identityId: null }, { identityId: reservation.identityId }] }
                : { identityId: null },
              { OR: [{ channel: null }, { channel: reservation.channel }] },
              { OR: [{ purpose: null }, { purpose: reservation.purpose }] },
              { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
            ],
          },
          orderBy: { startsAt: 'desc' },
          select: { type: true, reasonCode: true, overridable: true },
        }),
        transaction.cgConsent.findFirst({
          where: {
            tenantId,
            contactId: reservation.contactId,
            purpose: reservation.purpose,
            channel: reservation.channel,
            OR: reservation.identityId
              ? [{ identityId: null }, { identityId: reservation.identityId }]
              : [{ identityId: null }],
          },
          orderBy: { createdAt: 'desc' },
          select: { status: true, lawfulBasis: true, expiresAt: true },
        }),
        loadCg3Facts(transaction, {
          tenantId,
          contactId: reservation.contactId,
          identityId: reservation.identityId ?? undefined,
          channel: reservation.channel,
          purpose: reservation.purpose,
          contactKind: reservation.authorizationContactKind ?? undefined,
          now,
        }),
      ]);
      if (input.sourceContract === 'CG4' && input.sourceAggregateType === 'POLICY') {
        // CG4.8 (#191): CG4 policy event มี version ของ scope head และ kill switch มี aggregate ของ
        // ตัวเอง การเทียบกับ CG3 policy version จะตัดสินว่า stale ทุกครั้งแล้ว hold งานทั้ง tenant
        if (input.sourceEventType === CG4_EVENT_TYPES.KILL_SWITCH_CHANGED) {
          const killSwitch = await transaction.cg4ScopeKillSwitch.findFirst({
            where: { tenantId, id: input.sourceAggregateId },
            select: { id: true },
          });
          if (!killSwitch) {
            return review(
              'GOVERNANCE_STATE_UNAVAILABLE',
              facts.aggregateVersion,
              facts.policy?.version,
            );
          }
        } else {
          const head = input.sourceScopeKey
            ? await transaction.cg4PolicyScopeHead.findUnique({
                where: { tenantId_scopeKey: { tenantId, scopeKey: input.sourceScopeKey } },
                select: { headVersion: true },
              })
            : null;
          if (!head || head.headVersion < input.sourceAggregateVersion) {
            return review(
              'GOVERNANCE_VERSION_STALE',
              facts.aggregateVersion,
              facts.policy?.version,
            );
          }
        }
      } else if (
        (input.sourceAggregateType === 'CONTACT' &&
          facts.aggregateVersion < input.sourceAggregateVersion) ||
        (input.sourceAggregateType === 'POLICY' &&
          (facts.policy?.version ?? 0) < input.sourceAggregateVersion)
      ) {
        return review('GOVERNANCE_VERSION_STALE', facts.aggregateVersion, facts.policy?.version);
      }
      // CG4.8 (#191): kill switch เป็น non-overridable gate (#174 §2) ที่ re-authorization
      // ต้องเห็นเหมือน consumer ที่ได้ event; clear แล้วไม่ resume งานที่ hold ไว้
      const activeKillSwitches = await transaction.cg4ScopeKillSwitch.findMany({
        where: { tenantId, state: 'ACTIVE' },
        select: { scopeKey: true },
      });
      if (
        activeKillSwitches.some(({ scopeKey }) =>
          killSwitchCoversReservation(scopeKey, reservation),
        )
      ) {
        return review(GOVERNANCE_KILL_SWITCH_ACTIVE, facts.aggregateVersion, facts.policy?.version);
      }
      const baseline = evaluateContactPolicy({
        policyVersion: facts.policy?.version ?? 0,
        identityResolution: identity ? 'RESOLVED' : 'NOT_FOUND',
        ...(restriction
          ? {
              activeRestriction: {
                type: restriction.type,
                reasonCode: restriction.reasonCode,
                overridable: restriction.overridable,
              },
            }
          : {}),
        ...(consent
          ? {
              consent: {
                status:
                  consent.status === 'GRANTED' && consent.expiresAt && consent.expiresAt <= now
                    ? ('EXPIRED' as const)
                    : consent.status,
                lawfulBasis: consent.lawfulBasis,
              },
            }
          : {}),
      });
      if (baseline.decision !== 'ALLOW') {
        return {
          decision: baseline.decision,
          reasonCode: baseline.reasonCode,
          observedAggregateVersion: facts.aggregateVersion,
          ...(facts.policy ? { observedPolicyVersion: facts.policy.version } : {}),
          decisionDigest: digest(
            baseline.decision,
            baseline.reasonCode,
            facts.aggregateVersion,
            facts.policy?.version,
          ),
        };
      }
      const evaluate = (policy: Cg3PolicyFacts | undefined) =>
        evaluateCg3Policy({
          now,
          identityId: reservation.identityId ?? undefined,
          channel: reservation.channel,
          purpose: reservation.purpose,
          contactKind: reservation.authorizationContactKind ?? undefined,
          senderIdentityId: reservation.senderIdentityId ?? undefined,
          preferences: facts.preferences,
          policy,
          activeCallback: facts.activeCallback,
          // CG4.8 (#191): re-authorization ต้องเห็น exception ชุดเดียวกับ authorizeAndReserve
          // ไม่งั้นงานที่ได้รับอนุญาตผ่าน exception ที่ยัง active จะถูกยกเลิกจาก event อื่น
          source: reservation.source,
          sourceId: reservation.sourceId,
          activeExceptions: facts.activeExceptions,
        });
      // CG4.10 (#193): re-authorization ใช้ reader เดียวกับ authorizeAndReserve ภายใต้ rollout เดียวกัน
      // แต่ไม่บันทึก shadow mismatch เพราะการเรียกนี้ห้ามสร้าง fact ใหม่
      const policyRequest = cg4PolicyRequestScope({
        channel: reservation.channel,
        purpose: reservation.purpose,
        contactKind: reservation.authorizationContactKind,
        source: reservation.source,
      });
      const reader = cg4PolicyReaderFor(
        await loadCg4RolloutState(transaction, tenantId),
        policyRequest,
      );
      let cg3: Cg3GateOutcome;
      if (reader.mode === 'CG4') {
        const read = await loadCg4PolicyFacts(transaction, {
          tenantId,
          request: policyRequest,
          now,
        });
        if (read.outcome === 'FAIL_CLOSED') {
          return review(read.reason, facts.aggregateVersion, facts.policy?.version);
        }
        cg3 = evaluate(read.outcome === 'RESOLVED' ? read.facts : undefined);
      } else {
        cg3 = evaluate(facts.policy);
        if (reader.mode === 'CG3_WITH_SHADOW' && reader.pilot) {
          const read = await loadCg4PolicyFacts(transaction, {
            tenantId,
            request: policyRequest,
            now,
          });
          if (
            cg4ShadowDecisionDigest(cg3) !== cg4ShadowDecisionDigest(shadowOutcome(read, evaluate))
          ) {
            return review(
              GOVERNANCE_SHADOW_MISMATCH,
              facts.aggregateVersion,
              facts.policy?.version,
            );
          }
        }
      }
      const decision = cg3.decision ?? 'ALLOW';
      const reasonCode = cg3.reasonCode ?? 'POLICY_PASSED';
      return {
        decision,
        reasonCode,
        observedAggregateVersion: facts.aggregateVersion,
        ...(facts.policy ? { observedPolicyVersion: facts.policy.version } : {}),
        ...(cg3.nextEligibleAt ? { nextEligibleAt: cg3.nextEligibleAt } : {}),
        decisionDigest: digest(decision, reasonCode, facts.aggregateVersion, facts.policy?.version),
      };
    });
  }

  async authorizeAndReserve(
    tenantId: string,
    input: AuthorizeAndReserveInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<AuthorizationOutcome> {
    const inputHash = hashAuthorizationInput(input);

    const authorize = async (transactionClient: Prisma.TransactionClient) => {
      const transaction = transactionClient;
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`action:${tenantId}:${input.actionKey}`}))`,
      );
      if (input.contactId) {
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`contact:${tenantId}:${input.contactId}`}))`,
        );
        // ล็อกเดียวกับ Cg3PreferenceRepository.append() เพื่อไม่ให้ preference/callback mutation
        // แทรกระหว่างที่ authorizeAndReserve กำลังโหลด CG3 facts มาประเมิน (S1-CG3-CC01)
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg3-contact:${tenantId}:${input.contactId}`}))`,
        );
        // CG4.4 (#187): ล็อกเดียวกับ Cg4FoundationRepository/Cg4ExceptionLifecycleRepository
        // เพื่อ serialize authorize กับ approve/revoke ของ exception: revoke ที่ commit ก่อน
        // ต้องทำให้ decision นี้ใช้ exception นั้นไม่ได้ และกลับกัน
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg4-contact:${tenantId}:${input.contactId}`}))`,
        );
      }

      const existing = await transaction.cgDecisionLog.findFirst({
        where: { tenantId, actionKey: input.actionKey },
        orderBy: { decidedAt: 'desc' },
        select: decisionSelection,
      });
      if (existing) {
        if (existing.inputHash !== inputHash) {
          throw new IdempotencyConflictError(input.actionKey);
        }
        return toOutcome(existing);
      }

      const now = this.now();
      const contact = input.contactId
        ? await transaction.contact.findFirst({
            where: { id: input.contactId, tenantId },
            select: { id: true },
          })
        : null;
      const identity = input.identityId
        ? await transaction.contactIdentity.findFirst({
            where: { id: input.identityId, contactId: input.contactId, tenantId },
            select: { id: true },
          })
        : undefined;
      const identityResolution =
        input.identityResolution ??
        (!contact || (input.identityId && !identity) ? 'NOT_FOUND' : 'RESOLVED');

      const restriction = contact
        ? await transaction.cgRestriction.findFirst({
            where: {
              tenantId,
              startsAt: { lte: now },
              AND: [
                { OR: [{ contactId: null }, { contactId: input.contactId }] },
                {
                  OR: input.identityId
                    ? [{ identityId: null }, { identityId: input.identityId }]
                    : [{ identityId: null }],
                },
                { OR: [{ channel: null }, { channel: input.channel }] },
                { OR: [{ purpose: null }, { purpose: input.purpose }] },
                { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
              ],
            },
            orderBy: { startsAt: 'desc' },
            select: { type: true, reasonCode: true, overridable: true },
          })
        : null;

      const consent =
        contact && identityResolution === 'RESOLVED'
          ? await transaction.cgConsent.findFirst({
              where: {
                tenantId,
                contactId: input.contactId,
                purpose: input.purpose,
                channel: input.channel,
                OR: input.identityId
                  ? [{ identityId: null }, { identityId: input.identityId }]
                  : [{ identityId: null }],
              },
              orderBy: { createdAt: 'desc' },
              select: { status: true, lawfulBasis: true, expiresAt: true },
            })
          : null;

      const policyResult = evaluateContactPolicy({
        policyVersion: input.policyVersion,
        identityResolution,
        ...(restriction
          ? {
              activeRestriction: {
                type: restriction.type,
                reasonCode: restriction.reasonCode,
                overridable: restriction.overridable,
              },
            }
          : {}),
        ...(consent
          ? {
              consent: {
                status:
                  consent.status === 'GRANTED' && consent.expiresAt && consent.expiresAt <= now
                    ? ('EXPIRED' as const)
                    : consent.status,
                lawfulBasis: consent.lawfulBasis,
              },
            }
          : {}),
      });
      const decisionId = this.id();

      let trace: ContactPolicyTraceEntry[] = policyResult.trace;
      let decision = policyResult.decision;
      let reasonCode = policyResult.reasonCode;
      let cg3AggregateVersion: number | undefined;
      let cg3PolicyVersion: number | undefined;
      let cg3PreferenceVersion: number | undefined;
      let cg3NextEligibleAt: Date | undefined;
      let cg3TimezoneSource: string | undefined;
      let cg3MatchedScope: Record<string, string | null> | undefined;
      let cg3MatchedWindowRef: string | undefined;
      let cg3ExceptionMode: string | undefined;
      let cg3ExceptionRef: string | undefined;
      let cg4Pins: Cg4DecisionTracePinsV1 | undefined;

      // Scoped kill switch เป็น non-overridable gate (#174 §2) ตรวจหลัง identity/hard restriction/
      // consent และก่อน CG3/exception: exception ยกไม่ได้ และไม่ consume one-use callback ให้กับ
      // decision ที่ต้อง hold อยู่แล้ว ใช้ scope matching ชุดเดียวกับ revalidation (#228)
      const killSwitchActive =
        policyResult.decision === 'ALLOW' && input.contactId
          ? (
              await transaction.cg4ScopeKillSwitch.findMany({
                where: { tenantId, state: 'ACTIVE' },
                select: { scopeKey: true },
              })
            ).some(({ scopeKey }) =>
              killSwitchCoversReservation(scopeKey, {
                contactId: input.contactId!,
                channel: input.channel,
                purpose: input.purpose,
                source: input.source,
                authorizationContactKind: input.contactKind ?? null,
              }),
            )
          : false;

      if (killSwitchActive) {
        decision = 'REVIEW';
        reasonCode = GOVERNANCE_KILL_SWITCH_ACTIVE;
        trace = [
          ...policyResult.trace.map((entry, index) =>
            index === policyResult.trace.length - 1 && entry.outcome === 'ALLOW'
              ? { gate: entry.gate, outcome: 'PASS' as const }
              : entry,
          ),
          { gate: 'KILL_SWITCH', outcome: 'REVIEW', reasonCode: GOVERNANCE_KILL_SWITCH_ACTIVE },
        ];
      } else if (policyResult.decision === 'ALLOW' && input.contactId) {
        const facts = await loadCg3Facts(transaction, {
          tenantId,
          contactId: input.contactId,
          identityId: input.identityId,
          channel: input.channel,
          purpose: input.purpose,
          contactKind: input.contactKind,
          now,
        });
        const evaluate = (policy: Cg3PolicyFacts | undefined) =>
          evaluateCg3Policy({
            now,
            identityId: input.identityId,
            channel: input.channel,
            purpose: input.purpose,
            contactKind: input.contactKind,
            senderIdentityId: input.senderIdentityId,
            preferences: facts.preferences,
            policy,
            activeCallback: facts.activeCallback,
            source: input.source,
            sourceId: input.sourceId,
            activeExceptions: facts.activeExceptions,
          });
        // CG4.10 (#193): rollout stage เลือกว่า policy มาจาก CG3 loader หรือ head ของ CG4 (#179 §6)
        const policyRequest = cg4PolicyRequestScope(input);
        const reader = cg4PolicyReaderFor(
          await loadCg4RolloutState(transaction, tenantId),
          policyRequest,
        );
        let cg3: Cg3GateOutcome;
        let headBinding: Cg4PolicyBinding | undefined;
        let evaluatedPolicyVersion = facts.policy?.version;
        if (reader.mode === 'CG4') {
          const read = await loadCg4PolicyFacts(transaction, {
            tenantId,
            request: policyRequest,
            now,
          });
          if (read.outcome === 'FAIL_CLOSED') {
            cg3 = cg4PolicyFailClosedOutcome('POLICY_HEAD', read.reason);
            evaluatedPolicyVersion = undefined;
          } else {
            headBinding = read.outcome === 'RESOLVED' ? read.binding : undefined;
            evaluatedPolicyVersion = headBinding?.policyVersion;
            cg3 = evaluate(read.outcome === 'RESOLVED' ? read.facts : undefined);
          }
        } else {
          cg3 = evaluate(facts.policy);
          if (reader.mode === 'CG3_WITH_SHADOW') {
            const read = await loadCg4PolicyFacts(transaction, {
              tenantId,
              request: policyRequest,
              now,
            });
            const cg3Digest = cg4ShadowDecisionDigest(cg3);
            const cg4Digest = cg4ShadowDecisionDigest(shadowOutcome(read, evaluate));
            if (cg3Digest !== cg4Digest) {
              await transaction.cg4ShadowMismatch.create({
                data: {
                  id: this.id(),
                  tenantId,
                  decisionId,
                  requestScopeKey: requestScopeKey(policyRequest),
                  pilot: reader.pilot,
                  cg3Digest,
                  cg4Digest,
                  cg3PolicyVersion: facts.policy?.version ?? null,
                  cg4PolicyVersionId:
                    read.outcome === 'RESOLVED' ? read.binding.policyVersionId : null,
                  cg4Outcome: read.outcome,
                  detectedAt: now,
                },
              });
              // mismatch บน pilot scope fail closed; นอก pilot ให้ CG3 ตัดสินต่อแต่มีหลักฐานค้างไว้
              if (reader.pilot) {
                cg3 = cg4PolicyFailClosedOutcome('MIGRATION_SHADOW', GOVERNANCE_SHADOW_MISMATCH);
              }
            }
          }
        }
        trace = [
          ...policyResult.trace.map((entry, index) =>
            index === policyResult.trace.length - 1 && entry.outcome === 'ALLOW'
              ? { gate: entry.gate, outcome: 'PASS' as const }
              : entry,
          ),
          ...cg3.trace,
        ];
        cg3AggregateVersion = facts.aggregateVersion;
        cg3PolicyVersion = evaluatedPolicyVersion;
        cg3PreferenceVersion = cg3.preferenceVersion;
        cg3NextEligibleAt = cg3.nextEligibleAt ? new Date(cg3.nextEligibleAt) : undefined;
        cg3TimezoneSource = cg3.timezoneSource;
        cg3MatchedScope = cg3.matchedScope;
        cg3MatchedWindowRef = cg3.matchedWindowRef;
        cg3ExceptionMode = cg3.exceptionMode;
        cg3ExceptionRef = cg3.exceptionRef;
        if (cg3.appliedExceptions?.length || headBinding) {
          const appliedExceptions = cg3.appliedExceptions ?? [];
          // หลัง switch decision pin policy version ของ head ที่ใช้ตัดสินจริง; ก่อนหน้านั้นคง binding
          // ของ exception ที่ถูกใช้ตามเดิม (CG4.4)
          const policy =
            headBinding ??
            toCg4PolicyBinding(
              facts.activeExceptions.find(
                (candidate) => candidate.revisionId === appliedExceptions[0]!.revisionId,
              )!,
            );
          cg4Pins = {
            contractVersion: CG4_CONTRACT_VERSION,
            policy,
            decisionStateDigest: stableDigest({ policy, appliedExceptions }),
            appliedExceptions,
          };
        }

        if (cg3.decision) {
          decision = cg3.decision;
          reasonCode = cg3.reasonCode!;
        } else {
          decision = 'ALLOW';
          reasonCode = 'POLICY_PASSED';
        }

        if (cg3.consumedCallbackRequestId) {
          const original = await transaction.cgCallbackRequest.findUniqueOrThrow({
            where: { tenantId_id: { tenantId, id: cg3.consumedCallbackRequestId } },
          });
          await transaction.cgCallbackRequest.create({
            data: {
              id: this.id(),
              tenantId,
              seriesId: original.seriesId,
              version: original.version + 1,
              contactId: original.contactId,
              identityId: original.identityId,
              channel: original.channel,
              purpose: original.purpose,
              requestedAt: original.requestedAt,
              requestedTimezone: original.requestedTimezone,
              expiresAt: original.expiresAt,
              sourceKind: original.sourceKind,
              sourceVersion: original.sourceVersion,
              oneUseTokenHash: createHash('sha256')
                .update(`consume:${original.id}:${decisionId}`)
                .digest('hex'),
              approvedExceptionId: original.approvedExceptionId,
              mutationKind: 'CONSUME',
              supersedesId: original.id,
              evidenceRef: `system:authorizeAndReserve:${decisionId}`,
              requestHash: createHash('sha256')
                .update(`consume:${original.id}:${original.version + 1}`)
                .digest('hex'),
              actorClass: 'SYSTEM',
            },
          });
        }
      }

      let reservationId: string | undefined;
      let reservationExpiresAt: Date | undefined;

      if (decision === 'ALLOW') {
        if (!input.contactId) {
          throw new Error('ผล ALLOW ต้องมี contact ที่ resolve แล้ว');
        }
        reservationId = this.id();
        reservationExpiresAt = new Date(now.getTime() + RESERVATION_TTL_MS);
        await transaction.cgReservation.create({
          data: {
            id: reservationId,
            tenantId,
            contactId: input.contactId,
            identityId: input.identityId,
            channel: input.channel,
            purpose: input.purpose,
            source: input.source,
            sourceId: input.sourceId,
            teamId: input.teamId,
            actionKey: input.actionKey,
            inputHash,
            expiresAt: reservationExpiresAt,
            settlementStatus: 'UNCLAIMED',
            authorizationAggregateVersion: cg3AggregateVersion,
            authorizationPolicyVersion: cg3PolicyVersion,
            authorizationContactKind: input.contactKind,
            authorizationContextVersion: 1,
          },
        });
      }

      const created = await transaction.cgDecisionLog.create({
        data: {
          id: decisionId,
          tenantId,
          contactId: contact?.id,
          identityId: identity?.id,
          channel: input.channel,
          purpose: input.purpose,
          source: input.source,
          sourceId: input.sourceId,
          teamId: input.teamId,
          actionKey: input.actionKey,
          inputHash,
          decision,
          reasonCode,
          policyVersion: policyResult.policyVersion,
          gate: trace.at(-1)?.gate ?? 'IDENTITY',
          trace: trace as unknown as Prisma.InputJsonValue,
          reservationId,
          decidedAt: now,
          aggregateVersion: cg3AggregateVersion,
          preferenceVersion: cg3PreferenceVersion,
          nextEligibleAt: cg3NextEligibleAt,
          timezoneSource: cg3TimezoneSource,
          matchedScope: cg3MatchedScope as unknown as Prisma.InputJsonValue | undefined,
          matchedWindowRef: cg3MatchedWindowRef,
          exceptionMode: cg3ExceptionMode as CgCallbackMode | undefined,
          exceptionRef: cg3ExceptionRef,
          cg4: cg4Pins as unknown as Prisma.InputJsonValue | undefined,
        },
        select: decisionSelection,
      });

      if (reservationId) {
        await transaction.cgReservation.update({
          where: { id: reservationId },
          data: { authorizationDecisionId: decisionId },
        });
      }

      return toOutcome(created);
    };
    return transaction
      ? authorize(transaction)
      : withTenantDatabaseTransaction(this.database, tenantId, authorize);
  }

  async changeReservationState(
    tenantId: string,
    reservationId: string,
    command: ReservationCommand,
  ): Promise<ReservationView> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`reservation:${tenantId}:${reservationId}`}))`,
      );
      const current = await transaction.cgReservation.findFirst({
        where: { id: reservationId, tenantId },
        select: reservationSelection,
      });
      if (!current) throw new ReservationNotFoundError(reservationId);
      if (current.deliveryId) {
        throw new ReservationBindingError(
          current.submissionStartedAt || current.providerRequestKey
            ? 'DELIVERY_RECONCILIATION_REQUIRED'
            : 'INVALID_RESERVATION_TRANSITION',
        );
      }

      const next = transitionReservation({ id: current.id, state: current.state }, command);
      if (next.state === current.state) return toReservationView(current);

      const now = this.now();
      const updated = await transaction.cgReservation.update({
        where: { id: current.id },
        data: {
          state: next.state,
          ...(next.state === 'CONFIRMED' ? { confirmedAt: now } : {}),
          ...(next.state === 'RELEASED' ? { releasedAt: now } : {}),
          ...(next.state === 'REFUNDED' ? { refundedAt: now } : {}),
        },
        select: reservationSelection,
      });
      return toReservationView(updated);
    });
  }

  async validateReservationForDelivery(
    tenantId: string,
    reservationId: string,
  ): Promise<ReservationView> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const reservation = await transaction.cgReservation.findFirst({
        where: { id: reservationId, tenantId },
        select: reservationSelection,
      });
      if (!reservation) {
        throw new ReservationNotUsableError('RESERVATION_NOT_FOUND', reservationId);
      }
      if (reservation.state !== 'RESERVED') {
        throw new ReservationNotUsableError('RESERVATION_NOT_RESERVED', reservationId);
      }
      if (reservation.expiresAt <= this.now()) {
        throw new ReservationNotUsableError('RESERVATION_EXPIRED', reservationId);
      }
      return toReservationView(reservation);
    });
  }

  async releaseExpiredReservations(tenantId: string, limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('reservation sweep limit must be an integer between 1 and 500');
    }
    const now = this.now();

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const released = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        WITH expired AS (
          SELECT id
          FROM cg_reservations
          WHERE tenant_id = ${tenantId}::uuid
            AND state = 'RESERVED'
            AND submission_started_at IS NULL
            AND provider_request_key IS NULL
            AND (settlement_status IS NULL OR settlement_status IN ('UNCLAIMED', 'CLAIMED'))
            AND COALESCE(lease_expires_at, expires_at) <= ${now}
          ORDER BY COALESCE(lease_expires_at, expires_at), id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE cg_reservations AS reservation
        SET state = 'RELEASED',
            settlement_status = 'SETTLED',
            released_at = ${now},
            settled_at = ${now},
            updated_at = ${now}
        FROM expired
        WHERE reservation.id = expired.id
        RETURNING reservation.id
      `);
      return released.length;
    });
  }
}
