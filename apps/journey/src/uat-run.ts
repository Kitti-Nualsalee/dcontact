/**
 * Owner: Journey authoring API + UAT control — UAT fixture pack และ run record (U1.1 #429)
 *
 * Authority: Phase Contract #374, fixture/reset #376, evidence #379, boundary #378
 *
 * - server เป็นเจ้าของ run ทั้งหมด: browser ส่งได้แค่ opaque id/ค่าที่ผู้ทดสอบกรอก ไม่เป็น authority ของ
 *   tenant, สิทธิ์ หรือผล
 * - `เริ่มรอบใหม่` ปิด run เดิมเป็น `COMPLETED`/`ABANDONED` แล้วสร้าง run + Journey draft ใหม่ผ่าน J5 เดิม
 *   (สิทธิ์/rollout/audit ของ J5 ครบ) โดยไม่ลบอะไรของรอบก่อน และ resume ได้ด้วย key เดิมหลัง crash
 * - Journey ของ run ที่ปิดแล้วถูก `UatJourneyWriteGuard` ปิดทุก mutation — candidate เดิม review/publish
 *   ต่อไม่ได้ โดย J5 semantics อื่นไม่เปลี่ยน
 * - สิทธิ์ UAT-only มาจาก fixture pack ที่ operator provision: maker ของ pack เท่านั้นที่เริ่มรอบใหม่ได้
 */
import { randomUUID } from 'node:crypto';
import type { SimulationFixtureV1 } from '@d-contact/cxa-contracts';
import { withTenantDatabaseTransaction, type Prisma, type PrismaClient } from '@d-contact/db';
import { journeyAuthoringDigest } from './journey-authoring-canonical.js';
import { JourneyAuthoringError, type JourneyAuthoringActor } from './journey-authoring-model.js';
import type {
  JourneyAuthoringWriteGuard,
  JourneyCommandContext,
} from './journey-authoring-repository.js';

type Tx = Prisma.TransactionClient;

// ── Errors ────────────────────────────────────────────────────────────────

export const UAT_RUN_HTTP_STATUS = Object.freeze({
  VALIDATION_FAILED: 400,
  UAT_CAPABILITY_REQUIRED: 403,
  UAT_RUN_NOT_FOUND: 404,
  FIXTURE_PACK_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  UAT_RUN_CLOSED: 409,
  UAT_RUN_PENDING_REVIEW: 409,
  UAT_RUN_PENDING_PUBLISH: 409,
  UAT_RUN_MUTATION_IN_FLIGHT: 409,
  FIXTURE_PACK_DIGEST_MISMATCH: 409,
  FIXTURE_MANIFEST_INVALID: 422,
  FIXTURE_PREFLIGHT_FAILED: 422,
});
export type UatRunErrorCode = keyof typeof UAT_RUN_HTTP_STATUS;

export class UatRunError extends Error {
  constructor(
    readonly code: UatRunErrorCode,
    readonly safeParams?: Readonly<Record<string, string | number>>,
  ) {
    super(`uat run: ${code}`);
    this.name = 'UatRunError';
  }

  get httpStatus(): number {
    return UAT_RUN_HTTP_STATUS[this.code];
  }
}

// ── Fixture manifest ──────────────────────────────────────────────────────

export const UAT_STATE_LABELS = ['REAL_STATE', 'SIMULATION_ONLY'] as const;
export type UatStateLabelV1 = (typeof UAT_STATE_LABELS)[number];

export interface UatScenarioStepV1 {
  readonly stepId: string;
  readonly title: string;
  readonly expected: string;
  readonly stateLabel: UatStateLabelV1;
}

/** manifest สังเคราะห์ล้วน — opaque refs เท่านั้น ไม่มี secret/PII (#376) */
export interface UatFixturePackManifestV1 {
  readonly schema: 'UatFixturePackV1';
  readonly environment: string;
  readonly packVersion: string;
  readonly buildSha: string;
  readonly tenantId: string;
  readonly ownerTeamId: string;
  readonly makerSubjectId: string;
  readonly reviewerSubjectId: string;
  readonly senderRef: string;
  readonly contentRef: string;
  /** AuthoringDocumentV1 เริ่มต้นของแต่ละ run — J5 validate ตอนสร้าง draft */
  readonly baselineDocument: Readonly<Record<string, unknown>>;
  readonly simulationFixture: SimulationFixtureV1;
  readonly steps: readonly UatScenarioStepV1[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STEP_ID = /^[A-Z][A-Z0-9_-]{1,63}$/;
/** ข้อมูลจริง/secret ที่ต้องไม่อยู่ใน fixture — พบ = manifest ใช้ไม่ได้ */
const FORBIDDEN_CONTENT: ReadonlyArray<[string, RegExp]> = [
  ['EMAIL', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['JWT', /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/],
  ['BEARER', /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/i],
  ['PHONE', /(?<![0-9A-Za-z-])(?:\+66|0)[1-9][0-9]{7,8}(?![0-9])/],
];

function invalid(field: string): never {
  throw new UatRunError('FIXTURE_MANIFEST_INVALID', { field });
}

function text(value: unknown, field: string, pattern: RegExp): string {
  if (typeof value !== 'string' || !pattern.test(value)) invalid(field);
  return value;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function parseSimulationFixture(value: unknown): SimulationFixtureV1 {
  const fixture = record(value, 'simulationFixture');
  const startAt = text(fixture.startAt, 'simulationFixture.startAt', /^\d{4}-\d{2}-\d{2}T/);
  if (Number.isNaN(Date.parse(startAt))) invalid('simulationFixture.startAt');
  const context = record(fixture.context, 'simulationFixture.context');
  for (const [key, entry] of Object.entries(context)) {
    if (entry !== null && !['string', 'number', 'boolean'].includes(typeof entry)) {
      invalid(`simulationFixture.context.${key}`);
    }
  }
  const outcomes = (name: 'sendOutcomes' | 'ownerOutcomes', allowed: readonly string[]) => {
    if (fixture[name] === undefined) return undefined;
    const entries = record(fixture[name], `simulationFixture.${name}`);
    for (const [key, entry] of Object.entries(entries)) {
      if (typeof entry !== 'string' || !allowed.includes(entry)) {
        invalid(`simulationFixture.${name}.${key}`);
      }
    }
    return entries;
  };
  const sendOutcomes = outcomes('sendOutcomes', ['SENT', 'SUPPRESSED', 'SCOPE_DENIED']);
  const ownerOutcomes = outcomes('ownerOutcomes', ['ACCEPTED', 'REJECTED']);
  return {
    fixtureId: text(fixture.fixtureId, 'simulationFixture.fixtureId', OPAQUE),
    startAt,
    seed: text(fixture.seed, 'simulationFixture.seed', OPAQUE),
    context: context as SimulationFixtureV1['context'],
    ...(sendOutcomes ? { sendOutcomes: sendOutcomes as SimulationFixtureV1['sendOutcomes'] } : {}),
    ...(ownerOutcomes
      ? { ownerOutcomes: ownerOutcomes as SimulationFixtureV1['ownerOutcomes'] }
      : {}),
  };
}

export function parseUatFixturePackManifest(value: unknown): UatFixturePackManifestV1 {
  const manifest = record(value, 'manifest');
  if (manifest.schema !== 'UatFixturePackV1') invalid('schema');
  const serialized = JSON.stringify(manifest);
  for (const [kind, pattern] of FORBIDDEN_CONTENT) {
    if (pattern.test(serialized)) throw new UatRunError('FIXTURE_MANIFEST_INVALID', { kind });
  }
  if (!Array.isArray(manifest.steps) || manifest.steps.length < 1 || manifest.steps.length > 60) {
    invalid('steps');
  }
  const steps = manifest.steps.map((entry, index) => {
    const step = record(entry, `steps.${index}`);
    const stateLabel = step.stateLabel as UatStateLabelV1;
    if (!UAT_STATE_LABELS.includes(stateLabel)) invalid(`steps.${index}.stateLabel`);
    return {
      stepId: text(step.stepId, `steps.${index}.stepId`, STEP_ID),
      title: text(step.title, `steps.${index}.title`, /^[\s\S]{1,200}$/),
      expected: text(step.expected, `steps.${index}.expected`, /^[\s\S]{1,2000}$/),
      stateLabel,
    };
  });
  if (new Set(steps.map((step) => step.stepId)).size !== steps.length) invalid('steps.stepId');
  const makerSubjectId = text(manifest.makerSubjectId, 'makerSubjectId', OPAQUE);
  const reviewerSubjectId = text(manifest.reviewerSubjectId, 'reviewerSubjectId', OPAQUE);
  // maker-checker ต้องเป็นคนละบัญชี (#372)
  if (makerSubjectId === reviewerSubjectId) invalid('reviewerSubjectId');
  return {
    schema: 'UatFixturePackV1',
    environment: text(manifest.environment, 'environment', /^[a-z0-9][a-z0-9-]{0,62}$/),
    packVersion: text(manifest.packVersion, 'packVersion', /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/),
    buildSha: text(manifest.buildSha, 'buildSha', /^[a-f0-9]{7,64}$/),
    tenantId: text(manifest.tenantId, 'tenantId', UUID),
    ownerTeamId: text(manifest.ownerTeamId, 'ownerTeamId', UUID),
    makerSubjectId,
    reviewerSubjectId,
    senderRef: text(manifest.senderRef, 'senderRef', OPAQUE),
    contentRef: text(manifest.contentRef, 'contentRef', OPAQUE),
    baselineDocument: record(manifest.baselineDocument, 'baselineDocument'),
    simulationFixture: parseSimulationFixture(manifest.simulationFixture),
    steps,
  };
}

export function uatFixturePackDigest(manifest: UatFixturePackManifestV1): string {
  return journeyAuthoringDigest(manifest);
}

// ── Provisioning (UAT operator) ────────────────────────────────────────────

const MAKER_CAPABILITIES = ['journey.read', 'journey.edit', 'journey.publish'] as const;
const REVIEWER_CAPABILITIES = ['journey.read', 'journey.review'] as const;

export interface UatFixtureProvisionResult {
  status: 'CREATED' | 'UNCHANGED';
  fixturePackId: string;
  digest: string;
}

/**
 * provision fixture pack ด้วย connection ของ UAT operator (ไม่ใช่ app role — app role เขียน pack ไม่ได้)
 * idempotent ต่อ environment + tenant + pack version; digest ต่าง = fail closed; preflight ไม่ผ่าน = ไม่เขียน
 * ไม่แตะ run/Journey ที่ผู้ทดสอบทำไว้
 */
export class UatFixtureProvisioner {
  constructor(
    private readonly database: PrismaClient,
    private readonly id: () => string = randomUUID,
  ) {}

  async provision(value: unknown): Promise<UatFixtureProvisionResult> {
    const manifest = parseUatFixturePackManifest(value);
    const digest = uatFixturePackDigest(manifest);
    return this.database.$transaction(async (tx) => {
      const existing = await tx.uatFixturePack.findUnique({
        where: {
          tenantId_environment_packVersion: {
            tenantId: manifest.tenantId,
            environment: manifest.environment,
            packVersion: manifest.packVersion,
          },
        },
      });
      if (existing) {
        if (existing.digest !== digest) throw new UatRunError('FIXTURE_PACK_DIGEST_MISMATCH');
        return { status: 'UNCHANGED' as const, fixturePackId: existing.id, digest };
      }
      await this.preflight(tx, manifest);
      const fixturePackId = this.id();
      await tx.uatFixturePack.create({
        data: {
          id: fixturePackId,
          tenantId: manifest.tenantId,
          environment: manifest.environment,
          packVersion: manifest.packVersion,
          digest,
          buildSha: manifest.buildSha,
          manifest: manifest as unknown as Prisma.InputJsonValue,
        },
      });
      return { status: 'CREATED' as const, fixturePackId, digest };
    });
  }

  private async preflight(tx: Tx, manifest: UatFixturePackManifestV1) {
    const fail = (check: string): never => {
      throw new UatRunError('FIXTURE_PREFLIGHT_FAILED', { check });
    };
    const tenantId = manifest.tenantId;
    if (!(await tx.tenant.findUnique({ where: { id: tenantId }, select: { id: true } }))) {
      fail('TENANT_BINDING');
    }
    const team = await tx.team.findFirst({
      where: { id: manifest.ownerTeamId, tenantId },
      select: { id: true },
    });
    if (!team) fail('OWNER_TEAM');
    const rollout = await tx.jrAuthoringRolloutState.findUnique({ where: { tenantId } });
    if (
      !rollout ||
      rollout.stage === 'DISABLED' ||
      rollout.mutationFrozen ||
      !rollout.canvasWriteEnabled ||
      !rollout.publishUiEnabled
    ) {
      fail('AUTHORING_ROLLOUT');
    }
    const grants = async (subjectId: string, capabilities: readonly string[], check: string) => {
      const subject = await tx.iamAuthoringSubject.findUnique({
        where: { tenantId_subjectId: { tenantId, subjectId } },
      });
      if (!subject || subject.isServicePrincipal) fail(check);
      const found = await tx.iamAuthoringCapabilityGrant.findMany({
        where: {
          tenantId,
          subjectId,
          capability: { in: [...capabilities] },
          scopeKind: 'TEAM',
          scopeId: manifest.ownerTeamId,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: { capability: true },
      });
      const held = new Set(found.map((grant) => grant.capability));
      if (!capabilities.every((capability) => held.has(capability))) fail(check);
    };
    await grants(manifest.makerSubjectId, MAKER_CAPABILITIES, 'MAKER_GRANTS');
    await grants(manifest.reviewerSubjectId, REVIEWER_CAPABILITIES, 'REVIEWER_GRANTS');
  }
}

// ── Run record ────────────────────────────────────────────────────────────

export interface UatStepResultView {
  stepId: string;
  outcome: 'PASS' | 'FAIL' | 'BLOCKED';
  expected: string;
  actual: string;
  severity: 'S1' | 'S2' | 'S3' | 'S4' | null;
  correlationId: string | null;
  stateLabel: UatStateLabelV1;
  recordedByRef: string;
  recordedAt: string;
}

export interface UatRunView {
  runId: string;
  sequence: number;
  lifecycle: 'ACTIVE' | 'COMPLETED' | 'ABANDONED';
  revision: number;
  journeyId: string | null;
  fixturePack: { environment: string; packVersion: string; digest: string; buildSha: string };
  steps: readonly UatScenarioStepV1[];
  openedAt: string;
  closedAt: string | null;
  stepResults: UatStepResultView[];
}

export interface StartUatRunInput {
  readonly environment: string;
  readonly packVersion: string;
  /** revision ของ run ที่ ACTIVE อยู่ หรือ 0 เมื่อยังไม่มี */
  readonly expectedRevision: number;
}

export interface RecordUatStepResultInput {
  readonly runId: string;
  readonly stepId: string;
  readonly outcome: 'PASS' | 'FAIL' | 'BLOCKED';
  readonly actual: string;
  readonly severity?: 'S1' | 'S2' | 'S3' | 'S4';
  readonly correlationId?: string;
}

/** ส่วนของ J5 ที่ run ใช้สร้าง Journey draft — ผ่านสิทธิ์/rollout/audit ของ J5 ตามปกติ */
export interface UatJourneyAuthoringPort {
  createJourneyDraft(
    context: JourneyCommandContext,
    input: { readonly ownerTeamId: string; readonly document: unknown },
  ): Promise<{ journeyId: string }>;
}

type PackRow = Awaited<ReturnType<Tx['uatFixturePack']['findFirstOrThrow']>>;
type RunRow = Awaited<ReturnType<Tx['uatRun']['findFirstOrThrow']>>;

function manifestOf(pack: PackRow): UatFixturePackManifestV1 {
  return pack.manifest as unknown as UatFixturePackManifestV1;
}

function isParticipant(manifest: UatFixturePackManifestV1, actor: JourneyAuthoringActor): boolean {
  return [manifest.makerSubjectId, manifest.reviewerSubjectId].includes(actor.subjectId);
}

/** unique ของ run ACTIVE/sequence ชนกัน = มีอีกคำสั่งเปิด run ไปก่อน */
function uniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'P2002';
}

export class UatRunRepository {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly authoring: UatJourneyAuthoringPort,
    options: { now?: () => Date; id?: () => string } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  private scoped<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantDatabaseTransaction(this.database, tenantId, work);
  }

  // ── Reads ──

  async current(tenantId: string, actor: JourneyAuthoringActor): Promise<UatRunView> {
    return this.scoped(tenantId, async (tx) => {
      const run = await tx.uatRun.findFirst({ where: { tenantId, lifecycle: 'ACTIVE' } });
      if (!run) throw new UatRunError('UAT_RUN_NOT_FOUND');
      return this.view(tx, run, actor);
    });
  }

  async get(tenantId: string, actor: JourneyAuthoringActor, runId: string): Promise<UatRunView> {
    return this.scoped(tenantId, async (tx) => {
      const run = UUID.test(runId)
        ? await tx.uatRun.findUnique({ where: { tenantId_id: { tenantId, id: runId } } })
        : null;
      if (!run) throw new UatRunError('UAT_RUN_NOT_FOUND');
      return this.view(tx, run, actor);
    });
  }

  async history(
    tenantId: string,
    actor: JourneyAuthoringActor,
    input: { limit: number; beforeSequence?: number },
  ): Promise<{ items: UatRunView[]; nextCursor: number | null }> {
    return this.scoped(tenantId, async (tx) => {
      const runs = await tx.uatRun.findMany({
        where: {
          tenantId,
          ...(input.beforeSequence ? { sequence: { lt: input.beforeSequence } } : {}),
        },
        orderBy: { sequence: 'desc' },
        take: input.limit + 1,
      });
      const items: UatRunView[] = [];
      for (const run of runs.slice(0, input.limit)) {
        const manifest = manifestOf(await this.pack(tx, run));
        if (isParticipant(manifest, actor)) items.push(await this.view(tx, run, actor));
      }
      const last = runs.slice(0, input.limit).at(-1);
      return { items, nextCursor: runs.length > input.limit && last ? last.sequence : null };
    });
  }

  /** fixture ที่ server ตรึงไว้ของ run ปัจจุบัน — Console ใช้แทนการสร้าง startAt/seed เอง */
  async simulationFixture(
    tenantId: string,
    actor: JourneyAuthoringActor,
  ): Promise<{ runId: string; fixture: SimulationFixtureV1 }> {
    return this.scoped(tenantId, async (tx) => {
      const run = await tx.uatRun.findFirst({ where: { tenantId, lifecycle: 'ACTIVE' } });
      if (!run) throw new UatRunError('UAT_RUN_NOT_FOUND');
      const pack = await this.pack(tx, run);
      this.assertParticipant(manifestOf(pack), actor);
      return { runId: run.id, fixture: manifestOf(pack).simulationFixture };
    });
  }

  // ── Commands ──

  async recordStepResult(
    context: JourneyCommandContext,
    input: RecordUatStepResultInput,
  ): Promise<UatStepResultView> {
    const requestHash = journeyAuthoringDigest({
      command: 'RecordUatStepResult',
      actor: context.actor.subjectId,
      input,
    });
    return this.scoped(context.tenantId, async (tx) => {
      const replay = await this.replay(tx, context, requestHash);
      if (replay) return replay as unknown as UatStepResultView;
      const run = UUID.test(input.runId)
        ? await tx.uatRun.findUnique({
            where: { tenantId_id: { tenantId: context.tenantId, id: input.runId } },
          })
        : null;
      if (!run) throw new UatRunError('UAT_RUN_NOT_FOUND');
      const manifest = manifestOf(await this.pack(tx, run));
      this.assertParticipant(manifest, context.actor);
      if (run.lifecycle !== 'ACTIVE') throw new UatRunError('UAT_RUN_CLOSED');
      const step = manifest.steps.find((entry) => entry.stepId === input.stepId);
      if (!step) throw new UatRunError('VALIDATION_FAILED', { field: 'stepId' });
      if ((input.outcome === 'FAIL') !== (input.severity !== undefined)) {
        throw new UatRunError('VALIDATION_FAILED', { field: 'severity' });
      }
      const recordedAt = this.now();
      await tx.uatRunStepResult.create({
        data: {
          id: this.id(),
          tenantId: context.tenantId,
          runId: run.id,
          stepId: step.stepId,
          outcome: input.outcome,
          // expected มาจาก step catalog ที่ตรึงใน pack ไม่ใช่จาก browser
          expected: step.expected,
          actual: input.actual,
          severity: input.severity ?? null,
          correlationId: input.correlationId ?? null,
          stateLabel: step.stateLabel,
          recordedByRef: context.actor.subjectId,
          recordedAt,
        },
      });
      const view: UatStepResultView = {
        stepId: step.stepId,
        outcome: input.outcome,
        expected: step.expected,
        actual: input.actual,
        severity: input.severity ?? null,
        correlationId: input.correlationId ?? null,
        stateLabel: step.stateLabel,
        recordedByRef: context.actor.subjectId,
        recordedAt: recordedAt.toISOString(),
      };
      await this.complete(tx, context, 'RecordUatStepResult', requestHash, null, view);
      return view;
    });
  }

  /**
   * `เริ่มรอบใหม่` — ปิด run เดิมแล้วเปิด run + Journey draft ใหม่ แบ่งเป็น 3 ช่วงที่ resume ได้:
   * 1. transaction: ตรวจ key/revision/งานค้าง → ปิด run เดิม → สร้าง run ใหม่ + receipt ที่ยังไม่จบ
   * 2. สร้าง Journey draft ผ่าน J5 ด้วย key ที่ derive จาก run (J5 replay ได้ Journey เดิม)
   * 3. transaction: ผูก Journey กับ run แล้วปิด receipt
   * crash ระหว่างทาง → เรียกซ้ำด้วย key เดิมทำต่อจากช่วงที่ค้าง ไม่สร้าง run ซ้ำ
   */
  async startNewRun(context: JourneyCommandContext, input: StartUatRunInput): Promise<UatRunView> {
    const requestHash = journeyAuthoringDigest({
      command: 'StartUatRun',
      // key เดียวกันจากผู้ใช้อื่นต้องไม่ replay/resume คำสั่งของ maker
      actor: context.actor.subjectId,
      input,
    });
    const opened = await this.openRun(context, input, requestHash);
    if ('done' in opened) return opened.done;
    const runId = opened.runId;

    const manifest = await this.scoped(context.tenantId, async (tx) => {
      const run = await tx.uatRun.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: context.tenantId, id: runId } },
      });
      return manifestOf(await this.pack(tx, run));
    });
    const draft = await this.authoring.createJourneyDraft(
      { tenantId: context.tenantId, actor: context.actor, idempotencyKey: `uat-run-${runId}` },
      { ownerTeamId: manifest.ownerTeamId, document: manifest.baselineDocument },
    );

    return this.scoped(context.tenantId, async (tx) => {
      const run = await tx.uatRun.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: context.tenantId, id: runId } },
      });
      const bound =
        run.journeyId === null
          ? await tx.uatRun.update({
              where: { id: run.id },
              data: { journeyId: draft.journeyId, revision: run.revision + 1 },
            })
          : run;
      const view = await this.view(tx, bound, context.actor);
      await this.complete(tx, context, 'StartUatRun', requestHash, runId, view);
      return view;
    });
  }

  // ── Internals ──

  /** ช่วงที่ 1 ของ `เริ่มรอบใหม่` — ทั้งหมดใน transaction เดียว */
  private async openRun(
    context: JourneyCommandContext,
    input: StartUatRunInput,
    requestHash: string,
  ): Promise<{ done: UatRunView } | { runId: string }> {
    try {
      return await this.scoped(context.tenantId, async (tx) => {
        const receipt = await tx.uatCommandReceipt.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: context.tenantId,
              idempotencyKey: context.idempotencyKey,
            },
          },
        });
        if (receipt) {
          if (receipt.requestHash !== requestHash || receipt.commandName !== 'StartUatRun') {
            throw new UatRunError('IDEMPOTENCY_CONFLICT');
          }
          if (receipt.response) return { done: receipt.response as unknown as UatRunView };
          return { runId: receipt.runId! };
        }
        const pack = await tx.uatFixturePack.findUnique({
          where: {
            tenantId_environment_packVersion: {
              tenantId: context.tenantId,
              environment: input.environment,
              packVersion: input.packVersion,
            },
          },
        });
        if (!pack) throw new UatRunError('FIXTURE_PACK_NOT_FOUND');
        // UAT-only capability: maker ของ pack เท่านั้น (#376)
        if (manifestOf(pack).makerSubjectId !== context.actor.subjectId) {
          throw new UatRunError('UAT_CAPABILITY_REQUIRED');
        }
        await tx.$queryRaw`SELECT id FROM uat_runs WHERE tenant_id = ${context.tenantId}::uuid AND lifecycle = 'ACTIVE' FOR UPDATE`;
        const active = await tx.uatRun.findFirst({
          where: { tenantId: context.tenantId, lifecycle: 'ACTIVE' },
        });
        if ((active?.revision ?? 0) !== input.expectedRevision) {
          throw new UatRunError('REVISION_CONFLICT', { currentRevision: active?.revision ?? 0 });
        }
        const now = this.now();
        if (active) await this.close(tx, context, active, now);
        const latest = await tx.uatRun.findFirst({
          where: { tenantId: context.tenantId },
          orderBy: { sequence: 'desc' },
          select: { sequence: true },
        });
        const runId = this.id();
        await tx.uatRun.create({
          data: {
            id: runId,
            tenantId: context.tenantId,
            fixturePackId: pack.id,
            sequence: (latest?.sequence ?? 0) + 1,
            openedByRef: context.actor.subjectId,
            openedAt: now,
          },
        });
        await tx.uatCommandReceipt.create({
          data: {
            id: this.id(),
            tenantId: context.tenantId,
            idempotencyKey: context.idempotencyKey,
            commandName: 'StartUatRun',
            requestHash,
            runId,
          },
        });
        return { runId };
      });
    } catch (error) {
      if (uniqueViolation(error)) throw new UatRunError('REVISION_CONFLICT');
      throw error;
    }
  }

  /** run เดิมที่มีงานค้างปิดไม่ได้ — ต้อง resolve ผ่าน Journey Console ก่อน (#376) */
  private async close(tx: Tx, context: JourneyCommandContext, run: RunRow, now: Date) {
    if (!run.journeyId) {
      throw new UatRunError('UAT_RUN_MUTATION_IN_FLIGHT', { nextSafeAction: 'RETRY_START' });
    }
    const where = {
      tenantId: run.tenantId,
      resourceKind: 'JOURNEY' as const,
      resourceId: run.journeyId,
    };
    const open = await tx.jrReviewCandidate.findFirst({
      where: { ...where, state: { in: ['IN_REVIEW', 'APPROVED'] } },
      select: { state: true },
    });
    if (open?.state === 'IN_REVIEW') {
      throw new UatRunError('UAT_RUN_PENDING_REVIEW', { nextSafeAction: 'DECIDE_REVIEW' });
    }
    if (open?.state === 'APPROVED') {
      throw new UatRunError('UAT_RUN_PENDING_PUBLISH', {
        nextSafeAction: 'PUBLISH_OR_EDIT_DRAFT',
      });
    }
    const inFlight = await tx.jrAuthoringCommandReceipt.findFirst({
      where: { ...where, state: 'PENDING' },
      select: { id: true },
    });
    if (inFlight) {
      throw new UatRunError('UAT_RUN_MUTATION_IN_FLIGHT', {
        nextSafeAction: 'RESOLVE_PENDING_COMMAND',
      });
    }
    const head = await tx.jrJourneyHead.findUnique({
      where: { tenantId_journeyId: { tenantId: run.tenantId, journeyId: run.journeyId } },
      select: { activeVersion: true },
    });
    await tx.uatRun.update({
      where: { id: run.id },
      data: {
        lifecycle: head?.activeVersion ? 'COMPLETED' : 'ABANDONED',
        closedAt: now,
        closedByRef: context.actor.subjectId,
        revision: run.revision + 1,
      },
    });
  }

  private async pack(tx: Tx, run: RunRow): Promise<PackRow> {
    return tx.uatFixturePack.findUniqueOrThrow({
      where: { tenantId_id: { tenantId: run.tenantId, id: run.fixturePackId } },
    });
  }

  /** ไม่ใช่ผู้ทดสอบของ pack = ตอบเหมือนไม่มี run (ไม่เผย existence) */
  private assertParticipant(manifest: UatFixturePackManifestV1, actor: JourneyAuthoringActor) {
    if (!isParticipant(manifest, actor)) throw new UatRunError('UAT_RUN_NOT_FOUND');
  }

  private async view(tx: Tx, run: RunRow, actor: JourneyAuthoringActor): Promise<UatRunView> {
    const pack = await this.pack(tx, run);
    const manifest = manifestOf(pack);
    this.assertParticipant(manifest, actor);
    const results = await tx.uatRunStepResult.findMany({
      where: { tenantId: run.tenantId, runId: run.id },
      orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
    });
    return {
      runId: run.id,
      sequence: run.sequence,
      lifecycle: run.lifecycle,
      revision: run.revision,
      journeyId: run.journeyId,
      fixturePack: {
        environment: pack.environment,
        packVersion: pack.packVersion,
        digest: pack.digest,
        buildSha: pack.buildSha,
      },
      steps: manifest.steps,
      openedAt: run.openedAt.toISOString(),
      closedAt: run.closedAt?.toISOString() ?? null,
      stepResults: results.map((result) => ({
        stepId: result.stepId,
        outcome: result.outcome,
        expected: result.expected,
        actual: result.actual,
        severity: result.severity,
        correlationId: result.correlationId,
        stateLabel: result.stateLabel,
        recordedByRef: result.recordedByRef,
        recordedAt: result.recordedAt.toISOString(),
      })),
    };
  }

  private async replay(tx: Tx, context: JourneyCommandContext, requestHash: string) {
    const receipt = await tx.uatCommandReceipt.findUnique({
      where: {
        tenantId_idempotencyKey: {
          tenantId: context.tenantId,
          idempotencyKey: context.idempotencyKey,
        },
      },
    });
    if (!receipt) return null;
    if (receipt.requestHash !== requestHash) throw new UatRunError('IDEMPOTENCY_CONFLICT');
    return receipt.response;
  }

  private async complete(
    tx: Tx,
    context: JourneyCommandContext,
    commandName: string,
    requestHash: string,
    runId: string | null,
    response: object,
  ) {
    const data = {
      response: response as Prisma.InputJsonValue,
      completedAt: this.now(),
    };
    if (runId) {
      await tx.uatCommandReceipt.update({
        where: {
          tenantId_idempotencyKey: {
            tenantId: context.tenantId,
            idempotencyKey: context.idempotencyKey,
          },
        },
        data,
      });
      return;
    }
    await tx.uatCommandReceipt.create({
      data: {
        id: this.id(),
        tenantId: context.tenantId,
        idempotencyKey: context.idempotencyKey,
        commandName,
        requestHash,
        ...data,
      },
    });
  }
}

/**
 * J5 write guard ของ UAT: Journey ที่ผูกกับ run ที่ปิดแล้ว (COMPLETED/ABANDONED) แก้/ส่งตรวจ/อนุมัติ/publish
 * ต่อไม่ได้ (#376: candidate ของ run ที่ abandoned ต้องไม่ถูก review/publish ต่อ)
 */
export class UatJourneyWriteGuard implements JourneyAuthoringWriteGuard {
  async assertJourneyWritable(tx: Tx, tenantId: string, journeyId: string): Promise<void> {
    const closed = await tx.uatRun.findFirst({
      where: { tenantId, journeyId, lifecycle: { not: 'ACTIVE' } },
      select: { id: true },
    });
    if (closed) {
      throw new JourneyAuthoringError('JOURNEY_LIFECYCLE_CONFLICT', { reason: 'UAT_RUN_CLOSED' });
    }
  }
}
