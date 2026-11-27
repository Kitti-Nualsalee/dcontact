import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { createLineInteraction, isWebchatQueueStaffed } from '@d-contact/router';
import type { AccountSecretBox } from './account-identity.js';
import type { LineChatClient } from './line-chat-client.js';
import { verifyLineSignature } from './line-chat-client.js';
import { lineSealContext } from './line-chat-channel.js';
import { WebchatError, webchatUuid } from './webchat-errors.js';
import type { WebchatHub } from './webchat-hub.js';
import {
  appendChatMessage,
  LINE_OTHER_CONTENT_TYPE,
  type WebchatService,
} from './webchat-service.js';

/**
 * #1054 LINE chat: what a tenant's LINE Official Account receives becomes chat work in the same Router
 * as web chat (ADR-001), and what Agents write goes back to LINE.
 *
 * - LINE calls `POST /api/v1/line/webhook/:tenantId/:channelId`. The body is verified with that
 *   channel's own secret over the exact bytes received before anything is read from it; an unknown,
 *   disabled or mismatching channel answers the same 404.
 * - One LINE user of a channel is one long-lived conversation (ADR-023). A message with no open work
 *   opens a new Interaction in it, carrying over the customer the conversation is linked to.
 * - A LINE message id is the dedupe key (ADR-024), so a redelivered webhook stores nothing twice.
 * - When nobody can take the chat, the channel's auto reply answers once with the event's reply token
 *   (free of the push quota), and the chat still waits in the queue.
 * - An Agent's message is stored QUEUED (the row is the outbox) and pushed by `deliver` with the
 *   message id as LINE's retry key, so a send repeated after a crash reaches the customer once.
 */

type Tx = Prisma.TransactionClient;

/** an Agent's message LINE has not accepted after this long is given up (LINE keeps a retry key 24h) */
export const LINE_DELIVERY_GIVE_UP_MS = 6 * 60 * 60 * 1000;
/** a send claimed by a worker that died is taken again after this long */
const DELIVERY_LEASE_MS = 60_000;
const DELIVERY_BATCH = 20;
const MAX_WEBHOOK_EVENTS = 100;
const PROFILE_REFRESH_MS = 24 * 60 * 60 * 1000;

interface LineWebhookEvent {
  type?: unknown;
  mode?: unknown;
  replyToken?: unknown;
  source?: { type?: unknown; userId?: unknown };
  message?: { id?: unknown; type?: unknown; text?: unknown };
}

export interface LineChatServiceOptions {
  now?: () => Date;
  log?: (event: Record<string, unknown>) => void;
}

function errorFields(error: unknown): { error: string; code: string | null } {
  const code = (error as { code?: unknown } | null)?.code;
  return {
    error: error instanceof Error ? error.name : 'Unknown',
    code: typeof code === 'string' || typeof code === 'number' ? String(code) : null,
  };
}

const LINE_USER = /^U[0-9a-f]{32}$/;
const LINE_MESSAGE_ID = /^[0-9]{1,32}$/;

export class LineChatService {
  private readonly now: () => Date;
  private readonly log: (event: Record<string, unknown>) => void;
  private readonly worker = `${hostname()}:${process.pid}`;
  /** tenants with Agent messages waiting to go to LINE */
  private readonly pendingTenants = new Set<string>();
  /** work started by a webhook or an Agent's message that has not finished yet */
  private readonly running = new Set<Promise<unknown>>();
  /** one delivery round per tenant at a time in this process; a new request waits for the current one */
  private readonly delivering = new Map<string, Promise<boolean>>();

  constructor(
    private readonly database: PrismaClient,
    private readonly box: AccountSecretBox | null,
    private readonly client: LineChatClient,
    private readonly chats: WebchatService,
    private readonly hub: WebchatHub,
    options: LineChatServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((event) => console.error(JSON.stringify(event)));
  }

  private tenant<T>(tenantId: string, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withTenantDatabaseTransaction(this.database, tenantId, work);
  }

  private background(name: string, tenantId: string, work: () => Promise<unknown>) {
    const run = work().catch((error: unknown) =>
      this.log({ event: name, tenantId, ...errorFields(error) }),
    );
    this.running.add(run);
    void run.finally(() => this.running.delete(run));
  }

  /** Resolves when the replies, profile reads and sends started so far have finished (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
    await this.chats.settled();
  }

  private open(tenantId: string, channelId: string, sealed: string, kind: 'secret' | 'token') {
    if (!this.box) throw new WebchatError('SECRET_STORE_UNAVAILABLE');
    return this.box.open(sealed, lineSealContext(tenantId, channelId, kind));
  }

  // ───────────────────────────── from LINE ─────────────────────────────

  /**
   * Handles one webhook call. Throws NOT_FOUND for a channel that is unknown, off, or whose signature or
   * bot does not match, so a caller learns nothing about which it was.
   */
  async webhook(
    tenantValue: string,
    channelValue: string,
    rawBody: Buffer | undefined,
    signature: unknown,
  ): Promise<{ accepted: number }> {
    const tenantId = webchatUuid(tenantValue);
    const channelId = webchatUuid(channelValue);
    if (!rawBody) throw new WebchatError('NOT_FOUND');
    const channel = await this.tenant(tenantId, async (tx) => {
      const tenant = await tx.tenant.findUnique({
        where: { id: tenantId },
        select: { lifecycleStatus: true },
      });
      if (tenant?.lifecycleStatus !== 'ACTIVE') return null;
      return tx.lineChannel.findFirst({ where: { tenantId, id: channelId, enabled: true } });
    });
    if (!channel?.channelSecretSealed || !channel.queueId) throw new WebchatError('NOT_FOUND');
    let secret: string;
    try {
      secret = this.open(tenantId, channelId, channel.channelSecretSealed, 'secret');
    } catch {
      this.log({ event: 'line.secret_unavailable', tenantId });
      throw new WebchatError('NOT_FOUND');
    }
    if (!verifyLineSignature(rawBody, signature, secret)) throw new WebchatError('NOT_FOUND');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new WebchatError('VALIDATION_FAILED');
    }
    const body = (parsed && typeof parsed === 'object' ? parsed : {}) as {
      destination?: unknown;
      events?: unknown;
    };
    // the bot the token belongs to must be the one LINE delivers for
    if (channel.botUserId && body.destination !== channel.botUserId)
      throw new WebchatError('NOT_FOUND');
    const events = Array.isArray(body.events)
      ? (body.events as unknown[]).slice(0, MAX_WEBHOOK_EVENTS)
      : [];
    let accepted = 0;
    for (const item of events) {
      if (!item || typeof item !== 'object') continue;
      const event = item as LineWebhookEvent;
      // "standby" events belong to another module of the account; LINE chat only takes active ones
      if (event.type !== 'message' || (event.mode !== undefined && event.mode !== 'active'))
        continue;
      const userId = event.source?.type === 'user' ? event.source.userId : undefined;
      const messageId = event.message?.id;
      if (
        typeof userId !== 'string' ||
        !LINE_USER.test(userId) ||
        typeof messageId !== 'string' ||
        !LINE_MESSAGE_ID.test(messageId)
      )
        continue;
      const messageType = typeof event.message?.type === 'string' ? event.message.type : 'unknown';
      const text =
        messageType === 'text' && typeof event.message?.text === 'string'
          ? event.message.text.replace(/\r\n?/g, '\n').slice(0, 5000)
          : null;
      // One event that cannot be stored must not lose the others of the same delivery. A failure here is
      // a fault on our side (the database), not a bad request: LINE does not resend, so it is logged.
      try {
        await this.receive(tenantId, channelId, {
          userId,
          messageId,
          messageType,
          text,
          replyToken: typeof event.replyToken === 'string' ? event.replyToken : null,
        });
        accepted += 1;
      } catch (error) {
        this.log({ event: 'line.receive_failed', tenantId, ...errorFields(error) });
      }
    }
    return { accepted };
  }

  private async receive(
    tenantId: string,
    channelId: string,
    message: {
      userId: string;
      messageId: string;
      messageType: string;
      text: string | null;
      replyToken: string | null;
    },
  ) {
    const now = this.now();
    const result = await this.tenant(tenantId, async (tx) => {
      const channel = await tx.lineChannel.findFirst({
        where: { tenantId, id: channelId, enabled: true },
      });
      if (!channel?.queueId) return null;
      // One writer per LINE user: two first messages arriving together open a single piece of work.
      await tx.$executeRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:line-user:${tenantId}:${channelId}:${message.userId}`}, 0))`,
      );
      let user = await tx.lineChatUser.findFirst({
        where: { tenantId, channelId, lineUserId: message.userId },
      });
      if (!user) {
        const conversation = await tx.conversation.create({
          data: {
            tenantId,
            channel: 'LINE',
            channelAccountId: channelId,
            externalThreadId: message.userId,
            state: 'OPEN',
          },
          select: { id: true },
        });
        user = await tx.lineChatUser.create({
          data: {
            tenantId,
            channelId,
            lineUserId: message.userId,
            conversationId: conversation.id,
          },
        });
      }
      const conversationId = user.conversationId;
      // a redelivered webhook: the message is already stored
      const known = await tx.message.findFirst({
        where: { tenantId, channelAccountId: channelId, providerMessageId: message.messageId },
        select: { id: true },
      });
      if (known) return null;
      let work = await tx.interaction.findFirst({
        where: {
          tenantId,
          conversationId,
          channel: 'LINE',
          state: { in: ['QUEUED', 'ASSIGNED', 'ACTIVE'] },
        },
        select: { id: true, agentId: true },
        orderBy: [{ queuedAt: 'desc' }],
      });
      let opened = false;
      let autoReply: string | null = null;
      if (!work) {
        // Unlike a web visitor, a LINE customer cannot be told "try later" and waits anyway: the queue has
        // no cap, so no message is ever dropped.
        const conversation = await tx.conversation.findFirst({
          where: { tenantId, id: conversationId },
          select: { contactId: true },
        });
        // carry the customer over only while their Customer 360 identity is still in use
        const head = conversation?.contactId
          ? await tx.c360IdentityHead.findUnique({
              where: { tenantId_contactId: { tenantId, contactId: conversation.contactId } },
              select: { state: true },
            })
          : null;
        const id = await createLineInteraction(tx, {
          tenantId,
          queueId: channel.queueId,
          conversationId,
          contactId: head?.state === 'ACTIVE' ? conversation!.contactId : null,
          channelId,
          lineUserId: message.userId,
          now,
        });
        work = { id, agentId: null };
        opened = true;
        if (
          channel.autoReplyText &&
          message.replyToken &&
          !(await isWebchatQueueStaffed(tx, tenantId, channel.queueId))
        )
          autoReply = channel.autoReplyText;
      }
      await appendChatMessage(tx, {
        tenantId,
        conversationId,
        channelAccountId: channelId,
        interactionId: work.id,
        sender: 'CONTACT',
        body: message.text ?? message.messageType.slice(0, 32),
        ...(message.text === null ? { contentType: LINE_OTHER_CONTENT_TYPE } : {}),
        providerMessageId: message.messageId,
        // what a LINE customer writes is never refused: they cannot be told to stop
        unlimited: true,
        now,
      });
      // Claim the profile read now, so a burst of messages before LINE answers asks for it once.
      const stale =
        !user.profileFetchedAt ||
        now.getTime() - user.profileFetchedAt.getTime() > PROFILE_REFRESH_MS;
      if (stale)
        await tx.lineChatUser.update({
          where: { tenantId_id: { tenantId, id: user.id } },
          data: { profileFetchedAt: now },
        });
      return {
        interactionId: work.id,
        agentId: work.agentId,
        opened,
        autoReply,
        token: channel.accessTokenSealed,
        profileUserId: stale ? user.id : null,
      };
    });
    if (!result) return;
    this.hub.publish({ tenantId, agentIds: result.agentId ? [result.agentId] : [] });
    if (result.opened) this.chats.kick(tenantId);
    const sealedToken = result.token;
    if (!sealedToken) return;
    if (result.autoReply && message.replyToken) {
      const replyToken = message.replyToken;
      const text = result.autoReply;
      this.background('line.auto_reply_failed', tenantId, async () => {
        const token = this.open(tenantId, channelId, sealedToken, 'token');
        const outcome = await this.client.reply(token, replyToken, text);
        if (outcome.kind !== 'OK') {
          this.log({
            event: 'line.auto_reply_failed',
            tenantId,
            outcome: outcome.kind,
            status: 'status' in outcome ? outcome.status : null,
          });
          return;
        }
        await this.tenant(tenantId, (tx) =>
          tx.interactionEvent.create({
            data: {
              tenantId,
              interactionId: result.interactionId,
              type: 'interaction.auto_replied',
              payload: { channel: 'LINE' },
            },
          }),
        );
      });
    }
    if (result.profileUserId) {
      const rowId = result.profileUserId;
      this.background('line.profile_failed', tenantId, async () => {
        const token = this.open(tenantId, channelId, sealedToken, 'token');
        const profile = await this.client.profile(token, message.userId);
        await this.tenant(tenantId, (tx) =>
          tx.lineChatUser.update({
            where: { tenantId_id: { tenantId, id: rowId } },
            data: profile ? { displayName: profile.displayName } : {},
          }),
        );
        // the Agent's list shows the name as soon as it is known
        if (profile) this.notifyConversation(tenantId, rowId);
      });
    }
  }

  private notifyConversation(tenantId: string, lineUserRowId: string) {
    this.background('line.notify_failed', tenantId, async () => {
      const agentIds = await this.tenant(tenantId, async (tx) => {
        const user = await tx.lineChatUser.findFirst({
          where: { tenantId, id: lineUserRowId },
          select: { conversationId: true },
        });
        if (!user) return [];
        const open = await tx.interaction.findMany({
          where: {
            tenantId,
            conversationId: user.conversationId,
            agentId: { not: null },
            state: { in: ['ASSIGNED', 'ACTIVE', 'WRAPUP'] },
          },
          select: { agentId: true },
        });
        return open.flatMap((row) => (row.agentId ? [row.agentId] : []));
      });
      if (agentIds.length) this.hub.publish({ tenantId, agentIds });
    });
  }

  // ───────────────────────────── to LINE ─────────────────────────────

  /** An Agent's message is waiting: send it now instead of at the next background round. */
  kickDelivery(tenantId: string): void {
    this.pendingTenants.add(tenantId);
    this.background('line.delivery_failed', tenantId, () => this.deliver(tenantId));
  }

  /** Finds the tenants with LINE messages waiting, e.g. after a restart. */
  async discover(): Promise<void> {
    const tenants = await this.database.tenant.findMany({
      where: { lifecycleStatus: 'ACTIVE' },
      select: { id: true },
    });
    for (const { id } of tenants) {
      const waiting = await this.tenant(id, (tx) =>
        tx.message.count({
          where: {
            tenantId: id,
            status: { in: ['QUEUED', 'SENDING'] },
            conversation: { channel: 'LINE' },
          },
        }),
      );
      if (waiting > 0) this.pendingTenants.add(id);
    }
  }

  async deliverAll(): Promise<void> {
    for (const tenantId of [...this.pendingTenants]) {
      try {
        const more = await this.deliver(tenantId);
        if (!more) this.pendingTenants.delete(tenantId);
      } catch (error) {
        this.log({ event: 'line.delivery_failed', tenantId, ...errorFields(error) });
      }
    }
  }

  /** Sends what is due for one tenant. Returns whether messages are still waiting (retries). */
  deliver(tenantId: string): Promise<boolean> {
    const previous = this.delivering.get(tenantId) ?? Promise.resolve(true);
    const next = previous.catch(() => true).then(() => this.deliverRound(tenantId));
    this.delivering.set(tenantId, next);
    void next
      .finally(() => {
        if (this.delivering.get(tenantId) === next) this.delivering.delete(tenantId);
      })
      .catch(() => undefined);
    return next;
  }

  private async deliverRound(tenantId: string): Promise<boolean> {
    const now = this.now();
    // each round claims with its own token, so a round never records over another one's send
    const claim = `${this.worker}:${randomUUID()}`;
    const claimed = await this.tenant(tenantId, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          body: string;
          conversation_id: string;
          interaction_id: string | null;
          channel_account_id: string;
          created_at: Date;
        }[]
      >(Prisma.sql`
        SELECT m.id, m.body, m.conversation_id, m.interaction_id, m.channel_account_id, m.created_at
        FROM messages m
        JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
        WHERE m.tenant_id = ${tenantId}::uuid AND c.channel = 'LINE' AND m.sender_type = 'AGENT'
          AND ((m.status = 'QUEUED'
              AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ${now.toISOString()}::timestamp))
            OR (m.status = 'SENDING'
              AND m.locked_at < ${new Date(now.getTime() - DELIVERY_LEASE_MS).toISOString()}::timestamp))
        ORDER BY m.created_at, m.id
        LIMIT ${DELIVERY_BATCH}
        FOR UPDATE OF m SKIP LOCKED`);
      for (const row of rows)
        await tx.message.update({
          where: { id: row.id },
          data: {
            status: 'SENDING',
            lockedAt: now,
            lockedBy: claim,
            attempts: { increment: 1 },
          },
        });
      return rows;
    });
    const touched = new Set<string>();
    for (const message of claimed) {
      // renew the lease right before the send: LINE may have been slow with the ones before it
      const held = await this.tenant(tenantId, (tx) =>
        tx.message.updateMany({
          where: { tenantId, id: message.id, status: 'SENDING', lockedBy: claim },
          data: { lockedAt: this.now() },
        }),
      );
      if (held.count === 0) continue;
      const outcome = await this.sendOne(tenantId, message);
      await this.tenant(tenantId, (tx) => this.record(tx, tenantId, message, outcome, claim));
      if (message.interaction_id) touched.add(message.interaction_id);
    }
    if (touched.size) {
      const agentIds = await this.tenant(tenantId, async (tx) => {
        const rows = await tx.interaction.findMany({
          where: { tenantId, id: { in: [...touched] }, agentId: { not: null } },
          select: { agentId: true },
        });
        return rows.flatMap((row) => (row.agentId ? [row.agentId] : []));
      });
      if (agentIds.length) this.hub.publish({ tenantId, agentIds });
    }
    const waiting = await this.tenant(tenantId, (tx) =>
      tx.message.count({
        where: {
          tenantId,
          senderType: 'AGENT',
          status: { in: ['QUEUED', 'SENDING'] },
          conversation: { channel: 'LINE' },
        },
      }),
    );
    return waiting > 0;
  }

  private async sendOne(
    tenantId: string,
    message: { id: string; body: string; conversation_id: string; channel_account_id: string },
  ) {
    const target = await this.tenant(tenantId, async (tx) => {
      const user = await tx.lineChatUser.findFirst({
        where: { tenantId, conversationId: message.conversation_id },
        select: { lineUserId: true, channelId: true },
      });
      const channel = user
        ? await tx.lineChannel.findFirst({
            where: { tenantId, id: user.channelId },
            select: { accessTokenSealed: true, enabled: true },
          })
        : null;
      // a channel the Admin turned off sends nothing more
      if (channel && !channel.enabled) return 'OFF' as const;
      return user && channel?.accessTokenSealed
        ? { userId: user.lineUserId, channelId: user.channelId, sealed: channel.accessTokenSealed }
        : null;
    });
    if (target === 'OFF') return { kind: 'CHANNEL_OFF' as const };
    if (!target) return { kind: 'REJECTED' as const, status: 0 };
    let token: string;
    try {
      token = this.open(tenantId, target.channelId, target.sealed, 'token');
    } catch {
      return { kind: 'RETRY' as const, status: null, retryAfterSec: null };
    }
    // the message id is LINE's retry key: a push repeated after a crash is delivered once
    return this.client.push(token, target.userId, message.body, message.id);
  }

  private async record(
    tx: Tx,
    tenantId: string,
    message: { id: string; created_at: Date },
    outcome: Awaited<ReturnType<LineChatService['sendOne']>>,
    claim: string,
  ) {
    const now = this.now();
    const current = await tx.message.findFirst({
      where: { tenantId, id: message.id },
      select: { attempts: true, lockedBy: true, status: true },
    });
    // another worker took the send over after this one's lease ran out
    if (current?.status !== 'SENDING' || current.lockedBy !== claim) return;
    const done = { lockedAt: null, lockedBy: null };
    if (outcome.kind === 'OK' || outcome.kind === 'ALREADY_ACCEPTED') {
      await tx.message.update({
        where: { id: message.id },
        data: { ...done, status: 'SENT', sentAt: now, nextAttemptAt: null },
      });
      return;
    }
    // created_at is stored without a zone and read as UTC, like every DateTime here
    const tooOld = now.getTime() - message.created_at.getTime() > LINE_DELIVERY_GIVE_UP_MS;
    if (outcome.kind === 'REJECTED' || outcome.kind === 'CHANNEL_OFF' || tooOld) {
      await tx.message.update({
        where: { id: message.id },
        data: {
          ...done,
          status: 'FAILED',
          nextAttemptAt: null,
          failureCode:
            outcome.kind === 'REJECTED'
              ? `LINE_${outcome.status}`
              : outcome.kind === 'CHANNEL_OFF'
                ? 'LINE_CHANNEL_OFF'
                : 'LINE_GAVE_UP',
        },
      });
      return;
    }
    const backoffSec = outcome.retryAfterSec ?? Math.min(300, 2 ** Math.min(current.attempts, 8));
    await tx.message.update({
      where: { id: message.id },
      data: {
        ...done,
        status: 'QUEUED',
        nextAttemptAt: new Date(now.getTime() + backoffSec * 1000),
        failureCode: outcome.status ? `LINE_${outcome.status}` : 'LINE_NETWORK',
      },
    });
  }
}
