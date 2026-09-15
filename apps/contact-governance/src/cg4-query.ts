import {
  withTenantDatabaseTransaction,
  type Cg4PolicyStatus,
  type PrismaClient,
} from '@d-contact/db';
import type {
  Cg4Digest,
  Cg4ExceptionRiskTier,
  Cg4ExceptionWorkflowState,
  Cg4PolicyDiffClass,
  ContactChannel,
} from '@d-contact/cxa-contracts';
import { resolveCg4EffectiveState } from './cg4-exception-evaluation.js';
import {
  redactCg4Actor,
  redactCg4Ref,
  type Cg4EvidenceAccessLevel,
  type Cg4RedactedRef,
} from './cg4-redaction.js';

/**
 * CG4.7 (#190): the CG4 read surface, with redaction applied here rather than per route.
 *
 * Every query is tenant-scoped through `withTenantDatabaseTransaction`, and a miss always
 * returns `undefined`/`[]` — the caller turns that into a generic 404 so a cross-tenant id
 * is indistinguishable from one that never existed (#179 §3).
 */

export interface Cg4QueryContext {
  tenantId: string;
  level: Cg4EvidenceAccessLevel;
}

type Ref = string | Cg4RedactedRef | undefined;

export interface Cg4ExceptionRevisionView {
  seriesId: string;
  revisionId: string;
  revision: number;
  contactId: string;
  identityId?: string;
  scopeKind: string;
  channel: string;
  purpose: string;
  sourceType: string;
  sourceId: string;
  allowedRuleCodes: string[];
  policyId: string;
  policyVersion: number;
  policyContentDigest: Cg4Digest;
  registryVersion: string;
  startsAt: string;
  expiresAt: string;
  riskTier: Cg4ExceptionRiskTier;
  reasonCode: string;
  contentDigest: Cg4Digest;
  createdAt: string;
  ticketRef?: Ref;
  evidenceRef: Ref;
  actorRef: string | Cg4RedactedRef;
  renewsSeriesId?: string;
}

/** Read model for a whole series at its current revision; the write-side
 * `Cg4ExceptionView` in cg4-foundation-repository.ts is one recorded revision. */
export interface Cg4ExceptionSeriesView extends Cg4ExceptionRevisionView {
  workflowState: string;
  effectiveState: string;
  /**
   * CG4.9 (#192): the contact's exception CAS version, echoed back as `expectedVersion` on
   * approve/cancel/revoke. #179 §2 requires queries to return the current version; without
   * it a Console could only guess the number and fail as VERSION_CONFLICT.
   */
  aggregateVersion: number;
  /** Concurrency token the caller echoes back as `expectedRevision`. */
  etag: string;
}

function exceptionEtag(seriesId: string, revision: number, contentDigest: string): string {
  return `"cg4-exception:${seriesId}:${revision}:${contentDigest.slice(0, 16)}"`;
}

function policyEtag(policyId: string, version: number, draftRevision: number): string {
  return `"cg4-policy:${policyId}:${version}:${draftRevision}"`;
}

type ExceptionRow = {
  id: string;
  exceptionId: string;
  revision: number;
  contactId: string;
  identityId: string | null;
  scopeKind: string;
  channel: string;
  purpose: string;
  sourceType: string;
  sourceId: string;
  allowedRuleCodes: string[];
  policyId: string;
  policyVersion: number;
  policyContentDigest: string;
  registryVersion: string;
  startsAt: Date;
  expiresAt: Date;
  tier: Cg4ExceptionRiskTier;
  reasonCode: string;
  ticketRef: string | null;
  evidenceRef: string;
  actorRef: string;
  requestHash: string;
  renewsExceptionId: string | null;
  createdAt: Date;
};

function exceptionRevisionView(
  row: ExceptionRow,
  level: Cg4EvidenceAccessLevel,
): Cg4ExceptionRevisionView {
  return {
    seriesId: row.exceptionId,
    revisionId: row.id,
    revision: row.revision,
    contactId: row.contactId,
    ...(row.identityId ? { identityId: row.identityId } : {}),
    scopeKind: row.scopeKind,
    channel: row.channel,
    purpose: row.purpose,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    allowedRuleCodes: [...row.allowedRuleCodes],
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    policyContentDigest: row.policyContentDigest,
    registryVersion: row.registryVersion,
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    riskTier: row.tier,
    reasonCode: row.reasonCode,
    contentDigest: row.requestHash,
    createdAt: row.createdAt.toISOString(),
    ...(row.ticketRef ? { ticketRef: redactCg4Ref(row.ticketRef, level) } : {}),
    evidenceRef: redactCg4Ref(row.evidenceRef, level),
    actorRef: redactCg4Actor(row.actorRef, level),
    ...(row.renewsExceptionId ? { renewsSeriesId: row.renewsExceptionId } : {}),
  };
}

export async function cg4ExceptionBySeriesId(
  database: PrismaClient,
  context: Cg4QueryContext,
  seriesId: string,
  now = new Date(),
): Promise<Cg4ExceptionSeriesView | undefined> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const head = await transaction.cg4ExceptionHead.findUnique({
      where: { tenantId_exceptionId: { tenantId: context.tenantId, exceptionId: seriesId } },
    });
    if (!head) return undefined;
    const row = await transaction.cg4Exception.findFirst({
      where: { tenantId: context.tenantId, id: head.currentRevisionId },
    });
    if (!row) return undefined;
    const contactHead = await transaction.cg4ContactExceptionHead.findUnique({
      where: { tenantId_contactId: { tenantId: context.tenantId, contactId: row.contactId } },
      select: { aggregateVersion: true },
    });
    return {
      ...exceptionRevisionView(row, context.level),
      workflowState: head.status,
      aggregateVersion: contactHead?.aggregateVersion ?? 0,
      effectiveState: resolveCg4EffectiveState({
        workflowState: head.status as 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REVOKED',
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        now,
      }),
      etag: exceptionEtag(row.exceptionId, row.revision, row.requestHash),
    };
  });
}

export async function cg4ExceptionHistory(
  database: PrismaClient,
  context: Cg4QueryContext,
  seriesId: string,
): Promise<Cg4ExceptionRevisionView[]> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const rows = await transaction.cg4Exception.findMany({
      where: { tenantId: context.tenantId, exceptionId: seriesId },
      orderBy: { revision: 'asc' },
    });
    return rows.map((row) => exceptionRevisionView(row, context.level));
  });
}

export async function cg4ContactExceptions(
  database: PrismaClient,
  context: Cg4QueryContext,
  contactId: string,
  now = new Date(),
): Promise<Cg4ExceptionSeriesView[]> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const revisions = await transaction.cg4Exception.findMany({
      where: { tenantId: context.tenantId, contactId },
      orderBy: [{ exceptionId: 'asc' }, { revision: 'desc' }],
    });
    if (revisions.length === 0) return [];
    const heads = await transaction.cg4ExceptionHead.findMany({
      where: {
        tenantId: context.tenantId,
        exceptionId: { in: [...new Set(revisions.map((row) => row.exceptionId))] },
      },
    });
    const currentRevisionIds = new Map(heads.map((head) => [head.currentRevisionId, head]));
    const contactHead = await transaction.cg4ContactExceptionHead.findUnique({
      where: { tenantId_contactId: { tenantId: context.tenantId, contactId } },
      select: { aggregateVersion: true },
    });
    return revisions
      .filter((row) => currentRevisionIds.has(row.id))
      .map((row) => {
        const head = currentRevisionIds.get(row.id) as (typeof heads)[number];
        return {
          ...exceptionRevisionView(row, context.level),
          workflowState: head.status,
          aggregateVersion: contactHead?.aggregateVersion ?? 0,
          effectiveState: resolveCg4EffectiveState({
            workflowState: head.status as
              'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REVOKED',
            startsAt: row.startsAt,
            expiresAt: row.expiresAt,
            now,
          }),
          etag: exceptionEtag(row.exceptionId, row.revision, row.requestHash),
        };
      });
  });
}

// ── Tenant-wide exception queue (additive, #179 decision gap) ───────────────

/**
 * CG4.9's frozen queries let a checker open one contact at a time, but #180 Variant A
 * starts from a queue ordered by risk/expiry — so this closes that gap without touching
 * any existing route, error vocabulary or event.
 *
 * `Cg4ExceptionTier` is declared `STANDARD < HIGH < EMERGENCY` in the schema, so Postgres's
 * native enum ordering already sorts by urgency descending; the tie-break is `expiresAt`
 * ascending (soonest first) then `exceptionId` for a fully deterministic order.
 *
 * The cursor is an opaque, base64-encoded copy of the last returned row's sort key rather
 * than an offset, so a page boundary survives concurrent inserts/transitions instead of
 * skipping or repeating rows. `MAX_QUEUE_SCAN` bounds one tenant's PENDING backlog to a
 * size this synthetic-scale system is designed for; a tenant beyond that needs its own
 * follow-up, not a deeper scan here.
 */

const MAX_QUEUE_SCAN = 1_000;

export interface Cg4ExceptionQueueFilter {
  workflowState?: Cg4ExceptionWorkflowState;
  riskTier?: Cg4ExceptionRiskTier;
  channel?: ContactChannel;
  purpose?: string;
  limit?: number;
  cursor?: string;
}

export interface Cg4ExceptionQueuePage {
  items: Cg4ExceptionSeriesView[];
  nextCursor?: string;
}

export interface Cg4ExceptionQueueCursorKey {
  tier: Cg4ExceptionRiskTier;
  expiresAt: string;
  seriesId: string;
}

const QUEUE_TIER_RANK: Record<Cg4ExceptionRiskTier, number> = {
  EMERGENCY: 0,
  HIGH: 1,
  STANDARD: 2,
};

export function encodeQueueCursor(key: Cg4ExceptionQueueCursorKey): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** A cursor a caller could not have minted (malformed/tampered) is simply ignored — the
 *  first page is always a safe fallback, never an error that leaks internal shape. */
export function decodeQueueCursor(
  cursor: string | undefined,
): Cg4ExceptionQueueCursorKey | undefined {
  if (!cursor) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as Cg4ExceptionQueueCursorKey).tier === 'string' &&
      typeof (parsed as Cg4ExceptionQueueCursorKey).expiresAt === 'string' &&
      typeof (parsed as Cg4ExceptionQueueCursorKey).seriesId === 'string'
    ) {
      return parsed as Cg4ExceptionQueueCursorKey;
    }
  } catch {
    // fall through to undefined
  }
  return undefined;
}

function queueSortKey(row: Cg4ExceptionSeriesView): Cg4ExceptionQueueCursorKey {
  return { tier: row.riskTier, expiresAt: row.expiresAt, seriesId: row.seriesId };
}

function afterCursor(row: Cg4ExceptionSeriesView, cursor: Cg4ExceptionQueueCursorKey): boolean {
  const rank = QUEUE_TIER_RANK[row.riskTier];
  const cursorRank = QUEUE_TIER_RANK[cursor.tier];
  if (rank !== cursorRank) return rank > cursorRank;
  if (row.expiresAt !== cursor.expiresAt) return row.expiresAt > cursor.expiresAt;
  return row.seriesId > cursor.seriesId;
}

/**
 * Tenant-wide PENDING (or any single `workflowState`) queue, sorted by risk then expiry.
 * `workflowState`/`riskTier`/`channel`/`purpose` are the only filters — never identity or
 * any other PII-shaped field, so this can never become an identity lookup in disguise.
 */
export async function cg4PendingExceptionQueue(
  database: PrismaClient,
  context: Cg4QueryContext,
  filter: Cg4ExceptionQueueFilter = {},
  now = new Date(),
): Promise<Cg4ExceptionQueuePage> {
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const heads = await transaction.cg4ExceptionHead.findMany({
      where: {
        tenantId: context.tenantId,
        ...(filter.workflowState ? { status: filter.workflowState } : {}),
      },
      select: { currentRevisionId: true },
    });
    if (heads.length === 0) return { items: [] };

    // head.status (not the revision row's own status) is canonical — the same rule
    // `cg4ContactExceptions` follows — so filtering narrows to current revisions first and
    // only riskTier/channel/purpose are pushed into this second, DB-sorted query.
    const rows = await transaction.cg4Exception.findMany({
      where: {
        tenantId: context.tenantId,
        id: { in: heads.map((head) => head.currentRevisionId) },
        ...(filter.riskTier ? { tier: filter.riskTier } : {}),
        ...(filter.channel ? { channel: filter.channel } : {}),
        ...(filter.purpose ? { purpose: filter.purpose } : {}),
      },
      // native enum declaration order (STANDARD < HIGH < EMERGENCY) makes `desc` most-urgent-first
      orderBy: [{ tier: 'desc' }, { expiresAt: 'asc' }, { exceptionId: 'asc' }],
      take: MAX_QUEUE_SCAN,
    });
    if (rows.length === 0) return { items: [] };

    const headByRevisionId = new Map(
      (
        await transaction.cg4ExceptionHead.findMany({
          where: { tenantId: context.tenantId, currentRevisionId: { in: rows.map((r) => r.id) } },
        })
      ).map((head) => [head.currentRevisionId, head]),
    );
    const contactHeads = await transaction.cg4ContactExceptionHead.findMany({
      where: {
        tenantId: context.tenantId,
        contactId: { in: [...new Set(rows.map((r) => r.contactId))] },
      },
      select: { contactId: true, aggregateVersion: true },
    });
    const aggregateVersionByContact = new Map(
      contactHeads.map((head) => [head.contactId, head.aggregateVersion]),
    );

    const sorted = rows
      .filter((row) => headByRevisionId.has(row.id))
      .map((row) => {
        const head = headByRevisionId.get(row.id)!;
        return {
          ...exceptionRevisionView(row, context.level),
          workflowState: head.status,
          aggregateVersion: aggregateVersionByContact.get(row.contactId) ?? 0,
          effectiveState: resolveCg4EffectiveState({
            workflowState: head.status as Cg4ExceptionWorkflowState,
            startsAt: row.startsAt,
            expiresAt: row.expiresAt,
            now,
          }),
          etag: exceptionEtag(row.exceptionId, row.revision, row.requestHash),
        } satisfies Cg4ExceptionSeriesView;
      });

    const cursor = decodeQueueCursor(filter.cursor);
    const afterPage = cursor ? sorted.filter((row) => afterCursor(row, cursor)) : sorted;
    const items = afterPage.slice(0, limit);
    const hasMore = afterPage.length > limit;
    return {
      items,
      ...(hasMore ? { nextCursor: encodeQueueCursor(queueSortKey(items.at(-1)!)) } : {}),
    };
  });
}

export interface Cg4ApprovalView {
  approverRef: string | Cg4RedactedRef;
  decision: string;
  capability: string;
  capabilitySource: string;
  directCompliance: boolean;
  emergencyAuthority: boolean;
  authorizationEpoch: number;
  scopeVersion: number;
  decidedAt: string;
  evidenceRef: Ref;
}

export async function cg4ExceptionApprovals(
  database: PrismaClient,
  context: Cg4QueryContext,
  seriesId: string,
  revision: number,
): Promise<Cg4ApprovalView[]> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const rows = await transaction.cg4ExceptionApproval.findMany({
      where: { tenantId: context.tenantId, exceptionId: seriesId, exceptionRevision: revision },
      orderBy: { decidedAt: 'asc' },
    });
    return rows.map((row) => ({
      approverRef: redactCg4Actor(row.approverRef, context.level),
      decision: row.decision,
      capability: row.capability,
      capabilitySource: row.capabilitySource,
      directCompliance: row.directCompliance,
      emergencyAuthority: row.emergencyAuthority,
      authorizationEpoch: row.authorizationEpoch,
      scopeVersion: row.scopeVersion,
      decidedAt: row.decidedAt.toISOString(),
      evidenceRef: redactCg4Ref(row.evidenceRef, context.level),
    }));
  });
}

export interface Cg4PolicyVersionView {
  policyId: string;
  policyVersionId: string;
  version: number;
  draftRevision: number;
  scopeKey: string;
  lifecycleState: Cg4PolicyStatus;
  contentDigest: Cg4Digest;
  schemaVersion: number;
  registryVersion: string;
  evaluatorVersion: string;
  diffClass?: Cg4PolicyDiffClass;
  testArtifactDigest?: Cg4Digest;
  approvalDigest?: Cg4Digest;
  baseHeadVersion?: number;
  baseHeadDigest?: Cg4Digest;
  effectiveFrom: string;
  effectiveTo?: string;
  activateAt?: string;
  publishedAt?: string;
  rollbackOfVersionId?: string;
  supersedesVersionId?: string;
  makerActorRef: string | Cg4RedactedRef;
  createdAt: string;
  etag: string;
}

type PolicyRow = {
  id: string;
  policyId: string;
  version: number;
  draftRevision: number;
  scopeKey: string;
  status: Cg4PolicyStatus;
  contentDigest: string;
  schemaVersion: number;
  registryVersion: string;
  evaluatorVersion: string;
  diffClass: Cg4PolicyDiffClass | null;
  testArtifactDigest: string | null;
  approvalDigest: string | null;
  baseHeadVersion: number | null;
  baseHeadDigest: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  activateAt: Date | null;
  publishedAt: Date | null;
  rollbackOfId: string | null;
  supersedesId: string | null;
  makerActorRef: string;
  createdAt: Date;
};

function policyVersionView(row: PolicyRow, level: Cg4EvidenceAccessLevel): Cg4PolicyVersionView {
  return {
    policyId: row.policyId,
    policyVersionId: row.id,
    version: row.version,
    draftRevision: row.draftRevision,
    scopeKey: row.scopeKey,
    lifecycleState: row.status,
    contentDigest: row.contentDigest,
    schemaVersion: row.schemaVersion,
    registryVersion: row.registryVersion,
    evaluatorVersion: row.evaluatorVersion,
    ...(row.diffClass ? { diffClass: row.diffClass } : {}),
    ...(row.testArtifactDigest ? { testArtifactDigest: row.testArtifactDigest } : {}),
    ...(row.approvalDigest ? { approvalDigest: row.approvalDigest } : {}),
    ...(row.baseHeadVersion !== null ? { baseHeadVersion: row.baseHeadVersion } : {}),
    ...(row.baseHeadDigest ? { baseHeadDigest: row.baseHeadDigest } : {}),
    effectiveFrom: row.effectiveFrom.toISOString(),
    ...(row.effectiveTo ? { effectiveTo: row.effectiveTo.toISOString() } : {}),
    ...(row.activateAt ? { activateAt: row.activateAt.toISOString() } : {}),
    ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
    ...(row.rollbackOfId ? { rollbackOfVersionId: row.rollbackOfId } : {}),
    ...(row.supersedesId ? { supersedesVersionId: row.supersedesId } : {}),
    makerActorRef: redactCg4Actor(row.makerActorRef, level),
    createdAt: row.createdAt.toISOString(),
    etag: policyEtag(row.policyId, row.version, row.draftRevision),
  };
}

export async function cg4PolicyVersionById(
  database: PrismaClient,
  context: Cg4QueryContext,
  policyVersionId: string,
): Promise<Cg4PolicyVersionView | undefined> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const row = await transaction.cg4Policy.findFirst({
      where: { tenantId: context.tenantId, id: policyVersionId },
    });
    return row ? policyVersionView(row, context.level) : undefined;
  });
}

export async function cg4PolicyVersions(
  database: PrismaClient,
  context: Cg4QueryContext,
  policyId: string,
): Promise<Cg4PolicyVersionView[]> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const rows = await transaction.cg4Policy.findMany({
      where: { tenantId: context.tenantId, policyId },
      orderBy: { version: 'asc' },
    });
    return rows.map((row) => policyVersionView(row, context.level));
  });
}

export async function cg4PolicyApprovals(
  database: PrismaClient,
  context: Cg4QueryContext,
  policyId: string,
  version: number,
): Promise<Cg4ApprovalView[]> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const rows = await transaction.cg4PolicyApproval.findMany({
      where: { tenantId: context.tenantId, policyId, policyVersion: version },
      orderBy: { decidedAt: 'asc' },
    });
    return rows.map((row) => ({
      approverRef: redactCg4Actor(row.approverRef, context.level),
      decision: row.decision,
      capability: row.capability,
      capabilitySource: row.capabilitySource,
      directCompliance: row.directCompliance,
      emergencyAuthority: row.emergencyAuthority,
      authorizationEpoch: row.authorizationEpoch,
      scopeVersion: row.scopeVersion,
      decidedAt: row.decidedAt.toISOString(),
      evidenceRef: redactCg4Ref(row.evidenceRef, context.level),
    }));
  });
}

export interface Cg4PolicyTestArtifactView {
  artifactId: string;
  policyId: string;
  policyVersion: number;
  suiteVersion: string;
  artifactDigest: Cg4Digest;
  contentDigest: Cg4Digest;
  platformFixtureDigest: Cg4Digest;
  tenantFixtureDigest: Cg4Digest;
  baseHeadVersion: number;
  baseHeadDigest: Cg4Digest;
  diffClass: Cg4PolicyDiffClass;
  outcome: string;
  passed: number;
  failed: number;
  createdAt: string;
}

export async function cg4PolicyTestArtifacts(
  database: PrismaClient,
  context: Cg4QueryContext,
  policyId: string,
  version: number,
): Promise<Cg4PolicyTestArtifactView[]> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const rows = await transaction.cg4PolicyTestArtifact.findMany({
      where: { tenantId: context.tenantId, policyId, policyVersion: version },
      orderBy: { createdAt: 'asc' },
    });
    // The full check list stays out of the response: it is large, and `result` may carry
    // failure text. The digests are what an approval binds to anyway.
    return rows.map((row) => ({
      artifactId: row.id,
      policyId: row.policyId,
      policyVersion: row.policyVersion,
      suiteVersion: row.suiteVersion,
      artifactDigest: row.artifactDigest,
      contentDigest: row.contentDigest,
      platformFixtureDigest: row.platformFixtureDigest,
      tenantFixtureDigest: row.tenantFixtureDigest,
      baseHeadVersion: row.baseHeadVersion,
      baseHeadDigest: row.baseHeadDigest,
      diffClass: row.diffClass,
      outcome: row.outcome,
      passed: row.passed,
      failed: row.failed,
      createdAt: row.createdAt.toISOString(),
    }));
  });
}

export interface Cg4EffectiveScopeView {
  scopeKey: string;
  headVersion: number;
  headDigest: Cg4Digest;
  activePolicyId: string;
  activePolicyVersionId: string;
  activePolicyVersion: number;
  nextActivationAt?: string;
  killSwitchActive: boolean;
  updatedAt: string;
  etag: string;
}

export async function cg4EffectiveScope(
  database: PrismaClient,
  context: Cg4QueryContext,
  scopeKey: string,
): Promise<Cg4EffectiveScopeView | undefined> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const head = await transaction.cg4PolicyScopeHead.findUnique({
      where: { tenantId_scopeKey: { tenantId: context.tenantId, scopeKey } },
    });
    if (!head) return undefined;
    const kill = await transaction.cg4ScopeKillSwitch.findFirst({
      where: { tenantId: context.tenantId, scopeKey, state: 'ACTIVE' },
      select: { id: true },
    });
    return {
      scopeKey: head.scopeKey,
      headVersion: head.headVersion,
      headDigest: head.headDigest,
      activePolicyId: head.headPolicyId,
      activePolicyVersionId: head.headPolicyRevisionId,
      activePolicyVersion: head.headPolicyVersion,
      ...(head.nextActivationAt ? { nextActivationAt: head.nextActivationAt.toISOString() } : {}),
      killSwitchActive: kill !== null,
      updatedAt: head.updatedAt.toISOString(),
      etag: `"cg4-scope:${head.scopeKey}:${head.headVersion}"`,
    };
  });
}

export interface Cg4KillSwitchView {
  killSwitchId: string;
  scopeKey: string;
  state: string;
  reasonCode: string;
  activatedAt: string;
  clearedAt?: string;
  activatedByRef: string | Cg4RedactedRef;
  evidenceRef: Ref;
  clearApprovalRef?: Ref;
}

export async function cg4KillSwitches(
  database: PrismaClient,
  context: Cg4QueryContext,
  filter: { scopeKey?: string; state?: 'ACTIVE' | 'CLEARED' } = {},
): Promise<Cg4KillSwitchView[]> {
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const rows = await transaction.cg4ScopeKillSwitch.findMany({
      where: {
        tenantId: context.tenantId,
        ...(filter.scopeKey ? { scopeKey: filter.scopeKey } : {}),
        ...(filter.state ? { state: filter.state } : {}),
      },
      orderBy: { activatedAt: 'desc' },
    });
    return rows.map((row) => ({
      killSwitchId: row.id,
      scopeKey: row.scopeKey,
      state: row.state,
      reasonCode: row.reasonCode,
      activatedAt: row.activatedAt.toISOString(),
      ...(row.clearedAt ? { clearedAt: row.clearedAt.toISOString() } : {}),
      activatedByRef: redactCg4Actor(row.activatedByRef, context.level),
      evidenceRef: redactCg4Ref(row.evidenceRef, context.level),
      ...(row.clearApprovalRef
        ? { clearApprovalRef: redactCg4Ref(row.clearApprovalRef, context.level) }
        : {}),
    }));
  });
}

/**
 * The maker's subject id for a separation-of-duties check, deliberately outside the
 * redaction path: it is compared, never displayed, and the viewer requesting the check is
 * usually the very person who must not match it. Returning a redacted value here would
 * silently defeat the check.
 */
export async function cg4ExceptionMakerSubjectId(
  database: PrismaClient,
  tenantId: string,
  seriesId: string,
  revision: number,
): Promise<string | undefined> {
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const row = await transaction.cg4Exception.findFirst({
      where: { tenantId, exceptionId: seriesId, revision },
      select: { actorRef: true },
    });
    return row?.actorRef;
  });
}

export async function cg4PolicyMakerSubjectId(
  database: PrismaClient,
  tenantId: string,
  policyId: string,
  version: number,
): Promise<string | undefined> {
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const row = await transaction.cg4Policy.findFirst({
      where: { tenantId, policyId, version },
      select: { makerActorRef: true },
    });
    return row?.makerActorRef;
  });
}
