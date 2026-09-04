import type { KafkaEventEnvelope } from '@d-contact/kafka';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { TelephonyCallEvent } from '@d-contact/shared';
import type { FreeSwitchCommandAdapter } from './freeswitch-command-adapter.js';

/** Telephony เป็นเจ้าของการสร้าง recording เมื่อ media bridge เริ่มขึ้น. */
export class TelephonyRecordingLifecycle {
  constructor(
    private readonly database: PrismaClient,
    private readonly commands: FreeSwitchCommandAdapter,
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
}
