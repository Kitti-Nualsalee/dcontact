/**
 * E1.14 (#488): screen-pop data levels (E1.6 #462 items 1–2)
 *
 * - `effectiveScreenPopLevel()` lowers the level per the Contact Governance disclosure check result:
 *   team has no `VIEW` scope on the segment → `interaction`; contact has restriction/objection → at most `ids`
 * - `projectScreenPop()` builds the payload as a per-level allowlist — fields outside the level are never copied at all
 *   (not removed afterwards), so there is no way to exceed the level even if the source has extra data
 */
import type {
  CallDirection,
  ScreenPopLevel,
  ScreenPopMessage,
  ScreenPopSetting,
} from './protocol.js';

export const SCREEN_POP_REASON = {
  TEAM_SEGMENT_NOT_ALLOWED: 'TEAM_SEGMENT_NOT_ALLOWED',
  CONTACT_RESTRICTED: 'CONTACT_RESTRICTED',
} as const;

export interface DisclosureDecision {
  /** the agent's team has `VIEW` scope on the contact's segment (an unidentified contact = true) */
  teamSegmentView: boolean;
  /** restriction of processing or objection to disclosure */
  restricted: boolean;
  policyVersion: string;
  decisionId: string;
}

const RANK: Record<ScreenPopLevel, number> = { interaction: 0, ids: 1, contact: 2, custom: 3 };

export function effectiveScreenPopLevel(
  setting: ScreenPopSetting,
  decision: Pick<DisclosureDecision, 'teamSegmentView' | 'restricted'>,
): { level: ScreenPopLevel; reasonCode?: string } | null {
  if (setting === 'off') return null;
  if (!decision.teamSegmentView) {
    return { level: 'interaction', reasonCode: SCREEN_POP_REASON.TEAM_SEGMENT_NOT_ALLOWED };
  }
  if (decision.restricted && RANK[setting] > RANK.ids) {
    return { level: 'ids', reasonCode: SCREEN_POP_REASON.CONTACT_RESTRICTED };
  }
  return { level: setting };
}

export interface ScreenPopSource {
  interactionId: string;
  contactId?: string | null;
  externalId?: string | null;
  direction: CallDirection;
  queue?: { id: string; name: string } | null;
  callState: NonNullable<ScreenPopMessage['callState']>;
  ani?: string | null;
  dnis?: string | null;
  displayName?: string | null;
  /** values of the fields the system defines for level custom */
  customFields?: Record<string, string | null | undefined>;
}

const present = (value: string | null | undefined): value is string =>
  typeof value === 'string' && value.length > 0;

export function projectScreenPop(input: {
  requestId: string;
  source: ScreenPopSource;
  level: ScreenPopLevel;
  reasonCode?: string;
  decision: Pick<DisclosureDecision, 'policyVersion' | 'decisionId'>;
  /**
   * fields of level custom that the origin chose — the caller (server) must filter against the system-defined list first
   * here only names present in that list are copied
   */
  customFields?: readonly string[];
}): ScreenPopMessage {
  const { source, level } = input;
  const message: ScreenPopMessage = {
    v: 1,
    type: 'dphone.screenpop',
    requestId: input.requestId,
    level,
    interactionId: source.interactionId,
    policyVersion: input.decision.policyVersion,
    decisionId: input.decision.decisionId,
  };
  if (input.reasonCode) message.reasonCode = input.reasonCode;
  if (RANK[level] >= RANK.ids) {
    if (present(source.contactId)) message.contactId = source.contactId;
    if (present(source.externalId)) message.externalId = source.externalId;
    message.direction = source.direction;
    if (source.queue) message.queue = { id: source.queue.id, name: source.queue.name };
    message.callState = source.callState;
  }
  if (RANK[level] >= RANK.contact) {
    if (present(source.ani)) message.ani = source.ani;
    if (present(source.dnis)) message.dnis = source.dnis;
    if (present(source.displayName)) message.displayName = source.displayName;
  }
  if (level === 'custom') {
    const fields: Record<string, string> = {};
    for (const name of input.customFields ?? []) {
      if (!Object.hasOwn(source.customFields ?? {}, name)) continue;
      const value = source.customFields?.[name];
      if (present(value)) fields[name] = value;
    }
    message.fields = fields;
  }
  return message;
}
