import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent, TelephonyCallEventType } from '@d-contact/shared';

export interface FreeSwitchEvent {
  'Event-Name'?: unknown;
  'Unique-ID'?: unknown;
  'Caller-Caller-ID-Number'?: unknown;
  'Caller-Destination-Number'?: unknown;
  'DTMF-Digit'?: unknown;
  'Speech-Result'?: unknown;
  'Bridge-A-Unique-ID'?: unknown;
  variable_domain_name?: unknown;
}

export interface FreeSwitchNormalizationDependencies {
  resolveTenantId(sipDomain: string): string | undefined;
  /** DTMF/DETECTED_SPEECH ไม่มี channel variables จึงอ้างอิง tenant ของสายเดิม */
  resolveTenantIdForCall?(callUuid: string): string | undefined;
  telephonyNodeId: string;
  eventId(): string;
  now(): string;
}

export class FreeSwitchNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FreeSwitchNormalizationError';
  }
}

const eventTypes: Record<string, TelephonyCallEventType> = {
  CHANNEL_CREATE: 'call.created',
  CHANNEL_BRIDGE: 'call.answered',
  CHANNEL_HANGUP_COMPLETE: 'call.hangup',
  DTMF: 'call.input',
  DETECTED_SPEECH: 'call.input',
};

function requiredString(event: FreeSwitchEvent, key: keyof FreeSwitchEvent): string {
  const value = event[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FreeSwitchNormalizationError(`FreeSWITCH event requires ${key}`);
  }
  return value.trim();
}

export function normalizeFreeSwitchEvent(
  event: FreeSwitchEvent,
  dependencies: FreeSwitchNormalizationDependencies,
): KafkaEventEnvelope<TelephonyCallEvent> {
  const sourceType = requiredString(event, 'Event-Name');
  const type = eventTypes[sourceType];
  if (!type)
    throw new FreeSwitchNormalizationError(`FreeSWITCH event is not supported: ${sourceType}`);

  const callUuid =
    sourceType === 'CHANNEL_BRIDGE'
      ? requiredString(event, 'Bridge-A-Unique-ID')
      : requiredString(event, 'Unique-ID');
  const sipDomain = event.variable_domain_name;
  const tenantId =
    typeof sipDomain === 'string' && sipDomain.trim().length > 0
      ? dependencies.resolveTenantId(sipDomain.trim())
      : dependencies.resolveTenantIdForCall?.(callUuid);
  if (!tenantId) throw new FreeSwitchNormalizationError(`no tenant for SIP domain: ${sipDomain}`);

  const caller = requiredString(event, 'Caller-Caller-ID-Number');
  const destination = requiredString(event, 'Caller-Destination-Number');
  const occurredAt = dependencies.now();
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new FreeSwitchNormalizationError('normalizer clock must return an ISO-8601 timestamp');
  }

  const input =
    sourceType === 'DTMF'
      ? { inputMode: 'DTMF' as const, inputValue: requiredString(event, 'DTMF-Digit') }
      : sourceType === 'DETECTED_SPEECH'
        ? { inputMode: 'VOICE' as const, inputValue: requiredString(event, 'Speech-Result') }
        : {};

  return {
    eventId: dependencies.eventId(),
    type,
    tenantId,
    occurredAt,
    correlationId: callUuid,
    orderingKey: callUuid,
    payload: {
      callUuid,
      vendor: 'freeswitch',
      telephonyNodeId: dependencies.telephonyNodeId,
      caller,
      destination,
      ...input,
    },
  };
}
