/**
 * U1.1 (#429) — UAT run API ของ Journey Console ใน UAT first slice
 *
 * Authority: Phase Contract #374, fixture/reset #376, evidence #379
 *
 * tenant/actor มาจาก verified token เท่านั้น; browser ส่งได้แค่ opaque id, revision และค่าที่ผู้ทดสอบกรอก
 * mutation ทุกตัวต้องมี `Idempotency-Key`; `เริ่มรอบใหม่` ใช้ `expectedRevision` ของ run ที่ ACTIVE (0 = ยังไม่มี)
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
  Query,
  Req,
} from '@nestjs/common';
import { UatRunError, type UatRunRepository } from '@d-contact/journey';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  RequestMalformed,
  authoringActor,
  commandContext,
  mapAuthoringError,
  parse,
  pathUuid,
  queryLimit,
  strictBody,
  type FieldParser,
} from './journey-authoring-api.js';

export const UAT_RUN_REPOSITORY = Symbol('UAT_RUN_REPOSITORY');

const nonNegativeInt = ((value, field) => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RequestMalformed(field);
  }
  return value;
}) as FieldParser<number>;

const testerText = ((value, field) => {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 2000) {
    throw new RequestMalformed(field);
  }
  return value;
}) as FieldParser<string>;

async function handle<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof UatRunError) {
      throw new HttpException(
        { code: error.code, ...(error.safeParams ? { safeParams: error.safeParams } : {}) },
        error.httpStatus,
      );
    }
    // createJourneyDraft ของ J5 ระหว่าง `เริ่มรอบใหม่` คืน error contract ของ J5 ตามเดิม
    return mapAuthoringError(error);
  }
}

@Controller('api/v1/uat-runs')
export class UatRunController {
  constructor(@Inject(UAT_RUN_REPOSITORY) private readonly repository: UatRunRepository) {}

  @Get('current')
  current(@Req() request: AuthenticatedGatewayRequest) {
    const { tenantId, actor } = authoringActor(request);
    return handle(() => this.repository.current(tenantId, actor));
  }

  /** fixture ที่ server ตรึงไว้ของ run ปัจจุบัน — ใช้แทน startAt/seed ที่ browser สร้างเอง (#374 §4) */
  @Get('current/simulation-fixture')
  simulationFixture(@Req() request: AuthenticatedGatewayRequest) {
    const { tenantId, actor } = authoringActor(request);
    return handle(() => this.repository.simulationFixture(tenantId, actor));
  }

  @Get()
  history(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const { tenantId, actor } = authoringActor(request);
    if (cursor !== undefined && !/^[1-9][0-9]{0,8}$/.test(cursor)) {
      throw new RequestMalformed('cursor');
    }
    return handle(() =>
      this.repository.history(tenantId, actor, {
        limit: queryLimit(limit) ?? 20,
        ...(cursor !== undefined ? { beforeSequence: Number(cursor) } : {}),
      }),
    );
  }

  @Get(':runId')
  get(@Req() request: AuthenticatedGatewayRequest, @Param('runId') runId: string) {
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(runId, 'runId');
    return handle(() => this.repository.get(tenantId, actor, id));
  }

  /** `เริ่มรอบใหม่` */
  @Post('start')
  @HttpCode(200)
  start(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const input = strictBody(body, {
      environment: parse.opaque,
      packVersion: parse.opaque,
      expectedRevision: nonNegativeInt,
    });
    const context = commandContext(request);
    return handle(() => this.repository.startNewRun(context, input));
  }

  @Post(':runId/step-results')
  @HttpCode(200)
  recordStepResult(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('runId') runId: string,
    @Body() body: unknown,
  ) {
    const id = pathUuid(runId, 'runId');
    const input = strictBody(
      body,
      {
        stepId: parse.opaque,
        outcome: parse.oneOf(['PASS', 'FAIL', 'BLOCKED'] as const),
        actual: testerText,
      },
      {
        severity: parse.oneOf(['S1', 'S2', 'S3', 'S4'] as const),
        correlationId: parse.opaque,
      },
    );
    const context = commandContext(request);
    return handle(() => this.repository.recordStepResult(context, { runId: id, ...input }));
  }
}
