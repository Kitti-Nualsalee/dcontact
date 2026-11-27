/**
 * #971 — a Supervisor evaluates the team's calls with a form, then the Agent sees their own score (`/api/v1/qm`)
 *
 * - an Admin creates a form, edits drafts and publishes versions; a published version cannot be edited (ADR-010 item 9)
 * - a Supervisor can evaluate only calls that their own team really answered (`voice_interaction_handling_attributions`)
 *   checked against the current team on every request the same as #967, and cannot evaluate calls they answered themselves
 * - an Agent sees only their own published results; a result stores a snapshot of the form so it can always be read back later
 * - the role in the token is the first gate; the current role and status are read from the DB on every request
 */
import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  QmFormValidationError,
  answersView,
  assertPublishable,
  normalizeComment,
  normalizeFormName,
  parseAnswers,
  parseFormDefinition,
  scoreEvaluation,
  type QmAnswer,
  type QmFormDefinition,
} from './qm-evaluation-form.js';

export const QM_EVALUATION_DATABASE = Symbol('QM_EVALUATION_DATABASE');
export const QM_HUMAN_EVALUATION = Symbol('QM_HUMAN_EVALUATION');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;
const LIST_DEFAULT_DAYS = 30;
const LIST_MAX_DAYS = 90;
const LIST_DEFAULT_LIMIT = 20;
const LIST_MAX_LIMIT = 100;
const EVALUATION_STATUSES = ['NOT_EVALUATED', 'DRAFT', 'PUBLISHED'] as const;
type ListStatus = (typeof EVALUATION_STATUSES)[number];

interface Actor {
  tenantId: string;
  userId: string;
}

/** the snapshot stored in `qm_evaluations.form_snapshot` */
interface FormSnapshot {
  formId: string;
  formName: string;
  version: number;
  definition: QmFormDefinition;
}

interface TeamInteraction {
  interactionId: string;
  agentId: string;
  agentName: string | null;
  queueName: string | null;
  channel: string;
  acceptedAt: Date;
  endedAt: Date | null;
  hasRecording: boolean;
  evaluationId: string | null;
  evaluationStatus: 'DRAFT' | 'PUBLISHED' | null;
  finalScore: Prisma.Decimal | null;
}

const disabled = () => new ForbiddenException({ code: 'FEATURE_DISABLED' });
const denied = () => new ForbiddenException({ code: 'QM_ACCESS_DENIED' });
/** not found, another team's and another tenant's all answer the same */
const notFound = () => new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
const invalid = (field: string) => new BadRequestException({ code: 'INVALID_REQUEST', field });
const conflict = (code: string) => new ConflictException({ code });

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw notFound();
  return value.toLowerCase();
}

function bodyOf(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw invalid('body');
  return body as Record<string, unknown>;
}

function commandIdOf(body: Record<string, unknown>): string {
  const value = body.commandId;
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid('commandId');
  return value.toLowerCase();
}

function revisionOf(body: Record<string, unknown>, required: boolean): number | undefined {
  const value = body.revision;
  if (value === undefined && !required) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw invalid('revision');
  return value as number;
}

/** sort an object's keys before taking the digest: a retry with a different key order is still the same command */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

function digest(parts: unknown[]): string {
  return createHash('sha256')
    .update(JSON.stringify([1, ...parts]), 'utf8')
    .digest('hex');
}

function timestamp(value: unknown, field: string, fallback: Date): Date {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw invalid(field);
  return parsed;
}

function limitOf(value: unknown): number {
  const take = value === undefined ? LIST_DEFAULT_LIMIT : Number(value);
  if (!Number.isInteger(take) || take < 1 || take > LIST_MAX_LIMIT) throw invalid('limit');
  return take;
}

function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}

/** the cursor is only a position in the list; permission is rechecked on every request */
function decodeCursor(value: unknown): { at: Date; id: string } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && UUID.test(String(parsed[1]))) {
      const at = new Date(parsed[0]);
      if (!Number.isNaN(at.getTime())) return { at, id: String(parsed[1]) };
    }
  } catch {
    // falls through to answer 400 below
  }
  throw invalid('cursor');
}

function sqlTime(value: Date): Prisma.Sql {
  // send the time as a timestamp without a zone so the result does not depend on the DB session's TimeZone (lesson from #967)
  return Prisma.sql`${value.toISOString()}::timestamp(3)`;
}

function score(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

function validationFailed(error: QmFormValidationError): UnprocessableEntityException {
  return new UnprocessableEntityException({ code: 'VALIDATION_FAILED', errors: error.errors });
}

function storedAnswers(value: Prisma.JsonValue): QmAnswer[] {
  return Array.isArray(value) ? (value as unknown as QmAnswer[]) : [];
}

function questionCount(definition: QmFormDefinition): number {
  return definition.sections.reduce((sum, section) => sum + section.questions.length, 0);
}

@Controller('api/v1/qm')
export class QmEvaluationController {
  constructor(
    @Inject(QM_EVALUATION_DATABASE) private readonly database: PrismaClient,
    @Optional() @Inject(QM_HUMAN_EVALUATION) private readonly enabled: boolean = false,
  ) {}

  // ───────────────────────────── forms (Admin) ─────────────────────────────

  @Get('forms')
  @GatewayRoles('admin', 'supervisor')
  @Header('Cache-Control', 'no-store')
  async listForms(@Req() request: AuthenticatedGatewayRequest) {
    const actor = this.actor(request);
    return this.transaction(actor, async (tx) => {
      const role = await this.staffRole(tx, actor);
      const forms = await tx.qmForm.findMany({
        where: { tenantId: actor.tenantId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          name: true,
          updatedAt: true,
          versions: {
            where: { status: { in: role === 'ADMIN' ? ['DRAFT', 'PUBLISHED'] : ['PUBLISHED'] } },
            select: {
              id: true,
              version: true,
              status: true,
              revision: true,
              definition: true,
              publishedAt: true,
              updatedAt: true,
            },
          },
        },
      });
      const items = forms.flatMap((form) => {
        const current = form.versions.find((version) => version.status === 'PUBLISHED');
        const draft = form.versions.find((version) => version.status === 'DRAFT');
        // a Supervisor sees only forms that are ready to evaluate with
        if (role === 'SUPERVISOR' && !current) return [];
        return [
          {
            formId: form.id,
            name: form.name,
            updatedAt: form.updatedAt.toISOString(),
            current: current
              ? {
                  versionId: current.id,
                  version: current.version,
                  publishedAt: current.publishedAt!.toISOString(),
                  questionCount: questionCount(current.definition as unknown as QmFormDefinition),
                }
              : null,
            ...(role === 'ADMIN'
              ? {
                  draft: draft
                    ? {
                        versionId: draft.id,
                        version: draft.version,
                        revision: draft.revision,
                        updatedAt: draft.updatedAt.toISOString(),
                      }
                    : null,
                }
              : {}),
          },
        ];
      });
      return { items };
    });
  }

  @Post('forms')
  @GatewayRoles('admin')
  @Header('Cache-Control', 'no-store')
  async createForm(@Req() request: AuthenticatedGatewayRequest, @Body() rawBody: unknown) {
    const actor = this.actor(request);
    const body = bodyOf(rawBody);
    const commandId = commandIdOf(body);
    const { name, definition } = this.validate(() => ({
      name: normalizeFormName(body.name),
      definition: parseFormDefinition(body.definition ?? { sections: [] }, 'draft'),
    }));
    const payloadDigest = digest([actor.tenantId, actor.userId, name, definition]);
    return this.transaction(actor, async (tx) => {
      await this.lock(tx, `qm-command:${actor.tenantId}:${commandId}`);
      // check the current permission before returning the original result: someone who lost permission must not get a result from the receipt
      await this.requireAdmin(tx, actor);
      const replay = await this.replay(tx, actor, commandId, 'QM_FORM_CREATE', payloadDigest);
      if (replay) return replay.result;
      await this.lock(tx, `qm-form-name:${actor.tenantId}:${name.toLowerCase()}`);
      await this.assertNameFree(tx, actor, name);
      const form = await tx.qmForm.create({
        data: { tenantId: actor.tenantId, name, createdByUserId: actor.userId },
        select: { id: true },
      });
      await tx.qmFormVersion.create({
        data: {
          tenantId: actor.tenantId,
          formId: form.id,
          version: 1,
          definition: definition as unknown as Prisma.InputJsonValue,
          createdByUserId: actor.userId,
        },
      });
      const result = await this.formView(tx, actor, form.id);
      await this.receipt(tx, actor, commandId, 'QM_FORM_CREATE', form.id, payloadDigest, result);
      return result;
    });
  }

  @Get('forms/:formId')
  @GatewayRoles('admin')
  @Header('Cache-Control', 'no-store')
  async getForm(@Req() request: AuthenticatedGatewayRequest, @Param('formId') id: string) {
    const actor = this.actor(request);
    const formId = uuid(id);
    return this.transaction(actor, async (tx) => {
      await this.requireAdmin(tx, actor);
      return this.formView(tx, actor, formId);
    });
  }

  /** edit a draft (and the form name) — the revision prevents overwriting each other; a retry after success gets STALE_REVISION then reloads */
  @Put('forms/:formId/draft')
  @GatewayRoles('admin')
  @Header('Cache-Control', 'no-store')
  async updateDraft(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('formId') id: string,
    @Body() rawBody: unknown,
  ) {
    const actor = this.actor(request);
    const formId = uuid(id);
    const body = bodyOf(rawBody);
    const revision = revisionOf(body, true)!;
    const { name, definition } = this.validate(() => ({
      name: body.name === undefined ? undefined : normalizeFormName(body.name),
      definition: parseFormDefinition(body.definition, 'draft'),
    }));
    return this.transaction(actor, async (tx) => {
      await this.requireAdmin(tx, actor);
      const draft = await this.lockedDraft(tx, actor, formId);
      if (draft.revision !== revision) throw conflict('STALE_REVISION');
      if (name !== undefined) {
        await this.lock(tx, `qm-form-name:${actor.tenantId}:${name.toLowerCase()}`);
        await this.assertNameFree(tx, actor, name, formId);
        await tx.qmForm.update({ where: { id: formId }, data: { name } });
      }
      await tx.qmFormVersion.update({
        where: { id: draft.id },
        data: {
          definition: definition as unknown as Prisma.InputJsonValue,
          revision: { increment: 1 },
        },
      });
      return this.formView(tx, actor, formId);
    });
  }

  /** issue a new draft version from the active version */
  @Post('forms/:formId/draft')
  @GatewayRoles('admin')
  @Header('Cache-Control', 'no-store')
  async createDraft(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('formId') id: string,
    @Body() rawBody: unknown,
  ) {
    const actor = this.actor(request);
    const formId = uuid(id);
    const commandId = commandIdOf(bodyOf(rawBody));
    const payloadDigest = digest([actor.tenantId, actor.userId, formId]);
    return this.transaction(actor, async (tx) => {
      await this.lock(tx, `qm-command:${actor.tenantId}:${commandId}`);
      await this.requireAdmin(tx, actor);
      const replay = await this.replay(
        tx,
        actor,
        commandId,
        'QM_FORM_DRAFT_CREATE',
        payloadDigest,
        formId,
      );
      if (replay) return replay.result;
      await this.lockForm(tx, actor, formId);
      const versions = await tx.qmFormVersion.findMany({
        where: { tenantId: actor.tenantId, formId },
        orderBy: { version: 'desc' },
        select: { version: true, status: true, definition: true },
      });
      if (versions.some((version) => version.status === 'DRAFT')) throw conflict('DRAFT_EXISTS');
      const current = versions.find((version) => version.status === 'PUBLISHED');
      if (!current) throw conflict('NO_PUBLISHED_VERSION');
      await tx.qmFormVersion.create({
        data: {
          tenantId: actor.tenantId,
          formId,
          version: versions[0]!.version + 1,
          definition: current.definition as Prisma.InputJsonValue,
          createdByUserId: actor.userId,
        },
      });
      const result = await this.formView(tx, actor, formId);
      await this.receipt(
        tx,
        actor,
        commandId,
        'QM_FORM_DRAFT_CREATE',
        formId,
        payloadDigest,
        result,
      );
      return result;
    });
  }

  @Post('forms/:formId/draft/publish')
  @HttpCode(200)
  @GatewayRoles('admin')
  @Header('Cache-Control', 'no-store')
  async publishDraft(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('formId') id: string,
    @Body() rawBody: unknown,
  ) {
    const actor = this.actor(request);
    const formId = uuid(id);
    const body = bodyOf(rawBody);
    const commandId = commandIdOf(body);
    const revision = revisionOf(body, true)!;
    const payloadDigest = digest([actor.tenantId, actor.userId, formId, revision]);
    return this.transaction(actor, async (tx) => {
      await this.lock(tx, `qm-command:${actor.tenantId}:${commandId}`);
      await this.requireAdmin(tx, actor);
      const replay = await this.replay(
        tx,
        actor,
        commandId,
        'QM_FORM_PUBLISH',
        payloadDigest,
        formId,
      );
      if (replay) return replay.result;
      const draft = await this.lockedDraft(tx, actor, formId);
      if (draft.revision !== revision) throw conflict('STALE_REVISION');
      const definition = this.validate(() => parseFormDefinition(draft.definition, 'publish'));
      const publishedAt = new Date();
      // must change the original version first: the partial unique index allows one PUBLISHED row per form
      await tx.qmFormVersion.updateMany({
        where: { tenantId: actor.tenantId, formId, status: 'PUBLISHED' },
        data: { status: 'SUPERSEDED' },
      });
      await tx.qmFormVersion.update({
        where: { id: draft.id },
        data: {
          status: 'PUBLISHED',
          definition: definition as unknown as Prisma.InputJsonValue,
          publishedAt,
          publishedByUserId: actor.userId,
        },
      });
      await tx.qmForm.update({ where: { id: formId }, data: { updatedAt: publishedAt } });
      await tx.qmAuditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'FORM_VERSION_PUBLISHED',
          resourceType: 'QM_FORM_VERSION',
          resourceId: draft.id,
          details: { formId, version: draft.version, commandId },
        },
      });
      const result = await this.formView(tx, actor, formId);
      await this.receipt(tx, actor, commandId, 'QM_FORM_PUBLISH', formId, payloadDigest, result);
      return result;
    });
  }

  /** the content of a version: an Admin can read every version, a Supervisor only the active version */
  @Get('form-versions/:versionId')
  @GatewayRoles('admin', 'supervisor')
  @Header('Cache-Control', 'no-store')
  async getFormVersion(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('versionId') id: string,
  ) {
    const actor = this.actor(request);
    const versionId = uuid(id);
    return this.transaction(actor, async (tx) => {
      const role = await this.staffRole(tx, actor);
      const version = await tx.qmFormVersion.findFirst({
        where: {
          id: versionId,
          tenantId: actor.tenantId,
          ...(role === 'SUPERVISOR' ? { status: 'PUBLISHED' as const } : {}),
        },
        select: {
          id: true,
          formId: true,
          version: true,
          status: true,
          definition: true,
          publishedAt: true,
          form: { select: { name: true } },
        },
      });
      if (!version) throw notFound();
      return {
        versionId: version.id,
        formId: version.formId,
        formName: version.form.name,
        version: version.version,
        status: version.status,
        publishedAt: version.publishedAt?.toISOString() ?? null,
        definition: version.definition,
      };
    });
  }

  // ──────────────────────── evaluate the team's calls (Supervisor) ────────────────────────

  @Get('team-interactions')
  @GatewayRoles('supervisor')
  @Header('Cache-Control', 'no-store')
  async teamInteractions(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Query('status') status: unknown,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ) {
    const actor = this.actor(request);
    const asOf = new Date();
    const until = timestamp(to, 'to', asOf);
    const since = timestamp(from, 'from', new Date(until.getTime() - LIST_DEFAULT_DAYS * DAY_MS));
    if (since >= until || until.getTime() - since.getTime() > LIST_MAX_DAYS * DAY_MS) {
      throw invalid('from');
    }
    if (status !== undefined && !EVALUATION_STATUSES.includes(status as ListStatus)) {
      throw invalid('status');
    }
    const take = limitOf(limit);
    const after = decodeCursor(cursor);
    const statusFilter =
      status === 'NOT_EVALUATED'
        ? Prisma.sql`AND e.id IS NULL`
        : status === 'DRAFT' || status === 'PUBLISHED'
          ? Prisma.sql`AND e.status = ${status}::"QmEvaluationStatus"`
          : Prisma.empty;
    const rows = await this.transaction(actor, async (tx) => {
      const teamId = await this.supervisorTeam(tx, actor);
      return this.teamRows(
        tx,
        actor,
        teamId,
        Prisma.sql`AND a.agent_id <> ${actor.userId}::uuid
          AND a.accepted_at >= ${sqlTime(since)} AND a.accepted_at < ${sqlTime(until)}
          ${statusFilter}
          ${after ? Prisma.sql`AND (a.accepted_at, a.interaction_id) < (${sqlTime(after.at)}, ${after.id}::uuid)` : Prisma.empty}
          ORDER BY a.accepted_at DESC, a.interaction_id DESC LIMIT ${take + 1}`,
      );
    });
    const items = rows.slice(0, take);
    return {
      asOf: asOf.toISOString(),
      items: items.map((row) => ({
        interactionId: row.interactionId,
        agentId: row.agentId,
        agentName: row.agentName,
        queueName: row.queueName,
        channel: row.channel,
        acceptedAt: row.acceptedAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        hasRecording: row.hasRecording,
        evaluation: row.evaluationId
          ? {
              evaluationId: row.evaluationId,
              status: row.evaluationStatus,
              finalScore: score(row.finalScore),
            }
          : null,
      })),
      nextCursor:
        rows.length > take
          ? encodeCursor(items.at(-1)!.acceptedAt, items.at(-1)!.interactionId)
          : null,
    };
  }

  @Get('interactions/:interactionId/human-evaluation')
  @GatewayRoles('supervisor')
  @Header('Cache-Control', 'no-store')
  async getHumanEvaluation(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') id: string,
  ) {
    const actor = this.actor(request);
    const interactionId = uuid(id);
    return this.transaction(actor, async (tx) => {
      const interaction = await this.authorizeInteraction(tx, actor, interactionId);
      return this.supervisorView(tx, actor, interaction);
    });
  }

  /**
   * The call transcript the Supervisor reads beside the evaluation form.
   * Same gate as the evaluation itself (team at answer time, COMPLETED, not self) and every read
   * that returns text is audited as TRANSCRIPT_ACCESSED. The transcript stays readable after its
   * recording is deleted by retention (ADR-010 item 4: a transcript outlives the audio).
   */
  @Get('interactions/:interactionId/transcript')
  @GatewayRoles('supervisor')
  @Header('Cache-Control', 'no-store')
  async getTranscript(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') id: string,
  ) {
    const actor = this.actor(request);
    const interactionId = uuid(id);
    return this.transaction(actor, async (tx) => {
      await this.authorizeInteraction(tx, actor, interactionId);
      const transcript = await tx.qmTranscript.findFirst({
        where: { tenantId: actor.tenantId, interactionId },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          language: true,
          providerId: true,
          modelId: true,
          createdAt: true,
          segments: {
            orderBy: [{ startMs: 'asc' }, { endMs: 'asc' }],
            select: { id: true, speaker: true, startMs: true, endMs: true, text: true },
          },
        },
      });
      if (!transcript) {
        const job = await tx.qmTranscriptionJob.findFirst({
          where: { tenantId: actor.tenantId, interactionId },
          select: { status: true, failureCode: true },
        });
        return {
          status: !job
            ? ('NOT_REQUESTED' as const)
            : job.status === 'FAILED'
              ? ('FAILED' as const)
              : ('PROCESSING' as const),
          failureCode: job?.status === 'FAILED' ? (job.failureCode ?? null) : null,
          transcript: null,
        };
      }
      await tx.qmAuditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'TRANSCRIPT_ACCESSED',
          resourceType: 'QM_TRANSCRIPT',
          resourceId: transcript.id,
          details: { via: 'HUMAN_EVALUATION', interactionId },
        },
      });
      return {
        status: 'READY' as const,
        failureCode: null,
        transcript: {
          transcriptId: transcript.id,
          language: transcript.language,
          providerId: transcript.providerId,
          modelId: transcript.modelId,
          createdAt: transcript.createdAt.toISOString(),
          segments: transcript.segments.map((segment) => ({
            segmentId: segment.id,
            speaker: segment.speaker,
            startMs: segment.startMs,
            endMs: segment.endMs,
            text: segment.text,
          })),
        },
      };
    });
  }

  /** create or edit a draft evaluation — answers may be incomplete, the score is computed on publish */
  @Put('interactions/:interactionId/human-evaluation')
  @GatewayRoles('supervisor')
  @Header('Cache-Control', 'no-store')
  async saveHumanEvaluation(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') id: string,
    @Body() rawBody: unknown,
  ) {
    const actor = this.actor(request);
    const interactionId = uuid(id);
    const body = bodyOf(rawBody);
    const commandId = commandIdOf(body);
    const revision = revisionOf(body, false);
    if (typeof body.formVersionId !== 'string' || !UUID.test(body.formVersionId)) {
      throw invalid('formVersionId');
    }
    const formVersionId = body.formVersionId.toLowerCase();
    const comment = this.validate(() => normalizeComment(body.comment));
    const payloadDigest = digest([
      actor.tenantId,
      actor.userId,
      interactionId,
      formVersionId,
      canonical(body.answers ?? null),
      comment,
      revision ?? null,
    ]);
    return this.transaction(actor, async (tx) => {
      await this.lock(tx, `qm-command:${actor.tenantId}:${commandId}`);
      await this.lock(tx, `qm-evaluation:${actor.tenantId}:${interactionId}`);
      const interaction = await this.authorizeInteraction(tx, actor, interactionId);
      const replay = await this.replay(
        tx,
        actor,
        commandId,
        'QM_HUMAN_EVALUATION_SAVE',
        payloadDigest,
        interactionId,
      );
      if (replay) return replay.result;
      const existing = await this.humanEvaluation(tx, actor, interactionId);
      if (existing?.status === 'PUBLISHED') throw conflict('EVALUATION_PUBLISHED');
      if ((existing?.revision ?? undefined) !== revision) throw conflict('STALE_REVISION');
      const snapshot =
        existing && existing.formVersionId === formVersionId
          ? (existing.formSnapshot as unknown as FormSnapshot)
          : await this.publishedSnapshot(tx, actor, formVersionId);
      const answers = this.validate(() =>
        parseAnswers(snapshot.definition, body.answers ?? {}, 'draft'),
      );
      const data = {
        formVersionId,
        formSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        answers: answers as unknown as Prisma.InputJsonValue,
        comment,
        evaluatorId: actor.userId,
      };
      if (existing) {
        await tx.qmEvaluation.update({
          where: { id: existing.id },
          data: { ...data, revision: { increment: 1 } },
        });
      } else {
        await tx.qmEvaluation.create({
          data: {
            ...data,
            tenantId: actor.tenantId,
            interactionId,
            agentId: interaction.agentId,
            source: 'HUMAN',
            status: 'DRAFT',
          },
        });
      }
      const result = await this.supervisorView(tx, actor, interaction);
      await this.receipt(
        tx,
        actor,
        commandId,
        'QM_HUMAN_EVALUATION_SAVE',
        interactionId,
        payloadDigest,
        result,
      );
      return result;
    });
  }

  @Post('interactions/:interactionId/human-evaluation/publish')
  @HttpCode(200)
  @GatewayRoles('supervisor')
  @Header('Cache-Control', 'no-store')
  async publishHumanEvaluation(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') id: string,
    @Body() rawBody: unknown,
  ) {
    const actor = this.actor(request);
    const interactionId = uuid(id);
    const body = bodyOf(rawBody);
    const commandId = commandIdOf(body);
    const revision = revisionOf(body, true)!;
    const payloadDigest = digest([actor.tenantId, actor.userId, interactionId, revision]);
    return this.transaction(actor, async (tx) => {
      await this.lock(tx, `qm-command:${actor.tenantId}:${commandId}`);
      await this.lock(tx, `qm-evaluation:${actor.tenantId}:${interactionId}`);
      const interaction = await this.authorizeInteraction(tx, actor, interactionId);
      const replay = await this.replay(
        tx,
        actor,
        commandId,
        'QM_HUMAN_EVALUATION_PUBLISH',
        payloadDigest,
        interactionId,
      );
      if (replay) return replay.result;
      const existing = await this.humanEvaluation(tx, actor, interactionId);
      if (!existing) throw notFound();
      if (existing.status === 'PUBLISHED') throw conflict('EVALUATION_PUBLISHED');
      if (existing.revision !== revision) throw conflict('STALE_REVISION');
      const snapshot = existing.formSnapshot as unknown as FormSnapshot;
      const result = this.validate(() => {
        const answers = parseAnswers(
          snapshot.definition,
          answersView(storedAnswers(existing.answers)),
          'publish',
        );
        return assertPublishable(
          snapshot.definition,
          scoreEvaluation(snapshot.definition, answers),
          existing.comment,
        );
      });
      const publishedAt = new Date();
      await tx.qmEvaluation.update({
        where: { id: existing.id },
        data: {
          status: 'PUBLISHED',
          rawScore: result.rawScore,
          finalScore: result.finalScore,
          autoFailed: result.autoFailed,
          evaluatorId: actor.userId,
          publishedAt,
          revision: { increment: 1 },
        },
      });
      await tx.qmAuditEvent.create({
        data: {
          tenantId: actor.tenantId,
          actorUserId: actor.userId,
          action: 'EVALUATION_PUBLISHED',
          resourceType: 'QM_EVALUATION',
          resourceId: existing.id,
          details: {
            source: 'HUMAN',
            formVersionId: existing.formVersionId,
            finalScore: result.finalScore,
            autoFailed: result.autoFailed,
            commandId,
          },
        },
      });
      const view = await this.supervisorView(tx, actor, interaction);
      await this.receipt(
        tx,
        actor,
        commandId,
        'QM_HUMAN_EVALUATION_PUBLISH',
        interactionId,
        payloadDigest,
        view,
      );
      return view;
    });
  }

  // ─────────────────────────── my score (Agent) ───────────────────────────

  @Get('my-evaluations')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async myEvaluations(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ) {
    const actor = this.actor(request);
    const take = limitOf(limit);
    const after = decodeCursor(cursor);
    const rows = await this.transaction(actor, async (tx) => {
      await this.activeUser(tx, actor);
      return tx.qmEvaluation.findMany({
        where: {
          tenantId: actor.tenantId,
          agentId: actor.userId,
          source: 'HUMAN',
          status: 'PUBLISHED',
          ...(after
            ? {
                OR: [
                  { publishedAt: { lt: after.at } },
                  { publishedAt: after.at, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ publishedAt: 'desc' }, { id: 'desc' }],
        take: take + 1,
        select: {
          id: true,
          interactionId: true,
          formSnapshot: true,
          rawScore: true,
          finalScore: true,
          autoFailed: true,
          publishedAt: true,
          interaction: { select: { channel: true, queuedAt: true } },
        },
      });
    });
    const items = rows.slice(0, take);
    return {
      items: items.map((row) => {
        const snapshot = row.formSnapshot as unknown as FormSnapshot;
        return {
          evaluationId: row.id,
          interactionId: row.interactionId,
          channel: row.interaction.channel,
          interactionAt: row.interaction.queuedAt.toISOString(),
          formName: snapshot.formName,
          formVersion: snapshot.version,
          rawScore: score(row.rawScore),
          finalScore: score(row.finalScore),
          autoFailed: row.autoFailed,
          publishedAt: row.publishedAt!.toISOString(),
        };
      }),
      nextCursor:
        rows.length > take ? encodeCursor(items.at(-1)!.publishedAt!, items.at(-1)!.id) : null,
    };
  }

  @Get('my-evaluations/:evaluationId')
  @GatewayRoles('agent')
  @Header('Cache-Control', 'no-store')
  async myEvaluation(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('evaluationId') id: string,
  ) {
    const actor = this.actor(request);
    const evaluationId = uuid(id);
    return this.transaction(actor, async (tx) => {
      await this.activeUser(tx, actor);
      const evaluation = await tx.qmEvaluation.findFirst({
        where: {
          id: evaluationId,
          tenantId: actor.tenantId,
          agentId: actor.userId,
          source: 'HUMAN',
          status: 'PUBLISHED',
        },
        select: { interactionId: true },
      });
      if (!evaluation) throw notFound();
      const view = await this.evaluationView(tx, actor, evaluation.interactionId);
      return view!;
    });
  }

  // ──────────────────────────────── internal ────────────────────────────────

  private actor(request: AuthenticatedGatewayRequest): Actor {
    const identity = request.gatewayIdentity;
    if (!this.enabled) throw disabled();
    if (!identity) throw denied();
    return { tenantId: identity.tenantId, userId: identity.userId };
  }

  private transaction<T>(actor: Actor, run: (tx: Prisma.TransactionClient) => Promise<T>) {
    return withTenantDatabaseTransaction(this.database, actor.tenantId, run).catch(
      (error: unknown) => {
        if (error instanceof HttpException) throw error;
        // form names collide from two concurrent requests that passed locks of different names (different letter case)
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          throw conflict('CONCURRENT_UPDATE');
        }
        throw error;
      },
    );
  }

  private validate<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      if (error instanceof QmFormValidationError) throw validationFailed(error);
      throw error;
    }
  }

  private async lock(tx: Prisma.TransactionClient, key: string) {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
  }

  private async replay(
    tx: Prisma.TransactionClient,
    actor: Actor,
    commandId: string,
    action: string,
    payloadDigest: string,
    resourceId?: string,
  ) {
    const receipt = await tx.commandReceipt.findUnique({
      where: { tenantId_commandId: { tenantId: actor.tenantId, commandId } },
      select: {
        actorUserId: true,
        action: true,
        resourceId: true,
        payloadDigest: true,
        result: true,
      },
    });
    if (!receipt) return undefined;
    if (
      receipt.actorUserId !== actor.userId ||
      receipt.action !== action ||
      (resourceId !== undefined && receipt.resourceId !== resourceId)
    ) {
      throw conflict('COMMAND_ID_REUSED');
    }
    if (receipt.payloadDigest !== payloadDigest) throw conflict('COMMAND_PAYLOAD_MISMATCH');
    return receipt;
  }

  private async receipt(
    tx: Prisma.TransactionClient,
    actor: Actor,
    commandId: string,
    action: string,
    resourceId: string,
    payloadDigest: string,
    result: unknown,
  ) {
    await tx.commandReceipt.create({
      data: {
        tenantId: actor.tenantId,
        commandId,
        actorUserId: actor.userId,
        action,
        resourceId,
        payloadDigest,
        result: result as Prisma.InputJsonValue,
      },
    });
  }

  private async activeUser(tx: Prisma.TransactionClient, actor: Actor) {
    const user = await tx.user.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId, isActive: true },
      select: { role: true, teamId: true },
    });
    if (!user) throw denied();
    return user;
  }

  private async staffRole(tx: Prisma.TransactionClient, actor: Actor) {
    const user = await this.activeUser(tx, actor);
    if (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') throw denied();
    return user.role;
  }

  private async requireAdmin(tx: Prisma.TransactionClient, actor: Actor) {
    const user = await this.activeUser(tx, actor);
    if (user.role !== 'ADMIN') throw denied();
  }

  /** the Supervisor's current active teams, read from the DB every time without trusting only the role in the token */
  private async supervisorTeam(tx: Prisma.TransactionClient, actor: Actor): Promise<string> {
    const user = await this.activeUser(tx, actor);
    if (user.role !== 'SUPERVISOR' || !user.teamId) throw denied();
    return user.teamId;
  }

  private async assertNameFree(
    tx: Prisma.TransactionClient,
    actor: Actor,
    name: string,
    exceptFormId?: string,
  ) {
    const [taken] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM qm_forms
      WHERE tenant_id = ${actor.tenantId}::uuid AND lower(btrim(name)) = ${name.toLowerCase()}
        ${exceptFormId ? Prisma.sql`AND id <> ${exceptFormId}::uuid` : Prisma.empty}
      LIMIT 1`;
    if (taken) throw conflict('FORM_NAME_TAKEN');
  }

  private async lockForm(tx: Prisma.TransactionClient, actor: Actor, formId: string) {
    const [form] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM qm_forms
      WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${formId}::uuid FOR UPDATE`;
    if (!form) throw notFound();
  }

  private async lockedDraft(tx: Prisma.TransactionClient, actor: Actor, formId: string) {
    await this.lockForm(tx, actor, formId);
    const draft = await tx.qmFormVersion.findFirst({
      where: { tenantId: actor.tenantId, formId, status: 'DRAFT' },
      select: { id: true, version: true, revision: true, definition: true },
    });
    if (!draft) throw conflict('NO_DRAFT');
    return draft;
  }

  private async formView(tx: Prisma.TransactionClient, actor: Actor, formId: string) {
    const form = await tx.qmForm.findFirst({
      where: { id: formId, tenantId: actor.tenantId },
      select: {
        id: true,
        name: true,
        updatedAt: true,
        versions: {
          orderBy: { version: 'desc' },
          select: {
            id: true,
            version: true,
            status: true,
            revision: true,
            definition: true,
            publishedAt: true,
            createdAt: true,
            updatedAt: true,
          },
        },
      },
    });
    if (!form) throw notFound();
    const draft = form.versions.find((version) => version.status === 'DRAFT');
    const current = form.versions.find((version) => version.status === 'PUBLISHED');
    return {
      formId: form.id,
      name: form.name,
      updatedAt: form.updatedAt.toISOString(),
      versions: form.versions.map((version) => ({
        versionId: version.id,
        version: version.version,
        status: version.status,
        publishedAt: version.publishedAt?.toISOString() ?? null,
        createdAt: version.createdAt.toISOString(),
      })),
      draft: draft
        ? {
            versionId: draft.id,
            version: draft.version,
            revision: draft.revision,
            definition: draft.definition,
            updatedAt: draft.updatedAt.toISOString(),
          }
        : null,
      current: current
        ? {
            versionId: current.id,
            version: current.version,
            definition: current.definition,
            publishedAt: current.publishedAt!.toISOString(),
          }
        : null,
    };
  }

  private async publishedSnapshot(
    tx: Prisma.TransactionClient,
    actor: Actor,
    formVersionId: string,
  ): Promise<FormSnapshot> {
    const version = await tx.qmFormVersion.findFirst({
      where: { id: formVersionId, tenantId: actor.tenantId, status: 'PUBLISHED' },
      select: { formId: true, version: true, definition: true, form: { select: { name: true } } },
    });
    if (!version) throw conflict('FORM_VERSION_NOT_AVAILABLE');
    return {
      formId: version.formId,
      formName: version.form.name,
      version: version.version,
      definition: version.definition as unknown as QmFormDefinition,
    };
  }

  /** calls that this team really answered and that have ended */
  private teamRows(
    tx: Prisma.TransactionClient,
    actor: Actor,
    teamId: string,
    tail: Prisma.Sql,
  ): Promise<TeamInteraction[]> {
    return tx.$queryRaw<TeamInteraction[]>`
      SELECT a.interaction_id AS "interactionId", a.agent_id AS "agentId",
        u.display_name AS "agentName", q.name AS "queueName", i.channel::text AS "channel",
        a.accepted_at AS "acceptedAt", i.ended_at AS "endedAt",
        EXISTS (
          SELECT 1 FROM recordings r
          WHERE r.tenant_id = i.tenant_id AND r.interaction_id = i.id AND r.deleted_at IS NULL
        ) AS "hasRecording",
        e.id AS "evaluationId", e.status::text AS "evaluationStatus", e.final_score AS "finalScore"
      FROM voice_interaction_handling_attributions a
      JOIN interactions i ON i.tenant_id = a.tenant_id AND i.id = a.interaction_id
      LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.agent_id
      LEFT JOIN queues q ON q.tenant_id = i.tenant_id AND q.id = i.queue_id
      LEFT JOIN qm_evaluations e
        ON e.tenant_id = i.tenant_id AND e.interaction_id = i.id AND e.source = 'HUMAN'
      WHERE a.tenant_id = ${actor.tenantId}::uuid AND a.team_id = ${teamId}::uuid
        AND i.state = 'COMPLETED'
      ${tail}`;
  }

  private async authorizeInteraction(
    tx: Prisma.TransactionClient,
    actor: Actor,
    interactionId: string,
  ): Promise<TeamInteraction> {
    const teamId = await this.supervisorTeam(tx, actor);
    const [row] = await this.teamRows(
      tx,
      actor,
      teamId,
      Prisma.sql`AND a.interaction_id = ${interactionId}::uuid`,
    );
    if (!row) throw notFound();
    // the evaluator must not be the one being evaluated
    if (row.agentId === actor.userId) {
      throw new ForbiddenException({ code: 'SELF_EVALUATION_NOT_ALLOWED' });
    }
    return row;
  }

  private humanEvaluation(tx: Prisma.TransactionClient, actor: Actor, interactionId: string) {
    return tx.qmEvaluation.findFirst({
      where: { tenantId: actor.tenantId, interactionId, source: 'HUMAN' },
      select: {
        id: true,
        status: true,
        revision: true,
        formVersionId: true,
        formSnapshot: true,
        answers: true,
        comment: true,
      },
    });
  }

  private async supervisorView(
    tx: Prisma.TransactionClient,
    actor: Actor,
    interaction: TeamInteraction,
  ) {
    return {
      interaction: {
        interactionId: interaction.interactionId,
        agentId: interaction.agentId,
        agentName: interaction.agentName,
        queueName: interaction.queueName,
        channel: interaction.channel,
        acceptedAt: interaction.acceptedAt.toISOString(),
        endedAt: interaction.endedAt?.toISOString() ?? null,
        hasRecording: interaction.hasRecording,
      },
      evaluation: await this.evaluationView(tx, actor, interaction.interactionId),
    };
  }

  /** an evaluation with its form from the snapshot; per-section scores are computed from snapshot + answers (deterministic) */
  private async evaluationView(tx: Prisma.TransactionClient, actor: Actor, interactionId: string) {
    const evaluation = await tx.qmEvaluation.findFirst({
      where: { tenantId: actor.tenantId, interactionId, source: 'HUMAN' },
      select: {
        id: true,
        interactionId: true,
        agentId: true,
        evaluatorId: true,
        status: true,
        revision: true,
        formVersionId: true,
        formSnapshot: true,
        answers: true,
        comment: true,
        rawScore: true,
        finalScore: true,
        autoFailed: true,
        publishedAt: true,
        updatedAt: true,
      },
    });
    if (!evaluation) return null;
    const snapshot = evaluation.formSnapshot as unknown as FormSnapshot;
    const answers = storedAnswers(evaluation.answers);
    const scored = scoreEvaluation(snapshot.definition, answers);
    const required = snapshot.definition.sections
      .flatMap((section) => section.questions)
      .filter((question) => question.type !== 'TEXT');
    const answeredIds = new Set(answers.map((answer) => answer.questionId));
    const complete = required.every((question) => answeredIds.has(question.id));
    const evaluator = evaluation.evaluatorId
      ? await tx.user.findFirst({
          where: { tenantId: actor.tenantId, id: evaluation.evaluatorId },
          select: { displayName: true },
        })
      : null;
    return {
      evaluationId: evaluation.id,
      interactionId: evaluation.interactionId,
      agentId: evaluation.agentId,
      evaluatorName: evaluator?.displayName ?? null,
      status: evaluation.status,
      revision: evaluation.revision,
      formVersionId: evaluation.formVersionId,
      form: snapshot,
      answers: answersView(answers),
      comment: evaluation.comment,
      progress: {
        answered: required.filter((question) => answeredIds.has(question.id)).length,
        required: required.length,
      },
      // a fully answered draft shows a preview score to the Supervisor before publishing
      score:
        evaluation.status === 'PUBLISHED'
          ? {
              preview: false,
              rawScore: score(evaluation.rawScore),
              finalScore: score(evaluation.finalScore),
              autoFailed: evaluation.autoFailed,
              sections: scored?.sections ?? [],
            }
          : complete && scored
            ? { preview: true, ...scored }
            : null,
      publishedAt: evaluation.publishedAt?.toISOString() ?? null,
      updatedAt: evaluation.updatedAt.toISOString(),
    };
  }
}
