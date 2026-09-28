/**
 * E1.14 (#488): ระดับข้อมูลของ screen-pop (E1.6 #462 ข้อ 1–2)
 *
 * - `effectiveScreenPopLevel()` ลดระดับตามผล disclosure check ของ Contact Governance:
 *   ทีมไม่มี scope `VIEW` บน segment → `interaction`; contact มี restriction/objection → ไม่เกิน `ids`
 * - `projectScreenPop()` สร้าง payload แบบ allowlist ต่อระดับ — field ที่ไม่อยู่ในระดับจะไม่ถูกคัดลอกเลย
 *   (ไม่ใช่ลบทีหลัง) จึงไม่มีทางมี field เกินระดับแม้ source มีข้อมูลเพิ่ม
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
  /** ทีมของ agent มี scope `VIEW` บน segment ของ contact (contact ที่ยังระบุไม่ได้ = true) */
  teamSegmentView: boolean;
  /** restriction of processing หรือ objection ต่อการเปิดเผย */
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
  /** ค่าของ field ที่ระบบกำหนดสำหรับระดับ custom */
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
   * field ของระดับ custom ที่ origin เลือกไว้ — ผู้เรียก (server) ต้องกรองกับรายการที่ระบบกำหนดก่อน
   * ที่นี่คัดลอกเฉพาะชื่อที่อยู่ในรายการนี้เท่านั้น
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
