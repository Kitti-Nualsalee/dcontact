import { KAFKA_TOPICS, type KafkaTopic } from '@d-contact/shared';

export const KAFKA_EVENT_HEADERS = {
  TENANT_ID: 'tenantId',
  EVENT_ID: 'eventId',
  CORRELATION_ID: 'correlationId',
  ORDERING_KEY: 'orderingKey',
} as const;

export interface KafkaEventEnvelope<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
> {
  /** ID คงที่ของเหตุการณ์เดิม แม้ producer จะ retry */
  eventId: string;
  type: string;
  tenantId: string;
  occurredAt: string;
  /** ใช้เชื่อม log/event ข้าม service ตลอดหนึ่ง request หรือ workflow */
  correlationId: string;
  /** Kafka partition key; เหตุการณ์ของ entity เดียวกันต้องใช้ค่าเดิม */
  orderingKey: string;
  causationId?: string;
  payload: TPayload;
}

export type KafkaEventHeaders = Partial<
  Record<(typeof KAFKA_EVENT_HEADERS)[keyof typeof KAFKA_EVENT_HEADERS], string>
>;

export type KafkaContractErrorCode =
  | 'UNAPPROVED_TOPIC'
  | 'INVALID_JSON'
  | 'INVALID_ENVELOPE'
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

const APPROVED_TOPICS = new Set<string>(Object.values(KAFKA_TOPICS));

export function isKafkaTopic(topic: string): topic is KafkaTopic {
  return APPROVED_TOPICS.has(topic);
}

export function assertKafkaTopic(topic: string): asserts topic is KafkaTopic {
  if (!isKafkaTopic(topic)) {
    throw new KafkaContractError('UNAPPROVED_TOPIC', `ไม่อนุญาต Kafka topic: ${topic}`);
  }
}

function requireNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new KafkaContractError('INVALID_ENVELOPE', `${field} ต้องเป็น string ที่ไม่ว่าง`);
  }
}

export function validateEventEnvelope<TPayload extends Record<string, unknown>>(
  value: unknown,
): KafkaEventEnvelope<TPayload> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new KafkaContractError('INVALID_ENVELOPE', 'event envelope ต้องเป็น object');
  }

  const candidate = value as Partial<KafkaEventEnvelope<TPayload>>;
  requireNonEmptyString(candidate.eventId, 'eventId');
  requireNonEmptyString(candidate.type, 'type');
  requireNonEmptyString(candidate.tenantId, 'tenantId');
  requireNonEmptyString(candidate.occurredAt, 'occurredAt');
  requireNonEmptyString(candidate.correlationId, 'correlationId');
  requireNonEmptyString(candidate.orderingKey, 'orderingKey');

  if (Number.isNaN(Date.parse(candidate.occurredAt))) {
    throw new KafkaContractError('INVALID_ENVELOPE', 'occurredAt ต้องเป็น ISO-8601 timestamp');
  }
  if (
    !candidate.payload ||
    typeof candidate.payload !== 'object' ||
    Array.isArray(candidate.payload)
  ) {
    throw new KafkaContractError('INVALID_ENVELOPE', 'payload ต้องเป็น object');
  }
  if (candidate.causationId !== undefined) {
    requireNonEmptyString(candidate.causationId, 'causationId');
  }

  return candidate as KafkaEventEnvelope<TPayload>;
}

function requiredHeader(headers: KafkaEventHeaders, name: keyof KafkaEventHeaders): string {
  const value = headers[name];
  if (!value) {
    throw new KafkaContractError('MISSING_HEADER', `ไม่พบ header ${name}`);
  }
  return value;
}

/** ตรวจ boundary ก่อนส่ง event ให้ business handler */
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
      'tenantId, eventId หรือ correlationId ใน header ไม่ตรงกับ payload',
    );
  }
  if (!key || key !== event.orderingKey || orderingKey !== event.orderingKey) {
    throw new KafkaContractError(
      'ORDERING_KEY_MISMATCH',
      'Kafka key, orderingKey header และ orderingKey ใน payload ต้องตรงกัน',
    );
  }

  return event;
}
