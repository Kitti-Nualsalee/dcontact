import type { TelephonyCommand } from '@d-contact/shared';

export interface FreeSwitchEslCommandClient {
  command(value: string): Promise<void>;
}

/** แปลง command กลางให้เป็น ESL command โดยไม่ให้ Router ผูกกับ FreeSWITCH syntax */
export class FreeSwitchCommandAdapter {
  constructor(
    private readonly esl: FreeSwitchEslCommandClient,
    private readonly sipDomain = process.env.FREESWITCH_SIP_DOMAIN ?? 'dcontact.local',
  ) {}

  async handle(command: TelephonyCommand): Promise<void> {
    if (command.vendor !== 'freeswitch') return;
    if (command.type !== 'call.bridge') throw new Error(`unsupported telephony command ${command.type}`);
    await this.esl.command(
      `api uuid_bridge ${command.callUuid} user/${command.agentExtension}@${this.sipDomain}`,
    );
  }
}
