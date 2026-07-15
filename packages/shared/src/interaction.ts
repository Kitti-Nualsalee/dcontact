/**
 * Unified Interaction Model — หัวใจของ omnichannel
 * ทุก channel (call, chat, social, email) map เป็น Interaction เดียวกัน
 * และวิ่งผ่าน router ตัวเดียวกัน (ดู docs/adr/001)
 */

export type Channel = 'voice' | 'webchat' | 'line' | 'facebook' | 'whatsapp' | 'email';

export type Direction = 'inbound' | 'outbound';

export type InteractionState =
  | 'queued' // เข้า queue รอ agent
  | 'assigned' // router จองให้ agent แล้ว (ringing)
  | 'active' // agent กำลังคุย
  | 'wrapup' // จบแล้ว agent กำลังทำ after-call work
  | 'completed'
  | 'abandoned'; // ลูกค้าวางสาย/ออกก่อนเจอ agent

export type AgentState =
  | 'offline'
  | 'available'
  | 'reserved' // ถูกจองโดย router (มีงาน ringing)
  | 'busy'
  | 'acw' // after-call work
  | 'break';

export interface InteractionSummary {
  id: string;
  tenantId: string;
  channel: Channel;
  direction: Direction;
  state: InteractionState;
  queueId: string | null;
  agentId: string | null;
  contactId: string | null;
  /** id ฝั่งระบบภายนอก เช่น FreeSWITCH call UUID, LINE message id */
  externalId: string | null;
  queuedAt: string;
  assignedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
}
