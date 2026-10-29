import { createHash } from 'node:crypto';
import type { ManagedVoiceDirectCommand, ManagedVoiceDirectPort } from '@d-contact/router';

export interface ManagedVoiceEslTransport {
  request(command: string): Promise<string>;
}

export class ManagedVoiceReconciliationRequiredError extends Error {
  readonly code = 'MANAGED_VOICE_ORIGINATE_OUTCOME_UNKNOWN';
  readonly actionRequired = true;
  constructor() {
    super('MANAGED_VOICE_ORIGINATE_OUTCOME_UNKNOWN_ACTION_REQUIRED');
    this.name = 'ManagedVoiceReconciliationRequiredError';
  }
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class FreeSwitchManagedVoiceAdapter implements ManagedVoiceDirectPort {
  private readonly executing = new Map<string, Promise<{ confirmed: boolean }>>();
  private readonly completedJobs = new Set<string>();
  constructor(
    private readonly esl: ManagedVoiceEslTransport,
    private readonly nodeId: string,
    private readonly sipDomain: string,
  ) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(nodeId) || !/^[A-Za-z0-9.-]{1,253}$/.test(sipDomain))
      throw new Error('MANAGED_VOICE_INVALID_CONFIGURATION');
  }

  async ready(): Promise<boolean> {
    return /^UP\s+\d+\s+years?\b/im.test(await this.esl.request('api status'));
  }

  async backgroundJob(jobUuid: string) {
    if (!uuid.test(jobUuid)) throw new Error('MANAGED_VOICE_INVALID_JOB');
    const blegUuid = await this.global(`dcontact_job_${jobUuid}`);
    if (!uuid.test(blegUuid)) {
      if (this.completedJobs.size >= 1000)
        this.completedJobs.delete(this.completedJobs.values().next().value!);
      this.completedJobs.add(jobUuid);
      return;
    }
    this.completedJobs.delete(jobUuid);
    await this.accepted(`api global_setvar dcontact_offer_${blegUuid}=SETTLED`);
  }

  async bindCaller(tenantId: string, callUuid: string) {
    if (!uuid.test(tenantId) || !uuid.test(callUuid))
      throw new Error('MANAGED_VOICE_INVALID_CALLER');
    if (!(await this.exists(callUuid))) return;
    for (const [name, value] of Object.entries({
      dcontact_tenant_id: tenantId,
      dcontact_node_id: this.nodeId,
      dcontact_call_uuid: callUuid,
    })) {
      const current = await this.variable(callUuid, name);
      if (current !== '_undef_' && current !== value)
        throw new Error('MANAGED_VOICE_CHANNEL_SCOPE_MISMATCH');
      await this.accepted(`api uuid_setvar ${callUuid} ${name} ${value}`);
    }
  }

  private validate(command: ManagedVoiceDirectCommand) {
    if (
      command.telephonyNodeId !== this.nodeId ||
      ![command.commandId, command.tenantId, command.interactionId, command.callUuid].every(
        (value) => uuid.test(value),
      ) ||
      (command.offerId !== null && !uuid.test(command.offerId)) ||
      !uuid.test(command.blegUuid) ||
      command.blegUuid === command.callUuid
    )
      throw new Error('MANAGED_VOICE_INVALID_COMMAND');
  }

  private async exists(channel: string): Promise<boolean> {
    const value = await this.esl.request(`api uuid_exists ${channel}`);
    if (value !== 'true' && value !== 'false') throw new Error('MANAGED_VOICE_PROBE_UNCONFIRMED');
    return value === 'true';
  }

  private async variable(channel: string, name: string): Promise<string> {
    return this.esl.request(`api uuid_getvar ${channel} ${name}`);
  }

  private async global(name: string): Promise<string> {
    const value = await this.esl.request(`api global_getvar ${name}`);
    if (value === '-ERR no reply' || value === '_undef_') return '';
    if (value.startsWith('-ERR')) throw new Error('MANAGED_VOICE_GLOBAL_PROBE_UNCONFIRMED');
    return value;
  }

  private async owned(command: ManagedVoiceDirectCommand, channel: string, offer: boolean) {
    const expected: Record<string, string> = {
      dcontact_tenant_id: command.tenantId,
      dcontact_node_id: command.telephonyNodeId,
      dcontact_call_uuid: command.callUuid,
      ...(offer ? { dcontact_offer_id: command.offerId ?? '' } : {}),
      ...(offer && command.agentId ? { dcontact_agent_id: command.agentId } : {}),
      ...(offer ? { dcontact_bleg_uuid: command.blegUuid } : {}),
    };
    for (const [name, value] of Object.entries(expected)) {
      if ((await this.variable(channel, name)) !== value)
        throw new Error('MANAGED_VOICE_CHANNEL_SCOPE_MISMATCH');
    }
  }

  async readback(command: ManagedVoiceDirectCommand) {
    this.validate(command);
    const callerExists = await this.exists(command.callUuid);
    const blegExists = command.blegUuid ? await this.exists(command.blegUuid) : false;
    if (callerExists) await this.owned(command, command.callUuid, false);
    if (blegExists) await this.owned(command, command.blegUuid!, true);
    return { callerExists, blegExists };
  }

  private async accepted(value: string) {
    if (!(await this.esl.request(value)).startsWith('+OK'))
      throw new Error('MANAGED_VOICE_COMMAND_UNCONFIRMED');
  }

  execute(command: ManagedVoiceDirectCommand): Promise<{ confirmed: boolean }> {
    const key = JSON.stringify(command);
    const existing = this.executing.get(key);
    if (existing) return existing;
    const operation = this.dispatch(command).finally(() => this.executing.delete(key));
    this.executing.set(key, operation);
    return operation;
  }

  private marker(command: ManagedVoiceDirectCommand) {
    return `dcontact_offer_${command.blegUuid}`;
  }

  private fingerprint(command: ManagedVoiceDirectCommand) {
    return createHash('sha256')
      .update(
        JSON.stringify([
          command.commandId,
          command.tenantId,
          command.telephonyNodeId,
          command.interactionId,
          command.callUuid,
          command.offerId,
          command.blegUuid,
          command.agentId,
          command.agentExtension,
          command.expiresAt,
        ]),
      )
      .digest('hex');
  }

  private async dispatch(command: ManagedVoiceDirectCommand): Promise<{ confirmed: boolean }> {
    this.validate(command);
    if (command.type === 'offer.create') {
      if (
        !command.blegUuid ||
        !command.offerId ||
        !command.agentId ||
        !uuid.test(command.agentId) ||
        !/^[0-9]{4,6}$/.test(command.agentExtension ?? '') ||
        !command.expiresAt ||
        !Number.isFinite(Date.parse(command.expiresAt))
      )
        throw new Error('MANAGED_VOICE_INVALID_OFFER');
      if (!(await this.exists(command.callUuid))) return { confirmed: false };
      await this.owned(command, command.callUuid, false);
      if (await this.exists(command.blegUuid)) {
        await this.owned(command, command.blegUuid, true);
        if (
          (await this.variable(command.blegUuid, 'dcontact_command_fingerprint')) !==
          this.fingerprint(command)
        )
          throw new Error('MANAGED_VOICE_COMMAND_PAYLOAD_MISMATCH');
        return {
          confirmed:
            (await this.variable(command.blegUuid, 'dcontact_command_id')) === command.commandId,
        };
      }
      const remaining = Math.min(
        20,
        Math.ceil((Date.parse(command.expiresAt) - Date.now()) / 1000),
      );
      if (remaining <= 0) return { confirmed: false };
      const marker = await this.global(this.marker(command));
      if (marker !== '_undef_' && marker !== '') {
        if (marker !== this.fingerprint(command))
          throw new Error('MANAGED_VOICE_COMMAND_PAYLOAD_MISMATCH');
        return { confirmed: false };
      }
      await this.accepted(`api global_setvar ${this.marker(command)}=${this.fingerprint(command)}`);
      const variables = {
        origination_uuid: command.blegUuid,
        dcontact_command_id: command.commandId,
        dcontact_command_fingerprint: this.fingerprint(command),
        dcontact_tenant_id: command.tenantId,
        dcontact_node_id: this.nodeId,
        dcontact_call_uuid: command.callUuid,
        dcontact_offer_id: command.offerId,
        dcontact_agent_id: command.agentId,
        dcontact_bleg_uuid: command.blegUuid,
        domain_name: this.sipDomain,
        originate_timeout: String(remaining),
        park_after_bridge: 'true',
        hangup_after_bridge: 'true',
      };
      const response = await this.esl.request(
        `bgapi originate {${Object.entries(variables)
          .map(([name, value]) => `${name}=${value}`)
          .join(',')}}user/${command.agentExtension}@${this.sipDomain} &park()`,
      );
      if (!response.startsWith('+OK')) throw new Error('MANAGED_VOICE_COMMAND_UNCONFIRMED');
      const jobUuid = /Job-UUID:\s*([0-9a-f-]{36})/i.exec(response)?.[1];
      if (!jobUuid || !uuid.test(jobUuid)) throw new Error('MANAGED_VOICE_JOB_UNCONFIRMED');
      await this.accepted(`api global_setvar dcontact_job_${jobUuid}=${command.blegUuid}`);
      if (this.completedJobs.has(jobUuid)) await this.backgroundJob(jobUuid);
      if (!(await this.exists(command.blegUuid))) return { confirmed: false };
      await this.owned(command, command.blegUuid, true);
      return {
        confirmed:
          (await this.variable(command.blegUuid, 'dcontact_command_id')) === command.commandId,
      };
    }
    const state = await this.readback(command);
    if (command.type === 'call.bridge') {
      if (!state.callerExists || !state.blegExists || !command.blegUuid)
        return { confirmed: false };
      if ((await this.variable(command.callUuid, 'bridge_uuid')) === command.blegUuid)
        return { confirmed: true };
      if (!command.offerId || !command.agentId || !uuid.test(command.agentId))
        throw new Error('MANAGED_VOICE_INVALID_OFFER');
      for (const [name, value] of Object.entries({
        dcontact_offer_id: command.offerId,
        dcontact_agent_id: command.agentId,
        dcontact_bleg_uuid: command.blegUuid,
      }))
        await this.accepted(`api uuid_setvar ${command.callUuid} ${name} ${value}`);
      await this.accepted(`api uuid_bridge ${command.callUuid} ${command.blegUuid}`);
      return {
        confirmed: (await this.variable(command.callUuid, 'bridge_uuid')) === command.blegUuid,
      };
    }
    if (command.type !== 'call.hangup' && command.type !== 'offer.cancel')
      throw new Error('MANAGED_VOICE_UNSUPPORTED_COMMAND');
    const channels = [
      ...(state.blegExists && command.blegUuid ? [command.blegUuid] : []),
      ...(command.type === 'call.hangup' && state.callerExists ? [command.callUuid] : []),
    ];
    for (const channel of channels) {
      const response = await this.esl.request(`api uuid_kill ${channel} NORMAL_CLEARING`);
      if (!response.startsWith('+OK') && (await this.exists(channel))) return { confirmed: false };
    }
    if (!state.blegExists && command.blegUuid) {
      const marker = await this.global(this.marker(command));
      if (marker !== '_undef_' && marker !== '' && marker !== 'SETTLED')
        throw new ManagedVoiceReconciliationRequiredError();
    }
    const after = await this.readback(command);
    if (state.blegExists && !after.blegExists)
      await this.accepted(`api global_setvar ${this.marker(command)}=SETTLED`);
    return {
      confirmed: !after.blegExists && (command.type === 'offer.cancel' || !after.callerExists),
    };
  }
}
