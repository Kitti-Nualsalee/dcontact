import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { AccountSecretBox } from './account-identity.js';
import { readAgentHistory, readAgentHistoryTranscript } from './agent-history.js';
import { saveAgentWrapup } from './agent-wrapup-v1.js';
import { readLineChannel, saveLineChannel } from './line-chat-channel.js';
import type { LineCallOutcome, LineChatClient } from './line-chat-client.js';
import { LineChatService } from './line-chat-service.js';
import { readTeamHistoryTranscript } from './team-history.js';
import { WebchatError } from './webchat-errors.js';
import { WebchatHub } from './webchat-hub.js';
import { WebchatService } from './webchat-service.js';
import { saveWebchatWidget } from './webchat-widget.js';

/** #1054 LINE chat from the webhook to the history, against a fake LINE. */

const owner = new PrismaClient();
// The application role does not bypass RLS, as in production.
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});
after(async () => {
  await Promise.all([owner.$disconnect(), application.$disconnect()]);
});

const box = new AccountSecretBox(randomBytes(32).toString('base64'));
const SECRET = 'a'.repeat(32);
const TOKEN = 'line-token-0123456789abcdefghij';
const BOT = `U${'b'.repeat(32)}`;

/** a LINE that records what it was asked and answers what the test says */
class FakeLine {
  pushes: { to: string; text: string; retryKey: string }[] = [];
  replies: { replyToken: string; text: string }[] = [];
  pushOutcome: LineCallOutcome = { kind: 'OK', body: {} };
  tokenAccepted = true;
  async botInfo(token: string) {
    return this.tokenAccepted && token === TOKEN ? { userId: BOT, displayName: 'Demo Shop' } : null;
  }
  async profile(_token: string, userId: string) {
    return { displayName: `Khun ${userId.slice(1, 5)}` };
  }
  async push(_token: string, to: string, text: string, retryKey: string) {
    this.pushes.push({ to, text, retryKey });
    return this.pushOutcome;
  }
  async reply(_token: string, replyToken: string, text: string) {
    this.replies.push({ replyToken, text });
    return { kind: 'OK', body: {} } as LineCallOutcome;
  }
}

async function user(
  tenantId: string,
  teamId: string | null,
  role: 'AGENT' | 'SUPERVISOR' | 'ADMIN',
  state: 'AVAILABLE' | 'OFFLINE' = 'AVAILABLE',
) {
  const id = randomUUID();
  await owner.user.create({
    data: {
      id,
      tenantId,
      teamId,
      role,
      displayName: `${role} ${id.slice(0, 4)}`,
      email: `${id}@test.invalid`,
      passwordHash: 'unused',
    },
  });
  if (role === 'AGENT') await owner.agentStateLog.create({ data: { tenantId, userId: id, state } });
  return { tenantId, userId: id };
}

async function fixture(options: { agentState?: 'AVAILABLE' | 'OFFLINE'; autoReply?: string } = {}) {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const queueId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Demo Retail',
      slug: `line-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Chat' } });
  await owner.queue.create({
    data: { id: queueId, tenantId, teamId, name: 'LINE', channels: ['LINE'] },
  });
  const admin = await user(tenantId, null, 'ADMIN');
  const supervisor = await user(tenantId, teamId, 'SUPERVISOR');
  const agent = await user(tenantId, teamId, 'AGENT', options.agentState ?? 'AVAILABLE');
  const line = new FakeLine();
  const client = line as unknown as LineChatClient;
  const saved = await saveLineChannel(
    application,
    { box, client },
    admin,
    {
      expectedRevision: 0,
      enabled: true,
      queueId,
      lineChannelId: '1650000000',
      channelSecret: SECRET,
      accessToken: TOKEN,
      autoReplyText: options.autoReply ?? '',
      idleTimeoutSec: 600,
    },
    'test',
  );
  const channelId = saved.channel.id!;
  let now = new Date();
  const hub = new WebchatHub();
  const chats = new WebchatService(application, hub, { now: () => now });
  const service = new LineChatService(application, box, client, chats, hub, { now: () => now });
  chats.onOutbox((tenant) => service.kickDelivery(tenant));
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const lineUser = `U${randomBytes(16).toString('hex')}`;
  let messageId = 100_000 + Math.floor(Math.random() * 1_000_000);
  /** the customer writes on LINE; returns the webhook body it was sent with */
  const write = async (
    text: string | null,
    options: { id?: string; user?: string; destination?: string; secret?: string } = {},
  ) => {
    const id = options.id ?? String((messageId += 1));
    const body = Buffer.from(
      JSON.stringify({
        destination: options.destination ?? BOT,
        events: [
          {
            type: 'message',
            mode: 'active',
            replyToken: `reply-${id}`,
            webhookEventId: `event-${id}`,
            source: { type: 'user', userId: options.user ?? lineUser },
            message: text === null ? { id, type: 'sticker' } : { id, type: 'text', text },
          },
        ],
      }),
    );
    const signature = createHmac('sha256', options.secret ?? SECRET)
      .update(body)
      .digest('base64');
    const result = await service.webhook(tenantId, channelId, body, signature);
    await service.settled();
    return { id, result };
  };
  return {
    tenantId,
    teamId,
    queueId,
    channelId,
    admin,
    supervisor,
    agent,
    line,
    client,
    chats,
    service,
    advance,
    lineUser,
    write,
  };
}

const code = (expected: string) => (error: unknown) =>
  error instanceof WebchatError && error.code === expected;

test('the Admin saves the LINE channel; the secret and token never come back and the audit holds no secret', async () => {
  const f = await fixture();
  const read = await readLineChannel(application, f.supervisor);
  assert.equal(read.canEdit, false);
  assert.equal(read.channel.hasChannelSecret, true);
  assert.equal(read.channel.hasAccessToken, true);
  assert.equal(read.channel.accessTokenHint, TOKEN.slice(-4));
  assert.equal(read.channel.botName, 'Demo Shop');
  assert.equal(read.channel.webhookPath, `/api/v1/line/webhook/${f.tenantId}/${f.channelId}`);
  const text = JSON.stringify(read);
  assert.ok(!text.includes(SECRET) && !text.includes(TOKEN));
  const audits = await owner.lineChannelAuditEvent.findMany({ where: { tenantId: f.tenantId } });
  assert.equal(audits.length, 1);
  assert.ok(!JSON.stringify(audits).includes(SECRET) && !JSON.stringify(audits).includes(TOKEN));
  assert.deepEqual(audits[0]!.changedKeys.includes('accessToken'), true);
  // the stored values are sealed, and bound to this tenant and channel
  const row = await owner.lineChannel.findFirstOrThrow({ where: { tenantId: f.tenantId } });
  assert.ok(row.channelSecretSealed && !row.channelSecretSealed.includes(SECRET));

  // a save without the secrets keeps them; a Supervisor cannot save
  const kept = await saveLineChannel(
    application,
    { box, client: f.client },
    f.admin,
    {
      expectedRevision: 1,
      enabled: true,
      queueId: f.queueId,
      lineChannelId: '1650000000',
      autoReplyText: 'We will be with you soon',
      idleTimeoutSec: 900,
    },
    'test',
  );
  assert.equal(kept.channel.hasAccessToken, true);
  assert.equal(kept.channel.autoReplyText, 'We will be with you soon');
  await assert.rejects(
    saveLineChannel(
      application,
      { box, client: f.client },
      f.supervisor,
      { ...{ expectedRevision: 2, enabled: false, queueId: null, idleTimeoutSec: 600 } },
      'test',
    ),
    code('FORBIDDEN'),
  );
  // a token LINE does not accept is refused before anything is stored
  f.line.tokenAccepted = false;
  await assert.rejects(
    saveLineChannel(
      application,
      { box, client: f.client },
      f.admin,
      {
        expectedRevision: 2,
        enabled: true,
        queueId: f.queueId,
        accessToken: 'another-token-0123456789abcdef',
        idleTimeoutSec: 600,
      },
      'test',
    ),
    code('LINE_TOKEN_REJECTED'),
  );
  // a stale revision is refused
  await assert.rejects(
    saveLineChannel(
      application,
      { box, client: f.client },
      f.admin,
      { expectedRevision: 1, enabled: false, queueId: null, idleTimeoutSec: 600 },
      'test',
    ),
    code('REVISION_CONFLICT'),
  );
});

test('a webhook with a wrong signature, another bot or an unknown channel stores nothing', async () => {
  const f = await fixture();
  await assert.rejects(f.write('hello', { secret: 'b'.repeat(32) }), code('NOT_FOUND'));
  await assert.rejects(f.write('hello', { destination: `U${'c'.repeat(32)}` }), code('NOT_FOUND'));
  await assert.rejects(
    f.service.webhook(f.tenantId, randomUUID(), Buffer.from('{}'), 'x'),
    code('NOT_FOUND'),
  );
  // LINE's "Verify" button sends no events and must be answered
  const empty = Buffer.from(JSON.stringify({ destination: BOT, events: [] }));
  const signature = createHmac('sha256', SECRET).update(empty).digest('base64');
  assert.deepEqual(await f.service.webhook(f.tenantId, f.channelId, empty, signature), {
    accepted: 0,
  });
  assert.equal(await owner.message.count({ where: { tenantId: f.tenantId } }), 0);
});

test('LINE message → queue → offer → Agent replies by push → wrap-up → history; a redelivery stores nothing twice', async () => {
  const f = await fixture();
  const first = await f.write('Where is my order?');
  // the same webhook delivered again
  await f.write('Where is my order?', { id: first.id });
  assert.equal(await owner.message.count({ where: { tenantId: f.tenantId } }), 1);
  const offered = await f.chats.agentChats(f.agent);
  assert.equal(offered.chats.length, 1);
  const chat = offered.chats[0]!;
  assert.equal(chat.channel, 'LINE');
  assert.equal(chat.state, 'ASSIGNED');
  assert.equal(chat.origin, 'Demo Shop');
  assert.equal(chat.visitorOnline, null);
  // the name LINE gave for the user replaces the placeholder
  assert.equal(chat.visitorLabel, `Khun ${f.lineUser.slice(1, 5)}`);

  await f.chats.agentAccept(f.agent, chat.interactionId);
  const sent = await f.chats.agentSend(f.agent, chat.interactionId, {
    commandId: randomUUID(),
    text: 'Let me check',
  });
  assert.equal(sent.message.delivery, 'SENDING');
  await f.service.settled();
  assert.equal(f.line.pushes.length, 1);
  assert.deepEqual(f.line.pushes[0], {
    to: f.lineUser,
    text: 'Let me check',
    retryKey: sent.message.id,
  });
  const deliveries = await f.chats.agentDeliveries(f.agent, chat.interactionId);
  assert.deepEqual(deliveries.deliveries, [{ id: sent.message.id, delivery: 'SENT' }]);

  await f.write(null);
  const messages = await f.chats.agentMessages(f.agent, chat.interactionId);
  assert.deepEqual(
    messages.messages.map((message) => message.text ?? message.event ?? message.other),
    ['Where is my order?', 'AGENT_JOINED', 'Let me check', 'sticker'],
  );

  await f.chats.agentEnd(f.agent, chat.interactionId);
  await saveAgentWrapup(application, f.agent, chat.interactionId, {
    disposition: 'CUSTOMER_ASSISTED',
    note: 'Order located',
    commandId: randomUUID(),
  });
  const state = await owner.agentStateLog.findFirst({
    where: { tenantId: f.tenantId, userId: f.agent.userId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  });
  assert.equal(state?.state, 'AVAILABLE');
  const mine = await readAgentHistory(application, f.agent, { channel: 'LINE' });
  assert.equal(mine.items.length, 1);
  const transcript = await readAgentHistoryTranscript(application, f.agent, chat.interactionId);
  assert.equal(transcript.channel, 'LINE');
  assert.equal(transcript.endReason, 'AGENT_ENDED');
  assert.equal(transcript.visitorLabel, `Khun ${f.lineUser.slice(1, 5)}`);
  // the four messages and the line the end wrote
  assert.equal(transcript.messages.length, 5);
  assert.equal(transcript.messages[4]!.event, 'AGENT_ENDED');
  assert.equal(transcript.messages[3]!.other, 'sticker');
  assert.equal(
    (await readTeamHistoryTranscript(application, f.supervisor, chat.interactionId)).messages
      .length,
    5,
  );

  // the customer writes again: new work in the same conversation
  await f.write('One more question');
  const next = (await f.chats.agentChats(f.agent)).chats;
  assert.equal(next.length, 1);
  assert.notEqual(next[0]!.interactionId, chat.interactionId);
  const conversations = await owner.conversation.count({ where: { tenantId: f.tenantId } });
  assert.equal(conversations, 1);
});

test('a customer the conversation is linked to is carried over to the next work', async () => {
  const f = await fixture();
  await f.write('hello');
  const chat = (await f.chats.agentChats(f.agent)).chats[0]!;
  const contact = await owner.contact.create({
    data: { tenantId: f.tenantId, displayName: 'Somchai' },
  });
  await owner.c360IdentityHead.create({
    data: {
      tenantId: f.tenantId,
      contactId: contact.id,
      canonicalContactId: contact.id,
      stateDigest: '0'.repeat(64),
    },
  });
  // what linking the customer to LINE work does to the conversation (customer-360 profile-work)
  const conversation = await owner.conversation.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  await owner.conversation.update({
    where: { id: conversation.id },
    data: { contactId: contact.id },
  });
  await f.chats.agentAccept(f.agent, chat.interactionId);
  await f.chats.agentEnd(f.agent, chat.interactionId);
  await saveAgentWrapup(application, f.agent, chat.interactionId, {
    disposition: 'CUSTOMER_ASSISTED',
    note: 'done',
    commandId: randomUUID(),
  });
  await f.write('hello again');
  const next = await owner.interaction.findFirstOrThrow({
    where: { tenantId: f.tenantId, state: { in: ['QUEUED', 'ASSIGNED'] } },
  });
  assert.equal(next.contactId, contact.id);
  assert.equal(next.customerLinkRevision, 1n);
});

test('with nobody online the auto reply answers once, free of the push quota, and the chat waits', async () => {
  const f = await fixture({ agentState: 'OFFLINE', autoReply: 'We are away, we will answer soon' });
  const first = await f.write('anyone there?');
  await f.write('hello?');
  assert.deepEqual(f.line.replies, [
    { replyToken: `reply-${first.id}`, text: 'We are away, we will answer soon' },
  ]);
  assert.equal(f.line.pushes.length, 0);
  const waiting = await owner.interaction.findMany({ where: { tenantId: f.tenantId } });
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0]!.state, 'QUEUED');
  // the Agent signs in later and is offered the waiting chat
  await owner.agentStateLog.create({
    data: { tenantId: f.tenantId, userId: f.agent.userId, state: 'AVAILABLE' },
  });
  await f.chats.tick(f.tenantId);
  assert.equal((await f.chats.agentChats(f.agent)).chats[0]?.state, 'ASSIGNED');
});

test('a push LINE refuses fails; one LINE cannot take now is retried later with the same retry key', async () => {
  const f = await fixture();
  await f.write('hello');
  const chat = (await f.chats.agentChats(f.agent)).chats[0]!;
  await f.chats.agentAccept(f.agent, chat.interactionId);

  f.line.pushOutcome = { kind: 'RETRY', status: 429, retryAfterSec: 30 };
  const later = await f.chats.agentSend(f.agent, chat.interactionId, {
    commandId: randomUUID(),
    text: 'first',
  });
  await f.service.settled();
  let row = await owner.message.findFirstOrThrow({ where: { id: later.message.id } });
  assert.equal(row.status, 'QUEUED');
  assert.equal(row.failureCode, 'LINE_429');
  // not due yet
  await f.service.deliver(f.tenantId);
  assert.equal(f.line.pushes.length, 1);
  f.advance(31_000);
  f.line.pushOutcome = { kind: 'ALREADY_ACCEPTED' };
  await f.service.deliver(f.tenantId);
  assert.equal(f.line.pushes.length, 2);
  assert.equal(f.line.pushes[1]!.retryKey, later.message.id);
  row = await owner.message.findFirstOrThrow({ where: { id: later.message.id } });
  assert.equal(row.status, 'SENT');

  f.line.pushOutcome = { kind: 'REJECTED', status: 400 };
  const refused = await f.chats.agentSend(f.agent, chat.interactionId, {
    commandId: randomUUID(),
    text: 'second',
  });
  await f.service.settled();
  row = await owner.message.findFirstOrThrow({ where: { id: refused.message.id } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.failureCode, 'LINE_400');
  const view = await f.chats.agentMessages(f.agent, chat.interactionId);
  assert.equal(view.messages.at(-1)?.delivery, 'FAILED');
});

test('LINE and web chat share the Agent chat limit; a silent LINE chat closes for idleness', async () => {
  const f = await fixture();
  // web chat's settings hold the limit of chats an Agent takes at once
  await saveWebchatWidget(
    application,
    f.admin,
    {
      expectedRevision: 0,
      enabled: true,
      queueId: f.queueId,
      allowedOrigins: ['https://shop.test'],
      greetingTh: '',
      greetingEn: '',
      maxChatsPerAgent: 1,
      idleTimeoutSec: 600,
    },
    'test',
  );
  await f.write('first customer');
  await f.write('second customer', { user: `U${randomBytes(16).toString('hex')}` });
  const held = (await f.chats.agentChats(f.agent)).chats;
  assert.equal(held.length, 1);
  assert.equal(
    await owner.interaction.count({ where: { tenantId: f.tenantId, state: 'QUEUED' } }),
    1,
  );

  await f.chats.agentAccept(f.agent, held[0]!.interactionId);
  await f.chats.agentSend(f.agent, held[0]!.interactionId, {
    commandId: randomUUID(),
    text: 'Anything else?',
  });
  await f.service.settled();
  f.advance(601_000);
  await f.chats.tick(f.tenantId);
  const closed = await owner.interaction.findFirstOrThrow({
    where: { id: held[0]!.interactionId },
  });
  assert.equal(closed.state, 'WRAPUP');
  const reason = await owner.message.findFirst({
    where: { interactionId: closed.id, body: 'IDLE_TIMEOUT' },
  });
  assert.ok(reason);
});

test('a broken event does not lose the others; two first messages at once open one piece of work', async () => {
  const f = await fixture();
  const body = Buffer.from(
    JSON.stringify({
      destination: BOT,
      events: [
        null,
        { type: 'message', source: { type: 'user', userId: 'not-a-user' }, message: { id: '1' } },
        {
          type: 'message',
          mode: 'active',
          source: { type: 'user', userId: f.lineUser },
          message: { id: '7001', type: 'text', text: 'still here' },
        },
      ],
    }),
  );
  const signature = createHmac('sha256', SECRET).update(body).digest('base64');
  assert.deepEqual(await f.service.webhook(f.tenantId, f.channelId, body, signature), {
    accepted: 1,
  });
  // a signed body that is not an object names no bot: refused like any other mismatch, not a crash
  const odd = Buffer.from('null');
  await assert.rejects(
    f.service.webhook(
      f.tenantId,
      f.channelId,
      odd,
      createHmac('sha256', SECRET).update(odd).digest('base64'),
    ),
    code('NOT_FOUND'),
  );
  const other = `U${randomBytes(16).toString('hex')}`;
  await Promise.all([f.write('first', { user: other }), f.write('second', { user: other })]);
  await f.service.settled();
  const opened = await owner.interaction.count({
    where: { tenantId: f.tenantId, conversation: { externalThreadId: other } },
  });
  assert.equal(opened, 1);
});

test('a message to a channel the Admin turned off is not sent; with only web chat on LINE work is left alone', async () => {
  const f = await fixture();
  await f.write('hello');
  const chat = (await f.chats.agentChats(f.agent)).chats[0]!;
  await f.chats.agentAccept(f.agent, chat.interactionId);
  await owner.lineChannel.updateMany({ where: { tenantId: f.tenantId }, data: { enabled: false } });
  const sent = await f.chats.agentSend(f.agent, chat.interactionId, {
    commandId: randomUUID(),
    text: 'are you there?',
  });
  await f.service.settled();
  const row = await owner.message.findFirstOrThrow({ where: { id: sent.message.id } });
  assert.equal(row.status, 'FAILED');
  assert.equal(row.failureCode, 'LINE_CHANNEL_OFF');
  assert.equal(f.line.pushes.length, 0);

  // a deployment that turned LINE chat off: its round and the Agent's list leave LINE work alone
  const webOnly = new WebchatService(application, new WebchatHub(), { channels: ['WEBCHAT'] });
  assert.deepEqual((await webOnly.agentChats(f.agent)).chats, []);
  await assert.rejects(
    webOnly.agentSend(f.agent, chat.interactionId, { commandId: randomUUID(), text: 'x' }),
    code('NOT_FOUND'),
  );
});
