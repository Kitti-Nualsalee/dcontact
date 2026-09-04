import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent, TelephonyCallEventType } from '@d-contact/shared';

export interface FreeSwitchEvent {
  'Event-Name'?: unknown;
  'Unique-ID'?: unknown;
  'Caller-Caller-ID-Number'?: unknown;
  'Caller-Destination-Number'?: unknown;
  variable_domain_name?: unknown;
}

export interface FreeSwitchNormalizationDependencies {
  resolveTenantId(sipDomain: string): string | undefined;
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
  CHANNEL_ANSWER: 'call.answered',
  CHANNEL_HANGUP_COMPLETE: 'call.hangup',
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
  if (!type) throw new FreeSwitchNormalizationError(`FreeSWITCH event is not supported: ${sourceType}`);

  const callUuid = requiredString(event, 'Unique-ID');
  const sipDomain = requiredString(event, 'variable_domain_name');
  const tenantId = dependencies.resolveTenantId(sipDomain);
  if (!tenantId) throw new FreeSwitchNormalizationError(`no tenant for SIP domain: ${sipDomain}`);

  const caller = requiredString(event, 'Caller-Caller-ID-Number');
  const destination = requiredString(event, 'Caller-Destination-Number');
  const occurredAt = dependencies.now();
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new FreeSwitchNormalizationError('normalizer clock must return an ISO-8601 timestamp');
  }

  return {
    eventId: dependencies.eventId(),
    type,
    tenantId,
    occurredAt,
    correlationId: callUuid,
    orderingKey: callUuid,
    payload: { callUuid, vendor: 'freeswitch', telephonyNodeId: dependencies.telephonyNodeId, caller, destination },
  };
}
