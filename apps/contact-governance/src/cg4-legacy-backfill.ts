import { randomUUID } from 'node:crypto';
import {
  Prisma,
  withTenantDatabaseTransaction,
  type CgHolidayCalendarEntry,
  type CgPolicy,
  type PrismaClient,
} from '@d-contact/db';
import { stableDigest } from './cg3-persistence.js';
import { cg4KillSwitchEvent } from './cg4-kill-switch-event.js';
import {
  buildCg4PolicyScopeKey,
  cg4PolicyScopesAmbiguous,
  compileCg4Policy,
  type Cg4CompiledPolicy,
} from './cg4-policy-compiler.js';

/**
 * CG4.10 (#193) PR-A: backfill CG3 policy -> CG4 (#179 §6 backfill step + reconcile ambiguity +
 * seed compatibility)
 *
 * A re-runnable operator command, not part of a migration, and it does not change the runtime decision path:
 * as long as the tenant's rollout is still DISABLED, the runtime keeps reading CG3 `cg_policies` as before
 *
 * - a CG3 `PUBLISHED` that is in effect -> CG4 version `ACTIVE` origin `LEGACY_CG3` + scope head + approval
 *   `LEGACY_MIGRATED` that keeps the baseline but cannot count toward the quorum of a new version (DB trigger)
 * - CG3 `DRAFT` → CG4 `DRAFT` origin `LEGACY_CG3`
 * - no single winner (exact scope overlap, equal specificity, the CG4 head already exists, or content that
 *   cannot be compiled) -> **no head is created**, but a scoped kill switch is opened with a canonical event instead,
 *   because a scope with no head would become "no policy" at switch time, which is a silent relaxation
 * - a callback that references an `approvedExceptionId` with no canonical exception -> reported as an orphan
 *   (the evaluator cannot use that ref anyway) without creating an approval on its own
 *
 * Every result is recorded in `cg4_backfill_ledger`, unique per source, so a re-run produces no duplicate effect
 * the backfill emits no retroactive event for a migrated policy (the original facts did not change); it emits only the
 * event of a kill switch that was actually newly opened
 */

export const CG4_BACKFILL_KILL_REASONS = Object.freeze({
  AMBIGUOUS_SCOPE: 'MIGRATION_POLICY_AMBIGUOUS',
  UNMAPPABLE_POLICY: 'MIGRATION_POLICY_UNMAPPABLE',
  HEAD_CONFLICT: 'MIGRATION_POLICY_HEAD_CONFLICT',
} as const);

export type Cg4BackfillKillReason =
  (typeof CG4_BACKFILL_KILL_REASONS)[keyof typeof CG4_BACKFILL_KILL_REASONS];

export const CG4_BACKFILL_TARGETS = Object.freeze({
  LEGACY_ACTIVE: 'LEGACY_ACTIVE_POLICY',
  LEGACY_DRAFT: 'LEGACY_DRAFT_POLICY',
  KILL_SWITCH: 'SCOPE_KILL_SWITCH',
  DEFERRED: 'DEFERRED_FUTURE_POLICY',
  UNMAPPABLE_DRAFT: 'UNMAPPABLE_DRAFT_POLICY',
  ORPHAN_CALLBACK_REF: 'ORPHAN_CALLBACK_EXCEPTION_REF',
} as const);

/** capability of a migrated approval: not in the CG4 capability matrix, so no grant can hold it */
export const CG4_LEGACY_APPROVAL_CAPABILITY = 'cg.legacy.migrated';

const POLICY_LOCK_SCOPE = 'cg4-policy';

export interface Cg4LegacyBackfillInput {
  tenantId: string;
  /** opaque subject ref of the operator who ordered the backfill: not a name or email */
  operatorRef: string;
}

export interface Cg4LegacyBackfillReport {
  runId: string;
  tenantId: string;
  legacyActive: Array<{ scopeKey: string; policyId: string; version: number; policyRowId: string }>;
  drafts: Array<{ scopeKey: string; policyId: string; version: number; policyRowId: string }>;
  killedScopes: Array<{
    scopeKey: string;
    reason: Cg4BackfillKillReason;
    killSwitchId: string;
    sourcePolicyRowIds: string[];
    newlyActivated: boolean;
  }>;
  deferred: Array<{ legacyRowId: string; effectiveFrom: string }>;
  unmappableDrafts: Array<{ legacyRowId: string; code: string }>;
  orphanCallbackRefs: Array<{ callbackRequestId: string }>;
  /** a source that was backfilled in an earlier run, so it is not touched again */
  alreadyRecorded: number;
}

export interface Cg4LegacyBackfillOptions {
  now?: () => Date;
  id?: () => string;
}

interface Candidate {
  row: CgPolicy;
  scopeKey?: string;
  compiled?: Cg4CompiledPolicy;
  failure?: string;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function scopeKeyFor(row: CgPolicy): string {
  return buildCg4PolicyScopeKey({
    ...(row.channel ? { channel: row.channel } : {}),
    ...(row.purpose ? { purpose: row.purpose } : {}),
    ...(row.contactKind ? { contactKind: row.contactKind } : {}),
  });
}

function contentFor(row: CgPolicy, holidays: readonly CgHolidayCalendarEntry[]) {
  return {
    timezoneFallback: row.timezoneFallback,
    quietHours: row.quietHours,
    callbackMode: row.callbackMode,
    overridableRules: row.overridableRules,
    // CG3 has no Approved exception mechanism: the CG4 allowlist always starts empty and must not be inferred to grow
    allowedOperationalRuleCodes: [],
    holidays: holidays
      .filter((entry) => entry.policyId === row.policyId && entry.policyVersion === row.version)
      .map((entry) => ({
        localDate: entry.localDate.toISOString().slice(0, 10),
        effect: entry.effect,
        windows: entry.windows,
      })),
  };
}

function failureCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'VALIDATION_FAILED';
}

function ambiguous(left: string, right: string): boolean {
  try {
    return cg4PolicyScopesAmbiguous(left, right);
  } catch {
    // a head whose scopeKey is not in canonical form cannot be resolved in CG4 anyway, so it does not count as a conflict pair
    return false;
  }
}

export class Cg4LegacyBackfill {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: Cg4LegacyBackfillOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async run(input: Cg4LegacyBackfillInput): Promise<Cg4LegacyBackfillReport> {
    if (!input.tenantId?.trim()) throw new TypeError('tenantId is required');
    if (!input.operatorRef?.trim()) throw new TypeError('operatorRef is required');
    const tenantId = input.tenantId;
    const now = this.now();
    const runId = this.id();
    const evidenceRef = `cg4-backfill:${runId}`;

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cg4-backfill:${tenantId}`}))`,
      );
      const report: Cg4LegacyBackfillReport = {
        runId,
        tenantId,
        legacyActive: [],
        drafts: [],
        killedScopes: [],
        deferred: [],
        unmappableDrafts: [],
        orphanCallbackRefs: [],
        alreadyRecorded: 0,
      };

      const [ledgerRows, policies, holidays, heads] = await Promise.all([
        transaction.cg4BackfillLedger.findMany({
          where: { tenantId },
          select: { sourceTable: true, sourceKey: true },
        }),
        transaction.cgPolicy.findMany({
          where: { tenantId },
          orderBy: [{ policyId: 'asc' }, { version: 'asc' }],
        }),
        transaction.cgHolidayCalendarEntry.findMany({ where: { tenantId } }),
        transaction.cg4PolicyScopeHead.findMany({ where: { tenantId } }),
      ]);
      const ledger = new Set(ledgerRows.map((row) => `${row.sourceTable}:${row.sourceKey}`));
      const record = async (
        sourceTable: string,
        sourceKey: string,
        targetKind: string,
        targetId: string,
        source: unknown,
      ) => {
        await transaction.cg4BackfillLedger.create({
          data: {
            id: this.id(),
            tenantId,
            sourceTable,
            sourceKey,
            targetKind,
            targetId,
            sourceDigest: stableDigest(source),
          },
        });
        ledger.add(`${sourceTable}:${sourceKey}`);
      };
      const lockScope = (scopeKey: string) =>
        transaction.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`${POLICY_LOCK_SCOPE}:${tenantId}:${scopeKey}`}))`,
        );

      const toCandidate = (row: CgPolicy): Candidate => {
        let scopeKey: string | undefined;
        try {
          scopeKey = scopeKeyFor(row);
          const compiled = compileCg4Policy({
            content: contentFor(row, holidays),
            version: row.version,
          });
          return { row, scopeKey, compiled };
        } catch (error) {
          return { row, ...(scopeKey ? { scopeKey } : {}), failure: failureCode(error) };
        }
      };

      // ── latest CG3 version in effect per policy series ─────────────────────────────
      const activeBySeries = new Map<string, CgPolicy>();
      for (const row of policies) {
        if (row.status !== 'PUBLISHED') continue;
        if (row.effectiveTo && row.effectiveTo.getTime() <= now.getTime()) continue;
        if (row.effectiveFrom.getTime() > now.getTime()) {
          // not yet in effect in CG3: the operator must decide before the switch; do not map it to a head in advance
          report.deferred.push({
            legacyRowId: row.id,
            effectiveFrom: row.effectiveFrom.toISOString(),
          });
          if (!ledger.has(`cg_policies_deferred:${row.id}`)) {
            await record('cg_policies_deferred', row.id, CG4_BACKFILL_TARGETS.DEFERRED, row.id, {
              policyId: row.policyId,
              version: row.version,
              effectiveFrom: row.effectiveFrom.toISOString(),
            });
          }
          continue;
        }
        const current = activeBySeries.get(row.policyId);
        if (!current || row.version > current.version) activeBySeries.set(row.policyId, row);
      }

      const candidates: Candidate[] = [];
      for (const row of activeBySeries.values()) {
        if (ledger.has(`cg_policies:${row.id}`)) {
          report.alreadyRecorded += 1;
          continue;
        }
        candidates.push(toCandidate(row));
      }

      // ── reconcile ambiguity before creating a head (#179 §6 step 3) ────────────────────────
      const kills = new Map<string, { reason: Cg4BackfillKillReason; sources: Set<string> }>();
      const kill = (scopeKey: string, reason: Cg4BackfillKillReason, sourceId: string) => {
        const entry = kills.get(scopeKey) ?? { reason, sources: new Set<string>() };
        entry.sources.add(sourceId);
        kills.set(scopeKey, entry);
      };
      const headByScope = new Map(heads.map((head) => [head.scopeKey, head]));
      const byScope = new Map<string, Candidate[]>();
      for (const candidate of candidates) {
        if (!candidate.scopeKey || candidate.failure) {
          // a scopeKey that cannot be built at all means the boundary is unknown: use an unreadable scope, which the kill switch
          // treats as covering the whole tenant, failing closed
          kill(
            candidate.scopeKey ?? `legacy-policy:${candidate.row.policyId}`,
            CG4_BACKFILL_KILL_REASONS.UNMAPPABLE_POLICY,
            candidate.row.id,
          );
          continue;
        }
        byScope.set(candidate.scopeKey, [...(byScope.get(candidate.scopeKey) ?? []), candidate]);
      }
      for (const [scopeKey, group] of byScope) {
        if (group.length > 1) {
          for (const candidate of group) {
            kill(scopeKey, CG4_BACKFILL_KILL_REASONS.AMBIGUOUS_SCOPE, candidate.row.id);
          }
        } else if (headByScope.has(scopeKey)) {
          kill(scopeKey, CG4_BACKFILL_KILL_REASONS.HEAD_CONFLICT, group[0]!.row.id);
        }
      }
      const scopes = [...new Set([...byScope.keys(), ...headByScope.keys()])].sort();
      for (const [index, left] of scopes.entries()) {
        for (const right of scopes.slice(index + 1)) {
          if (!byScope.has(left) && !byScope.has(right)) continue;
          if (!ambiguous(left, right)) continue;
          for (const scopeKey of [left, right]) {
            const sources = byScope.get(scopeKey)?.map((candidate) => candidate.row.id) ?? [
              headByScope.get(scopeKey)!.id,
            ];
            for (const source of sources) {
              kill(scopeKey, CG4_BACKFILL_KILL_REASONS.AMBIGUOUS_SCOPE, source);
            }
          }
        }
      }

      for (const [scopeKey, entry] of [...kills.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        await lockScope(scopeKey);
        const active = await transaction.cg4ScopeKillSwitch.findFirst({
          where: { tenantId, scopeKey, state: 'ACTIVE' },
          select: { id: true },
        });
        let killSwitchId = active?.id;
        if (!killSwitchId) {
          killSwitchId = this.id();
          const mutationId = this.id();
          await transaction.cg4ScopeKillSwitch.create({
            data: {
              id: killSwitchId,
              tenantId,
              scopeKey,
              state: 'ACTIVE',
              reasonCode: entry.reason,
              evidenceRef,
              activatedByRef: input.operatorRef,
              activatedAt: now,
            },
          });
          const event = cg4KillSwitchEvent({
            tenantId,
            scopeKey,
            killSwitchId,
            state: 'ACTIVE',
            mutationId,
            eventId: this.id(),
            occurredAt: now,
          });
          await transaction.cgEventOutbox.create({ data: event.outbox });
          await transaction.cgAuditLog.create({
            data: {
              id: this.id(),
              tenantId,
              mutationId,
              aggregateType: 'POLICY',
              aggregateId: killSwitchId,
              aggregateVersion: event.version,
              action: 'CG4_BACKFILL_KILL_SWITCH',
              actorClass: 'SYSTEM',
              actorRef: input.operatorRef,
              sourceKind: 'SYSTEM',
              evidenceRef,
              afterDigest: event.stateDigest,
              occurredAt: now,
            },
          });
        }
        const sourcePolicyRowIds = [...entry.sources].sort();
        if (!ledger.has(`cg4_scope:${scopeKey}`)) {
          await record('cg4_scope', scopeKey, CG4_BACKFILL_TARGETS.KILL_SWITCH, killSwitchId, {
            scopeKey,
            reason: entry.reason,
            sources: sourcePolicyRowIds,
          });
        }
        report.killedScopes.push({
          scopeKey,
          reason: entry.reason,
          killSwitchId,
          sourcePolicyRowIds,
          newlyActivated: !active,
        });
      }

      // ── map a CG3 PUBLISHED with a single winner to a LEGACY_ACTIVE head ─────────────────
      for (const candidate of candidates) {
        const { row, scopeKey, compiled } = candidate;
        if (!scopeKey || !compiled || candidate.failure || kills.has(scopeKey)) continue;
        await lockScope(scopeKey);
        const policyRowId = this.id();
        const mutationId = this.id();
        const decidedAt = row.publishedAt ?? row.effectiveFrom;
        const legacyApproval = {
          approverRef: row.checkerActorRef ?? `legacy-unrecorded-checker:${row.id}`,
          evidenceRef: row.approvalRef ?? `legacy-unrecorded-approval:${row.id}`,
          decidedAt: decidedAt.toISOString(),
          capabilitySource: 'LEGACY_MIGRATED',
        };
        const approvalDigest = stableDigest(legacyApproval);
        await transaction.cg4Policy.create({
          data: {
            id: policyRowId,
            tenantId,
            policyId: row.policyId,
            version: row.version,
            scopeKey,
            content: json(compiled.content),
            contentDigest: compiled.contentDigest,
            registryVersion: compiled.registryVersion,
            schemaVersion: compiled.schemaVersion,
            evaluatorVersion: compiled.evaluatorVersion,
            status: 'ACTIVE',
            effectiveFrom: row.effectiveFrom,
            ...(row.effectiveTo ? { effectiveTo: row.effectiveTo } : {}),
            makerActorRef: row.makerActorRef,
            submittedAt: decidedAt,
            approvedAt: decidedAt,
            publishedAt: decidedAt,
            approvalDigest,
            origin: 'LEGACY_CG3',
            legacySourceRowId: row.id,
          },
        });
        await transaction.cg4PolicyApproval.create({
          data: {
            id: this.id(),
            tenantId,
            policyId: row.policyId,
            policyVersion: row.version,
            decision: 'APPROVED',
            approverRef: legacyApproval.approverRef,
            evidenceRef: legacyApproval.evidenceRef,
            decidedAt,
            capability: CG4_LEGACY_APPROVAL_CAPABILITY,
            capabilitySource: 'LEGACY_MIGRATED',
            directCompliance: false,
            emergencyAuthority: false,
            authorizationEpoch: 0,
            scopeVersion: 0,
          },
        });
        const headDigest = stableDigest({
          scopeKey,
          policyId: row.policyId,
          version: row.version,
          contentDigest: compiled.contentDigest,
          origin: 'LEGACY_CG3',
        });
        await transaction.cg4PolicyScopeHead.create({
          data: {
            id: this.id(),
            tenantId,
            scopeKey,
            headPolicyId: row.policyId,
            headPolicyVersion: row.version,
            headPolicyRevisionId: policyRowId,
            headVersion: 1,
            headDigest,
            latestMutationId: mutationId,
          },
        });
        await transaction.cgAuditLog.create({
          data: {
            id: this.id(),
            tenantId,
            mutationId,
            aggregateType: 'POLICY',
            aggregateId: row.policyId,
            aggregateVersion: 1,
            action: 'CG4_BACKFILL_LEGACY_ACTIVE',
            actorClass: 'SYSTEM',
            actorRef: input.operatorRef,
            sourceKind: 'SYSTEM',
            evidenceRef,
            afterDigest: headDigest,
            occurredAt: now,
          },
        });
        await record('cg_policies', row.id, CG4_BACKFILL_TARGETS.LEGACY_ACTIVE, policyRowId, {
          policyId: row.policyId,
          version: row.version,
          status: row.status,
          contentDigest: row.contentDigest,
          effectiveFrom: row.effectiveFrom.toISOString(),
        });
        report.legacyActive.push({
          scopeKey,
          policyId: row.policyId,
          version: row.version,
          policyRowId,
        });
      }

      // ── CG3 DRAFT -> CG4 DRAFT (no head; must be tested and approved with CG4 before publish) ──
      for (const row of policies) {
        if (row.status !== 'DRAFT') continue;
        if (ledger.has(`cg_policies:${row.id}`)) {
          report.alreadyRecorded += 1;
          continue;
        }
        const candidate = toCandidate(row);
        const existing = candidate.scopeKey
          ? await transaction.cg4Policy.findUnique({
              where: {
                tenantId_policyId_version: {
                  tenantId,
                  policyId: row.policyId,
                  version: row.version,
                },
              },
              select: { id: true },
            })
          : null;
        if (!candidate.scopeKey || !candidate.compiled || candidate.failure || existing) {
          const code = existing
            ? 'POLICY_VERSION_CONFLICT'
            : (candidate.failure ?? 'SCOPE_INVALID');
          await record('cg_policies', row.id, CG4_BACKFILL_TARGETS.UNMAPPABLE_DRAFT, row.id, {
            policyId: row.policyId,
            version: row.version,
            code,
          });
          report.unmappableDrafts.push({ legacyRowId: row.id, code });
          continue;
        }
        const policyRowId = this.id();
        await transaction.cg4Policy.create({
          data: {
            id: policyRowId,
            tenantId,
            policyId: row.policyId,
            version: row.version,
            scopeKey: candidate.scopeKey,
            content: json(candidate.compiled.content),
            contentDigest: candidate.compiled.contentDigest,
            registryVersion: candidate.compiled.registryVersion,
            schemaVersion: candidate.compiled.schemaVersion,
            evaluatorVersion: candidate.compiled.evaluatorVersion,
            status: 'DRAFT',
            effectiveFrom: row.effectiveFrom,
            ...(row.effectiveTo ? { effectiveTo: row.effectiveTo } : {}),
            makerActorRef: row.makerActorRef,
            origin: 'LEGACY_CG3',
            legacySourceRowId: row.id,
          },
        });
        await record('cg_policies', row.id, CG4_BACKFILL_TARGETS.LEGACY_DRAFT, policyRowId, {
          policyId: row.policyId,
          version: row.version,
          status: row.status,
          contentDigest: row.contentDigest,
        });
        report.drafts.push({
          scopeKey: candidate.scopeKey,
          policyId: row.policyId,
          version: row.version,
          policyRowId,
        });
      }

      // ── a callback that references an exception with no canonical series (#179 §6 step 5) ────────
      const callbacks = await transaction.cgCallbackRequest.findMany({
        where: { tenantId, approvedExceptionId: { not: null } },
        select: { id: true, approvedExceptionId: true },
      });
      if (callbacks.length > 0) {
        const canonical = new Set(
          (
            await transaction.cg4ExceptionHead.findMany({
              where: {
                tenantId,
                exceptionId: {
                  in: [...new Set(callbacks.map((callback) => callback.approvedExceptionId!))],
                },
              },
              select: { exceptionId: true },
            })
          ).map((head) => head.exceptionId),
        );
        for (const callback of callbacks) {
          if (canonical.has(callback.approvedExceptionId!)) continue;
          if (ledger.has(`cg_callback_requests:${callback.id}`)) {
            report.alreadyRecorded += 1;
            continue;
          }
          await record(
            'cg_callback_requests',
            callback.id,
            CG4_BACKFILL_TARGETS.ORPHAN_CALLBACK_REF,
            callback.id,
            { approvedExceptionId: callback.approvedExceptionId },
          );
          report.orphanCallbackRefs.push({ callbackRequestId: callback.id });
        }
      }

      return report;
    });
  }
}
