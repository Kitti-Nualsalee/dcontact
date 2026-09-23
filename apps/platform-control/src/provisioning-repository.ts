/**
 * Owner: Platform control plane — durable intent ของ tenant provisioning (A1.1 #406)
 *
 * Authority: #389 (lifecycle/identity/reservation), #390 (durable-intent-first, ledger, idempotency),
 * #393 §5 (append-only Action history), decision บน #406
 *
 * ต่อฐานข้อมูลด้วย role `dcontact_platform` เท่านั้น — role นี้ไม่มีสิทธิ์บน tenant business tables
 * กติกาหลักอยู่ที่ database (unique/composite FK/trigger) เพื่อให้ race ตัดสินที่เดียว ส่วน repository
 * แปลงผลเป็น error code ที่คงที่ และไม่เผยว่า resource ของ tenant/request อื่นมีอยู่จริง
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  IDENTITY_TOMBSTONE_DAYS,
  PROVISIONING_SAGA_LIMITS,
  PROVISIONING_STEP_KEYS,
  PlatformProvisioningError,
  isAllowedProvisioningTransition,
  type IdentityReservationKind,
  type PlatformActionKind,
  type PlatformActorKind,
  type PlatformProvisioningErrorCode,
  type ProvisioningRequestInput,
  type ProvisioningRequestStatus,
  type ProvisioningStepKey,
} from '@d-contact/shared';
import {
  canonicalizeProvisioningRequest,
  deriveTenantSipDomain,
  platformIdentityHash,
  provisioningPayloadDigest,
} from './provisioning-input.js';

export interface PlatformActor {
  kind: PlatformActorKind;
  /** subject ของ platform identity (ไม่ใช่ email) */
  subject: string;
  role?: string;
  sessionRef?: string;
}

export interface AcceptProvisioningCommand {
  idempotencyKey: string;
  input: ProvisioningRequestInput;
  /** plan ที่ caller resolve และ pin จาก plan catalog แล้ว (#392) — retry ใช้ค่าเดิมเสมอ */
  plan: { version: number; snapshotDigest: string };
  actor: PlatformActor;
  correlationId: string;
}

export interface ProvisioningRequestRef {
  outcome: 'ACCEPTED' | 'REPLAYED';
  requestId: string;
  tenantId: string;
  status: ProvisioningRequestStatus;
  revision: number;
}

/** รูปที่ control plane อ่านได้ — ไม่มี raw email ของ first admin (มีแค่ hash) */
export interface ProvisioningRequestView {
  requestId: string;
  tenantId: string;
  status: ProvisioningRequestStatus;
  revision: number;
  displayName: string;
  slug: string;
  primaryDomain: string;
  sipDomain: string;
  planCode: string;
  planVersion: number;
  bootstrapTemplateVersion: string;
  firstAdminEmailHash: string;
  failureCode: string | null;
  acceptedAt: Date;
  deadlineAt: Date;
  terminalAt: Date | null;
  steps: Array<{ stepKey: ProvisioningStepKey; state: string; attempt: number }>;
}

export interface ActionHistoryEntry {
  id: string;
  action: PlatformActionKind;
  actorKind: PlatformActorKind;
  actorSubject: string;
  reasonCode: string | null;
  beforeState: string | null;
  afterState: string | null;
  outcome: string;
  errorCode: string | null;
  stepKey: ProvisioningStepKey | null;
  attempt: number | null;
  correlationId: string;
  occurredAt: Date;
}

export interface ProvisioningRepositoryOptions {
  /** base domain ของ SIP (decision บน #406): sipDomain = `<slug>.<base>` */
  sipBaseDomain: string;
  now?: () => Date;
  id?: () => string;
}

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CREATE_COMMAND = 'CREATE_PROVISIONING_REQUEST';
const HEX64 = /^[0-9a-f]{64}$/;

/** placeholder ของ tenant ที่ยัง PROVISIONING — `~` ทำให้ชนกับ slug จริงไม่ได้ (ดู migration) */
export function provisioningPlaceholder(tenantId: string) {
  return { slug: `~pv-${tenantId}`, sipDomain: `~pv-${tenantId}.invalid` };
}

class ConflictSignal extends Error {
  constructor(readonly code: PlatformProvisioningErrorCode) {
    super(code);
  }
}

const isUniqueViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';

const isForeignKeyViolation = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003';

export class ProvisioningControlRepository {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly options: ProvisioningRepositoryOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  // ── Accept (durable intent, #390 step 1) ──────────────────────────────────

  /**
   * transaction เดียวสร้าง Tenant(PROVISIONING) + request + step ledger + reservations + receipt +
   * Action history แล้วคืน `requestId/tenantId` ที่ immutable; key/payload เดิมคืนผลเดิม (REPLAYED)
   */
  async accept(command: AcceptProvisioningCommand): Promise<ProvisioningRequestRef> {
    if (!IDEMPOTENCY_KEY.test(command.idempotencyKey)) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', { idempotencyKey: 'INVALID' });
    }
    if (
      !Number.isInteger(command.plan.version) ||
      command.plan.version < 1 ||
      !HEX64.test(command.plan.snapshotDigest)
    ) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', { plan: 'INVALID' });
    }
    const canonical = canonicalizeProvisioningRequest(command.input);
    const payloadDigest = provisioningPayloadDigest(canonical);
    const keyHash = platformIdentityHash('idempotency-key', command.idempotencyKey);

    const replay = await this.replay(keyHash, payloadDigest, command);
    if (replay) return replay;

    const sipDomain = deriveTenantSipDomain(canonical.slug, this.options.sipBaseDomain);
    const emailHash = platformIdentityHash('first-admin-email', canonical.firstAdminEmail);
    const tenantId = this.id();
    const requestId = this.id();
    const now = this.now();
    try {
      await this.database.$transaction(async (transaction) => {
        const template = await transaction.pfBootstrapTemplate.findUnique({
          where: { version: canonical.bootstrapTemplateVersion },
        });
        if (!template || template.status !== 'ACTIVE') {
          throw new PlatformProvisioningError('BOOTSTRAP_TEMPLATE_UNAVAILABLE');
        }
        // tenant ที่ ACTIVE/legacy ถือ slug/domain จริงใน tenants — ตรวจก่อน (unique ตอน activate เป็นด่านสุดท้าย)
        const taken = await transaction.tenant.findFirst({
          where: {
            OR: [
              { slug: canonical.slug },
              { sipDomain },
              { primaryDomain: canonical.primaryDomain },
            ],
          },
          select: { slug: true, sipDomain: true },
        });
        if (taken) {
          throw new ConflictSignal(
            taken.slug === canonical.slug || taken.sipDomain === sipDomain
              ? 'TENANT_SLUG_CONFLICT'
              : 'TENANT_DOMAIN_CONFLICT',
          );
        }

        const placeholder = provisioningPlaceholder(tenantId);
        await transaction.tenant.create({
          data: {
            id: tenantId,
            name: canonical.displayName,
            slug: placeholder.slug,
            sipDomain: placeholder.sipDomain,
            lifecycleStatus: 'PROVISIONING',
          },
        });
        await transaction.pfProvisioningRequest.create({
          data: {
            id: requestId,
            tenantId,
            idempotencyKeyHash: keyHash,
            payloadDigest,
            displayName: canonical.displayName,
            slug: canonical.slug,
            primaryDomain: canonical.primaryDomain,
            sipDomain,
            locale: canonical.locale,
            timezone: canonical.timezone,
            planCode: canonical.planCode,
            planVersion: command.plan.version,
            planSnapshotDigest: command.plan.snapshotDigest,
            bootstrapTemplateVersion: template.version,
            bootstrapTemplateDigest: template.contentDigest,
            firstAdminEmail: canonical.firstAdminEmail,
            firstAdminEmailHash: emailHash,
            firstAdminDisplayName: canonical.firstAdminDisplayName,
            requestedBy: command.actor.subject,
            correlationId: command.correlationId,
            acceptedAt: now,
            deadlineAt: new Date(
              now.getTime() + PROVISIONING_SAGA_LIMITS.requestDeadlineMinutes * 60_000,
            ),
          },
        });
        // TENANT_RECORD สำเร็จในตัว transaction นี้เอง; step อื่นรอ worker (A1.3)
        await transaction.pfProvisioningStep.createMany({
          data: PROVISIONING_STEP_KEYS.map((stepKey, index) => ({
            requestId,
            tenantId,
            stepKey,
            ordinal: index + 1,
            ...(stepKey === 'TENANT_RECORD'
              ? { state: 'SUCCEEDED' as const, attempt: 1, startedAt: now, finishedAt: now }
              : {}),
          })),
        });
        await transaction.pfProvisioningStepReceipt.create({
          data: {
            id: this.id(),
            requestId,
            tenantId,
            stepKey: 'TENANT_RECORD',
            attempt: 1,
            outcome: 'SUCCEEDED',
            recordedAt: now,
          },
        });
        for (const [kind, valueKey, code] of [
          ['SLUG', canonical.slug, 'TENANT_SLUG_CONFLICT'],
          ['PRIMARY_DOMAIN', canonical.primaryDomain, 'TENANT_DOMAIN_CONFLICT'],
          ['FIRST_ADMIN_EMAIL', emailHash, 'FIRST_ADMIN_EMAIL_CONFLICT'],
        ] as const) {
          await this.reserve(transaction, { kind, valueKey, tenantId, requestId }, code);
        }
        await transaction.pfCommandReceipt.create({
          data: {
            id: this.id(),
            idempotencyKeyHash: keyHash,
            commandKind: CREATE_COMMAND,
            payloadDigest,
            requestId,
            tenantId,
            actorSubject: command.actor.subject,
          },
        });
        await this.appendAction(transaction, {
          tenantId,
          requestId,
          action: 'REQUEST_ACCEPTED',
          actor: command.actor,
          correlationId: command.correlationId,
          idempotencyKeyHash: keyHash,
          afterState: 'PENDING',
          outcome: 'SUCCEEDED',
          at: now,
        });
      });
    } catch (error) {
      // ผู้แพ้ race ของ key เดียวกันชน unique ก่อนเสมอ — ตรวจ replay ก่อนรายงาน conflict อื่น
      if (error instanceof ConflictSignal || isUniqueViolation(error)) {
        const raced = await this.replay(keyHash, payloadDigest, command);
        if (raced) return raced;
        if (error instanceof ConflictSignal) throw new PlatformProvisioningError(error.code);
        throw new PlatformProvisioningError(uniqueConflictCode(error));
      }
      throw error;
    }
    return { outcome: 'ACCEPTED', requestId, tenantId, status: 'PENDING', revision: 1 };
  }

  /**
   * reservation ของค่าหนึ่ง: รับช่วงแถวที่ tombstone หมดอายุแล้ว (เทียบกับนาฬิกาของ DB) หรือสร้างใหม่
   * แถวที่ยัง HELD/CONSUMED/tombstone ไม่หมดอายุ = ชน PK → conflict; row lock ทำให้ผู้ชนะมีคนเดียว
   */
  private async reserve(
    transaction: Prisma.TransactionClient,
    input: { kind: IdentityReservationKind; valueKey: string; tenantId: string; requestId: string },
    conflict: PlatformProvisioningErrorCode,
  ): Promise<void> {
    const takenOver = await transaction.$executeRaw`
      UPDATE "pf_identity_reservations"
         SET "tenant_id" = ${input.tenantId}::uuid,
             "request_id" = ${input.requestId}::uuid,
             "state" = 'HELD',
             "tombstoned_until" = NULL,
             "revision" = "revision" + 1,
             "updated_at" = now()
       WHERE "kind" = ${input.kind}::"PfReservationKind"
         AND "value_key" = ${input.valueKey}
         AND "state" = 'TOMBSTONED'
         AND "tombstoned_until" <= now()`;
    if (takenOver === 1) return;
    try {
      await transaction.pfIdentityReservation.create({ data: input });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ConflictSignal(conflict);
      throw error;
    }
  }

  private async replay(
    keyHash: string,
    payloadDigest: string,
    command: AcceptProvisioningCommand,
  ): Promise<ProvisioningRequestRef | null> {
    const receipt = await this.database.pfCommandReceipt.findUnique({
      where: { idempotencyKeyHash: keyHash },
      include: { request: { select: { status: true, revision: true } } },
    });
    if (!receipt) return null;
    if (receipt.commandKind !== CREATE_COMMAND || receipt.payloadDigest !== payloadDigest) {
      throw new PlatformProvisioningError('IDEMPOTENCY_KEY_REUSED');
    }
    // replay ไม่สร้าง state transition ซ้ำ แต่บันทึกว่าเกิด replay (#393 §5)
    await this.appendAction(this.database, {
      tenantId: receipt.tenantId,
      requestId: receipt.requestId,
      action: 'COMMAND_REPLAYED',
      actor: command.actor,
      correlationId: command.correlationId,
      idempotencyKeyHash: keyHash,
      outcome: 'REPLAYED',
      at: this.now(),
    });
    return {
      outcome: 'REPLAYED',
      requestId: receipt.requestId,
      tenantId: receipt.tenantId,
      status: receipt.request.status,
      revision: receipt.request.revision,
    };
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * อ่านด้วย requestId ที่ authoritative; ถ้าระบุ tenantId แล้วไม่ตรงคืน `null` เหมือนไม่มี —
   * ไม่เผยว่า request ของ tenant อื่นมีอยู่ (#388 generic 404)
   */
  async findRequest(input: {
    requestId: string;
    tenantId?: string;
  }): Promise<ProvisioningRequestView | null> {
    if (!isUuid(input.requestId) || (input.tenantId !== undefined && !isUuid(input.tenantId))) {
      return null;
    }
    const request = await this.database.pfProvisioningRequest.findFirst({
      where: { id: input.requestId, ...(input.tenantId ? { tenantId: input.tenantId } : {}) },
      include: { steps: { orderBy: { ordinal: 'asc' } } },
    });
    if (!request) return null;
    return {
      requestId: request.id,
      tenantId: request.tenantId,
      status: request.status,
      revision: request.revision,
      displayName: request.displayName,
      slug: request.slug,
      primaryDomain: request.primaryDomain,
      sipDomain: request.sipDomain,
      planCode: request.planCode,
      planVersion: request.planVersion,
      bootstrapTemplateVersion: request.bootstrapTemplateVersion,
      firstAdminEmailHash: request.firstAdminEmailHash,
      failureCode: request.failureCode,
      acceptedAt: request.acceptedAt,
      deadlineAt: request.deadlineAt,
      terminalAt: request.terminalAt,
      steps: request.steps.map((step) => ({
        stepKey: step.stepKey,
        state: step.state,
        attempt: step.attempt,
      })),
    };
  }

  /** timeline ใหม่สุดก่อน แบบ cursor (occurredAt + id) — projection ของ ledger เดียวกับที่ UI ใช้ */
  async listActionHistory(input: {
    tenantId: string;
    cursor?: { occurredAt: Date; id: string };
    limit?: number;
  }): Promise<ActionHistoryEntry[]> {
    if (!isUuid(input.tenantId)) return [];
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const rows = await this.database.pfActionHistory.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.cursor
          ? {
              OR: [
                { occurredAt: { lt: input.cursor.occurredAt } },
                { occurredAt: input.cursor.occurredAt, id: { lt: input.cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorKind: row.actorKind,
      actorSubject: row.actorSubject,
      reasonCode: row.reasonCode,
      beforeState: row.beforeState,
      afterState: row.afterState,
      outcome: row.outcome,
      errorCode: row.errorCode,
      stepKey: row.stepKey,
      attempt: row.attempt,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt,
    }));
  }

  // ── Transition (CAS) ──────────────────────────────────────────────────────

  /**
   * เปลี่ยนสถานะด้วย `expectedRevision`: ตาราง transition เดียวกับ trigger ของ DB; terminal ที่ล้ม/ยกเลิก
   * ปล่อย reservation เป็น tombstone 30 วันใน transaction เดียวกัน — SUCCEEDED ต้องใช้ `complete`
   */
  async transition(input: {
    requestId: string;
    expectedRevision: number;
    to: Exclude<ProvisioningRequestStatus, 'SUCCEEDED' | 'PENDING'>;
    actor: PlatformActor;
    correlationId: string;
    reasonCode?: string;
    comment?: string;
    failureCode?: string;
  }): Promise<{ status: ProvisioningRequestStatus; revision: number }> {
    const request = await this.requireRequest(input.requestId);
    if (request.revision !== input.expectedRevision) {
      throw new PlatformProvisioningError('REVISION_CONFLICT');
    }
    if (!isAllowedProvisioningTransition(request.status, input.to)) {
      throw new PlatformProvisioningError('INVALID_STATE_TRANSITION');
    }
    const now = this.now();
    const terminal = input.to === 'FAILED_FINAL' || input.to === 'CANCELLED';
    await this.database.$transaction(async (transaction) => {
      const updated = await transaction.pfProvisioningRequest.updateMany({
        where: { id: request.id, revision: input.expectedRevision, status: request.status },
        data: {
          status: input.to,
          revision: { increment: 1 },
          ...(terminal ? { terminalAt: now } : {}),
          ...(input.failureCode ? { failureCode: input.failureCode } : {}),
        },
      });
      if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
      await this.appendAction(transaction, {
        tenantId: request.tenantId,
        requestId: request.id,
        action:
          input.to === 'CANCELLED'
            ? 'CANCEL'
            : input.to === 'FAILED_FINAL'
              ? 'MARK_FAILED_FINAL'
              : 'STATE_CHANGED',
        actor: input.actor,
        correlationId: input.correlationId,
        beforeState: request.status,
        afterState: input.to,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
        outcome: 'SUCCEEDED',
        at: now,
      });
      if (terminal) {
        const tombstoned = await transaction.pfIdentityReservation.updateMany({
          where: { requestId: request.id, state: 'HELD' },
          data: {
            state: 'TOMBSTONED',
            tombstonedUntil: new Date(now.getTime() + IDENTITY_TOMBSTONE_DAYS * 86_400_000),
            revision: { increment: 1 },
          },
        });
        if (tombstoned.count > 0) {
          await this.appendAction(transaction, {
            tenantId: request.tenantId,
            requestId: request.id,
            action: 'RESERVATION_TOMBSTONED',
            actor: { kind: 'SYSTEM', subject: 'platform-control' },
            correlationId: input.correlationId,
            outcome: 'SUCCEEDED',
            at: now,
          });
        }
      }
    });
    return { status: input.to, revision: input.expectedRevision + 1 };
  }

  /**
   * completion invariant (#390): request SUCCEEDED + tenant ACTIVE + reservation CONSUMED ใน transaction
   * เดียว — DB ปฏิเสธถ้า step ยังไม่ครบ หรือ slug/domain ที่ตั้งให้ tenant ไม่ตรง request
   */
  async complete(input: {
    requestId: string;
    expectedRevision: number;
    actor: PlatformActor;
    correlationId: string;
  }): Promise<{ status: 'SUCCEEDED'; revision: number }> {
    const request = await this.requireRequest(input.requestId);
    if (request.revision !== input.expectedRevision) {
      throw new PlatformProvisioningError('REVISION_CONFLICT');
    }
    if (!isAllowedProvisioningTransition(request.status, 'SUCCEEDED')) {
      throw new PlatformProvisioningError('INVALID_STATE_TRANSITION');
    }
    const now = this.now();
    try {
      await this.database.$transaction(async (transaction) => {
        const updated = await transaction.pfProvisioningRequest.updateMany({
          where: { id: request.id, revision: input.expectedRevision, status: request.status },
          data: { status: 'SUCCEEDED', revision: { increment: 1 }, terminalAt: now },
        });
        if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
        await transaction.tenant.update({
          where: { id: request.tenantId },
          data: {
            lifecycleStatus: 'ACTIVE',
            slug: request.slug,
            sipDomain: request.sipDomain,
            primaryDomain: request.primaryDomain,
          },
        });
        await transaction.pfIdentityReservation.updateMany({
          where: { requestId: request.id, state: 'HELD' },
          data: { state: 'CONSUMED', revision: { increment: 1 } },
        });
        await this.appendAction(transaction, {
          tenantId: request.tenantId,
          requestId: request.id,
          action: 'STATE_CHANGED',
          actor: input.actor,
          correlationId: input.correlationId,
          beforeState: request.status,
          afterState: 'SUCCEEDED',
          outcome: 'SUCCEEDED',
          at: now,
        });
      });
    } catch (error) {
      if (error instanceof PlatformProvisioningError) throw error;
      // step ไม่ครบ/binding ไม่ตรงคือ transition ที่ไม่อนุญาต ไม่ใช่ error ของระบบ
      if (error instanceof Error && /PF_REQUEST_INCOMPLETE|TENANT_/.test(error.message)) {
        throw new PlatformProvisioningError('INVALID_STATE_TRANSITION');
      }
      if (isUniqueViolation(error)) throw new PlatformProvisioningError(uniqueConflictCode(error));
      throw error;
    }
    return { status: 'SUCCEEDED', revision: input.expectedRevision + 1 };
  }

  // ── Step receipts ─────────────────────────────────────────────────────────

  /**
   * บันทึกผลของ step: head + append-only receipt + Action history ในที่เดียว; binding
   * `(tenantId, requestId)` ต้องตรงกัน (composite FK) ไม่ตรง = NOT_FOUND แบบ generic
   * receipt ของ attempt เดิมที่ SUCCEEDED แล้ว replay ได้เป็น no-op
   */
  async recordStepOutcome(input: {
    tenantId: string;
    requestId: string;
    stepKey: Exclude<ProvisioningStepKey, 'TENANT_RECORD'>;
    attempt: number;
    outcome: 'SUCCEEDED' | 'ACTION_REQUIRED';
    inputDigest?: string;
    outputDigest?: string;
    externalRef?: string;
    errorCode?: string;
    actor: PlatformActor;
    correlationId: string;
  }): Promise<{ replayed: boolean }> {
    if (!isUuid(input.tenantId) || !isUuid(input.requestId)) {
      throw new PlatformProvisioningError('NOT_FOUND');
    }
    const now = this.now();
    const externalRefHash = input.externalRef
      ? platformIdentityHash('external-ref', input.externalRef)
      : undefined;
    try {
      return await this.database.$transaction(async (transaction) => {
        const step = await transaction.pfProvisioningStep.findFirst({
          where: { requestId: input.requestId, tenantId: input.tenantId, stepKey: input.stepKey },
        });
        if (!step) throw new PlatformProvisioningError('NOT_FOUND');
        if (step.state === 'SUCCEEDED') {
          const receipt = await transaction.pfProvisioningStepReceipt.findFirst({
            where: { requestId: input.requestId, stepKey: input.stepKey, outcome: 'SUCCEEDED' },
          });
          if (receipt?.attempt === input.attempt) return { replayed: true };
          throw new PlatformProvisioningError('INVALID_STATE_TRANSITION');
        }
        await transaction.pfProvisioningStepReceipt.create({
          data: {
            id: this.id(),
            requestId: input.requestId,
            tenantId: input.tenantId,
            stepKey: input.stepKey,
            attempt: input.attempt,
            outcome: input.outcome,
            ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
            ...(input.outputDigest ? { outputDigest: input.outputDigest } : {}),
            ...(externalRefHash ? { externalRefHash } : {}),
            ...(input.errorCode ? { errorCode: input.errorCode } : {}),
            recordedAt: now,
          },
        });
        const updated = await transaction.pfProvisioningStep.updateMany({
          where: { requestId: input.requestId, stepKey: input.stepKey, revision: step.revision },
          data: {
            state: input.outcome,
            attempt: input.attempt,
            revision: { increment: 1 },
            startedAt: step.startedAt ?? now,
            ...(input.outcome === 'SUCCEEDED' ? { finishedAt: now } : {}),
            ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
            ...(input.outputDigest ? { outputDigest: input.outputDigest } : {}),
            ...(input.externalRef ? { externalRef: input.externalRef } : {}),
            errorCode: input.errorCode ?? null,
          },
        });
        if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
        await this.appendAction(transaction, {
          tenantId: input.tenantId,
          requestId: input.requestId,
          action: input.outcome === 'SUCCEEDED' ? 'STEP_SUCCEEDED' : 'STEP_ACTION_REQUIRED',
          actor: input.actor,
          correlationId: input.correlationId,
          stepKey: input.stepKey,
          attempt: input.attempt,
          ...(input.inputDigest ? { inputDigest: input.inputDigest } : {}),
          ...(input.outputDigest ? { outputDigest: input.outputDigest } : {}),
          ...(externalRefHash ? { externalRefHash } : {}),
          ...(input.errorCode ? { errorCode: input.errorCode } : {}),
          outcome: 'SUCCEEDED',
          at: now,
        });
        return { replayed: false };
      });
    } catch (error) {
      if (error instanceof PlatformProvisioningError) throw error;
      if (isForeignKeyViolation(error)) throw new PlatformProvisioningError('NOT_FOUND');
      if (isUniqueViolation(error)) throw new PlatformProvisioningError('REVISION_CONFLICT');
      throw error;
    }
  }

  // ── Support ───────────────────────────────────────────────────────────────

  private async requireRequest(requestId: string) {
    if (!isUuid(requestId)) throw new PlatformProvisioningError('NOT_FOUND');
    const request = await this.database.pfProvisioningRequest.findUnique({
      where: { id: requestId },
    });
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');
    return request;
  }

  private appendAction(
    client: Prisma.TransactionClient | PrismaClient,
    entry: {
      tenantId: string;
      requestId: string;
      action: PlatformActionKind;
      actor: PlatformActor;
      correlationId: string;
      outcome: 'SUCCEEDED' | 'REJECTED' | 'REPLAYED';
      at: Date;
      idempotencyKeyHash?: string;
      beforeState?: string;
      afterState?: string;
      reasonCode?: string;
      comment?: string;
      errorCode?: string;
      stepKey?: ProvisioningStepKey;
      attempt?: number;
      inputDigest?: string;
      outputDigest?: string;
      externalRefHash?: string;
    },
  ) {
    return client.pfActionHistory.create({
      data: {
        id: this.id(),
        tenantId: entry.tenantId,
        requestId: entry.requestId,
        action: entry.action,
        actorKind: entry.actor.kind,
        actorSubject: entry.actor.subject,
        ...(entry.actor.role ? { actorRole: entry.actor.role } : {}),
        ...(entry.actor.sessionRef ? { sessionRef: entry.actor.sessionRef } : {}),
        correlationId: entry.correlationId,
        ...(entry.idempotencyKeyHash ? { idempotencyKeyHash: entry.idempotencyKeyHash } : {}),
        ...(entry.beforeState ? { beforeState: entry.beforeState } : {}),
        ...(entry.afterState ? { afterState: entry.afterState } : {}),
        ...(entry.reasonCode ? { reasonCode: entry.reasonCode } : {}),
        ...(entry.comment ? { comment: entry.comment } : {}),
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        ...(entry.stepKey ? { stepKey: entry.stepKey } : {}),
        ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
        ...(entry.inputDigest ? { inputDigest: entry.inputDigest } : {}),
        ...(entry.outputDigest ? { outputDigest: entry.outputDigest } : {}),
        ...(entry.externalRefHash ? { externalRefHash: entry.externalRefHash } : {}),
        outcome: entry.outcome,
        occurredAt: entry.at,
      },
    });
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** unique ของ tenants ตอน activate/race — แยก domain ออกจาก slug/sipDomain ตามชื่อ field */
function uniqueConflictCode(error: unknown): PlatformProvisioningErrorCode {
  const target =
    error instanceof Prisma.PrismaClientKnownRequestError ? error.meta?.target : undefined;
  const fields = Array.isArray(target) ? target.map(String) : [String(target ?? '')];
  if (fields.some((field) => field.includes('primary_domain') || field.includes('primaryDomain'))) {
    return 'TENANT_DOMAIN_CONFLICT';
  }
  if (fields.some((field) => field.includes('idempotency'))) return 'IDEMPOTENCY_KEY_REUSED';
  return 'TENANT_SLUG_CONFLICT';
}
