/**
 * Owner: Delivery/Channels — durable primitives of the LINE rollout control plane (S2.1 #365)
 *
 * gate/allowlist/credential ref/run authorization/cap ledger per #358 — here there are only primitives
 * that are atomic and tenant-isolated; policy (who may order what, effective gate, real cap values) belongs to
 * S2.3, which calls these primitives. The DB still re-checks invariants with CHECK/trigger every time
 *
 * Race safety comes from three mechanisms only: conditional update (CAS/one-shot), unique index and
 * the gate's row lock (`FOR UPDATE`) that serializes cap counting per scope — no counter in memory
 */
import {
  Prisma,
  type DlLineAllowlistEntry,
  type DlLineCapLedgerEntry,
  type DlLineCredentialRef,
  type DlLineKillReason,
  type DlLineRolloutState,
  type DlLineRunAuthorization,
  type DlLineScopeGate,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { LineCapKind, LineCredentialKind, LineGateErrorCode } from '@d-contact/cxa-contracts';
import {
  LineBindingRejectedError,
  LineIdempotencyConflictError,
  isUniqueViolation,
  rejectingForeignBinding,
} from './line-repository-support.js';

export interface LineGateScope {
  tenantId: string;
  channelAccountId: string;
  senderIdentityId: string;
  purpose: string;
  contactKind: string;
}

export interface LineGatePatch {
  businessState?: DlLineRolloutState;
  technicalSwitchOn?: boolean;
  configDigest?: string | null;
}

export interface AddLineAllowlistEntryInput {
  id: string;
  tenantId: string;
  gateId: string;
  channelAccountId: string;
  senderIdentityId: string;
  purpose: string;
  contactKind: string;
  recipientFingerprint: string;
  recipientProtectedRef: string;
  contentRef: string;
  contentDigest: string;
  configDigest: string;
  validFrom: Date;
  validUntil: Date;
  approvalAuditRef: string;
}

export interface RegisterLineCredentialRefInput {
  id: string;
  tenantId: string;
  channelAccountId: string;
  credentialKind: LineCredentialKind;
  version: number;
  keychainService: string;
  keychainAccount: string;
  fingerprint: string;
  keyId?: string;
  issuedAt: Date;
  expiresAt?: Date;
  longLivedExceptionRef?: string;
}

export interface ProposeLineRunInput {
  id: string;
  tenantId: string;
  gateId: string;
  allowlistEntryId: string;
  credentialRefId: string;
  credentialVersion: number;
  proposalDigest: string;
  configDigest: string;
  capLogicalDeliveries: number;
  capProviderAttempts: number;
  proposedBy: string;
  proposedAt: Date;
  expiresAt: Date;
  /** #567: present only for the profile `S2_LINE_TEAM_TRIAL_V1` */
  profile?: string;
  capRecipientPer24h?: number;
  capPer24h?: number;
  capLifetime?: number;
  trialRef?: string;
  contactId?: string;
  identityId?: string | null;
}

export type LineRunApprovalRole = 'TENANT_ADMIN' | 'COMPLIANCE';

export type ConsumeLineRunResult =
  | { status: 'CONSUMED'; authorization: DlLineRunAuthorization }
  | {
      status: 'DENIED';
      code: Extract<
        LineGateErrorCode,
        'RUN_AUTHORIZATION_MISSING' | 'RUN_AUTHORIZATION_EXPIRED' | 'RUN_AUTHORIZATION_CONSUMED'
      >;
    };

export interface LineCapLimit {
  code: LineGateErrorCode;
  capKind: LineCapKind;
  max: number;
  /** Counts only the same recipient (e.g. 1/recipient/24h) */
  sameRecipient?: boolean;
  /** Counts only the same run authorization (e.g. 1/run) */
  sameRun?: boolean;
  /** Counts only the same logical delivery (e.g. provider attempts ≤4 per delivery) */
  sameDelivery?: boolean;
  /** Rolling time window: counts only reservedAt >= since */
  since?: Date;
  /** A concurrency slot counts only RESERVED; other values count RESERVED + COMMITTED */
  activeOnly?: boolean;
}

export interface ReserveLineCapInput {
  id: string;
  tenantId: string;
  gateId: string;
  runAuthorizationId: string;
  deliveryId: string;
  capKind: LineCapKind;
  attemptNo?: number;
  recipientFingerprint: string;
  reservedAt: Date;
  limits: LineCapLimit[];
}

export type ReserveLineCapResult =
  | { status: 'RESERVED'; entry: DlLineCapLedgerEntry; replay: boolean }
  | { status: 'DENIED'; code: LineGateErrorCode };

export class LineControlRepository {
  constructor(private readonly database: PrismaClient) {}

  // ── Gate ──────────────────────────────────────────────────────────────────

  /** Create the gate of the scope as DISABLED if it does not exist yet; racing creators always get the same row */
  ensureGate(id: string, scope: LineGateScope): Promise<DlLineScopeGate> {
    return withTenantDatabaseTransaction(this.database, scope.tenantId, async (transaction) => {
      await transaction.dlLineScopeGate.createMany({
        data: [{ id, ...scope }],
        skipDuplicates: true,
      });
      return transaction.dlLineScopeGate.findFirstOrThrow({ where: { ...scope } });
    });
  }

  findGate(scope: LineGateScope): Promise<DlLineScopeGate | null> {
    return withTenantDatabaseTransaction(this.database, scope.tenantId, (transaction) =>
      transaction.dlLineScopeGate.findFirst({ where: { ...scope } }),
    );
  }

  /** CAS on version: returns null if someone changed the gate first — the caller must re-read, never overwrite */
  compareAndSetGate(
    tenantId: string,
    gateId: string,
    expectedVersion: number,
    patch: LineGatePatch,
  ): Promise<DlLineScopeGate | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineScopeGate.updateMany({
        where: { tenantId, id: gateId, version: expectedVersion },
        data: { ...patch, version: { increment: 1 } },
      });
      if (updated.count === 0) return null;
      return transaction.dlLineScopeGate.findFirst({ where: { tenantId, id: gateId } });
    });
  }

  /**
   * kill beats every state and needs no version: the first latch records the reason, later calls are a no-op
   * that returns the already latched gate. The technical switch is always turned off in the same row
   */
  killGate(
    tenantId: string,
    gateId: string,
    reason: DlLineKillReason,
    at: Date,
  ): Promise<DlLineScopeGate> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.dlLineScopeGate.updateMany({
        where: { tenantId, id: gateId, killed: false },
        data: {
          killed: true,
          killReason: reason,
          killedAt: at,
          technicalSwitchOn: false,
          version: { increment: 1 },
        },
      });
      const gate = await transaction.dlLineScopeGate.findFirst({ where: { tenantId, id: gateId } });
      if (!gate) throw new LineBindingRejectedError();
      return gate;
    });
  }

  /** Lifting a kill needs a new approval ref and returns to DISABLED (a trigger enforces it again) */
  clearGateKill(
    tenantId: string,
    gateId: string,
    expectedVersion: number,
    killClearedRef: string,
  ): Promise<DlLineScopeGate | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineScopeGate.updateMany({
        where: { tenantId, id: gateId, version: expectedVersion, killed: true },
        data: {
          killed: false,
          killReason: null,
          killedAt: null,
          killClearedRef,
          businessState: 'DISABLED',
          version: { increment: 1 },
        },
      });
      if (updated.count === 0) return null;
      return transaction.dlLineScopeGate.findFirst({ where: { tenantId, id: gateId } });
    });
  }

  // ── Allowlist ─────────────────────────────────────────────────────────────

  addAllowlistEntry(input: AddLineAllowlistEntryInput): Promise<DlLineAllowlistEntry> {
    return rejectingForeignBinding(() =>
      withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
        transaction.dlLineAllowlistEntry.create({ data: input }),
      ),
    );
  }

  findAllowlistEntry(tenantId: string, id: string): Promise<DlLineAllowlistEntry | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineAllowlistEntry.findFirst({ where: { tenantId, id } }),
    );
  }

  /**
   * exact tuple lookup per the unique index `..._tuple_key` — the caller must know the full recipient/content/config
   * to find the row, so it can serve as the "match on every dimension" of #358 §B without comparing column by column
   */
  findAllowlistEntryByTuple(
    tenantId: string,
    gateId: string,
    recipientFingerprint: string,
    contentDigest: string,
    configDigest: string,
  ): Promise<DlLineAllowlistEntry | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineAllowlistEntry.findFirst({
        where: { tenantId, gateId, recipientFingerprint, contentDigest, configDigest },
      }),
    );
  }

  /** Can be revoked only once; returns false if not found or already revoked */
  revokeAllowlistEntry(tenantId: string, id: string, code: string, at: Date): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineAllowlistEntry.updateMany({
        where: { tenantId, id, revokedAt: null },
        data: { revokedAt: at, revocationCode: code },
      });
      return updated.count === 1;
    });
  }

  // ── Credential reference ──────────────────────────────────────────────────

  registerCredentialRef(input: RegisterLineCredentialRefInput): Promise<DlLineCredentialRef> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      transaction.dlLineCredentialRef.create({
        data: {
          ...input,
          keyId: input.keyId ?? null,
          expiresAt: input.expiresAt ?? null,
          longLivedExceptionRef: input.longLivedExceptionRef ?? null,
        },
      }),
    );
  }

  findCredentialRef(tenantId: string, id: string): Promise<DlLineCredentialRef | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineCredentialRef.findFirst({ where: { tenantId, id } }),
    );
  }

  /**
   * The version that is really ACTIVE for the channel now (the unique index `..._one_active_key` enforces at most
   * one per class) — the caller compares it with the version the run authorization pinned, so that a
   * worker cannot cross the barrier with a token of a different version from the one approved (#358 §G/§I)
   */
  findActiveCredentialRef(
    tenantId: string,
    channelAccountId: string,
    credentialClass: 'ACCESS_TOKEN' | 'CHANNEL_SECRET',
  ): Promise<DlLineCredentialRef | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineCredentialRef.findFirst({
        where: {
          tenantId,
          channelAccountId,
          status: 'ACTIVE',
          credentialKind:
            credentialClass === 'CHANNEL_SECRET'
              ? 'CHANNEL_SECRET'
              : { in: ['CHANNEL_ACCESS_TOKEN_V2_1', 'CHANNEL_ACCESS_TOKEN_LONG_LIVED'] },
        },
      }),
    );
  }

  /**
   * Atomic rotation (#358 §G): retire the ACTIVE version of the same class and activate the
   * candidate in a single transaction — there is no moment where a worker sees two versions or none
   */
  activateCredentialRef(
    tenantId: string,
    id: string,
    verifiedAt: Date,
    at: Date,
  ): Promise<DlLineCredentialRef | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidate = await transaction.dlLineCredentialRef.findFirst({
        where: { tenantId, id, status: 'CANDIDATE' },
      });
      if (!candidate) return null;
      const secretClass = candidate.credentialKind === 'CHANNEL_SECRET';
      await transaction.dlLineCredentialRef.updateMany({
        where: {
          tenantId,
          channelAccountId: candidate.channelAccountId,
          status: 'ACTIVE',
          credentialKind: secretClass
            ? 'CHANNEL_SECRET'
            : { in: ['CHANNEL_ACCESS_TOKEN_V2_1', 'CHANNEL_ACCESS_TOKEN_LONG_LIVED'] },
        },
        data: { status: 'RETIRED', retiredAt: at },
      });
      const activated = await transaction.dlLineCredentialRef.updateMany({
        where: { tenantId, id, status: 'CANDIDATE' },
        data: { status: 'ACTIVE', verifiedAt, activatedAt: at },
      });
      if (activated.count === 0) return null;
      return transaction.dlLineCredentialRef.findFirst({ where: { tenantId, id } });
    });
  }

  revokeCredentialRef(tenantId: string, id: string, at: Date): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineCredentialRef.updateMany({
        where: { tenantId, id, status: { not: 'REVOKED' } },
        data: { status: 'REVOKED', revokedAt: at },
      });
      return updated.count === 1;
    });
  }

  // ── Run authorization ─────────────────────────────────────────────────────

  findRun(tenantId: string, id: string): Promise<DlLineRunAuthorization | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineRunAuthorization.findFirst({ where: { tenantId, id } }),
    );
  }

  /** The same proposal digest returns the original row; the same digest with a different binding is a conflict */
  async proposeRun(input: ProposeLineRunInput): Promise<DlLineRunAuthorization> {
    try {
      return await rejectingForeignBinding(() =>
        withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
          transaction.dlLineRunAuthorization.create({ data: input }),
        ),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await withTenantDatabaseTransaction(
        this.database,
        input.tenantId,
        (transaction) =>
          transaction.dlLineRunAuthorization.findFirst({
            where: { tenantId: input.tenantId, proposalDigest: input.proposalDigest },
          }),
      );
      if (
        existing &&
        existing.gateId === input.gateId &&
        existing.allowlistEntryId === input.allowlistEntryId &&
        existing.credentialRefId === input.credentialRefId &&
        existing.credentialVersion === input.credentialVersion &&
        existing.configDigest === input.configDigest
      ) {
        return existing;
      }
      throw new LineIdempotencyConflictError('dl_line_run_authorizations');
    }
  }

  /**
   * Each role's approval can be added once while PROPOSED; once both roles are in it advances to APPROVED
   * in the same transaction. Returns null if not found/already closed/that role already approved
   */
  approveRun(
    tenantId: string,
    id: string,
    role: LineRunApprovalRole,
    actor: string,
    at: Date,
  ): Promise<DlLineRunAuthorization | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const approval =
        role === 'TENANT_ADMIN'
          ? {
              where: { tenantAdminApprovedBy: null },
              data: { tenantAdminApprovedBy: actor, tenantAdminApprovedAt: at },
            }
          : {
              where: { complianceApprovedBy: null },
              data: { complianceApprovedBy: actor, complianceApprovedAt: at },
            };
      const updated = await transaction.dlLineRunAuthorization.updateMany({
        where: { tenantId, id, state: 'PROPOSED', ...approval.where },
        data: approval.data,
      });
      if (updated.count === 0) return null;
      await transaction.dlLineRunAuthorization.updateMany({
        where: {
          tenantId,
          id,
          state: 'PROPOSED',
          tenantAdminApprovedBy: { not: null },
          complianceApprovedBy: { not: null },
        },
        data: { state: 'APPROVED' },
      });
      return transaction.dlLineRunAuthorization.findFirst({ where: { tenantId, id } });
    });
  }

  /**
   * one-shot: a conditional update from APPROVED, not yet expired, to CONSUMED — two workers
   * racing always yield exactly one winner, and the loser gets a code stating the reason without touching the row
   */
  async consumeRun(
    tenantId: string,
    id: string,
    deliveryId: string,
    at: Date,
  ): Promise<ConsumeLineRunResult> {
    try {
      return await this.consumeRunOnce(tenantId, id, deliveryId, at);
    } catch (error) {
      // This delivery already consumed another authorization — one delivery per run only
      if (isUniqueViolation(error))
        throw new LineIdempotencyConflictError('dl_line_run_authorizations');
      throw error;
    }
  }

  private consumeRunOnce(
    tenantId: string,
    id: string,
    deliveryId: string,
    at: Date,
  ): Promise<ConsumeLineRunResult> {
    return rejectingForeignBinding(() =>
      withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
        const updated = await transaction.dlLineRunAuthorization.updateMany({
          where: { tenantId, id, state: 'APPROVED', expiresAt: { gte: at } },
          data: { state: 'CONSUMED', consumedAt: at, consumedDeliveryId: deliveryId },
        });
        const authorization = await transaction.dlLineRunAuthorization.findFirst({
          where: { tenantId, id },
        });
        if (updated.count === 1 && authorization) return { status: 'CONSUMED', authorization };
        if (
          !authorization ||
          authorization.state === 'PROPOSED' ||
          authorization.state === 'REVOKED'
        ) {
          return { status: 'DENIED', code: 'RUN_AUTHORIZATION_MISSING' };
        }
        if (authorization.state === 'CONSUMED') {
          return { status: 'DENIED', code: 'RUN_AUTHORIZATION_CONSUMED' };
        }
        return { status: 'DENIED', code: 'RUN_AUTHORIZATION_EXPIRED' };
      }),
    );
  }

  /** Close an authorization that has not been used (expired/revoked) — terminal, cannot be edited again */
  closeRun(tenantId: string, id: string, state: 'EXPIRED' | 'REVOKED', at: Date): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineRunAuthorization.updateMany({
        where: { tenantId, id, state: { in: ['PROPOSED', 'APPROVED'] } },
        data: { state, closedAt: at },
      });
      return updated.count === 1;
    });
  }

  // ── Cap ledger ────────────────────────────────────────────────────────────

  /**
   * Reserve one cap unit under the gate's row lock: the kill latch and every limit are checked against the ledger
   * committed within the same transaction as the insert, so two workers cannot pass the same limit
   * The same reservation key (delivery, kind, attempt) is a replay; a different binding is a conflict
   */
  reserveCap(input: ReserveLineCapInput): Promise<ReserveLineCapResult> {
    const attemptNo = input.attemptNo ?? 0;
    return rejectingForeignBinding(() =>
      withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
        const gates = await transaction.$queryRaw<Array<{ killed: boolean }>>(Prisma.sql`
          SELECT killed FROM dl_line_scope_gates
          WHERE tenant_id = ${input.tenantId}::uuid AND id = ${input.gateId}::uuid
          FOR UPDATE
        `);
        const gate = gates[0];
        if (!gate) throw new LineBindingRejectedError();

        const existing = await transaction.dlLineCapLedgerEntry.findFirst({
          where: {
            tenantId: input.tenantId,
            deliveryId: input.deliveryId,
            capKind: input.capKind,
            attemptNo,
          },
        });
        if (existing) {
          if (
            existing.gateId !== input.gateId ||
            existing.runAuthorizationId !== input.runAuthorizationId ||
            existing.recipientFingerprint !== input.recipientFingerprint
          ) {
            throw new LineIdempotencyConflictError('dl_line_cap_ledger');
          }
          return { status: 'RESERVED', entry: existing, replay: true };
        }
        if (gate.killed) return { status: 'DENIED', code: 'LINE_GATE_KILLED' };

        for (const limit of input.limits) {
          const used = await transaction.dlLineCapLedgerEntry.count({
            where: {
              tenantId: input.tenantId,
              gateId: input.gateId,
              capKind: limit.capKind,
              state: limit.activeOnly ? 'RESERVED' : { in: ['RESERVED', 'COMMITTED'] },
              ...(limit.sameRecipient ? { recipientFingerprint: input.recipientFingerprint } : {}),
              ...(limit.sameRun ? { runAuthorizationId: input.runAuthorizationId } : {}),
              ...(limit.sameDelivery ? { deliveryId: input.deliveryId } : {}),
              ...(limit.since ? { reservedAt: { gte: limit.since } } : {}),
            },
          });
          if (used >= limit.max) return { status: 'DENIED', code: limit.code };
        }

        const entry = await transaction.dlLineCapLedgerEntry.create({
          data: {
            id: input.id,
            tenantId: input.tenantId,
            gateId: input.gateId,
            runAuthorizationId: input.runAuthorizationId,
            deliveryId: input.deliveryId,
            capKind: input.capKind,
            attemptNo,
            recipientFingerprint: input.recipientFingerprint,
            reservedAt: input.reservedAt,
          },
        });
        return { status: 'RESERVED', entry, replay: false };
      }),
    );
  }

  /** Reservations still holding a slot of this scope — used to decide auto-pause of unknown (#358 §C) */
  listActiveCapEntries(
    tenantId: string,
    gateId: string,
    capKind: LineCapKind,
  ): Promise<DlLineCapLedgerEntry[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineCapLedgerEntry.findMany({
        where: { tenantId, gateId, capKind, state: 'RESERVED' },
        orderBy: [{ reservedAt: 'asc' }, { id: 'asc' }],
      }),
    );
  }

  /** RESERVED -> COMMITTED (crossed the barrier) or RELEASED (before the barrier/slot free) exactly once */
  settleCap(
    tenantId: string,
    deliveryId: string,
    capKind: LineCapKind,
    attemptNo: number,
    state: 'COMMITTED' | 'RELEASED',
    at: Date,
  ): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineCapLedgerEntry.updateMany({
        where: { tenantId, deliveryId, capKind, attemptNo, state: 'RESERVED' },
        data: { state, settledAt: at },
      });
      return updated.count === 1;
    });
  }
}
