import {
  withTenantDatabaseTransaction,
  type Prisma,
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
  priority?: number;
}

export interface UpdateVoiceQueueCommand {
  tenantId: string;
  actorUserId: string;
  queueId: string;
  name?: string;
  slaThresholdSec?: number;
  maxWaitSec?: number | null;
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

export class TenantQueueNotFoundError extends Error {
  constructor() {
    super('voice queue was not found in the tenant');
    this.name = 'TenantQueueNotFoundError';
  }
}

const queueMetadataSelection = {
  id: true,
  name: true,
  channels: true,
  slaThresholdSec: true,
  maxWaitSec: true,
  priority: true,
  isActive: true,
} as const;

const directVoiceDestinationSelection = {
  id: true,
  destination: true,
  entryMode: true,
  queueId: true,
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

export function createVoiceQueue(database: PrismaClient, command: CreateVoiceQueueCommand) {
  return withTenantDatabaseTransaction(database, command.tenantId, async (transaction) => {
    const queue = await transaction.queue.create({
      data: {
        tenantId: command.tenantId,
        name: command.name,
        channels: ['VOICE'],
        slaThresholdSec: command.slaThresholdSec,
        maxWaitSec: command.maxWaitSec,
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

export function listDirectVoiceDestinations(database: PrismaClient, tenantId: string) {
  return withTenantDatabaseTransaction(database, tenantId, (transaction) =>
    transaction.voiceDestination.findMany({
      where: { tenantId, entryMode: 'DIRECT_QUEUE' },
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
        isActive: command.isActive,
      },
      create: {
        tenantId: command.tenantId,
        destination: command.destination,
        entryMode: 'DIRECT_QUEUE',
        queueId: queue.id,
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
