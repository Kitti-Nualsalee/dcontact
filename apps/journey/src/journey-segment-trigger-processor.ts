/**
 * J3.6 (#217) — the apply phase of the segment membership receipt
 *
 * Closes the loop between the consumer (ingest) and the repository (persist): claims one READY receipt,
 * re-reads the exact entry from Customer 360, checks the current team scope, matches the published
 * SEGMENT_ENTRY definitions, then decides whether to enroll, re-filter, let it pass, or send it to review
 *
 * resolves everything outside the transaction (read-only) and opens a single transaction only to persist —
 * holding no DB lock while waiting for Customer 360 or IAM to answer, same as J2.7
 *
 * the caller cannot pass in a snapshot of membership or scope as an authority: the only trusted values
 * are what resolveEntry and the authorizer answer at the real processing time, not values that came with the event
 * (the stop condition of #217)
 */
import { createHash } from 'node:crypto';
import type { Prisma, PrismaClient } from '@d-contact/db';
import {
  contactId as toContactId,
  membershipRevision as toMembershipRevision,
  segmentEntryId as toSegmentEntryId,
  segmentId as toSegmentId,
  teamId as toTeamId,
  tenantId as toTenantId,
  type CustomerSegmentMembershipReader,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import { canonicalJson } from './event-inbox.js';
import type { JourneyDefinitionRepository } from './journey-definition-repository.js';
import {
  JourneySegmentReceiptRepository,
  type SegmentEnrollmentIntentInput,
} from './journey-segment-receipt-repository.js';

export type SegmentTriggerOutcome =
  | 'ENROLLED'
  | 'REFILTERED'
  | 'NO_MATCH'
  | 'NOT_ELIGIBLE'
  | 'DEFERRED'
  | 'DENIED'
  | 'REVIEW'
  | undefined;

export interface JourneySegmentTriggerProcessorPorts {
  membershipReader: CustomerSegmentMembershipReader<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
}

export interface JourneySegmentTriggerProcessorOptions {
  now?: () => Date;
  id?: () => string;
  retryDelayMs?: number;
  leaseSeconds?: number;
}

/** change kinds that carry a "new entry into the segment" — the rest are the job of re-filter */
const ENTRY_CHANGE_KINDS = new Set(['ENTERED']);

export class JourneySegmentTriggerProcessor {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly leaseSeconds: number;
  private readonly receipts: JourneySegmentReceiptRepository;

  constructor(
    database: PrismaClient,
    private readonly definitions: JourneyDefinitionRepository,
    private readonly ports: JourneySegmentTriggerProcessorPorts,
    options: JourneySegmentTriggerProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.receipts = new JourneySegmentReceiptRepository(database, {
      ...(options.id ? { id: options.id } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
  }

  /** processes at most one READY receipt per call; the caller sets the polling loop itself */
  async executeNext(tenantId: string, workerId: string): Promise<SegmentTriggerOutcome> {
    const claimed = await this.receipts.claimNextReady(tenantId, workerId, this.leaseSeconds);
    if (!claimed) return undefined;

    const at = this.now().toISOString();

    /**
     * a change that is not a new entry (LEFT/CORRECTED/REFILTER_REQUIRED/IDENTITY_INVALIDATED)
     * needs nothing resolved here — record it as work awaiting evaluation and let J3.7 continue. Trying to
     * decide on its behalf here would turn into re-filtering with half the data
     */
    if (!ENTRY_CHANGE_KINDS.has(claimed.changeKind)) {
      await this.receipts.applyRefilter(
        {
          tenantId,
          receiptId: claimed.id,
          reasonCode: claimed.changeKind,
          // LEFT closes that entry permanently while other kinds only order a re-evaluation
          ...(claimed.changeKind === 'LEFT' && claimed.entryId
            ? { terminalEntryId: claimed.entryId }
            : {}),
          correlationId: claimed.correlationId,
        },
        this.outboxEvent(claimed.contactId, claimed.segmentId, {
          kind: 'REFILTER_REQUESTED',
          reasonCode: claimed.changeKind,
        }),
      );
      return 'REFILTERED';
    }

    if (!claimed.entryId) {
      // an ENTERED without an entryId contradicts the contract itself — an abnormality that someone has to look at
      await this.receipts.markReview(tenantId, claimed.id, 'PAYLOAD_VALIDATION_FAILED');
      return 'REVIEW';
    }

    const resolution = await this.ports.membershipReader.resolveEntry({
      tenantId: toTenantId(tenantId),
      contactId: toContactId(claimed.contactId),
      segmentId: toSegmentId(claimed.segmentId),
      entryId: toSegmentEntryId(claimed.entryId),
      membershipRevision: toMembershipRevision(claimed.membershipRevision),
      at,
    });

    if (resolution.status === 'STALE') {
      // the context has not caught up, it is not that there is no permission — the whole evaluation must start over in the next round
      await this.receipts.markRetryableFailure(
        tenantId,
        claimed.id,
        this.retryDelayMs,
        'MEMBERSHIP_CONTEXT_STALE',
      );
      return 'DEFERRED';
    }
    if (resolution.status === 'AMBIGUOUS' || resolution.status === 'NOT_FOUND') {
      /**
       * uses the reason code exactly as Customer 360 answered but does not try to say more — separating
       * "does not exist" from "belongs to another tenant" would let a caller guess existence across tenants
       */
      await this.receipts.markReview(tenantId, claimed.id, resolution.reasonCode);
      return 'REVIEW';
    }
    if (resolution.status !== 'ELIGIBLE') {
      await this.receipts.applyNoOp(tenantId, claimed.id);
      return 'NOT_ELIGIBLE';
    }

    const matched = await this.definitions.findPublishedBySegmentTrigger(
      tenantId,
      claimed.segmentId,
    );
    if (matched.length === 0) {
      // no journey cares about this segment — the head must still advance, otherwise the next revision gets stuck
      await this.receipts.applyNoOp(tenantId, claimed.id);
      return 'NO_MATCH';
    }

    /**
     * only the survivor Customer 360 decided can be used, not the contactId that came with the event
     * — a merge makes the two differ, and using the value from the event would create an enrollment for a contact
     * that no longer exists
     */
    const canonicalContactId = resolution.contactId;

    const scopes = await Promise.all(
      matched.map((definition) =>
        this.ports.teamContactScopeAuthorizer.authorize({
          tenantId: toTenantId(tenantId),
          teamId: toTeamId(definition.ownerTeamId),
          contactId: toContactId(canonicalContactId),
          permission: 'WORK',
          at,
        }),
      ),
    );

    if (scopes.some((scope) => scope.decision === 'DEFER')) {
      await this.receipts.markRetryableFailure(
        tenantId,
        claimed.id,
        this.retryDelayMs,
        'SCOPE_CONTEXT_STALE',
      );
      return 'DEFERRED';
    }

    /**
     * DENY means "this team cannot work with this contact", not a Governance block — recording it as a
     * Governance BLOCK is strictly forbidden (acceptance of #217); it just creates no enrollment for that team
     */
    const allowed = matched.filter((_, index) => scopes[index]?.decision === 'ALLOW');
    if (allowed.length === 0) {
      await this.receipts.applyNoOp(tenantId, claimed.id);
      return 'DENIED';
    }

    const intents: SegmentEnrollmentIntentInput[] = allowed.map((definition) => ({
      journeyId: definition.journeyId,
      journeyVersion: definition.version,
      entryStepId: definition.graph.entryStepId,
      reasonMembershipRevision: resolution.membershipRevision,
      reasonDefinitionVersion: resolution.segmentDefinitionVersion,
      reasonDigest: resolution.stateDigest,
      ...(resolution.evidenceRef ? { reasonEvidenceRef: resolution.evidenceRef } : {}),
    }));

    await this.receipts.applyEnrollment(
      {
        tenantId,
        receiptId: claimed.id,
        entryId: claimed.entryId,
        canonicalContactId,
        intents,
        correlationId: claimed.correlationId,
        ...(claimed.causationId ? { causationId: claimed.causationId } : {}),
      },
      this.outboxEvent(canonicalContactId, claimed.segmentId, {
        kind: 'SEGMENT_ENTRY_ENROLLED',
        journeys: intents.map((intent) => ({
          journeyId: intent.journeyId,
          journeyVersion: intent.journeyVersion,
        })),
      }),
    );
    return 'ENROLLED';
  }

  /**
   * the outbox payload can hold only a reference/version/digest like the enrollment reason
   * — no attribute values, no raw identity and no segment definition
   */
  private outboxEvent(
    contactIdValue: string,
    segmentIdValue: string,
    body: Record<string, unknown>,
  ) {
    const payload = { contractVersion: 1, segmentId: segmentIdValue, ...body };
    return {
      eventType: 'journey.segment_entry.recorded',
      orderingKey: `${contactIdValue}:${segmentIdValue}`,
      payload,
      // the hash must always be computed from the real payload; a random value would make the whole integrity check meaningless
      payloadHash: createHash('sha256').update(canonicalJson(payload)).digest('hex'),
    };
  }
}
