import type { PrismaClient } from '@d-contact/db';
import type { ContactChannel, ContactDecision } from '@d-contact/cxa-contracts';
import type { LocalTimeWindow } from './cg3-persistence.js';
import type { PolicyView } from './cg3-policy-persistence.js';

/** Read-side queries สำหรับ CG3 command/query API (#107) — ไม่มี mutation ใดๆ ในไฟล์นี้ */

export interface EffectivePolicyQuery {
  tenantId: string;
  contactId: string;
  channel: ContactChannel;
  purpose: string;
  contactKind?: string;
  now?: Date;
}

export interface EffectivePolicyResult {
  policy?: PolicyView;
  holidays: Array<{ localDate: string; effect: 'CLOSED' | 'WINDOWS'; windows: LocalTimeWindow[] }>;
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
  query: EffectivePolicyQuery,
): boolean {
  if (scope.channel !== null && scope.channel !== query.channel) return false;
  if (scope.purpose !== null && scope.purpose !== query.purpose) return false;
  if (scope.contactKind !== null && scope.contactKind !== (query.contactKind ?? null)) {
    return false;
  }
  return true;
}

/** resolve policy ที่ specificity สูงสุดในกลุ่ม PUBLISHED ที่ effective ณ now — ตรรกะเดียวกับ cg3-fact-loader.ts */
export async function effectivePolicy(
  database: PrismaClient,
  query: EffectivePolicyQuery,
): Promise<EffectivePolicyResult> {
  const now = query.now ?? new Date();
  const policyRows = await database.cgPolicy.findMany({
    where: {
      tenantId: query.tenantId,
      status: 'PUBLISHED',
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: [{ version: 'desc' }],
  });
  const compatible = policyRows.filter((row) => scopeCompatible(row, query));
  if (compatible.length === 0) return { holidays: [] };

  const bestSpecificity = Math.max(...compatible.map((row) => specificity(row)));
  const resolved = compatible
    .filter((row) => specificity(row) === bestSpecificity)
    .sort(
      (left, right) => (right.publishedAt?.getTime() ?? 0) - (left.publishedAt?.getTime() ?? 0),
    )[0]!;

  const holidayRows = await database.cgHolidayCalendarEntry.findMany({
    where: {
      tenantId: query.tenantId,
      policyId: resolved.policyId,
      policyVersion: resolved.version,
    },
  });

  return {
    policy: {
      id: resolved.id,
      tenantId: resolved.tenantId,
      policyId: resolved.policyId,
      version: resolved.version,
      ...(resolved.purpose ? { purpose: resolved.purpose } : {}),
      ...(resolved.contactKind ? { contactKind: resolved.contactKind } : {}),
      ...(resolved.channel ? { channel: resolved.channel } : {}),
      status: resolved.status,
      makerActorRef: resolved.makerActorRef,
      ...(resolved.checkerActorRef ? { checkerActorRef: resolved.checkerActorRef } : {}),
      ...(resolved.approvalRef ? { approvalRef: resolved.approvalRef } : {}),
      effectiveFrom: resolved.effectiveFrom.toISOString(),
      ...(resolved.effectiveTo ? { effectiveTo: resolved.effectiveTo.toISOString() } : {}),
      ...(resolved.publishedAt ? { publishedAt: resolved.publishedAt.toISOString() } : {}),
      createdAt: resolved.createdAt.toISOString(),
    },
    holidays: holidayRows.map((row) => ({
      localDate: row.localDate.toISOString().slice(0, 10),
      effect: row.effect,
      windows: row.windows as unknown as LocalTimeWindow[],
    })),
  };
}

export interface DecisionQuery {
  tenantId: string;
  decisionId: string;
}

export interface DecisionView {
  decisionId: string;
  decision: ContactDecision;
  reasonCode: string;
  policyVersion: number;
  gate: string;
  trace: unknown;
  aggregateVersion?: number;
  preferenceVersion?: number;
  nextEligibleAt?: string;
  timezoneSource?: string;
  matchedScope?: unknown;
  matchedWindowRef?: string;
  exceptionMode?: string;
  exceptionRef?: string;
  reservationId?: string;
  decidedAt: string;
}

/** PII-safe: ไม่ select contactId/identityId/segmentSnapshot ดิบ ๆ ออกไป */
export async function decisionById(
  database: PrismaClient,
  query: DecisionQuery,
): Promise<DecisionView | undefined> {
  const row = await database.cgDecisionLog.findFirst({
    where: { id: query.decisionId, tenantId: query.tenantId },
    select: {
      id: true,
      decision: true,
      reasonCode: true,
      policyVersion: true,
      gate: true,
      trace: true,
      aggregateVersion: true,
      preferenceVersion: true,
      nextEligibleAt: true,
      timezoneSource: true,
      matchedScope: true,
      matchedWindowRef: true,
      exceptionMode: true,
      exceptionRef: true,
      reservationId: true,
      decidedAt: true,
    },
  });
  if (!row) return undefined;
  return {
    decisionId: row.id,
    decision: row.decision,
    reasonCode: row.reasonCode,
    policyVersion: row.policyVersion,
    gate: row.gate,
    trace: row.trace,
    ...(row.aggregateVersion !== null ? { aggregateVersion: row.aggregateVersion } : {}),
    ...(row.preferenceVersion !== null ? { preferenceVersion: row.preferenceVersion } : {}),
    ...(row.nextEligibleAt ? { nextEligibleAt: row.nextEligibleAt.toISOString() } : {}),
    ...(row.timezoneSource ? { timezoneSource: row.timezoneSource } : {}),
    ...(row.matchedScope ? { matchedScope: row.matchedScope } : {}),
    ...(row.matchedWindowRef ? { matchedWindowRef: row.matchedWindowRef } : {}),
    ...(row.exceptionMode ? { exceptionMode: row.exceptionMode } : {}),
    ...(row.exceptionRef ? { exceptionRef: row.exceptionRef } : {}),
    ...(row.reservationId ? { reservationId: row.reservationId } : {}),
    decidedAt: row.decidedAt.toISOString(),
  };
}
