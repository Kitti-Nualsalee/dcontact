/**
 * J3.10 (#221) — baseline of memberships that existed before J3 was turned on, and projection rebuild
 *
 * The heart of this is what must not be done: **a contact already in a segment before the system was turned on must not be
 * enrolled**, because their entry into the segment already happened in the past and is not a new event. Creating
 * an enrollment for everyone at turn-on would fire the campaign at the entire customer base at once with nobody ordering it
 *
 * The baseline therefore writes only the head to match the current Customer 360 revision — no receipt that
 * carries an entry, no intent, no outbox. After that the next revision that really arrives is processed as normal
 * and only a real OUT -> IN creates a new entry
 *
 * Always repeatable: every run gives the same result, and a head that has moved further ahead is never pulled backwards
 */
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export interface SegmentBaselineResult {
  /** streams that got a baseline in this round */
  baselined: number;
  /** streams that already have a head and need no touching */
  skipped: number;
  /** cursor to call again with — undefined means finished */
  nextCursor?: { contactId: string; segmentId: string };
}

export interface SegmentBaselineInput {
  tenantId: string;
  /** number of streams per round — lets the caller control the transaction size itself */
  batchSize?: number;
  /** the position left over from the previous round */
  cursor?: { contactId: string; segmentId: string };
}

export class JourneySegmentBaseline {
  constructor(private readonly database: PrismaClient) {}

  /**
   * sets the baseline batch by batch, resumably
   *
   * sorted by (contactId, segmentId), which is the primary key of the C360 head — so the order is stable
   * across rounds and restarts, unlike sorting by time where new rows would be inserted in the middle of the batches already done
   * and make some streams get skipped silently
   */
  async baselineNext(input: SegmentBaselineInput): Promise<SegmentBaselineResult> {
    const batchSize = input.batchSize ?? 100;
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const memberships = await transaction.c360SegmentMembershipHead.findMany({
        where: {
          tenantId: input.tenantId,
          ...(input.cursor
            ? {
                OR: [
                  { contactId: { gt: input.cursor.contactId } },
                  {
                    contactId: input.cursor.contactId,
                    segmentId: { gt: input.cursor.segmentId },
                  },
                ],
              }
            : {}),
        },
        orderBy: [{ contactId: 'asc' }, { segmentId: 'asc' }],
        take: batchSize,
        select: {
          contactId: true,
          segmentId: true,
          membershipRevision: true,
          state: true,
          entryId: true,
        },
      });
      if (memberships.length === 0) return { baselined: 0, skipped: 0 };

      let baselined = 0;
      let skipped = 0;
      for (const membership of memberships) {
        const key = {
          tenantId_contactId_segmentId: {
            tenantId: input.tenantId,
            contactId: membership.contactId,
            segmentId: membership.segmentId,
          },
        };
        const existing = await transaction.jrSegmentHead.findUnique({
          where: key,
          select: { lastAppliedRevision: true },
        });

        /**
         * an existing head is not touched at all, whether higher or lower than the current revision
         *
         * higher = the system has moved far ahead, pulling it back would make an already applied revision be processed again
         * lower = a revision is really waiting, and jumping forward would swallow it with nobody knowing
         */
        if (existing) {
          skipped += 1;
          continue;
        }

        await transaction.jrSegmentHead.create({
          data: {
            tenantId: input.tenantId,
            contactId: membership.contactId,
            segmentId: membership.segmentId,
            lastAppliedRevision: membership.membershipRevision,
            /**
             * terminal is not set even if the current membership is OUT/INVALIDATED
             *
             * terminal is the record that "this entry was closed by an event J3 saw" but the baseline did not
             * see that event; writing it would be fabricating a history that never passed through this system
             */
          },
        });
        baselined += 1;
      }

      const last = memberships[memberships.length - 1]!;
      return {
        baselined,
        skipped,
        ...(memberships.length === batchSize
          ? { nextCursor: { contactId: last.contactId, segmentId: last.segmentId } }
          : {}),
      };
    });
  }

  /** walks the baseline to the end across the whole tenant — combining the results of every round */
  async baselineTenant(
    tenantId: string,
    batchSize = 100,
  ): Promise<{ baselined: number; skipped: number; batches: number }> {
    let cursor: SegmentBaselineResult['nextCursor'];
    let baselined = 0;
    let skipped = 0;
    let batches = 0;
    do {
      const result: SegmentBaselineResult = await this.baselineNext({
        tenantId,
        batchSize,
        ...(cursor ? { cursor } : {}),
      });
      baselined += result.baselined;
      skipped += result.skipped;
      batches += 1;
      cursor = result.nextCursor;
    } while (cursor);
    return { baselined, skipped, batches };
  }

  /**
   * rebuilds the head from applied receipts only
   *
   * used when the projection is damaged and must be reassembled — reads from the receipt ledger, which is a fact that really passed
   * through the system, not from Customer 360 directly, because the J3 head must reflect "what J3 has processed"
   * not "what Customer 360 says now"; the two differ when a revision is pending
   *
   * touches no intent, enrollment or outbox at all — rebuilding the projection is not a replay of effects
   */
  async rebuildHead(
    tenantId: string,
    contactId: string,
    segmentId: string,
  ): Promise<{ lastAppliedRevision: number; rebuilt: boolean }> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`jr-segment-stream:${tenantId}:${contactId}:${segmentId}`}))`,
      );
      const applied = await transaction.jrSegmentReceipt.findFirst({
        where: { tenantId, contactId, segmentId, state: 'APPLIED' },
        orderBy: { membershipRevision: 'desc' },
        select: { id: true, membershipRevision: true },
      });
      if (!applied) return { lastAppliedRevision: 0, rebuilt: false };

      const key = { tenantId_contactId_segmentId: { tenantId, contactId, segmentId } };
      const head = await transaction.jrSegmentHead.findUnique({
        where: key,
        select: { lastAppliedRevision: true },
      });
      if (head?.lastAppliedRevision === applied.membershipRevision) {
        return { lastAppliedRevision: applied.membershipRevision, rebuilt: false };
      }

      await transaction.jrSegmentHead.upsert({
        where: key,
        create: {
          tenantId,
          contactId,
          segmentId,
          lastAppliedRevision: applied.membershipRevision,
          lastAppliedReceiptId: applied.id,
        },
        update: {
          lastAppliedRevision: applied.membershipRevision,
          lastAppliedReceiptId: applied.id,
        },
      });
      return { lastAppliedRevision: applied.membershipRevision, rebuilt: true };
    });
  }
}
