import {
  CG4_CONTRACT_VERSION,
  CG4_EVALUATOR_VERSION,
  CG4_EVENT_TYPES,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  type Cg4CanonicalChangePayloadV1,
} from '@d-contact/cxa-contracts';

/**
 * CG4.6 (#189): the guard every canonical CG4 event passes on the way out of the outbox
 * and on the way into an inbox. It is the boundary where an unknown contract, schema,
 * registry or evaluator version becomes a DLQ decision instead of a silently-applied
 * projection (#179 §4), and where a payload that leaked a restricted field is stopped
 * before it reaches a broker (#179 §7).
 */

export type Cg4EventType = (typeof CG4_EVENT_TYPES)[keyof typeof CG4_EVENT_TYPES];

const EVENT_TYPES = new Set<string>(Object.values(CG4_EVENT_TYPES));

export type Cg4EnvelopeRejection =
  | 'MALFORMED_PAYLOAD'
  | 'UNSUPPORTED_EVENT_TYPE'
  | 'UNSUPPORTED_CONTRACT_VERSION'
  | 'UNSUPPORTED_POLICY_SCHEMA_VERSION'
  | 'UNSUPPORTED_RULE_REGISTRY_VERSION'
  | 'UNSUPPORTED_EVALUATOR_VERSION'
  | 'RESTRICTED_FIELD_PRESENT';

export type Cg4EnvelopeParse =
  | { ok: true; eventType: Cg4EventType; payload: Cg4CanonicalChangePayloadV1 }
  | { ok: false; reason: Cg4EnvelopeRejection; detail: string };

/**
 * Keys that must never appear in a canonical payload. Opaque UUIDs and reason codes are
 * fine — #179 §7 bars actor identity, ticket/evidence bodies and raw contact identity.
 * This is a regression guard on our own producers, not an exhaustive PII detector.
 */
const RESTRICTED_KEYS = new Set([
  'actorref',
  'actorclass',
  'approverref',
  'makeractorref',
  'checkeractorref',
  'ticketref',
  'evidenceref',
  'clearapprovalref',
  'identityvalue',
  'email',
  'phone',
  'phonenumber',
  'displayname',
  'contactname',
  'fullname',
]);

function findRestrictedKey(value: unknown, path = 'payload'): string | undefined {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = findRestrictedKey(entry, `${path}[${index}]`);
      if (found) return found;
    }
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (RESTRICTED_KEYS.has(key.toLowerCase())) return `${path}.${key}`;
    const found = findRestrictedKey(entry, `${path}.${key}`);
    if (found) return found;
  }
  return undefined;
}

function reject(reason: Cg4EnvelopeRejection, detail: string): Cg4EnvelopeParse {
  return { ok: false, reason, detail };
}

export interface ParseCg4CanonicalEventInput {
  eventType: string;
  payload: unknown;
}

export function parseCg4CanonicalEvent(input: ParseCg4CanonicalEventInput): Cg4EnvelopeParse {
  if (!EVENT_TYPES.has(input.eventType)) {
    return reject('UNSUPPORTED_EVENT_TYPE', `event type ${input.eventType} ไม่ใช่ canonical CG4`);
  }
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) {
    return reject('MALFORMED_PAYLOAD', 'payload ต้องเป็น object');
  }
  const payload = input.payload as Record<string, unknown>;

  for (const [field, expected] of [
    ['subjectId', 'string'],
    ['mutationId', 'string'],
    ['transitionKind', 'string'],
    ['state', 'string'],
    ['effectiveAt', 'string'],
    ['scopeDigest', 'string'],
    ['stateDigest', 'string'],
    ['restrictiveness', 'string'],
  ] as const) {
    if (typeof payload[field] !== expected) {
      return reject('MALFORMED_PAYLOAD', `payload.${field} ต้องเป็น ${expected}`);
    }
  }
  if (!Number.isInteger(payload.subjectVersion)) {
    return reject('MALFORMED_PAYLOAD', 'payload.subjectVersion ต้องเป็น integer');
  }
  if (!payload.affectedScope || typeof payload.affectedScope !== 'object') {
    return reject('MALFORMED_PAYLOAD', 'payload.affectedScope ต้องเป็น object');
  }
  if (!['TIGHTENING', 'NEUTRAL', 'RELAXATION'].includes(payload.restrictiveness as string)) {
    return reject('MALFORMED_PAYLOAD', 'payload.restrictiveness ไม่ใช่ค่าที่รู้จัก');
  }

  if (payload.contractVersion !== CG4_CONTRACT_VERSION) {
    return reject(
      'UNSUPPORTED_CONTRACT_VERSION',
      `contractVersion ${String(payload.contractVersion)} ไม่รองรับ`,
    );
  }
  if (payload.policySchemaVersion !== CG4_POLICY_SCHEMA_VERSION) {
    return reject(
      'UNSUPPORTED_POLICY_SCHEMA_VERSION',
      `policySchemaVersion ${String(payload.policySchemaVersion)} ไม่รองรับ`,
    );
  }
  if (payload.ruleRegistryVersion !== CG4_RULE_REGISTRY_VERSION) {
    return reject(
      'UNSUPPORTED_RULE_REGISTRY_VERSION',
      `ruleRegistryVersion ${String(payload.ruleRegistryVersion)} ไม่รองรับ`,
    );
  }
  if (payload.evaluatorVersion !== CG4_EVALUATOR_VERSION) {
    return reject(
      'UNSUPPORTED_EVALUATOR_VERSION',
      `evaluatorVersion ${String(payload.evaluatorVersion)} ไม่รองรับ`,
    );
  }

  const restricted = findRestrictedKey(payload);
  if (restricted) {
    return reject('RESTRICTED_FIELD_PRESENT', `${restricted} เป็น field ที่ห้ามอยู่ใน payload`);
  }

  return {
    ok: true,
    eventType: input.eventType as Cg4EventType,
    payload: payload as unknown as Cg4CanonicalChangePayloadV1,
  };
}

/** A rejection the producer side must never publish, versus one a consumer may still DLQ. */
export function isCg4ProducerSideRejection(reason: Cg4EnvelopeRejection): boolean {
  return reason === 'MALFORMED_PAYLOAD' || reason === 'RESTRICTED_FIELD_PRESENT';
}
