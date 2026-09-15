import type { Cg4EnvelopeParse, Cg4EnvelopeRejection } from './cg4-event-envelope.js';

/**
 * CG4.6 (#189): the pure inbox decision from #179 §4. Kept free of I/O so every branch —
 * duplicate, gap, out-of-order, hash conflict, unsupported contract — is testable without
 * a broker, because these are the branches that decide whether a scope keeps serving.
 *
 * The cursor is what the consumer has already applied for one aggregate. An event that is
 * merely redelivered is caught earlier, by `eventId`, so anything reaching here with a
 * version at or below the cursor is a real ordering anomaly rather than routine
 * at-least-once noise — which is why it pauses the scope instead of being ignored.
 */

export interface Cg4InboxCursor {
  aggregateVersion: number;
  payloadHash: string;
}

export interface Cg4IncomingEvent {
  aggregateVersion: number;
  payloadHash: string;
}

export type Cg4InboxDecision =
  /** Contiguous next version: apply it and advance the cursor. */
  | { kind: 'APPLY' }
  /** Same version, same digest: already applied, nothing to do. */
  | { kind: 'DUPLICATE' }
  /** Same version, different digest: two different truths for one version. */
  | { kind: 'QUARANTINE'; detail: string }
  /** A version is missing: the projection would be built on a hole. */
  | { kind: 'GAP'; expectedVersion: number; receivedVersion: number }
  /** A version older than what is already applied arrived as a new event. */
  | { kind: 'OUT_OF_ORDER'; appliedVersion: number; receivedVersion: number }
  /** The payload is not something this build can interpret. */
  | { kind: 'UNSUPPORTED'; reason: Cg4EnvelopeRejection; detail: string };

/** Every decision except APPLY and DUPLICATE holds the scope until a canonical reload. */
export function cg4InboxDecisionPausesScope(decision: Cg4InboxDecision): boolean {
  return decision.kind !== 'APPLY' && decision.kind !== 'DUPLICATE';
}

export interface ClassifyCg4InboundEventInput {
  /** Undefined when this consumer group has never applied an event for the aggregate. */
  cursor?: Cg4InboxCursor;
  incoming: Cg4IncomingEvent;
  parse: Cg4EnvelopeParse;
}

export function classifyCg4InboundEvent(input: ClassifyCg4InboundEventInput): Cg4InboxDecision {
  if (!input.parse.ok) {
    return { kind: 'UNSUPPORTED', reason: input.parse.reason, detail: input.parse.detail };
  }

  const { cursor, incoming } = input;
  if (!cursor) {
    // Joining an aggregate's stream anywhere but its first event means earlier versions
    // were never applied. Reloading canonical state is the only safe way in.
    return incoming.aggregateVersion === 1
      ? { kind: 'APPLY' }
      : { kind: 'GAP', expectedVersion: 1, receivedVersion: incoming.aggregateVersion };
  }

  if (incoming.aggregateVersion === cursor.aggregateVersion) {
    return incoming.payloadHash === cursor.payloadHash
      ? { kind: 'DUPLICATE' }
      : {
          kind: 'QUARANTINE',
          detail: `version ${incoming.aggregateVersion} มีสอง payload hash ที่ต่างกัน`,
        };
  }
  if (incoming.aggregateVersion === cursor.aggregateVersion + 1) return { kind: 'APPLY' };
  if (incoming.aggregateVersion > cursor.aggregateVersion) {
    return {
      kind: 'GAP',
      expectedVersion: cursor.aggregateVersion + 1,
      receivedVersion: incoming.aggregateVersion,
    };
  }
  return {
    kind: 'OUT_OF_ORDER',
    appliedVersion: cursor.aggregateVersion,
    receivedVersion: incoming.aggregateVersion,
  };
}

export type Cg4ScopePauseReason =
  'EVENT_GAP' | 'EVENT_OUT_OF_ORDER' | 'HASH_CONFLICT' | 'UNSUPPORTED_CONTRACT';

export function cg4PauseReasonFor(decision: Cg4InboxDecision): Cg4ScopePauseReason | undefined {
  switch (decision.kind) {
    case 'GAP':
      return 'EVENT_GAP';
    case 'OUT_OF_ORDER':
      return 'EVENT_OUT_OF_ORDER';
    case 'QUARANTINE':
      return 'HASH_CONFLICT';
    case 'UNSUPPORTED':
      return 'UNSUPPORTED_CONTRACT';
    default:
      return undefined;
  }
}
