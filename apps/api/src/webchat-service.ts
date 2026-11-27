import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  acceptWebchatOffer,
  closeOrphanWebchatOffers,
  createWebchatInteraction,
  endWebchat,
  isWebchatQueueStaffed,
  offerQueuedWebchat,
  releaseWebchatOffer,
  webchatIdleDeadline,
  type WebchatEndReason,
} from '@d-contact/router';
import { findActiveAgent } from './active-agent.js';
import { WebchatError, webchatText, webchatUuid } from './webchat-errors.js';
import type { WebchatHub, WebchatNotice } from './webchat-hub.js';

/**
 * #1044 Web chat: the visitor's session and messages, the Agent's chats, and the background round that
 * moves chats along (offer, offer timeout, a visitor who left, silence). Assignment rules live in
 * `@d-contact/router`; this file is the channel side (ADR-001) and owns messages and notifications.
 *
 * - Every query runs in the tenant's transaction. The visitor names the tenant in the URL and proves
 *   the session with a secret whose digest is stored; nothing here reads across tenants.
 * - Messages of one conversation are written one at a time (the conversation row is locked) with a
 *   strictly increasing time, so "messages after this cursor" never skips one.
 * - A notice is published only after the transaction commits.
 */

type Tx = Prisma.TransactionClient;
type Actor = { tenantId: string; userId: string };

/** `messages.content_type` of a system line; the body is one of `WebchatSystemEvent` */
export const WEBCHAT_EVENT_CONTENT_TYPE = 'application/vnd.dcontact.webchat-event';
/** a waiting visitor whose page stopped asking for this long has left */
export const WEBCHAT_VISITOR_GONE_MS = 120_000;
export const WEBCHAT_MAX_MESSAGES = 500;
/** chats of one widget that may wait for an Agent at once */
export const WEBCHAT_MAX_WAITING = 200;
const SEEN_REFRESH_MS = 10_000;

export type WebchatSystemEvent = 'AGENT_JOINED' | WebchatEndReason;

export interface WebchatMessageView {
  id: string;
  at: string;
  from: 'visitor' | 'agent' | 'system';
  text?: string;
  event?: WebchatSystemEvent;
  /** the id the sender gave the message, so the sender can match it with the copy it is still showing */
  clientId?: string;
}

export type WebchatVisitorStatus = 'NEW' | 'WAITING' | 'ACTIVE' | 'ENDED';

export interface WebchatVisitorState {
  status: WebchatVisitorStatus;
  endReason: WebchatEndReason | null;
  /** an Agent who can take this widget's chats is signed in; meaningful before the first message */
  staffed: boolean;
  messages: WebchatMessageView[];
  /** pass as `after` to read only newer messages */
  cursor: string | null;
  /** changes whenever the status or the messages change; the long poll waits while it is equal */
  version: string;
}

export interface WebchatAgentChat {
  interactionId: string;
  state: 'ASSIGNED' | 'ACTIVE' | 'WRAPUP';
  visitorLabel: string;
  /** the site the visitor started the chat from, as the widget reported it */
  origin: string;
  queueName: string | null;
  queuedAt: string;
  offerExpiresAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: WebchatEndReason | null;
  visitorOnline: boolean;
  /** when an active chat will close for silence if the customer does not answer; null = not counting */
  idleClosesAt: string | null;
  lastMessage: WebchatMessageView | null;
  visitorMessageCount: number;
}

const digest = (secret: string) => createHash('sha256').update(secret, 'utf8').digest();

function messageView(row: {
  id: string;
  createdAt: Date;
  senderType: string;
  contentType: string;
  body: string;
  providerMessageId: string | null;
  clientToken: string | null;
}): WebchatMessageView {
  const base = { id: row.id, at: row.createdAt.toISOString() };
  if (row.contentType === WEBCHAT_EVENT_CONTENT_TYPE)
    return { ...base, from: 'system', event: row.body as WebchatSystemEvent };
  if (row.senderType === 'AGENT')
    return {
      ...base,
      from: 'agent',
      text: row.body,
      ...(row.clientToken ? { clientId: row.clientToken } : {}),
    };
  // a visitor message is stored as `<session>:<client id>`
  const clientId = row.providerMessageId?.split(':')[1];
  return { ...base, from: 'visitor', text: row.body, ...(clientId ? { clientId } : {}) };
}

function cursorDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string' && value.length <= 32) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString() === value) return parsed;
  }
  throw new WebchatError('VALIDATION_FAILED', { field: 'after' });
}

const MESSAGE_SELECT = {
  id: true,
  createdAt: true,
  senderType: true,
  contentType: true,
  body: true,
  providerMessageId: true,
  clientToken: true,
} as const;

export interface WebchatServiceOptions {
  now?: () => Date;
}

export class WebchatService {
  private readonly now: () => Date;
  /** tenants that had open chats at the last look; the background round visits only these */
  private readonly activeTenants = new Set<string>();
  /** rounds started by a new chat that have not finished yet */
  private readonly kicks = new Set<Promise<unknown>>();

  constructor(
    private readonly database: PrismaClient,
    private readonly hub: WebchatHub,
    options: WebchatServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private tenant<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantDatabaseTransaction(this.database, tenantId, work);
  }

  // ───────────────────────────── visitor ─────────────────────────────

  /** Where the widget may be embedded; null when the widget does not exist or is turned off. */
  async embedPolicy(
    tenantValue: string,
    widgetValue: string,
  ): Promise<{ allowedOrigins: string[]; tenantName: string } | null> {
    const tenantId = webchatUuid(tenantValue);
    const widgetId = webchatUuid(widgetValue);
    return this.tenant(tenantId, async (tx) => {
      const widget = await tx.webchatWidget.findFirst({
        where: { tenantId, id: widgetId, enabled: true },
        select: { allowedOrigins: true },
      });
      if (!widget) return null;
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      return { allowedOrigins: [...widget.allowedOrigins], tenantName: tenant?.name ?? '' };
    });
  }

  private async enabledWidget(tx: Tx, tenantId: string, widgetId: string) {
    const widget = await tx.webchatWidget.findFirst({
      where: { tenantId, id: widgetId, enabled: true },
    });
    if (!widget?.queueId) throw new WebchatError('WEBCHAT_DISABLED');
    return { ...widget, queueId: widget.queueId };
  }

  async bootstrap(tenantValue: string, widgetValue: string) {
    const tenantId = webchatUuid(tenantValue);
    const widgetId = webchatUuid(widgetValue);
    return this.tenant(tenantId, async (tx) => {
      const widget = await this.enabledWidget(tx, tenantId, widgetId);
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      });
      return {
        tenantName: tenant?.name ?? '',
        greeting: { th: widget.greetingTh, en: widget.greetingEn },
        idleTimeoutSec: widget.idleTimeoutSec,
        staffed: await isWebchatQueueStaffed(tx, tenantId, widget.queueId),
      };
    });
  }

  async startSession(
    tenantValue: string,
    widgetValue: string,
    input: { origin: string; locale: unknown },
  ) {
    const tenantId = webchatUuid(tenantValue);
    const widgetId = webchatUuid(widgetValue);
    const locale = input.locale === 'en' ? 'en' : 'th';
    const sessionId = randomUUID();
    const secret = randomBytes(32).toString('base64url');
    const visitorLabel = randomBytes(2).toString('hex').toUpperCase();
    await this.tenant(tenantId, async (tx) => {
      await this.enabledWidget(tx, tenantId, widgetId);
      const conversation = await tx.conversation.create({
        data: {
          tenantId,
          channel: 'WEBCHAT',
          channelAccountId: widgetId,
          externalThreadId: sessionId,
          state: 'IDLE',
        },
        select: { id: true },
      });
      await tx.webchatSession.create({
        data: {
          tenantId,
          id: sessionId,
          widgetId,
          conversationId: conversation.id,
          tokenHash: digest(secret).toString('hex'),
          origin: input.origin.slice(0, 255),
          visitorLabel,
          locale,
          lastSeenAt: this.now(),
        },
      });
    });
    return { sessionId, token: secret, visitorLabel };
  }

  private async session(tx: Tx, tenantId: string, sessionId: string, token: unknown) {
    const session = await tx.webchatSession.findFirst({ where: { tenantId, id: sessionId } });
    const expected = session ? Buffer.from(session.tokenHash, 'hex') : Buffer.alloc(32);
    const supplied = digest(typeof token === 'string' ? token : '');
    // compare even when the session is unknown, so a miss takes the same time as a wrong secret
    const matches = expected.length === supplied.length && timingSafeEqual(expected, supplied);
    if (!session || !matches) throw new WebchatError('SESSION_INVALID');
    return session;
  }

  private async visitorState(
    tx: Tx,
    session: {
      tenantId: string;
      widgetId: string;
      conversationId: string;
      interactionId: string | null;
      endReason: string | null;
    },
    after: Date | undefined,
  ): Promise<WebchatVisitorState> {
    const { tenantId } = session;
    const interaction = session.interactionId
      ? await tx.interaction.findFirst({
          where: { tenantId, id: session.interactionId },
          select: { state: true },
        })
      : null;
    const status: WebchatVisitorStatus = session.endReason
      ? 'ENDED'
      : !interaction
        ? 'NEW'
        : interaction.state === 'ACTIVE'
          ? 'ACTIVE'
          : interaction.state === 'QUEUED' || interaction.state === 'ASSIGNED'
            ? 'WAITING'
            : 'ENDED';
    let staffed = true;
    if (status === 'NEW') {
      const widget = await tx.webchatWidget.findFirst({
        where: { tenantId, id: session.widgetId, enabled: true },
        select: { queueId: true },
      });
      staffed = widget?.queueId ? await isWebchatQueueStaffed(tx, tenantId, widget.queueId) : false;
    }
    const rows = await tx.message.findMany({
      where: {
        tenantId,
        conversationId: session.conversationId,
        ...(after ? { createdAt: { gt: after } } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: MESSAGE_SELECT,
      take: WEBCHAT_MAX_MESSAGES + 20,
    });
    const messages = rows.map(messageView);
    const cursor = messages.at(-1)?.at ?? after?.toISOString() ?? null;
    return {
      status,
      endReason: (session.endReason as WebchatEndReason | null) ?? null,
      staffed,
      messages,
      cursor,
      version: `${status}:${cursor ?? ''}`,
    };
  }

  /**
   * The visitor's view of the chat. With `known` equal to the current version the call waits for a
   * change (long poll) for up to `waitMs`, then answers whatever is current.
   */
  async sessionState(
    tenantValue: string,
    sessionValue: string,
    token: unknown,
    query: { after?: unknown; known?: unknown; waitMs?: number; signal?: AbortSignal } = {},
  ): Promise<WebchatVisitorState> {
    const tenantId = webchatUuid(tenantValue);
    const sessionId = webchatUuid(sessionValue, 'SESSION_INVALID');
    const after = cursorDate(query.after);
    const read = () =>
      this.tenant(tenantId, async (tx) => {
        const session = await this.session(tx, tenantId, sessionId, token);
        const now = this.now();
        if (!session.endReason && now.getTime() - session.lastSeenAt.getTime() > SEEN_REFRESH_MS)
          await tx.webchatSession.update({
            where: { tenantId_id: { tenantId, id: sessionId } },
            data: { lastSeenAt: now },
          });
        return this.visitorState(tx, session, after);
      });
    const first = await read();
    if (!query.waitMs || first.version !== query.known || first.status === 'ENDED') return first;
    const changed = await this.hub.waitForSession(tenantId, sessionId, query.waitMs, query.signal);
    return changed ? read() : first;
  }

  private async append(
    tx: Tx,
    input: {
      tenantId: string;
      conversationId: string;
      channelAccountId: string;
      interactionId: string | null;
      sender: 'CONTACT' | 'AGENT' | 'SYSTEM';
      body: string;
      event?: boolean;
      providerMessageId?: string;
      clientToken?: string;
      now: Date;
    },
  ) {
    const { tenantId, conversationId, now } = input;
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM conversations WHERE tenant_id = ${tenantId}::uuid AND id = ${conversationId}::uuid
      FOR UPDATE`);
    if (input.providerMessageId) {
      const repeated = await tx.message.findFirst({
        where: {
          tenantId,
          channelAccountId: input.channelAccountId,
          providerMessageId: input.providerMessageId,
        },
        select: MESSAGE_SELECT,
      });
      if (repeated) return { message: messageView(repeated), repeated: true };
    }
    if (input.clientToken) {
      const repeated = await tx.message.findFirst({
        where: { tenantId, clientToken: input.clientToken },
        select: { ...MESSAGE_SELECT, conversationId: true },
      });
      if (repeated) {
        if (repeated.conversationId !== conversationId || repeated.body !== input.body)
          throw new WebchatError('COMMAND_ID_REUSED');
        return { message: messageView(repeated), repeated: true };
      }
    }
    const [{ count, last }] = await tx.$queryRaw<{ count: number; last: Date | null }[]>(Prisma.sql`
      SELECT count(*)::int AS count, max(created_at) AS last FROM messages
      WHERE tenant_id = ${tenantId}::uuid AND conversation_id = ${conversationId}::uuid`);
    if (!input.event && count >= WEBCHAT_MAX_MESSAGES) throw new WebchatError('MESSAGE_LIMIT');
    // max(created_at) is a timestamp without zone that the driver reads as UTC, like every DateTime here
    const createdAt = last && last.getTime() >= now.getTime() ? new Date(last.getTime() + 1) : now;
    const row = await tx.message.create({
      data: {
        tenantId,
        conversationId,
        channelAccountId: input.channelAccountId,
        interactionId: input.interactionId,
        senderType: input.sender,
        direction: input.sender === 'CONTACT' ? 'INBOUND' : 'OUTBOUND',
        contentType: input.event ? WEBCHAT_EVENT_CONTENT_TYPE : 'text/plain',
        body: input.body,
        status: input.sender === 'CONTACT' ? 'RECEIVED' : 'SENT',
        ...(input.sender === 'CONTACT' ? {} : { sentAt: createdAt }),
        ...(input.providerMessageId ? { providerMessageId: input.providerMessageId } : {}),
        ...(input.clientToken ? { clientToken: input.clientToken } : {}),
        createdAt,
      },
      select: MESSAGE_SELECT,
    });
    if (!input.event)
      await tx.conversation.update({
        where: { id: conversationId },
        data:
          input.sender === 'CONTACT'
            ? { lastCustomerMessageAt: createdAt, state: 'OPEN' }
            : { lastAgentMessageAt: createdAt },
      });
    return { message: messageView(row), repeated: false };
  }

  async visitorSend(tenantValue: string, sessionValue: string, token: unknown, body: unknown) {
    const tenantId = webchatUuid(tenantValue);
    const sessionId = webchatUuid(sessionValue, 'SESSION_INVALID');
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const clientMessageId = webchatUuid(input.clientMessageId, 'VALIDATION_FAILED');
    const text = webchatText(input.text);
    const now = this.now();
    const result = await this.tenant(tenantId, async (tx) => {
      await this.session(tx, tenantId, sessionId, token);
      // One writer per session: two first messages sent together must open a single chat.
      await tx.$queryRaw(Prisma.sql`
        SELECT id FROM webchat_sessions WHERE tenant_id = ${tenantId}::uuid AND id = ${sessionId}::uuid
        FOR UPDATE`);
      const session = await tx.webchatSession.findFirstOrThrow({
        where: { tenantId, id: sessionId },
      });
      if (session.endReason) throw new WebchatError('CHAT_ENDED');
      let interactionId = session.interactionId;
      let agentId: string | null = null;
      let opened = false;
      if (!interactionId) {
        const widget = await this.enabledWidget(tx, tenantId, session.widgetId);
        if (!(await isWebchatQueueStaffed(tx, tenantId, widget.queueId)))
          throw new WebchatError('NO_AGENT_ONLINE');
        const waiting = await tx.interaction.count({
          where: {
            tenantId,
            channel: 'WEBCHAT',
            queueId: widget.queueId,
            state: { in: ['QUEUED', 'ASSIGNED'] },
          },
        });
        if (waiting >= WEBCHAT_MAX_WAITING) throw new WebchatError('QUEUE_FULL');
        interactionId = await createWebchatInteraction(tx, {
          tenantId,
          queueId: widget.queueId,
          conversationId: session.conversationId,
          sessionId,
          widgetId: session.widgetId,
          visitorLabel: session.visitorLabel,
          now,
        });
        await tx.webchatSession.update({
          where: { tenantId_id: { tenantId, id: sessionId } },
          data: { interactionId, lastSeenAt: now },
        });
        opened = true;
      } else {
        const interaction = await tx.interaction.findFirst({
          where: { tenantId, id: interactionId },
          select: { state: true, agentId: true },
        });
        if (!interaction || !['QUEUED', 'ASSIGNED', 'ACTIVE'].includes(interaction.state))
          throw new WebchatError('CHAT_ENDED');
        agentId = interaction.agentId;
      }
      const appended = await this.append(tx, {
        tenantId,
        conversationId: session.conversationId,
        channelAccountId: session.widgetId,
        interactionId,
        sender: 'CONTACT',
        body: text,
        providerMessageId: `${sessionId}:${clientMessageId}`,
        now,
      });
      return { message: appended.message, agentId, opened };
    });
    this.hub.publish({
      tenantId,
      sessionIds: [sessionId],
      agentIds: result.agentId ? [result.agentId] : [],
    });
    if (result.opened) {
      this.activeTenants.add(tenantId);
      // offer the new chat now instead of waiting for the next background round
      const kick = this.tick(tenantId).catch(() => undefined);
      this.kicks.add(kick);
      void kick.finally(() => this.kicks.delete(kick));
    }
    return { message: result.message };
  }

  async visitorEnd(tenantValue: string, sessionValue: string, token: unknown) {
    const tenantId = webchatUuid(tenantValue);
    const sessionId = webchatUuid(sessionValue, 'SESSION_INVALID');
    const notice = await this.tenant(tenantId, async (tx) => {
      const session = await this.session(tx, tenantId, sessionId, token);
      if (session.endReason) return null;
      if (!session.interactionId) {
        // nothing was ever sent: just close the session so the widget starts a fresh one
        await tx.webchatSession.update({
          where: { tenantId_id: { tenantId, id: sessionId } },
          data: { endReason: 'CUSTOMER_ENDED', endedAt: this.now() },
        });
        return { tenantId, sessionIds: [sessionId] } satisfies WebchatNotice;
      }
      return this.end(tx, tenantId, session.interactionId, 'CUSTOMER_ENDED');
    });
    if (notice) this.hub.publish(notice);
    return { status: 'ENDED' as const };
  }

  /** Ends the chat and writes everything that goes with it. Null when it had already ended. */
  private async end(
    tx: Tx,
    tenantId: string,
    interactionId: string,
    reason: WebchatEndReason,
  ): Promise<WebchatNotice | null> {
    const now = this.now();
    const ended = await endWebchat(tx, { tenantId, interactionId, reason, now });
    if (!ended) return null;
    const session = await tx.webchatSession.findFirst({ where: { tenantId, interactionId } });
    if (!session) return { tenantId, agentIds: ended.agentId ? [ended.agentId] : [] };
    await tx.webchatSession.update({
      where: { tenantId_id: { tenantId, id: session.id } },
      data: { endReason: reason, endedAt: now },
    });
    await this.append(tx, {
      tenantId,
      conversationId: session.conversationId,
      channelAccountId: session.widgetId,
      interactionId,
      sender: 'SYSTEM',
      body: reason,
      event: true,
      now,
    });
    await tx.conversation.update({
      where: { id: session.conversationId },
      data: { state: 'RESOLVED', lastResolvedAt: now },
    });
    return {
      tenantId,
      sessionIds: [session.id],
      agentIds: ended.agentId ? [ended.agentId] : [],
    };
  }

  // ───────────────────────────── Agent ─────────────────────────────

  private async agent(tx: Tx, actor: Actor) {
    if (!(await findActiveAgent(tx, actor))) throw new WebchatError('FORBIDDEN');
  }

  /** The chats in the Agent's hands: offers, active chats and chats waiting for their result. */
  async agentChats(actor: Actor): Promise<{ maxChatsPerAgent: number; chats: WebchatAgentChat[] }> {
    const { tenantId } = actor;
    return this.tenant(tenantId, async (tx) => {
      await this.agent(tx, actor);
      const interactions = await tx.interaction.findMany({
        where: {
          tenantId,
          agentId: actor.userId,
          channel: 'WEBCHAT',
          state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] },
        },
        select: {
          id: true,
          state: true,
          queuedAt: true,
          offerExpiresAt: true,
          answeredAt: true,
          endedAt: true,
          conversationId: true,
          queue: { select: { name: true } },
          conversation: { select: { lastCustomerMessageAt: true, lastAgentMessageAt: true } },
        },
        orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
      });
      const sessions = await tx.webchatSession.findMany({
        where: { tenantId, interactionId: { in: interactions.map((row) => row.id) } },
      });
      const widget = await tx.webchatWidget.findFirst({
        where: { tenantId },
        select: { maxChatsPerAgent: true, idleTimeoutSec: true },
      });
      const now = this.now().getTime();
      const chats: WebchatAgentChat[] = [];
      for (const interaction of interactions) {
        const session = sessions.find((row) => row.interactionId === interaction.id);
        if (!session || !interaction.conversationId) continue;
        const where = { tenantId, conversationId: interaction.conversationId };
        const [last, visitorMessageCount] = await Promise.all([
          tx.message.findFirst({
            where,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            select: MESSAGE_SELECT,
          }),
          tx.message.count({ where: { ...where, senderType: 'CONTACT' } }),
        ]);
        chats.push({
          interactionId: interaction.id,
          state: interaction.state as WebchatAgentChat['state'],
          visitorLabel: session.visitorLabel,
          origin: session.origin,
          queueName: interaction.queue?.name ?? null,
          queuedAt: interaction.queuedAt.toISOString(),
          offerExpiresAt: interaction.offerExpiresAt?.toISOString() ?? null,
          answeredAt: interaction.answeredAt?.toISOString() ?? null,
          endedAt: interaction.endedAt?.toISOString() ?? null,
          endReason: (session.endReason as WebchatEndReason | null) ?? null,
          visitorOnline:
            !session.endReason && now - session.lastSeenAt.getTime() < WEBCHAT_VISITOR_GONE_MS,
          idleClosesAt:
            interaction.state === 'ACTIVE'
              ? (webchatIdleDeadline({
                  lastCustomerMessageAt: interaction.conversation?.lastCustomerMessageAt ?? null,
                  lastAgentMessageAt: interaction.conversation?.lastAgentMessageAt ?? null,
                  idleTimeoutSec: widget?.idleTimeoutSec ?? 600,
                })?.toISOString() ?? null)
              : null,
          lastMessage: last ? messageView(last) : null,
          visitorMessageCount,
        });
      }
      return { maxChatsPerAgent: widget?.maxChatsPerAgent ?? 3, chats };
    });
  }

  private async ownedChat(tx: Tx, actor: Actor, interactionId: string, states: string[]) {
    const interaction = await tx.interaction.findFirst({
      where: {
        tenantId: actor.tenantId,
        id: interactionId,
        agentId: actor.userId,
        channel: 'WEBCHAT',
      },
      select: { id: true, state: true, conversationId: true },
    });
    // another Agent's chat, another tenant's and a missing one all answer the same
    if (!interaction?.conversationId) throw new WebchatError('NOT_FOUND');
    if (!states.includes(interaction.state)) throw new WebchatError('CHAT_NOT_ACTIVE');
    const session = await tx.webchatSession.findFirst({
      where: { tenantId: actor.tenantId, interactionId },
    });
    if (!session) throw new WebchatError('NOT_FOUND');
    return { interaction, session, conversationId: interaction.conversationId };
  }

  async agentMessages(actor: Actor, interactionValue: string, afterValue?: unknown) {
    const interactionId = webchatUuid(interactionValue);
    const after = cursorDate(afterValue);
    return this.tenant(actor.tenantId, async (tx) => {
      await this.agent(tx, actor);
      const { conversationId } = await this.ownedChat(tx, actor, interactionId, [
        'ACTIVE',
        'WRAPUP',
      ]);
      const rows = await tx.message.findMany({
        where: {
          tenantId: actor.tenantId,
          conversationId,
          ...(after ? { createdAt: { gt: after } } : {}),
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: MESSAGE_SELECT,
        take: WEBCHAT_MAX_MESSAGES + 20,
      });
      const messages = rows.map(messageView);
      return { messages, cursor: messages.at(-1)?.at ?? after?.toISOString() ?? null };
    });
  }

  async agentAccept(actor: Actor, interactionValue: string) {
    const interactionId = webchatUuid(interactionValue);
    const { tenantId } = actor;
    const now = this.now();
    const sessionId = await this.tenant(tenantId, async (tx) => {
      await this.agent(tx, actor);
      const result = await acceptWebchatOffer(tx, {
        tenantId,
        interactionId,
        agentId: actor.userId,
        now,
      });
      if (result === 'OFFER_GONE') throw new WebchatError('OFFER_GONE');
      const session = await tx.webchatSession.findFirst({ where: { tenantId, interactionId } });
      if (result === 'ACCEPTED' && session)
        await this.append(tx, {
          tenantId,
          conversationId: session.conversationId,
          channelAccountId: session.widgetId,
          interactionId,
          sender: 'SYSTEM',
          body: 'AGENT_JOINED',
          event: true,
          now,
        });
      return session?.id;
    });
    this.hub.publish({
      tenantId,
      sessionIds: sessionId ? [sessionId] : [],
      agentIds: [actor.userId],
    });
    return { interactionId, state: 'ACTIVE' as const };
  }

  async agentSend(actor: Actor, interactionValue: string, body: unknown) {
    const interactionId = webchatUuid(interactionValue);
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const commandId = webchatUuid(input.commandId, 'VALIDATION_FAILED');
    const text = webchatText(input.text);
    const { tenantId } = actor;
    const result = await this.tenant(tenantId, async (tx) => {
      await this.agent(tx, actor);
      const { session, conversationId } = await this.ownedChat(tx, actor, interactionId, [
        'ACTIVE',
      ]);
      const appended = await this.append(tx, {
        tenantId,
        conversationId,
        channelAccountId: session.widgetId,
        interactionId,
        sender: 'AGENT',
        body: text,
        clientToken: commandId,
        now: this.now(),
      });
      // The chat may have ended while this waited for the conversation; an ended chat takes no new message.
      const current = await tx.interaction.findFirst({
        where: { tenantId, id: interactionId },
        select: { state: true },
      });
      if (current?.state !== 'ACTIVE' && !appended.repeated)
        throw new WebchatError('CHAT_NOT_ACTIVE');
      return { message: appended.message, sessionId: session.id };
    });
    this.hub.publish({ tenantId, sessionIds: [result.sessionId], agentIds: [actor.userId] });
    return { message: result.message };
  }

  async agentEnd(actor: Actor, interactionValue: string) {
    const interactionId = webchatUuid(interactionValue);
    const { tenantId } = actor;
    const notice = await this.tenant(tenantId, async (tx) => {
      await this.agent(tx, actor);
      // ending twice is fine: the second call finds the chat already in wrap-up
      await this.ownedChat(tx, actor, interactionId, ['ACTIVE', 'WRAPUP']);
      return this.end(tx, tenantId, interactionId, 'AGENT_ENDED');
    });
    if (notice) this.hub.publish(notice);
    return { interactionId, state: 'WRAPUP' as const };
  }

  // ───────────────────────────── background round ─────────────────────────────

  /** Finds the tenants that have open chats. Run at start and now and then, e.g. after a restart. */
  async discover(): Promise<void> {
    const tenants = await this.database.tenant.findMany({
      where: { lifecycleStatus: 'ACTIVE' },
      select: { id: true },
    });
    for (const { id } of tenants) {
      const open = await this.tenant(id, (tx) =>
        tx.interaction.count({
          where: {
            tenantId: id,
            channel: 'WEBCHAT',
            state: { in: ['QUEUED', 'ASSIGNED', 'ACTIVE'] },
          },
        }),
      );
      if (open > 0) this.activeTenants.add(id);
    }
  }

  /** Resolves when the rounds started by new chats have finished (tests, shutdown). */
  async settled(): Promise<void> {
    await Promise.all([...this.kicks]);
  }

  async tickAll(): Promise<void> {
    for (const tenantId of [...this.activeTenants]) {
      const open = await this.tick(tenantId);
      if (!open) this.activeTenants.delete(tenantId);
    }
  }

  /** One round for a tenant. Returns whether it still has chats that are queued, offered or active. */
  async tick(tenantId: string): Promise<boolean> {
    const now = this.now();
    const notices: WebchatNotice[] = [];
    const orphaned = await this.tenant(tenantId, (tx) =>
      closeOrphanWebchatOffers(tx, tenantId, now),
    );
    if (orphaned.length) notices.push({ tenantId, agentIds: orphaned });

    const snapshot = await this.tenant(tenantId, async (tx) => {
      const open = await tx.interaction.findMany({
        where: { tenantId, channel: 'WEBCHAT', state: { in: ['QUEUED', 'ASSIGNED', 'ACTIVE'] } },
        select: {
          id: true,
          state: true,
          agentId: true,
          offerExpiresAt: true,
          conversation: { select: { lastCustomerMessageAt: true, lastAgentMessageAt: true } },
        },
        orderBy: [{ queuedAt: 'asc' }, { id: 'asc' }],
      });
      const sessions = await tx.webchatSession.findMany({
        where: { tenantId, interactionId: { in: open.map((row) => row.id) } },
        select: { id: true, interactionId: true, widgetId: true, lastSeenAt: true },
      });
      const widgets = await tx.webchatWidget.findMany({
        where: { tenantId },
        select: { id: true, maxChatsPerAgent: true, idleTimeoutSec: true },
      });
      // an offered Agent who has since taken a call (the rare race with a voice router)
      const onCall = await tx.interaction.findMany({
        where: {
          tenantId,
          channel: { not: 'WEBCHAT' },
          state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] },
          agentId: {
            in: open.flatMap((row) =>
              row.state === 'ASSIGNED' && row.agentId ? [row.agentId] : [],
            ),
          },
        },
        select: { agentId: true },
      });
      return { open, sessions, widgets, onCall: new Set(onCall.map((row) => row.agentId)) };
    });

    const queued: { id: string; maxChatsPerAgent: number }[] = [];
    for (const chat of snapshot.open) {
      const session = snapshot.sessions.find((row) => row.interactionId === chat.id);
      const widget = snapshot.widgets.find((row) => row.id === session?.widgetId);
      const waiting = chat.state === 'QUEUED' || chat.state === 'ASSIGNED';
      if (
        waiting &&
        session &&
        now.getTime() - session.lastSeenAt.getTime() > WEBCHAT_VISITOR_GONE_MS
      ) {
        const notice = await this.tenant(tenantId, (tx) =>
          this.end(tx, tenantId, chat.id, 'CUSTOMER_LEFT'),
        );
        if (notice) notices.push(notice);
        continue;
      }
      if (chat.state === 'ASSIGNED' && chat.agentId) {
        const agentId = chat.agentId;
        const due =
          !chat.offerExpiresAt || chat.offerExpiresAt <= now || snapshot.onCall.has(agentId);
        const released = due
          ? await this.tenant(tenantId, (tx) =>
              releaseWebchatOffer(tx, { tenantId, interactionId: chat.id, agentId, now }),
            )
          : null;
        if (released) {
          notices.push({ tenantId, agentIds: [released.agentId] });
          queued.push({ id: chat.id, maxChatsPerAgent: widget?.maxChatsPerAgent ?? 3 });
        }
        continue;
      }
      if (chat.state === 'ACTIVE') {
        const deadline = webchatIdleDeadline({
          lastCustomerMessageAt: chat.conversation?.lastCustomerMessageAt ?? null,
          lastAgentMessageAt: chat.conversation?.lastAgentMessageAt ?? null,
          idleTimeoutSec: widget?.idleTimeoutSec ?? 600,
        });
        if (deadline && deadline <= now) {
          const notice = await this.tenant(tenantId, (tx) =>
            this.end(tx, tenantId, chat.id, 'IDLE_TIMEOUT'),
          );
          if (notice) notices.push(notice);
        }
        continue;
      }
      if (chat.state === 'QUEUED')
        queued.push({ id: chat.id, maxChatsPerAgent: widget?.maxChatsPerAgent ?? 3 });
    }

    for (const chat of queued) {
      const offer = await this.tenant(tenantId, (tx) =>
        offerQueuedWebchat(tx, {
          tenantId,
          interactionId: chat.id,
          maxChatsPerAgent: chat.maxChatsPerAgent,
          now,
        }),
      );
      if (offer) notices.push({ tenantId, agentIds: [offer.agentId] });
    }
    for (const notice of notices) this.hub.publish(notice);
    return snapshot.open.length > 0;
  }
}
