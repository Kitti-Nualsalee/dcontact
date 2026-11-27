import type { ManagedVoiceEvent } from '@d-contact/router';
import type { FreeSwitchEvent } from './freeswitch-normalizer.js';

export function normalizeManagedVoiceEvent(
  source: FreeSwitchEvent,
  tenantId: string,
  nodeId: string,
): ManagedVoiceEvent | undefined {
  const types = {
    CHANNEL_CREATE: 'call.created',
    CHANNEL_ANSWER: 'call.answered',
    CHANNEL_BRIDGE: 'call.bridge',
    CHANNEL_HANGUP_COMPLETE: 'call.hangup',
  } as const;
  const name = source['Event-Name'];
  if (typeof name !== 'string' || !(name in types)) return undefined;
  const type = types[name as keyof typeof types];
  const callUuid = source.variable_dcontact_call_uuid ?? source['Unique-ID'];
  if (typeof callUuid !== 'string') return undefined;
  if (
    source.variable_dcontact_tenant_id !== undefined &&
    source.variable_dcontact_tenant_id !== tenantId
  )
    throw new Error('MANAGED_VOICE_EVENT_TENANT_MISMATCH');
  if (source.variable_dcontact_node_id !== undefined && source.variable_dcontact_node_id !== nodeId)
    throw new Error('MANAGED_VOICE_EVENT_NODE_MISMATCH');
  const offerId = source.variable_dcontact_offer_id;
  const agentId = source.variable_dcontact_agent_id;
  const blegUuid = source.variable_dcontact_bleg_uuid;
  if (
    (type === 'call.answered' || type === 'call.bridge') &&
    ![offerId, agentId, blegUuid].every((value) => typeof value === 'string')
  )
    return undefined;
  if (type === 'call.created' && offerId !== undefined) return undefined;
  const callerHangup = type === 'call.hangup' && source['Unique-ID'] === callUuid;
  const hangupInitiator = type === 'call.hangup' ? initiator(source, callerHangup) : undefined;
  return {
    tenantId,
    telephonyNodeId: nodeId,
    callUuid,
    type,
    ...(typeof source['Caller-Destination-Number'] === 'string'
      ? { destination: source['Caller-Destination-Number'] }
      : {}),
    ...(typeof source['Caller-Caller-ID-Number'] === 'string'
      ? { caller: source['Caller-Caller-ID-Number'] }
      : {}),
    ...(!callerHangup && typeof offerId === 'string' ? { offerId } : {}),
    ...(!callerHangup && typeof agentId === 'string' ? { agentId } : {}),
    ...(!callerHangup && typeof blegUuid === 'string' ? { blegUuid } : {}),
    ...(hangupInitiator ? { hangupInitiator } : {}),
  };
}

/**
 * Which side ended the call. `sip_hangup_disposition` is per leg: `recv_*` means the far end of this leg hung up,
 * `send_*` means the switch ended this leg because the other side (or the switch itself) did. The caller leg (A)
 * faces the customer and the offer leg (B) faces the Agent, so both legs agree on who hung up whichever event
 * arrives first. A `send_*` is trusted only with `NORMAL_CLEARING`: a switch-side end (media timeout, kill,
 * shutdown) sends BYE on both legs and must not be read as the other party hanging up
 */
function initiator(source: FreeSwitchEvent, callerLeg: boolean): 'caller' | 'agent' | undefined {
  const disposition = source.variable_sip_hangup_disposition;
  if (typeof disposition !== 'string') return undefined;
  const received = disposition.startsWith('recv_');
  if (!received && !disposition.startsWith('send_')) return undefined;
  if (!received && source['Hangup-Cause'] !== 'NORMAL_CLEARING') return undefined;
  return received === callerLeg ? 'caller' : 'agent';
}
