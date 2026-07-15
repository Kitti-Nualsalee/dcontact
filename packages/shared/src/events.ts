import type { AgentState, Channel, InteractionState } from './interaction';

/**
 * Event contracts บน Kafka — ทุก service คุยกันผ่าน events เหล่านี้ (ดู ADR-003)
 * telephony/channels ผลิต → router ตัดสินใจ → api กระจายไป UI ผ่าน WebSocket
 * ทุก message มี tenantId ทั้งใน header และ payload; Redis เหลือบทบาท state store เท่านั้น
 */

export const KAFKA_TOPICS = {
  /** raw events จาก FreeSWITCH (telephony produce, key = callUuid) */
  FS_EVENTS: 'dc.fs.events',
  /** interaction lifecycle events ทุก channel (key = interactionId) — source of truth ของ metering/billing */
  INTERACTION_EVENTS: 'dc.interaction.events',
  /** agent state changes (key = agentId) */
  AGENT_EVENTS: 'dc.agent.events',
  /** call control commands router → telephony (key = callUuid) — ใช้จริง Phase 1 */
  TELEPHONY_COMMANDS: 'dc.telephony.commands',
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

export type DContactEvent = InteractionEvent | AgentEvent;
