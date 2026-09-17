/**
 * J2.7 — apply phase ของ interaction outcome receipt: resolve trusted current
 * contact identity/team scope, match published `INTERACTION_OUTCOME` trigger แล้ว
 * สร้าง enrollment + owner action intent atomic กับ receipt transition (#120,#122)
 *
 * แยกจาก Kafka consumer (`journey-outcome-consumer.ts`) ที่ทำแค่ ingest ตามแบบ J2.3/
 * J2.8 เดิม: claim หนึ่งใบ, resolve ภายนอก transaction (read-only, ไม่ต้องถือ DB lock
 * ระหว่างรอ Customer 360/IAM ตอบ), แล้วเปิด transaction เดียวเฉพาะตอนต้อง persist
 * เพื่อให้ enrollment/action/receipt-transition เป็น atomic unit เดียว
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  actionKey as toActionKey,
  campaignId as toCampaignId,
  commandId as toCommandId,
  contactId as toContactId,
  enrollmentId as toEnrollmentId,
  interactionId as toInteractionId,
  journeyId as toJourneyId,
  outcomeId as toOutcomeId,
  teamId as toTeamId,
  tenantId as toTenantId,
  withOwnerRequestHash,
  type CustomerIdentityResolver,
  type InteractionOutcomeType,
  type J2OwnerCommandDraftV1,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import type { JourneyActionIntentStep, JourneyVersionSnapshot } from './journey-definition.js';
import {
  matchesOutcomeTrigger,
  type JourneyDefinitionRepository,
} from './journey-definition-repository.js';
import { createJourneyActionKey } from './action-key.js';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneyOutcomeReceiptRepository } from './journey-outcome-receipt-repository.js';

/** เนื้อหาขั้นต่ำที่ `journey-outcome-consumer.ts` ต้อง persist ไว้ตอน ingest — ดู #120 */
export interface InteractionOutcomeReceiptPayload {
  interactionId: string;
  contactId?: string;
  outcomeCode?: string;
  effectiveAt: string;
}

/**
 * ผลรวมของ receipt หนึ่งใบ (อาจ fan-out หลาย journey) — เลือกผลที่มี side effect มากสุด:
 * ENROLLED > CANCELLED > BLOCKED > UNCHANGED > NO_MATCH
 *
 * - `CANCELLED` — correction ทำให้ enrollment เดิมไม่ match trigger ของ version ที่ pin ไว้แล้ว
 * - `UNCHANGED` — correction ของ outcome ที่ enroll ไปแล้วและยัง match เหมือนเดิม: ไม่มี effect ใหม่
 */
export type TriggerProcessingOutcome =
  | 'ENROLLED'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'UNCHANGED'
  | 'NO_MATCH'
  | 'REVIEW'
  | 'DEFERRED'
  | undefined;

export interface JourneyOutcomeTriggerProcessorPorts {
  identityResolver: CustomerIdentityResolver<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
}

export interface JourneyOutcomeTriggerProcessorOptions {
  now?: () => Date;
  id?: () => string;
  retryDelayMs?: number;
  leaseSeconds?: number;
}

const ACTION_INTENT_KIND_BY_STEP_TYPE = {
  ENSURE_CASE: 'ENSURE_CASE',
  ADMIT_CAMPAIGN_TARGET: 'ADMIT_CAMPAIGN_TARGET',
  SCHEDULE_CALLBACK: 'SCHEDULE_CALLBACK',
} as const;

const CANCELLABLE_OWNER_ACTION_STATES = new Set(['PENDING', 'DISPATCHED', 'ACK_UNKNOWN']);

const OUTCOME_PRIORITY: readonly Exclude<TriggerProcessingOutcome, undefined>[] = [
  'ENROLLED',
  'CANCELLED',
  'BLOCKED',
  'UNCHANGED',
  'NO_MATCH',
];

type ScopeDecision = 'ALLOW' | 'DENY';

interface StreamEnrollment {
  id: string;
  journeyId: string | null;
  journeyVersion: number;
  state: string;
  runState: string;
  terminalReason: string | null;
}

function buildCommandDraft(
  matched: JourneyVersionSnapshot,
  entryStep: JourneyActionIntentStep,
  enrollmentId: string,
  outcomeType: string,
  outcomeIdValue: string,
  outcomeVersion: number,
  interactionIdValue: string,
  contactIdValue: string,
  now: Date,
): J2OwnerCommandDraftV1 {
  const common = {
    contractVersion: 1 as const,
    commandId: toCommandId(randomUUID()),
    actionKey: toActionKey(
      createJourneyActionKey({
        enrollmentId,
        journeyVersion: matched.version,
        stepId: entryStep.id,
      }),
    ),
    journeyId: toJourneyId(matched.journeyId),
    journeyVersion: matched.version,
    enrollmentId: toEnrollmentId(enrollmentId),
    stepId: entryStep.id,
    sourceOutcome: {
      outcomeType: outcomeType as InteractionOutcomeType,
      outcomeId: toOutcomeId(outcomeIdValue),
      outcomeVersion,
    },
    interactionId: toInteractionId(interactionIdValue),
    contactId: toContactId(contactIdValue),
    sourceOwnerTeamId: toTeamId(matched.ownerTeamId),
    targetOwnerTeamId: toTeamId(entryStep.targetOwnerTeamId),
  };
  if (entryStep.type === 'ENSURE_CASE') {
    return {
      ...common,
      commandType: 'ENSURE_CASE',
      intent: {
        caseTypePolicyRef: entryStep.caseTypeId,
        routingPolicyRef: entryStep.routingIntentRef,
      },
    };
  }
  if (entryStep.type === 'ADMIT_CAMPAIGN_TARGET') {
    return {
      ...common,
      commandType: 'ADMIT_CAMPAIGN_TARGET',
      intent: { campaignId: toCampaignId(entryStep.campaignId) },
    };
  }
  const requestedFor = new Date(now.getTime() + entryStep.requestedInSeconds * 1_000).toISOString();
  return {
    ...common,
    commandType: 'SCHEDULE_CALLBACK',
    intent: {
      requestedFor,
      queueId: entryStep.queueId,
      ...(entryStep.agentId ? { agentId: entryStep.agentId } : {}),
    },
  };
}

export class JourneyOutcomeTriggerProcessor {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly retryDelayMs: number;
  private readonly leaseSeconds: number;
  private readonly receipts: JourneyOutcomeReceiptRepository;
  private readonly actions: JourneyOwnerActionRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly definitions: JourneyDefinitionRepository,
    private readonly ports: JourneyOutcomeTriggerProcessorPorts,
    options: JourneyOutcomeTriggerProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.receipts = new JourneyOutcomeReceiptRepository(database, { id: this.id });
    this.actions = new JourneyOwnerActionRepository(database, { id: this.id });
  }

  /**
   * ประมวลผล receipt ที่ READY ได้สูงสุดหนึ่งใบต่อครั้ง; caller กำหนด polling loop เอง
   *
   * อ่านทุกอย่างนอก transaction ก่อน (identity, definitions, enrollment เดิมของ logical
   * outcome, scope) แล้ว persist ทั้งหมดใน transaction เดียวกับ `markApplied` — crash
   * ตรงไหนก็ไม่มี enrollment/action ครึ่ง ๆ กลาง ๆ และ retry receipt ใบเดิมได้ผลเท่าเดิม
   */
  async executeNext(tenantId: string, workerId: string): Promise<TriggerProcessingOutcome> {
    const claimed = await this.receipts.claimNextReady(tenantId, workerId, this.leaseSeconds);
    if (!claimed) return undefined;

    const payload = claimed.payload as unknown as InteractionOutcomeReceiptPayload;
    if (!payload.contactId) {
      await this.receipts.markReview(tenantId, claimed.id, 'IDENTITY_UNRESOLVED');
      return 'REVIEW';
    }

    const now = this.now();
    const at = now.toISOString();
    const identity = await this.ports.identityResolver.resolveByContactId({
      tenantId: toTenantId(tenantId),
      contactId: toContactId(payload.contactId),
      at,
    });
    if (identity.status !== 'RESOLVED') {
      await this.receipts.markReview(tenantId, claimed.id, 'IDENTITY_UNRESOLVED');
      return 'REVIEW';
    }

    const [matches, existing] = await Promise.all([
      this.definitions.findPublishedByOutcomeTrigger(
        tenantId,
        claimed.outcomeType,
        payload.outcomeCode,
      ),
      this.streamEnrollments(tenantId, claimed.outcomeType, claimed.outcomeId),
    ]);

    /**
     * correction เป็น revision ของ logical outcome เดิม (#123): journey ที่มี enrollment อยู่แล้ว
     * ถูก re-evaluate กับ trigger ของ version ที่ enrollment pin ไว้ — ไม่ใช่ version ล่าสุด
     * และไม่สร้าง enrollment ใบใหม่ ส่วน enrollment PENDING คือของที่ worker ก่อนหน้า
     * (ก่อนมี atomic path นี้) ค้างไว้ ยังไม่เคยตัดสิน จึงตัดสินต่อด้วย version ที่ pin ไว้
     */
    const existingByJourney = new Map(
      existing.flatMap((enrollment) =>
        enrollment.journeyId ? [[enrollment.journeyId, enrollment] as const] : [],
      ),
    );
    const decisions: Array<{ snapshot: JourneyVersionSnapshot; enrollmentId?: string }> = [];
    const withdrawn: StreamEnrollment[] = [];
    let unchanged = 0;
    for (const enrollment of existing) {
      const pinned = enrollment.journeyId
        ? await this.definitions.getVersion(
            tenantId,
            enrollment.journeyId,
            enrollment.journeyVersion,
          )
        : undefined;
      const stillMatches =
        pinned !== undefined &&
        matchesOutcomeTrigger(pinned, claimed.outcomeType, payload.outcomeCode);
      if (!stillMatches) withdrawn.push(enrollment);
      else if (enrollment.state === 'PENDING') {
        decisions.push({ snapshot: pinned, enrollmentId: enrollment.id });
      } else unchanged += 1;
    }
    for (const matched of matches) {
      if (!existingByJourney.has(matched.journeyId)) decisions.push({ snapshot: matched });
    }

    const scopes = await Promise.all(
      decisions.map(({ snapshot }) =>
        this.authorizeWork(tenantId, snapshot, identity.contactId, at),
      ),
    );
    if (scopes.includes('DEFER')) {
      await this.receipts.markRetryableFailure(
        tenantId,
        claimed.id,
        this.retryDelayMs,
        'SCOPE_CONTEXT_STALE',
      );
      return 'DEFERRED';
    }

    const outcomes = new Set<Exclude<TriggerProcessingOutcome, undefined>>();
    if (unchanged > 0) outcomes.add('UNCHANGED');
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`journey-enrollment:${tenantId}:outcome-stream:${claimed.outcomeType}:${claimed.outcomeId}`}))`,
      );
      for (const [index, decision] of decisions.entries()) {
        outcomes.add(
          await this.applyDecision(transaction, {
            tenantId,
            receipt: claimed,
            interactionId: payload.interactionId,
            contactId: identity.contactId,
            snapshot: decision.snapshot,
            ...(decision.enrollmentId ? { enrollmentId: decision.enrollmentId } : {}),
            scope: scopes[index] as ScopeDecision,
            now,
          }),
        );
      }
      for (const enrollment of withdrawn) {
        const changed = await this.withdrawEnrollment(
          transaction,
          tenantId,
          enrollment,
          claimed.correlationId,
        );
        outcomes.add(changed ? 'CANCELLED' : 'UNCHANGED');
      }
      await this.receipts.markApplied(tenantId, claimed.id, transaction);
    });
    return OUTCOME_PRIORITY.find((outcome) => outcomes.has(outcome)) ?? 'NO_MATCH';
  }

  /** enrollment ทุกใบของ logical outcome `(outcomeType, outcomeId)` ไม่ว่าเกิดจาก revision ไหน */
  private streamEnrollments(
    tenantId: string,
    outcomeType: string,
    outcomeId: string,
  ): Promise<StreamEnrollment[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrEnrollment.findMany({
        where: { tenantId, outcomeReceipt: { tenantId, outcomeType, outcomeId } },
        select: {
          id: true,
          journeyId: true,
          journeyVersion: true,
          state: true,
          runState: true,
          terminalReason: true,
        },
        orderBy: { journeyId: 'asc' },
      }),
    );
  }

  /** source (Journey owner ที่ pin ไว้) และ target team ต้องมี current WORK scope ทั้งคู่ (#122) */
  private async authorizeWork(
    tenantId: string,
    snapshot: JourneyVersionSnapshot,
    resolvedContactId: string,
    at: string,
  ): Promise<ScopeDecision | 'DEFER'> {
    const entryStep = this.entryStep(snapshot);
    const decisions = await Promise.all(
      [snapshot.ownerTeamId, entryStep.targetOwnerTeamId].map((teamId) =>
        this.ports.teamContactScopeAuthorizer.authorize({
          tenantId: toTenantId(tenantId),
          teamId: toTeamId(teamId),
          contactId: toContactId(resolvedContactId),
          permission: 'WORK',
          at,
        }),
      ),
    );
    if (decisions.some(({ decision }) => decision === 'DEFER')) return 'DEFER';
    return decisions.some(({ decision }) => decision === 'DENY') ? 'DENY' : 'ALLOW';
  }

  private entryStep(snapshot: JourneyVersionSnapshot): JourneyActionIntentStep {
    return snapshot.graph.steps.find(
      (step) => step.id === snapshot.graph.entryStepId,
    ) as JourneyActionIntentStep;
  }

  /**
   * สร้าง (หรือตัดสิน PENDING ที่ค้าง) enrollment ของ journey หนึ่งใบ — scope denial เป็น
   * enrollment BLOCKED ของ Journey เอง ไม่ใช่ Governance BLOCK และไม่มี owner action
   */
  private async applyDecision(
    transaction: Prisma.TransactionClient,
    input: {
      tenantId: string;
      receipt: {
        id: string;
        outcomeType: string;
        outcomeId: string;
        outcomeVersion: number;
        correlationId: string;
      };
      interactionId: string;
      contactId: string;
      snapshot: JourneyVersionSnapshot;
      enrollmentId?: string;
      scope: ScopeDecision;
      now: Date;
    },
  ): Promise<'ENROLLED' | 'BLOCKED' | 'UNCHANGED'> {
    const { tenantId, receipt, snapshot } = input;
    const entryStep = this.entryStep(snapshot);
    const decided =
      input.scope === 'ALLOW'
        ? { state: 'AUTHORIZED' as const, runState: 'WAITING' as const }
        : {
            state: 'BLOCKED' as const,
            runState: 'TERMINAL' as const,
            terminalReason: 'EXIT_RULE' as const,
          };

    let enrollmentId = input.enrollmentId;
    if (enrollmentId) {
      const updated = await transaction.jrEnrollment.updateMany({
        where: { tenantId, id: enrollmentId, state: 'PENDING' },
        data: decided,
      });
      // worker อื่นตัดสินไปแล้วระหว่างที่เราอ่านนอก transaction
      if (updated.count === 0) return 'UNCHANGED';
    } else {
      const raced = await transaction.jrEnrollment.findFirst({
        where: {
          tenantId,
          journeyId: snapshot.journeyId,
          outcomeReceipt: {
            tenantId,
            outcomeType: receipt.outcomeType,
            outcomeId: receipt.outcomeId,
          },
        },
        select: { id: true },
      });
      if (raced) return 'UNCHANGED';
      enrollmentId = this.id();
      await transaction.jrEnrollment.create({
        data: {
          id: enrollmentId,
          tenantId,
          outcomeReceiptId: receipt.id,
          journeyId: snapshot.journeyId,
          journeyVersion: snapshot.version,
          contactId: input.contactId,
          currentStepId: entryStep.id,
          correlationId: receipt.correlationId,
          ...decided,
        },
      });
    }
    if (input.scope === 'DENY') return 'BLOCKED';

    const command = withOwnerRequestHash(
      toTenantId(tenantId),
      buildCommandDraft(
        snapshot,
        entryStep,
        enrollmentId,
        receipt.outcomeType,
        receipt.outcomeId,
        receipt.outcomeVersion,
        input.interactionId,
        input.contactId,
        input.now,
      ),
    );
    await this.actions.ensureAction(
      {
        tenantId,
        actionKey: command.actionKey,
        enrollmentId,
        outcomeReceiptId: receipt.id,
        kind: ACTION_INTENT_KIND_BY_STEP_TYPE[entryStep.type],
        requestHash: command.requestHash,
        correlationId: receipt.correlationId,
        commandId: command.commandId,
        commandPayload: command,
      },
      transaction,
    );
    return 'ENROLLED';
  }

  /**
   * correction ทำให้ enrollment เดิมไม่ match แล้ว: ขอ cancel action ที่ยัง reversible
   * (pre-barrier) ด้วย actionKey เดิม และหยุด enrollment — action ที่ owner รับไปแล้ว
   * (เช่น Case ที่ commit แล้ว) คงอยู่เป็น fact ของ owner; Journey ไม่ลบหรือชดเชยเอง (#123)
   *
   * cancelCommandId คำนวณจาก actionKey จึง replay ได้โดยไม่สั่ง owner ยกเลิกซ้ำ; enrollment ที่
   * terminal ไปแล้วด้วยเหตุอื่นไม่ถูกเขียนทับ (first terminal commit wins)
   */
  private async withdrawEnrollment(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    enrollment: StreamEnrollment,
    correlationId: string,
  ): Promise<boolean> {
    let changed = false;
    const actions = await transaction.jrOwnerAction.findMany({
      where: { tenantId, enrollmentId: enrollment.id },
      select: { actionKey: true, state: true, version: true },
      orderBy: { actionKey: 'asc' },
    });
    for (const action of actions) {
      if (!CANCELLABLE_OWNER_ACTION_STATES.has(action.state)) continue;
      await this.actions.requestCancellation(
        {
          tenantId,
          actionKey: action.actionKey,
          cancelCommandId: `cancel:outcome-correction:${action.actionKey}`,
          correlationId,
          expectedVersion: action.version,
        },
        transaction,
      );
      changed = true;
    }
    const stopped = await transaction.jrEnrollment.updateMany({
      where: { tenantId, id: enrollment.id, terminalReason: null },
      data: { state: 'BLOCKED', runState: 'TERMINAL', terminalReason: 'CANCELLED' },
    });
    return changed || stopped.count > 0;
  }
}
