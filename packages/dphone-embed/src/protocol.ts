/**
 * E1.14 (#488): postMessage API v1 ระหว่าง dphone ที่ถูกฝัง (iframe) กับ host (E1.6 #462, E1.7 #463)
 *
 * กติกาของ v1 (ห้ามเปลี่ยนภายใน major เดียวกัน):
 * - ทุกข้อความมี `v: 1` และ `type`; คำขอจาก host มี `requestId` ที่ dphone ส่งกลับในคำตอบ
 * - เพิ่มได้อย่างเดียว: เพิ่ม type/field ได้ ห้ามลบ ห้ามเปลี่ยนความหมาย ห้ามเปลี่ยน field ไม่บังคับให้บังคับ
 * - ฝั่งรับไม่สนใจ type/field ที่ไม่รู้จัก; `v` ที่ไม่รองรับได้ `dphone.error` code `unsupported_version`
 * - ไม่มี token, ไฟล์เสียง/URL ของไฟล์เสียง, transcript หรือโน้ตแบบข้อความอิสระในข้อความใดเลย
 *
 * JSON Schema คู่กันอยู่ที่ `schema/v1.json` — contract test ตรวจว่าตรงกับ type ในไฟล์นี้
 */

export const DPHONE_EMBED_PROTOCOL_VERSION = 1;

/** ระดับข้อมูล screen-pop ที่ตั้งต่อ origin (ค่าเริ่มต้น `off`) */
export type ScreenPopSetting = 'off' | 'ids' | 'contact' | 'custom';
/** ระดับที่ส่งจริงหลัง server ลดระดับ (`interaction` = เหลือเฉพาะ interactionId) */
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
  /** มีเมื่อ level ถูกลดลง เช่น `TEAM_SEGMENT_NOT_ALLOWED`, `CONTACT_RESTRICTED` */
  reasonCode?: string;
  policyVersion: string;
  decisionId: string;
  // ระดับ ids ขึ้นไป
  contactId?: string;
  externalId?: string;
  direction?: CallDirection;
  queue?: { id: string; name: string };
  callState?: 'RINGING' | 'ACTIVE' | 'HELD' | 'ENDED';
  // ระดับ contact ขึ้นไป
  ani?: string;
  dnis?: string;
  displayName?: string;
  // ระดับ custom
  fields?: Record<string, string>;
}

export type CallResultStatus =
  | 'prefilled' // กรอกเบอร์ใน dphone แล้ว รอ agent กดโทร
  | 'dialing' // agent กดโทรและผ่าน Contact Governance แล้ว
  | 'blocked' // BLOCK / DEFER / REVIEW — ไม่โทรออก
  | 'cancelled' // agent ยกเลิก
  | 'rate_limited'
  | 'unavailable'; // dphone ไม่พร้อม (ยังไม่ login, มีสายอยู่, click-to-call ปิด ฯลฯ)

export interface CallResultMessage {
  v: 1;
  type: 'dphone.call.result';
  requestId: string;
  status: CallResultStatus;
  blocked: boolean;
  /** ไม่มี PII — เช่น `CONSENT_MISSING`, `QUIET_HOURS`, `REVIEW_REQUIRED` */
  reasonCode?: string;
  /** DEFER: เวลาที่โทรได้ (ISO 8601) */
  retryAt?: string;
  decisionId?: string;
}

export interface ActivityMessage {
  v: 1;
  type: 'dphone.activity';
  requestId: string;
  /** idempotency key — host ต้องไม่บันทึกซ้ำเมื่อได้ interactionId เดิม */
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
  /** ตอบ `dphone.error` (unsupported_version / invalid_message) */
  | { kind: 'error'; code: DphoneErrorCode; requestId?: string }
  /** type ที่ไม่รู้จักหรือไม่ใช่ข้อความของ dphone — ไม่สนใจ ไม่ตอบ */
  | { kind: 'ignore' };

const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/;
/** เบอร์ที่ host กรอกให้ — ตัวเลข, `+` นำหน้า และตัวคั่นทั่วไป (dphone normalize ต่อเอง) */
const DIAL_NUMBER = /^\+?[0-9][0-9 ()-]{1,30}$/;
const ID = /^[A-Za-z0-9._:-]{1,128}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * ตรวจข้อความจาก host (หลังผ่านการตรวจ origin/source แล้ว) — ไม่ throw
 * ข้อความที่ไม่มี `type` ขึ้นต้นด้วย `dphone.` ถือว่าไม่ใช่ของเรา (host อาจมี postMessage อื่น)
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
