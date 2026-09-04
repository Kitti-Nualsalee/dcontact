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
  getTenantQueuePolicy,
  InvalidQueueRequiredSkillsError,
  listDirectVoiceDestinations,
  listQueueAuditEvents,
  listQueueRequiredSkills,
  listTenantQueues,
  setDirectVoiceDestination,
  setIvrVoiceDestination,
  setQueueRequiredSkills,
  TenantSkillNotFoundError,
  TenantQueueNotFoundError,
  TenantQueuePolicyNotFoundError,
  updateTenantQueuePolicy,
  updateVoiceQueue,
} from './tenant-queue.js';

export const TENANT_QUEUE_DATABASE = Symbol('TENANT_QUEUE_DATABASE');

interface CreateVoiceQueueBody {
  name?: unknown;
  slaThresholdSec?: unknown;
  maxWaitSec?: unknown;
  offerTimeoutSec?: unknown;
  offerTimeoutAction?: unknown;
  offerCooldownSec?: unknown;
  maxWaitAction?: unknown;
  routingStrategy?: unknown;
  priority?: unknown;
}

interface UpdateVoiceQueueBody extends CreateVoiceQueueBody {
  isActive?: unknown;
}

interface SetDirectVoiceDestinationBody {
  queueId?: unknown;
  isActive?: unknown;
}

interface SetQueueRequiredSkillsBody {
  requiredSkills?: unknown;
}

interface SetIvrVoiceDestinationBody {
  defaultQueueId?: unknown;
  prompt?: unknown;
  inputTimeoutSec?: unknown;
  voiceRoutes?: unknown;
  dtmfRoutes?: unknown;
  isActive?: unknown;
}

interface UpdateTenantQueuePolicyBody {
  defaultOfferTimeoutSec?: unknown;
  defaultOfferTimeoutAction?: unknown;
  defaultOfferCooldownSec?: unknown;
  defaultMaxWaitSec?: unknown;
  defaultMaxWaitAction?: unknown;
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

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new BadRequestException(`${field} must be one of ${values.join(', ')}`);
  }
  return value as T;
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

function requiredSkills(value: unknown) {
  if (!Array.isArray(value)) throw new BadRequestException('requiredSkills must be an array');
  const parsed = value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new BadRequestException('requiredSkills entries must be objects');
    }
    const skill = item as { skillId?: unknown; minLevel?: unknown };
    return {
      skillId: requiredIdentifier(skill.skillId, 'requiredSkills.skillId'),
      minLevel: optionalInteger(skill.minLevel, 'requiredSkills.minLevel', 1),
    };
  });
  if (parsed.some((skill) => skill.minLevel === undefined || skill.minLevel > 5)) {
    throw new BadRequestException('requiredSkills.minLevel must be an integer from 1 to 5');
  }
  if (new Set(parsed.map((skill) => skill.skillId)).size !== parsed.length) {
    throw new BadRequestException('requiredSkills.skillId must be unique');
  }
  return parsed as { skillId: string; minLevel: number }[];
}

function requiredIvrRoutes(value: unknown, field: string, normalizeKey: (key: string) => string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException(`${field} must be an object`);
  }
  const routes: Record<string, string> = {};
  for (const [rawKey, rawQueueId] of Object.entries(value)) {
    const key = normalizeKey(rawKey);
    if (!key) throw new BadRequestException(`${field} contains an empty input`);
    if (routes[key]) throw new BadRequestException(`${field} contains duplicate input ${key}`);
    routes[key] = requiredIdentifier(rawQueueId, `${field}.${key}`);
  }
  return routes;
}

function ivrConfiguration(body: SetIvrVoiceDestinationBody) {
  if (
    typeof body.prompt !== 'string' ||
    body.prompt.trim().length === 0 ||
    body.prompt.length > 240
  ) {
    throw new BadRequestException('prompt must contain 1-240 characters');
  }
  const voiceRoutes = requiredIvrRoutes(body.voiceRoutes, 'voiceRoutes', (value) =>
    value.trim().toLocaleLowerCase('th-TH').replaceAll(/\s+/g, ' '),
  );
  const dtmfRoutes = requiredIvrRoutes(body.dtmfRoutes, 'dtmfRoutes', (value) => value.trim());
  if (Object.keys(voiceRoutes).length === 0 || Object.keys(dtmfRoutes).length === 0) {
    throw new BadRequestException(
      'voiceRoutes and dtmfRoutes must each contain at least one route',
    );
  }
  if (Object.keys(dtmfRoutes).some((value) => !/^[0-9*#]$/.test(value))) {
    throw new BadRequestException('dtmfRoutes keys must be one DTMF digit');
  }
  return {
    prompt: body.prompt.trim(),
    inputTimeoutSec: optionalInteger(body.inputTimeoutSec, 'inputTimeoutSec', 1) ?? 5,
    voiceRoutes,
    dtmfRoutes,
  };
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
      offerTimeoutSec: optionalInteger(body.offerTimeoutSec, 'offerTimeoutSec', 1),
      offerTimeoutAction: optionalEnum(body.offerTimeoutAction, 'offerTimeoutAction', [
        'IMMEDIATE_REQUEUE',
        'COOLDOWN_REQUEUE',
        'ABANDON',
      ]),
      offerCooldownSec: optionalInteger(body.offerCooldownSec, 'offerCooldownSec', 1),
      maxWaitAction: optionalEnum(body.maxWaitAction, 'maxWaitAction', [
        'WAIT',
        'CALLBACK',
        'VOICEMAIL',
      ]),
      routingStrategy: optionalEnum(body.routingStrategy, 'routingStrategy', [
        'LONGEST_AVAILABLE_IDLE',
        'LONGEST_SINCE_LAST_INTERACTION',
        'ROUND_ROBIN',
      ]),
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
        offerTimeoutSec: optionalInteger(body.offerTimeoutSec, 'offerTimeoutSec', 1),
        offerTimeoutAction: optionalEnum(body.offerTimeoutAction, 'offerTimeoutAction', [
          'IMMEDIATE_REQUEUE',
          'COOLDOWN_REQUEUE',
          'ABANDON',
        ]),
        offerCooldownSec: optionalInteger(body.offerCooldownSec, 'offerCooldownSec', 1),
        maxWaitAction: optionalEnum(body.maxWaitAction, 'maxWaitAction', [
          'WAIT',
          'CALLBACK',
          'VOICEMAIL',
        ]),
        routingStrategy: optionalEnum(body.routingStrategy, 'routingStrategy', [
          'LONGEST_AVAILABLE_IDLE',
          'LONGEST_SINCE_LAST_INTERACTION',
          'ROUND_ROBIN',
        ]),
        priority: optionalInteger(body.priority, 'priority', 0),
        isActive: optionalBoolean(body.isActive, 'isActive'),
      });
    } catch (error) {
      if (error instanceof TenantQueueNotFoundError) throw new NotFoundException();
      throw error;
    }
  }

  @Get(':queueId/required-skills')
  @GatewayRoles('admin')
  async listRequiredSkills(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('queueId') queueId: string,
  ) {
    try {
      return await listQueueRequiredSkills(
        this.database,
        identity(request).tenantId,
        requiredIdentifier(queueId, 'queueId'),
      );
    } catch (error) {
      if (error instanceof TenantQueueNotFoundError) throw new NotFoundException();
      throw error;
    }
  }

  @Put(':queueId/required-skills')
  @GatewayRoles('admin')
  async setRequiredSkills(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('queueId') queueId: string,
    @Body() body: SetQueueRequiredSkillsBody,
  ) {
    const actor = identity(request);
    try {
      return await setQueueRequiredSkills(this.database, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        queueId: requiredIdentifier(queueId, 'queueId'),
        requiredSkills: requiredSkills(body.requiredSkills),
      });
    } catch (error) {
      if (error instanceof TenantQueueNotFoundError || error instanceof TenantSkillNotFoundError) {
        throw new NotFoundException();
      }
      if (error instanceof InvalidQueueRequiredSkillsError)
        throw new BadRequestException(error.message);
      throw error;
    }
  }
}

@Controller('api/v1/tenant/queue-policy')
export class TenantQueuePolicyController {
  constructor(@Inject(TENANT_QUEUE_DATABASE) private readonly database: PrismaClient) {}

  @Get()
  @GatewayRoles('admin')
  async get(@Req() request: AuthenticatedGatewayRequest) {
    try {
      return await getTenantQueuePolicy(this.database, identity(request).tenantId);
    } catch (error) {
      if (error instanceof TenantQueuePolicyNotFoundError) throw new NotFoundException();
      throw error;
    }
  }

  @Patch()
  @GatewayRoles('admin')
  async update(
    @Req() request: AuthenticatedGatewayRequest,
    @Body() body: UpdateTenantQueuePolicyBody,
  ) {
    if (Object.keys(body).length === 0) throw new BadRequestException('update body is required');
    try {
      return await updateTenantQueuePolicy(this.database, {
        tenantId: identity(request).tenantId,
        defaultOfferTimeoutSec: optionalInteger(
          body.defaultOfferTimeoutSec,
          'defaultOfferTimeoutSec',
          1,
        ),
        defaultOfferTimeoutAction: optionalEnum(
          body.defaultOfferTimeoutAction,
          'defaultOfferTimeoutAction',
          ['IMMEDIATE_REQUEUE', 'COOLDOWN_REQUEUE', 'ABANDON'],
        ),
        defaultOfferCooldownSec: optionalInteger(
          body.defaultOfferCooldownSec,
          'defaultOfferCooldownSec',
          1,
        ),
        defaultMaxWaitSec: optionalNullableInteger(body.defaultMaxWaitSec, 'defaultMaxWaitSec', 1),
        defaultMaxWaitAction: optionalEnum(body.defaultMaxWaitAction, 'defaultMaxWaitAction', [
          'WAIT',
          'CALLBACK',
          'VOICEMAIL',
        ]),
      });
    } catch (error) {
      if (error instanceof TenantQueuePolicyNotFoundError) throw new NotFoundException();
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

  @Put(':destination/ivr')
  @GatewayRoles('admin')
  async setIvr(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('destination') destination: string,
    @Body() body: SetIvrVoiceDestinationBody,
  ) {
    const actor = identity(request);
    try {
      return await setIvrVoiceDestination(this.database, {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        destination: requiredDestination(destination),
        defaultQueueId: requiredIdentifier(body.defaultQueueId, 'defaultQueueId'),
        configuration: ivrConfiguration(body),
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
