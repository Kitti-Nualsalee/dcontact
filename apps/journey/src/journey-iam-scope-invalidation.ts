import {
  assertTeamSegmentScopeChangedEnvelope,
  type TeamSegmentScopeChangedEnvelopeV2,
} from '@d-contact/cxa-contracts';
import { type Prisma } from '@d-contact/db';

const RESTRICTIVE_KINDS = new Set(['REVOKED', 'TEAM_DEACTIVATED', 'DELEGATION_REVOKED']);

export type JourneyIamScopeInvalidationResult =
  { state: 'DUPLICATE' } | { state: 'RECORDED'; scheduledCursorCount: number };

/**
 * รับ canonical IAM scope fact แล้วบันทึก durable inbox พร้อมคิว cancel ของ Journey ใน
 * owner-local transaction เดียวกัน. GRANTED ถูกเก็บเพื่อ dedup/audit เท่านั้น: สิทธิ์ใหม่
 * ห้าม revive enrollment หรือ action เก่าที่เคยถูก revoke ไปแล้ว.
 */
export class JourneyIamScopeInvalidationService {
  async apply(
    value: unknown,
    consumer: string,
    transaction: Prisma.TransactionClient,
  ): Promise<JourneyIamScopeInvalidationResult> {
    const event = assertTeamSegmentScopeChangedEnvelope(value);
    const existing = await transaction.jrIamScopeInvalidationInbox.findUnique({
      where: {
        consumer_tenantId_eventId: {
          consumer,
          tenantId: event.tenantId,
          eventId: event.eventId,
        },
      },
      select: { eventId: true },
    });
    if (existing) return { state: 'DUPLICATE' };

    const scheduledCursorCount = RESTRICTIVE_KINDS.has(event.payload.kind)
      ? await this.scheduleScopedRefilters(event, transaction)
      : 0;

    await transaction.jrIamScopeInvalidationInbox.create({
      data: {
        consumer,
        tenantId: event.tenantId,
        eventId: event.eventId,
        scopeVersion: event.payload.scopeVersion,
      },
    });
    return { state: 'RECORDED', scheduledCursorCount };
  }

  private async scheduleScopedRefilters(
    event: TeamSegmentScopeChangedEnvelopeV2,
    transaction: Prisma.TransactionClient,
  ): Promise<number> {
    const definitions = await transaction.jrJourneyDefinition.findMany({
      where: { tenantId: event.tenantId, ownerTeamId: event.payload.teamId },
      select: { journeyId: true, version: true },
    });
    if (definitions.length === 0) return 0;

    const versions = new Set(
      definitions.map(({ journeyId, version }) => `${journeyId}:${version}`),
    );
    const intents = await transaction.jrSegmentEnrollmentIntent.findMany({
      where: {
        tenantId: event.tenantId,
        journeyId: { in: definitions.map((definition) => definition.journeyId) },
      },
      select: {
        contactId: true,
        segmentId: true,
        receiptId: true,
        reasonMembershipRevision: true,
        journeyId: true,
        journeyVersion: true,
      },
    });
    const targets = intents.filter((intent) =>
      versions.has(`${intent.journeyId}:${intent.journeyVersion}`),
    );
    if (targets.length === 0) return 0;

    const result = await transaction.jrSegmentRefilterCursor.createMany({
      data: targets.map((intent) => ({
        tenantId: event.tenantId,
        contactId: intent.contactId,
        segmentId: intent.segmentId,
        membershipRevision: intent.reasonMembershipRevision,
        receiptId: intent.receiptId,
        reasonCode: `IAM_SCOPE_${event.payload.kind}`,
        correlationId: event.correlationId,
        scopeTeamId: event.payload.teamId,
      })),
      skipDuplicates: true,
    });
    return result.count;
  }
}
