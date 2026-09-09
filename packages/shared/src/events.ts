import type { AgentState, Channel, InteractionState } from './interaction';

/**
 * Event contracts บน Kafka — ทุก service คุยกันผ่าน events เหล่านี้ (ดู ADR-003)
 * telephony/channels ผลิต → router ตัดสินใจ → api กระจายไป UI ผ่าน WebSocket
 * ทุก message มี tenantId ทั้งใน header และ payload; Redis เหลือบทบาท state store เท่านั้น
 */

export const KAFKA_TOPICS = {
  /**
   * raw events จาก media server ทุก vendor — FreeSWITCH หรือ Asterisk (telephony produce, key = callUuid)
   * ชื่อเดิม `dc.fs.events` ถูกเลิกใช้ตาม ADR-023 ข้อ 6 เพราะผูกกับ vendor เดียว
   */
  TELEPHONY_EVENTS: 'dc.telephony.events',
  /** ข้อความ/เหตุการณ์ขาเข้าจากช่องทาง digital (channels produce, key = conversationId) */
  CHANNEL_EVENTS: 'dc.channel.events',
  /** interaction lifecycle events ทุก channel (key = interactionId) — source of truth ของ metering/billing */
  INTERACTION_EVENTS: 'dc.interaction.events',
  /** agent state changes (key = agentId) */
  AGENT_EVENTS: 'dc.agent.events',
  /** call control commands router → telephony (key = callUuid) — ใช้จริง Phase 1 */
  TELEPHONY_COMMANDS: 'dc.telephony.commands',
  /** ส่งข้อความออกช่องทาง digital: router → channels (key = conversationId) */
  CHANNEL_COMMANDS: 'dc.channel.commands',
  /** งานถอดเสียง/วิเคราะห์แบบ asynchronous ของ QM (key = jobId) */
  QM_JOBS: 'dc.qm.jobs',
  /** ผลลัพธ์ QM สำหรับ API/WebSocket fan-out (key = tenantId) */
  QM_EVENTS: 'dc.qm.events',
  /**
   * เหตุการณ์จากระบบธุรกิจของลูกค้า → journey engine (key = contactRef)
   * เข้าทาง `POST /api/v1/events` แล้วถูก dedupe ด้วย (tenantId, source, eventId) ก่อนวางลง topic
   * ดู ADR-025 (CX automation)
   */
  JOURNEY_EVENTS: 'dc.journey.events',
  /** quarantine สำหรับ Kafka contract ที่ตรวจไม่ผ่าน; access/retention แยกจาก topic ธุรกิจ */
  DEAD_LETTER: 'dc.platform.dlq',
} as const;

export type KafkaTopic = (typeof KAFKA_TOPICS)[keyof typeof KAFKA_TOPICS];

export interface BaseEvent {
  eventId: string;
  tenantId: string;
  occurredAt: string; // ISO-8601
}

export interface InteractionEvent extends BaseEvent {
  type:
    | 'interaction.created'
    | 'interaction.queued'
    | 'interaction.assigned'
    | 'interaction.answered'
    | 'interaction.offer_declined'
    | 'interaction.offer_timed_out'
    | 'interaction.ended'
    | 'interaction.abandoned'
    | 'interaction.wrapup_completed';
  interactionId: string;
  channel: Channel;
  state: InteractionState;
  queueId?: string;
  agentId?: string;
  payload?: Record<string, unknown>;
}

export interface AgentEvent extends BaseEvent {
  type: 'agent.state_changed';
  agentId: string;
  state: AgentState;
  previousState: AgentState;
  reason?: string;
}

/**
 * เหตุการณ์จากระบบธุรกิจของลูกค้า — ทางเข้าหลักของ CX automation (ADR-025)
 *
 * กติกาที่ทำให้ API retry ไม่ทำให้ลูกค้าถูกดึงเข้า journey ซ้ำ:
 *   unique (tenantId, source, eventId) ที่ event inbox — ยิงซ้ำได้ไม่จำกัด ผลลัพธ์เท่าเดิม
 * `eventId` ต้องมาจาก **ระบบผู้ส่ง** และคงที่ทุกครั้งที่ retry เหตุการณ์เดียวกัน
 * (วินัยเดียวกับ providerMessageId / clientToken ใน ADR-024)
 */
export interface InboundBusinessEvent {
  /** ระบบต้นทาง เช่น 'billing' | 'wms' | 'crm' — ทำให้ eventId ไม่ชนกันข้ามระบบ */
  source: string;
  /** id ของเหตุการณ์ฝั่งผู้ส่ง — คงที่เมื่อ retry */
  eventId: string;
  /** ชนิดเหตุการณ์ เช่น 'payment.failed' */
  type: string;
  /** เวลาที่เหตุการณ์เกิดจริง (ไม่ใช่เวลาที่เรารับ) */
  occurredAt: string; // ISO-8601
  /** เวอร์ชันของ payload — ผู้ส่งเปลี่ยนโครงได้โดยไม่ทำให้ของเก่าพัง */
  schemaVersion: number;
  /** ชี้ลูกค้าด้วย identity ใดก็ได้ที่ระบบเรารู้จัก (ADR-020) */
  contactRef: { kind: 'PHONE' | 'EMAIL' | 'LINE' | 'CRM_ID'; value: string };
  payload: Record<string, unknown>;
}

export type DContactEvent = InteractionEvent | AgentEvent;
