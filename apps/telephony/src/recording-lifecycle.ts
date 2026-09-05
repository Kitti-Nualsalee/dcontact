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

/** Telephony เป็นเจ้าของการสร้าง recording เมื่อ media bridge เริ่มขึ้น. */
export class TelephonyRecordingLifecycle {
  constructor(
    private readonly database: PrismaClient,
    private readonly commands: TelephonyRecordingCommandSink,
    private readonly archive: RecordingArchive,
    private readonly recordingsDirectory = process.env.FREESWITCH_RECORDINGS_DIR ??
      '/var/lib/freeswitch/recordings',
  ) {}

  async startForAnsweredCall(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<void> {
    if (event.type !== 'call.answered' || event.payload.vendor !== 'freeswitch') return;
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
          select: { telephonyPath: true, channelLayout: true },
        });
        return {
          ...created,
          announcement: interaction.queue.recordingAnnouncement,
          language: interaction.queue.recordingAnnouncementLanguage,
        };
      },
    );
    if (!recording) return;
    await this.archive.prepare({
      tenantId: event.tenantId,
      telephonyPath: recording.telephonyPath,
    });
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
  }

  async finishForHungupCall(event: KafkaEventEnvelope<TelephonyCallEvent>): Promise<void> {
    if (event.type !== 'call.hangup' || event.payload.vendor !== 'freeswitch') return;
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
    if (!recording) return;
    await this.archiveRecording(event.tenantId, recording);
  }

  async retryPendingArchives(telephonyNodeId: string): Promise<string[]> {
    const tenants = await this.database.tenant.findMany({ select: { id: true } });
    const archived: string[] = [];
    for (const { id: tenantId } of tenants) {
      const pending = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.recording.findMany({
          where: {
            tenantId,
            endedAt: { not: null },
            archivedAt: null,
            deletedAt: null,
            interaction: {
              metadata: { path: ['telephonyNodeId'], equals: telephonyNodeId },
            },
          },
          select: { id: true, storageKey: true, telephonyPath: true },
          orderBy: { endedAt: 'asc' },
          take: 20,
        }),
      );
      for (const recording of pending) {
        await this.archiveRecording(tenantId, recording);
        archived.push(recording.id);
      }
    }
    return archived;
  }

  private async archiveRecording(
    tenantId: string,
    recording: { id: string; storageKey: string; telephonyPath: string },
  ): Promise<void> {
    await this.archive.archive({
      tenantId,
      storageKey: recording.storageKey,
      telephonyPath: recording.telephonyPath,
    });
    await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.recording.updateMany({
        where: { id: recording.id, tenantId, archivedAt: null },
        data: { archivedAt: new Date() },
      }),
    );
  }
}
