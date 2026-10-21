import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient } from '@d-contact/db';
import { coreTeamNameError } from '@d-contact/shared';
import {
  coreActor,
  coreTransaction,
  coreUuid,
  executeCoreCommand,
  prepareCoreCommand,
  type CoreIdentity,
} from './tenant-core-command.js';
import { coreFail } from './tenant-core-errors.js';

type TeamSnapshot = { id: string; name: string; isActive: boolean; revision: string };
async function snapshot(tx: Prisma.TransactionClient, tenantId: string, id: string) {
  const [row] = await tx.$queryRaw<
    { value: TeamSnapshot | null }[]
  >`SELECT public.dc_core_team_snapshot(${tenantId}::uuid,${id}::uuid) AS value`;
  if (!row?.value) coreFail('RESOURCE_NOT_FOUND', 404);
  return row.value;
}
export function readCoreTeam(db: PrismaClient, identity: CoreIdentity, id: unknown) {
  const teamId = coreUuid(id);
  return coreTransaction(db, identity.tenantId, async (tx) => {
    const actor = await coreActor(tx, identity, false);
    if (actor.role === 'SUPERVISOR' && actor.teamId !== teamId) coreFail('RESOURCE_NOT_FOUND', 404);
    return { team: await snapshot(tx, identity.tenantId, teamId) };
  });
}
export async function createCoreTeam(db: PrismaClient, identity: CoreIdentity, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) coreFail('INVALID_REQUEST', 400);
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some((k) => !['commandId', 'teamId', 'name'].includes(k)) ||
    typeof input.name !== 'string'
  )
    coreFail('INVALID_REQUEST', 400);
  const name = input.name.trim();
  const command = prepareCoreCommand({
    commandId: input.commandId,
    action: 'TEAM_CREATE',
    resourceType: 'TEAM',
    resourceId: coreUuid(input.teamId),
    expectedRevision: null,
    payload: { teamId: coreUuid(input.teamId), name },
  });
  return executeCoreCommand(db, identity, command, async (tx) => {
    if (coreTeamNameError(name))
      coreFail('VALIDATION_FAILED', 422, { fieldErrors: { name: 'core.validation.teamName' } });
    await tx.$executeRawUnsafe('SAVEPOINT core_team_create');
    try {
      await tx.team.create({
        data: { id: command.resourceId, tenantId: identity.tenantId, name, isActive: true },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Prisma อาจไม่ส่ง target เมื่อมี trigger; อ่าน unique ที่อยู่ใน tenant หลัง rollback statement
        await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT core_team_create');
        const duplicate = await tx.team.findFirst({
          where: { tenantId: identity.tenantId, name },
          select: { id: true },
        });
        coreFail(duplicate ? 'TEAM_NAME_CONFLICT' : 'RESOURCE_ID_CONFLICT', 409);
      }
      throw error;
    }
    const value = await snapshot(tx, identity.tenantId, command.resourceId);
    return {
      outcome: 'APPLIED',
      revision: 1n,
      beforeRevision: null,
      before: null,
      snapshot: value,
    };
  });
}

export async function renameCoreTeam(
  db: PrismaClient,
  identity: CoreIdentity,
  id: unknown,
  body: unknown,
) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) coreFail('INVALID_REQUEST', 400);
  const input = body as Record<string, unknown>;
  if (
    Object.keys(input).some((k) => !['commandId', 'expectedRevision', 'patch'].includes(k)) ||
    !input.patch ||
    typeof input.patch !== 'object' ||
    Array.isArray(input.patch)
  )
    coreFail('INVALID_REQUEST', 400);
  const patch = input.patch as Record<string, unknown>;
  if (Object.keys(patch).length !== 1 || typeof patch.name !== 'string')
    coreFail('INVALID_REQUEST', 400);
  const name = patch.name.trim();
  const command = prepareCoreCommand({
    commandId: input.commandId,
    action: 'TEAM_RENAME',
    resourceType: 'TEAM',
    resourceId: coreUuid(id),
    expectedRevision: input.expectedRevision,
    payload: { name },
  });
  return executeCoreCommand(db, identity, command, async (tx) => {
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM teams WHERE tenant_id=${identity.tenantId}::uuid AND id=${command.resourceId}::uuid FOR UPDATE NOWAIT`;
    if (!locked.length) coreFail('RESOURCE_NOT_FOUND', 404);
    const before = await snapshot(tx, identity.tenantId, command.resourceId);
    if (before.revision !== command.expectedRevision)
      coreFail('REVISION_CONFLICT', 409, { currentRevision: before.revision });
    if (coreTeamNameError(name))
      coreFail('VALIDATION_FAILED', 422, { fieldErrors: { name: 'core.validation.teamName' } });
    if (name === before.name)
      return { outcome: 'NO_OP', revision: BigInt(before.revision), snapshot: before };
    try {
      await tx.team.update({ where: { id: command.resourceId }, data: { name } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        coreFail('TEAM_NAME_CONFLICT', 409);
      throw error;
    }
    const value = await snapshot(tx, identity.tenantId, command.resourceId);
    return {
      outcome: 'APPLIED',
      revision: BigInt(value.revision),
      beforeRevision: BigInt(before.revision),
      before,
      snapshot: value,
    };
  });
}

export function deactivateCoreTeam(
  db: PrismaClient,
  identity: CoreIdentity,
  id: unknown,
  body: unknown,
) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) coreFail('INVALID_REQUEST', 400);
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((k) => !['commandId', 'expectedRevision'].includes(k)))
    coreFail('INVALID_REQUEST', 400);
  const command = prepareCoreCommand({
    commandId: input.commandId,
    action: 'TEAM_DEACTIVATE',
    resourceType: 'TEAM',
    resourceId: coreUuid(id),
    expectedRevision: input.expectedRevision,
    payload: {},
  });
  return executeCoreCommand(db, identity, command, async (tx) => {
    // Reference fence มาก่อน Team row เพื่อไม่สวนลำดับ material writer เดิม
    await tx.$executeRaw`SELECT public.dc_team_reference_lock(${identity.tenantId}::uuid,ARRAY[${command.resourceId}::uuid],true)`;
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM teams WHERE tenant_id=${identity.tenantId}::uuid AND id=${command.resourceId}::uuid FOR UPDATE NOWAIT`;
    if (!locked.length) coreFail('RESOURCE_NOT_FOUND', 404);
    await coreActor(tx, identity);
    const before = await snapshot(tx, identity.tenantId, command.resourceId);
    if (before.revision !== command.expectedRevision)
      coreFail('REVISION_CONFLICT', 409, { currentRevision: before.revision });
    if (!before.isActive)
      return { outcome: 'NO_OP', revision: BigInt(before.revision), snapshot: before };
    const references = await tx.$queryRaw<
      { kind: string; count: bigint }[]
    >`SELECT kind,count FROM public.dc_team_reference_blockers(${identity.tenantId}::uuid,${command.resourceId}::uuid) ORDER BY kind`;
    const blockers = references.map((r) => ({ kind: r.kind, count: Number(r.count) }));
    if (blockers.length)
      coreFail(
        blockers.some((r) => r.kind === 'UNRESOLVED_CURRENT_REFERENCE')
          ? 'TEAM_REFERENCE_UNRESOLVED'
          : 'TEAM_REFERENCED',
        409,
        { blockers },
      );
    await tx.team.update({ where: { id: command.resourceId }, data: { isActive: false } });
    const value = await snapshot(tx, identity.tenantId, command.resourceId);
    return {
      outcome: 'APPLIED',
      revision: BigInt(value.revision),
      beforeRevision: BigInt(before.revision),
      before,
      snapshot: value,
    };
  });
}

// Cursor มีอายุเท่า process; หลัง restart/สลับ replica ให้เริ่มรายการใหม่ ไม่มี mutable server cursor state
const cursorKey = randomBytes(32);
function signCursor(payload: string) {
  return createHmac('sha256', cursorKey).update(payload).digest('base64url');
}
export function listCoreTeams(
  db: PrismaClient,
  identity: CoreIdentity,
  query: Record<string, unknown>,
) {
  if (
    Object.keys(query).some((k) => !['limit', 'cursor'].includes(k)) ||
    (query.limit !== undefined &&
      (typeof query.limit !== 'string' || !/^[1-9][0-9]?$|^100$/.test(query.limit))) ||
    (query.cursor !== undefined && typeof query.cursor !== 'string')
  )
    coreFail('INVALID_REQUEST', 400);
  const limit = Number(query.limit ?? 50);
  return coreTransaction(db, identity.tenantId, async (tx) => {
    const actor = await coreActor(tx, identity, false);
    const scope = JSON.stringify([
      identity.tenantId,
      actor.role,
      actor.role === 'SUPERVISOR' ? actor.teamId : null,
    ]);
    let after: string | undefined;
    if (query.cursor !== undefined) {
      const cursor = query.cursor as string;
      if (cursor.length > 2048) coreFail('INVALID_REQUEST', 400);
      const parts = cursor.split('.');
      if (
        parts.length !== 2 ||
        !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
        !/^[A-Za-z0-9_-]{43}$/.test(parts[1])
      )
        coreFail('INVALID_REQUEST', 400);
      const expected = Buffer.from(signCursor(parts[0]));
      const supplied = Buffer.from(parts[1]);
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
        coreFail('INVALID_REQUEST', 400);
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      } catch {
        coreFail('INVALID_REQUEST', 400);
      }
      if (!Array.isArray(decoded) || decoded.length !== 2 || decoded[0] !== scope)
        coreFail('INVALID_REQUEST', 400);
      after = coreUuid(decoded[1]);
    }
    const rows = await tx.team.findMany({
      where: {
        tenantId: identity.tenantId,
        id: {
          ...(after ? { gt: after } : {}),
          ...(actor.role === 'SUPERVISOR' ? { equals: actor.teamId! } : {}),
        },
        ...(actor.role === 'SUPERVISOR' ? { isActive: true } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      select: { id: true, name: true, isActive: true, revision: true },
    });
    const hasNext = rows.length > limit;
    const teams = rows
      .slice(0, limit)
      .map((row) => ({ ...row, revision: row.revision.toString() }));
    let nextCursor: string | null = null;
    if (hasNext) {
      const payload = Buffer.from(JSON.stringify([scope, teams[teams.length - 1].id])).toString(
        'base64url',
      );
      nextCursor = `${payload}.${signCursor(payload)}`;
    }
    return { teams, nextCursor };
  });
}
