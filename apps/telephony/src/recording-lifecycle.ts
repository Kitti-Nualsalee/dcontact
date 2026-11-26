import type { KafkaEventEnvelope } from '@d-contact/kafka';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { TelephonyCallEvent, TelephonyCommand } from '@d-contact/shared';

export interface TelephonyRecordingCommandSink {
  handle(command: TelephonyCommand): Promise<void>;
}

export interface RecordingArchive {
  prepare(input: { tenantId: string; telephonyPath: string }): Promise<void>;
  archive(input: { tenantId: string; storageKey: string; telephonyPath: string }): Promise<void>;
}

export interface TelephonyRecordingLifecycleOptions {
  /** An mkdir on unresponsive storage (e.g. a hung NFS) must not stall the call's start-recording work. Default 5 seconds */
  prepareTimeoutMs?: number;
  /** An archive (file read + PUT) stuck longer than this counts as failed so it does not stall the retry round. Default 60 seconds */
  archiveTimeoutMs?: number;
  /**
   * Stop retrying a missing file (ENOENT) when all of these hold: more than missingFileGraceMs (30 minutes) since hangup,
   * this process has seen ENOENT continuously for more than missingFileObservationMs (10 minutes), and another archive of the node
   * succeeded after the file was first seen missing (proving the storage is visible and the whole mount has not vanished)
   */
  missingFileGraceMs?: number;
  missingFileObservationMs?: number;
  /** A failed retry round skips that item for exponentially longer, starting at 5 seconds up to 5 minutes */
  retryBackoffInitialMs?: number;
  retryBackoffMaxMs?: number;
  now?: () => Date;
  log?: (message: string, details: Record<string, unknown>) => void;
}

export interface PendingArchive {
  id: string;
  storageKey: string;
  telephonyPath: string;
  endedAt?: Date | null;
}

/** Telephony owns creating the recording when the media bridge starts. */
export class TelephonyRecordingLifecycle {
  private readonly prepareTimeoutMs: number;
  private readonly archiveTimeoutMs: number;
  private readonly missingFileGraceMs: number;
  private readonly missingFileObservationMs: number;
  private readonly retryBackoffInitialMs: number;
  private readonly retryBackoffMaxMs: number;
  private readonly now: () => Date;
  private readonly log: (message: string, details: Record<string, unknown>) => void;
  /** Recordings being archived (from hangup or a retry round), preventing concurrent duplicate file reads and PUTs */
  private readonly archivesInFlight = new Set<string>();
  /** In-memory backoff state of items whose retry failed; counting restarts after a restart */
  private readonly retryFailures = new Map<
    string,
    {
      attempts: number;
      nextAttemptAt: number;
      firstMissingAt?: number;
      successesAtFirstMissing?: number;
    }
  >();
  /** Number of archives that succeeded in this process, used to prove storage is still visible after one file went missing */
  private archiveSuccesses = 0;
  private retryInProgress = false;

  constructor(
    private readonly database: PrismaClient,
    private readonly commands: TelephonyRecordingCommandSink,
    private readonly archive: RecordingArchive,
    private readonly recordingsDirectory = process.env.FREESWITCH_RECORDINGS_DIR ??
      '/var/lib/freeswitch/recordings',
    options: TelephonyRecordingLifecycleOptions = {},
  ) {
    this.prepareTimeoutMs = options.prepareTimeoutMs ?? 5_000;
    this.archiveTimeoutMs = options.archiveTimeoutMs ?? 60_000;
    this.missingFileGraceMs = options.missingFileGraceMs ?? 30 * 60_000;
    this.missingFileObservationMs = options.missingFileObservationMs ?? 10 * 60_000;
    this.retryBackoffInitialMs = options.retryBackoffInitialMs ?? 5_000;
    this.retryBackoffMaxMs = options.retryBackoffMaxMs ?? 5 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message, details) => console.error(message, details));
  }

  async startForAnsweredCall(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<void> {
    const start = await this.beginForAnsweredCall(event);
    await start?.();
  }

  /**
   * Step 1 creates the recording row (DB only, fast) and returns step 2 (prepare storage, announcement, uuid_record)
   * for the caller to sequence itself, so hangup can set endedAt without waiting for slow storage
   */
  async beginForAnsweredCall(
    event: KafkaEventEnvelope<TelephonyCallEvent>,
  ): Promise<(() => Promise<void>) | undefined> {
    if (event.type !== 'call.answered' || event.payload.vendor !== 'freeswitch') return undefined;
    const recording = await withTenantDatabaseTransaction(
      this.database,
      event.tenantId,
      async (transaction) => {
        const interaction = await transaction.interaction.findFirst({
          where: { tenantId: event.tenantId, externalId: event.payload.callUuid, channel: 'VOICE' },
          select: {
            id: true,
            queue: {
              select: {
                recordingEnabled: true,
                recordingAnnouncement: true,
                recordingAnnouncementLanguage: true,
                recordingChannelLayout: true,
              },
            },
          },
        });
        if (!interaction?.queue?.recordingEnabled) return undefined;
        const existing = await transaction.recording.findFirst({
          where: { tenantId: event.tenantId, interactionId: interaction.id },
          select: { id: true },
        });
        if (existing) return undefined;
        const storageKey = `recordings/${event.tenantId}/${interaction.id}.wav`;
        const telephonyPath = `${this.recordingsDirectory}/${event.tenantId}/${interaction.id}.wav`;
        const created = await transaction.recording.create({
          data: {
            tenantId: event.tenantId,
            interactionId: interaction.id,
            storageKey,
            telephonyPath,
            channelLayout: interaction.queue.recordingChannelLayout,
            startedAt: new Date(event.occurredAt),
          },
          select: { id: true, telephonyPath: true, channelLayout: true },
        });
        return {
          ...created,
          announcement: interaction.queue.recordingAnnouncement,
          language: interaction.queue.recordingAnnouncementLanguage,
        };
      },
    );
    if (!recording) return undefined;
    return () => this.startRecordingMedia(event, recording);
  }

  private async startRecordingMedia(
    event: KafkaEventEnvelope<TelephonyCallEvent>,
    recording: {
      id: string;
      telephonyPath: string;
      channelLayout: 'PER_LEG' | 'STEREO';
      announcement: string | null;
      language: string | null;
    },
  ): Promise<void> {
    try {
      await withTimeout(
        this.archive.prepare({ tenantId: event.tenantId, telephonyPath: recording.telephonyPath }),
        this.prepareTimeoutMs,
        'recording storage prepare timed out',
      );
      if (recording.announcement && recording.language) {
        await this.commands.handle({
          callUuid: event.payload.callUuid,
          vendor: event.payload.vendor,
          telephonyNodeId: event.payload.telephonyNodeId,
          type: 'recording.announce',
          announcement: recording.announcement,
          language: recording.language,
        });
      }
      await this.commands.handle({
        callUuid: event.payload.callUuid,
        vendor: event.payload.vendor,
        telephonyNodeId: event.payload.telephonyNodeId,
        type: 'recording.start',
        recordingPath: recording.telephonyPath,
        channelLayout: recording.channelLayout,
      });
    } catch (error) {
      // #923: no audio file was produced; if the row were left, retryPendingArchives would keep reading a file that will never exist (ENOENT),
      // so delete the row before rethrowing the error. It can be deleted even when hangup already set endedAt while waiting for storage
      await this.discardUnstartedRecording(event.tenantId, recording.id);
      throw error;
    }
  }

  private async discardUnstartedRecording(tenantId: string, recordingId: string): Promise<void> {
    try {
      await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.recording.deleteMany({
          where: { id: recordingId, tenantId, archivedAt: null },
        }),
      );
      return;
    } catch (deleteError) {
      // hangup may set endedAt while waiting for storage and QM then creates a job referencing this row (FK RESTRICT), so it cannot be deleted.
      // It is certain uuid_record was not sent, so stop retrying at once with evidence instead of letting retry chase a file that will never exist
      try {
        const abandoned = await withTenantDatabaseTransaction(
          this.database,
          tenantId,
          async (transaction) => {
            const result = await transaction.recording.updateMany({
              where: {
                id: recordingId,
                tenantId,
                archivedAt: null,
                deletedAt: null,
                legalHolds: { none: { releasedAt: null } },
              },
              data: { deletedAt: this.now() },
            });
            if (result.count !== 1) return false;
            await transaction.recordingAuditEvent.create({
              data: {
                tenantId,
                recordingId,
                action: 'ARCHIVE_ABANDONED',
                reason: 'RECORDING_NOT_STARTED',
                details: { deleteErrorCode: errorCode(deleteError) ?? 'UNKNOWN' },
              },
            });
            return true;
          },
        );
        this.log('[telephony] unstarted recording kept as abandoned', {
          tenantId,
          recordingId,
          abandoned,
          ...describeError(deleteError),
        });
      } catch (rollbackError) {
        this.log('[telephony] recording rollback failed', {
          tenantId,
          recordingId,
          ...describeError(rollbackError),
        });
      }
    }
  }

  async finishForHungupCall(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<void> {
    const recording = await this.endForHungupCall(event);
    if (recording) await this.archiveEndedRecording(event.tenantId, recording);
  }

  /** Sets endedAt (DB only) and returns the row to archive next. QM reads endedAt at interaction.ended */
  async endForHungupCall(
    event: KafkaEventEnvelope<TelephonyCallEvent>,
  ): Promise<PendingArchive | undefined> {
    if (event.type !== 'call.hangup' || event.payload.vendor !== 'freeswitch') return undefined;
    const endedAt = new Date(event.occurredAt);
    const recording = await withTenantDatabaseTransaction(
      this.database,
      event.tenantId,
      async (transaction) => {
        const current = await transaction.recording.findFirst({
          where: {
            tenantId: event.tenantId,
            interaction: { externalId: event.payload.callUuid },
          },
          select: {
            id: true,
            storageKey: true,
            telephonyPath: true,
            startedAt: true,
            endedAt: true,
            archivedAt: true,
          },
        });
        if (!current || current.archivedAt) return undefined;
        if (!current.endedAt) {
          await transaction.recording.updateMany({
            where: { id: current.id, tenantId: event.tenantId, endedAt: null },
            data: {
              endedAt,
              durationSec: Math.max(
                0,
                Math.floor((endedAt.getTime() - current.startedAt.getTime()) / 1_000),
              ),
            },
          });
        }
        return current;
      },
    );
    return recording ?? undefined;
  }

  async archiveEndedRecording(tenantId: string, recording: PendingArchive): Promise<void> {
    await this.archiveRecording(tenantId, recording);
  }

  /**
   * Tries to archive recordings that were hung up but are not yet in the object storage of this node.
   * A failed item does not block other items or other tenants, and overlapping rounds are skipped
   */
  async retryPendingArchives(telephonyNodeId: string): Promise<string[]> {
    if (this.retryInProgress) return [];
    this.retryInProgress = true;
    try {
      return await this.retryPendingArchivesOnce(telephonyNodeId);
    } finally {
      this.retryInProgress = false;
    }
  }

  private async retryPendingArchivesOnce(telephonyNodeId: string): Promise<string[]> {
    const tenants = await this.database.tenant.findMany({ select: { id: true } });
    const archived: string[] = [];
    for (const { id: tenantId } of tenants) {
      const backedOff = this.backedOffRecordingIds();
      let pending: PendingArchive[];
      try {
        pending = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
          transaction.recording.findMany({
            where: {
              tenantId,
              endedAt: { not: null },
              archivedAt: null,
              deletedAt: null,
              ...(backedOff.length > 0 ? { id: { notIn: backedOff } } : {}),
              interaction: {
                metadata: { path: ['telephonyNodeId'], equals: telephonyNodeId },
              },
            },
            select: { id: true, storageKey: true, telephonyPath: true, endedAt: true },
            orderBy: { endedAt: 'asc' },
            take: 20,
          }),
        );
      } catch (error) {
        this.log('[telephony] recording archive retry skipped tenant', {
          tenantId,
          ...describeError(error),
        });
        continue;
      }
      for (const recording of pending) {
        try {
          if (await this.archiveRecording(tenantId, recording)) archived.push(recording.id);
        } catch (error) {
          await this.handleRetryFailure(tenantId, telephonyNodeId, recording, error);
        }
      }
    }
    return archived;
  }

  private backedOffRecordingIds(): string[] {
    const now = this.now().getTime();
    return [...this.retryFailures]
      .filter(([, failure]) => failure.nextAttemptAt > now)
      .map(([id]) => id);
  }

  private async handleRetryFailure(
    tenantId: string,
    telephonyNodeId: string,
    recording: PendingArchive,
    error: unknown,
  ): Promise<void> {
    const now = this.now();
    const previous = this.retryFailures.get(recording.id);
    const attempts = (previous?.attempts ?? 0) + 1;
    const missingForMs = recording.endedAt ? now.getTime() - recording.endedAt.getTime() : 0;
    const missing = errorCode(error) === 'ENOENT';
    const firstMissingAt = missing ? (previous?.firstMissingAt ?? now.getTime()) : undefined;
    const successesAtFirstMissing = missing
      ? (previous?.successesAtFirstMissing ?? this.archiveSuccesses)
      : undefined;
    const storageVisible =
      successesAtFirstMissing !== undefined && this.archiveSuccesses > successesAtFirstMissing;
    if (
      missing &&
      missingForMs >= this.missingFileGraceMs &&
      now.getTime() - firstMissingAt! >= this.missingFileObservationMs &&
      storageVisible
    ) {
      try {
        // e.g. the caller hangs up before FreeSWITCH creates the file: the file will never exist, so stop retrying and keep the evidence in the audit
        const abandoned = await this.abandonMissingRecording(tenantId, telephonyNodeId, recording, {
          attempts,
          missingForMs,
        });
        if (!abandoned) {
          this.log('[telephony] recording archive not abandoned: legal hold or already handled', {
            tenantId,
            recordingId: recording.id,
          });
        } else {
          this.retryFailures.delete(recording.id);
          this.log('[telephony] recording archive abandoned: source file missing', {
            tenantId,
            recordingId: recording.id,
            attempts,
            missingForSec: Math.floor(missingForMs / 1_000),
          });
          return;
        }
      } catch (abandonError) {
        this.log('[telephony] recording archive abandon failed', {
          tenantId,
          recordingId: recording.id,
          ...describeError(abandonError),
        });
      }
    }
    const delayMs = Math.min(
      this.retryBackoffMaxMs,
      this.retryBackoffInitialMs * 2 ** Math.min(attempts - 1, 30),
    );
    this.retryFailures.set(recording.id, {
      attempts,
      nextAttemptAt: now.getTime() + delayMs,
      firstMissingAt,
      successesAtFirstMissing,
    });
    this.log('[telephony] recording archive retry failed', {
      tenantId,
      recordingId: recording.id,
      attempts,
      nextRetryInSec: Math.ceil(delayMs / 1_000),
      ...describeError(error),
    });
  }

  private async abandonMissingRecording(
    tenantId: string,
    telephonyNodeId: string,
    recording: PendingArchive,
    evidence: { attempts: number; missingForMs: number },
  ): Promise<boolean> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const result = await transaction.recording.updateMany({
        where: {
          id: recording.id,
          tenantId,
          archivedAt: null,
          deletedAt: null,
          // Same as retention: a recording under legal hold does not get deletedAt set
          legalHolds: { none: { releasedAt: null } },
        },
        data: { deletedAt: now },
      });
      if (result.count !== 1) return false;
      await transaction.recordingAuditEvent.create({
        data: {
          tenantId,
          recordingId: recording.id,
          action: 'ARCHIVE_ABANDONED',
          reason: 'SOURCE_FILE_MISSING',
          details: {
            errorCode: 'ENOENT',
            telephonyNodeId,
            endedAt: recording.endedAt?.toISOString() ?? null,
            missingForSec: Math.floor(evidence.missingForMs / 1_000),
            attempts: evidence.attempts,
          },
        },
      });
      return true;
    });
  }

  /** Returns false if an archive job for this recording is already running */
  private async archiveRecording(tenantId: string, recording: PendingArchive): Promise<boolean> {
    if (this.archivesInFlight.has(recording.id)) return false;
    this.archivesInFlight.add(recording.id);
    try {
      await withTimeout(
        this.archive.archive({
          tenantId,
          storageKey: recording.storageKey,
          telephonyPath: recording.telephonyPath,
        }),
        this.archiveTimeoutMs,
        'recording archive timed out',
      );
      await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.recording.updateMany({
          where: { id: recording.id, tenantId, archivedAt: null },
          data: { archivedAt: new Date() },
        }),
      );
      this.retryFailures.delete(recording.id);
      this.archiveSuccesses += 1;
      return true;
    } finally {
      this.archivesInFlight.delete(recording.id);
    }
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' })),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

/** Logs only the name, code and message, not the whole error object that may carry the client config/credentials */
export function describeError(error: unknown): Record<string, unknown> {
  const failure = error instanceof Error ? error : undefined;
  return {
    errorName: failure?.name,
    errorCode: errorCode(error),
    reason: failure?.message ?? String(error),
  };
}
