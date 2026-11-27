/**
 * #1044: web chat for the Agent in Workspace and its settings for the Admin in Console.
 * The role in the token opens the route; the service reads the role and ownership from the database again.
 */
import type { ServerResponse } from 'node:http';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { PrismaClient } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { WEBCHAT_SERVICE, webchatMapped } from './webchat-public-api.js';
import type { WebchatService } from './webchat-service.js';
import { readWebchatWidget, saveWebchatWidget } from './webchat-widget.js';

export const WEBCHAT_DATABASE = Symbol('WEBCHAT_DATABASE');

function actorOf(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new ForbiddenException();
  return { tenantId: request.gatewayIdentity.tenantId, userId: request.gatewayIdentity.userId };
}

@Controller('api/v1/workspace/agent/webchat')
@GatewayRoles('agent')
export class WebchatAgentController {
  constructor(@Inject(WEBCHAT_SERVICE) private readonly webchat: WebchatService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  chats(@Req() request: AuthenticatedGatewayRequest) {
    return webchatMapped(null, () => this.webchat.agentChats(actorOf(request)));
  }

  @Get(':interactionId/messages')
  @Header('Cache-Control', 'no-store')
  messages(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
    @Query('after') after: unknown,
  ) {
    return webchatMapped(null, () =>
      this.webchat.agentMessages(actorOf(request), interactionId, after),
    );
  }

  /** #1054 the delivery state of the Agent's LINE messages */
  @Get(':interactionId/deliveries')
  @Header('Cache-Control', 'no-store')
  deliveries(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
  ) {
    return webchatMapped(null, () => this.webchat.agentDeliveries(actorOf(request), interactionId));
  }

  @Post(':interactionId/accept')
  @HttpCode(200)
  accept(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
  ) {
    return webchatMapped(null, () => this.webchat.agentAccept(actorOf(request), interactionId));
  }

  @Post(':interactionId/messages')
  @HttpCode(201)
  send(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('interactionId') interactionId: string,
    @Body() body: unknown,
  ) {
    return webchatMapped(null, () => this.webchat.agentSend(actorOf(request), interactionId, body));
  }

  @Post(':interactionId/end')
  @HttpCode(200)
  end(@Req() request: AuthenticatedGatewayRequest, @Param('interactionId') interactionId: string) {
    return webchatMapped(null, () => this.webchat.agentEnd(actorOf(request), interactionId));
  }
}

@Controller('api/v1/webchat/widget')
export class WebchatWidgetController {
  constructor(@Inject(WEBCHAT_DATABASE) private readonly database: PrismaClient) {}

  @Get()
  @GatewayRoles('admin', 'supervisor')
  @Header('Cache-Control', 'no-store')
  read(@Req() request: AuthenticatedGatewayRequest) {
    return webchatMapped(null, () => readWebchatWidget(this.database, actorOf(request)));
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
      saveWebchatWidget(
        this.database,
        actorOf(request),
        body,
        request.correlationId ?? 'unavailable',
      ),
    );
  }
}
