import { randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { Cg4SourceType } from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';
import { cg4PolicyScopeMatches, parseCg4PolicyScopeKey } from './cg4-policy-compiler.js';
import type { Cg4PolicyRequestScope } from './cg4-policy-resolution.js';

/**
 * CG4.10 (#193) PR-B: development rollout of Contact Governance per tenant (#178, #179 §6)
 *
 * - `DISABLED`: the CG3 loader is the reader, the CG4 writer writes dark
 * - `SHADOW_EVALUATION`: CG3 still decides, but the CG4 head is evaluated side by side and differing digests are recorded;
 *   a mismatch on the pilot scope fails closed
 * - `SCOPED_SYNTHETIC`: the pilot scope reads from the CG4 head (switch), other scopes are still in shadow
 * - `INTERNAL_ENABLED`: every scope reads from the CG4 head
 *
 * Before the switch you can step back one stage at a time; after the switch you must not go back to the CG3 reader: use freeze, scoped kill,
 * canonical reconcile and forward-fix instead. Every stage has `actualProviderTraffic=false`
 */

export const CG4_ROLLOUT_STAGES = Object.freeze([
  'DISABLED',
  'SHADOW_EVALUATION',
  'SCOPED_SYNTHETIC',
  'INTERNAL_ENABLED',
] as const);
export type Cg4RolloutStage = (typeof CG4_ROLLOUT_STAGES)[number];

const SWITCHED_STAGE_INDEX = CG4_ROLLOUT_STAGES.indexOf('SCOPED_SYNTHETIC');

export const GOVERNANCE_SHADOW_MISMATCH = 'GOVERNANCE_SHADOW_MISMATCH';
export const GOVERNANCE_MUTATION_FROZEN = 'GOVERNANCE_MUTATION_FROZEN';

export type Cg4RolloutErrorCode =
  | 'ROLLOUT_VERSION_CONFLICT'
  | 'ROLLOUT_INVALID_TRANSITION'
  | 'ROLLOUT_SWITCH_IRREVERSIBLE'
  | 'ROLLOUT_SCOPE_REQUIRED'
  | 'ROLLOUT_BACKFILL_REQUIRED'
  | 'ROLLOUT_SHADOW_MISMATCH_UNRESOLVED'
  | 'ROLLOUT_CALLBACK_REF_NONCANONICAL'
  | 'ROLLOUT_FROZEN'
  | typeof GOVERNANCE_MUTATION_FROZEN;

export class Cg4RolloutError extends Error {
  constructor(
    readonly code: Cg4RolloutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Cg4RolloutError';
  }
}

export interface Cg4RolloutSnapshot {
  tenantId: string;
  stage: Cg4RolloutStage;
  syntheticScopeKeys: string[];
  shadowStartedAt: Date | null;
  switchedAt: Date | null;
  mutationFrozen: boolean;
  /** 0 = no row yet (DISABLED by default) */
  version: number;
}

export function cg4DefaultRollout(tenantId: string): Cg4RolloutSnapshot {
  return {
    tenantId,
    stage: 'DISABLED',
    syntheticScopeKeys: [],
    shadowStartedAt: null,
    switchedAt: null,
    mutationFrozen: false,
    version: 0,
  };
}

export async function loadCg4RolloutState(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<Cg4RolloutSnapshot> {
  const row = await transaction.cg4RolloutState.findUnique({ where: { tenantId } });
  if (!row) return cg4DefaultRollout(tenantId);
  return {
    tenantId,
    stage: row.stage,
    syntheticScopeKeys: [...row.syntheticScopeKeys],
    shadowStartedAt: row.shadowStartedAt,
    switchedAt: row.switchedAt,
    mutationFrozen: row.mutationFrozen,
    version: row.version,
  };
}

// ── Reader selection (pure) ──────────────────────────────────────────────────

export type Cg4PolicyReaderMode = 'CG3' | 'CG3_WITH_SHADOW' | 'CG4';

export interface Cg4PolicyReaderSelection {
  mode: Cg4PolicyReaderMode;
  /** the request is in the pilot scope declared when entering shadow/switch */
  pilot: boolean;
}

/** a scope key that cannot be parsed is treated as covering every request, so a broken scope does not escape the pilot/fail closed */
function scopeCovers(scopeKey: string, request: Cg4PolicyRequestScope): boolean {
  try {
    return cg4PolicyScopeMatches(scopeKey, request);
  } catch {
    return true;
  }
}

export function cg4PolicyReaderFor(
  rollout: Pick<Cg4RolloutSnapshot, 'stage' | 'syntheticScopeKeys'>,
  request: Cg4PolicyRequestScope,
): Cg4PolicyReaderSelection {
  const pilot = rollout.syntheticScopeKeys.some((scopeKey) => scopeCovers(scopeKey, request));
  switch (rollout.stage) {
    case 'DISABLED':
      return { mode: 'CG3', pilot: false };
    case 'SHADOW_EVALUATION':
      return { mode: 'CG3_WITH_SHADOW', pilot };
    case 'SCOPED_SYNTHETIC':
      return { mode: pilot ? 'CG4' : 'CG3_WITH_SHADOW', pilot };
    case 'INTERNAL_ENABLED':
      return { mode: 'CG4', pilot };
  }
}

export function cg4PolicyRequestScope(input: {
  channel: string;
  purpose: string;
  contactKind?: string | null;
  source?: string | null;
}): Cg4PolicyRequestScope {
  return {
    channel: input.channel as Cg4PolicyRequestScope['channel'],
    purpose: input.purpose,
    ...(input.contactKind ? { contactKind: input.contactKind } : {}),
    ...(input.source ? { sourceType: input.source as Cg4SourceType } : {}),
  };
}

// ── Transition planning (pure) ───────────────────────────────────────────────

export interface Cg4RolloutTransitionRequest {
  toStage: Cg4RolloutStage;
  /** pilot scopes; required when entering SHADOW_EVALUATION and must not change at switch */
  syntheticScopeKeys?: readonly string[];
}

export interface Cg4RolloutTransitionPlan {
  stage: Cg4RolloutStage;
  syntheticScopeKeys: string[];
  startsShadowWindow: boolean;
  switches: boolean;
}

function normalizeScopeKeys(keys: readonly string[]): string[] {
  const normalized = [...new Set(keys.map((key) => key.trim()))].sort();
  for (const key of normalized) {
    try {
      parseCg4PolicyScopeKey(key);
    } catch {
      throw new Cg4RolloutError(
        'ROLLOUT_SCOPE_REQUIRED',
        `pilot scope ${key} is not a policy scope key`,
      );
    }
  }
  return normalized;
}

export function planCg4RolloutTransition(
  current: Cg4RolloutSnapshot,
  request: Cg4RolloutTransitionRequest,
): Cg4RolloutTransitionPlan {
  const from = CG4_ROLLOUT_STAGES.indexOf(current.stage);
  const to = CG4_ROLLOUT_STAGES.indexOf(request.toStage);
  if (to < 0 || Math.abs(to - from) !== 1) {
    throw new Cg4RolloutError(
      'ROLLOUT_INVALID_TRANSITION',
      `rollout can advance only one stage at a time: ${current.stage} -> ${request.toStage}`,
    );
  }
  if (to < from && current.switchedAt && to < SWITCHED_STAGE_INDEX) {
    // #179 §6: after any CG4 mutation, never down-migrate or revert the writer/reader
    throw new Cg4RolloutError(
      'ROLLOUT_SWITCH_IRREVERSIBLE',
      'after switching to the CG4 reader it cannot be reverted; use freeze/kill/forward-fix instead',
    );
  }

  if (request.toStage === 'DISABLED') {
    return {
      stage: 'DISABLED',
      syntheticScopeKeys: [],
      startsShadowWindow: false,
      switches: false,
    };
  }
  if (request.toStage === 'SHADOW_EVALUATION') {
    const keys = normalizeScopeKeys(request.syntheticScopeKeys ?? []);
    if (keys.length === 0) {
      throw new Cg4RolloutError(
        'ROLLOUT_SCOPE_REQUIRED',
        'shadow must declare at least one pilot scope',
      );
    }
    return {
      stage: request.toStage,
      syntheticScopeKeys: keys,
      startsShadowWindow: true,
      switches: false,
    };
  }
  if (request.toStage === 'SCOPED_SYNTHETIC' && to > from) {
    // a switch is allowed only for scopes that have passed a shadow window: adding a new scope must go back to shadow first
    if (
      request.syntheticScopeKeys &&
      normalizeScopeKeys(request.syntheticScopeKeys).join('\n') !==
        current.syntheticScopeKeys.join('\n')
    ) {
      throw new Cg4RolloutError(
        'ROLLOUT_INVALID_TRANSITION',
        'a switch must use the same pilot scopes that passed the shadow window',
      );
    }
    return {
      stage: request.toStage,
      syntheticScopeKeys: [...current.syntheticScopeKeys],
      startsShadowWindow: false,
      switches: true,
    };
  }
  return {
    stage: request.toStage,
    syntheticScopeKeys: [...current.syntheticScopeKeys],
    startsShadowWindow: false,
    switches: false,
  };
}

// ── Repository ───────────────────────────────────────────────────────────────

interface RolloutCommandBase {
  tenantId: string;
  expectedVersion: number;
  actorRef: string;
  evidenceRef: string;
  reasonCode: string;
}

export interface Cg4RolloutTransitionInput
  extends RolloutCommandBase, Cg4RolloutTransitionRequest {}

export interface Cg4RolloutFreezeInput extends RolloutCommandBase {
  frozen: boolean;
}

export interface Cg4RolloutRepositoryOptions {
  id?: () => string;
  now?: () => Date;
  /** drill fault injection (`CG4-RC01`): called before commit inside the same transaction */
  beforeCommit?: (snapshot: Cg4RolloutSnapshot) => Promise<void> | void;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function stateDigest(snapshot: Cg4RolloutSnapshot): string {
  return stableDigest({
    stage: snapshot.stage,
    syntheticScopeKeys: snapshot.syntheticScopeKeys,
    shadowStartedAt: snapshot.shadowStartedAt?.toISOString() ?? null,
    switchedAt: snapshot.switchedAt?.toISOString() ?? null,
    mutationFrozen: snapshot.mutationFrozen,
    version: snapshot.version,
  });
}

export class Cg4RolloutRepository {
  private readonly id: () => string;
  private readonly now: () => Date;
  private readonly beforeCommit?: Cg4RolloutRepositoryOptions['beforeCommit'];

  constructor(
    private readonly database: PrismaClient,
    options: Cg4RolloutRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
    this.beforeCommit = options.beforeCommit;
  }

  async current(tenantId: string): Promise<Cg4RolloutSnapshot> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      loadCg4RolloutState(transaction, tenantId),
    );
  }

  async transition(input: Cg4RolloutTransitionInput): Promise<Cg4RolloutSnapshot> {
    return this.mutate(input, 'TRANSITION', async (transaction, current, now) => {
      const plan = planCg4RolloutTransition(current, input);
      const forward =
        CG4_ROLLOUT_STAGES.indexOf(plan.stage) > CG4_ROLLOUT_STAGES.indexOf(current.stage);
      if (forward && plan.stage !== 'SHADOW_EVALUATION') {
        await this.assertSwitchReady(transaction, current, plan, now);
      }
      if (forward && plan.stage === 'SHADOW_EVALUATION') {
        const ledger = await transaction.cg4BackfillLedger.count({
          where: { tenantId: input.tenantId },
        });
        if (ledger === 0) {
          throw new Cg4RolloutError(
            'ROLLOUT_BACKFILL_REQUIRED',
            'CG3 -> CG4 must be backfilled before starting shadow evaluation',
          );
        }
      }
      return {
        ...current,
        stage: plan.stage,
        syntheticScopeKeys: plan.syntheticScopeKeys,
        shadowStartedAt:
          plan.stage === 'DISABLED'
            ? null
            : plan.startsShadowWindow
              ? now
              : current.shadowStartedAt,
        switchedAt: plan.switches ? now : current.switchedAt,
      };
    });
  }

  async setFrozen(input: Cg4RolloutFreezeInput): Promise<Cg4RolloutSnapshot> {
    return this.mutate(
      input,
      input.frozen ? 'FREEZE' : 'UNFREEZE',
      async (_transaction, current) => {
        if (current.mutationFrozen === input.frozen) {
          throw new Cg4RolloutError(
            'ROLLOUT_INVALID_TRANSITION',
            input.frozen ? 'mutation is already frozen' : 'mutation is not frozen',
          );
        }
        return { ...current, mutationFrozen: input.frozen };
      },
    );
  }

  /**
   * a switch and enable need evidence that the shadow window is clean and that every callback that references an exception
   * resolves to a canonical exception (#179 §6 step 5 seed compatibility)
   */
  private async assertSwitchReady(
    transaction: Prisma.TransactionClient,
    current: Cg4RolloutSnapshot,
    plan: Cg4RolloutTransitionPlan,
    now: Date,
  ): Promise<void> {
    if (current.mutationFrozen) {
      throw new Cg4RolloutError('ROLLOUT_FROZEN', 'cannot enable the CG4 reader during a freeze');
    }
    const onlyPilot = plan.stage === 'SCOPED_SYNTHETIC';
    const mismatches = await transaction.cg4ShadowMismatch.count({
      where: {
        tenantId: current.tenantId,
        detectedAt: { gte: current.shadowStartedAt ?? new Date(0) },
        ...(onlyPilot ? { pilot: true } : {}),
      },
    });
    if (mismatches > 0) {
      throw new Cg4RolloutError(
        'ROLLOUT_SHADOW_MISMATCH_UNRESOLVED',
        `the shadow window has ${mismatches} mismatches; reconcile and start a new shadow window`,
      );
    }

    const callbacks = await transaction.cgCallbackRequest.findMany({
      where: { tenantId: current.tenantId, expiresAt: { gt: now } },
      select: {
        seriesId: true,
        version: true,
        mutationKind: true,
        approvedExceptionId: true,
        channel: true,
        purpose: true,
      },
      orderBy: [{ seriesId: 'asc' }, { version: 'desc' }],
    });
    const latest = new Map<string, (typeof callbacks)[number]>();
    for (const callback of callbacks) {
      if (!latest.has(callback.seriesId)) latest.set(callback.seriesId, callback);
    }
    const references = [...latest.values()].filter(
      (callback) =>
        callback.mutationKind === 'REQUEST' &&
        callback.approvedExceptionId !== null &&
        (!onlyPilot ||
          current.syntheticScopeKeys.some((scopeKey) =>
            scopeCovers(scopeKey, { channel: callback.channel, purpose: callback.purpose }),
          )),
    );
    if (references.length === 0) return;
    const ids = [...new Set(references.map((callback) => callback.approvedExceptionId as string))];
    const heads = await transaction.cg4ExceptionHead.findMany({
      where: { tenantId: current.tenantId, exceptionId: { in: ids } },
      select: { exceptionId: true },
    });
    const canonical = new Set(heads.map((head) => head.exceptionId));
    const orphans = ids.filter((id) => !canonical.has(id));
    if (orphans.length > 0) {
      throw new Cg4RolloutError(
        'ROLLOUT_CALLBACK_REF_NONCANONICAL',
        `${orphans.length} callbacks reference an exception that is not in canonical CG4`,
      );
    }
  }

  private async mutate(
    input: RolloutCommandBase,
    action: 'TRANSITION' | 'FREEZE' | 'UNFREEZE',
    next: (
      transaction: Prisma.TransactionClient,
      current: Cg4RolloutSnapshot,
      now: Date,
    ) => Promise<Cg4RolloutSnapshot>,
  ): Promise<Cg4RolloutSnapshot> {
    const actorRef = nonEmpty(input.actorRef, 'actorRef');
    const evidenceRef = nonEmpty(input.evidenceRef, 'evidenceRef');
    const reasonCode = nonEmpty(input.reasonCode, 'reasonCode');
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg4-rollout:${input.tenantId}`}))`,
      );
      const current = await loadCg4RolloutState(transaction, input.tenantId);
      if (current.version !== input.expectedVersion) {
        throw new Cg4RolloutError(
          'ROLLOUT_VERSION_CONFLICT',
          `rollout is at version ${current.version} and not ${input.expectedVersion}`,
        );
      }
      const now = this.now();
      const planned = await next(transaction, current, now);
      const updated: Cg4RolloutSnapshot = { ...planned, version: current.version + 1 };
      const data = {
        stage: updated.stage,
        syntheticScopeKeys: updated.syntheticScopeKeys,
        shadowStartedAt: updated.shadowStartedAt,
        switchedAt: updated.switchedAt,
        mutationFrozen: updated.mutationFrozen,
        version: updated.version,
        updatedByRef: actorRef,
        evidenceRef,
        updatedAt: now,
      };
      if (current.version === 0) {
        await transaction.cg4RolloutState.create({
          data: { id: this.id(), tenantId: input.tenantId, ...data },
        });
      } else {
        const written = await transaction.cg4RolloutState.updateMany({
          where: { tenantId: input.tenantId, version: current.version },
          data,
        });
        if (written.count !== 1) {
          throw new Cg4RolloutError(
            'ROLLOUT_VERSION_CONFLICT',
            'rollout was changed during the command',
          );
        }
      }
      await transaction.cg4RolloutTransition.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          action,
          fromStage: current.stage,
          toStage: updated.stage,
          fromVersion: current.version,
          toVersion: updated.version,
          mutationFrozen: updated.mutationFrozen,
          syntheticScopeKeys: updated.syntheticScopeKeys,
          reasonCode,
          actorRef,
          evidenceRef,
          stateDigest: stateDigest(updated),
          occurredAt: now,
        },
      });
      await this.beforeCommit?.(updated);
      return updated;
    });
  }
}

/**
 * a freeze stops the mutations that move the CG4 policy head (publish/scheduled activation) during reconcile
 * a kill switch can still be opened because it only tightens (#176 §6)
 */
export async function assertCg4MutationNotFrozen(
  transaction: Prisma.TransactionClient,
  tenantId: string,
): Promise<void> {
  const rollout = await transaction.cg4RolloutState.findUnique({
    where: { tenantId },
    select: { mutationFrozen: true },
  });
  if (rollout?.mutationFrozen) {
    throw new Cg4RolloutError(
      GOVERNANCE_MUTATION_FROZEN,
      'Contact Governance mutation is frozen during reconcile/forward-fix',
    );
  }
}
