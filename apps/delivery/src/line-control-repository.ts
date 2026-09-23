/**
 * Owner: Delivery/Channels — durable primitives ของ LINE rollout control plane (S2.1 #365)
 *
 * gate/allowlist/credential ref/run authorization/cap ledger ตาม #358 — ที่นี่มีแค่ primitive
 * ที่ atomic และ tenant-isolated; policy (ใครสั่งอะไรได้, effective gate, ค่า cap จริง) เป็นของ
 * S2.3 ที่เรียก primitive เหล่านี้ DB ยังตรวจ invariant ซ้ำด้วย CHECK/trigger เสมอ
 *
 * ความ race-safe มาจากสามกลไกเท่านั้น: conditional update (CAS/one-shot), unique index และ
 * row lock ของ gate (`FOR UPDATE`) ที่ serialize การนับ cap ต่อ scope — ไม่มี counter ใน memory
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
  /** นับเฉพาะ recipient เดียวกัน (เช่น 1/recipient/24h) */
  sameRecipient?: boolean;
  /** นับเฉพาะ run authorization เดียวกัน (เช่น 1/run) */
  sameRun?: boolean;
  /** นับเฉพาะ logical delivery เดียวกัน (เช่น provider attempts ≤4 ต่อหนึ่ง delivery) */
  sameDelivery?: boolean;
  /** หน้าต่างเวลาแบบ rolling: นับเฉพาะ reservedAt >= since */
  since?: Date;
  /** concurrency slot นับเฉพาะ RESERVED; ค่าอื่นนับ RESERVED + COMMITTED */
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

  /** สร้าง gate ของ scope เป็น DISABLED ถ้ายังไม่มี; ผู้แข่งกันสร้างได้แถวเดียวกันเสมอ */
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

  /** CAS บน version: คืน null ถ้ามีคนเปลี่ยน gate ไปก่อน — ผู้เรียกต้องอ่านใหม่ ห้ามเขียนทับ */
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
   * kill ชนะทุก state และไม่ต้องรู้ version: latch ครั้งแรกบันทึกเหตุผล ครั้งต่อไปเป็น no-op
   * ที่คืน gate ซึ่ง latch อยู่แล้ว technical switch ถูกปิดในแถวเดียวกันเสมอ
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

  /** ยก kill ต้องมี approval ref ใหม่และกลับไป DISABLED (trigger บังคับซ้ำ) */
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
   * exact tuple lookup ตาม unique index `..._tuple_key` — ผู้เรียกต้องรู้ recipient/content/config
   * ครบถึงจะเจอแถว จึงใช้เป็น "ตรงทุกมิติ" ของ #358 §B ได้โดยไม่ต้องไล่เทียบทีละคอลัมน์
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

  /** revoke ได้ครั้งเดียว; คืน false ถ้าไม่พบหรือ revoke ไปแล้ว */
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
   * version ที่ ACTIVE อยู่จริงของ channel ตอนนี้ (unique index `..._one_active_key` บังคับว่ามีได้
   * ตัวเดียวต่อ class) — ผู้เรียกใช้เทียบกับ version ที่ run authorization pin ไว้ เพื่อไม่ให้
   * worker ข้าม barrier ด้วย token คนละ version กับที่อนุมัติ (#358 §G/§I)
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
   * rotation แบบ atomic (#358 §G): retire version ที่ ACTIVE อยู่ของ class เดียวกันแล้ว activate
   * candidate ใน transaction เดียว — ไม่มีจังหวะที่ worker เห็นสอง version หรือไม่เห็นเลย
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

  /** proposal digest เดิมคืนแถวเดิม; digest เดิมที่ binding ต่างเป็น conflict */
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
   * approval แต่ละ role ใส่ได้ครั้งเดียวขณะ PROPOSED; ครบทั้งสอง role แล้วเลื่อนเป็น APPROVED
   * ใน transaction เดียวกัน คืน null ถ้าไม่พบ/ปิดแล้ว/role นั้นอนุมัติไปแล้ว
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
   * one-shot: conditional update จาก APPROVED ที่ยังไม่หมดอายุไปเป็น CONSUMED — worker สองตัว
   * แข่งกันได้ผู้ชนะหนึ่งตัวเสมอ ผู้แพ้ได้ code ที่บอกเหตุผลโดยไม่แตะแถว
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
      // delivery นี้ consume authorization ใบอื่นไปแล้ว — หนึ่ง delivery ต่อหนึ่ง run เท่านั้น
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

  /** ปิด authorization ที่ยังไม่ถูกใช้ (หมดอายุ/เพิกถอน) — terminal แล้วแก้ไม่ได้อีก */
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
   * จอง cap หนึ่งหน่วยภายใต้ row lock ของ gate: kill latch และทุก limit ถูกตรวจกับ ledger
   * ที่ commit แล้วใน transaction เดียวกับ insert จึงไม่มี worker สองตัวผ่าน limit เดียวกันได้
   * reservation key เดิม (delivery, kind, attempt) เป็น replay; binding ต่างเป็น conflict
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

  /** reservation ที่ยังถือ slot อยู่ของ scope นี้ — ใช้ตัดสิน auto-pause ของ unknown (#358 §C) */
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

  /** RESERVED -> COMMITTED (ข้าม barrier แล้ว) หรือ RELEASED (ก่อน barrier/slot ว่าง) ครั้งเดียว */
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
