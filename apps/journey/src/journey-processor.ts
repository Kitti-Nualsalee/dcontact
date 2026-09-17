import type {
  AuthorizeAndReserveInput,
  AuthorizationOutcome,
  ContactAuthorizationPort,
  CustomerContextReader,
  CustomerContextResolution,
  TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import {
  contactId as toContactId,
  teamId as toTeamId,
  tenantId as toTenantId,
} from '@d-contact/cxa-contracts';
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
  teamId?: string;
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
  decisionId?: string;
  decision?: CgDecision;
  reasonCode: string;
  reservationId?: string;
  action?: AuthorizedJourneyAction;
  scopeDecision?: 'DENY';
}

export interface JourneyProcessorOptions {
  now?: () => Date;
}

interface ResolvedContact {
  contactId: string;
  identityId: string;
}

export interface JourneyProcessorPorts {
  customerContextReader: CustomerContextReader<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
  contactAuthorizationPort: ContactAuthorizationPort<Prisma.TransactionClient>;
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

export class JourneyScopeContextStaleError extends Error {
  readonly code = 'SCOPE_CONTEXT_STALE';

  constructor(readonly receiptId: string) {
    super(`Journey scope ยังไม่สดสำหรับ receipt: ${receiptId}`);
    this.name = 'JourneyScopeContextStaleError';
  }
}

export class JourneyProcessor {
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly ports: JourneyProcessorPorts,
    options: JourneyProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async processEvent(
    tenantId: string,
    input: ProcessJourneyEventInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<JourneyProcessingResult> {
    const event = await this.loadEvent(tenantId, input, transaction);
    const enrollmentId = input.receiptId;
    const actionKey = createJourneyActionKey({
      enrollmentId,
      journeyVersion: input.journeyVersion,
      stepId: input.stepId,
    });
    const resolution = await this.ports.customerContextReader.resolveCurrentContext(
      {
        tenantId: toTenantId(tenantId),
        contactRef: event.contactRef,
        at: this.now().toISOString(),
      },
      transaction,
    );
    const resolved = this.toResolvedContact(resolution);
    if (resolved && input.teamId) {
      const scope = await this.ports.teamContactScopeAuthorizer.authorize(
        {
          tenantId: toTenantId(tenantId),
          teamId: toTeamId(input.teamId),
          contactId: toContactId(resolved.contactId),
          permission: 'CONTACT',
          at: this.now().toISOString(),
        },
        transaction,
      );
      if (scope.decision === 'DENY') {
        await this.ensureEnrollment(tenantId, input, transaction);
        await this.persistScopeDenied(tenantId, input, resolved, transaction);
        return {
          receiptId: input.receiptId,
          enrollmentId,
          actionKey,
          reasonCode: scope.reasonCode,
          scopeDecision: 'DENY',
        };
      }
      if (scope.decision === 'DEFER') {
        // ห้ามสร้าง enrollment หรือเรียก Governance จาก scope ที่ stale; Kafka handler จะไม่
        // mark receipt ว่า PROCESSED จึง retry โดย resolve IAM ใหม่ทั้งเส้นทาง.
        throw new JourneyScopeContextStaleError(input.receiptId);
      }
    }
    await this.ensureEnrollment(tenantId, input, transaction);
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
          identityResolution: resolution.status === 'AMBIGUOUS' ? 'AMBIGUOUS' : 'NOT_FOUND',
        };
    const authorization = await this.ports.contactAuthorizationPort.authorizeAndReserve(
      tenantId,
      authorizationInput,
      transaction,
    );

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

  private async loadEvent(
    tenantId: string,
    input: ProcessJourneyEventInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<InboundBusinessEvent> {
    const load = async (
      transactionClient: Prisma.TransactionClient,
    ): Promise<InboundBusinessEvent> => {
      const inbox = await transactionClient.jrEventInbox.findFirst({
        where: { id: input.receiptId, tenantId, state: { in: ['PUBLISHED', 'PROCESSED'] } },
        select: { payload: true },
      });
      if (!inbox) throw new JourneyEventNotReadyError(input.receiptId);

      return inbox.payload as unknown as InboundBusinessEvent;
    };
    return transaction
      ? load(transaction)
      : withTenantDatabaseTransaction(this.database, tenantId, load);
  }

  private async ensureEnrollment(
    tenantId: string,
    input: ProcessJourneyEventInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const ensure = async (transactionClient: Prisma.TransactionClient): Promise<void> => {
      await transactionClient.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`journey-enrollment:${tenantId}:${input.receiptId}`}))`,
      );
      const enrollment = await transactionClient.jrEnrollment.findFirst({
        where: { tenantId, eventInboxId: input.receiptId },
        select: { journeyVersion: true },
      });
      if (enrollment && enrollment.journeyVersion !== input.journeyVersion) {
        throw new JourneyEnrollmentConflictError(input.receiptId);
      }
      if (!enrollment) {
        await transactionClient.jrEnrollment.create({
          data: {
            id: input.receiptId,
            tenantId,
            eventInboxId: input.receiptId,
            journeyVersion: input.journeyVersion,
            state: 'PENDING',
          },
        });
      }
    };
    if (transaction) {
      await ensure(transaction);
      return;
    }
    await withTenantDatabaseTransaction(this.database, tenantId, ensure);
  }

  private toResolvedContact(resolution: CustomerContextResolution): ResolvedContact | undefined {
    return resolution.status === 'RESOLVED' && resolution.identityId
      ? { contactId: resolution.contactId, identityId: resolution.identityId }
      : undefined;
  }

  private async persistScopeDenied(
    tenantId: string,
    input: ProcessJourneyEventInput,
    resolved: ResolvedContact,
    transaction?: Prisma.TransactionClient,
  ): Promise<void> {
    const persist = async (transactionClient: Prisma.TransactionClient): Promise<void> => {
      await transactionClient.jrEnrollment.updateMany({
        where: { id: input.receiptId, tenantId },
        data: { state: 'BLOCKED', contactId: resolved.contactId, decisionId: null },
      });
      await transactionClient.jrEventInbox.updateMany({
        where: { id: input.receiptId, tenantId, state: { in: ['PUBLISHED', 'PROCESSED'] } },
        data: { state: 'PROCESSED', processedAt: this.now() },
      });
    };
    if (transaction) {
      await persist(transaction);
      return;
    }
    await withTenantDatabaseTransaction(this.database, tenantId, persist);
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
