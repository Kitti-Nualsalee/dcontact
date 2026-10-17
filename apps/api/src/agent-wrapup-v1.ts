import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  HttpException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { findActiveAgent } from './active-agent.js';

type Actor = { tenantId: string; userId: string };
const action = 'AGENT_WRAPUP_V1_SUBMIT';

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', field });
  }
  return value.toLowerCase();
}

function inputFrom(body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((key) => !['disposition', 'note', 'commandId'].includes(key))) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED' });
  }
  if (input.disposition !== 'CUSTOMER_ASSISTED' && input.disposition !== 'FOLLOW_UP_REQUIRED') {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'disposition' });
  }
  if (
    typeof input.note !== 'string' ||
    /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
      input.note,
    )
  ) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'note' });
  }
  const note = input.note.replace(/\r\n/g, '\n').trim();
  if ([...note].length < 1 || [...note].length > 2000) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', field: 'note' });
  }
  return { disposition: input.disposition, note, commandId: uuid(input.commandId, 'commandId') };
}

async function authorize(
  transaction: Prisma.TransactionClient,
  actor: Actor,
  interactionId: string,
) {
  const agent = await findActiveAgent(transaction, actor);
  if (!agent) throw new ForbiddenException({ code: 'AGENT_REQUIRED' });
  const interaction = await transaction.interaction.findFirst({
    where: { id: interactionId, tenantId: actor.tenantId, agentId: actor.userId, channel: 'VOICE' },
    select: {
      id: true,
      state: true,
      voiceWrapupPolicy: true,
      wrapUpCode: true,
      endedAt: true,
      queuedAt: true,
    },
  });
  if (!interaction) throw new NotFoundException({ code: 'INTERACTION_NOT_FOUND' });
  return interaction;
}

async function committedResult(
  transaction: Prisma.TransactionClient,
  actor: Actor,
  interactionId: string,
) {
  const result = await transaction.interactionWrapupResult.findFirst({
    where: { tenantId: actor.tenantId, ownerAgentId: actor.userId, interactionId },
  });
  if (!result) throw new ConflictException({ code: 'RESULT_NOT_COMMITTED' });
  return {
    interactionId: result.interactionId,
    policyVersion: result.policyVersion,
    state: 'COMPLETED' as const,
    disposition: result.disposition,
    note: result.note,
    recordedAt: result.recordedAt.toISOString(),
    recordedAtSource: 'SERVER_COMMIT' as const,
    legacy: false as const,
  };
}

export async function saveAgentWrapup(
  database: PrismaClient,
  actor: Actor,
  resourceId: string,
  body: unknown,
) {
  const interactionId = uuid(resourceId, 'interactionId');
  const input = inputFrom(body);
  const payloadDigest = createHash('sha256')
    .update(
      JSON.stringify([
        1,
        actor.tenantId.toLowerCase(),
        actor.userId.toLowerCase(),
        interactionId,
        input.disposition,
        input.note,
      ]),
      'utf8',
    )
    .digest('hex');
  return withTenantDatabaseTransaction(database, actor.tenantId, async (transaction) => {
    await transaction.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${actor.tenantId}:${input.commandId}`}, 0))`,
    );
    await transaction.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${actor.userId}::uuid FOR NO KEY UPDATE`,
    );
    await transaction.$queryRaw(
      Prisma.sql`SELECT id FROM interactions WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${interactionId}::uuid AND agent_id = ${actor.userId}::uuid FOR UPDATE`,
    );
    const interaction = await authorize(transaction, actor, interactionId);
    const receipt = await transaction.commandReceipt.findUnique({
      where: { tenantId_commandId: { tenantId: actor.tenantId, commandId: input.commandId } },
    });
    if (receipt) {
      if (
        receipt.actorUserId !== actor.userId ||
        receipt.action !== action ||
        receipt.resourceId !== interactionId
      ) {
        throw new ConflictException({ code: 'COMMAND_ID_REUSED' });
      }
      if (receipt.payloadDigest !== payloadDigest)
        throw new ConflictException({ code: 'COMMAND_PAYLOAD_MISMATCH' });
      return committedResult(transaction, actor, interactionId);
    }
    if (interaction.voiceWrapupPolicy !== 'VOICE_NOTE_V1')
      throw new ConflictException({ code: 'WRAPUP_POLICY_MISMATCH' });
    if (interaction.state === 'COMPLETED')
      throw new ConflictException({ code: 'INTERACTION_ALREADY_COMPLETED' });
    if (interaction.state !== 'WRAPUP')
      throw new ConflictException({ code: 'INTERACTION_NOT_IN_WRAPUP' });
    await transaction.interactionWrapupResult.create({
      data: {
        tenantId: actor.tenantId,
        ownerAgentId: actor.userId,
        interactionId,
        policyVersion: 1,
        disposition: input.disposition,
        note: input.note,
        commandId: input.commandId,
      },
    });
    await transaction.interaction.update({
      where: { id: interactionId },
      data: { state: 'COMPLETED', wrapUpCode: input.disposition },
    });
    await transaction.interactionEvent.create({
      data: {
        tenantId: actor.tenantId,
        interactionId,
        type: 'interaction.wrapup_completed',
        payload: { disposition: input.disposition, commandId: input.commandId },
      },
    });
    await transaction.agentStateLog.create({
      data: {
        tenantId: actor.tenantId,
        userId: actor.userId,
        state: 'AVAILABLE',
        reason: 'wrapup_completed',
      },
    });
    const result = await committedResult(transaction, actor, interactionId);
    const {
      note: omittedNote,
      legacy: omittedLegacy,
      recordedAtSource: omittedSource,
      ...summary
    } = result;
    await transaction.commandReceipt.create({
      data: {
        tenantId: actor.tenantId,
        actorUserId: actor.userId,
        commandId: input.commandId,
        resourceId: interactionId,
        action,
        payloadDigest,
        result: summary,
      },
    });
    await transaction.$executeRaw`SET CONSTRAINTS interactions_wrapup_result_guard, wrapup_result_interaction_guard IMMEDIATE`;
    return result;
  }).catch((error: unknown) => {
    if (error instanceof HttpException) throw error;
    throw new InternalServerErrorException({ code: 'WRAPUP_SAVE_FAILED' });
  });
}

export async function readAgentWrapup(database: PrismaClient, actor: Actor, resourceId: string) {
  const interactionId = uuid(resourceId, 'interactionId');
  return withTenantDatabaseTransaction(database, actor.tenantId, async (transaction) => {
    const interaction = await authorize(transaction, actor, interactionId);
    if (interaction.state !== 'COMPLETED')
      throw new ConflictException({ code: 'RESULT_NOT_COMMITTED' });
    if (interaction.voiceWrapupPolicy === 'VOICE_NOTE_V1')
      return committedResult(transaction, actor, interactionId);
    const completion = await transaction.interactionEvent.findFirst({
      where: { tenantId: actor.tenantId, interactionId, type: 'interaction.wrapup_completed' },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: { createdAt: true },
    });
    return {
      interactionId,
      policyVersion: null,
      state: 'COMPLETED',
      disposition: interaction.wrapUpCode,
      note: null,
      recordedAt: (
        completion?.createdAt ??
        interaction.endedAt ??
        interaction.queuedAt
      ).toISOString(),
      recordedAtSource: completion ? 'LEGACY_EVENT' : 'LEGACY_FALLBACK',
      legacy: true,
    };
  });
}

export async function readAgentWrapupCommand(
  database: PrismaClient,
  actor: Actor,
  resourceId: string,
  commandValue: string,
) {
  const interactionId = uuid(resourceId, 'interactionId');
  const commandId = uuid(commandValue, 'commandId');
  return withTenantDatabaseTransaction(database, actor.tenantId, async (transaction) => {
    await authorize(transaction, actor, interactionId);
    const receipt = await transaction.commandReceipt.findUnique({
      where: { tenantId_commandId: { tenantId: actor.tenantId, commandId } },
    });
    if (!receipt) throw new NotFoundException({ code: 'COMMAND_NOT_FOUND' });
    if (
      receipt.actorUserId !== actor.userId ||
      receipt.action !== action ||
      receipt.resourceId !== interactionId
    ) {
      throw new ConflictException({ code: 'COMMAND_ID_REUSED' });
    }
    return { status: 'COMMITTED', result: receipt.result };
  });
}
