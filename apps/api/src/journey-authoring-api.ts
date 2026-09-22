/**
 * J5.5 (#343): REST adapter ของ Journey authoring (Phase Spec #337 §5)
 *
 * controller ทำแค่สี่อย่าง: auth context, strict body parsing, header/CAS extraction และ error
 * mapping — policy, authorization และ transaction ทั้งหมดอยู่ใน `JourneyTemplateRepository`
 *
 * - tenant/subject มาจาก verified token เท่านั้น ไม่รับจาก body/query
 * - body ที่มี field ไม่รู้จักหรือชนิดผิดตอบ `400 REQUEST_MALFORMED` ก่อนถึง domain
 * - ทุก mutation ต้องมี `Idempotency-Key`; GET ไม่รับ key
 * - error ส่งแค่ `code`/`safeParams`/diagnostics ที่มีขอบเขต ไม่มีข้อความ localized หรือ detail ดิบ
 * - publish ที่ไม่รู้ผล (commit แล้วหรือยังไม่รู้) ตอบ `202 PUBLISH_OUTCOME_UNKNOWN` พร้อม key เดิม
 *   ให้ resolve — ไม่ตอบสำเร็จแบบ optimistic และไม่ retry เอง
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import {
  JOURNEY_LIFECYCLES,
  JOURNEY_REVIEW_DECISIONS,
  type JourneyAuthoringErrorCode,
  type JourneyDiagnosticV1,
  type SimulationFixtureV1,
} from '@d-contact/cxa-contracts';
import {
  JourneyAuthoringError,
  type JourneyAuthoringActor,
  type JourneyCommandContext,
  type JourneyTemplateRepository,
} from '@d-contact/journey';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';

export const JOURNEY_AUTHORING_REPOSITORY = Symbol('JOURNEY_AUTHORING_REPOSITORY');

/** diagnostics ในคำตอบ error มีเพดาน เพื่อไม่ให้ payload โตตาม graph ที่ส่งเข้ามา */
export const MAX_ERROR_DIAGNOSTICS = 50;

// ── Strict DTO parsing ──────────────────────────────────────────────────────

export class RequestMalformed extends HttpException {
  constructor(field: string) {
    super({ code: 'REQUEST_MALFORMED', safeParams: { field } }, 400);
  }
}

export type FieldParser<T = unknown> = (value: unknown, field: string) => T;

const DIGEST = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z][A-Z0-9_]{2,63}$/;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const parse = {
  positiveInt: ((value, field) => {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
      throw new RequestMalformed(field);
    return value;
  }) as FieldParser<number>,
  digest: ((value, field) => {
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new RequestMalformed(field);
    return value;
  }) as FieldParser<string>,
  nullableDigest: ((value, field) =>
    value === null ? null : parse.digest(value, field)) as FieldParser<string | null>,
  uuid: ((value, field) => {
    if (typeof value !== 'string' || !UUID.test(value)) throw new RequestMalformed(field);
    return value.toLowerCase();
  }) as FieldParser<string>,
  reasonCode: ((value, field) => {
    if (typeof value !== 'string' || !CODE.test(value)) throw new RequestMalformed(field);
    return value;
  }) as FieldParser<string>,
  opaque: ((value, field) => {
    if (typeof value !== 'string' || !OPAQUE.test(value)) throw new RequestMalformed(field);
    return value;
  }) as FieldParser<string>,
  name: ((value, field) => {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 200)
      throw new RequestMalformed(field);
    return value;
  }) as FieldParser<string>,
  /** document/schema ถูก validate เชิงลึกโดย domain — ที่นี่แค่บังคับรูป JSON ชั้นนอก */
  object: ((value, field) => {
    if (!isPlainObject(value)) throw new RequestMalformed(field);
    return value;
  }) as FieldParser<Record<string, unknown>>,
  array: ((value, field) => {
    if (!Array.isArray(value)) throw new RequestMalformed(field);
    return value;
  }) as FieldParser<unknown[]>,
  oneOf<T extends string>(values: readonly T[]): FieldParser<T> {
    return (value, field) => {
      if (typeof value !== 'string' || !(values as readonly string[]).includes(value))
        throw new RequestMalformed(field);
      return value as T;
    };
  },
  recordOf<T>(item: FieldParser<T>, maxKeys = 100): FieldParser<Record<string, T>> {
    return (value, field) => {
      if (!isPlainObject(value) || Object.keys(value).length > maxKeys)
        throw new RequestMalformed(field);
      const result: Record<string, T> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (!/^[A-Za-z@][A-Za-z0-9_.:@-]{0,127}$/.test(key))
          throw new RequestMalformed(`${field}.${key}`);
        result[key] = item(entry, `${field}.${key}`);
      }
      return result;
    };
  },
  scalar: ((value, field) => {
    if (!(
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    ))
      throw new RequestMalformed(field);
    return value;
  }) as FieldParser<string | number | boolean>,
};

type Parsed<S extends Record<string, FieldParser>> = { [K in keyof S]: ReturnType<S[K]> };

/** field ที่ไม่รู้จักหรือขาด field บังคับ → 400 ทันที; optional ที่ไม่ส่งมาไม่ปรากฏในผล */
export function strictBody<
  R extends Record<string, FieldParser>,
  O extends Record<string, FieldParser> = Record<never, FieldParser>,
>(raw: unknown, required: R, optional?: O, prefix = 'body'): Parsed<R> & Partial<Parsed<O>> {
  if (!isPlainObject(raw)) throw new RequestMalformed(prefix);
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(raw)) {
    if (!(key in required) && !(optional && key in optional))
      throw new RequestMalformed(`${prefix}.${key}`);
  }
  for (const [key, parser] of Object.entries(required)) {
    if (!(key in raw)) throw new RequestMalformed(`${prefix}.${key}`);
    result[key] = parser(raw[key], `${prefix}.${key}`);
  }
  for (const [key, parser] of Object.entries(optional ?? {})) {
    if (key in raw) result[key] = parser(raw[key], `${prefix}.${key}`);
  }
  return result as Parsed<R> & Partial<Parsed<O>>;
}

export function pathUuid(value: string, field: string): string {
  return parse.uuid(value, field);
}

export function pathVersion(value: string, field: string): number {
  if (!/^[1-9][0-9]{0,8}$/.test(value)) throw new RequestMalformed(field);
  return Number(value);
}

export function queryLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100) throw new RequestMalformed('limit');
  return Number(value);
}

// ── Auth context ────────────────────────────────────────────────────────────

/** workspace identity เท่านั้น — service principal ไม่มี subject ที่ถือ capability ของ authoring */
export function authoringActor(request: AuthenticatedGatewayRequest): {
  tenantId: string;
  actor: JourneyAuthoringActor;
} {
  const identity = request.gatewayIdentity;
  if (!identity) throw new UnauthorizedException();
  return {
    tenantId: identity.tenantId,
    actor: { subjectId: identity.userId, correlationId: request.correlationId ?? '' },
  };
}

export function idempotencyKey(request: AuthenticatedGatewayRequest): string {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value)) {
    throw new RequestMalformed('Idempotency-Key');
  }
  return value;
}

export function commandContext(request: AuthenticatedGatewayRequest): JourneyCommandContext {
  const { tenantId, actor } = authoringActor(request);
  return { tenantId, actor, idempotencyKey: idempotencyKey(request) };
}

// ── Error mapping ───────────────────────────────────────────────────────────

const DEPENDENCY_ERROR_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);

function dependencyFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, code } = error as { name?: unknown; code?: unknown };
  return (
    name === 'PrismaClientInitializationError' ||
    name === 'PrismaClientRustPanicError' ||
    (typeof code === 'string' && DEPENDENCY_ERROR_CODES.has(code))
  );
}

function errorBody(
  code: JourneyAuthoringErrorCode,
  safeParams?: Record<string, unknown>,
  diagnostics?: readonly JourneyDiagnosticV1[],
) {
  return {
    code,
    ...(safeParams ? { safeParams } : {}),
    ...(diagnostics && diagnostics.length > 0
      ? {
          diagnostics: diagnostics.slice(0, MAX_ERROR_DIAGNOSTICS),
          diagnosticsTruncated: diagnostics.length > MAX_ERROR_DIAGNOSTICS,
        }
      : {}),
  };
}

export function mapAuthoringError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof JourneyAuthoringError) {
    throw new HttpException(
      errorBody(error.code, error.safeParams as Record<string, unknown>, error.diagnostics),
      error.httpStatus,
    );
  }
  if (dependencyFailure(error)) {
    throw new HttpException(errorBody('DEPENDENCY_UNAVAILABLE'), 503);
  }
  throw error;
}

export async function handle<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    mapAuthoringError(error);
  }
}

// ── Controller ──────────────────────────────────────────────────────────────

const draftCas = {
  expectedHeadVersion: parse.positiveInt,
  expectedDraftRevision: parse.positiveInt,
  expectedDraftDigest: parse.digest,
};
const draftBinding = { draftRevision: parse.positiveInt, draftDigest: parse.digest };
const lifecycleBody = { expectedHeadVersion: parse.positiveInt, reasonCode: parse.reasonCode };

function parseFixture(value: unknown, field: string): SimulationFixtureV1 {
  const outcome = <T extends string>(values: readonly T[]) =>
    parse.recordOf(parse.oneOf(values), 200);
  return strictBody(
    value,
    {
      fixtureId: parse.opaque,
      startAt: parse.name,
      seed: parse.opaque,
      context: parse.recordOf(((entry, name) =>
        entry === null ? null : parse.scalar(entry, name)) as FieldParser<
        string | number | boolean | null
      >),
    },
    {
      sendOutcomes: outcome(['SENT', 'SUPPRESSED', 'SCOPE_DENIED'] as const),
      ownerOutcomes: outcome(['ACCEPTED', 'REJECTED'] as const),
    },
    field,
  );
}

@Controller('api/v1/journey-authoring')
export class JourneyAuthoringController {
  constructor(
    @Inject(JOURNEY_AUTHORING_REPOSITORY)
    private readonly repository: JourneyTemplateRepository,
  ) {}

  @Get('journeys')
  list(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('lifecycle') lifecycle?: string,
    @Query('ownerTeamId') ownerTeamId?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const { tenantId, actor } = authoringActor(request);
    const filters = {
      ...(lifecycle !== undefined
        ? { lifecycle: parse.oneOf(JOURNEY_LIFECYCLES)(lifecycle, 'lifecycle') }
        : {}),
      ...(ownerTeamId !== undefined ? { ownerTeamId: parse.uuid(ownerTeamId, 'ownerTeamId') } : {}),
      ...(cursor !== undefined ? { cursor: parse.uuid(cursor, 'cursor') } : {}),
      limit: queryLimit(limit),
    };
    return handle(() => this.repository.listVisibleJourneys(tenantId, actor, filters));
  }

  @Post('journeys')
  @HttpCode(200)
  create(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const input = strictBody(body, { ownerTeamId: parse.uuid, document: parse.object });
    const context = commandContext(request);
    return handle(() => this.repository.createJourneyDraft(context, input));
  }

  /** state + notice ของ template ต้นทาง (ข้อมูลเท่านั้น ไม่ auto-apply) */
  @Get('journeys/:journeyId')
  get(@Req() request: AuthenticatedGatewayRequest, @Param('journeyId') journeyId: string) {
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(async () => {
      const state = await this.repository.getJourneyAuthoringState(tenantId, actor, id);
      const templateNotices = await this.repository.listTemplateNotices(tenantId, actor, id);
      return { ...state, templateNotices };
    });
  }

  @Put('journeys/:journeyId/draft')
  update(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, { ...draftCas, document: parse.object });
    const context = commandContext(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() => this.repository.updateJourneyDraft(context, { ...input, journeyId: id }));
  }

  @Post('journeys/:journeyId/draft/discard')
  @HttpCode(200)
  discard(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, { ...draftCas, reasonCode: parse.reasonCode });
    const context = commandContext(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() => this.repository.discardJourneyDraft(context, { ...input, journeyId: id }));
  }

  @Post('journeys/:journeyId/validate')
  @HttpCode(200)
  validate(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, draftBinding);
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() =>
      this.repository.validateJourneyDraft(tenantId, actor, { ...input, journeyId: id }),
    );
  }

  @Post('journeys/:journeyId/compile')
  @HttpCode(200)
  compile(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, { ...draftBinding, expectedHeadVersion: parse.positiveInt });
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(async () => {
      const result = await this.repository.compileJourneyDraft(tenantId, actor, {
        journeyId: id,
        draftRevision: input.draftRevision,
        draftDigest: input.draftDigest,
      });
      // runtime definition เป็นรายละเอียดภายใน — API คืนแค่ digest/diagnostics ที่ใช้ผูก review/publish
      const artifact = result.artifact
        ? {
            compileDigest: result.artifact.compileDigest,
            runtimeHash: result.artifact.runtimeHash,
            referenceDigest: result.artifact.referenceDigest,
            capabilityDigest: result.artifact.capabilityDigest,
            baseHeadVersion: result.artifact.baseHeadVersion,
          }
        : null;
      return {
        artifact,
        diagnostics: result.diagnostics,
        stale: result.stale,
        headStale: artifact !== null && artifact.baseHeadVersion !== input.expectedHeadVersion,
      };
    });
  }

  @Post('journeys/:journeyId/preview')
  @HttpCode(200)
  preview(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, { compileDigest: parse.digest });
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() =>
      this.repository.previewJourneyPlan(tenantId, actor, { ...input, journeyId: id }),
    );
  }

  @Post('journeys/:journeyId/simulations')
  @HttpCode(200)
  simulate(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, { compileDigest: parse.digest, fixture: parseFixture });
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() =>
      this.repository.simulateJourneyScenario(tenantId, actor, { ...input, journeyId: id }),
    );
  }

  @Post('journeys/:journeyId/reviews')
  @HttpCode(200)
  submitReview(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      ...draftBinding,
      compileDigest: parse.digest,
      referenceDigest: parse.digest,
      capabilityDigest: parse.digest,
      baseHeadVersion: parse.positiveInt,
      baseHeadDigest: parse.nullableDigest,
    });
    const context = commandContext(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() => this.repository.submitJourneyReview(context, { ...input, journeyId: id }));
  }

  @Post('reviews/:reviewId/decisions')
  @HttpCode(200)
  decideReview(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('reviewId') reviewId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      expectedReviewState: parse.oneOf(['IN_REVIEW'] as const),
      decision: parse.oneOf(JOURNEY_REVIEW_DECISIONS),
      reasonCode: parse.reasonCode,
      evidenceRef: parse.opaque,
    });
    const context = commandContext(request);
    const id = pathUuid(reviewId, 'reviewId');
    return handle(async () => {
      const journeyId = await this.repository.reviewResourceId(context.tenantId, id, 'JOURNEY');
      return this.repository.decideJourneyReview(context, { ...input, journeyId, reviewId: id });
    });
  }

  @Post('journeys/:journeyId/publish')
  @HttpCode(200)
  publish(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      reviewId: parse.uuid,
      ...draftBinding,
      compileDigest: parse.digest,
      referenceDigest: parse.digest,
      capabilityDigest: parse.digest,
      baseHeadVersion: parse.positiveInt,
      baseHeadDigest: parse.nullableDigest,
      expectedHeadVersion: parse.positiveInt,
    });
    const context = commandContext(request);
    const id = pathUuid(journeyId, 'journeyId');
    return (async () => {
      try {
        return await this.repository.publishJourneyDraft(context, { ...input, journeyId: id });
      } catch (error) {
        if (error instanceof JourneyAuthoringError || error instanceof HttpException) {
          mapAuthoringError(error);
        }
        // commit อาจเกิดแล้วหรือยังไม่เกิด — บอกตามจริงและให้ resolve ด้วย key เดิมเท่านั้น
        throw new HttpException(
          {
            code: 'PUBLISH_OUTCOME_UNKNOWN',
            resolution: { journeyId: id, originalIdempotencyKey: context.idempotencyKey },
          },
          202,
        );
      }
    })();
  }

  /** อ่าน receipt ของ key เดิมอย่างเดียว — ไม่ publish ซ้ำ จึงไม่ต้องมี Idempotency-Key ใหม่ */
  @Post('journeys/:journeyId/publish-resolution')
  @HttpCode(200)
  resolvePublish(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, { originalIdempotencyKey: parse.opaque });
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() =>
      this.repository.resolvePublish(tenantId, actor, { ...input, journeyId: id }),
    );
  }

  @Post('journeys/:journeyId/pause')
  @HttpCode(200)
  pause(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle(request, journeyId, body, 'PAUSED');
  }

  @Post('journeys/:journeyId/resume')
  @HttpCode(200)
  resume(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle(request, journeyId, body, 'ACTIVE');
  }

  @Post('journeys/:journeyId/deprecate')
  @HttpCode(200)
  deprecate(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle(request, journeyId, body, 'DEPRECATED');
  }

  @Post('journeys/:journeyId/ownership-transfer')
  @HttpCode(200)
  transfer(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      expectedHeadVersion: parse.positiveInt,
      targetTeamId: parse.uuid,
      reasonCode: parse.reasonCode,
    });
    const context = commandContext(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() =>
      this.repository.transferJourneyOwnership(context, { ...input, journeyId: id }),
    );
  }

  @Post('journeys/:journeyId/roll-forwards')
  @HttpCode(200)
  rollForward(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      sourceVersion: parse.positiveInt,
      expectedHeadVersion: parse.positiveInt,
    });
    const context = commandContext(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() =>
      this.repository.createRollForwardFromVersion(context, { ...input, journeyId: id }),
    );
  }

  @Post('journeys/:journeyId/versions/:version/clones')
  @HttpCode(200)
  clone(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, { targetOwnerTeamId: parse.uuid, name: parse.name });
    const context = commandContext(request);
    const id = pathUuid(journeyId, 'journeyId');
    const sourceVersion = pathVersion(version, 'version');
    return handle(() =>
      this.repository.cloneJourneyFromVersion(context, {
        ...input,
        journeyId: id,
        version: sourceVersion,
      }),
    );
  }

  @Get('journeys/:journeyId/audit')
  audit(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
  ) {
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(journeyId, 'journeyId');
    if (before !== undefined && Number.isNaN(Date.parse(before))) {
      throw new RequestMalformed('before');
    }
    return handle(async () => ({
      items: await this.repository.listJourneyAudit(tenantId, actor, {
        journeyId: id,
        limit: queryLimit(limit),
        ...(before !== undefined ? { before: new Date(before).toISOString() } : {}),
      }),
    }));
  }

  @Post('journeys/:journeyId/template-upgrade-checks')
  @HttpCode(200)
  checkUpgrade(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, { ...draftBinding, targetVersion: parse.positiveInt });
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() =>
      this.repository.checkTemplateUpgrade(tenantId, actor, { ...input, journeyId: id }),
    );
  }

  @Post('journeys/:journeyId/template-upgrades')
  @HttpCode(200)
  applyUpgrade(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('journeyId') journeyId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      ...draftCas,
      targetVersion: parse.positiveInt,
      proposalDigest: parse.digest,
      conflictDigest: parse.digest,
      resolutions: parse.recordOf(parse.oneOf(['KEEP_LOCAL', 'TAKE_TEMPLATE'] as const)),
    });
    const context = commandContext(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() => this.repository.applyTemplateUpgrade(context, { ...input, journeyId: id }));
  }

  private lifecycle(
    request: AuthenticatedGatewayRequest,
    journeyId: string,
    body: unknown,
    target: 'PAUSED' | 'ACTIVE' | 'DEPRECATED',
  ) {
    const input = strictBody(body, lifecycleBody);
    const context = commandContext(request);
    const id = pathUuid(journeyId, 'journeyId');
    return handle(() =>
      this.repository.changeJourneyLifecycle(context, { ...input, journeyId: id, target }),
    );
  }
}
