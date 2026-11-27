import { Prisma } from '@d-contact/db';
import { recordVoiceHandlingAttribution } from './handling-attribution.js';

/**
 * #1044 Web chat assignment (ADR-001: one router decides assignment for every channel).
 *
 * - An Agent holds several chats at once, up to the widget's limit; an offer, an active chat and a chat
 *   waiting for its wrap-up all count against the limit.
 * - Chat and voice are never mixed: an Agent with a call is not offered a chat, and while an Agent holds
 *   a chat the state log says RESERVED/BUSY/ACW with reason `webchat`, so the voice routers (which only
 *   pick AVAILABLE Agents) skip them.
 * - Every function runs inside the caller's tenant transaction; the caller owns messages and notifications.
 * - Lock order: the Agent's `users` row first, then the Interaction. Offering a queued chat is the one
 *   exception (the Agent is unknown until picked) and takes the Agent with SKIP LOCKED, so it never waits.
 */

type Tx = Prisma.TransactionClient;

/** `agent_state_logs.reason` of a state that web chat owns */
export const WEBCHAT_STATE_REASON = 'webchat';
/** an Agent who let an offer time out is not offered the same chat again for this long */
export const WEBCHAT_REOFFER_COOLDOWN_MS = 60_000;
/** used when neither the queue nor the tenant sets an offer timeout */
export const WEBCHAT_DEFAULT_OFFER_TIMEOUT_SEC = 30;

export type WebchatEndReason = 'CUSTOMER_ENDED' | 'AGENT_ENDED' | 'IDLE_TIMEOUT' | 'CUSTOMER_LEFT';
export type WebchatAgentState = 'RESERVED' | 'BUSY' | 'ACW';

const OPEN_STATES = Prisma.sql`('ASSIGNED','ACTIVE','WRAPUP')`;

/** the state web chat wants the log to show for an Agent holding these chats; null = holds none */
export function desiredWebchatAgentState(open: {
  assigned: number;
  active: number;
  wrapup: number;
}): WebchatAgentState | null {
  if (open.active > 0) return 'BUSY';
  if (open.wrapup > 0) return 'ACW';
  if (open.assigned > 0) return 'RESERVED';
  return null;
}

/**
 * When an active chat is closed for silence: the Agent spoke last and the customer has not answered
 * within the timeout. A customer still waiting for the Agent's reply is never closed for silence.
 */
export function webchatIdleDeadline(input: {
  lastCustomerMessageAt: Date | null;
  lastAgentMessageAt: Date | null;
  idleTimeoutSec: number;
}): Date | null {
  const { lastAgentMessageAt, lastCustomerMessageAt } = input;
  if (!lastAgentMessageAt) return null;
  if (lastCustomerMessageAt && lastCustomerMessageAt > lastAgentMessageAt) return null;
  return new Date(lastAgentMessageAt.getTime() + input.idleTimeoutSec * 1000);
}

const eligibleForQueue = (tenantId: string, queueId: string) => Prisma.sql`
  EXISTS (
    SELECT 1 FROM queues q
    WHERE q.tenant_id = ${tenantId}::uuid AND q.id = ${queueId}::uuid AND q.is_active
      AND (q.team_id IS NULL OR q.team_id = u.team_id)
  )
  AND NOT EXISTS (
    SELECT 1 FROM queue_skills required
    LEFT JOIN agent_skills held ON held.tenant_id = required.tenant_id
      AND held.skill_id = required.skill_id AND held.user_id = u.id
    WHERE required.tenant_id = ${tenantId}::uuid AND required.queue_id = ${queueId}::uuid
      AND (held.user_id IS NULL OR held.level < required.min_level)
  )`;

const latestState = Prisma.sql`
  JOIN LATERAL (
    SELECT s.state::text AS state, s.reason, s.started_at FROM agent_state_logs s
    WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id
    ORDER BY s.started_at DESC, s.id DESC LIMIT 1
  ) latest ON true`;

/** true when at least one Agent who can take this queue's chats is signed in and not on a break */
export async function isWebchatQueueStaffed(
  tx: Tx,
  tenantId: string,
  queueId: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u.id FROM users u ${latestState}
    WHERE u.tenant_id = ${tenantId}::uuid AND u.role = 'AGENT' AND u.is_active
      AND latest.state IN ('AVAILABLE','RESERVED','BUSY','ACW')
      AND ${eligibleForQueue(tenantId, queueId)}
    LIMIT 1`);
  return rows.length > 0;
}

async function logEvent(
  tx: Tx,
  tenantId: string,
  interactionId: string,
  type: string,
  payload: Prisma.InputJsonObject,
) {
  await tx.interactionEvent.create({ data: { tenantId, interactionId, type, payload } });
}

async function lockAgent(tx: Tx, tenantId: string, agentId: string) {
  await tx.$queryRaw(Prisma.sql`
    SELECT id FROM users WHERE tenant_id = ${tenantId}::uuid AND id = ${agentId}::uuid
    FOR NO KEY UPDATE`);
}

async function lockInteraction(tx: Tx, tenantId: string, interactionId: string) {
  const rows = await tx.$queryRaw<
    { id: string; state: string; agent_id: string | null; queue_id: string | null }[]
  >(Prisma.sql`
    SELECT id, state::text AS state, agent_id, queue_id FROM interactions
    WHERE tenant_id = ${tenantId}::uuid AND id = ${interactionId}::uuid AND channel = 'WEBCHAT'
    FOR UPDATE`);
  return rows[0];
}

/**
 * Brings the Agent's state log in line with the chats they hold. The caller holds the Agent's row lock.
 * A state web chat does not own (OFFLINE, BREAK, a voice state) is left alone, so a forced or self-set
 * state is never overwritten; `workCompleted` applies the after-work state when the last chat is done.
 */
export async function syncAgentWebchatState(
  tx: Tx,
  tenantId: string,
  agentId: string,
  options: { workCompleted?: boolean; resume?: boolean } = {},
): Promise<void> {
  const [open] = await tx.$queryRaw<{ assigned: number; active: number; wrapup: number }[]>(
    Prisma.sql`
    SELECT count(*) FILTER (WHERE state = 'ASSIGNED')::int AS assigned,
      count(*) FILTER (WHERE state = 'ACTIVE')::int AS active,
      count(*) FILTER (WHERE state = 'WRAPUP')::int AS wrapup
    FROM interactions
    WHERE tenant_id = ${tenantId}::uuid AND agent_id = ${agentId}::uuid AND channel = 'WEBCHAT'
      AND state IN ${OPEN_STATES}`,
  );
  const latest = await tx.agentStateLog.findFirst({
    where: { tenantId, userId: agentId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    select: { state: true, reason: true },
  });
  const owned =
    latest?.reason === WEBCHAT_STATE_REASON &&
    (latest.state === 'RESERVED' || latest.state === 'BUSY' || latest.state === 'ACW');
  const desired = desiredWebchatAgentState(open ?? { assigned: 0, active: 0, wrapup: 0 });
  if (desired) {
    const takeOver =
      latest?.state === 'AVAILABLE' ||
      // an Agent who signed in again while still holding chats continues them
      (options.resume === true && (latest?.state === 'OFFLINE' || latest === null));
    if ((owned && latest?.state !== desired) || (!owned && takeOver))
      await tx.agentStateLog.create({
        data: { tenantId, userId: agentId, state: desired, reason: WEBCHAT_STATE_REASON },
      });
    return;
  }
  if (!owned) return;
  if (options.workCompleted) {
    const requested = await tx.agentAfterWorkState.findUnique({
      where: { tenantId_userId: { tenantId, userId: agentId } },
      select: { reasonCode: true },
    });
    if (requested) {
      await tx.agentAfterWorkState.delete({
        where: { tenantId_userId: { tenantId, userId: agentId } },
      });
      await tx.agentStateLog.create({
        data: {
          tenantId,
          userId: agentId,
          state: 'BREAK',
          reasonCode: requested.reasonCode,
          actorUserId: agentId,
          reason: 'after_work_not_ready',
        },
      });
      return;
    }
  }
  await tx.agentStateLog.create({
    data: {
      tenantId,
      userId: agentId,
      state: 'AVAILABLE',
      reason: options.workCompleted ? 'wrapup_completed' : 'webchat_released',
    },
  });
}

/** Creates the work item of a visitor's chat in the queue. The caller links it to the session. */
export async function createWebchatInteraction(
  tx: Tx,
  input: {
    tenantId: string;
    queueId: string;
    conversationId: string;
    sessionId: string;
    widgetId: string;
    visitorLabel: string;
    now: Date;
  },
): Promise<string> {
  const interaction = await tx.interaction.create({
    data: {
      tenantId: input.tenantId,
      channel: 'WEBCHAT',
      direction: 'INBOUND',
      state: 'QUEUED',
      queueId: input.queueId,
      conversationId: input.conversationId,
      queuedAt: input.now,
      metadata: {
        webchat: {
          sessionId: input.sessionId,
          widgetId: input.widgetId,
          visitorLabel: input.visitorLabel,
        },
      },
    },
    select: { id: true },
  });
  await logEvent(tx, input.tenantId, interaction.id, 'interaction.queued', {
    channel: 'WEBCHAT',
    queueId: input.queueId,
  });
  return interaction.id;
}

export interface WebchatOfferResult {
  offerId: string;
  agentId: string;
  expiresAt: Date;
}

/**
 * Offers a queued chat to the Agent with the fewest chats who has waited longest. Returns null when
 * the chat is no longer queued or nobody can take it now; the caller tries again on its next round.
 */
export async function offerQueuedWebchat(
  tx: Tx,
  input: { tenantId: string; interactionId: string; maxChatsPerAgent: number; now: Date },
): Promise<WebchatOfferResult | null> {
  const { tenantId, interactionId, now } = input;
  const interaction = await lockInteraction(tx, tenantId, interactionId);
  if (!interaction || interaction.state !== 'QUEUED' || !interaction.queue_id) return null;
  const queueId = interaction.queue_id;
  const cooldownFrom = new Date(now.getTime() - WEBCHAT_REOFFER_COOLDOWN_MS);
  const eligibleNow = Prisma.sql`
    (latest.state = 'AVAILABLE'
      OR (latest.state IN ('RESERVED','BUSY','ACW') AND latest.reason = ${WEBCHAT_STATE_REASON}))
    AND chats.open < ${input.maxChatsPerAgent}
    AND NOT EXISTS (
      SELECT 1 FROM interactions other
      WHERE other.tenant_id = u.tenant_id AND other.agent_id = u.id
        AND other.channel <> 'WEBCHAT' AND other.state IN ${OPEN_STATES}
    )
    -- an Agent who asked to go Not Ready after work gets no new chat while finishing the ones in hand
    AND NOT (chats.open > 0 AND EXISTS (
      SELECT 1 FROM agent_after_work_states after_work
      WHERE after_work.tenant_id = u.tenant_id AND after_work.user_id = u.id
    ))`;
  const chats = Prisma.sql`
    JOIN LATERAL (
      SELECT count(*)::int AS open FROM interactions held
      WHERE held.tenant_id = u.tenant_id AND held.agent_id = u.id
        AND held.channel = 'WEBCHAT' AND held.state IN ${OPEN_STATES}
    ) chats ON true`;
  const [picked] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u.id FROM users u ${latestState} ${chats}
    LEFT JOIN LATERAL (
      SELECT max(assigned_at) AS at FROM interactions assigned
      WHERE assigned.tenant_id = u.tenant_id AND assigned.agent_id = u.id
    ) last_assignment ON true
    WHERE u.tenant_id = ${tenantId}::uuid AND u.role = 'AGENT' AND u.is_active
      AND ${eligibleForQueue(tenantId, queueId)}
      AND ${eligibleNow}
      AND NOT EXISTS (
        SELECT 1 FROM webchat_offers earlier
        WHERE earlier.tenant_id = u.tenant_id AND earlier.interaction_id = ${interactionId}::uuid
          AND earlier.agent_id = u.id AND earlier.outcome = 'TIMED_OUT'
          AND earlier.resolved_at > ${cooldownFrom}::timestamptz
      )
    ORDER BY chats.open, last_assignment.at ASC NULLS FIRST, latest.started_at, u.id
    FOR NO KEY UPDATE OF u SKIP LOCKED LIMIT 1`);
  if (!picked) return null;
  // The pick read its facts from the statement snapshot. Now that the row is locked, read them again so
  // an assignment committed in between (by a voice router or another chat round) is not doubled.
  const [confirmed] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u.id FROM users u ${latestState} ${chats}
    WHERE u.tenant_id = ${tenantId}::uuid AND u.id = ${picked.id}::uuid AND ${eligibleNow}`);
  if (!confirmed) return null;

  const queue = await tx.queue.findFirst({
    where: { tenantId, id: queueId },
    select: { offerTimeoutSec: true, tenant: { select: { defaultOfferTimeoutSec: true } } },
  });
  const timeoutSec =
    queue?.offerTimeoutSec ??
    queue?.tenant.defaultOfferTimeoutSec ??
    WEBCHAT_DEFAULT_OFFER_TIMEOUT_SEC;
  const expiresAt = new Date(now.getTime() + timeoutSec * 1000);
  const offer = await tx.webchatOffer.create({
    data: { tenantId, interactionId, agentId: picked.id, offeredAt: now, expiresAt },
    select: { id: true },
  });
  await tx.interaction.update({
    where: { id: interactionId },
    data: { state: 'ASSIGNED', agentId: picked.id, assignedAt: now, offerExpiresAt: expiresAt },
  });
  await logEvent(tx, tenantId, interactionId, 'interaction.offered', {
    agentId: picked.id,
    offerId: offer.id,
  });
  await syncAgentWebchatState(tx, tenantId, picked.id);
  return { offerId: offer.id, agentId: picked.id, expiresAt };
}

async function requeue(
  tx: Tx,
  tenantId: string,
  interactionId: string,
  agentId: string,
  outcome: 'TIMED_OUT' | 'CANCELLED',
  now: Date,
) {
  await tx.webchatOffer.updateMany({
    where: { tenantId, interactionId, outcome: 'PENDING' },
    data: { outcome, resolvedAt: now },
  });
  await tx.interaction.update({
    where: { id: interactionId },
    data: { state: 'QUEUED', agentId: null, assignedAt: null, offerExpiresAt: null },
  });
  await logEvent(
    tx,
    tenantId,
    interactionId,
    outcome === 'TIMED_OUT' ? 'interaction.offer_timed_out' : 'interaction.offer_cancelled',
    { agentId },
  );
  await syncAgentWebchatState(tx, tenantId, agentId);
}

/**
 * Returns an offer nobody accepted in time to the queue, and an offer whose Agent has since taken a
 * call (the rare race with a voice router) as well. Returns the Agent it was taken from, or null.
 */
export async function releaseWebchatOffer(
  tx: Tx,
  input: { tenantId: string; interactionId: string; agentId: string; now: Date },
): Promise<{ agentId: string; reason: 'TIMED_OUT' | 'CANCELLED' } | null> {
  const { tenantId, interactionId, agentId, now } = input;
  await lockAgent(tx, tenantId, agentId);
  const interaction = await lockInteraction(tx, tenantId, interactionId);
  if (!interaction || interaction.state !== 'ASSIGNED' || interaction.agent_id !== agentId)
    return null;
  const offer = await tx.webchatOffer.findFirst({
    where: { tenantId, interactionId, agentId, outcome: 'PENDING' },
    select: { expiresAt: true },
  });
  const onCall = await tx.interaction.count({
    where: {
      tenantId,
      agentId,
      channel: { not: 'WEBCHAT' },
      state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] },
    },
  });
  const reason = onCall > 0 ? 'CANCELLED' : !offer || offer.expiresAt <= now ? 'TIMED_OUT' : null;
  if (!reason) return null;
  await requeue(tx, tenantId, interactionId, agentId, reason, now);
  return { agentId, reason };
}

export type WebchatAcceptResult = 'ACCEPTED' | 'ALREADY_ACCEPTED' | 'OFFER_GONE';

/** The Agent takes the chat offered to them. Accepting twice is safe. */
export async function acceptWebchatOffer(
  tx: Tx,
  input: { tenantId: string; interactionId: string; agentId: string; now: Date },
): Promise<WebchatAcceptResult> {
  const { tenantId, interactionId, agentId, now } = input;
  await lockAgent(tx, tenantId, agentId);
  const interaction = await lockInteraction(tx, tenantId, interactionId);
  if (!interaction || interaction.agent_id !== agentId) return 'OFFER_GONE';
  if (interaction.state === 'ACTIVE') return 'ALREADY_ACCEPTED';
  if (interaction.state !== 'ASSIGNED') return 'OFFER_GONE';
  const onCall = await tx.interaction.count({
    where: {
      tenantId,
      agentId,
      channel: { not: 'WEBCHAT' },
      state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] },
    },
  });
  if (onCall > 0) {
    await requeue(tx, tenantId, interactionId, agentId, 'CANCELLED', now);
    return 'OFFER_GONE';
  }
  const accepted = await tx.webchatOffer.updateMany({
    where: { tenantId, interactionId, agentId, outcome: 'PENDING' },
    data: { outcome: 'ACCEPTED', resolvedAt: now },
  });
  if (accepted.count === 0) return 'OFFER_GONE';
  await tx.interaction.update({
    where: { id: interactionId },
    data: { state: 'ACTIVE', answeredAt: now, offerExpiresAt: null },
  });
  await logEvent(tx, tenantId, interactionId, 'interaction.accepted', { agentId });
  // The team that took the chat is the evidence behind who may read it later (#859, #986).
  await recordVoiceHandlingAttribution(tx, {
    tenantId,
    interactionId,
    agentId,
    sourceEventId: `webchat-accept:${interactionId}`,
  });
  await syncAgentWebchatState(tx, tenantId, agentId);
  return 'ACCEPTED';
}

export interface WebchatEndResult {
  /** WRAPUP = an Agent took the chat and now records the result; ABANDONED = it ended before any Agent did */
  state: 'WRAPUP' | 'ABANDONED';
  agentId: string | null;
}

/**
 * Ends a chat that is still queued, offered or active. Returns null when it had already ended, so a
 * repeated end (customer and Agent at once, or a retry) changes nothing.
 */
export async function endWebchat(
  tx: Tx,
  input: { tenantId: string; interactionId: string; reason: WebchatEndReason; now: Date },
): Promise<WebchatEndResult | null> {
  const { tenantId, interactionId, reason, now } = input;
  const current = await tx.interaction.findFirst({
    where: { tenantId, id: interactionId, channel: 'WEBCHAT' },
    select: { agentId: true },
  });
  if (!current) return null;
  if (current.agentId) await lockAgent(tx, tenantId, current.agentId);
  const interaction = await lockInteraction(tx, tenantId, interactionId);
  if (!interaction) return null;
  // The owner changed between the read and the lock (an offer moved on): the caller's next round retries.
  if (interaction.agent_id !== current.agentId) return null;
  const agentId = interaction.agent_id;
  if (interaction.state === 'ACTIVE' && agentId) {
    await tx.interaction.update({
      where: { id: interactionId },
      data: { state: 'WRAPUP', endedAt: now },
    });
    await logEvent(tx, tenantId, interactionId, 'interaction.ended', { reason, agentId });
    await syncAgentWebchatState(tx, tenantId, agentId);
    return { state: 'WRAPUP', agentId };
  }
  if (interaction.state === 'QUEUED' || interaction.state === 'ASSIGNED') {
    await tx.webchatOffer.updateMany({
      where: { tenantId, interactionId, outcome: 'PENDING' },
      data: { outcome: 'CANCELLED', resolvedAt: now },
    });
    await tx.interaction.update({
      where: { id: interactionId },
      data: {
        state: 'ABANDONED',
        agentId: null,
        assignedAt: null,
        offerExpiresAt: null,
        endedAt: now,
      },
    });
    await logEvent(tx, tenantId, interactionId, 'interaction.abandoned', { reason });
    if (agentId) await syncAgentWebchatState(tx, tenantId, agentId);
    return { state: 'ABANDONED', agentId };
  }
  return null;
}

/**
 * A pending offer whose Interaction another writer already returned to the queue (a work-session
 * takeover requeues every offer of the Agent) is closed so the chat can be offered again.
 */
export async function closeOrphanWebchatOffers(
  tx: Tx,
  tenantId: string,
  now: Date,
): Promise<string[]> {
  const orphans = await tx.$queryRaw<{ id: string; agent_id: string }[]>(Prisma.sql`
    SELECT offer.id, offer.agent_id FROM webchat_offers offer
    JOIN interactions i ON i.tenant_id = offer.tenant_id AND i.id = offer.interaction_id
    WHERE offer.tenant_id = ${tenantId}::uuid AND offer.outcome = 'PENDING'
      AND (i.state <> 'ASSIGNED' OR i.agent_id IS DISTINCT FROM offer.agent_id)
    FOR UPDATE OF offer SKIP LOCKED`);
  for (const orphan of orphans) {
    await tx.webchatOffer.updateMany({
      where: { tenantId, id: orphan.id, outcome: 'PENDING' },
      data: { outcome: 'CANCELLED', resolvedAt: now },
    });
  }
  return [...new Set(orphans.map((orphan) => orphan.agent_id))];
}
