import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  readAgentHistory,
  readAgentHistorySummary,
  readAgentHistoryTranscript,
} from './agent-history.js';
import { saveAgentWrapup } from './agent-wrapup-v1.js';
import {
  readTeamHistory,
  readTeamHistorySummary,
  readTeamHistoryTranscript,
} from './team-history.js';
import { WebchatError } from './webchat-errors.js';
import { WebchatHub, type WebchatNotice } from './webchat-hub.js';
import { WEBCHAT_VISITOR_GONE_MS, WebchatService } from './webchat-service.js';
import { readWebchatWidget, saveWebchatWidget } from './webchat-widget.js';

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

async function user(
  tenantId: string,
  teamId: string | null,
  role: 'AGENT' | 'SUPERVISOR' | 'ADMIN',
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
  if (role === 'AGENT')
    await owner.agentStateLog.create({ data: { tenantId, userId: id, state: 'AVAILABLE' } });
  return { tenantId, userId: id };
}

async function fixture(options: { agents?: number; idleTimeoutSec?: number } = {}) {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const queueId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Demo Retail',
      slug: `webchat-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Chat' } });
  await owner.queue.create({
    data: { id: queueId, tenantId, teamId, name: 'Web chat', channels: ['WEBCHAT'] },
  });
  const admin = await user(tenantId, null, 'ADMIN');
  const supervisor = await user(tenantId, teamId, 'SUPERVISOR');
  const agents = [];
  for (let index = 0; index < (options.agents ?? 1); index++)
    agents.push(await user(tenantId, teamId, 'AGENT'));
  const saved = await saveWebchatWidget(
    application,
    admin,
    {
      expectedRevision: 0,
      enabled: true,
      queueId,
      allowedOrigins: ['https://shop.test/'],
      greetingTh: 'hello th',
      greetingEn: 'hello en',
      maxChatsPerAgent: 2,
      idleTimeoutSec: options.idleTimeoutSec ?? 600,
    },
    'test',
  );
  const widgetId = saved.widget.id!;
  let now = new Date();
  const notices: WebchatNotice[] = [];
  const hub = new WebchatHub();
  hub.onAgents((tenant, agentIds) => notices.push({ tenantId: tenant, agentIds }));
  const service = new WebchatService(application, hub, { now: () => now });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const visitor = async () => {
    const session = await service.startSession(tenantId, widgetId, {
      origin: 'https://shop.test',
      locale: 'th',
    });
    return {
      ...session,
      send: async (text: string, clientMessageId = randomUUID()) => {
        const sent = await service.visitorSend(tenantId, session.sessionId, session.token, {
          clientMessageId,
          text,
        });
        // the first message starts a round of its own; wait for it so each step of a test is deterministic
        await service.settled();
        return sent;
      },
      state: (after?: string | null) =>
        service.sessionState(tenantId, session.sessionId, session.token, {
          after: after ?? undefined,
        }),
      end: () => service.visitorEnd(tenantId, session.sessionId, session.token),
    };
  };
  return {
    tenantId,
    teamId,
    queueId,
    widgetId,
    admin,
    supervisor,
    agents,
    service,
    hub,
    notices,
    advance,
    visitor,
  };
}

const code = (expected: string) => (error: unknown) =>
  error instanceof WebchatError && error.code === expected;

test('the Admin saves the widget; the Supervisor reads it; nobody else does and a stale save is refused', async () => {
  const f = await fixture();
  const read = await readWebchatWidget(application, f.supervisor);
  assert.equal(read.canEdit, false);
  assert.match(read.lastSaved?.byName ?? '', /^ADMIN /);
  assert.deepEqual(read.widget.allowedOrigins, ['https://shop.test']);
  assert.equal(read.widget.revision, 1);
  assert.deepEqual(
    read.queues.map((queue) => queue.id),
    [f.queueId],
  );
  const body = { ...read.widget, id: undefined, revision: undefined, expectedRevision: 1 };
  delete (body as Record<string, unknown>).id;
  delete (body as Record<string, unknown>).revision;
  await assert.rejects(
    saveWebchatWidget(application, f.supervisor, body, 'test'),
    code('FORBIDDEN'),
  );
  await assert.rejects(readWebchatWidget(application, f.agents[0]!), code('FORBIDDEN'));
  await assert.rejects(
    saveWebchatWidget(application, f.admin, { ...body, expectedRevision: 0 }, 'test'),
    code('REVISION_CONFLICT'),
  );
  await assert.rejects(
    saveWebchatWidget(
      application,
      f.admin,
      { ...body, allowedOrigins: ['http://shop.test'] },
      'test',
    ),
    code('VALIDATION_FAILED'),
  );
  await assert.rejects(
    saveWebchatWidget(application, f.admin, { ...body, allowedOrigins: [] }, 'test'),
    code('VALIDATION_FAILED'),
  );
  const next = await saveWebchatWidget(
    application,
    f.admin,
    { ...body, maxChatsPerAgent: 4 },
    'test',
  );
  assert.equal(next.widget.revision, 2);
  const audit = await owner.webchatWidgetAuditEvent.findMany({
    where: { tenantId: f.tenantId },
    orderBy: { occurredAt: 'asc' },
  });
  assert.deepEqual(
    audit.map((row) => [row.action, row.changedKeys]),
    [
      [
        'CREATED',
        ['allowedOrigins', 'enabled', 'greetingEn', 'greetingTh', 'maxChatsPerAgent', 'queueId'],
      ],
      ['UPDATED', ['maxChatsPerAgent']],
    ],
  );
});

test('a visitor chats with an Agent to the end, the result is saved and the conversation can be read back', async () => {
  const f = await fixture();
  const [agent] = f.agents;
  const boot = await f.service.bootstrap(f.tenantId, f.widgetId);
  assert.deepEqual(boot, {
    tenantName: 'Demo Retail',
    greeting: { th: 'hello th', en: 'hello en' },
    idleTimeoutSec: 600,
    staffed: true,
  });
  const visitor = await f.visitor();
  assert.equal((await visitor.state()).status, 'NEW');

  const firstId = randomUUID();
  const first = await visitor.send('  Where is my order?  ', firstId);
  assert.equal(first.message.text, 'Where is my order?');
  // the same message sent again (a retry after a lost answer) is stored once
  assert.equal((await visitor.send('Where is my order?', firstId)).message.id, first.message.id);
  await f.service.tick(f.tenantId);
  assert.equal((await visitor.state()).status, 'WAITING');

  const offered = await f.service.agentChats(agent!);
  assert.equal(offered.maxChatsPerAgent, 2);
  assert.equal(offered.chats.length, 1);
  const chat = offered.chats[0]!;
  assert.equal(chat.state, 'ASSIGNED');
  assert.equal(chat.lastMessage?.text, 'Where is my order?');
  assert.ok(f.notices.some((notice) => notice.agentIds?.includes(agent!.userId)));
  // an offer shows the latest message but the conversation opens only after accepting
  await assert.rejects(
    f.service.agentMessages(agent!, chat.interactionId),
    code('CHAT_NOT_ACTIVE'),
  );

  await f.service.agentAccept(agent!, chat.interactionId);
  f.advance(1000);
  const commandId = randomUUID();
  const reply = await f.service.agentSend(agent!, chat.interactionId, {
    commandId,
    text: 'Let me check.',
  });
  assert.equal(
    (await f.service.agentSend(agent!, chat.interactionId, { commandId, text: 'Let me check.' }))
      .message.id,
    reply.message.id,
  );
  await assert.rejects(
    f.service.agentSend(agent!, chat.interactionId, { commandId, text: 'Something else' }),
    code('COMMAND_ID_REUSED'),
  );
  const active = await visitor.state();
  assert.equal(active.status, 'ACTIVE');
  assert.deepEqual(
    active.messages.map((message) => [message.from, message.text ?? message.event]),
    [
      ['visitor', 'Where is my order?'],
      ['system', 'AGENT_JOINED'],
      ['agent', 'Let me check.'],
    ],
  );
  assert.equal(active.messages[0]!.clientId, firstId);
  // only newer messages after the cursor, and nothing when there is none
  f.advance(1000);
  await visitor.send('Thanks');
  const newer = await visitor.state(active.cursor);
  assert.deepEqual(
    newer.messages.map((message) => message.text),
    ['Thanks'],
  );
  assert.deepEqual((await visitor.state(newer.cursor)).messages, []);

  f.advance(1000);
  await f.service.agentEnd(agent!, chat.interactionId);
  await f.service.agentEnd(agent!, chat.interactionId);
  const ended = await visitor.state();
  assert.equal(ended.status, 'ENDED');
  assert.equal(ended.endReason, 'AGENT_ENDED');
  await assert.rejects(visitor.send('Still there?'), code('CHAT_ENDED'));
  await assert.rejects(
    f.service.agentSend(agent!, chat.interactionId, { commandId: randomUUID(), text: 'late' }),
    code('CHAT_NOT_ACTIVE'),
  );
  const wrapup = await f.service.agentChats(agent!);
  assert.equal(wrapup.chats[0]?.state, 'WRAPUP');
  assert.equal(wrapup.chats[0]?.endReason, 'AGENT_ENDED');

  await saveAgentWrapup(application, agent!, chat.interactionId, {
    disposition: 'CUSTOMER_ASSISTED',
    note: 'Order located',
    commandId: randomUUID(),
  });
  assert.deepEqual((await f.service.agentChats(agent!)).chats, []);
  const state = await owner.agentStateLog.findFirst({
    where: { tenantId: f.tenantId, userId: agent!.userId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  });
  assert.equal(state?.state, 'AVAILABLE');

  const mine = await readAgentHistory(application, agent!, { channel: 'WEBCHAT' });
  assert.deepEqual(
    mine.items.map((item) => [item.interactionId, item.channel, item.disposition]),
    [[chat.interactionId, 'WEBCHAT', 'CUSTOMER_ASSISTED']],
  );
  assert.deepEqual((await readAgentHistory(application, agent!, { channel: 'VOICE' })).items, []);
  const transcript = await readAgentHistoryTranscript(application, agent!, chat.interactionId);
  assert.equal(transcript.endReason, 'AGENT_ENDED');
  assert.equal(transcript.customerLinked, false);
  assert.equal(transcript.visitorLabel, chat.visitorLabel);
  assert.equal(transcript.queueName, 'Web chat');
  // the summary counts by the same channel filter as the list
  assert.equal(
    (await readAgentHistorySummary(application, agent!, 'all', undefined, 'WEBCHAT')).completed,
    1,
  );
  assert.equal(
    (await readAgentHistorySummary(application, agent!, 'all', undefined, 'VOICE')).completed,
    0,
  );
  assert.equal(
    (await readTeamHistorySummary(application, f.supervisor, { period: 'all', channel: 'WEBCHAT' }))
      .completed,
    1,
  );
  assert.deepEqual(
    transcript.messages.map((message) => message.text ?? message.event),
    ['Where is my order?', 'AGENT_JOINED', 'Let me check.', 'Thanks', 'AGENT_ENDED'],
  );
  const team = await readTeamHistory(application, f.supervisor, {});
  assert.deepEqual(
    team.items.map((item) => [item.interactionId, item.channel]),
    [[chat.interactionId, 'WEBCHAT']],
  );
  assert.equal(
    (await readTeamHistoryTranscript(application, f.supervisor, chat.interactionId)).messages
      .length,
    5,
  );
  assert.equal(
    (await readTeamHistoryTranscript(application, f.admin, chat.interactionId)).messages.length,
    5,
  );
});

test('a conversation is readable only by its Agent, the team that took it and the Admin of the tenant', async () => {
  const f = await fixture({ agents: 2 });
  const [agent, colleague] = f.agents;
  const visitor = await f.visitor();
  await visitor.send('hello');
  await f.service.tick(f.tenantId);
  const taker = [agent!, colleague!].find(async () => true)!;
  const offered =
    (await f.service.agentChats(agent!)).chats[0] ??
    (await f.service.agentChats(colleague!)).chats[0];
  const holder = (await f.service.agentChats(agent!)).chats.length ? agent! : colleague!;
  const other = holder === agent ? colleague! : agent!;
  assert.ok(taker && offered);
  const id = offered!.interactionId;
  // while the chat is live, another Agent cannot read, answer, accept or end it
  await assert.rejects(f.service.agentAccept(other, id), code('OFFER_GONE'));
  await f.service.agentAccept(holder, id);
  await assert.rejects(f.service.agentMessages(other, id), code('NOT_FOUND'));
  await assert.rejects(
    f.service.agentSend(other, id, { commandId: randomUUID(), text: 'hi' }),
    code('NOT_FOUND'),
  );
  await assert.rejects(f.service.agentEnd(other, id), code('NOT_FOUND'));
  await visitor.end();
  await saveAgentWrapup(application, holder, id, {
    disposition: 'FOLLOW_UP_REQUIRED',
    note: 'Call back',
    commandId: randomUUID(),
  });

  const notFound = (error: unknown) =>
    (error as { getStatus?: () => number }).getStatus?.() === 404;
  await assert.rejects(readAgentHistoryTranscript(application, other, id), notFound);
  // a Supervisor of another team, and anyone of another tenant
  const otherTeam = randomUUID();
  await owner.team.create({ data: { id: otherTeam, tenantId: f.tenantId, name: 'Other' } });
  const outsider = await user(f.tenantId, otherTeam, 'SUPERVISOR');
  await assert.rejects(readTeamHistoryTranscript(application, outsider, id), notFound);
  const elsewhere = await fixture();
  await assert.rejects(readTeamHistoryTranscript(application, elsewhere.admin, id), notFound);
  await assert.rejects(readTeamHistoryTranscript(application, elsewhere.supervisor, id), notFound);
  await assert.rejects(f.service.agentMessages(elsewhere.agents[0]!, id), code('NOT_FOUND'));
  assert.equal((await readTeamHistoryTranscript(application, f.supervisor, id)).messages.length, 3);
});

test('a session belongs to its tenant and its secret; nothing is opened while no Agent is online', async () => {
  const f = await fixture();
  const other = await fixture();
  const visitor = await f.visitor();
  await assert.rejects(
    f.service.sessionState(f.tenantId, visitor.sessionId, 'wrong-secret'),
    code('SESSION_INVALID'),
  );
  await assert.rejects(
    f.service.sessionState(other.tenantId, visitor.sessionId, visitor.token),
    code('SESSION_INVALID'),
  );
  await assert.rejects(
    f.service.visitorSend(other.tenantId, visitor.sessionId, visitor.token, {
      clientMessageId: randomUUID(),
      text: 'hi',
    }),
    code('SESSION_INVALID'),
  );
  await assert.rejects(
    f.service.startSession(f.tenantId, other.widgetId, { origin: 'x', locale: 'th' }),
    code('WEBCHAT_DISABLED'),
  );
  assert.equal(await f.service.embedPolicy(f.tenantId, other.widgetId), null);
  assert.deepEqual(await f.service.embedPolicy(f.tenantId, f.widgetId), {
    allowedOrigins: ['https://shop.test'],
    tenantName: 'Demo Retail',
  });

  await owner.agentStateLog.create({
    data: { tenantId: f.tenantId, userId: f.agents[0]!.userId, state: 'OFFLINE' },
  });
  assert.equal((await f.service.bootstrap(f.tenantId, f.widgetId)).staffed, false);
  assert.equal((await visitor.state()).staffed, false);
  await assert.rejects(visitor.send('anyone?'), code('NO_AGENT_ONLINE'));
  assert.equal(await owner.interaction.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await owner.message.count({ where: { tenantId: f.tenantId } }), 0);
  await assert.rejects(visitor.send(''), code('VALIDATION_FAILED'));
  await assert.rejects(visitor.send('x'.repeat(2001)), code('VALIDATION_FAILED'));
});

test('the background round passes an ignored offer on, drops a visitor who left and closes a silent chat', async () => {
  const f = await fixture({ agents: 2, idleTimeoutSec: 120 });
  const [first, second] = f.agents;
  const visitor = await f.visitor();
  await visitor.send('hello');
  await f.service.tick(f.tenantId);
  const holder = (await f.service.agentChats(first!)).chats.length ? first! : second!;
  const next = holder === first ? second! : first!;
  const id = (await f.service.agentChats(holder)).chats[0]!.interactionId;
  // nobody accepts within the offer timeout: the next Agent gets it
  f.advance(21_000);
  await visitor.state();
  await f.service.tick(f.tenantId);
  assert.deepEqual((await f.service.agentChats(holder)).chats, []);
  assert.equal((await f.service.agentChats(next)).chats[0]?.interactionId, id);
  await f.service.agentAccept(next, id);

  // the customer is still waiting for a reply: silence does not close the chat
  f.advance(10 * 60_000);
  assert.equal(await f.service.tick(f.tenantId), true);
  assert.equal((await visitor.state()).status, 'ACTIVE');
  // the Agent answered and the customer stays silent past the timeout
  await f.service.agentSend(next, id, { commandId: randomUUID(), text: 'Are you there?' });
  f.advance(119_000);
  await f.service.tick(f.tenantId);
  assert.equal((await visitor.state()).status, 'ACTIVE');
  f.advance(2_000);
  await f.service.tick(f.tenantId);
  const closed = await visitor.state();
  assert.equal(closed.status, 'ENDED');
  assert.equal(closed.endReason, 'IDLE_TIMEOUT');
  assert.equal((await f.service.agentChats(next)).chats[0]?.state, 'WRAPUP');

  // a waiting visitor whose page stopped asking has left: the chat is abandoned, not offered
  const gone = await f.visitor();
  await gone.send('hello?');
  f.advance(WEBCHAT_VISITOR_GONE_MS + 1000);
  await f.service.tick(f.tenantId);
  const abandoned = await owner.webchatSession.findFirstOrThrow({
    where: { tenantId: f.tenantId, id: gone.sessionId },
  });
  assert.equal(abandoned.endReason, 'CUSTOMER_LEFT');
  const interaction = await owner.interaction.findUniqueOrThrow({
    where: { id: abandoned.interactionId! },
  });
  assert.equal(interaction.state, 'ABANDONED');
  assert.equal(interaction.agentId, null);
  assert.equal(await f.service.tick(f.tenantId), false);
});

test('an Agent holds chats up to the limit and finishes them before leaving after work', async () => {
  const f = await fixture();
  const [agent] = f.agents;
  const visitors = [await f.visitor(), await f.visitor(), await f.visitor()];
  for (const visitor of visitors) await visitor.send('hello');
  await f.service.tick(f.tenantId);
  const held = (await f.service.agentChats(agent!)).chats;
  assert.equal(held.length, 2, 'the limit of the widget is 2');
  assert.equal((await visitors[2]!.state()).status, 'WAITING');
  for (const chat of held) await f.service.agentAccept(agent!, chat.interactionId);

  const [reason] = await owner.$queryRaw<{ code: string }[]>`
    SELECT code FROM tenant_not_ready_reasons WHERE tenant_id = ${f.tenantId}::uuid LIMIT 1`;
  await owner.agentAfterWorkState.create({
    data: { tenantId: f.tenantId, userId: agent!.userId, state: 'BREAK', reasonCode: reason!.code },
  });
  const latest = async () =>
    (
      await owner.agentStateLog.findFirst({
        where: { tenantId: f.tenantId, userId: agent!.userId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      })
    )?.state;
  for (const [index, chat] of held.entries()) {
    await f.service.agentEnd(agent!, chat.interactionId);
    await saveAgentWrapup(application, agent!, chat.interactionId, {
      disposition: 'CUSTOMER_ASSISTED',
      note: 'done',
      commandId: randomUUID(),
    });
    await f.service.tick(f.tenantId);
    // a free slot is not filled once the Agent asked to go Not Ready after work
    assert.equal((await f.service.agentChats(agent!)).chats.length, held.length - index - 1);
    assert.equal(await latest(), index === 0 ? 'BUSY' : 'BREAK');
  }
  assert.equal((await visitors[2]!.state()).status, 'WAITING');
});
