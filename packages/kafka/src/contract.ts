import { KAFKA_TOPICS, type KafkaTopic } from '@d-contact/shared';

export const KAFKA_EVENT_HEADERS = {
  TENANT_ID: 'tenantId',
  EVENT_ID: 'eventId',
  CORRELATION_ID: 'correlationId',
  ORDERING_KEY: 'orderingKey',
  SCHEMA_VERSION: 'schemaVersion',
  AGGREGATE_ID: 'aggregateId',
} as const;

interface KafkaEventEnvelopeBase<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  /** stable ID of the original event, even if the producer retries */
  eventId: string;
  type: string;
  tenantId: string;
  occurredAt: string;
  /** links logs/events across services through one request or workflow */
  correlationId: string;
  /** Kafka partition key; events of the same entity must use the same value */
  orderingKey: string;
  causationId?: string;
  payload: TPayload;
}

/** separates canonical aggregate events from ingress and commands that have no real version yet. */
export type KafkaEventKind = 'CANONICAL' | 'INGRESS' | 'COMMAND';

/** Wire format used before Kafka envelope V2. */
export interface KafkaEventEnvelopeV1<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> extends KafkaEventEnvelopeBase<TPayload> {
  /** V1 is identified by the absence of schemaVersion at the top-level envelope. */
  schemaVersion?: undefined;
}

/**
 * Versioned envelope for new E0/C1 producers. Aggregate metadata
 * supports replay and projection ordering without fabricating data for legacy messages.
 */
export interface KafkaEventEnvelopeV2<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> extends KafkaEventEnvelopeBase<TPayload> {
  schemaVersion: 2;
  eventKind: KafkaEventKind;
  aggregateType: string;
  aggregateId: string;
  /** Canonical aggregate events start at 1; ingress/command may use 0. */
  aggregateVersion: number;
}

/** V1 is still accepted while producers migrate to V2. */
export type KafkaEventEnvelope<TPayload extends Record<string, unknown> = Record<string, unknown>> =
  KafkaEventEnvelopeV1<TPayload> | KafkaEventEnvelopeV2<TPayload>;

export type NormalizedKafkaEventEnvelope<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> =
  | {
      format: 'V1_LEGACY';
      event: KafkaEventEnvelopeV1<TPayload>;
    }
  | {
      format: 'V2';
      event: KafkaEventEnvelopeV2<TPayload>;
    };

export type KafkaEventHeaders = Partial<
  Record<(typeof KAFKA_EVENT_HEADERS)[keyof typeof KAFKA_EVENT_HEADERS], string>
>;

export type KafkaContractErrorCode =
  | 'UNAPPROVED_TOPIC'
  | 'INVALID_JSON'
  | 'INVALID_ENVELOPE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'MISSING_HEADER'
  | 'HEADER_PAYLOAD_MISMATCH'
  | 'ORDERING_KEY_MISMATCH';

export class KafkaContractError extends Error {
  constructor(
    public readonly code: KafkaContractErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'KafkaContractError';
  }
}

/** The DLQ keeps a forensic record, not a Kafka envelope, so it must not enter a business consumer. */
const APPROVED_TOPICS = new Set<string>(
  Object.values(KAFKA_TOPICS).filter((topic) => topic !== KAFKA_TOPICS.DEAD_LETTER),
);

export function isKafkaTopic(topic: string): topic is KafkaTopic {
  return APPROVED_TOPICS.has(topic);
}

export function assertKafkaTopic(topic: string): asserts topic is KafkaTopic {
  if (!isKafkaTopic(topic)) {
    throw new KafkaContractError('UNAPPROVED_TOPIC', `Kafka topic not allowed: ${topic}`);
  }
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new KafkaContractError('INVALID_ENVELOPE', `${field} must be a non-empty string`);
  }
}

function requireNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new KafkaContractError('INVALID_ENVELOPE', `${field} must be a non-negative integer`);
  }
}

function requireKafkaEventKind(value: unknown): asserts value is KafkaEventKind {
  if (value !== 'CANONICAL' && value !== 'INGRESS' && value !== 'COMMAND') {
    throw new KafkaContractError(
      'INVALID_ENVELOPE',
      'eventKind must be CANONICAL, INGRESS or COMMAND',
    );
  }
}

export function isKafkaEventEnvelopeV2<TPayload extends Record<string, unknown>>(
  event: KafkaEventEnvelope<TPayload>,
): event is KafkaEventEnvelopeV2<TPayload> {
  return event.schemaVersion === 2;
}

export function validateEventEnvelope<TPayload extends Record<string, unknown>>(
  value: unknown,
): KafkaEventEnvelope<TPayload> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KafkaContractError('INVALID_ENVELOPE', 'event envelope must be an object');
  }

  const candidate = value as Partial<KafkaEventEnvelopeBase<TPayload>> & {
    schemaVersion?: unknown;
    eventKind?: unknown;
    aggregateType?: unknown;
    aggregateId?: unknown;
    aggregateVersion?: unknown;
  };
  requireNonEmptyString(candidate.eventId, 'eventId');
  requireNonEmptyString(candidate.type, 'type');
  requireNonEmptyString(candidate.tenantId, 'tenantId');
  requireNonEmptyString(candidate.occurredAt, 'occurredAt');
  requireNonEmptyString(candidate.correlationId, 'correlationId');
  requireNonEmptyString(candidate.orderingKey, 'orderingKey');

  if (Number.isNaN(Date.parse(candidate.occurredAt))) {
    throw new KafkaContractError('INVALID_ENVELOPE', 'occurredAt must be an ISO-8601 timestamp');
  }
  if (
    !candidate.payload ||
    typeof candidate.payload !== 'object' ||
    Array.isArray(candidate.payload)
  ) {
    throw new KafkaContractError('INVALID_ENVELOPE', 'payload must be an object');
  }
  if (candidate.causationId !== undefined) {
    requireNonEmptyString(candidate.causationId, 'causationId');
  }

  if (candidate.schemaVersion === undefined) {
    return candidate as KafkaEventEnvelopeV1<TPayload>;
  }
  if (candidate.schemaVersion !== 2) {
    throw new KafkaContractError(
      'UNSUPPORTED_SCHEMA_VERSION',
      `Unsupported Kafka envelope schemaVersion: ${String(candidate.schemaVersion)}`,
    );
  }

  requireNonEmptyString(candidate.aggregateType, 'aggregateType');
  requireNonEmptyString(candidate.aggregateId, 'aggregateId');
  requireKafkaEventKind(candidate.eventKind);
  requireNonNegativeInteger(candidate.aggregateVersion, 'aggregateVersion');
  if (candidate.eventKind === 'CANONICAL' && candidate.aggregateVersion < 1) {
    throw new KafkaContractError(
      'INVALID_ENVELOPE',
      'canonical aggregate event must have aggregateVersion of at least 1',
    );
  }
  return candidate as KafkaEventEnvelopeV2<TPayload>;
}

/**
 * Keeps the V1/V2 distinction for consumers that must do replay/projection. V1 is explicitly
 * legacy and does not accept aggregate metadata created during normalization.
 */
export function normalizeKafkaEventEnvelope<TPayload extends Record<string, unknown>>(
  event: KafkaEventEnvelope<TPayload>,
): NormalizedKafkaEventEnvelope<TPayload> {
  return isKafkaEventEnvelopeV2(event) ? { format: 'V2', event } : { format: 'V1_LEGACY', event };
}

function requiredHeader(headers: KafkaEventHeaders, name: keyof KafkaEventHeaders): string {
  const value = headers[name];
  if (!value) {
    throw new KafkaContractError('MISSING_HEADER', `Header ${name} not found`);
  }
  return value;
}

/** Validates the boundary before passing an event to the business handler */
export function validateConsumedEvent<TPayload extends Record<string, unknown>>(
  topic: string,
  key: string | null,
  headers: KafkaEventHeaders,
  value: unknown,
): KafkaEventEnvelope<TPayload> {
  assertKafkaTopic(topic);
  const event = validateEventEnvelope<TPayload>(value);
  const tenantId = requiredHeader(headers, KAFKA_EVENT_HEADERS.TENANT_ID);
  const eventId = requiredHeader(headers, KAFKA_EVENT_HEADERS.EVENT_ID);
  const correlationId = requiredHeader(headers, KAFKA_EVENT_HEADERS.CORRELATION_ID);
  const orderingKey = requiredHeader(headers, KAFKA_EVENT_HEADERS.ORDERING_KEY);

  if (
    tenantId !== event.tenantId ||
    eventId !== event.eventId ||
    correlationId !== event.correlationId
  ) {
    throw new KafkaContractError(
      'HEADER_PAYLOAD_MISMATCH',
      'tenantId, eventId or correlationId in the header does not match the payload',
    );
  }
  if (!key || key !== event.orderingKey || orderingKey !== event.orderingKey) {
    throw new KafkaContractError(
      'ORDERING_KEY_MISMATCH',
      'Kafka key, orderingKey header and orderingKey in the payload must match',
    );
  }

  if (isKafkaEventEnvelopeV2(event)) {
    const schemaVersion = requiredHeader(headers, KAFKA_EVENT_HEADERS.SCHEMA_VERSION);
    const aggregateId = requiredHeader(headers, KAFKA_EVENT_HEADERS.AGGREGATE_ID);
    if (schemaVersion !== String(event.schemaVersion) || aggregateId !== event.aggregateId) {
      throw new KafkaContractError(
        'HEADER_PAYLOAD_MISMATCH',
        'schemaVersion or aggregateId in the header does not match the payload',
      );
    }
  }

  return event;
}
