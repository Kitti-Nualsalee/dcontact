import type { TelephonyCommand } from '@d-contact/shared';

export interface FreeSwitchEslCommandClient {
  command(value: string): Promise<void>;
}

export interface FreeSwitchVoiceTargetResolver {
  resolve(input: {
    tenantId: string;
    targetIdentityId: string;
  }): Promise<{ extension: string } | null>;
}

/** แปลง command กลางให้เป็น ESL command โดยไม่ให้ Router ผูกกับ FreeSWITCH syntax */
export class FreeSwitchCommandAdapter {
  constructor(
    private readonly esl: FreeSwitchEslCommandClient,
    private readonly sipDomain = process.env.FREESWITCH_SIP_DOMAIN ?? 'dcontact.local',
    private readonly telephonyNodeId = process.env.TELEPHONY_NODE_ID ?? 'fs-local',
    private readonly agentDialTemplate = process.env.FREESWITCH_AGENT_DIAL_TEMPLATE ??
      'user/{extension}@{domain}',
    private readonly voiceOriginate: {
      enabled: boolean;
      resolver?: FreeSwitchVoiceTargetResolver;
    } = { enabled: false },
  ) {}

  async handle(command: TelephonyCommand, tenantId?: string): Promise<void> {
    if (command.vendor !== 'freeswitch' || command.telephonyNodeId !== this.telephonyNodeId) return;
    if (command.type === 'sip.registration.flush') {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(command.extension)) {
        throw new Error('invalid SIP extension');
      }
      if (!/^[A-Za-z0-9.-]{1,253}$/.test(command.sipDomain)) {
        throw new Error('invalid SIP domain');
      }
      await this.esl.command(
        `api sofia profile internal flush_inbound_reg ${command.extension}@${command.sipDomain}`,
      );
      return;
    }
    if (command.type === 'call.bridge') {
      const dialString = this.agentDialTemplate
        .replaceAll('{extension}', command.agentExtension)
        .replaceAll('{domain}', this.sipDomain);
      await this.esl.command(`api uuid_transfer ${command.callUuid} bridge:${dialString} inline`);
      return;
    }
    if (command.type === 'call.originate') {
      if (!this.voiceOriginate.enabled || !tenantId || !this.voiceOriginate.resolver) return;
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(command.agentExtension)) {
        throw new Error('invalid SIP extension');
      }
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          command.originationUuid,
        )
      ) {
        throw new Error('invalid origination UUID');
      }
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(command.deliveryId)) {
        throw new Error('invalid delivery ID');
      }
      const target = await this.voiceOriginate.resolver.resolve({
        tenantId,
        targetIdentityId: command.targetIdentityId,
      });
      if (!target || !/^1[0-9]{3}$/.test(target.extension)) {
        throw new Error('voice target is not an allowed internal extension');
      }
      const agentDialString = this.agentDialTemplate
        .replaceAll('{extension}', command.agentExtension)
        .replaceAll('{domain}', this.sipDomain);
      const targetDialString = this.agentDialTemplate
        .replaceAll('{extension}', target.extension)
        .replaceAll('{domain}', this.sipDomain);
      await this.esl.command(
        `bgapi originate {origination_uuid=${command.originationUuid},dcontact_delivery_id=${command.deliveryId}}${agentDialString} &bridge(${targetDialString})`,
      );
      return;
    }
    if (command.type === 'call.collect') {
      const prompt = command.prompt.trim().replaceAll(/\s+/g, '_');
      await this.esl.command(`api uuid_answer ${command.callUuid}`);
      await this.esl.command(`api uuid_broadcast ${command.callUuid} say:flite.slt:${prompt} aleg`);
      if (command.inputMode === 'VOICE') {
        await this.esl.command(
          `api uuid_broadcast ${command.callUuid} detect_speech:pocketsphinx aleg`,
        );
      }
      return;
    }
    if (command.type === 'recording.pause' || command.type === 'recording.resume') {
      await this.esl.command(
        `api uuid_record ${command.callUuid} ${command.type === 'recording.pause' ? 'pause' : 'resume'} ${command.recordingPath}`,
      );
      return;
    }
    if (command.type === 'recording.announce') {
      const announcement = command.announcement.trim().replaceAll(/\s+/g, '_');
      await this.esl.command(
        `api uuid_broadcast ${command.callUuid} say:flite.slt:${announcement} aleg`,
      );
      return;
    }
    if (command.type === 'recording.start') {
      await this.esl.command(`api uuid_record ${command.callUuid} start ${command.recordingPath}`);
      return;
    }
    throw new Error(`unsupported telephony command ${(command as { type: string }).type}`);
  }
}
