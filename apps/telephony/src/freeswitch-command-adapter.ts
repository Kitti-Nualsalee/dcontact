import type { TelephonyCommand } from '@d-contact/shared';

export interface FreeSwitchEslCommandClient {
  command(value: string): Promise<void>;
}

/** แปลง command กลางให้เป็น ESL command โดยไม่ให้ Router ผูกกับ FreeSWITCH syntax */
export class FreeSwitchCommandAdapter {
  constructor(
    private readonly esl: FreeSwitchEslCommandClient,
    private readonly sipDomain = process.env.FREESWITCH_SIP_DOMAIN ?? 'dcontact.local',
    private readonly telephonyNodeId = process.env.TELEPHONY_NODE_ID ?? 'fs-local',
    private readonly agentDialTemplate = process.env.FREESWITCH_AGENT_DIAL_TEMPLATE ??
      'user/{extension}@{domain}',
  ) {}

  async handle(command: TelephonyCommand): Promise<void> {
    if (command.vendor !== 'freeswitch' || command.telephonyNodeId !== this.telephonyNodeId) return;
    if (command.type === 'call.bridge') {
      const dialString = this.agentDialTemplate
        .replaceAll('{extension}', command.agentExtension)
        .replaceAll('{domain}', this.sipDomain);
      await this.esl.command(`api uuid_transfer ${command.callUuid} bridge:${dialString} inline`);
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
    throw new Error(`unsupported telephony command ${(command as { type: string }).type}`);
  }
}
