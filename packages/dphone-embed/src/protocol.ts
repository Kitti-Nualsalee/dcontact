/**
 * E1.14 (#488): postMessage API v1 between the embedded dphone (iframe) and the host (E1.6 #462, E1.7 #463)
 *
 * Rules of v1 (must not change within the same major):
 * - every message has `v: 1` and `type`; a request from the host has a `requestId` that dphone sends back in the reply
 * - additive only: types/fields may be added, never removed, never change meaning, never turn an optional field into a required one
 * - the receiving side ignores unknown types/fields; an unsupported `v` gets `dphone.error` with code `unsupported_version`
 * - no token, audio file/audio file URL, transcript or free-text note in any message
 *
 * The companion JSON Schema is at `schema/v1.json` — the contract test checks that it matches the types in this file
 */

export const DPHONE_EMBED_PROTOCOL_VERSION = 1;

/** screen-pop data level set per origin (default `off`) */
export type ScreenPopSetting = 'off' | 'ids' | 'contact' | 'custom';
/** level actually sent after the server lowers it (`interaction` = only interactionId remains) */
export type ScreenPopLevel = 'interaction' | 'ids' | 'contact' | 'custom';

export type CallDirection = 'INBOUND' | 'OUTBOUND';

export interface DphoneCapabilities {
  screenPop: boolean;
  clickToCall: boolean;
  activity: boolean;
}

// ---------- dphone → host ----------

export interface DphoneReadyMessage {
  v: 1;
  type: 'dphone.ready';
  capabilities: DphoneCapabilities;
  screenPopLevel: ScreenPopSetting;
}

export interface ScreenPopMessage {
  v: 1;
  type: 'dphone.screenpop';
  requestId: string;
  level: ScreenPopLevel;
  interactionId: string;
  /** present when the level was lowered, e.g. `TEAM_SEGMENT_NOT_ALLOWED`, `CONTACT_RESTRICTED` */
  reasonCode?: string;
  policyVersion: string;
  decisionId: string;
  // level ids and above
  contactId?: string;
  externalId?: string;
  direction?: CallDirection;
  queue?: { id: string; name: string };
  callState?: 'RINGING' | 'ACTIVE' | 'HELD' | 'ENDED';
  // level contact and above
  ani?: string;
  dnis?: string;
  displayName?: string;
  // level custom
  fields?: Record<string, string>;
}

export type CallResultStatus =
  | 'prefilled' // number entered in dphone, waiting for the agent to press call
  | 'dialing' // the agent pressed call and Contact Governance passed
  | 'blocked' // BLOCK / DEFER / REVIEW — no outbound call
  | 'cancelled' // the agent cancelled
  | 'rate_limited'
  | 'unavailable'; // dphone is not ready (not logged in, a call is in progress, click-to-call is off, etc.)

export interface CallResultMessage {
  v: 1;
  type: 'dphone.call.result';
  requestId: string;
  status: CallResultStatus;
  blocked: boolean;
  /** no PII — e.g. `CONSENT_MISSING`, `QUIET_HOURS`, `REVIEW_REQUIRED` */
  reasonCode?: string;
  /** DEFER: time the call may be made (ISO 8601) */
  retryAt?: string;
  decisionId?: string;
}

export interface ActivityMessage {
  v: 1;
  type: 'dphone.activity';
  requestId: string;
  /** idempotency key — the host must not record again when it gets the same interactionId */
  interactionId: string;
  contactId?: string;
  direction: CallDirection;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  disposition?: string;
  wrapUpCode?: string;
  queue?: { id: string; name: string };
}

export type DphoneErrorCode = 'unsupported_version' | 'invalid_message';

export interface DphoneErrorMessage {
  v: 1;
  type: 'dphone.error';
  requestId?: string;
  code: DphoneErrorCode;
  supportedVersions: number[];
}

export type DphoneToHostMessage =
  DphoneReadyMessage | ScreenPopMessage | CallResultMessage | ActivityMessage | DphoneErrorMessage;

// ---------- host → dphone ----------

export interface CallRequestMessage {
  v: 1;
  type: 'dphone.call';
  requestId: string;
  number: string;
  contactId?: string;
}

export interface ActivityAckMessage {
  v: 1;
  type: 'dphone.activity.ack';
  interactionId: string;
  requestId?: string;
}

export type HostToDphoneMessage = CallRequestMessage | ActivityAckMessage;

export type ParsedHostMessage =
  | { kind: 'message'; message: HostToDphoneMessage }
  /** answer with `dphone.error` (unsupported_version / invalid_message) */
  | { kind: 'error'; code: DphoneErrorCode; requestId?: string }
  /** unknown type or not a dphone message — ignore, do not reply */
  | { kind: 'ignore' };

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** number the host fills in — digits, leading `+` and common separators (dphone normalizes further itself) */
const DIAL_NUMBER = /^\+?[0-9][0-9 ()-]{1,30}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * validate a message from the host (after the origin/source check has passed) — does not throw
 * a message without a `type` starting with `dphone.` is treated as not ours (the host may have other postMessage traffic)
 */
export function parseHostMessage(data: unknown): ParsedHostMessage {
  if (!isRecord(data) || typeof data.type !== 'string' || !data.type.startsWith('dphone.')) {
    return { kind: 'ignore' };
  }
  const requestId =
    typeof data.requestId === 'string' && REQUEST_ID.test(data.requestId)
      ? data.requestId
      : undefined;
  if (data.v !== DPHONE_EMBED_PROTOCOL_VERSION) {
    return { kind: 'error', code: 'unsupported_version', requestId };
  }
  const invalid = { kind: 'error', code: 'invalid_message', requestId } as const;
  switch (data.type) {
    case 'dphone.call': {
      if (!requestId || typeof data.number !== 'string' || !DIAL_NUMBER.test(data.number)) {
        return invalid;
      }
      if (
        data.contactId !== undefined &&
        (typeof data.contactId !== 'string' || !ID.test(data.contactId))
      ) {
        return invalid;
      }
      const message: CallRequestMessage = {
        v: 1,
        type: 'dphone.call',
        requestId,
        number: data.number,
      };
      if (typeof data.contactId === 'string') message.contactId = data.contactId;
      return { kind: 'message', message };
    }
    case 'dphone.activity.ack': {
      if (typeof data.interactionId !== 'string' || !ID.test(data.interactionId)) return invalid;
      const message: ActivityAckMessage = {
        v: 1,
        type: 'dphone.activity.ack',
        interactionId: data.interactionId,
      };
      if (requestId) message.requestId = requestId;
      return { kind: 'message', message };
    }
    default:
      return { kind: 'ignore' };
  }
}
