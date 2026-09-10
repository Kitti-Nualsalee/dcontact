/**
 * Owner: Journey — durable execution ของ J1 (C1.5)
 *
 * ขอบเขต C1.5: enrollment lifecycle, Schedule/Event ingress dedupe, WAIT wake-up,
 * cancellation/goal/exit/max-age และ restart safety เท่านั้น
 * **ไม่มี** Governance, Delivery หรือ provider traffic — node `SEND` หยุดที่
 * `AWAITING_SEND` เพื่อส่งต่อให้ C1.6 ประกอบ ไม่ใช่ให้ที่นี่เรียกเอง
 *
 * กติกาที่โค้ดนี้ต้องรักษา:
 *   1. `(enrollment_id, step_sequence)` เป็น unique — worker สองตัวที่ claim งานเดียวกัน
 *      จะมีตัวเดียวที่ insert step run ผ่าน อีกตัวรู้ตัวจาก unique violation ไม่ใช่จากการอ่าน
 *   2. terminal ครั้งแรกชนะเสมอ และตรวจซ้ำใน transaction เดียวกับที่จะรัน node
 *      — cancel/goal/exit/max-age ที่มาก่อนจึงตัดหน้างานได้แน่นอน
 *   3. evidence ที่ปล่อยออกมีแต่ opaque id, step id และ enum ห้ามมี payload หรือ PII
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrRunState,
  type JrTerminalReason,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { ExpressionContext, ExpressionEvaluator } from '@d-contact/cxa-contracts';
import type {
  JourneyGraph,
  JourneyGraphStep,
  JourneyVersionSnapshot,
} from './journey-definition.js';

export interface JourneyDefinitionSource {
  getVersion(
    tenantId: string,
    journeyId: string,
    version: number,
  ): Promise<JourneyVersionSnapshot | undefined>;
}

export interface JourneyExecutionOptions {
  now?: () => Date;
  id?: () => string;
  /** lease ของ worker ต่อการ claim หนึ่งครั้ง; หมดอายุแล้ว worker อื่นหยิบต่อได้ */
  claimSeconds?: number;
}

export interface EnrollmentView {
  enrollmentId: string;
  journeyId: string;
  journeyVersion: number;
  runState: JrRunState;
  stepSequence: number;
  currentStepId?: string;
  waitUntil?: string;
  maxAgeAt?: string;
  terminalReason?: JrTerminalReason;
  terminalStepId?: string;
  terminalAt?: string;
}

export type JourneyStepOutcome =
  | { kind: 'ADVANCED'; stepId: string; nextStepId: string; enrollment: EnrollmentView }
  | { kind: 'WAITING'; stepId: string; wakeAt: string; enrollment: EnrollmentView }
  | { kind: 'AWAITING_SEND'; stepId: string; stepSequence: number; enrollment: EnrollmentView }
  | { kind: 'TERMINAL'; reason: JrTerminalReason; enrollment: EnrollmentView }
  | { kind: 'NOT_DUE'; enrollment: EnrollmentView };

export interface EnrollFromEventInput {
  receiptId: string;
  journeyId: string;
  journeyVersion: number;
  correlationId: string;
}

export interface EnrollFromScheduleInput {
  journeyId: string;
  journeyVersion: number;
  /** จุดเวลาของ occurrence ที่ scheduler ตั้งใจยิง ไม่ใช่เวลาที่ worker ตื่น */
  occurrenceAt: string;
  correlationId: string;
}

export interface AdvanceInput {
  correlationId: string;
  causationId?: string;
  /** context ของ BRANCH; ผู้เรียกเป็นคนตัดสินว่าอะไรเข้ามาได้ ที่นี่ไม่ persist ค่า */
  context?: ExpressionContext;
}

export class JourneyEnrollmentNotFoundError extends Error {
  readonly code = 'ENROLLMENT_NOT_FOUND';

  constructor(readonly enrollmentId: string) {
    super(`ไม่พบ enrollment: ${enrollmentId}`);
    this.name = 'JourneyEnrollmentNotFoundError';
  }
}

export class JourneyDefinitionNotPublishedError extends Error {
  readonly code = 'DEFINITION_NOT_PUBLISHED';

  constructor(
    readonly journeyId: string,
    readonly version: number,
  ) {
    super(`Journey version ยังไม่ publish: ${journeyId}:${version}`);
    this.name = 'JourneyDefinitionNotPublishedError';
  }
}

export class JourneyStepRaceError extends Error {
  readonly code = 'STEP_ALREADY_RUN';

  constructor(
    readonly enrollmentId: string,
    readonly stepSequence: number,
  ) {
    super(`step ${stepSequence} ของ ${enrollmentId} ถูก worker อื่นรันไปแล้ว`);
    this.name = 'JourneyStepRaceError';
  }
}

const enrollmentSelection = {
  id: true,
  journeyId: true,
  journeyVersion: true,
  runState: true,
  currentStepId: true,
  stepSequence: true,
  waitUntil: true,
  maxAgeAt: true,
  terminalReason: true,
  terminalStepId: true,
  terminalAt: true,
} as const;

type EnrollmentRow = {
  id: string;
  journeyId: string | null;
  journeyVersion: number;
  runState: JrRunState;
  currentStepId: string | null;
  stepSequence: number;
  waitUntil: Date | null;
  maxAgeAt: Date | null;
  terminalReason: JrTerminalReason | null;
  terminalStepId: string | null;
  terminalAt: Date | null;
};

function view(row: EnrollmentRow): EnrollmentView {
  return {
    enrollmentId: row.id,
    journeyId: row.journeyId ?? '',
    journeyVersion: row.journeyVersion,
    runState: row.runState,
    stepSequence: row.stepSequence,
    ...(row.currentStepId ? { currentStepId: row.currentStepId } : {}),
    ...(row.waitUntil ? { waitUntil: row.waitUntil.toISOString() } : {}),
    ...(row.maxAgeAt ? { maxAgeAt: row.maxAgeAt.toISOString() } : {}),
    ...(row.terminalReason ? { terminalReason: row.terminalReason } : {}),
    ...(row.terminalStepId ? { terminalStepId: row.terminalStepId } : {}),
    ...(row.terminalAt ? { terminalAt: row.terminalAt.toISOString() } : {}),
  };
}

function stepOf(graph: JourneyGraph, stepId: string): JourneyGraphStep {
  const step = graph.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new TypeError(`graph ไม่มี step ${stepId}`);
  return step;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class JourneyExecutionService {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly claimSeconds: number;

  constructor(
    private readonly database: PrismaClient,
    private readonly definitions: JourneyDefinitionSource,
    private readonly evaluator: ExpressionEvaluator,
    options: JourneyExecutionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.claimSeconds = options.claimSeconds ?? 60;
  }

  private async publishedGraph(
    tenantId: string,
    journeyId: string,
    version: number,
  ): Promise<JourneyVersionSnapshot> {
    const snapshot = await this.definitions.getVersion(tenantId, journeyId, version);
    if (!snapshot || snapshot.status !== 'PUBLISHED') {
      throw new JourneyDefinitionNotPublishedError(journeyId, version);
    }
    return snapshot;
  }

  /**
   * Event ingress: `(tenant_id, event_inbox_id)` เป็น unique อยู่แล้ว การเรียกซ้ำด้วย
   * receipt เดิมจึงคืน enrollment เดิมแทนที่จะเปิดใบใหม่ ถึงจะมาจากคนละ worker
   */
  async enrollFromEvent(tenantId: string, input: EnrollFromEventInput): Promise<EnrollmentView> {
    const definition = await this.publishedGraph(tenantId, input.journeyId, input.journeyVersion);
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await this.lock(transaction, `jr-enroll-event:${tenantId}:${input.receiptId}`);
      const existing = await transaction.jrEnrollment.findFirst({
        where: { tenantId, eventInboxId: input.receiptId },
        select: enrollmentSelection,
      });
      if (existing) return view(existing);

      const created = await transaction.jrEnrollment.create({
        data: {
          id: input.receiptId,
          tenantId,
          eventInboxId: input.receiptId,
          journeyId: input.journeyId,
          journeyVersion: input.journeyVersion,
          runState: 'RUNNING',
          currentStepId: definition.graph.entryStepId,
          maxAgeAt: this.maxAgeFrom(definition.maxDurationDays),
          correlationId: input.correlationId,
        },
        select: enrollmentSelection,
      });
      return view(created);
    });
  }

  /**
   * Schedule ingress: unique `(tenant, journey, version, occurrence_at)` เป็นตัวกัน cron
   * ที่ยิงซ้ำ ไม่ว่าจะจาก scheduler เอง, worker หลายตัว หรือ restart — ผู้แพ้อ่าน
   * occurrence เดิมแล้วคืน enrollment ใบเดียวกัน
   */
  async enrollFromSchedule(
    tenantId: string,
    input: EnrollFromScheduleInput,
  ): Promise<EnrollmentView> {
    const definition = await this.publishedGraph(tenantId, input.journeyId, input.journeyVersion);
    const occurrenceAt = new Date(input.occurrenceAt);
    if (Number.isNaN(occurrenceAt.getTime())) {
      throw new TypeError('occurrenceAt ต้องเป็น ISO-8601 timestamp');
    }

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await this.lock(
        transaction,
        `jr-occurrence:${tenantId}:${input.journeyId}:${input.journeyVersion}:${occurrenceAt.toISOString()}`,
      );
      const existing = await transaction.jrScheduleOccurrence.findFirst({
        where: {
          tenantId,
          journeyId: input.journeyId,
          journeyVersion: input.journeyVersion,
          occurrenceAt,
        },
        select: { id: true },
      });
      if (existing) {
        const enrollment = await transaction.jrEnrollment.findFirst({
          where: { tenantId, occurrenceId: existing.id },
          select: enrollmentSelection,
        });
        if (enrollment) return view(enrollment);
      }

      const occurrenceId = existing?.id ?? this.id();
      if (!existing) {
        await transaction.jrScheduleOccurrence.create({
          data: {
            id: occurrenceId,
            tenantId,
            journeyId: input.journeyId,
            journeyVersion: input.journeyVersion,
            occurrenceAt,
            state: 'CLAIMED',
            correlationId: input.correlationId,
          },
        });
      }

      const created = await transaction.jrEnrollment.create({
        data: {
          id: this.id(),
          tenantId,
          occurrenceId,
          journeyId: input.journeyId,
          journeyVersion: input.journeyVersion,
          runState: 'RUNNING',
          currentStepId: definition.graph.entryStepId,
          maxAgeAt: this.maxAgeFrom(definition.maxDurationDays),
          correlationId: input.correlationId,
        },
        select: enrollmentSelection,
      });
      await transaction.jrScheduleOccurrence.update({
        where: { id: occurrenceId },
        data: { state: 'ENROLLED' },
      });
      return view(created);
    });
  }

  /**
   * เดินหนึ่ง node ต่อการเรียกหนึ่งครั้ง ไม่ใช่ทั้ง graph — ผู้เรียกเป็นคนคุมจังหวะ
   * และ crash กลางทางจึงเสียแค่ node เดียวที่ยังไม่ commit
   */
  async advance(
    tenantId: string,
    enrollmentId: string,
    input: AdvanceInput,
  ): Promise<JourneyStepOutcome> {
    const head = await this.read(tenantId, enrollmentId);
    const definition = await this.publishedGraph(
      tenantId,
      head.journeyId ?? '',
      head.journeyVersion,
    );

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await this.lock(transaction, `jr-enrollment:${tenantId}:${enrollmentId}`);
      const row = await transaction.jrEnrollment.findFirst({
        where: { id: enrollmentId, tenantId },
        select: enrollmentSelection,
      });
      if (!row) throw new JourneyEnrollmentNotFoundError(enrollmentId);

      // terminal ที่มาก่อน (cancel/goal/exit) ชนะเสมอ และเช็คในทรานแซกชันเดียวกับที่จะรัน node
      if (row.runState === 'TERMINAL') {
        return {
          kind: 'TERMINAL' as const,
          reason: row.terminalReason ?? 'CANCELLED',
          enrollment: view(row),
        };
      }

      const now = this.now();
      if (row.maxAgeAt && row.maxAgeAt <= now) {
        const aged = await this.writeTerminal(transaction, tenantId, row, 'MAX_AGE', now);
        return { kind: 'TERMINAL' as const, reason: 'MAX_AGE', enrollment: view(aged) };
      }
      if (row.runState === 'WAITING' && row.waitUntil && row.waitUntil > now) {
        return { kind: 'NOT_DUE' as const, enrollment: view(row) };
      }
      if (!row.currentStepId) {
        const done = await this.writeTerminal(transaction, tenantId, row, 'GRAPH_EXIT', now);
        return { kind: 'TERMINAL' as const, reason: 'GRAPH_EXIT', enrollment: view(done) };
      }

      // SEND ที่ส่งมอบให้ C1.6 แล้วยังค้างอยู่ที่ cursor เดิม การเรียก advance ซ้ำจึงต้อง
      // เป็น replay ของ hand-off เดิม ไม่ใช่การรัน node เดิมอีกรอบ
      const parked = await this.pendingSend(transaction, tenantId, row);
      if (parked) {
        return {
          kind: 'AWAITING_SEND' as const,
          stepId: parked.stepId,
          stepSequence: parked.stepSequence,
          enrollment: view(row),
        };
      }

      const step = stepOf(definition.graph, row.currentStepId);
      const sequence = row.stepSequence + 1;

      if (step.type === 'EXIT') {
        await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
          state: 'COMPLETED',
        });
        const exited = await this.writeTerminal(transaction, tenantId, row, 'GRAPH_EXIT', now, {
          stepSequence: sequence,
          stepId: step.id,
        });
        return { kind: 'TERMINAL' as const, reason: 'GRAPH_EXIT', enrollment: view(exited) };
      }

      if (step.type === 'WAIT') {
        const wakeAt = new Date(now.getTime() + step.waitSeconds * 1_000);
        await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
          state: 'COMPLETED',
          nextStepId: step.next,
        });
        const waiting = await this.moveCursor(transaction, tenantId, row, sequence, {
          runState: 'WAITING',
          currentStepId: step.next,
          waitUntil: wakeAt,
          claimedBy: null,
          claimExpiresAt: null,
        });
        return {
          kind: 'WAITING' as const,
          stepId: step.id,
          wakeAt: wakeAt.toISOString(),
          enrollment: view(waiting),
        };
      }

      if (step.type === 'BRANCH') {
        const evaluation = this.evaluator.evaluate({
          document: step.expression,
          context: input.context ?? {},
          expectedType: 'boolean',
        });
        // BRANCH ที่ประเมินไม่ได้ต้อง fail closed ไปทาง whenFalse ไม่ใช่ค้างอยู่กับที่
        const branchResult = evaluation.status === 'OK' && evaluation.value === true;
        const nextStepId = branchResult ? step.whenTrue : step.whenFalse;
        await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
          state: 'COMPLETED',
          nextStepId,
          branchResult,
        });
        const advanced = await this.moveCursor(transaction, tenantId, row, sequence, {
          runState: 'RUNNING',
          currentStepId: nextStepId,
          waitUntil: null,
        });
        return {
          kind: 'ADVANCED' as const,
          stepId: step.id,
          nextStepId,
          enrollment: view(advanced),
        };
      }

      // SEND: C1.5 หยุดตรงนี้ ไม่แตะ Governance/Delivery — C1.6 เป็นคนต่อ
      await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
        state: 'AWAITING_SEND',
        nextStepId: step.next,
      });
      const pending = await this.moveCursor(transaction, tenantId, row, sequence, {
        runState: 'RUNNING',
        currentStepId: step.id,
        waitUntil: null,
      });
      return {
        kind: 'AWAITING_SEND' as const,
        stepId: step.id,
        stepSequence: sequence,
        enrollment: view(pending),
      };
    });
  }

  /**
   * หยิบงานที่ถึงเวลาแล้วด้วย `FOR UPDATE SKIP LOCKED` + lease: worker หลายตัวจึงแบ่ง
   * งานกันได้โดยไม่ต้องคุยกัน และงานของ worker ที่ตายจะกลับเข้าคิวเมื่อ lease หมด
   */
  async claimDueWork(
    tenantId: string,
    options: { workerId: string; limit?: number } = { workerId: 'worker' },
  ): Promise<string[]> {
    const limit = options.limit ?? 10;
    const now = this.now();
    const claimExpiresAt = new Date(now.getTime() + this.claimSeconds * 1_000);

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const due = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM jr_enrollments
        WHERE tenant_id = ${tenantId}::uuid
          AND run_state <> 'TERMINAL'
          AND (run_state = 'RUNNING' OR wait_until <= ${now})
          AND (claim_expires_at IS NULL OR claim_expires_at <= ${now})
        ORDER BY wait_until NULLS FIRST, created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      if (due.length === 0) return [];

      const ids = due.map((row) => row.id);
      await transaction.jrEnrollment.updateMany({
        where: { tenantId, id: { in: ids } },
        data: { claimedBy: options.workerId, claimExpiresAt },
      });
      return ids;
    });
  }

  /**
   * durable state contract ที่ C1.6 จะเรียกเมื่อ SEND ถูกส่งมอบสำเร็จ — ที่นี่ไม่รู้และ
   * ไม่สนใจว่า Governance/Delivery ทำอะไร รู้แค่ว่า cursor เดินต่อได้แล้ว
   */
  async completeSend(
    tenantId: string,
    enrollmentId: string,
    input: AdvanceInput,
  ): Promise<JourneyStepOutcome> {
    const head = await this.read(tenantId, enrollmentId);
    const definition = await this.publishedGraph(
      tenantId,
      head.journeyId ?? '',
      head.journeyVersion,
    );

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await this.lock(transaction, `jr-enrollment:${tenantId}:${enrollmentId}`);
      const row = await transaction.jrEnrollment.findFirst({
        where: { id: enrollmentId, tenantId },
        select: enrollmentSelection,
      });
      if (!row) throw new JourneyEnrollmentNotFoundError(enrollmentId);
      if (row.runState === 'TERMINAL') {
        return {
          kind: 'TERMINAL' as const,
          reason: row.terminalReason ?? 'CANCELLED',
          enrollment: view(row),
        };
      }

      const parked = await this.pendingSend(transaction, tenantId, row);
      if (!parked) throw new JourneyStepRaceError(enrollmentId, row.stepSequence);

      const step = stepOf(definition.graph, parked.stepId);
      if (step.type !== 'SEND') throw new TypeError(`step ${step.id} ไม่ใช่ SEND`);

      const sequence = row.stepSequence + 1;
      await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
        state: 'COMPLETED',
        nextStepId: step.next,
      });
      const advanced = await this.moveCursor(transaction, tenantId, row, sequence, {
        runState: 'RUNNING',
        currentStepId: step.next,
        waitUntil: null,
      });
      return {
        kind: 'ADVANCED' as const,
        stepId: step.id,
        nextStepId: step.next,
        enrollment: view(advanced),
      };
    });
  }

  private async pendingSend(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    row: EnrollmentRow,
  ): Promise<{ stepId: string; stepSequence: number } | undefined> {
    if (row.stepSequence === 0) return undefined;
    const last = await transaction.jrStepRun.findFirst({
      where: { tenantId, enrollmentId: row.id, stepSequence: row.stepSequence },
      select: { state: true, stepId: true, stepSequence: true },
    });
    if (!last || last.state !== 'AWAITING_SEND' || last.stepId !== row.currentStepId) {
      return undefined;
    }
    return { stepId: last.stepId, stepSequence: last.stepSequence };
  }

  /** ยกเลิกจากภายนอก — ชนะงานที่ยังไม่ submit เสมอ และเก็บเหตุผลไว้ครั้งเดียว */
  cancel(tenantId: string, enrollmentId: string): Promise<EnrollmentView> {
    return this.terminate(tenantId, enrollmentId, 'CANCELLED');
  }

  /** goal สำเร็จ — enrollment ที่เหลือไม่ต้องเดินต่อ */
  reachGoal(tenantId: string, enrollmentId: string): Promise<EnrollmentView> {
    return this.terminate(tenantId, enrollmentId, 'GOAL_REACHED');
  }

  /** exit rule ยิงจากภายนอก (event หรือ higher-priority journey) */
  applyExitRule(tenantId: string, enrollmentId: string): Promise<EnrollmentView> {
    return this.terminate(tenantId, enrollmentId, 'EXIT_RULE');
  }

  /** ปิด enrollment ที่เกิน max age ทั้งชุด — idempotent ต่อ enrollment ที่จบไปแล้ว */
  async sweepMaxAge(tenantId: string, limit = 50): Promise<EnrollmentView[]> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const expired = await transaction.jrEnrollment.findMany({
        where: {
          tenantId,
          runState: { not: 'TERMINAL' },
          maxAgeAt: { lte: now },
        },
        select: enrollmentSelection,
        orderBy: { maxAgeAt: 'asc' },
        take: limit,
      });
      const closed: EnrollmentView[] = [];
      for (const row of expired) {
        closed.push(view(await this.writeTerminal(transaction, tenantId, row, 'MAX_AGE', now)));
      }
      return closed;
    });
  }

  private async read(tenantId: string, enrollmentId: string): Promise<EnrollmentRow> {
    const row = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrEnrollment.findFirst({
        where: { id: enrollmentId, tenantId },
        select: enrollmentSelection,
      }),
    );
    if (!row) throw new JourneyEnrollmentNotFoundError(enrollmentId);
    return row;
  }

  /** อ่านสถานะปัจจุบันเป็น evidence ที่ปลอดภัย — ไม่มี payload หรือ context ติดออกมา */
  async describe(tenantId: string, enrollmentId: string): Promise<EnrollmentView> {
    return view(await this.read(tenantId, enrollmentId));
  }

  private async terminate(
    tenantId: string,
    enrollmentId: string,
    reason: JrTerminalReason,
  ): Promise<EnrollmentView> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await this.lock(transaction, `jr-enrollment:${tenantId}:${enrollmentId}`);
      const row = await transaction.jrEnrollment.findFirst({
        where: { id: enrollmentId, tenantId },
        select: enrollmentSelection,
      });
      if (!row) throw new JourneyEnrollmentNotFoundError(enrollmentId);
      return view(await this.writeTerminal(transaction, tenantId, row, reason, this.now()));
    });
  }

  /** terminal แรกชนะ: แถวที่จบแล้วคืนค่าเดิมโดยไม่เขียนทับเหตุผลหรือเวลา */
  private async writeTerminal(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    row: EnrollmentRow,
    reason: JrTerminalReason,
    now: Date,
    at: { stepSequence?: number; stepId?: string } = {},
  ): Promise<EnrollmentRow> {
    if (row.runState === 'TERMINAL') return row;
    const updated = await transaction.jrEnrollment.updateMany({
      where: { tenantId, id: row.id, runState: { not: 'TERMINAL' } },
      data: {
        runState: 'TERMINAL',
        terminalReason: reason,
        terminalAt: now,
        terminalStepId: at.stepId ?? row.currentStepId,
        waitUntil: null,
        claimedBy: null,
        claimExpiresAt: null,
        ...(at.stepSequence ? { stepSequence: at.stepSequence } : {}),
      },
    });
    if (updated.count === 0) {
      // worker อื่นปิดไปก่อนแล้ว — เหตุผลของเขาเป็นตัวจริง
      return transaction.jrEnrollment.findFirstOrThrow({
        where: { id: row.id, tenantId },
        select: enrollmentSelection,
      });
    }
    return transaction.jrEnrollment.findFirstOrThrow({
      where: { id: row.id, tenantId },
      select: enrollmentSelection,
    });
  }

  /**
   * ledger เป็นตัวกันการรันซ้ำ ไม่ใช่การอ่านก่อนเขียน: worker ที่แพ้จะชน unique
   * `(enrollment_id, step_sequence)` แล้วรู้ว่า node นี้มีคนรันไปแล้ว
   */
  private async recordStepRun(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    row: EnrollmentRow,
    stepSequence: number,
    step: JourneyGraphStep,
    input: AdvanceInput,
    outcome: {
      state: 'COMPLETED' | 'AWAITING_SEND';
      nextStepId?: string;
      branchResult?: boolean;
    },
  ): Promise<void> {
    try {
      await transaction.jrStepRun.create({
        data: {
          id: this.id(),
          tenantId,
          enrollmentId: row.id,
          stepSequence,
          stepId: step.id,
          stepType: step.type,
          state: outcome.state,
          ...(outcome.nextStepId ? { nextStepId: outcome.nextStepId } : {}),
          ...(outcome.branchResult === undefined ? {} : { branchResult: outcome.branchResult }),
          correlationId: input.correlationId,
          ...(input.causationId ? { causationId: input.causationId } : {}),
          startedAt: this.now(),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new JourneyStepRaceError(row.id, stepSequence);
      throw error;
    }
  }

  /** CAS ที่ step_sequence: cursor เดินได้ต่อเมื่อยังอยู่ตำแหน่งที่เราอ่านมา */
  private async moveCursor(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    row: EnrollmentRow,
    stepSequence: number,
    data: {
      runState: JrRunState;
      currentStepId: string;
      waitUntil: Date | null;
      claimedBy?: null;
      claimExpiresAt?: null;
    },
  ): Promise<EnrollmentRow> {
    const updated = await transaction.jrEnrollment.updateMany({
      where: {
        tenantId,
        id: row.id,
        stepSequence: row.stepSequence,
        runState: { not: 'TERMINAL' },
      },
      data: { ...data, stepSequence },
    });
    if (updated.count === 0) throw new JourneyStepRaceError(row.id, stepSequence);
    return transaction.jrEnrollment.findFirstOrThrow({
      where: { id: row.id, tenantId },
      select: enrollmentSelection,
    });
  }

  private maxAgeFrom(maxDurationDays: number): Date {
    return new Date(this.now().getTime() + maxDurationDays * 24 * 60 * 60 * 1_000);
  }

  private async lock(transaction: Prisma.TransactionClient, key: string): Promise<void> {
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${key}))`,
    );
  }
}
