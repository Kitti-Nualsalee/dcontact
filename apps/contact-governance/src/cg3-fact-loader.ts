import type { Prisma, PrismaClient } from '@d-contact/db';
import type { ContactChannel } from '@d-contact/cxa-contracts';
import { stableDigest, type LocalTimeWindow } from './cg3-persistence.js';
import type { Cg4ExceptionFacts } from './cg4-exception-evaluation.js';
import type {
  Cg3CallbackFacts,
  Cg3HolidayEntry,
  Cg3PolicyFacts,
  Cg3PreferenceCandidate,
} from './cg3-policy-evaluator.js';

export interface Cg3FactQuery {
  tenantId: string;
  contactId: string;
  identityId?: string;
  channel: ContactChannel;
  purpose: string;
  contactKind?: string;
  now: Date;
}

export interface Cg3Facts {
  aggregateVersion: number;
  preferences: Cg3PreferenceCandidate[];
  policy?: Cg3PolicyFacts;
  activeCallback?: Cg3CallbackFacts;
  /**
   * CG4.4 (#187): APPROVED exception series whose window covers `now`. Scope matching is
   * left to the pure evaluator so the decision stays replayable from these facts alone.
   */
  activeExceptions: Cg4ExceptionFacts[];
}

function policyAllowedRuleCodes(content: unknown): string[] {
  if (!content || typeof content !== 'object' || Array.isArray(content)) return [];
  const value = (content as Record<string, unknown>).allowedOperationalRuleCodes;
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/**
 * CG4 exception facts for one contact, resolved to each series' current revision. Only
 * series whose head is APPROVED and whose current revision is the time-active one are
 * returned; everything else is left out so a stale revision can never be matched.
 */
export async function loadCg4ExceptionFacts(
  transaction: Prisma.TransactionClient,
  query: Cg3FactQuery,
): Promise<Cg4ExceptionFacts[]> {
  const revisions = await transaction.cg4Exception.findMany({
    where: {
      tenantId: query.tenantId,
      contactId: query.contactId,
      startsAt: { lte: query.now },
      expiresAt: { gt: query.now },
    },
    orderBy: [{ startsAt: 'asc' }, { revision: 'asc' }],
  });
  if (revisions.length === 0) return [];

  const [heads, policies, approvals] = await Promise.all([
    transaction.cg4ExceptionHead.findMany({
      where: {
        tenantId: query.tenantId,
        exceptionId: { in: [...new Set(revisions.map((row) => row.exceptionId))] },
        status: 'APPROVED',
      },
    }),
    transaction.cg4Policy.findMany({
      where: {
        tenantId: query.tenantId,
        OR: revisions.map((row) => ({ policyId: row.policyId, version: row.policyVersion })),
      },
    }),
    transaction.cg4ExceptionApproval.findMany({
      where: {
        tenantId: query.tenantId,
        exceptionId: { in: [...new Set(revisions.map((row) => row.exceptionId))] },
      },
      orderBy: [{ approverRef: 'asc' }],
    }),
  ]);

  const approvedRevisionIds = new Set(heads.map((head) => head.currentRevisionId));
  const policyByKey = new Map(
    policies.map((policy) => [`${policy.policyId}:${policy.version}`, policy]),
  );

  return revisions
    .filter((revision) => approvedRevisionIds.has(revision.id))
    .map((revision) => {
      const policy = policyByKey.get(`${revision.policyId}:${revision.policyVersion}`);
      const revisionApprovals = approvals.filter(
        (approval) =>
          approval.exceptionId === revision.exceptionId &&
          approval.exceptionRevision === revision.revision,
      );
      return {
        seriesId: revision.exceptionId,
        revisionId: revision.id,
        revision: revision.revision,
        workflowState: 'APPROVED' as const,
        identityId: revision.identityId,
        scopeKind:
          revision.scopeKind === 'IDENTITY'
            ? ('EXACT_IDENTITY' as const)
            : ('CONTACT_WIDE' as const),
        channel: revision.channel,
        purpose: revision.purpose,
        sourceType: revision.sourceType,
        sourceId: revision.sourceId,
        allowedRuleCodes: revision.allowedRuleCodes,
        policyId: revision.policyId,
        policyVersionId: policy?.id ?? revision.policyId,
        policyVersion: revision.policyVersion,
        policyContentDigest: revision.policyContentDigest,
        currentPolicyContentDigest: policy?.contentDigest ?? null,
        policyAllowedRuleCodes: policyAllowedRuleCodes(policy?.content),
        registryVersion: revision.registryVersion,
        startsAt: revision.startsAt,
        expiresAt: revision.expiresAt,
        tier: revision.tier,
        contentDigest: revision.requestHash,
        approvalDigest: stableDigest(
          revisionApprovals.map((approval) => ({
            approverRef: approval.approverRef,
            decision: approval.decision,
            capability: approval.capability,
            capabilitySource: approval.capabilitySource,
            authorizationEpoch: approval.authorizationEpoch,
            scopeVersion: approval.scopeVersion,
            decidedAt: approval.decidedAt.toISOString(),
          })),
        ),
      };
    });
}

function specificity(scope: {
  channel: string | null;
  purpose: string | null;
  contactKind: string | null;
}): number {
  return (
    (scope.channel !== null ? 1 : 0) +
    (scope.purpose !== null ? 1 : 0) +
    (scope.contactKind !== null ? 1 : 0)
  );
}

function scopeCompatible(
  scope: { channel: string | null; purpose: string | null; contactKind: string | null },
  query: Cg3FactQuery,
): boolean {
  if (scope.channel !== null && scope.channel !== query.channel) return false;
  if (scope.purpose !== null && scope.purpose !== query.purpose) return false;
  if (scope.contactKind !== null && scope.contactKind !== (query.contactKind ?? null)) {
    return false;
  }
  return true;
}

/** โหลด CG3 facts ทั้งหมดที่ evaluator ต้องใช้ ภายใน transaction เดียวกับ authorizeAndReserve */
export async function loadCg3Facts(
  transaction: Prisma.TransactionClient,
  query: Cg3FactQuery,
): Promise<Cg3Facts> {
  const [head, preferenceRows, policyRows, callback] = await Promise.all([
    transaction.cgContactStateHead.findUnique({
      where: { tenantId_contactId: { tenantId: query.tenantId, contactId: query.contactId } },
      select: { aggregateVersion: true },
    }),
    transaction.cgPreference.findMany({
      where: {
        tenantId: query.tenantId,
        contactId: query.contactId,
        effectiveFrom: { lte: query.now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: query.now } }],
      },
      orderBy: { version: 'desc' },
    }),
    transaction.cgPolicy.findMany({
      where: {
        tenantId: query.tenantId,
        status: 'PUBLISHED',
        effectiveFrom: { lte: query.now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: query.now } }],
      },
      orderBy: [{ version: 'desc' }],
    }),
    transaction.cgCallbackRequest.findFirst({
      where: {
        tenantId: query.tenantId,
        contactId: query.contactId,
        identityId: query.identityId ?? null,
        channel: query.channel,
        purpose: query.purpose,
      },
      orderBy: { version: 'desc' },
    }),
  ]);

  const latestByScope = new Map<string, (typeof preferenceRows)[number]>();
  for (const row of preferenceRows) {
    if (!latestByScope.has(row.scopeHash)) latestByScope.set(row.scopeHash, row);
  }
  const preferences: Cg3PreferenceCandidate[] = [...latestByScope.values()]
    .filter((row) => row.mutationKind === 'SET')
    .map((row) => ({
      version: row.version,
      identityId: row.identityId,
      channel: row.channel,
      purpose: row.purpose,
      contactKind: row.contactKind,
      decision: row.decision,
      timezone: row.timezone,
      preferredWindows: row.preferredWindows as unknown as LocalTimeWindow[],
    }));

  const compatiblePolicies = policyRows.filter((row) => scopeCompatible(row, query));
  const bestSpecificity =
    compatiblePolicies.length > 0
      ? Math.max(...compatiblePolicies.map((row) => specificity(row)))
      : undefined;
  const resolvedPolicyRow =
    bestSpecificity === undefined
      ? undefined
      : compatiblePolicies
          .filter((row) => specificity(row) === bestSpecificity)
          .sort(
            (left, right) =>
              (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0),
          )[0];

  let policy: Cg3PolicyFacts | undefined;
  if (resolvedPolicyRow) {
    const holidayRows = await transaction.cgHolidayCalendarEntry.findMany({
      where: {
        tenantId: query.tenantId,
        policyId: resolvedPolicyRow.policyId,
        policyVersion: resolvedPolicyRow.version,
      },
    });
    const holidays: Cg3HolidayEntry[] = holidayRows.map((row) => ({
      localDate: row.localDate.toISOString().slice(0, 10),
      effect: row.effect,
      windows: row.windows as unknown as LocalTimeWindow[],
    }));
    policy = {
      version: resolvedPolicyRow.version,
      timezoneFallback: resolvedPolicyRow.timezoneFallback,
      quietHours: resolvedPolicyRow.quietHours as unknown as LocalTimeWindow[],
      callbackMode: resolvedPolicyRow.callbackMode,
      overridableRules: (resolvedPolicyRow.overridableRules as unknown as string[]) ?? [],
      holidays,
    };
  }

  const activeCallback: Cg3CallbackFacts | undefined =
    callback && callback.mutationKind === 'REQUEST'
      ? {
          requestId: callback.id,
          identityId: callback.identityId,
          channel: callback.channel,
          purpose: callback.purpose,
          expiresAt: callback.expiresAt.toISOString(),
          approvedExceptionId: callback.approvedExceptionId,
        }
      : undefined;

  return {
    aggregateVersion: head?.aggregateVersion ?? 0,
    preferences,
    ...(policy ? { policy } : {}),
    ...(activeCallback ? { activeCallback } : {}),
    activeExceptions: await loadCg4ExceptionFacts(transaction, query),
  };
}
