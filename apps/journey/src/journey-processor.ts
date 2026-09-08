import type { ContactGovernanceService } from '@d-contact/contact-governance';
import {
  type ChannelType,
  type CgDecision,
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
    super(`journey event is not published in the active tenant: ${receiptId}`);
    this.name = 'JourneyEventNotReadyError';
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
  ): Promise<JourneyProcessingResult> {
    const event = await this.loadEvent(tenantId, input.receiptId);
    const enrollmentId = input.receiptId;
    const actionKey = createJourneyActionKey({
      enrollmentId,
      journeyVersion: input.journeyVersion,
      stepId: input.stepId,
    });
    const resolved = await this.resolveContact(tenantId, event);
    const authorization = await this.governance.authorizeAndReserve(
      tenantId,
      resolved
        ? {
            contactId: resolved.contactId,
            identityId: resolved.identityId,
            channel: input.channel,
            purpose: input.purpose,
            source: 'JOURNEY',
            sourceId: input.receiptId,
            actionKey,
            policyVersion: input.policyVersion,
          }
        : {
            identityResolution: event.contactRef.kind === 'CRM_ID' ? 'AMBIGUOUS' : 'NOT_FOUND',
            channel: input.channel,
            purpose: input.purpose,
            source: 'JOURNEY',
            sourceId: input.receiptId,
            actionKey,
            policyVersion: input.policyVersion,
          },
    );

    await this.markProcessed(tenantId, input.receiptId);

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

  private async loadEvent(tenantId: string, receiptId: string): Promise<InboundBusinessEvent> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const inbox = await transaction.jrEventInbox.findFirst({
        where: { id: receiptId, tenantId, state: { in: ['PUBLISHED', 'PROCESSED'] } },
        select: { payload: true },
      });
      if (!inbox) throw new JourneyEventNotReadyError(receiptId);
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

  private async markProcessed(tenantId: string, receiptId: string): Promise<void> {
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.jrEventInbox.updateMany({
        where: { id: receiptId, tenantId, state: { in: ['PUBLISHED', 'PROCESSED'] } },
        data: { state: 'PROCESSED', processedAt: this.now() },
      });
    });
  }
}
