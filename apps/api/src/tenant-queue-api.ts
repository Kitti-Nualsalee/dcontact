import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaClient } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  createVoiceQueue,
  listDirectVoiceDestinations,
  listQueueAuditEvents,
  listTenantQueues,
  setDirectVoiceDestination,
  TenantQueueNotFoundError,
  updateVoiceQueue,
} from './tenant-queue.js';

export const TENANT_QUEUE_DATABASE = Symbol('TENANT_QUEUE_DATABASE');

interface CreateVoiceQueueBody {
  name?: unknown;
  slaThresholdSec?: unknown;
  maxWaitSec?: unknown;
  priority?: unknown;
}

interface UpdateVoiceQueueBody extends CreateVoiceQueueBody {
  isActive?: unknown;
}

interface SetDirectVoiceDestinationBody {
  queueId?: unknown;
  isActive?: unknown;
}

function requiredName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 120) {
    throw new BadRequestException('name must contain 1-120 characters');
  }
  return value.trim();
}

function optionalInteger(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum) {
    throw new BadRequestException(
      `${field} must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

function optionalNullableInteger(
  value: unknown,
  field: string,
  minimum: number,
): number | null | undefined {
  if (value === null) return null;
  return optionalInteger(value, field, minimum);
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} must be a boolean`);
  return value;
}

function requiredIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function requiredDestination(value: string): string {
  const destination = value.trim();
  if (destination.length === 0 || destination.length > 128) {
    throw new BadRequestException('destination must contain 1-128 characters');
  }
  return destination;
}

function identity(request: AuthenticatedGatewayRequest) {
  if (!request.gatewayIdentity) throw new UnauthorizedException();
  return request.gatewayIdentity;
}

@Controller('api/v1/queues')
export class QueueController {
  constructor(@Inject(TENANT_QUEUE_DATABASE) private readonly database: PrismaClient) {}

  @Get()
  @GatewayRoles('agent', 'supervisor', 'admin')
  list(@Req() request: AuthenticatedGatewayRequest) {
    return listTenantQueues(this.database, identity(request).tenantId);
  }

  @Post()
  @GatewayRoles('admin')
  create(@Req() request: AuthenticatedGatewayRequest, @Body() body: CreateVoiceQueueBody) {
    const actor = identity(request);
    return createVoiceQueue(this.database, {
      tenantId: actor.tenantId,
      actorUserId: actor.userId,
      name: requiredName(body.name),
      slaThresholdSec: optionalInteger(body.slaThresholdSec, 'slaThresholdSec', 1),
      maxWaitSec: optionalNullableInteger(body.maxWaitSec, 'maxWaitSec', 1),
      priority: optionalInteger(body.priority, 'priority', 0),
    });
  }

  @Patch(':queueId')
  @GatewayRoles('admin')
  async update(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('queueId') queueId: string,
    @Body() body: UpdateVoiceQueueBody,
  ) {
    const actor = identity(request);
    if (Object.keys(body).length === 0) throw new BadRequestException('update body is required');
    try {
      return await updateVoiceQueue(this.database, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        queueId: requiredIdentifier(queueId, 'queueId'),
        name: body.name === undefined ? undefined : requiredName(body.name),
        slaThresholdSec: optionalInteger(body.slaThresholdSec, 'slaThresholdSec', 1),
        maxWaitSec: optionalNullableInteger(body.maxWaitSec, 'maxWaitSec', 1),
        priority: optionalInteger(body.priority, 'priority', 0),
        isActive: optionalBoolean(body.isActive, 'isActive'),
      });
    } catch (error) {
      if (error instanceof TenantQueueNotFoundError) throw new NotFoundException();
      throw error;
    }
  }
}

@Controller('api/v1/voice-destinations')
export class VoiceDestinationController {
  constructor(@Inject(TENANT_QUEUE_DATABASE) private readonly database: PrismaClient) {}

  @Get()
  @GatewayRoles('admin')
  list(@Req() request: AuthenticatedGatewayRequest) {
    return listDirectVoiceDestinations(this.database, identity(request).tenantId);
  }

  @Put(':destination')
  @GatewayRoles('admin')
  async set(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('destination') destination: string,
    @Body() body: SetDirectVoiceDestinationBody,
  ) {
    const actor = identity(request);
    try {
      return await setDirectVoiceDestination(this.database, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        destination: requiredDestination(destination),
        queueId: requiredIdentifier(body.queueId, 'queueId'),
        isActive: optionalBoolean(body.isActive, 'isActive'),
      });
    } catch (error) {
      if (error instanceof TenantQueueNotFoundError) throw new NotFoundException();
      throw error;
    }
  }
}

@Controller('api/v1/queue-audit-events')
export class QueueAuditController {
  constructor(@Inject(TENANT_QUEUE_DATABASE) private readonly database: PrismaClient) {}

  @Get()
  @GatewayRoles('admin')
  list(@Req() request: AuthenticatedGatewayRequest) {
    return listQueueAuditEvents(this.database, identity(request).tenantId);
  }
}
