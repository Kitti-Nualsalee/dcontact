/**
 * Owner: Platform API + control plane — durable operator command (A1.6 #411)
 *
 * Authority: #388 checkpoint 1 และ decision "Recovery ที่ต้องใช้ Keycloak ทำงานผ่าน durable command
 * ของ worker"
 *
 * `OperatorCommandIntake` (ฝั่ง API, ใช้แค่ DB role `dcontact_platform`)
 * - ตรวจสิ่งที่รู้ได้จาก DB แบบ synchronous: validation, target, state, `expectedRevision`,
 *   resend cap (429 + Retry-After) และ idempotency (`pf_command_receipts`) แล้วบันทึก command → 202
 * - ถูกปฏิเสธก่อนบันทึก = ลง Action history เป็น REJECTED (target ที่มีจริงเท่านั้น)
 *
 * `OperatorCommandWorker` (ฝั่ง worker ที่ถือ Keycloak credential)
 * - claim ด้วย lease/CAS; preview/execute ผ่าน `ProvisioningRecoveryService` / `InvitationOutbox`
 *   ในนามของ operator ที่สั่ง (audit ผูก actor จริง ไม่ใช่ SYSTEM)
 * - ผลที่ปฏิเสธได้แน่นอน = REJECTED + code; error ที่ไม่รู้ผล = คืน lease ให้ลองใหม่ ≤ 5 ครั้ง
 *   (recovery ตรวจ revision/digest ซ้ำทุกครั้ง จึงลองใหม่แล้วไม่เกิด side effect ซ้ำ)
 */
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  canonicalJson,
  INVITATION_LIMITS,
  PlatformProvisioningError,
  PROVISIONING_RECOVERY_ACTIONS,
  type PlatformProvisioningErrorCode,
  type ProvisioningRecoveryAction,
} from '@d-contact/shared';
import { appendPlatformAction } from './action-history.js';
import type { InvitationOutbox } from './invitation-outbox.js';
import { platformIdentityHash } from './provisioning-input.js';
import type { ProvisioningRecoveryService } from './provisioning-recovery.js';
import type { PlatformActor } from './provisioning-repository.js';
import { ProvisioningStepError } from './provisioning-saga.js';

export const OPERATOR_ACTIONS = [...PROVISIONING_RECOVERY_ACTIONS, 'RESEND_INVITATION'] as const;
export type OperatorAction = (typeof OPERATOR_ACTIONS)[number];

/** path segment ของ #388 checkpoint 1 → action ภายใน */
export const OPERATOR_ACTION_PATHS: Readonly<Record<string, OperatorAction>> = Object.freeze({
  reconcile: 'RECONCILE',
  retry: 'RETRY_STEP',
  'resend-invitation': 'RESEND_INVITATION',
  'safe-compensate': 'SAFE_COMPENSATE',
  'mark-failed-final': 'MARK_FAILED_FINAL',
});

/** 429 ต้องบอกว่าลองได้อีกเมื่อไร (#388: `Retry-After`) */
export class PlatformRetryAfterError extends PlatformProvisioningError {
  constructor(
    code: PlatformProvisioningErrorCode,
    readonly retryAfterSeconds: number,
  ) {
    super(code);
    this.name = 'PlatformRetryAfterError';
  }
}

const REASON = /^[A-Z][A-Z0-9_]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[a-f0-9]{64}$/;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const isRecovery = (action: OperatorAction): action is ProvisioningRecoveryAction =>
  (PROVISIONING_RECOVERY_ACTIONS as readonly string[]).includes(action);

type CommandRow = Prisma.PfOperatorCommandGetPayload<object>;

export interface CommandView {
  commandId: string;
  requestId: string;
  kind: 'PREVIEW' | 'EXECUTE';
  action: OperatorAction;
  state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'REJECTED';
  errorCode: string | null;
  /** preview: digest/allowed/blockedBy/finding; execute: สถานะหลังทำ — ไม่มี PII */
  result: Record<string, unknown> | null;
  createdAt: string;
  finishedAt: string | null;
}

export function commandView(row: CommandRow): CommandView {
  return {
    commandId: row.id,
    requestId: row.requestId,
    kind: row.kind,
    action: row.action as OperatorAction,
    // RUNNING ที่ถูกคืน lease เพื่อรอลองใหม่ยังนับเป็นกำลังทำ
    state: row.state,
    errorCode: row.errorCode,
    result: (row.result as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

// ── Intake (API) ────────────────────────────────────────────────────────────

export class OperatorCommandIntake {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: { now?: () => Date; id?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  private async request(requestId: string) {
    const request = UUID.test(requestId)
      ? await this.database.pfProvisioningRequest.findUnique({ where: { id: requestId } })
      : null;
    if (!request) throw new PlatformProvisioningError('NOT_FOUND');
    return request;
  }

  /** preview เป็น read-only จึงไม่ต้องมี Idempotency-Key — ผลจริงมาจาก worker */
  async requestPreview(input: {
    requestId: string;
    action: OperatorAction;
    actor: PlatformActor;
    correlationId: string;
  }): Promise<CommandView> {
    if (!isRecovery(input.action)) throw new PlatformProvisioningError('NOT_FOUND');
    const request = await this.request(input.requestId);
    const row = await this.database.pfOperatorCommand.create({
      data: {
        id: this.id(),
        requestId: request.id,
        tenantId: request.tenantId,
        kind: 'PREVIEW',
        action: input.action,
        ...actorColumns(input.actor),
        correlationId: input.correlationId,
        createdAt: this.now(),
      },
    });
    return commandView(row);
  }

  async command(requestId: string, commandId: string, kind?: 'PREVIEW' | 'EXECUTE') {
    const row = UUID.test(commandId)
      ? await this.database.pfOperatorCommand.findUnique({ where: { id: commandId } })
      : null;
    // command ของ request อื่น = ไม่มี (ไม่เปิดว่ามีอยู่)
    if (!row || row.requestId !== requestId || (kind && row.kind !== kind)) {
      throw new PlatformProvisioningError('NOT_FOUND');
    }
    return commandView(row);
  }

  async submit(input: {
    requestId: string;
    action: OperatorAction;
    idempotencyKey: string;
    expectedRevision?: number;
    previewDigest?: string;
    reasonCode: string;
    comment: string;
    actor: PlatformActor;
    correlationId: string;
  }): Promise<CommandView & { replayed: boolean }> {
    const fieldErrors: Record<string, string> = {};
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(input.idempotencyKey))
      fieldErrors.idempotencyKey = 'INVALID';
    if (!REASON.test(input.reasonCode)) fieldErrors.reasonCode = 'INVALID';
    const comment = input.comment?.trim() ?? '';
    if (!comment || comment.length > 500) fieldErrors.comment = 'INVALID';
    if (isRecovery(input.action)) {
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision! < 1) {
        fieldErrors.expectedRevision = 'INVALID';
      }
      if (!HEX64.test(input.previewDigest ?? '')) fieldErrors.previewDigest = 'INVALID';
    }
    if (Object.keys(fieldErrors).length > 0) {
      throw new PlatformProvisioningError('VALIDATION_FAILED', fieldErrors);
    }
    const commandKind = `OPERATOR_${input.action}`;
    const keyHash = platformIdentityHash('idempotency-key', input.idempotencyKey);
    // requestId อยู่ใน digest: key เดิมกับ request อื่น (target swap) = IDEMPOTENCY_KEY_REUSED
    const payloadDigest = sha256(
      canonicalJson({
        requestId: input.requestId,
        action: input.action,
        expectedRevision: input.expectedRevision ?? null,
        previewDigest: input.previewDigest ?? null,
        reasonCode: input.reasonCode,
        comment,
      }),
    );

    const replay = async () => {
      const receipt = await this.database.pfCommandReceipt.findUnique({
        where: { idempotencyKeyHash: keyHash },
      });
      if (!receipt) return null;
      if (receipt.commandKind !== commandKind || receipt.payloadDigest !== payloadDigest) {
        throw new PlatformProvisioningError('IDEMPOTENCY_KEY_REUSED');
      }
      const row = await this.database.pfOperatorCommand.findUniqueOrThrow({
        where: { idempotencyKeyHash: keyHash },
      });
      return { ...commandView(row), replayed: true };
    };
    const replayed = await replay();
    if (replayed) return replayed;

    const request = await this.request(input.requestId);
    const reject = async (code: PlatformProvisioningErrorCode, retryAfterSeconds?: number) => {
      await appendPlatformAction(this.database, this.id(), {
        tenantId: request.tenantId,
        requestId: request.id,
        action: input.action,
        actor: input.actor,
        correlationId: input.correlationId,
        idempotencyKeyHash: keyHash,
        outcome: 'REJECTED',
        reasonCode: input.reasonCode,
        comment,
        errorCode: code,
        at: this.now(),
      });
      return retryAfterSeconds === undefined
        ? new PlatformProvisioningError(code)
        : new PlatformRetryAfterError(code, retryAfterSeconds);
    };

    if (isRecovery(input.action)) {
      if (request.status !== 'ACTION_REQUIRED') throw await reject('INVALID_STATE_TRANSITION');
      if (request.revision !== input.expectedRevision) throw await reject('REVISION_CONFLICT');
    } else {
      const latest = await this.database.pfInvitation.findFirst({
        where: { requestId: request.id },
        orderBy: { generation: 'desc' },
      });
      if (!latest) throw await reject('RECOVERY_PRECONDITION_FAILED');
      // cap ของ #392 นับ resend ที่ส่งแล้วและที่รอ worker อยู่ — trigger ใน DB บังคับซ้ำตอนทำจริง
      const windowStart = new Date(this.now().getTime() - 3600_000);
      const [sent, pending] = await Promise.all([
        this.database.pfInvitation.findMany({
          where: { requestId: request.id, generation: { gt: 1 }, createdAt: { gt: windowStart } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        }),
        this.database.pfOperatorCommand.count({
          where: {
            requestId: request.id,
            action: 'RESEND_INVITATION',
            kind: 'EXECUTE',
            state: { in: ['QUEUED', 'RUNNING'] },
          },
        }),
      ]);
      if (sent.length + pending >= INVITATION_LIMITS.resendPerHour) {
        const oldest = sent[0]?.createdAt ?? this.now();
        const retryAfter = Math.max(
          1,
          Math.ceil((oldest.getTime() + 3600_000 - this.now().getTime()) / 1000),
        );
        throw await reject('INVITATION_RESEND_LIMITED', retryAfter);
      }
    }

    try {
      const row = await this.database.$transaction(async (transaction) => {
        await transaction.pfCommandReceipt.create({
          data: {
            id: this.id(),
            idempotencyKeyHash: keyHash,
            commandKind,
            payloadDigest,
            requestId: request.id,
            tenantId: request.tenantId,
            actorSubject: input.actor.subject,
          },
        });
        return transaction.pfOperatorCommand.create({
          data: {
            id: this.id(),
            requestId: request.id,
            tenantId: request.tenantId,
            kind: 'EXECUTE',
            action: input.action,
            expectedRevision: input.expectedRevision ?? null,
            previewDigest: input.previewDigest ?? null,
            reasonCode: input.reasonCode,
            comment,
            idempotencyKeyHash: keyHash,
            ...actorColumns(input.actor),
            correlationId: input.correlationId,
            createdAt: this.now(),
          },
        });
      });
      return { ...commandView(row), replayed: false };
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const target = String((error.meta as { target?: unknown } | undefined)?.target ?? '');
        // key เดียวกันส่งพร้อมกัน: อีกฝั่งบันทึกก่อน → replay ผลเดียวกัน
        const again = await replay();
        if (again) return again;
        if (!target.includes('idempotency')) throw await reject('COMMAND_IN_PROGRESS');
      }
      throw error;
    }
  }
}

function actorColumns(actor: PlatformActor) {
  return {
    actorKind: actor.kind,
    actorSubject: actor.subject,
    actorRole: actor.role ?? null,
    actorSessionRef: actor.sessionRef ?? null,
  };
}

// ── Worker ──────────────────────────────────────────────────────────────────

export type CommandRunResult =
  | { kind: 'IDLE' }
  | {
      kind: 'FINISHED';
      commandId: string;
      state: 'SUCCEEDED' | 'REJECTED';
      errorCode: string | null;
    }
  | { kind: 'RETRY_LATER'; commandId: string; errorCode: string };

export class OperatorCommandWorker {
  private readonly now: () => Date;
  private readonly leaseMs: number;
  private readonly retryMs: number;
  private readonly maxAttempts: number;

  constructor(
    private readonly database: PrismaClient,
    private readonly handlers: {
      recovery: ProvisioningRecoveryService;
      /** ไม่ส่งมา = resend ถูกปฏิเสธ (worker ที่ไม่มี Keycloak) */
      invitations?: InvitationOutbox;
    },
    private readonly options: {
      workerId: string;
      now?: () => Date;
      leaseMs?: number;
      retryMs?: number;
      maxAttempts?: number;
      /** จำกัดชุด command (แยก fixture ของเทสต์) — ไม่ใช่ authority */
      scope?: () => Prisma.PfOperatorCommandWhereInput;
    },
  ) {
    this.now = options.now ?? (() => new Date());
    this.leaseMs = options.leaseMs ?? 120_000;
    this.retryMs = options.retryMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 5;
  }

  async drain(limit = 50): Promise<CommandRunResult[]> {
    const results: CommandRunResult[] = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await this.runOnce();
      if (result.kind === 'IDLE') break;
      results.push(result);
    }
    return results;
  }

  async runOnce(): Promise<CommandRunResult> {
    const now = this.now();
    const candidates = await this.database.pfOperatorCommand.findMany({
      where: {
        OR: [{ state: 'QUEUED' }, { state: 'RUNNING', leaseExpiresAt: { lte: now } }],
        ...(this.options.scope ? this.options.scope() : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const candidate of candidates) {
      const claimed = await this.database.pfOperatorCommand.updateMany({
        where: { id: candidate.id, revision: candidate.revision },
        data: {
          state: 'RUNNING',
          attempt: { increment: 1 },
          leaseOwner: this.options.workerId,
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          startedAt: candidate.startedAt ?? now,
          revision: { increment: 1 },
        },
      });
      if (claimed.count !== 1) continue;
      return this.process({
        ...candidate,
        revision: candidate.revision + 1,
        attempt: candidate.attempt + 1,
      });
    }
    return { kind: 'IDLE' };
  }

  private async process(command: CommandRow): Promise<CommandRunResult> {
    const actor: PlatformActor = {
      kind: command.actorKind,
      subject: command.actorSubject,
      ...(command.actorRole ? { role: command.actorRole } : {}),
      ...(command.actorSessionRef ? { sessionRef: command.actorSessionRef } : {}),
    };
    const action = command.action as OperatorAction;
    try {
      let result: Record<string, unknown>;
      if (command.kind === 'PREVIEW') {
        const preview = await this.handlers.recovery.preview({
          requestId: command.requestId,
          action: action as ProvisioningRecoveryAction,
        });
        result = {
          previewDigest: preview.previewDigest,
          allowed: preview.allowed,
          blockedBy: preview.blockedBy,
          finding: preview.finding,
          stepKey: preview.stepKey,
          revision: preview.revision,
        };
      } else if (isRecovery(action)) {
        const executed = await this.handlers.recovery.execute({
          requestId: command.requestId,
          action,
          expectedRevision: command.expectedRevision!,
          previewDigest: command.previewDigest!,
          reasonCode: command.reasonCode!,
          comment: command.comment!,
          actor,
          correlationId: command.correlationId,
        });
        result = { status: executed.status, revision: executed.revision };
      } else {
        if (!this.handlers.invitations) {
          return this.finish(command, 'REJECTED', null, 'RESEND_UNAVAILABLE');
        }
        const status = await this.handlers.invitations.resend({
          requestId: command.requestId,
          reasonCode: command.reasonCode!,
          comment: command.comment!,
          actor,
          correlationId: command.correlationId,
        });
        result = {
          generation: status.generation,
          delivery: status.delivery,
          expiresAt: status.expiresAt?.toISOString() ?? null,
        };
      }
      return this.finish(command, 'SUCCEEDED', result, null);
    } catch (error) {
      if (error instanceof PlatformProvisioningError) {
        return this.finish(command, 'REJECTED', null, error.code);
      }
      // ผลของ step ภายนอกที่ปฏิเสธถาวร/ไม่รู้ผล (เช่น delivery ambiguous) เป็นคำตอบสุดท้ายของคำสั่ง
      if (error instanceof ProvisioningStepError && error.kind !== 'TRANSIENT') {
        return this.finish(command, 'REJECTED', null, error.code);
      }
      const code =
        error instanceof ProvisioningStepError ? error.code : 'COMMAND_DEPENDENCY_FAILED';
      if (command.attempt >= this.maxAttempts) {
        return this.finish(command, 'REJECTED', null, 'COMMAND_ATTEMPTS_EXHAUSTED');
      }
      // คืน lease ให้หมดอายุเร็ว แล้ว worker ใดก็ได้ claim ใหม่
      const released = await this.database.pfOperatorCommand.updateMany({
        where: { id: command.id, revision: command.revision, leaseOwner: this.options.workerId },
        data: {
          leaseExpiresAt: new Date(this.now().getTime() + this.retryMs),
          errorCode: code,
          revision: { increment: 1 },
        },
      });
      if (released.count !== 1)
        return { kind: 'RETRY_LATER', commandId: command.id, errorCode: 'LEASE_LOST' };
      return { kind: 'RETRY_LATER', commandId: command.id, errorCode: code };
    }
  }

  private async finish(
    command: CommandRow,
    state: 'SUCCEEDED' | 'REJECTED',
    result: Record<string, unknown> | null,
    errorCode: string | null,
  ): Promise<CommandRunResult> {
    const finished = await this.database.pfOperatorCommand.updateMany({
      where: { id: command.id, revision: command.revision, leaseOwner: this.options.workerId },
      data: {
        state,
        ...(result ? { result: result as Prisma.InputJsonValue } : {}),
        errorCode,
        finishedAt: this.now(),
        leaseOwner: null,
        leaseExpiresAt: null,
        revision: { increment: 1 },
      },
    });
    if (finished.count !== 1) {
      return { kind: 'RETRY_LATER', commandId: command.id, errorCode: 'LEASE_LOST' };
    }
    return { kind: 'FINISHED', commandId: command.id, state, errorCode };
  }
}
