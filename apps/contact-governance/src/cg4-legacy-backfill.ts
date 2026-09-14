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
 * CG4.10 (#193) PR-A: backfill CG3 policy → CG4 (#179 §6 ขั้น backfill + reconcile ambiguity +
 * seed compatibility)
 *
 * เป็นคำสั่งของ operator ที่รันซ้ำได้ ไม่ใช่ส่วนของ migration และไม่เปลี่ยน runtime decision path:
 * ตราบใดที่ rollout ของ tenant ยังเป็น DISABLED runtime ยังอ่าน CG3 `cg_policies` เหมือนเดิม
 *
 * - CG3 `PUBLISHED` ที่มีผลอยู่ → CG4 version `ACTIVE` origin `LEGACY_CG3` + scope head + approval
 *   `LEGACY_MIGRATED` ที่คง baseline ได้แต่นับเป็น quorum ของ version ใหม่ไม่ได้ (DB trigger)
 * - CG3 `DRAFT` → CG4 `DRAFT` origin `LEGACY_CG3`
 * - ไม่มีผู้ชนะเดียว (overlap ตรง scope, equal specificity, head ของ CG4 อยู่แล้ว หรือ content ที่
 *   compile ไม่ได้) → **ไม่สร้าง head** แต่เปิด scoped kill switch พร้อม canonical event แทน
 *   เพราะ scope ที่ไม่มี head จะกลายเป็น "ไม่มี policy" ตอน switch ซึ่งเป็นการผ่อนลงแบบเงียบ
 * - callback ที่อ้าง `approvedExceptionId` ซึ่งไม่มี canonical exception → รายงานเป็น orphan
 *   (evaluator ใช้ ref นั้นไม่ได้อยู่แล้ว) โดยไม่สร้าง approval ขึ้นเอง
 *
 * ทุกผลถูกบันทึกใน `cg4_backfill_ledger` แบบ unique ต่อ source จึงรันซ้ำแล้วไม่เกิด effect ซ้ำ
 * backfill ไม่ออก event ย้อนหลังให้ policy ที่ย้ายมา (ข้อเท็จจริงเดิมไม่ได้เปลี่ยน) ออกเฉพาะ event
 * ของ kill switch ที่เพิ่งเปิดจริง
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

/** capability ของ approval ที่ย้ายมา — ไม่อยู่ใน capability matrix ของ CG4 จึงไม่มี grant ใดถือได้ */
export const CG4_LEGACY_APPROVAL_CAPABILITY = 'cg.legacy.migrated';

const POLICY_LOCK_SCOPE = 'cg4-policy';

export interface Cg4LegacyBackfillInput {
  tenantId: string;
  /** opaque subject ref ของ operator ที่สั่ง backfill — ไม่ใช่ชื่อหรืออีเมล */
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
  /** source ที่เคย backfill แล้วในรอบก่อน จึงไม่ถูกแตะซ้ำ */
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
    // CG3 ไม่มีกลไก Approved exception: allowlist ของ CG4 จึงเริ่มว่างเสมอ ห้ามอนุมานเพิ่ม
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
    // head ที่ scopeKey ไม่ใช่ canonical form resolve ใน CG4 ไม่ได้อยู่แล้ว จึงไม่นับเป็นคู่ชน
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
    if (!input.tenantId?.trim()) throw new TypeError('tenantId ต้องระบุ');
    if (!input.operatorRef?.trim()) throw new TypeError('operatorRef ต้องระบุ');
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

      // ── CG3 version ล่าสุดที่มีผลอยู่ต่อ policy series ─────────────────────────────
      const activeBySeries = new Map<string, CgPolicy>();
      for (const row of policies) {
        if (row.status !== 'PUBLISHED') continue;
        if (row.effectiveTo && row.effectiveTo.getTime() <= now.getTime()) continue;
        if (row.effectiveFrom.getTime() > now.getTime()) {
          // ยังไม่ถึงเวลามีผลใน CG3: ต้องให้ operator ตัดสินก่อน switch ไม่ map เป็น head ล่วงหน้า
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

      // ── reconcile ambiguity ก่อนสร้าง head (#179 §6 ขั้น 3) ────────────────────────
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
          // scopeKey ที่สร้างไม่ได้เลยทำให้ไม่รู้ขอบเขต: ใช้ scope ที่อ่านไม่ออกซึ่ง kill switch
          // ถือว่าครอบทั้ง tenant แบบ fail closed
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

      // ── map CG3 PUBLISHED ที่มีผู้ชนะเดียวเป็น LEGACY_ACTIVE head ─────────────────
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

      // ── CG3 DRAFT → CG4 DRAFT (ไม่มี head, ต้องทดสอบและอนุมัติด้วย CG4 ก่อน publish) ──
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

      // ── callback ที่อ้าง exception ซึ่งไม่มี canonical series (#179 §6 ขั้น 5) ────────
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
