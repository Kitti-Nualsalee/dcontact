import type { AgentState, Channel, InteractionState } from './interaction';

/**
 * Event contracts on Kafka — every service talks to the others through these events (see ADR-003)
 * telephony/channels produce → router decides → api fans out to the UI over WebSocket
 * every message carries tenantId in both the header and the payload; Redis remains only a state store
 */

export const KAFKA_TOPICS = {
  /**
   * raw events from every vendor's media server — FreeSWITCH or Asterisk (telephony produces, key = callUuid)
   * the old name `dc.fs.events` was retired per ADR-023 item 6 because it was tied to a single vendor
   */
  TELEPHONY_EVENTS: 'dc.telephony.events',
  /** inbound messages/events from digital channels (channels produce, key = conversationId) */
  CHANNEL_EVENTS: 'dc.channel.events',
  /** interaction lifecycle events for every channel (key = interactionId) — source of truth for metering/billing */
  INTERACTION_EVENTS: 'dc.interaction.events',
  /** agent state changes (key = agentId) */
  AGENT_EVENTS: 'dc.agent.events',
  /** call control commands router → telephony (key = callUuid) — used for real in Phase 1 */
  TELEPHONY_COMMANDS: 'dc.telephony.commands',
  /** send outbound messages to digital channels: router → channels (key = conversationId) */
  CHANNEL_COMMANDS: 'dc.channel.commands',
  /** asynchronous QM transcription/analysis jobs (key = jobId) */
  QM_JOBS: 'dc.qm.jobs',
  /** QM results for API/WebSocket fan-out (key = tenantId) */
  QM_EVENTS: 'dc.qm.events',
  /**
   * events from the customer's business systems → journey engine (key = contactRef)
   * enters through `POST /api/v1/events` and is deduped by (tenantId, source, eventId) before being placed on the topic
   * see ADR-025 (CX automation)
   */
  JOURNEY_EVENTS: 'dc.journey.events',
  /**
   * canonical Customer 360 facts (key = contactId:segmentId) — Customer 360 is the owner/producer;
   * Journey and other consumers read read-only and check the revision before applying
   */
  CUSTOMER_EVENTS: 'dc.customer.events',
  /** IAM canonical scope invalidations (key = teamId); restrictive changes trigger re-filter. */
  ADMIN_EVENTS: 'dc.admin.events',
  /**
   * CG3/CG4 canonical snapshot notifications (key = tenantId:contactId or tenantId:policyId)
   * — restriction/consent/preference/policy/exception/kill changed; the payload has only version/scope/digest
   * and no raw PII (#104, #179)
   */
  CONTACT_GOVERNANCE_EVENTS: 'dc.contact-governance.events',
  /**
   * a downstream consumer (Journey/Dialer/Channels/Workspace) declares it has applied a CG3/CG4 event
   * — Contact Governance consumes it only as a read-only projection into cg_consumer_acknowledgements
   */
  CONTACT_GOVERNANCE_ACKNOWLEDGEMENTS: 'dc.contact-governance.acknowledgements',
  /** Journey → Cases durable owner commands (key = actionKey). */
  CASE_COMMANDS: 'dc.case.commands',
  /** Cases canonical command results (key = actionKey). */
  CASE_EVENTS: 'dc.case.events',
  /** Journey → Dialer campaign/callback durable owner commands (key = actionKey). */
  DIALER_COMMANDS: 'dc.dialer.commands',
  /** Dialer canonical command results (key = actionKey). */
  DIALER_EVENTS: 'dc.dialer.events',
  /** Journey → Delivery reconcile command after the submission barrier (key = actionKey). */
  DELIVERY_COMMANDS: 'dc.delivery.commands',
  /** quarantine for Kafka contracts that fail validation; access/retention are separate from business topics */
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
 * Events from the customer's business systems — the main entry to CX automation (ADR-025)
 *
 * Rules that keep an API retry from pulling a customer into a journey twice:
 *   unique (tenantId, source, eventId) at the event inbox — it can be fired any number of times with the same result
 * `eventId` must come from the **sending system** and stay the same on every retry of the same event
 * (the same discipline as providerMessageId / clientToken in ADR-024)
 */
export interface InboundBusinessEvent {
  /** the source system, e.g. 'billing' | 'wms' | 'crm' — keeps eventId from colliding across systems */
  source: string;
  /** the sender's id for the event — stable across retries */
  eventId: string;
  /** event type, e.g. 'payment.failed' */
  type: string;
  /** when the event actually occurred (not when we received it) */
  occurredAt: string; // ISO-8601
  /** payload version — the sender can change the structure without breaking old data */
  schemaVersion: number;
  /** points at the customer by any identity we know (ADR-020) */
  contactRef: { kind: 'PHONE' | 'EMAIL' | 'LINE' | 'CRM_ID'; value: string };
  payload: Record<string, unknown>;
}

export type DContactEvent = InteractionEvent | AgentEvent;
