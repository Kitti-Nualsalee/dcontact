/**
 * Owner: Platform control plane — recovery commands ของ operator เมื่อ request `ACTION_REQUIRED`
 * (A1.3 #408, #390 Operator recovery controls, #388 preview/previewDigest/reason)
 *
 * ทุก action:
 * - ทำได้กับ step ปัจจุบันเท่านั้น (step แรกที่ยังไม่ SUCCEEDED) — ห้ามข้าม failed/current step
 * - ต้อง preview ก่อน; execute ส่ง `previewDigest` ที่ผูก action/revision/step/attempt/ผลของ `find`
 *   ถ้าสถานะเปลี่ยนระหว่างนั้น = `PREVIEW_STALE` ต้อง preview ใหม่
 * - ต้องมี `expectedRevision`, `reasonCode` และ `comment`; ผลทุกแบบ (รวมที่ถูกปฏิเสธ) ลง Action history
 * - ไม่มี destructive compensation เป็นค่าเริ่มต้น: Safe compensate ได้เฉพาะ resource ที่ `find`
 *   พิสูจน์ correlation แล้วและ port รองรับเท่านั้น
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@d-contact/db';
import {
  PROVISIONING_SAGA_LIMITS,
  PlatformProvisioningError,
  type ProvisioningRecoveryAction,
  type ProvisioningStepKey,
} from '@d-contact/shared';
import { appendPlatformAction } from './action-history.js';
import { platformIdentityHash } from './provisioning-input.js';
import { ProvisioningControlRepository, type PlatformActor } from './provisioning-repository.js';
import {
  currentStep,
  provisioningStepContext,
  type ExternalProvisioningStepKey,
  type ProvisioningAdoption,
  type ProvisioningStepPorts,
} from './provisioning-saga.js';

export interface RecoveryPreview {
  action: ProvisioningRecoveryAction;
  requestId: string;
  tenantId: string;
  revision: number;
  stepKey: ProvisioningStepKey | null;
  attempt: number | null;
  /** ผลของ `find` ณ เวลานี้ (ไม่มีสำหรับ MARK_FAILED_FINAL) */
  finding: ProvisioningAdoption['status'] | null;
  allowed: boolean;
  /** เหตุผลที่ทำไม่ได้แบบ machine code — แสดงใน UI ก่อน operator ยืนยัน */
  blockedBy: string | null;
  previewDigest: string;
}

export interface RecoveryCommand {
  requestId: string;
  action: ProvisioningRecoveryAction;
  expectedRevision: number;
  previewDigest: string;
  reasonCode: string;
  comment: string;
  actor: PlatformActor;
  correlationId: string;
}

export interface RecoveryResult {
  action: ProvisioningRecoveryAction;
  status: string;
  revision: number;
}

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;

type LoadedRequest = Prisma.PfProvisioningRequestGetPayload<{ include: { steps: true } }>;

export class ProvisioningRecoveryService {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly repository: ProvisioningControlRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly ports: ProvisioningStepPorts,
    options: { sipBaseDomain: string; now?: () => Date; id?: () => string },
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.repository = new ProvisioningControlRepository(database, {
      sipBaseDomain: options.sipBaseDomain,
      now: this.now,
      id: this.id,
    });
  }

  async preview(input: {
    requestId: string;
    action: ProvisioningRecoveryAction;
  }): Promise<RecoveryPreview> {
    const request = await this.load(input.requestId);
    return this.evaluate(request, input.action);
  }

  async execute(command: RecoveryCommand): Promise<RecoveryResult> {
    if (
      !REASON.test(command.reasonCode) ||
      !command.comment.trim() ||
      command.comment.length > 500
    ) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', {
        ...(REASON.test(command.reasonCode) ? {} : { reasonCode: 'INVALID' }),
        ...(command.comment.trim() && command.comment.length <= 500 ? {} : { comment: 'INVALID' }),
      });
    }
    const request = await this.load(command.requestId);
    if (request.revision !== command.expectedRevision) {
      throw new PlatformProvisioningError('REVISION_CONFLICT');
    }
    const preview = await this.evaluate(request, command.action);
    if (preview.previewDigest !== command.previewDigest) {
      throw new PlatformProvisioningError('PREVIEW_STALE');
    }
    if (!preview.allowed) {
      await this.audit(this.database, request, command, {
        outcome: 'REJECTED',
        errorCode: preview.blockedBy ?? 'RECOVERY_PRECONDITION_FAILED',
        ...(preview.stepKey ? { stepKey: preview.stepKey } : {}),
      });
      throw new PlatformProvisioningError(
        request.status === 'ACTION_REQUIRED'
          ? 'RECOVERY_PRECONDITION_FAILED'
          : 'INVALID_STATE_TRANSITION',
      );
    }

    if (command.action === 'MARK_FAILED_FINAL') {
      // transition ของ repository บันทึก MARK_FAILED_FINAL + tombstone reservation ใน transaction เดียว
      const failed = await this.repository.transition({
        requestId: request.id,
        expectedRevision: request.revision,
        to: 'FAILED_FINAL',
        actor: command.actor,
        correlationId: command.correlationId,
        reasonCode: command.reasonCode,
        comment: command.comment,
        failureCode: command.reasonCode,
      });
      return { action: command.action, ...failed };
    }

    const step = currentStep(request)!;
    const stepKey = step.stepKey as ExternalProvisioningStepKey;
    if (command.action === 'SAFE_COMPENSATE') {
      const context = provisioningStepContext(request, stepKey, step.attempt);
      const found = await this.ports[stepKey].find(context);
      if (found.status !== 'FOUND') throw new PlatformProvisioningError('PREVIEW_STALE');
      const externalRefHash = platformIdentityHash('external-ref', found.externalRef);
      // durable intent ก่อนแตะระบบภายนอก: CAS บน step ทำให้ operator สองคนที่กดพร้อมกันมีผู้ชนะคนเดียว
      // crash หลังจุดนี้ทิ้ง `COMPENSATING` ไว้ให้ preview ใหม่ถาม `find` ว่า resource ยังอยู่หรือไม่
      await this.database.$transaction((transaction) =>
        this.updateStep(transaction, step, { errorCode: 'COMPENSATING' }),
      );
      const claimed = { ...step, revision: step.revision + 1 };
      try {
        await this.ports[stepKey].compensate!(context, found.externalRef);
      } catch (error) {
        await this.audit(this.database, request, command, {
          outcome: 'REJECTED',
          stepKey,
          attempt: step.attempt,
          externalRefHash,
          errorCode: 'COMPENSATION_FAILED',
        });
        throw error;
      }
      return this.commit(request, claimed, command, async (transaction) => {
        await this.updateStep(transaction, claimed, {
          errorCode: 'COMPENSATED',
          externalRef: null,
        });
        await this.audit(transaction, request, command, {
          outcome: 'SUCCEEDED',
          stepKey,
          attempt: step.attempt,
          externalRefHash,
          afterState: 'ACTION_REQUIRED',
        });
        return { status: 'ACTION_REQUIRED', revision: request.revision };
      });
    }

    if (command.action === 'RETRY_STEP') {
      return this.commit(request, step, command, async (transaction) => {
        // เปิดงบ attempt และ deadline ใหม่ แต่ไม่ reset attempt (receipt ต้องเดินหน้าอย่างเดียว)
        await this.updateStep(transaction, step, {
          state: 'PENDING',
          attemptFloor: step.attempt,
          nextAttemptAt: null,
          errorCode: null,
        });
        const revision = await this.resume(transaction, request);
        await this.audit(transaction, request, command, {
          outcome: 'SUCCEEDED',
          stepKey,
          attempt: step.attempt,
          beforeState: 'ACTION_REQUIRED',
          afterState: 'RUNNING',
        });
        return { status: 'RUNNING', revision };
      });
    }

    // RECONCILE: resource มีจริงและ correlation ตรง = adopt แล้วเดินต่อ; ไม่พบ = ไม่เปลี่ยนอะไร
    if (preview.finding === 'NOT_FOUND') {
      await this.audit(this.database, request, command, {
        outcome: 'SUCCEEDED',
        stepKey,
        attempt: step.attempt,
        errorCode: 'NOTHING_TO_ADOPT',
        beforeState: 'ACTION_REQUIRED',
        afterState: 'ACTION_REQUIRED',
      });
      return { action: command.action, status: 'ACTION_REQUIRED', revision: request.revision };
    }
    const context = provisioningStepContext(request, stepKey, step.attempt);
    const found = await this.ports[stepKey].find(context);
    if (found.status !== 'FOUND') throw new PlatformProvisioningError('PREVIEW_STALE');
    const attempt = step.attempt + 1;
    const externalRefHash = platformIdentityHash('external-ref', found.externalRef);
    return this.commit(request, step, command, async (transaction) => {
      await this.updateStep(transaction, step, {
        state: 'SUCCEEDED',
        attempt,
        finishedAt: this.now(),
        externalRef: found.externalRef,
        ...(found.outputDigest ? { outputDigest: found.outputDigest } : {}),
        errorCode: null,
      });
      await transaction.pfProvisioningStepReceipt.create({
        data: {
          id: this.id(),
          requestId: request.id,
          tenantId: request.tenantId,
          stepKey,
          attempt,
          outcome: 'SUCCEEDED',
          ...(found.outputDigest ? { outputDigest: found.outputDigest } : {}),
          externalRefHash,
          recordedAt: this.now(),
        },
      });
      const revision = await this.resume(transaction, request);
      await this.audit(transaction, request, command, {
        outcome: 'SUCCEEDED',
        stepKey,
        attempt,
        externalRefHash,
        beforeState: 'ACTION_REQUIRED',
        afterState: 'RUNNING',
      });
      return { status: 'RUNNING', revision };
    });
  }

  // ── Evaluation ────────────────────────────────────────────────────────────

  private async evaluate(
    request: LoadedRequest,
    action: ProvisioningRecoveryAction,
  ): Promise<RecoveryPreview> {
    const step = currentStep(request);
    const external = step && step.stepKey !== 'TENANT_RECORD' ? step : undefined;
    let finding: ProvisioningAdoption['status'] | null = null;
    if (action !== 'MARK_FAILED_FINAL' && external && request.status === 'ACTION_REQUIRED') {
      const stepKey = external.stepKey as ExternalProvisioningStepKey;
      finding = (
        await this.ports[stepKey].find(provisioningStepContext(request, stepKey, external.attempt))
      ).status;
    }
    const blockedBy = this.blockedBy(request, external, action, finding);
    const body = {
      action,
      requestId: request.id,
      revision: request.revision,
      stepKey: external?.stepKey ?? null,
      attempt: external?.attempt ?? null,
      stepRevision: external?.revision ?? null,
      finding,
    };
    return {
      action,
      requestId: request.id,
      tenantId: request.tenantId,
      revision: request.revision,
      stepKey: external?.stepKey ?? null,
      attempt: external?.attempt ?? null,
      finding,
      allowed: blockedBy === null,
      blockedBy,
      previewDigest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    };
  }

  private blockedBy(
    request: LoadedRequest,
    step: LoadedRequest['steps'][number] | undefined,
    action: ProvisioningRecoveryAction,
    finding: ProvisioningAdoption['status'] | null,
  ): string | null {
    if (request.status !== 'ACTION_REQUIRED') return 'REQUEST_NOT_ACTION_REQUIRED';
    if (action === 'MARK_FAILED_FINAL') return null;
    if (!step || step.state !== 'ACTION_REQUIRED') return 'NO_ACTION_REQUIRED_STEP';
    if (action === 'RECONCILE') return finding === 'MISMATCH' ? 'CORRELATION_MISMATCH' : null;
    if (action === 'RETRY_STEP') {
      // resource อาจมีอยู่แล้ว — ต้อง Reconcile (adopt) หรือ Safe compensate ก่อน ห้าม blind retry
      return finding === 'NOT_FOUND' ? null : 'RESOURCE_MAY_EXIST';
    }
    const port = this.ports[step.stepKey as ExternalProvisioningStepKey];
    if (!port.compensate) return 'COMPENSATION_UNSUPPORTED';
    return finding === 'FOUND' ? null : 'NOTHING_TO_COMPENSATE';
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private async load(requestId: string): Promise<LoadedRequest> {
    const request = /^[0-9a-f-]{36}$/i.test(requestId)
      ? await this.database.pfProvisioningRequest.findUnique({
          where: { id: requestId },
          include: { steps: true },
        })
      : null;
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');
    return request;
  }

  private async commit(
    request: LoadedRequest,
    step: LoadedRequest['steps'][number],
    command: RecoveryCommand,
    work: (transaction: Prisma.TransactionClient) => Promise<{ status: string; revision: number }>,
  ): Promise<RecoveryResult> {
    const result = await this.database.$transaction(async (transaction) => work(transaction));
    return { action: command.action, ...result };
  }

  /** CAS บน revision ของ step ที่ preview เห็น — มีใครขยับก่อน = REVISION_CONFLICT */
  private async updateStep(
    transaction: Prisma.TransactionClient,
    step: LoadedRequest['steps'][number],
    data: Prisma.PfProvisioningStepUpdateManyMutationInput,
  ) {
    const updated = await transaction.pfProvisioningStep.updateMany({
      where: {
        requestId: step.requestId,
        stepKey: step.stepKey,
        revision: step.revision,
        state: 'ACTION_REQUIRED',
      },
      data: { ...data, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
  }

  /**
   * กลับไป RUNNING พร้อม deadline ใหม่: การแทรกแซงของ operator เปิดหน้าต่างเวลาใหม่เสมอ ไม่เช่นนั้น
   * request ที่ถูก escalate เพราะ `DEADLINE_EXCEEDED` จะถูก escalate ซ้ำทันทีที่ step ถัดไปถูก claim
   */
  private async resume(
    transaction: Prisma.TransactionClient,
    request: LoadedRequest,
  ): Promise<number> {
    const deadlineAt = new Date(
      this.now().getTime() + PROVISIONING_SAGA_LIMITS.requestDeadlineMinutes * 60_000,
    );
    const updated = await transaction.pfProvisioningRequest.updateMany({
      where: { id: request.id, revision: request.revision, status: 'ACTION_REQUIRED' },
      data: { status: 'RUNNING', failureCode: null, deadlineAt, revision: { increment: 1 } },
    });
    if (updated.count !== 1) throw new PlatformProvisioningError('REVISION_CONFLICT');
    return request.revision + 1;
  }

  private audit(
    client: Prisma.TransactionClient | PrismaClient,
    request: LoadedRequest,
    command: RecoveryCommand,
    entry: {
      outcome: 'SUCCEEDED' | 'REJECTED';
      stepKey?: ProvisioningStepKey;
      attempt?: number;
      errorCode?: string;
      beforeState?: string;
      afterState?: string;
      externalRefHash?: string;
    },
  ) {
    return appendPlatformAction(client, this.id(), {
      tenantId: request.tenantId,
      requestId: request.id,
      action: command.action,
      actor: command.actor,
      correlationId: command.correlationId,
      reasonCode: command.reasonCode,
      comment: command.comment,
      at: this.now(),
      ...entry,
    });
  }
}
