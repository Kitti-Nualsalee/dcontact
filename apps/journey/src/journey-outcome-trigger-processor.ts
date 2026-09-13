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
import {
  Prisma,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
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
import type { JourneyDefinitionRepository } from './journey-definition-repository.js';
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

export type TriggerProcessingOutcome =
  | 'ENROLLED'
  | 'NO_MATCH'
  | 'REVIEW'
  | 'DEFERRED'
  | 'BLOCKED'
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

function buildCommandDraft(
  rawTenantId: string,
  matched: JourneyVersionSnapshot,
  entryStep: JourneyActionIntentStep,
  enrollmentId: string,
  outcomeType: string,
  outcomeIdValue: string,
  outcomeVersion: number,
  interactionIdValue: string,
  contactIdValue: string,
): J2OwnerCommandDraftV1 {
  const common = {
    contractVersion: 1 as const,
    commandId: toCommandId(randomUUID()),
    actionKey: toActionKey(
      createJourneyActionKey({ enrollmentId, journeyVersion: matched.version, stepId: entryStep.id }),
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
      intent: { caseTypePolicyRef: entryStep.caseTypeId, routingPolicyRef: entryStep.routingIntentRef },
    };
  }
  if (entryStep.type === 'ADMIT_CAMPAIGN_TARGET') {
    return {
      ...common,
      commandType: 'ADMIT_CAMPAIGN_TARGET',
      intent: { campaignId: toCampaignId(entryStep.campaignId) },
    };
  }
  const requestedFor = new Date(Date.now() + entryStep.requestedInSeconds * 1_000).toISOString();
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

  /** ประมวลผล receipt ที่ READY ได้สูงสุดหนึ่งใบต่อครั้ง; caller กำหนด polling loop เอง */
  async executeNext(tenantId: string, workerId: string): Promise<TriggerProcessingOutcome> {
    const claimed = await this.receipts.claimNextReady(tenantId, workerId, this.leaseSeconds);
    if (!claimed) return undefined;

    const payload = claimed.payload as unknown as InteractionOutcomeReceiptPayload;
    if (!payload.contactId) {
      await this.receipts.markReview(tenantId, claimed.id, 'IDENTITY_UNRESOLVED');
      return 'REVIEW';
    }

    const at = this.now().toISOString();
    const identity = await this.ports.identityResolver.resolveByContactId({
      tenantId: toTenantId(tenantId),
      contactId: toContactId(payload.contactId),
      at,
    });
    if (identity.status !== 'RESOLVED') {
      await this.receipts.markReview(tenantId, claimed.id, 'IDENTITY_UNRESOLVED');
      return 'REVIEW';
    }

    // V1: อย่างมากหนึ่ง match ต่อ outcome ตาม JrEnrollment's unique trigger-source
    // design (#135) — ดู journey-definition-repository.ts
    const [matched] = await this.definitions.findPublishedByOutcomeTrigger(
      tenantId,
      claimed.outcomeType,
      payload.outcomeCode,
    );
    if (!matched) {
      await this.receipts.markApplied(tenantId, claimed.id);
      return 'NO_MATCH';
    }
    const entryStep = matched.graph.steps.find(
      (step) => step.id === matched.graph.entryStepId,
    ) as JourneyActionIntentStep;

    const [sourceScope, targetScope] = await Promise.all([
      this.ports.teamContactScopeAuthorizer.authorize({
        tenantId: toTenantId(tenantId),
        teamId: toTeamId(matched.ownerTeamId),
        contactId: toContactId(identity.contactId),
        permission: 'WORK',
        at,
      }),
      this.ports.teamContactScopeAuthorizer.authorize({
        tenantId: toTenantId(tenantId),
        teamId: toTeamId(entryStep.targetOwnerTeamId),
        contactId: toContactId(identity.contactId),
        permission: 'WORK',
        at,
      }),
    ]);

    if (sourceScope.decision === 'DEFER' || targetScope.decision === 'DEFER') {
      await this.receipts.markRetryableFailure(
        tenantId,
        claimed.id,
        this.retryDelayMs,
        'SCOPE_CONTEXT_STALE',
      );
      return 'DEFERRED';
    }

    const enrollmentId = await this.ensureEnrollment(
      tenantId,
      claimed.id,
      matched,
      entryStep,
      identity.contactId,
      claimed.correlationId,
    );

    if (sourceScope.decision === 'DENY' || targetScope.decision === 'DENY') {
      await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
        await transaction.jrEnrollment.updateMany({
          where: { tenantId, id: enrollmentId, state: 'PENDING' },
          data: { state: 'BLOCKED', runState: 'TERMINAL', terminalReason: 'EXIT_RULE' },
        });
        await this.receipts.markApplied(tenantId, claimed.id, transaction);
      });
      return 'BLOCKED';
    }

    const draft = buildCommandDraft(
      tenantId,
      matched,
      entryStep,
      enrollmentId,
      claimed.outcomeType,
      claimed.outcomeId,
      claimed.outcomeVersion,
      payload.interactionId,
      identity.contactId,
    );
    const command = withOwnerRequestHash(toTenantId(tenantId), draft);

    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.jrEnrollment.updateMany({
        where: { tenantId, id: enrollmentId, state: 'PENDING' },
        data: { state: 'AUTHORIZED', runState: 'WAITING' },
      });
      await this.actions.ensureAction(
        {
          tenantId,
          actionKey: command.actionKey,
          enrollmentId,
          outcomeReceiptId: claimed.id,
          kind: ACTION_INTENT_KIND_BY_STEP_TYPE[entryStep.type],
          requestHash: command.requestHash,
          correlationId: claimed.correlationId,
          commandId: command.commandId,
          commandPayload: command,
        },
        transaction,
      );
      await this.receipts.markApplied(tenantId, claimed.id, transaction);
    });
    return 'ENROLLED';
  }

  /**
   * idempotent ต่อ restart: `@@unique([tenantId, outcomeReceiptId])` กัน enrollment ซ้ำ
   * แม้ worker ตายระหว่างสอง transaction ถัดไป (BLOCKED/ENROLLED) แล้ว retry receipt ใบเดิม
   */
  private async ensureEnrollment(
    tenantId: string,
    outcomeReceiptId: string,
    matched: JourneyVersionSnapshot,
    entryStep: JourneyActionIntentStep,
    resolvedContactId: string,
    correlationId: string,
  ): Promise<string> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`journey-enrollment:${tenantId}:outcome-receipt:${outcomeReceiptId}`}))`,
      );
      const existing = await transaction.jrEnrollment.findFirst({
        where: { tenantId, outcomeReceiptId },
        select: { id: true },
      });
      if (existing) return existing.id;
      const newId = this.id();
      await transaction.jrEnrollment.create({
        data: {
          id: newId,
          tenantId,
          outcomeReceiptId,
          journeyId: matched.journeyId,
          journeyVersion: matched.version,
          contactId: resolvedContactId,
          currentStepId: entryStep.id,
          state: 'PENDING',
          runState: 'WAITING',
          correlationId,
        },
      });
      return newId;
    });
  }
}
