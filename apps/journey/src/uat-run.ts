/**
 * Owner: Journey authoring API + UAT control — the UAT fixture pack and run record (U1.1 #429)
 *
 * Authority: Phase Contract #374, fixture/reset #376, evidence #379, boundary #378
 *
 * - the server owns the whole run: the browser can send only opaque ids/values the tester entered, never an authority for
 *   the tenant, permissions or results
 * - "Start new round" closes the existing run as `COMPLETED`/`ABANDONED` then creates a new run + Journey draft through the existing J5
 *   (with the full permissions/rollout/audit of J5) without deleting anything from the previous round, and can resume with the same key after a crash
 * - the Journey of a closed run has every mutation shut by `UatJourneyWriteGuard` — an existing candidate can no longer be reviewed/published
 *   while the other J5 semantics do not change
 * - UAT-only permissions come from the fixture pack the operator provisions: only the pack's maker can start a new round
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
import { scanUatText } from './uat-evidence-content.js';

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
  // U1.5 (#433): screenshot evidence
  EVIDENCE_NOT_FOUND: 404,
  EVIDENCE_TOO_LARGE: 413,
  EVIDENCE_TYPE_REJECTED: 415,
  EVIDENCE_INTEGRITY_FAILED: 500,
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

/** a purely synthetic manifest — opaque refs only, no secret/PII (#376) */
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
  /** the starting AuthoringDocumentV1 of each run — J5 validates it when creating the draft */
  readonly baselineDocument: Readonly<Record<string, unknown>>;
  readonly simulationFixture: SimulationFixtureV1;
  readonly steps: readonly UatScenarioStepV1[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const STEP_ID = /^[A-Z][A-Z0-9_-]{1,63}$/;
/** the stepId format of the step catalog — shared with evidence (U1.5 #433) */
export const UAT_STEP_ID_PATTERN = STEP_ID;

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
  // real data/secrets that must not be in a fixture — finding one = the manifest is unusable (the same scanner as the negative scan of U1.5)
  const [kind] = scanUatText(JSON.stringify(manifest));
  if (kind) throw new UatRunError('FIXTURE_MANIFEST_INVALID', { kind });
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
  // maker-checker must be two different accounts (#372)
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

/** the TEAM grant of the owner team that the preflight needs — the CLI provision (U1.8 #502) uses the same set */
export const UAT_MAKER_CAPABILITIES = ['journey.read', 'journey.edit', 'journey.publish'] as const;
export const UAT_REVIEWER_CAPABILITIES = ['journey.read', 'journey.review'] as const;
const MAKER_CAPABILITIES = UAT_MAKER_CAPABILITIES;
const REVIEWER_CAPABILITIES = UAT_REVIEWER_CAPABILITIES;

export interface UatFixtureProvisionResult {
  status: 'CREATED' | 'UNCHANGED';
  fixturePackId: string;
  digest: string;
}

export interface UatFixtureCheckResult {
  status: 'WOULD_CREATE' | 'UNCHANGED';
  fixturePackId: string | null;
  digest: string;
  /** `SKIPPED` = the caller asked to skip the preflight because items 1–4 have not been created yet (see `check`) */
  preflight: 'PASS' | 'SKIPPED';
}

/**
 * provisions the fixture pack with the UAT operator's connection (not the app role — the app role cannot write a pack)
 * idempotent per environment + tenant + pack version; a different digest = fail closed; a failed preflight = nothing is written
 * does not touch runs/Journeys the testers have made
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
      const existing = await this.existing(tx, manifest, digest);
      if (existing) return { status: 'UNCHANGED' as const, fixturePackId: existing.id, digest };
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

  /**
   * U1.8 (#502): the CLI `--check` — the same parse, digest and preflight as `provision` in a transaction
   * that is READ ONLY so it can write nothing at all; `preflight: false` is used when items 1–4 (tenant/team/grant/rollout)
   * do not exist yet and will be created in the apply round — it still checks the manifest and the digest of the existing pack as usual
   */
  async check(
    value: unknown,
    options: { readonly preflight?: boolean } = {},
  ): Promise<UatFixtureCheckResult> {
    const manifest = parseUatFixturePackManifest(value);
    const digest = uatFixturePackDigest(manifest);
    return this.database.$transaction(async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const existing = await this.existing(tx, manifest, digest);
      if (existing) {
        return { status: 'UNCHANGED', fixturePackId: existing.id, digest, preflight: 'PASS' };
      }
      if (options.preflight === false) {
        return { status: 'WOULD_CREATE', fixturePackId: null, digest, preflight: 'SKIPPED' };
      }
      await this.preflight(tx, manifest);
      return { status: 'WOULD_CREATE', fixturePackId: null, digest, preflight: 'PASS' };
    });
  }

  /** the existing pack of environment + tenant + pack version; a different digest = fail closed */
  private async existing(tx: Tx, manifest: UatFixturePackManifestV1, digest: string) {
    const existing = await tx.uatFixturePack.findUnique({
      where: {
        tenantId_environment_packVersion: {
          tenantId: manifest.tenantId,
          environment: manifest.environment,
          packVersion: manifest.packVersion,
        },
      },
    });
    if (existing && existing.digest !== digest) {
      throw new UatRunError('FIXTURE_PACK_DIGEST_MISMATCH');
    }
    return existing;
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
  /** the revision of the run that is ACTIVE, or 0 when there is none */
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

/** the part of J5 a run uses to create a Journey draft — through the normal J5 permissions/rollout/audit */
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

/** a collision of the unique for an ACTIVE run/sequence = another command opened a run first */
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

  /** the fixture the server pins for the current run — the Console uses it instead of creating startAt/seed itself */
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
          // expected comes from the step catalog pinned in the pack, not from the browser
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
   * "Start new round" — closes the existing run then opens a new run + Journey draft, split into 3 resumable phases:
   * 1. transaction: check key/revision/pending work → close the existing run → create the new run + an unfinished receipt
   * 2. create the Journey draft through J5 with a key derived from the run (J5 replays to the same Journey)
   * 3. transaction: bind the Journey to the run then close the receipt
   * a crash midway → calling again with the same key continues from the phase left off and does not create a duplicate run
   */
  async startNewRun(context: JourneyCommandContext, input: StartUatRunInput): Promise<UatRunView> {
    const requestHash = journeyAuthoringDigest({
      command: 'StartUatRun',
      // the same key from another user must not replay/resume the maker's command
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

  /** phase 1 of "Start new round" — all within a single transaction */
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
        // UAT-only capability: only the pack's maker (#376)
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

  /** an existing run with pending work cannot be closed — must be resolved through the Journey Console first (#376) */
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

  /** not a tester of the pack = answer as if there is no run (does not reveal existence) */
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
 * J5 write guard of UAT: a Journey bound to a closed run (COMPLETED/ABANDONED) cannot be edited/submitted for review/approved/published
 * any further (#376: a candidate of an abandoned run must not be reviewed/published further)
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
