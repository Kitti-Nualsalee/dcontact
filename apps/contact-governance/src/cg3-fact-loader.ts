import type { Prisma, PrismaClient } from '@d-contact/db';
import type { ContactChannel } from '@d-contact/cxa-contracts';
import type { LocalTimeWindow } from './cg3-persistence.js';
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
  };
}
