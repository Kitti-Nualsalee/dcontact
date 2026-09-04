import {
  withTenantDatabaseTransaction,
  Prisma,
  type PrismaClient,
  type QueueAuditAction,
} from '@d-contact/db';
import type { DirectVoiceQueueAdmissionDecision } from '@d-contact/shared';

export interface CreateVoiceQueueCommand {
  tenantId: string;
  actorUserId: string;
  name: string;
  slaThresholdSec?: number;
  maxWaitSec?: number | null;
  offerTimeoutSec?: number;
  offerTimeoutAction?: 'IMMEDIATE_REQUEUE' | 'COOLDOWN_REQUEUE' | 'ABANDON';
  offerCooldownSec?: number;
  maxWaitAction?: 'WAIT' | 'CALLBACK' | 'VOICEMAIL';
  routingStrategy?: 'LONGEST_AVAILABLE_IDLE' | 'LONGEST_SINCE_LAST_INTERACTION' | 'ROUND_ROBIN';
  priority?: number;
}

export interface UpdateVoiceQueueCommand {
  tenantId: string;
  actorUserId: string;
  queueId: string;
  name?: string;
  slaThresholdSec?: number;
  maxWaitSec?: number | null;
  offerTimeoutSec?: number;
  offerTimeoutAction?: 'IMMEDIATE_REQUEUE' | 'COOLDOWN_REQUEUE' | 'ABANDON';
  offerCooldownSec?: number;
  maxWaitAction?: 'WAIT' | 'CALLBACK' | 'VOICEMAIL';
  routingStrategy?: 'LONGEST_AVAILABLE_IDLE' | 'LONGEST_SINCE_LAST_INTERACTION' | 'ROUND_ROBIN';
  priority?: number;
  isActive?: boolean;
}

export interface SetDirectVoiceDestinationCommand {
  tenantId: string;
  actorUserId: string;
  destination: string;
  queueId: string;
  isActive?: boolean;
}

export interface IvrConfiguration {
  prompt: string;
  inputTimeoutSec: number;
  voiceRoutes: Record<string, string>;
  dtmfRoutes: Record<string, string>;
}

export interface SetIvrVoiceDestinationCommand {
  tenantId: string;
  actorUserId: string;
  destination: string;
  defaultQueueId: string;
  configuration: IvrConfiguration;
  isActive?: boolean;
}

export interface QueueRequiredSkill {
  skillId: string;
  minLevel: number;
}

export interface SetQueueRequiredSkillsCommand {
  tenantId: string;
  actorUserId: string;
  queueId: string;
  requiredSkills: QueueRequiredSkill[];
}

export interface UpdateTenantQueuePolicyCommand {
  tenantId: string;
  defaultOfferTimeoutSec?: number;
  defaultOfferTimeoutAction?: 'IMMEDIATE_REQUEUE' | 'COOLDOWN_REQUEUE' | 'ABANDON';
  defaultOfferCooldownSec?: number;
  defaultMaxWaitSec?: number | null;
  defaultMaxWaitAction?: 'WAIT' | 'CALLBACK' | 'VOICEMAIL';
}

export class TenantQueueNotFoundError extends Error {
  constructor() {
    super('voice queue was not found in the tenant');
    this.name = 'TenantQueueNotFoundError';
  }
}

export class TenantSkillNotFoundError extends Error {
  constructor() {
    super('one or more skills were not found in the tenant');
    this.name = 'TenantSkillNotFoundError';
  }
}

export class InvalidQueueRequiredSkillsError extends Error {
  constructor() {
    super('required skills must use unique IDs and levels 1-5');
    this.name = 'InvalidQueueRequiredSkillsError';
  }
}

export class TenantQueuePolicyNotFoundError extends Error {
  constructor() {
    super('tenant queue policy was not found');
    this.name = 'TenantQueuePolicyNotFoundError';
  }
}

const queueMetadataSelection = {
  id: true,
  name: true,
  channels: true,
  slaThresholdSec: true,
  maxWaitSec: true,
  offerTimeoutSec: true,
  offerTimeoutAction: true,
  offerCooldownSec: true,
  maxWaitAction: true,
  routingStrategy: true,
  priority: true,
  isActive: true,
} as const;

const directVoiceDestinationSelection = {
  id: true,
  destination: true,
  entryMode: true,
  queueId: true,
  ivrConfig: true,
  isActive: true,
} as const;

const queueAuditSelection = {
  id: true,
  queueId: true,
  actorUserId: true,
  action: true,
  details: true,
  createdAt: true,
} as const;

const queueRequiredSkillSelection = {
  skillId: true,
  minLevel: true,
} as const;

const tenantQueuePolicySelection = {
  defaultOfferTimeoutSec: true,
  defaultOfferTimeoutAction: true,
  defaultOfferCooldownSec: true,
  defaultMaxWaitSec: true,
  defaultMaxWaitAction: true,
} as const;

interface AppendQueueAuditEventCommand {
  tenantId: string;
  queueId: string;
  actorUserId: string;
  action: QueueAuditAction;
  details: Prisma.InputJsonValue;
}

function appendQueueAuditEvent(
  transaction: Prisma.TransactionClient,
  command: AppendQueueAuditEventCommand,
) {
  return transaction.queueAuditEvent.create({ data: command });
}

/**
 * Tenant-scoped read model for the API boundary. The explicit where clause is
 * the service-level guard; the transaction helper also installs SET LOCAL
 * app.tenant_id so PostgreSQL RLS remains the final defense-in-depth boundary.
 */
export function listTenantQueues(database: PrismaClient, tenantId: string) {
  return withTenantDatabaseTransaction(database, tenantId, (transaction) =>
    transaction.queue.findMany({
      where: { tenantId },
      select: queueMetadataSelection,
      orderBy: { name: 'asc' },
    }),
  );
}

export function getTenantQueuePolicy(database: PrismaClient, tenantId: string) {
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const policy = await transaction.tenant.findUnique({
      where: { id: tenantId },
      select: tenantQueuePolicySelection,
    });
    if (!policy) throw new TenantQueuePolicyNotFoundError();
    return policy;
  });
}

export function updateTenantQueuePolicy(
  database: PrismaClient,
  command: UpdateTenantQueuePolicyCommand,
) {
  return withTenantDatabaseTransaction(database, command.tenantId, async (transaction) => {
    const result = await transaction.tenant.updateMany({
      where: { id: command.tenantId },
      data: {
        defaultOfferTimeoutSec: command.defaultOfferTimeoutSec,
        defaultOfferTimeoutAction: command.defaultOfferTimeoutAction,
        defaultOfferCooldownSec: command.defaultOfferCooldownSec,
        defaultMaxWaitSec: command.defaultMaxWaitSec,
        defaultMaxWaitAction: command.defaultMaxWaitAction,
      },
    });
    if (result.count !== 1) throw new TenantQueuePolicyNotFoundError();
    return transaction.tenant.findUniqueOrThrow({
      where: { id: command.tenantId },
      select: tenantQueuePolicySelection,
    });
  });
}

export function createVoiceQueue(database: PrismaClient, command: CreateVoiceQueueCommand) {
  return withTenantDatabaseTransaction(database, command.tenantId, async (transaction) => {
    const queue = await transaction.queue.create({
      data: {
        tenantId: command.tenantId,
        name: command.name,
        channels: ['VOICE'],
        slaThresholdSec: command.slaThresholdSec,
        maxWaitSec: command.maxWaitSec,
        offerTimeoutSec: command.offerTimeoutSec,
        offerTimeoutAction: command.offerTimeoutAction,
        offerCooldownSec: command.offerCooldownSec,
        maxWaitAction: command.maxWaitAction,
        routingStrategy: command.routingStrategy,
        priority: command.priority,
      },
      select: queueMetadataSelection,
    });
    await appendQueueAuditEvent(transaction, {
      tenantId: command.tenantId,
      queueId: queue.id,
      actorUserId: command.actorUserId,
      action: 'QUEUE_CREATED',
      details: { after: queue },
    });
    return queue;
  });
}

export function updateVoiceQueue(database: PrismaClient, command: UpdateVoiceQueueCommand) {
  return withTenantDatabaseTransaction(database, command.tenantId, async (transaction) => {
    const before = await transaction.queue.findFirst({
      where: { id: command.queueId, tenantId: command.tenantId, channels: { has: 'VOICE' } },
      select: queueMetadataSelection,
    });
    if (!before) throw new TenantQueueNotFoundError();

    const result = await transaction.queue.updateMany({
      where: { id: command.queueId, tenantId: command.tenantId, channels: { has: 'VOICE' } },
      data: {
        name: command.name,
        slaThresholdSec: command.slaThresholdSec,
        maxWaitSec: command.maxWaitSec,
        offerTimeoutSec: command.offerTimeoutSec,
        offerTimeoutAction: command.offerTimeoutAction,
        offerCooldownSec: command.offerCooldownSec,
        maxWaitAction: command.maxWaitAction,
        routingStrategy: command.routingStrategy,
        priority: command.priority,
        isActive: command.isActive,
      },
    });
    if (result.count !== 1) throw new TenantQueueNotFoundError();

    const queue = await transaction.queue.findFirstOrThrow({
      where: { id: command.queueId, tenantId: command.tenantId },
      select: queueMetadataSelection,
    });
    const action: QueueAuditAction =
      before.isActive !== queue.isActive
        ? queue.isActive
          ? 'QUEUE_ENABLED'
          : 'QUEUE_DISABLED'
        : 'QUEUE_UPDATED';
    await appendQueueAuditEvent(transaction, {
      tenantId: command.tenantId,
      queueId: queue.id,
      actorUserId: command.actorUserId,
      action,
      details: { before, after: queue },
    });
    return queue;
  });
}

export function listQueueRequiredSkills(database: PrismaClient, tenantId: string, queueId: string) {
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const queue = await transaction.queue.findFirst({
      where: { id: queueId, tenantId, channels: { has: 'VOICE' } },
      select: { id: true },
    });
    if (!queue) throw new TenantQueueNotFoundError();
    return transaction.queueSkill.findMany({
      where: { queueId: queue.id },
      select: queueRequiredSkillSelection,
      orderBy: { skillId: 'asc' },
    });
  });
}

export function setQueueRequiredSkills(
  database: PrismaClient,
  command: SetQueueRequiredSkillsCommand,
) {
  return withTenantDatabaseTransaction(database, command.tenantId, async (transaction) => {
    if (
      new Set(command.requiredSkills.map((skill) => skill.skillId)).size !==
        command.requiredSkills.length ||
      command.requiredSkills.some(
        (skill) => !Number.isInteger(skill.minLevel) || skill.minLevel < 1 || skill.minLevel > 5,
      )
    ) {
      throw new InvalidQueueRequiredSkillsError();
    }
    const queue = await transaction.queue.findFirst({
      where: {
        id: command.queueId,
        tenantId: command.tenantId,
        channels: { has: 'VOICE' },
      },
      select: { id: true },
    });
    if (!queue) throw new TenantQueueNotFoundError();

    const skillIds = command.requiredSkills.map((skill) => skill.skillId);
    const skills = await transaction.skill.findMany({
      where: { tenantId: command.tenantId, id: { in: skillIds } },
      select: { id: true },
    });
    if (skills.length !== skillIds.length) throw new TenantSkillNotFoundError();

    await transaction.queueSkill.deleteMany({ where: { queueId: queue.id } });
    if (command.requiredSkills.length > 0) {
      await transaction.queueSkill.createMany({
        data: command.requiredSkills.map((skill) => ({
          queueId: queue.id,
          skillId: skill.skillId,
          minLevel: skill.minLevel,
        })),
      });
    }
    const requiredSkills = await transaction.queueSkill.findMany({
      where: { queueId: queue.id },
      select: queueRequiredSkillSelection,
      orderBy: { skillId: 'asc' },
    });
    await appendQueueAuditEvent(transaction, {
      tenantId: command.tenantId,
      queueId: queue.id,
      actorUserId: command.actorUserId,
      action: 'QUEUE_UPDATED',
      details: { requiredSkills },
    });
    return requiredSkills;
  });
}

export function listDirectVoiceDestinations(database: PrismaClient, tenantId: string) {
  return withTenantDatabaseTransaction(database, tenantId, (transaction) =>
    transaction.voiceDestination.findMany({
      where: { tenantId },
      select: directVoiceDestinationSelection,
      orderBy: { destination: 'asc' },
    }),
  );
}

export function listQueueAuditEvents(database: PrismaClient, tenantId: string) {
  return withTenantDatabaseTransaction(database, tenantId, (transaction) =>
    transaction.queueAuditEvent.findMany({
      where: { tenantId },
      select: queueAuditSelection,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  );
}

export function resolveDirectVoiceDestination(
  database: PrismaClient,
  tenantId: string,
  destination: string,
): Promise<DirectVoiceQueueAdmissionDecision> {
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const configured = await transaction.voiceDestination.findFirst({
      where: { tenantId, destination, entryMode: 'DIRECT_QUEUE' },
      select: {
        id: true,
        queueId: true,
        isActive: true,
        queue: { select: { isActive: true } },
      },
    });
    if (!configured) return { status: 'REJECTED', reason: 'DESTINATION_NOT_FOUND' };
    if (!configured.isActive) return { status: 'REJECTED', reason: 'DESTINATION_DISABLED' };
    if (!configured.queue.isActive) return { status: 'REJECTED', reason: 'QUEUE_DISABLED' };

    return {
      status: 'ACCEPTED',
      entryMode: 'DIRECT_QUEUE',
      destinationId: configured.id,
      queueId: configured.queueId,
    };
  });
}

export function setDirectVoiceDestination(
  database: PrismaClient,
  command: SetDirectVoiceDestinationCommand,
) {
  return withTenantDatabaseTransaction(database, command.tenantId, async (transaction) => {
    const queue = await transaction.queue.findFirst({
      where: {
        id: command.queueId,
        tenantId: command.tenantId,
        channels: { has: 'VOICE' },
        isActive: true,
      },
      select: { id: true },
    });
    if (!queue) throw new TenantQueueNotFoundError();

    const configured = await transaction.voiceDestination.upsert({
      where: {
        tenantId_destination: {
          tenantId: command.tenantId,
          destination: command.destination,
        },
      },
      update: {
        queueId: queue.id,
        entryMode: 'DIRECT_QUEUE',
        ivrConfig: Prisma.JsonNull,
        isActive: command.isActive,
      },
      create: {
        tenantId: command.tenantId,
        destination: command.destination,
        entryMode: 'DIRECT_QUEUE',
        queueId: queue.id,
        ivrConfig: Prisma.JsonNull,
        isActive: command.isActive,
      },
      select: directVoiceDestinationSelection,
    });
    await appendQueueAuditEvent(transaction, {
      tenantId: command.tenantId,
      queueId: queue.id,
      actorUserId: command.actorUserId,
      action: 'DIRECT_DESTINATION_SET',
      details: { destination: configured },
    });
    return configured;
  });
}

export function setIvrVoiceDestination(
  database: PrismaClient,
  command: SetIvrVoiceDestinationCommand,
) {
  return withTenantDatabaseTransaction(database, command.tenantId, async (transaction) => {
    const routedQueueIds = [
      command.defaultQueueId,
      ...Object.values(command.configuration.voiceRoutes),
      ...Object.values(command.configuration.dtmfRoutes),
    ];
    const queues = await transaction.queue.findMany({
      where: {
        tenantId: command.tenantId,
        id: { in: routedQueueIds },
        channels: { has: 'VOICE' },
        isActive: true,
      },
      select: { id: true },
    });
    if (queues.length !== new Set(routedQueueIds).size) throw new TenantQueueNotFoundError();

    const configured = await transaction.voiceDestination.upsert({
      where: {
        tenantId_destination: {
          tenantId: command.tenantId,
          destination: command.destination,
        },
      },
      update: {
        entryMode: 'IVR',
        queueId: command.defaultQueueId,
        ivrConfig: command.configuration as unknown as Prisma.InputJsonValue,
        isActive: command.isActive,
      },
      create: {
        tenantId: command.tenantId,
        destination: command.destination,
        entryMode: 'IVR',
        queueId: command.defaultQueueId,
        ivrConfig: command.configuration as unknown as Prisma.InputJsonValue,
        isActive: command.isActive,
      },
      select: directVoiceDestinationSelection,
    });
    await appendQueueAuditEvent(transaction, {
      tenantId: command.tenantId,
      queueId: command.defaultQueueId,
      actorUserId: command.actorUserId,
      action: 'DIRECT_DESTINATION_SET',
      details: { destination: configured },
    });
    return configured;
  });
}
