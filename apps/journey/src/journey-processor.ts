import type {
  AuthorizeAndReserveInput,
  AuthorizationOutcome,
  ContactGovernanceService,
} from '@d-contact/contact-governance';
import {
  Prisma,
  type ChannelType,
  type CgDecision,
  type JrEnrollmentState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { InboundBusinessEvent } from '@d-contact/shared';
import { createJourneyActionKey } from './action-key.js';

export interface ProcessJourneyEventInput {
  receiptId: string;
  journeyVersion: number;
  stepId: string;
  channel: ChannelType;
  purpose: string;
  policyVersion: number;
}

export interface AuthorizedJourneyAction {
  actionKey: string;
  contactId: string;
  identityId: string;
  decisionId: string;
  reservationId: string;
}

export interface JourneyProcessingResult {
  receiptId: string;
  enrollmentId: string;
  actionKey: string;
  decisionId: string;
  decision: CgDecision;
  reasonCode: string;
  reservationId?: string;
  action?: AuthorizedJourneyAction;
}

export interface JourneyProcessorOptions {
  now?: () => Date;
}

interface ResolvedContact {
  contactId: string;
  identityId: string;
}

export class JourneyEventNotReadyError extends Error {
  readonly code = 'JOURNEY_EVENT_NOT_READY';

  constructor(readonly receiptId: string) {
    super(`Journey event ยังไม่ถูก publish ใน active tenant: ${receiptId}`);
    this.name = 'JourneyEventNotReadyError';
  }
}

export class JourneyEnrollmentConflictError extends Error {
  readonly code = 'JOURNEY_ENROLLMENT_CONFLICT';

  constructor(readonly receiptId: string) {
    super(`receipt ถูก enroll ด้วย Journey version อื่นแล้ว: ${receiptId}`);
    this.name = 'JourneyEnrollmentConflictError';
  }
}

export class JourneyProcessor {
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly governance: ContactGovernanceService,
    options: JourneyProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async processEvent(
    tenantId: string,
    input: ProcessJourneyEventInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<JourneyProcessingResult> {
    const event = await this.loadEventAndPrepareEnrollment(tenantId, input);
    const enrollmentId = input.receiptId;
    const actionKey = createJourneyActionKey({
      enrollmentId,
      journeyVersion: input.journeyVersion,
      stepId: input.stepId,
    });
    const resolved = await this.resolveContact(tenantId, event);
    const authorizationBase = {
      channel: input.channel,
      purpose: input.purpose,
      source: 'JOURNEY',
      sourceId: input.receiptId,
      actionKey,
      policyVersion: input.policyVersion,
    };
    const authorizationInput: AuthorizeAndReserveInput = resolved
      ? {
          ...authorizationBase,
          contactId: resolved.contactId,
          identityId: resolved.identityId,
        }
      : {
          ...authorizationBase,
          identityResolution: event.contactRef.kind === 'CRM_ID' ? 'AMBIGUOUS' : 'NOT_FOUND',
        };
    const authorization = await this.governance.authorizeAndReserve(tenantId, authorizationInput);

    await this.persistOutcome(tenantId, input, actionKey, resolved, authorization, transaction);

    return {
      receiptId: input.receiptId,
      enrollmentId,
      actionKey,
      decisionId: authorization.decisionId,
      decision: authorization.decision,
      reasonCode: authorization.reasonCode,
      ...(authorization.reservationId ? { reservationId: authorization.reservationId } : {}),
      ...(authorization.decision === 'ALLOW' && authorization.reservationId && resolved
        ? {
            action: {
              actionKey,
              contactId: resolved.contactId,
              identityId: resolved.identityId,
              decisionId: authorization.decisionId,
              reservationId: authorization.reservationId,
            },
          }
        : {}),
    };
  }

  private async loadEventAndPrepareEnrollment(
    tenantId: string,
    input: ProcessJourneyEventInput,
  ): Promise<InboundBusinessEvent> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`journey-enrollment:${tenantId}:${input.receiptId}`}))`,
      );
      const inbox = await transaction.jrEventInbox.findFirst({
        where: { id: input.receiptId, tenantId, state: { in: ['PUBLISHED', 'PROCESSED'] } },
        select: { payload: true },
      });
      if (!inbox) throw new JourneyEventNotReadyError(input.receiptId);

      const enrollment = await transaction.jrEnrollment.findFirst({
        where: { tenantId, eventInboxId: input.receiptId },
        select: { journeyVersion: true },
      });
      if (enrollment && enrollment.journeyVersion !== input.journeyVersion) {
        throw new JourneyEnrollmentConflictError(input.receiptId);
      }
      if (!enrollment) {
        await transaction.jrEnrollment.create({
          data: {
            id: input.receiptId,
            tenantId,
            eventInboxId: input.receiptId,
            journeyVersion: input.journeyVersion,
            state: 'PENDING',
          },
        });
      }
      return inbox.payload as unknown as InboundBusinessEvent;
    });
  }

  private async resolveContact(
    tenantId: string,
    event: InboundBusinessEvent,
  ): Promise<ResolvedContact | undefined> {
    const identityType = event.contactRef.kind;
    if (identityType === 'CRM_ID') return undefined;

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const identity = await transaction.contactIdentity.findUnique({
        where: {
          tenantId_type_value: {
            tenantId,
            type: identityType,
            value: event.contactRef.value,
          },
        },
        select: { id: true, contactId: true },
      });
      return identity ? { identityId: identity.id, contactId: identity.contactId } : undefined;
    });
  }

  private async persistOutcome(
    tenantId: string,
    input: ProcessJourneyEventInput,
    actionKey: string,
    resolved: ResolvedContact | undefined,
    authorization: AuthorizationOutcome,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const persist = async (transactionClient: Prisma.TransactionClient): Promise<void> => {
      const state: JrEnrollmentState =
        authorization.decision === 'ALLOW'
          ? 'AUTHORIZED'
          : authorization.decision === 'REVIEW'
            ? 'REVIEW'
            : authorization.decision === 'DEFER'
              ? 'DEFERRED'
              : 'BLOCKED';
      await transactionClient.jrEnrollment.updateMany({
        where: { id: input.receiptId, tenantId },
        data: {
          state,
          contactId: resolved?.contactId,
          decisionId: authorization.decisionId,
        },
      });

      if (authorization.decision === 'ALLOW') {
        if (!resolved || !authorization.reservationId) {
          throw new Error(
            'Journey action ที่ authorize แล้วต้องมี contact และ reservation evidence',
          );
        }
        await transactionClient.jrAction.upsert({
          where: { tenantId_actionKey: { tenantId, actionKey } },
          create: {
            tenantId,
            enrollmentId: input.receiptId,
            actionKey,
            contactId: resolved.contactId,
            identityId: resolved.identityId,
            channel: input.channel,
            purpose: input.purpose,
            decisionId: authorization.decisionId,
            reservationId: authorization.reservationId,
          },
          update: {},
        });
      }

      await transactionClient.jrEventInbox.updateMany({
        where: {
          id: input.receiptId,
          tenantId,
          state: { in: ['PUBLISHED', 'PROCESSED'] },
        },
        data: { state: 'PROCESSED', processedAt: this.now() },
      });
    };
    if (transaction) {
      await persist(transaction);
      return;
    }
    await withTenantDatabaseTransaction(this.database, tenantId, persist);
  }
}
