/**
 * J5.5 (#343): REST adapter ของ Journey template catalog (Phase Spec #337 §5, §7)
 *
 * ใช้ parser/auth/error mapping ชุดเดียวกับ `journey-authoring-api.ts`; ค่า parameter binding ผ่าน
 * controller ไปถึง binder เท่านั้น ไม่ถูก log หรือสะท้อนกลับใน error
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  JOURNEY_REVIEW_DECISIONS,
  JOURNEY_TEMPLATE_ORIGINS,
  JOURNEY_TEMPLATE_VISIBILITIES,
  type AuthoringDocumentV1,
  type JourneyTemplateParameterV1,
} from '@d-contact/cxa-contracts';
import type { JourneyTemplateRepository } from '@d-contact/journey';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  JOURNEY_AUTHORING_REPOSITORY,
  authoringActor,
  commandContext,
  handle,
  parse,
  pathUuid,
  pathVersion,
  queryLimit,
  strictBody,
} from './journey-authoring-api.js';

const templateContent = {
  document: parse.object,
  parameterSchema: parse.array,
};
const headLifecycle = { expectedHeadVersion: parse.positiveInt, reasonCode: parse.reasonCode };

/** document/schema ถูกตรวจเชิงลึกโดย binder/validator ใน domain — ที่นี่แค่รูปชั้นนอก */
const asDocument = (value: Record<string, unknown>) => value as unknown as AuthoringDocumentV1;
const asSchema = (value: unknown[]) => value as unknown as JourneyTemplateParameterV1[];

@Controller('api/v1/journey-authoring')
export class JourneyTemplateController {
  constructor(
    @Inject(JOURNEY_AUTHORING_REPOSITORY)
    private readonly repository: JourneyTemplateRepository,
  ) {}

  @Get('templates')
  list(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('origin') origin?: string,
    @Query('visibility') visibility?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    const { tenantId, actor } = authoringActor(request);
    const filters = {
      ...(origin !== undefined
        ? { origin: parse.oneOf(JOURNEY_TEMPLATE_ORIGINS)(origin, 'origin') }
        : {}),
      ...(visibility !== undefined
        ? { visibility: parse.oneOf(JOURNEY_TEMPLATE_VISIBILITIES)(visibility, 'visibility') }
        : {}),
      ...(cursor !== undefined ? { cursor: parse.uuid(cursor, 'cursor') } : {}),
      limit: queryLimit(limit),
    };
    return handle(() => this.repository.listVisibleTemplates(tenantId, actor, filters));
  }

  @Post('templates')
  @HttpCode(200)
  create(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const input = strictBody(body, {
      ownerTeamId: parse.uuid,
      visibility: parse.oneOf(JOURNEY_TEMPLATE_VISIBILITIES),
      name: parse.name,
      ...templateContent,
    });
    const context = commandContext(request);
    return handle(() =>
      this.repository.createTemplateDraft(context, {
        ...input,
        document: asDocument(input.document),
        parameterSchema: asSchema(input.parameterSchema),
      }),
    );
  }

  @Get('templates/:templateId')
  get(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Query('version') version?: string,
  ) {
    const { tenantId, actor } = authoringActor(request);
    const id = pathUuid(templateId, 'templateId');
    const pinned = version !== undefined ? pathVersion(version, 'version') : undefined;
    return handle(() =>
      this.repository.getTemplate(tenantId, actor, {
        templateId: id,
        ...(pinned !== undefined ? { version: pinned } : {}),
      }),
    );
  }

  @Put('templates/:templateId/draft')
  update(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      expectedHeadVersion: parse.positiveInt,
      expectedDraftRevision: parse.positiveInt,
      expectedDraftDigest: parse.digest,
      ...templateContent,
    });
    const context = commandContext(request);
    const id = pathUuid(templateId, 'templateId');
    return handle(() =>
      this.repository.updateTemplateDraft(context, {
        ...input,
        templateId: id,
        document: asDocument(input.document),
        parameterSchema: asSchema(input.parameterSchema),
      }),
    );
  }

  @Post('templates/:templateId/draft/discard')
  @HttpCode(200)
  discard(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      expectedHeadVersion: parse.positiveInt,
      expectedDraftRevision: parse.positiveInt,
      expectedDraftDigest: parse.digest,
      reasonCode: parse.reasonCode,
    });
    const context = commandContext(request);
    const id = pathUuid(templateId, 'templateId');
    return handle(() =>
      this.repository.discardTemplateDraft(context, { ...input, templateId: id }),
    );
  }

  @Post('templates/:templateId/reviews')
  @HttpCode(200)
  submitReview(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      draftRevision: parse.positiveInt,
      draftDigest: parse.digest,
      baseHeadVersion: parse.positiveInt,
    });
    const context = commandContext(request);
    const id = pathUuid(templateId, 'templateId');
    return handle(() =>
      this.repository.submitTemplateReview(context, { ...input, templateId: id }),
    );
  }

  @Post('template-reviews/:reviewId/decisions')
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
      const templateId = await this.repository.reviewResourceId(context.tenantId, id, 'TEMPLATE');
      return this.repository.decideTemplateReview(context, { ...input, templateId, reviewId: id });
    });
  }

  @Post('templates/:templateId/publish')
  @HttpCode(200)
  publish(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      reviewId: parse.uuid,
      draftRevision: parse.positiveInt,
      draftDigest: parse.digest,
      expectedHeadVersion: parse.positiveInt,
    });
    const context = commandContext(request);
    const id = pathUuid(templateId, 'templateId');
    return handle(() =>
      this.repository.publishTemplateVersion(context, { ...input, templateId: id }),
    );
  }

  @Post('templates/:templateId/visibility')
  @HttpCode(200)
  visibility(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      ...headLifecycle,
      visibility: parse.oneOf(JOURNEY_TEMPLATE_VISIBILITIES),
    });
    const context = commandContext(request);
    const id = pathUuid(templateId, 'templateId');
    return handle(() =>
      this.repository.changeTemplateVisibility(context, { ...input, templateId: id }),
    );
  }

  @Post('templates/:templateId/deprecate')
  @HttpCode(200)
  deprecate(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle(request, templateId, body, 'DEPRECATED');
  }

  @Post('templates/:templateId/archive')
  @HttpCode(200)
  archive(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle(request, templateId, body, 'ARCHIVED');
  }

  @Post('templates/:templateId/restore')
  @HttpCode(200)
  restore(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Body() body: unknown,
  ) {
    return this.lifecycle(request, templateId, body, 'ACTIVE');
  }

  @Post('templates/:templateId/versions/:version/instantiate')
  @HttpCode(200)
  instantiate(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      expectedContentDigest: parse.digest,
      bindings: parse.recordOf(parse.scalar),
      targetOwnerTeamId: parse.uuid,
      name: parse.name,
    });
    const context = commandContext(request);
    const id = pathUuid(templateId, 'templateId');
    const pinned = pathVersion(version, 'version');
    return handle(() =>
      this.repository.instantiateTemplate(context, {
        ...input,
        origin: this.repository.templateOrigin(id),
        templateId: id,
        version: pinned,
      }),
    );
  }

  @Post('templates/:templateId/versions/:version/fork')
  @HttpCode(200)
  fork(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('templateId') templateId: string,
    @Param('version') version: string,
    @Body() body: unknown,
  ) {
    const input = strictBody(body, {
      expectedContentDigest: parse.digest,
      targetOwnerTeamId: parse.uuid,
      name: parse.name,
      visibility: parse.oneOf(JOURNEY_TEMPLATE_VISIBILITIES),
    });
    const context = commandContext(request);
    const id = pathUuid(templateId, 'templateId');
    const pinned = pathVersion(version, 'version');
    return handle(() =>
      this.repository.forkTemplate(context, {
        ...input,
        origin: this.repository.templateOrigin(id),
        templateId: id,
        version: pinned,
      }),
    );
  }

  private lifecycle(
    request: AuthenticatedGatewayRequest,
    templateId: string,
    body: unknown,
    target: 'DEPRECATED' | 'ARCHIVED' | 'ACTIVE',
  ) {
    const input = strictBody(body, headLifecycle);
    const context = commandContext(request);
    const id = pathUuid(templateId, 'templateId');
    return handle(() =>
      this.repository.changeTemplateLifecycle(context, { ...input, templateId: id, target }),
    );
  }
}
