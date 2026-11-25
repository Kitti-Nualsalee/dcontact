/**
 * Unified Interaction Model — the heart of omnichannel
 * every channel (call, chat, social, email) maps to the same Interaction
 * and flows through the same router (see docs/adr/001)
 */

export type Channel = 'voice' | 'webchat' | 'line' | 'facebook' | 'whatsapp' | 'email';

export type Direction = 'inbound' | 'outbound';

export type InteractionState =
  | 'queued' // in the queue, waiting for an agent
  | 'assigned' // the router has reserved it for an agent (ringing)
  | 'active' // the agent is talking
  | 'wrapup' // finished, the agent is doing after-call work
  | 'completed'
  | 'abandoned'; // the customer hung up/left before reaching an agent

export type AgentState =
  | 'offline'
  | 'available'
  | 'reserved' // reserved by the router (a ringing job exists)
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
  /** id on the external system, e.g. FreeSWITCH call UUID, LINE message id */
  externalId: string | null;
  queuedAt: string;
  assignedAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
}
