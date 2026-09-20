import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { type Cg5ExportDataset } from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';
import { redactCg4Ref } from './cg4-redaction.js';
import type { Cg5CanonicalExportReader } from './cg5-export-worker.js';

type Input = Parameters<Cg5CanonicalExportReader['read']>[0];

function reference(value: string | null | undefined, level: string) {
  return redactCg4Ref(value, level === 'EVIDENCE' ? 'EVIDENCE' : 'SUMMARY') ?? null;
}

function filter(input: Input) {
  const raw = input.filters;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  return {
    ...(typeof value.channel === 'string' ? { channel: value.channel as never } : {}),
    ...(typeof value.purpose === 'string' ? { purpose: value.purpose } : {}),
  };
}

function body(rows: unknown[]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(rows));
}

/** Canonical-only CG5.8 reader: data rows carry approved fields; trace/evidence bodies stay as digests. */
export class PrismaCg5CanonicalExportReader implements Cg5CanonicalExportReader {
  constructor(private readonly database: PrismaClient) {}

  async read(input: Input) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (tx) => {
      const result: Array<{ dataset: Cg5ExportDataset; body: Uint8Array; rowCount: number }> = [];
      for (const dataset of input.datasets) {
        const rows = await this.rows(tx, dataset, input);
        result.push({ dataset, body: body(rows), rowCount: rows.length });
      }
      return result;
    });
  }

  private async rows(
    tx: Parameters<Parameters<typeof withTenantDatabaseTransaction>[2]>[0],
    dataset: Cg5ExportDataset,
    input: Input,
  ): Promise<unknown[]> {
    const range = { gte: input.rangeFrom, lt: input.rangeTo };
    const dimensions = filter(input);
    if (dataset === 'DECISION_TRACE') {
      const rows = await tx.cgDecisionLog.findMany({
        where: { tenantId: input.tenantId, decidedAt: range, ...dimensions },
        select: {
          id: true,
          channel: true,
          purpose: true,
          source: true,
          sourceId: true,
          actionKey: true,
          decision: true,
          reasonCode: true,
          policyVersion: true,
          gate: true,
          trace: true,
          reservationId: true,
          exceptionRef: true,
          decidedAt: true,
        },
      });
      return rows.map((row) => ({
        decisionId: row.id,
        channel: row.channel,
        purpose: row.purpose,
        source: row.source,
        sourceRef: reference(row.sourceId, input.evidenceLevel),
        actionRef: reference(row.actionKey, input.evidenceLevel),
        decision: row.decision,
        reasonCode: row.reasonCode,
        policyVersion: row.policyVersion,
        gate: row.gate,
        traceDigest: stableDigest(row.trace),
        reservationRef: reference(row.reservationId, input.evidenceLevel),
        exceptionRef: reference(row.exceptionRef, input.evidenceLevel),
        decidedAt: row.decidedAt,
      }));
    }
    if (dataset === 'AUDIT_LOG') {
      const rows = await tx.cgAuditLog.findMany({
        where: { tenantId: input.tenantId, occurredAt: range },
        select: {
          aggregateType: true,
          aggregateId: true,
          aggregateVersion: true,
          action: true,
          actorClass: true,
          actorRef: true,
          sourceKind: true,
          evidenceRef: true,
          beforeDigest: true,
          afterDigest: true,
          occurredAt: true,
        },
      });
      return rows.map((row) => ({
        aggregateType: row.aggregateType,
        aggregateRef: reference(row.aggregateId, input.evidenceLevel),
        aggregateVersion: row.aggregateVersion,
        action: row.action,
        actorClass: row.actorClass,
        actorRef: reference(row.actorRef, input.evidenceLevel),
        sourceKind: row.sourceKind,
        evidenceRef: reference(row.evidenceRef, input.evidenceLevel),
        beforeDigest: row.beforeDigest,
        afterDigest: row.afterDigest,
        occurredAt: row.occurredAt,
      }));
    }
    if (dataset === 'RESTRICTION_CONSENT') {
      const [restrictions, consents, preferences] = await Promise.all([
        tx.cgRestriction.findMany({
          where: { tenantId: input.tenantId, createdAt: range, ...dimensions },
          select: {
            type: true,
            channel: true,
            purpose: true,
            scope: true,
            reasonCode: true,
            source: true,
            startsAt: true,
            expiresAt: true,
            createdBy: true,
            createdAt: true,
            evidence: true,
          },
        }),
        tx.cgConsent.findMany({
          where: { tenantId: input.tenantId, createdAt: range, ...dimensions },
          select: {
            purpose: true,
            channel: true,
            status: true,
            lawfulBasis: true,
            noticeVersion: true,
            grantedAt: true,
            revokedAt: true,
            expiresAt: true,
            createdAt: true,
            evidence: true,
          },
        }),
        tx.cgPreference.findMany({
          where: { tenantId: input.tenantId, occurredAt: range, ...dimensions },
          select: {
            version: true,
            channel: true,
            purpose: true,
            decision: true,
            sourceKind: true,
            sourceVersion: true,
            occurredAt: true,
            effectiveFrom: true,
            effectiveTo: true,
            mutationKind: true,
            evidenceRef: true,
          },
        }),
      ]);
      return [
        ...restrictions.map((row) => ({
          kind: 'RESTRICTION',
          type: row.type,
          channel: row.channel,
          purpose: row.purpose,
          scope: row.scope,
          reasonCode: row.reasonCode,
          source: row.source,
          startsAt: row.startsAt,
          expiresAt: row.expiresAt,
          createdByRef: reference(row.createdBy, input.evidenceLevel),
          evidenceDigest: row.evidence ? stableDigest(row.evidence) : null,
          occurredAt: row.createdAt,
        })),
        ...consents.map((row) => ({
          kind: 'CONSENT',
          purpose: row.purpose,
          channel: row.channel,
          status: row.status,
          lawfulBasis: row.lawfulBasis,
          noticeVersion: row.noticeVersion,
          grantedAt: row.grantedAt,
          revokedAt: row.revokedAt,
          expiresAt: row.expiresAt,
          evidenceDigest: stableDigest(row.evidence),
          occurredAt: row.createdAt,
        })),
        ...preferences.map((row) => ({
          kind: 'PREFERENCE',
          version: row.version,
          channel: row.channel,
          purpose: row.purpose,
          decision: row.decision,
          sourceKind: row.sourceKind,
          sourceVersion: row.sourceVersion,
          occurredAt: row.occurredAt,
          effectiveFrom: row.effectiveFrom,
          effectiveTo: row.effectiveTo,
          mutationKind: row.mutationKind,
          evidenceRef: reference(row.evidenceRef, input.evidenceLevel),
        })),
      ];
    }
    const [exceptions, approvals] = await Promise.all([
      tx.cg4Exception.findMany({
        where: { tenantId: input.tenantId, createdAt: range, ...dimensions },
        select: {
          exceptionId: true,
          revision: true,
          channel: true,
          purpose: true,
          sourceType: true,
          sourceId: true,
          allowedRuleCodes: true,
          policyId: true,
          policyVersion: true,
          policyContentDigest: true,
          startsAt: true,
          expiresAt: true,
          tier: true,
          status: true,
          reasonCode: true,
          ticketRef: true,
          evidenceRef: true,
          actorRef: true,
          createdAt: true,
        },
      }),
      tx.cg4ExceptionApproval.findMany({
        where: { tenantId: input.tenantId, decidedAt: range },
        select: {
          exceptionId: true,
          exceptionRevision: true,
          decision: true,
          approverRef: true,
          evidenceRef: true,
          decidedAt: true,
          capability: true,
          capabilitySource: true,
        },
      }),
    ]);
    return [
      ...exceptions.map((row) => ({
        kind: 'EXCEPTION',
        exceptionRef: reference(row.exceptionId, input.evidenceLevel),
        revision: row.revision,
        channel: row.channel,
        purpose: row.purpose,
        sourceType: row.sourceType,
        sourceRef: reference(row.sourceId, input.evidenceLevel),
        allowedRuleCodes: row.allowedRuleCodes,
        policyRef: reference(row.policyId, input.evidenceLevel),
        policyVersion: row.policyVersion,
        policyContentDigest: row.policyContentDigest,
        startsAt: row.startsAt,
        expiresAt: row.expiresAt,
        tier: row.tier,
        status: row.status,
        reasonCode: row.reasonCode,
        ticketRef: reference(row.ticketRef, input.evidenceLevel),
        evidenceRef: reference(row.evidenceRef, input.evidenceLevel),
        actorRef: reference(row.actorRef, input.evidenceLevel),
        occurredAt: row.createdAt,
      })),
      ...approvals.map((row) => ({
        kind: 'APPROVAL',
        exceptionRef: reference(row.exceptionId, input.evidenceLevel),
        revision: row.exceptionRevision,
        decision: row.decision,
        approverRef: reference(row.approverRef, input.evidenceLevel),
        evidenceRef: reference(row.evidenceRef, input.evidenceLevel),
        capability: row.capability,
        capabilitySource: row.capabilitySource,
        occurredAt: row.decidedAt,
      })),
    ];
  }
}
