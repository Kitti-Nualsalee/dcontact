import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type {
  C360FactSnapshotInput,
  C360SegmentDefinitionContentV1,
} from './segment-definition.js';
import { C360SegmentRepositoryError, type C360SegmentRepository } from './segment-repository.js';
import type {
  C360MembershipCommitResult,
  C360SegmentMembershipRepository,
} from './segment-membership-repository.js';

/**
 * #911: a per-tenant system segment that an Admin grants to teams through the existing team-scopes
 * the existence of a segment grants nobody access by itself — only a team_segment_scope set by an Admin does
 */
export interface C360SystemSegment {
  segmentId: string;
  definition: C360SegmentDefinitionContentV1;
}

export const C360_SYSTEM_SEGMENTS: readonly C360SystemSegment[] = Object.freeze([
  {
    segmentId: 'system:all-customers',
    definition: {
      contractVersion: 1,
      name: 'ลูกค้าทั้งหมด',
      expression: { language: 'DC_EXPR', version: 1, expression: { type: 'literal', value: true } },
    },
  },
  {
    segmentId: 'system:vip',
    definition: {
      contractVersion: 1,
      name: 'VIP',
      expression: {
        language: 'DC_EXPR',
        version: 1,
        expression: {
          type: 'comparison',
          operator: 'eq',
          left: { type: 'ref', path: ['contact', 'vip'] },
          right: { type: 'literal', value: true },
        },
      },
    },
  },
] as C360SystemSegment[]);

/** Binds the snapshot to the profile revision read together with the facts; revision changed = must re-evaluate */
export const C360_FACTS_MARKER_PREFIX = 'c360-facts:v1:';

export function c360ContactFacts(contact: {
  vip: boolean;
  company: string | null;
}): C360FactSnapshotInput['attributes'] {
  return {
    vip: { type: 'BOOLEAN', value: contact.vip },
    company:
      contact.company === null
        ? { type: 'NULL', value: null }
        : { type: 'STRING', value: contact.company },
  };
}

/**
 * commandId is stable per (contact, segment, definition, snapshot, expected revision) — a retry gives the same result
 * the receipt is unique per tenant, so it must include contactId, otherwise another contact collides as IDEMPOTENCY_CONFLICT
 */
export function c360SystemEvaluationCommandId(input: {
  contactId: string;
  segmentId: string;
  segmentDefinitionVersion: number;
  snapshotVersion: number;
  expectedMembershipRevision: number;
}): string {
  return `c360-system-eval:${input.contactId}:${input.segmentId}:${input.segmentDefinitionVersion}:${input.snapshotVersion}:${input.expectedMembershipRevision}`;
}

export interface C360PublishedSystemSegment {
  segmentId: string;
  version: number;
}

export interface C360SegmentRuntimeResult {
  contacts: number;
  snapshots: number;
  commits: Partial<Record<C360MembershipCommitResult['status'], number>>;
  skipped: number;
}

type DirtyContact = {
  id: string;
  vip: boolean;
  company: string | null;
  profile_revision: bigint;
  snapshot_version: number | null;
  correlation_id: string | null;
};

/**
 * Evaluates the system segment for contacts whose latest facts are older than the current data or that have no result for the
 * current segment/definition, using the existing owner writer (recordFactSnapshot/commitEvaluation) throughout
 * so it gets outbox → relay → IAM projection along the same path as other segments
 */
export class C360SegmentRuntime {
  constructor(
    private readonly database: PrismaClient,
    private readonly segments: C360SegmentRepository,
    private readonly memberships: C360SegmentMembershipRepository,
    private readonly systemSegments: readonly C360SystemSegment[] = C360_SYSTEM_SEGMENTS,
  ) {}

  /** creates and publishes v1 if missing; if it exists returns the published version (does not overwrite an edited segment) */
  async ensureSystemSegments(tenantId: string): Promise<C360PublishedSystemSegment[]> {
    const published: C360PublishedSystemSegment[] = [];
    for (const segment of this.systemSegments) {
      const current = await this.segments.resolvePublished(tenantId, segment.segmentId);
      if (current) {
        published.push({ segmentId: segment.segmentId, version: current.segmentDefinitionVersion });
        continue;
      }
      const draft = await this.segments.createVersion({
        tenantId,
        segmentId: segment.segmentId,
        version: 1,
        definition: segment.definition,
        correlationId: `c360-system-segment:${segment.segmentId}:v1`,
      });
      try {
        await this.segments.publishVersion({
          tenantId,
          segmentId: segment.segmentId,
          version: 1,
          expectedContentDigest: draft.contentDigest,
          expectedHeadVersion: 0,
        });
      } catch (error) {
        // another instance published first: use the published result
        if (!(error instanceof C360SegmentRepositoryError)) throw error;
      }
      const after = await this.segments.resolvePublished(tenantId, segment.segmentId);
      if (after)
        published.push({ segmentId: segment.segmentId, version: after.segmentDefinitionVersion });
    }
    return published;
  }

  async evaluatePending(tenantId: string, limit = 100): Promise<C360SegmentRuntimeResult> {
    const segments = await this.ensureSystemSegments(tenantId);
    const result: C360SegmentRuntimeResult = { contacts: 0, snapshots: 0, commits: {}, skipped: 0 };
    if (segments.length === 0) return result;
    const dirty = await this.pendingContacts(tenantId, segments, limit);
    for (const contact of dirty) {
      result.contacts += 1;
      try {
        let snapshotVersion = contact.snapshot_version ?? 0;
        const marker = `${C360_FACTS_MARKER_PREFIX}${contact.profile_revision}`;
        if (contact.correlation_id !== marker) {
          snapshotVersion += 1;
          await this.segments.recordFactSnapshot({
            tenantId,
            contactId: contact.id,
            snapshotVersion,
            attributes: c360ContactFacts(contact),
            computed: {},
            sourceCutoffAt: new Date().toISOString(),
            correlationId: marker,
          });
          result.snapshots += 1;
        }
        for (const segment of segments) {
          const head = await withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
            tx.c360SegmentMembershipHead.findUnique({
              where: {
                tenantId_contactId_segmentId: {
                  tenantId,
                  contactId: contact.id,
                  segmentId: segment.segmentId,
                },
              },
              select: {
                membershipRevision: true,
                snapshotVersion: true,
                segmentDefinitionVersion: true,
              },
            }),
          );
          if (
            head &&
            head.snapshotVersion >= snapshotVersion &&
            head.segmentDefinitionVersion === segment.version
          )
            continue;
          const expectedMembershipRevision = head?.membershipRevision ?? 0;
          const commit = await this.memberships.commitEvaluation({
            tenantId,
            contactId: contact.id,
            segmentId: segment.segmentId,
            segmentDefinitionVersion: segment.version,
            snapshotVersion,
            expectedMembershipRevision,
            commandId: c360SystemEvaluationCommandId({
              contactId: contact.id,
              segmentId: segment.segmentId,
              segmentDefinitionVersion: segment.version,
              snapshotVersion,
              expectedMembershipRevision,
            }),
            correlationId: `c360-system-eval:${contact.id}:${snapshotVersion}`,
          });
          result.commits[commit.status] = (result.commits[commit.status] ?? 0) + 1;
        }
      } catch (error) {
        // raced with another instance (version/idempotency conflict): skip and wait for the next round
        if (!(error instanceof C360SegmentRepositoryError)) throw error;
        result.skipped += 1;
      }
    }
    return result;
  }

  /**
   * contacts that need work: no snapshot yet, a snapshot bound to an old revision, or no result for the
   * current segment/definition on the latest snapshot (and not yet tried with the same commandId —
   * so a quarantined contact does not loop every round), excluding identities that are not ACTIVE
   */
  private pendingContacts(
    tenantId: string,
    segments: readonly C360PublishedSystemSegment[],
    limit: number,
  ): Promise<DirtyContact[]> {
    const values = Prisma.join(
      segments.map((segment) => Prisma.sql`(${segment.segmentId}::text, ${segment.version}::int)`),
    );
    return withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      tx.$queryRaw<DirtyContact[]>(Prisma.sql`
        SELECT c.id, c.vip, c.company, c.profile_revision, s.snapshot_version, s.correlation_id
        FROM contacts c
        LEFT JOIN LATERAL (
          SELECT f.snapshot_version, f.correlation_id
          FROM c360_fact_snapshots f
          WHERE f.tenant_id = c.tenant_id AND f.contact_id = c.id
          ORDER BY f.snapshot_version DESC
          LIMIT 1
        ) s ON true
        WHERE c.tenant_id = ${tenantId}::uuid
          AND NOT EXISTS (
            SELECT 1 FROM c360_identity_heads ih
            WHERE ih.tenant_id = c.tenant_id AND ih.contact_id = c.id AND ih.state <> 'ACTIVE'
          )
          AND (
            s.snapshot_version IS NULL
            OR s.correlation_id <> (${C360_FACTS_MARKER_PREFIX} || c.profile_revision::text)
            OR EXISTS (
              SELECT 1
              FROM (VALUES ${values}) AS seg(segment_id, version)
              LEFT JOIN c360_segment_membership_heads h
                ON h.tenant_id = c.tenant_id AND h.contact_id = c.id AND h.segment_id = seg.segment_id
              WHERE (h.contact_id IS NULL
                  OR h.snapshot_version < s.snapshot_version
                  OR h.segment_definition_version <> seg.version)
                AND NOT EXISTS (
                  SELECT 1 FROM c360_membership_command_receipts r
                  WHERE r.tenant_id = c.tenant_id
                    AND r.command_id = 'c360-system-eval:' || c.id::text || ':' || seg.segment_id || ':' || seg.version
                      || ':' || s.snapshot_version || ':' || COALESCE(h.membership_revision, 0)
                )
            )
          )
        ORDER BY c.created_at, c.id
        LIMIT ${limit}
      `),
    );
  }
}
