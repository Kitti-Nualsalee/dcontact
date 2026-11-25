/**
 * #967 — a Supervisor opens and listens to recordings of calls their own team answered (`/api/v1/recordings`)
 *
 * the permission to listen comes from the team the Router recorded when the call was actually answered (`voice_interaction_handling_attributions`)
 * compared with the Supervisor's current team on every request; a call with no evidence cannot be opened for listening
 * audio leaves through the API only as short WAV ranges, with no presigned URL and never the whole file
 */
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
  StreamableFile,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { RECORDING_DATABASE, RECORDING_SUPERVISOR_PLAYBACK } from './recording-api.js';
import {
  RECORDING_CHUNK_SECONDS,
  WAV_HEADER_PROBE_BYTES,
  WavFormatError,
  frameByteRange,
  parseWavHeader,
  wavChunk,
  type WavFormat,
} from './recording-wav.js';

export const RECORDING_PLAYBACK_STORAGE = Symbol('RECORDING_PLAYBACK_STORAGE');

export const PLAYBACK_SESSION_TTL_MS = 5 * 60_000;
const HISTORY_DEFAULT_DAYS = 30;
const HISTORY_MAX_DAYS = 90;
const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 100;
const DAY_MS = 86_400_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RecordingPlaybackStorage {
  /** reads a byte range of a file under the tenant prefix; `objectBytes` is the size of the whole file */
  readRange(input: {
    tenantId: string;
    storageKey: string;
    start: number;
    endInclusive: number;
  }): Promise<{ bytes: Buffer; objectBytes: number }>;
}

interface Actor {
  tenantId: string;
  userId: string;
}

interface VisibleRecording {
  id: string;
  interactionId: string;
  storageKey: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSec: number | null;
  channelLayout: string;
  archivedAt: Date | null;
  queueName: string | null;
  agentName: string | null;
}

const logger = new Logger('RecordingPlayback');

const denied = () => new ForbiddenException({ code: 'PLAYBACK_ACCESS_DENIED' });
/** not found, another team's and another tenant's all answer the same */
const notFound = () => new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
const invalid = (field: string) => new BadRequestException({ code: 'INVALID_REQUEST', field });

function uuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw notFound();
  return value;
}

function timestamp(value: unknown, field: string, fallback: Date): Date {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' ? new Date(value) : new Date(Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw invalid(field);
  return parsed;
}

function encodeCursor(row: { startedAt: Date; id: string }): string {
  return Buffer.from(JSON.stringify([row.startedAt.toISOString(), row.id])).toString('base64url');
}

/** the cursor is only a position in the list; permission is rechecked on every request so it need not bind to the requester */
function decodeCursor(value: unknown): { startedAt: Date; id: string } | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (Array.isArray(parsed) && typeof parsed[0] === 'string' && UUID.test(String(parsed[1]))) {
      const startedAt = new Date(parsed[0]);
      if (!Number.isNaN(startedAt.getTime())) return { startedAt, id: String(parsed[1]) };
    }
  } catch {
    // falls through to answer 400 below
  }
  throw invalid('cursor');
}

function view(recording: VisibleRecording) {
  const status = recording.archivedAt ? ('READY' as const) : ('ARCHIVING' as const);
  return {
    recordingId: recording.id,
    interactionId: recording.interactionId,
    status,
    startedAt: recording.startedAt.toISOString(),
    endedAt: recording.endedAt?.toISOString() ?? null,
    durationSec: recording.durationSec,
    channelLayout: recording.channelLayout,
    queueName: recording.queueName,
    agentName: recording.agentName,
    capabilities: { play: status === 'READY' },
  };
}

@Controller('api/v1/recordings')
export class RecordingPlaybackController {
  constructor(
    @Inject(RECORDING_DATABASE) private readonly database: PrismaClient,
    @Inject(RECORDING_PLAYBACK_STORAGE) private readonly storage: RecordingPlaybackStorage,
    @Optional() @Inject(RECORDING_SUPERVISOR_PLAYBACK) private readonly enabled: boolean = false,
  ) {}

  @Get('history')
  @GatewayRoles('supervisor')
  @Header('Cache-Control', 'no-store')
  async history(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('from') from: unknown,
    @Query('to') to: unknown,
    @Query('limit') limit: unknown,
    @Query('cursor') cursor: unknown,
  ) {
    const actor = this.actor(request);
    const asOf = new Date();
    const until = timestamp(to, 'to', asOf);
    const since = timestamp(
      from,
      'from',
      new Date(until.getTime() - HISTORY_DEFAULT_DAYS * DAY_MS),
    );
    if (since >= until || until.getTime() - since.getTime() > HISTORY_MAX_DAYS * DAY_MS) {
      throw invalid('from');
    }
    const take = limit === undefined ? HISTORY_DEFAULT_LIMIT : Number(limit);
    if (!Number.isInteger(take) || take < 1 || take > HISTORY_MAX_LIMIT) throw invalid('limit');
    const after = decodeCursor(cursor);
    const rows = await withTenantDatabaseTransaction(this.database, actor.tenantId, async (tx) => {
      const teamId = await this.supervisorTeam(tx, actor);
      return this.visible(
        tx,
        actor.tenantId,
        teamId,
        // send the time as a timestamp without a zone so the result does not depend on the DB session's TimeZone
        Prisma.sql`AND r.started_at >= ${since.toISOString()}::timestamp(3)
          AND r.started_at < ${until.toISOString()}::timestamp(3)
          ${after ? Prisma.sql`AND (r.started_at, r.id) < (${after.startedAt.toISOString()}::timestamp(3), ${after.id}::uuid)` : Prisma.empty}
          ORDER BY r.started_at DESC, r.id DESC LIMIT ${take + 1}`,
      );
    });
    const items = rows.slice(0, take);
    return {
      asOf: asOf.toISOString(),
      items: items.map(view),
      nextCursor: rows.length > take ? encodeCursor(items.at(-1)!) : null,
    };
  }

  @Get(':recordingId')
  @GatewayRoles('supervisor')
  @Header('Cache-Control', 'no-store')
  async detail(@Req() request: AuthenticatedGatewayRequest, @Param('recordingId') id: string) {
    const actor = this.actor(request);
    const recordingId = uuid(id);
    const recording = await withTenantDatabaseTransaction(this.database, actor.tenantId, (tx) =>
      this.authorize(tx, actor, recordingId),
    );
    return { asOf: new Date().toISOString(), ...view(recording) };
  }

  @Post(':recordingId/playback-sessions')
  @GatewayRoles('supervisor')
  @Header('Cache-Control', 'no-store')
  async openSession(@Req() request: AuthenticatedGatewayRequest, @Param('recordingId') id: string) {
    const actor = this.actor(request);
    const recordingId = uuid(id);
    const recording = await withTenantDatabaseTransaction(this.database, actor.tenantId, (tx) =>
      this.authorizeReady(tx, actor, recordingId),
    );
    // read storage outside the transaction so no DB lock is held while waiting on the network
    const probe = await this.read(
      actor.tenantId,
      recording.storageKey,
      0,
      WAV_HEADER_PROBE_BYTES - 1,
    );
    let format: WavFormat;
    try {
      format = parseWavHeader(probe.bytes, probe.objectBytes);
    } catch (error) {
      if (!(error instanceof WavFormatError)) throw error;
      throw new UnprocessableEntityException({ code: 'RECORDING_FORMAT_UNSUPPORTED' });
    }
    const now = new Date();
    const expiresAt = new Date(now.getTime() + PLAYBACK_SESSION_TTL_MS);
    const session = await withTenantDatabaseTransaction(
      this.database,
      actor.tenantId,
      async (tx) => {
        // lock the user row: two concurrent requests of the same person must leave only one open session
        await tx.$queryRaw`SELECT id FROM users
          WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${actor.userId}::uuid FOR UPDATE`;
        await this.authorizeReady(tx, actor, recordingId);
        await tx.recordingPlaybackSession.updateMany({
          where: { tenantId: actor.tenantId, actorUserId: actor.userId, closedAt: null },
          data: { closedAt: now },
        });
        const created = await tx.recordingPlaybackSession.create({
          data: {
            tenantId: actor.tenantId,
            recordingId,
            actorUserId: actor.userId,
            dataOffset: format.dataOffset,
            sampleRate: format.sampleRate,
            channels: format.channels,
            totalFrames: format.totalFrames,
            expiresAt,
          },
          select: { id: true },
        });
        await tx.recordingAuditEvent.create({
          data: {
            tenantId: actor.tenantId,
            recordingId,
            actorUserId: actor.userId,
            action: 'PLAYBACK_ACCESSED',
            details: { transport: 'API_CHUNKS', sessionId: created.id },
          },
        });
        return created;
      },
    );
    return {
      sessionId: session.id,
      expiresAt: expiresAt.toISOString(),
      transport: 'API_CHUNKS' as const,
      format: {
        sampleRate: format.sampleRate,
        channels: format.channels,
        bitsPerSample: 16,
        totalFrames: format.totalFrames,
        maxChunkFrames: format.sampleRate * RECORDING_CHUNK_SECONDS,
      },
    };
  }

  @Post(':recordingId/playback-sessions/:sessionId/chunks')
  @HttpCode(200)
  @GatewayRoles('supervisor')
  @Header('Cache-Control', 'no-store')
  async chunk(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('recordingId') id: string,
    @Param('sessionId') sid: string,
    @Body() body: { startFrame?: unknown; frameCount?: unknown },
  ) {
    const actor = this.actor(request);
    const recordingId = uuid(id);
    const sessionId = uuid(sid);
    const { startFrame, frameCount } = body ?? {};
    if (!Number.isInteger(startFrame) || (startFrame as number) < 0) throw invalid('startFrame');
    if (!Number.isInteger(frameCount) || (frameCount as number) < 1) throw invalid('frameCount');
    const check = () =>
      withTenantDatabaseTransaction(this.database, actor.tenantId, (tx) =>
        this.authorizeSession(tx, actor, recordingId, sessionId),
      );
    const { recording, format } = await check();
    if ((frameCount as number) > format.sampleRate * RECORDING_CHUNK_SECONDS) {
      throw invalid('frameCount');
    }
    if ((startFrame as number) >= format.totalFrames) throw invalid('startFrame');
    const range = frameByteRange(format, startFrame as number, frameCount as number);
    const { bytes } = await this.read(
      actor.tenantId,
      recording.storageKey,
      range.start,
      range.endInclusive,
    );
    // the permission may be revoked while reading storage, so check again before sending bytes
    await check();
    const frameBytes = format.channels * 2;
    // do not send beyond the requested range even if storage answers with more
    const wanted = Math.min(bytes.length, range.frames * frameBytes);
    const pcm = bytes.subarray(0, wanted - (wanted % frameBytes));
    return new StreamableFile(wavChunk(format, pcm), { type: 'audio/wav' });
  }

  @Post(':recordingId/playback-sessions/:sessionId/close')
  @HttpCode(204)
  @GatewayRoles('supervisor')
  async close(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('recordingId') id: string,
    @Param('sessionId') sid: string,
  ) {
    const actor = this.actor(request);
    const recordingId = uuid(id);
    const sessionId = uuid(sid);
    // closing can repeat, and works even after the listening permission is revoked, but only for the caller's own session
    await withTenantDatabaseTransaction(this.database, actor.tenantId, (tx) =>
      tx.recordingPlaybackSession.updateMany({
        where: {
          id: sessionId,
          tenantId: actor.tenantId,
          recordingId,
          actorUserId: actor.userId,
          closedAt: null,
        },
        data: { closedAt: new Date() },
      }),
    );
  }

  private actor(request: AuthenticatedGatewayRequest): Actor {
    const identity = request.gatewayIdentity;
    if (!identity || !this.enabled) throw denied();
    return { tenantId: identity.tenantId, userId: identity.userId };
  }

  /** the Supervisor's current active teams, read from the DB every time without trusting only the role in the token */
  private async supervisorTeam(tx: Prisma.TransactionClient, actor: Actor): Promise<string> {
    const user = await tx.user.findFirst({
      where: { id: actor.userId, tenantId: actor.tenantId, role: 'SUPERVISOR', isActive: true },
      select: { teamId: true },
    });
    if (!user?.teamId) throw denied();
    return user.teamId;
  }

  /** the recordings this team may access: a finished call, not deleted, with evidence that this team answered */
  private visible(
    tx: Prisma.TransactionClient,
    tenantId: string,
    teamId: string,
    tail: Prisma.Sql,
  ): Promise<VisibleRecording[]> {
    return tx.$queryRaw<VisibleRecording[]>`
      SELECT r.id, r.interaction_id AS "interactionId", r.storage_key AS "storageKey",
        r.started_at AS "startedAt", r.ended_at AS "endedAt", r.duration_sec AS "durationSec",
        r.channel_layout::text AS "channelLayout", r.archived_at AS "archivedAt",
        q.name AS "queueName", u.display_name AS "agentName"
      FROM recordings r
      JOIN interactions i ON i.tenant_id = r.tenant_id AND i.id = r.interaction_id
      JOIN voice_interaction_handling_attributions a
        ON a.tenant_id = r.tenant_id AND a.interaction_id = r.interaction_id
      LEFT JOIN queues q ON q.tenant_id = i.tenant_id AND q.id = i.queue_id
      LEFT JOIN users u ON u.tenant_id = a.tenant_id AND u.id = a.agent_id
      WHERE r.tenant_id = ${tenantId}::uuid AND r.deleted_at IS NULL
        AND i.state = 'COMPLETED' AND a.team_id = ${teamId}::uuid
        ${tail}`;
  }

  private async authorize(
    tx: Prisma.TransactionClient,
    actor: Actor,
    recordingId: string,
  ): Promise<VisibleRecording> {
    const teamId = await this.supervisorTeam(tx, actor);
    const [recording] = await this.visible(
      tx,
      actor.tenantId,
      teamId,
      Prisma.sql`AND r.id = ${recordingId}::uuid`,
    );
    if (!recording) throw notFound();
    return recording;
  }

  private async authorizeReady(tx: Prisma.TransactionClient, actor: Actor, recordingId: string) {
    const recording = await this.authorize(tx, actor, recordingId);
    if (!recording.archivedAt) throw new ConflictException({ code: 'RECORDING_NOT_READY' });
    return recording;
  }

  /** a session is not a permission: it must belong to the requester, not be expired, and the current listening permission must still hold */
  private async authorizeSession(
    tx: Prisma.TransactionClient,
    actor: Actor,
    recordingId: string,
    sessionId: string,
  ): Promise<{ recording: VisibleRecording; format: WavFormat }> {
    const recording = await this.authorizeReady(tx, actor, recordingId);
    const session = await tx.recordingPlaybackSession.findFirst({
      where: { id: sessionId, tenantId: actor.tenantId, recordingId, actorUserId: actor.userId },
      select: {
        dataOffset: true,
        sampleRate: true,
        channels: true,
        totalFrames: true,
        expiresAt: true,
        closedAt: true,
      },
    });
    if (!session) throw notFound();
    if (session.closedAt || session.expiresAt <= new Date()) {
      throw new ConflictException({ code: 'PLAYBACK_SESSION_EXPIRED' });
    }
    return {
      recording,
      format: {
        dataOffset: session.dataOffset,
        sampleRate: session.sampleRate,
        channels: session.channels as 1 | 2,
        totalFrames: session.totalFrames,
      },
    };
  }

  private async read(tenantId: string, storageKey: string, start: number, endInclusive: number) {
    try {
      return await this.storage.readRange({ tenantId, storageKey, start, endInclusive });
    } catch (error) {
      if (error instanceof HttpException) throw error;
      // do not log the key or a message from storage, which may contain an internal path
      logger.error({
        event: 'recording_playback_storage_failed',
        name: error instanceof Error ? error.name : typeof error,
      });
      throw new ServiceUnavailableException({ code: 'STORAGE_UNAVAILABLE' });
    }
  }
}
