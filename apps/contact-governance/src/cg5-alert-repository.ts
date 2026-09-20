import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  CG5_CONTRACT_VERSION,
  CG5_EVENT_AGGREGATE_TYPES,
  CG5_EVENT_TYPES,
  CG5_RULE_REGISTRY_VERSION,
  assertCg5PiiFreePayload,
  canCg5AlertTransition,
  cg5AlertScopeKey,
  type Cg5AlertScope,
  type Cg5AlertState,
  type Cg5RuleCode,
} from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';

const json = (value: unknown) => value as Prisma.InputJsonValue;

export class Cg5AlertRepository {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(input: {
    tenantId: string;
    ruleCode: Cg5RuleCode;
    scope: Cg5AlertScope;
    state: Cg5AlertState;
    severity: 'WARNING' | 'CRITICAL';
    value: number;
    threshold: number;
    actorRef?: string;
  }) {
    const scopeKey = cg5AlertScopeKey(input.scope);
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (tx) => {
      const current = await tx.cg5AlertState.findUnique({
        where: {
          tenantId_ruleCode_scopeKey: {
            tenantId: input.tenantId,
            ruleCode: input.ruleCode,
            scopeKey,
          },
        },
      });
      if (current && current.state === input.state) return current;
      if (current && !canCg5AlertTransition(current.state, input.state))
        throw new TypeError('alert transition ไม่ถูกต้อง');
      const now = this.now();
      const version = (current?.version ?? 0) + 1;
      const stateDigest = stableDigest({
        ruleCode: input.ruleCode,
        scopeKey,
        state: input.state,
        severity: input.severity,
        value: input.value,
        threshold: input.threshold,
        version,
      });
      const data = {
        state: input.state,
        severity: input.severity,
        value: new Prisma.Decimal(input.value),
        threshold: new Prisma.Decimal(input.threshold),
        consecutiveHits: input.state === 'OPEN' ? (current?.consecutiveHits ?? 0) + 1 : 0,
        version,
        updatedAt: now,
        ...(input.state === 'OPEN'
          ? { openedAt: current?.openedAt ?? now, resolvedAt: null }
          : input.state === 'RESOLVED'
            ? { resolvedAt: now }
            : {}),
      };
      const alert = await tx.cg5AlertState.upsert({
        where: {
          tenantId_ruleCode_scopeKey: {
            tenantId: input.tenantId,
            ruleCode: input.ruleCode,
            scopeKey,
          },
        },
        create: {
          tenantId: input.tenantId,
          ruleCode: input.ruleCode,
          scopeKey,
          channel: input.scope.channel,
          purpose: input.scope.purpose,
          teamId: input.scope.teamId,
          ...data,
        },
        update: data,
      });
      const payload = {
        contractVersion: CG5_CONTRACT_VERSION,
        mutationId: randomUUID(),
        subjectId: alert.id,
        subjectVersion: version,
        effectiveAt: now.toISOString(),
        stateDigest,
        ruleCode: input.ruleCode,
        severity: input.severity,
        state: input.state,
        scopeKey,
        registryVersion: CG5_RULE_REGISTRY_VERSION,
      };
      assertCg5PiiFreePayload(payload);
      await tx.cg5AlertTransition.create({
        data: {
          tenantId: input.tenantId,
          alertId: alert.id,
          fromState: current?.state,
          toState: input.state,
          fromVersion: current?.version ?? 0,
          toVersion: version,
          actorRef: input.actorRef ?? 'cg5-anomaly-engine',
          evidenceRef: `cg5-alert:${input.ruleCode}:${scopeKey}`,
          stateDigest,
          occurredAt: now,
        },
      });
      await tx.cgEventOutbox.create({
        data: {
          mutationId: payload.mutationId,
          tenantId: input.tenantId,
          aggregateType: 'ALERT',
          aggregateId: alert.id,
          aggregateVersion: version,
          eventType: CG5_EVENT_TYPES.ALERT_CHANGED,
          orderingKey: `${input.tenantId}:${alert.id}`,
          payload: json(payload),
          payloadHash: stableDigest(payload),
        },
      });
      return alert;
    });
  }
}
