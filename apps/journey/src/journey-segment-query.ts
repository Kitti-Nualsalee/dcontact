/**
 * J3.8 (#219) — sanitized read of the segment membership stream for forensic work
 *
 * "sanitized" here does not mean filtering PII out afterwards but means **never reading a column that may hold PII
 * in the first place** — every select names its fields explicitly, with no bare `findMany()` that pulls the whole row up and
 * then hopes it is all mapped out, because the day someone adds a new column the latter leaks silently
 *
 * the outbox payload and the intent reason are not returned at all: the intent keeps only a ref/version/digest
 * to begin with, but a digest is a value used to confirm correctness, not a value an operator needs to see
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export interface SegmentReceiptView {
  receiptId: string;
  source: string;
  eventId: string;
  membershipRevision: number;
  changeKind: string;
  entryId: string | null;
  supersedesRevision: number | null;
  state: string;
  attempts: number;
  version: number;
  reviewReasonCode: string | null;
  receivedAt: string;
  appliedAt: string | null;
}

export interface SegmentRefilterView {
  cursorId: string;
  membershipRevision: number;
  state: string;
  attempts: number;
  version: number;
  reasonCode: string | null;
  availableAt: string;
  settledAt: string | null;
}

export interface SegmentEnrollmentView {
  intentId: string;
  journeyId: string;
  journeyVersion: number;
  entryId: string;
  reasonMembershipRevision: number;
  reasonDefinitionVersion: number;
  enrollmentId: string | null;
  enrollmentState: string | null;
  runState: string | null;
  terminalReason: string | null;
}

export interface SegmentStreamView {
  contactId: string;
  segmentId: string;
  lastAppliedRevision: number;
  terminalEntryId: string | null;
  terminalRevision: number | null;
  terminalReasonCode: string | null;
  updatedAt: string;
  /**
   * a revision that has not been applied and has no receipt behind it — the hole the operator needs to hunt for
   * computed from receipts that really exist, not guessed from the head alone
   */
  gaps: number[];
  receipts: SegmentReceiptView[];
  refilters: SegmentRefilterView[];
  enrollments: SegmentEnrollmentView[];
  recoveries: { operation: string; targetRef: string; reasonCode: string; recordedAt: string }[];
}

export class JourneySegmentQuery {
  constructor(private readonly database: PrismaClient) {}

  /** returns undefined when this stream does not exist — the caller must convert it to a 404 the same as for something that never existed */
  async readStream(
    tenantId: string,
    contactId: string,
    segmentId: string,
  ): Promise<SegmentStreamView | undefined> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const head = await transaction.jrSegmentHead.findUnique({
        where: { tenantId_contactId_segmentId: { tenantId, contactId, segmentId } },
        select: {
          lastAppliedRevision: true,
          terminalEntryId: true,
          terminalRevision: true,
          terminalReasonCode: true,
          updatedAt: true,
        },
      });
      if (!head) return undefined;

      const receipts = await transaction.jrSegmentReceipt.findMany({
        where: { tenantId, contactId, segmentId },
        orderBy: { membershipRevision: 'asc' },
        select: {
          id: true,
          source: true,
          eventId: true,
          membershipRevision: true,
          changeKind: true,
          entryId: true,
          supersedesRevision: true,
          state: true,
          attempts: true,
          version: true,
          reviewReasonCode: true,
          receivedAt: true,
          appliedAt: true,
        },
      });

      const refilters = await transaction.jrSegmentRefilterCursor.findMany({
        where: { tenantId, contactId, segmentId },
        orderBy: { membershipRevision: 'asc' },
        select: {
          id: true,
          membershipRevision: true,
          state: true,
          attempts: true,
          version: true,
          reasonCode: true,
          availableAt: true,
          settledAt: true,
        },
      });

      const intents = await transaction.jrSegmentEnrollmentIntent.findMany({
        where: { tenantId, contactId, segmentId },
        orderBy: [{ entryId: 'asc' }, { journeyId: 'asc' }],
        select: {
          id: true,
          journeyId: true,
          journeyVersion: true,
          entryId: true,
          reasonMembershipRevision: true,
          reasonDefinitionVersion: true,
          enrollment: {
            select: { id: true, state: true, runState: true, terminalReason: true },
          },
        },
      });

      const recoveries = await transaction.jrRecoveryAudit.findMany({
        where: {
          tenantId,
          targetKind: { in: ['SEGMENT_RECEIPT', 'SEGMENT_REFILTER'] },
          targetRef: {
            in: [
              ...receipts.map((receipt) => receipt.eventId),
              ...refilters.map((cursor) => cursor.id),
            ],
          },
        },
        orderBy: { occurredAt: 'asc' },
        select: { operation: true, targetRef: true, reasonCode: true, occurredAt: true },
      });

      return {
        contactId,
        segmentId,
        lastAppliedRevision: head.lastAppliedRevision,
        terminalEntryId: head.terminalEntryId,
        terminalRevision: head.terminalRevision,
        terminalReasonCode: head.terminalReasonCode,
        updatedAt: head.updatedAt.toISOString(),
        gaps: findGaps(receipts.map((receipt) => receipt.membershipRevision)),
        receipts: receipts.map((receipt) => ({
          receiptId: receipt.id,
          source: receipt.source,
          eventId: receipt.eventId,
          membershipRevision: receipt.membershipRevision,
          changeKind: receipt.changeKind,
          entryId: receipt.entryId,
          supersedesRevision: receipt.supersedesRevision,
          state: receipt.state,
          attempts: receipt.attempts,
          version: receipt.version,
          reviewReasonCode: receipt.reviewReasonCode,
          receivedAt: receipt.receivedAt.toISOString(),
          appliedAt: receipt.appliedAt?.toISOString() ?? null,
        })),
        refilters: refilters.map((cursor) => ({
          cursorId: cursor.id,
          membershipRevision: cursor.membershipRevision,
          state: cursor.state,
          attempts: cursor.attempts,
          version: cursor.version,
          reasonCode: cursor.reasonCode,
          availableAt: cursor.availableAt.toISOString(),
          settledAt: cursor.settledAt?.toISOString() ?? null,
        })),
        enrollments: intents.map((intent) => ({
          intentId: intent.id,
          journeyId: intent.journeyId,
          journeyVersion: intent.journeyVersion,
          entryId: intent.entryId,
          reasonMembershipRevision: intent.reasonMembershipRevision,
          reasonDefinitionVersion: intent.reasonDefinitionVersion,
          enrollmentId: intent.enrollment?.id ?? null,
          enrollmentState: intent.enrollment?.state ?? null,
          runState: intent.enrollment?.runState ?? null,
          terminalReason: intent.enrollment?.terminalReason ?? null,
        })),
        recoveries: recoveries.map((entry) => ({
          operation: entry.operation,
          targetRef: entry.targetRef,
          reasonCode: entry.reasonCode,
          recordedAt: entry.occurredAt.toISOString(),
        })),
      };
    });
  }
}

/**
 * a hole in a stream is a revision with no receipt at all, between the first and the last one seen
 *
 * it does not always start from 1, because retention may have correctly deleted old revisions; reporting them as holes
 * would make the operator chase something that was deliberately deleted
 */
function findGaps(revisions: readonly number[]): number[] {
  if (revisions.length === 0) return [];
  const present = new Set(revisions);
  const gaps: number[] = [];
  for (let revision = revisions[0]!; revision < revisions[revisions.length - 1]!; revision += 1) {
    if (!present.has(revision)) gaps.push(revision);
  }
  return gaps;
}
