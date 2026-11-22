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
  /** mkdir บน storage ที่ไม่ตอบ (เช่น NFS ค้าง) ต้องไม่ค้างงานเริ่มบันทึกของสาย ค่าเริ่มต้น 5 วินาที */
  prepareTimeoutMs?: number;
  /** archive (อ่านไฟล์ + PUT) ที่ค้างนานเกินนี้ถือว่าล้ม ไม่ให้ค้างรอบ retry ค่าเริ่มต้น 60 วินาที */
  archiveTimeoutMs?: number;
  /**
   * หยุดลองไฟล์ที่ไม่มี (ENOENT) เมื่อครบทุกข้อ: วางสายมาแล้วเกิน missingFileGraceMs (30 นาที),
   * process นี้เห็น ENOENT ต่อเนื่องเกิน missingFileObservationMs (10 นาที) และมี archive อื่นของ node
   * สำเร็จหลังเห็นไฟล์หายครั้งแรก (พิสูจน์ว่า storage มองเห็น ไม่ใช่ mount หายทั้งก้อน)
   */
  missingFileGraceMs?: number;
  missingFileObservationMs?: number;
  /** รอบ retry ที่ล้มจะเว้นรายการนั้นนานขึ้นทีละเท่า เริ่ม 5 วินาที สูงสุด 5 นาที */
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

/** Telephony เป็นเจ้าของการสร้าง recording เมื่อ media bridge เริ่มขึ้น. */
export class TelephonyRecordingLifecycle {
  private readonly prepareTimeoutMs: number;
  private readonly archiveTimeoutMs: number;
  private readonly missingFileGraceMs: number;
  private readonly missingFileObservationMs: number;
  private readonly retryBackoffInitialMs: number;
  private readonly retryBackoffMaxMs: number;
  private readonly now: () => Date;
  private readonly log: (message: string, details: Record<string, unknown>) => void;
  /** recording ที่กำลัง archive อยู่ (จาก hangup หรือรอบ retry) กันอ่านไฟล์และ PUT ซ้ำพร้อมกัน */
  private readonly archivesInFlight = new Set<string>();
  /** สถานะ backoff ในหน่วยความจำของรายการที่ retry ล้ม รีสตาร์ทแล้วเริ่มนับใหม่ */
  private readonly retryFailures = new Map<
    string,
    {
      attempts: number;
      nextAttemptAt: number;
      firstMissingAt?: number;
      successesAtFirstMissing?: number;
    }
  >();
  /** จำนวน archive ที่สำเร็จใน process นี้ ใช้พิสูจน์ว่า storage ยังมองเห็นหลังไฟล์หนึ่งหาย */
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
   * ขั้นที่ 1 สร้างแถว recording (DB อย่างเดียว เร็ว) แล้วคืนขั้นที่ 2 (เตรียม storage, ประกาศ, uuid_record)
   * ให้ caller เรียงต่อเอง hangup จึงตั้ง endedAt ได้โดยไม่ต้องรอ storage ที่ช้า
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
      // #923: ไม่มีไฟล์เสียงเกิดขึ้น ถ้าปล่อยแถวไว้ retryPendingArchives จะวนอ่านไฟล์ที่ไม่มีวันมี (ENOENT)
      // จึงลบแถวทิ้งก่อนส่ง error ต่อ ลบได้แม้ hangup ตั้ง endedAt ไปแล้วระหว่างรอ storage
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
      // hangup อาจตั้ง endedAt ระหว่างรอ storage แล้ว QM สร้าง job อ้างแถวนี้ (FK RESTRICT) จึงลบไม่ได้
      // รู้แน่ว่าไม่ได้สั่ง uuid_record จึงหยุดลองทันทีพร้อมหลักฐานแทนการปล่อยให้ retry ไล่ไฟล์ที่ไม่มีวันมี
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

  /** ตั้ง endedAt (DB อย่างเดียว) และคืนแถวที่ต้อง archive ต่อ QM อ่าน endedAt ตอน interaction.ended */
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
   * ลอง archive recording ที่วางสายแล้วแต่ยังไม่ขึ้น object storage ของ node นี้
   * รายการที่ล้มไม่ขวางรายการอื่นหรือ tenant อื่น และรอบที่ซ้อนกันจะถูกข้าม
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
        // เช่น ผู้โทรวางสายก่อน FreeSWITCH สร้างไฟล์: ไฟล์ไม่มีวันมี จึงหยุดลองและเก็บหลักฐานไว้ใน audit
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
          // เหมือน retention: recording ที่ติด legal hold ไม่ถูกตั้ง deletedAt
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

  /** คืน false ถ้ามีงาน archive ของ recording นี้กำลังทำอยู่แล้ว */
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

/** log เฉพาะชื่อ รหัส และข้อความ ไม่ส่ง error object ทั้งก้อนที่อาจพก config/credential ของ client */
export function describeError(error: unknown): Record<string, unknown> {
  const failure = error instanceof Error ? error : undefined;
  return {
    errorName: failure?.name,
    errorCode: errorCode(error),
    reason: failure?.message ?? String(error),
  };
}
