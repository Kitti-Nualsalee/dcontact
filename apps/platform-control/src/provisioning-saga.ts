/**
 * Owner: Platform control plane — Postgres-backed provisioning saga worker (A1.3 #408)
 *
 * Authority: #390 (ordered steps, verified adoption, forward recovery, lease/retry), #389 (states),
 * Phase Contract #388 (lease 2 นาที, heartbeat 30 วินาที, timeout 60 วินาที, 5 attempts, deadline 30 นาที)
 *
 * database เป็น authority เดียว — worker ไม่มี state ในหน่วยความจำที่ใช้ตัดสินอะไร:
 * - claim step ด้วย CAS บน `(revision, lease)` จึงมีผู้ชนะคนเดียวแม้หลาย worker แย่งกัน
 * - ทุก attempt ถาม `find` ก่อน `execute` เสมอ: response ที่หายหรือ timeout ครั้งก่อนจบด้วย verified
 *   adoption ไม่ใช่ blind create ซ้ำ; correlation ไม่ตรง = `ACTION_REQUIRED` ห้ามยึดหรือลบ
 * - ผลของ attempt เขียนได้เฉพาะเมื่อ lease ยังเป็นของ worker นี้และ revision ตรง — worker ที่ lease
 *   หมดไปแล้วเขียนทับไม่ได้ (`LEASE_LOST`)
 * - timeout/attempt/deadline ไม่ทำให้ `FAILED_FINAL` เอง — ไปจบที่ `ACTION_REQUIRED` ให้ operator
 * - `ACTIVE` เกิดเฉพาะใน transaction สุดท้ายหลัง receipt ครบ (DB trigger บังคับซ้ำ)
 */
import { createHash, randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import {
  PROVISIONING_SAGA_LIMITS,
  PlatformProvisioningError,
  type ProvisioningStepKey,
} from '@d-contact/shared';
import { appendPlatformAction } from './action-history.js';
import { platformIdentityHash } from './provisioning-input.js';
import { ProvisioningControlRepository, type PlatformActor } from './provisioning-repository.js';

export type ExternalProvisioningStepKey = Exclude<ProvisioningStepKey, 'TENANT_RECORD'>;

/** ข้อมูลที่ port ได้รับ — correlation `tenantId/requestId` ต้องถูก stamp ลง resource ภายนอกเสมอ */
export interface ProvisioningStepContext {
  tenantId: string;
  requestId: string;
  stepKey: ExternalProvisioningStepKey;
  attempt: number;
  /** identity ที่ deterministic ต่อ (request, step) — ใช้เป็น message/operation id ของ side effect */
  operationKey: string;
  request: {
    displayName: string;
    slug: string;
    primaryDomain: string;
    sipDomain: string;
    locale: string;
    timezone: string;
    planCode: string;
    planVersion: number;
    planSnapshotDigest: string;
    bootstrapTemplateVersion: string;
    bootstrapTemplateDigest: string;
    firstAdminEmail: string;
    firstAdminDisplayName: string;
  };
}

export type ProvisioningAdoption =
  | { status: 'FOUND'; externalRef: string; outputDigest?: string }
  | { status: 'NOT_FOUND' }
  /** มี resource ชื่อเดียวกันแต่ correlation ไม่ตรง — ห้ามยึดหรือลบ (#390) */
  | { status: 'MISMATCH'; code: string };

export interface ProvisioningStepPort {
  /** lookup ด้วย correlation แล้ว verify ก่อน adopt — read-only เสมอ */
  find(context: ProvisioningStepContext): Promise<ProvisioningAdoption>;
  /** side effect จริง; ต้อง stamp correlation และเคารพ `signal` เมื่อ timeout */
  execute(
    context: ProvisioningStepContext,
    signal: AbortSignal,
  ): Promise<{ externalRef: string; outputDigest?: string }>;
  /** ชดเชยได้เฉพาะ resource ที่ `find` พิสูจน์ ownership แล้ว; ไม่มี = step นี้ compensate ไม่ได้ */
  compensate?(context: ProvisioningStepContext, externalRef: string): Promise<void>;
}

export type ProvisioningStepPorts = Record<ExternalProvisioningStepKey, ProvisioningStepPort>;

/**
 * - `TRANSIENT`: ยังไม่เกิด side effect แน่นอน (เช่น 503 ก่อนส่ง) — retry ได้
 * - `AMBIGUOUS`: อาจเกิดแล้ว (timeout/lost response) — retry ได้เพราะรอบหน้าถาม `find` ก่อน
 * - `PERMANENT`: validation/policy ที่ retry เดิมแก้ไม่ได้ — `ACTION_REQUIRED` ทันที
 */
export class ProvisioningStepError extends Error {
  constructor(
    readonly kind: 'TRANSIENT' | 'AMBIGUOUS' | 'PERMANENT',
    readonly code: string,
  ) {
    super(`provisioning step ${kind}: ${code}`);
    this.name = 'ProvisioningStepError';
  }
}

export interface ProvisioningSagaOptions {
  workerId: string;
  now?: () => Date;
  /** [0, 1) สำหรับ jitter — inject เพื่อให้เทสต์ deterministic */
  random?: () => number;
  id?: () => string;
  leaseMs?: number;
  heartbeatMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** จำนวน request ที่ดูต่อรอบ */
  batchSize?: number;
  /** จำกัดชุด request ที่ worker นี้รับ (sharding หรือแยก fixture ของเทสต์) — ไม่ใช่ authority */
  scope?: () => Prisma.PfProvisioningRequestWhereInput;
}

export type SagaRunResult =
  | { kind: 'IDLE' }
  | { kind: 'STEP_SUCCEEDED'; requestId: string; stepKey: ProvisioningStepKey; adopted: boolean }
  | {
      kind: 'RETRY_SCHEDULED';
      requestId: string;
      stepKey: ProvisioningStepKey;
      nextAttemptAt: Date;
    }
  | { kind: 'ACTION_REQUIRED'; requestId: string; stepKey: ProvisioningStepKey; code: string }
  | { kind: 'COMPLETED'; requestId: string; tenantId: string }
  | { kind: 'LEASE_LOST'; requestId: string; stepKey: ProvisioningStepKey };

const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;

class LeaseLost extends Error {}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stepCode(code: string): string {
  return CODE.test(code) ? code : 'STEP_FAILED';
}

type LoadedRequest = Prisma.PfProvisioningRequestGetPayload<{ include: { steps: true } }>;

export function provisioningStepContext(
  request: LoadedRequest,
  stepKey: ExternalProvisioningStepKey,
  attempt: number,
): ProvisioningStepContext {
  return {
    tenantId: request.tenantId,
    requestId: request.id,
    stepKey,
    attempt,
    operationKey: `${request.id}:${stepKey}`,
    request: {
      displayName: request.displayName,
      slug: request.slug,
      primaryDomain: request.primaryDomain,
      sipDomain: request.sipDomain,
      locale: request.locale,
      timezone: request.timezone,
      planCode: request.planCode,
      planVersion: request.planVersion,
      planSnapshotDigest: request.planSnapshotDigest,
      bootstrapTemplateVersion: request.bootstrapTemplateVersion,
      bootstrapTemplateDigest: request.bootstrapTemplateDigest,
      firstAdminEmail: request.firstAdminEmail,
      firstAdminDisplayName: request.firstAdminDisplayName,
    },
  };
}

/** step แรกที่ยังไม่ SUCCEEDED — saga ไม่ข้าม step และไม่ทำสอง step พร้อมกันใน request เดียว */
export function currentStep(request: LoadedRequest) {
  return [...request.steps]
    .sort((left, right) => left.ordinal - right.ordinal)
    .find((step) => step.state !== 'SUCCEEDED');
}

export class ProvisioningSagaWorker {
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly id: () => string;
  private readonly leaseMs: number;
  private readonly heartbeatMs: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly batchSize: number;
  private readonly actor: PlatformActor;
  private readonly repository: ProvisioningControlRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly ports: ProvisioningStepPorts,
    private readonly options: ProvisioningSagaOptions & { sipBaseDomain: string },
  ) {
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.id = options.id ?? randomUUID;
    this.leaseMs = options.leaseMs ?? PROVISIONING_SAGA_LIMITS.leaseSeconds * 1000;
    this.heartbeatMs = options.heartbeatMs ?? PROVISIONING_SAGA_LIMITS.heartbeatSeconds * 1000;
    this.timeoutMs = options.timeoutMs ?? PROVISIONING_SAGA_LIMITS.externalTimeoutSeconds * 1000;
    this.maxAttempts = options.maxAttempts ?? PROVISIONING_SAGA_LIMITS.maxAttempts;
    this.backoffBaseMs = options.backoffBaseMs ?? 5_000;
    this.backoffMaxMs = options.backoffMaxMs ?? 120_000;
    this.batchSize = options.batchSize ?? 20;
    this.actor = { kind: 'SYSTEM', subject: `provisioning-worker:${options.workerId}` };
    this.repository = new ProvisioningControlRepository(database, {
      sipBaseDomain: options.sipBaseDomain,
      now: this.now,
      id: this.id,
    });
  }

  /** exponential backoff + jitter ครึ่งบน — attempt ในงบปัจจุบันเริ่มที่ 1 */
  backoffMs(attemptInBudget: number): number {
    const ceiling = Math.min(
      this.backoffBaseMs * 2 ** Math.max(0, attemptInBudget - 1),
      this.backoffMaxMs,
    );
    return Math.round(ceiling / 2 + (ceiling / 2) * this.random());
  }

  /** ทำงานหนึ่งหน่วย: finalize request ที่ครบแล้ว หรือ claim + ทำ step ปัจจุบันของ request หนึ่งใบ */
  async runOnce(): Promise<SagaRunResult> {
    const candidates = await this.database.pfProvisioningRequest.findMany({
      where: {
        status: { in: ['PENDING', 'RUNNING'] },
        ...(this.options.scope ? this.options.scope() : {}),
      },
      include: { steps: true },
      orderBy: { acceptedAt: 'asc' },
      take: this.batchSize,
    });
    for (const request of candidates) {
      const step = currentStep(request);
      if (!step) {
        const completed = await this.finalize(request);
        if (completed) return completed;
        continue;
      }
      if (step.stepKey === 'TENANT_RECORD' || step.state === 'ACTION_REQUIRED') continue;
      const now = this.now();
      if (step.nextAttemptAt && step.nextAttemptAt > now) continue;
      if (step.leaseExpiresAt && step.leaseExpiresAt > now) continue;
      const claimed = await this.claim(request, step, now);
      if (!claimed) continue;
      return this.process(request, step.stepKey as ExternalProvisioningStepKey, claimed);
    }
    return { kind: 'IDLE' };
  }

  /** เรียกซ้ำจนไม่มีงาน — ใช้ใน worker loop และเทสต์ */
  async drain(limit = 50): Promise<SagaRunResult[]> {
    const results: SagaRunResult[] = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await this.runOnce();
      if (result.kind === 'IDLE') break;
      results.push(result);
    }
    return results;
  }

  // ── Claim / lease ─────────────────────────────────────────────────────────

  private async claim(
    request: LoadedRequest,
    step: LoadedRequest['steps'][number],
    now: Date,
  ): Promise<{ attempt: number; attemptFloor: number; revision: number } | null> {
    const attempt = step.attempt + 1;
    return this.database.$transaction(async (transaction) => {
      const claimed = await transaction.pfProvisioningStep.updateMany({
        where: {
          requestId: request.id,
          stepKey: step.stepKey,
          revision: step.revision,
          state: { in: ['PENDING', 'RUNNING'] },
          OR: [{ leaseOwner: null }, { leaseExpiresAt: { lte: now } }],
        },
        data: {
          state: 'RUNNING',
          attempt,
          leaseOwner: this.options.workerId,
          leaseExpiresAt: new Date(now.getTime() + this.leaseMs),
          nextAttemptAt: null,
          startedAt: step.startedAt ?? now,
          revision: { increment: 1 },
        },
      });
      if (claimed.count !== 1) return null;
      if (request.status === 'PENDING') {
        const started = await transaction.pfProvisioningRequest.updateMany({
          where: { id: request.id, status: 'PENDING', revision: request.revision },
          data: { status: 'RUNNING', revision: { increment: 1 } },
        });
        if (started.count === 1) {
          await this.audit(transaction, request, {
            action: 'STATE_CHANGED',
            beforeState: 'PENDING',
            afterState: 'RUNNING',
          });
        }
      }
      await this.audit(transaction, request, {
        action: 'STEP_STARTED',
        stepKey: step.stepKey,
        attempt,
      });
      return { attempt, attemptFloor: step.attemptFloor, revision: step.revision + 1 };
    });
  }

  private async process(
    request: LoadedRequest,
    stepKey: ExternalProvisioningStepKey,
    lease: { attempt: number; attemptFloor: number; revision: number },
  ): Promise<SagaRunResult> {
    const attemptInBudget = lease.attempt - lease.attemptFloor;
    const now = this.now();
    if (now > request.deadlineAt)
      return this.escalate(request, stepKey, lease, 'DEADLINE_EXCEEDED');
    if (attemptInBudget > this.maxAttempts) {
      return this.escalate(request, stepKey, lease, 'ATTEMPTS_EXHAUSTED');
    }

    const port = this.ports[stepKey];
    const context = provisioningStepContext(request, stepKey, lease.attempt);
    const heartbeat = this.startHeartbeat(request.id, stepKey, lease);
    let outcome:
      | { kind: 'DONE'; externalRef: string; outputDigest?: string; adopted: boolean }
      | { kind: 'ESCALATE'; code: string }
      | { kind: 'RETRY'; code: string };
    try {
      outcome = await this.attempt(port, context);
    } finally {
      await heartbeat.stop();
    }
    if (heartbeat.lost()) return { kind: 'LEASE_LOST', requestId: request.id, stepKey };

    if (outcome.kind === 'DONE') return this.succeed(request, stepKey, lease, outcome);
    if (outcome.kind === 'ESCALATE') return this.escalate(request, stepKey, lease, outcome.code);
    if (attemptInBudget >= this.maxAttempts) {
      return this.escalate(request, stepKey, lease, 'ATTEMPTS_EXHAUSTED');
    }
    return this.scheduleRetry(request, stepKey, lease, outcome.code, attemptInBudget);
  }

  /** find → (FOUND = adopt | MISMATCH = หยุด | NOT_FOUND = execute ภายใต้ timeout) */
  private async attempt(port: ProvisioningStepPort, context: ProvisioningStepContext) {
    let adoption: ProvisioningAdoption;
    try {
      adoption = await withTimeout(
        (signal) => port.find(context).then(guard(signal)),
        this.timeoutMs,
      );
    } catch (error) {
      return classify(error);
    }
    if (adoption.status === 'FOUND') {
      return {
        kind: 'DONE' as const,
        externalRef: adoption.externalRef,
        ...(adoption.outputDigest ? { outputDigest: adoption.outputDigest } : {}),
        adopted: true,
      };
    }
    if (adoption.status === 'MISMATCH') {
      return { kind: 'ESCALATE' as const, code: stepCode(adoption.code) };
    }
    try {
      const created = await withTimeout((signal) => port.execute(context, signal), this.timeoutMs);
      return { kind: 'DONE' as const, ...created, adopted: false };
    } catch (error) {
      return classify(error);
    }
  }

  private startHeartbeat(
    requestId: string,
    stepKey: ProvisioningStepKey,
    lease: { revision: number },
  ) {
    let lost = false;
    let pending: Promise<void> = Promise.resolve();
    const beat = () => {
      pending = pending.then(async () => {
        if (lost) return;
        const extended = await this.database.pfProvisioningStep.updateMany({
          where: {
            requestId,
            stepKey,
            leaseOwner: this.options.workerId,
            revision: lease.revision,
          },
          data: {
            leaseExpiresAt: new Date(this.now().getTime() + this.leaseMs),
            revision: { increment: 1 },
          },
        });
        if (extended.count === 1) lease.revision += 1;
        else lost = true;
      });
    };
    const timer = setInterval(beat, this.heartbeatMs);
    timer.unref?.();
    return {
      lost: () => lost,
      stop: async () => {
        clearInterval(timer);
        await pending.catch(() => undefined);
      },
    };
  }

  // ── Outcomes ──────────────────────────────────────────────────────────────

  private async succeed(
    request: LoadedRequest,
    stepKey: ExternalProvisioningStepKey,
    lease: { attempt: number; revision: number },
    result: { externalRef: string; outputDigest?: string; adopted: boolean },
  ): Promise<SagaRunResult> {
    const now = this.now();
    const externalRefHash = platformIdentityHash('external-ref', result.externalRef);
    try {
      await this.database.$transaction(async (transaction) => {
        const updated = await transaction.pfProvisioningStep.updateMany({
          where: {
            requestId: request.id,
            stepKey,
            leaseOwner: this.options.workerId,
            revision: lease.revision,
          },
          data: {
            state: 'SUCCEEDED',
            finishedAt: now,
            externalRef: result.externalRef,
            ...(result.outputDigest ? { outputDigest: result.outputDigest } : {}),
            errorCode: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new LeaseLost();
        await transaction.pfProvisioningStepReceipt.create({
          data: {
            id: this.id(),
            requestId: request.id,
            tenantId: request.tenantId,
            stepKey,
            attempt: lease.attempt,
            outcome: 'SUCCEEDED',
            ...(result.outputDigest ? { outputDigest: result.outputDigest } : {}),
            externalRefHash,
            recordedAt: now,
          },
        });
        await this.audit(transaction, request, {
          action: 'STEP_SUCCEEDED',
          stepKey,
          attempt: lease.attempt,
          externalRefHash,
          ...(result.outputDigest ? { outputDigest: result.outputDigest } : {}),
          ...(result.adopted ? { reasonCode: 'VERIFIED_ADOPTION' } : {}),
        });
      });
    } catch (error) {
      if (error instanceof LeaseLost) return { kind: 'LEASE_LOST', requestId: request.id, stepKey };
      throw error;
    }
    return { kind: 'STEP_SUCCEEDED', requestId: request.id, stepKey, adopted: result.adopted };
  }

  private async scheduleRetry(
    request: LoadedRequest,
    stepKey: ExternalProvisioningStepKey,
    lease: { attempt: number; revision: number },
    code: string,
    attemptInBudget: number,
  ): Promise<SagaRunResult> {
    const nextAttemptAt = new Date(this.now().getTime() + this.backoffMs(attemptInBudget));
    try {
      await this.database.$transaction(async (transaction) => {
        const updated = await transaction.pfProvisioningStep.updateMany({
          where: {
            requestId: request.id,
            stepKey,
            leaseOwner: this.options.workerId,
            revision: lease.revision,
          },
          data: {
            state: 'PENDING',
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt,
            errorCode: code,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new LeaseLost();
        await this.audit(transaction, request, {
          action: 'STEP_RETRY_SCHEDULED',
          stepKey,
          attempt: lease.attempt,
          errorCode: code,
        });
      });
    } catch (error) {
      if (error instanceof LeaseLost) return { kind: 'LEASE_LOST', requestId: request.id, stepKey };
      throw error;
    }
    return { kind: 'RETRY_SCHEDULED', requestId: request.id, stepKey, nextAttemptAt };
  }

  /** ปัญหาที่ worker แก้เองไม่ได้: step + request เป็น ACTION_REQUIRED พร้อม receipt ของ attempt นี้ */
  private async escalate(
    request: LoadedRequest,
    stepKey: ExternalProvisioningStepKey,
    lease: { attempt: number; revision: number },
    code: string,
  ): Promise<SagaRunResult> {
    const now = this.now();
    try {
      await this.database.$transaction(async (transaction) => {
        const updated = await transaction.pfProvisioningStep.updateMany({
          where: {
            requestId: request.id,
            stepKey,
            leaseOwner: this.options.workerId,
            revision: lease.revision,
          },
          data: {
            state: 'ACTION_REQUIRED',
            errorCode: code,
            leaseOwner: null,
            leaseExpiresAt: null,
            nextAttemptAt: null,
            revision: { increment: 1 },
          },
        });
        if (updated.count !== 1) throw new LeaseLost();
        await transaction.pfProvisioningStepReceipt.create({
          data: {
            id: this.id(),
            requestId: request.id,
            tenantId: request.tenantId,
            stepKey,
            attempt: lease.attempt,
            outcome: 'ACTION_REQUIRED',
            errorCode: code,
            recordedAt: now,
          },
        });
        const moved = await transaction.pfProvisioningRequest.updateMany({
          where: { id: request.id, status: 'RUNNING' },
          data: { status: 'ACTION_REQUIRED', failureCode: code, revision: { increment: 1 } },
        });
        await this.audit(transaction, request, {
          action: 'STEP_ACTION_REQUIRED',
          stepKey,
          attempt: lease.attempt,
          errorCode: code,
        });
        if (moved.count === 1) {
          await this.audit(transaction, request, {
            action: 'STATE_CHANGED',
            beforeState: 'RUNNING',
            afterState: 'ACTION_REQUIRED',
            errorCode: code,
          });
        }
      });
    } catch (error) {
      if (error instanceof LeaseLost) return { kind: 'LEASE_LOST', requestId: request.id, stepKey };
      throw error;
    }
    return { kind: 'ACTION_REQUIRED', requestId: request.id, stepKey, code };
  }

  /** receipt ครบแล้ว: SUCCEEDED + ACTIVE ใน transaction เดียว (crash ก่อนนี้ = worker ถัดไปมาทำต่อ) */
  private async finalize(request: LoadedRequest): Promise<SagaRunResult | null> {
    if (request.status !== 'RUNNING') return null;
    try {
      await this.repository.complete({
        requestId: request.id,
        expectedRevision: request.revision,
        actor: this.actor,
        correlationId: request.correlationId,
      });
    } catch (error) {
      if (error instanceof PlatformProvisioningError && error.code === 'REVISION_CONFLICT')
        return null;
      throw error;
    }
    return { kind: 'COMPLETED', requestId: request.id, tenantId: request.tenantId };
  }

  private audit(
    client: Prisma.TransactionClient,
    request: LoadedRequest,
    entry: {
      action:
        | 'STATE_CHANGED'
        | 'STEP_STARTED'
        | 'STEP_SUCCEEDED'
        | 'STEP_RETRY_SCHEDULED'
        | 'STEP_ACTION_REQUIRED';
      beforeState?: string;
      afterState?: string;
      stepKey?: ProvisioningStepKey;
      attempt?: number;
      errorCode?: string;
      reasonCode?: string;
      outputDigest?: string;
      externalRefHash?: string;
    },
  ) {
    return appendPlatformAction(client, this.id(), {
      tenantId: request.tenantId,
      requestId: request.id,
      actor: this.actor,
      correlationId: request.correlationId,
      outcome: 'SUCCEEDED',
      at: this.now(),
      ...entry,
    });
  }
}

/** timeout ของ external call = ผลไม่ทราบ (AMBIGUOUS) และ abort ส่งไปให้ port หยุดงาน */
async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProvisioningStepError('AMBIGUOUS', 'EXTERNAL_TIMEOUT'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function guard<T>(signal: AbortSignal) {
  return (value: T) => {
    if (signal.aborted) throw new ProvisioningStepError('AMBIGUOUS', 'EXTERNAL_TIMEOUT');
    return value;
  };
}

/** error ที่ไม่รู้จักถือว่าไม่รู้ผล — ปลอดภัยเพราะรอบหน้าถาม find ก่อนเสมอ */
function classify(error: unknown): { kind: 'ESCALATE' | 'RETRY'; code: string } {
  if (error instanceof ProvisioningStepError) {
    return { kind: error.kind === 'PERMANENT' ? 'ESCALATE' : 'RETRY', code: stepCode(error.code) };
  }
  return { kind: 'RETRY', code: 'EXTERNAL_UNKNOWN_ERROR' };
}

export const provisioningDigest = sha256;
