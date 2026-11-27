/**
 * #1054: LINE chat routes. LINE calls the webhook without a user (the channel's signature is the proof);
 * the Console reads and saves the channel settings with the Admin's token.
 */
import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import type { PrismaClient } from '@d-contact/db';
import type { AccountSecretBox } from './account-identity.js';
import { GatewayPublic, GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { readLineChannel, saveLineChannel } from './line-chat-channel.js';
import type { LineChatClient } from './line-chat-client.js';
import type { LineChatService } from './line-chat-service.js';
import { webchatMapped } from './webchat-public-api.js';

export const LINE_CHAT_SERVICE = Symbol('LINE_CHAT_SERVICE');
export const LINE_CHAT_DEPENDENCIES = Symbol('LINE_CHAT_DEPENDENCIES');

export interface LineChatDependencies {
  database: PrismaClient;
  box: AccountSecretBox | null;
  client: LineChatClient;
}

function actorOf(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return { tenantId: request.gatewayIdentity.tenantId, userId: request.gatewayIdentity.userId };
}

@Controller('api/v1/line/webhook')
@GatewayPublic()
export class LineChatWebhookController {
  constructor(@Inject(LINE_CHAT_SERVICE) private readonly line: LineChatService) {}

  @Post(':tenantId/:channelId')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async webhook(
    @Req() request: RawBodyRequest<AuthenticatedGatewayRequest>,
    @Param('tenantId') tenantId: string,
    @Param('channelId') channelId: string,
    @Headers('x-line-signature') signature: unknown,
  ) {
    await webchatMapped(null, () =>
      this.line.webhook(tenantId, channelId, request.rawBody, signature),
    );
    // LINE reads only the status; the body says nothing about what was stored
    return {};
  }
}

@Controller('api/v1/line/channel')
export class LineChannelController {
  constructor(
    @Inject(LINE_CHAT_DEPENDENCIES) private readonly dependencies: LineChatDependencies,
  ) {}

  @Get()
  @GatewayRoles('admin', 'supervisor')
  @Header('Cache-Control', 'no-store')
  read(@Req() request: AuthenticatedGatewayRequest) {
    return webchatMapped(null, () => readLineChannel(this.dependencies.database, actorOf(request)));
  }

  @Put()
  @GatewayRoles('admin')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  save(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Body() body: unknown,
  ) {
    return webchatMapped(response, () =>
      saveLineChannel(
        this.dependencies.database,
        this.dependencies,
        actorOf(request),
        body,
        request.correlationId ?? 'unavailable',
      ),
    );
  }
}
