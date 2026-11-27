import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction, type Prisma } from '@d-contact/db';
import {
  WEBCHAT_REOFFER_COOLDOWN_MS,
  acceptWebchatOffer,
  closeOrphanWebchatOffers,
  createWebchatInteraction,
  desiredWebchatAgentState,
  endWebchat,
  isWebchatQueueStaffed,
  offerQueuedWebchat,
  releaseWebchatOffer,
  syncAgentWebchatState,
  webchatIdleDeadline,
} from './webchat-routing.js';

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

async function fixture(agentCount = 2) {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const queueId = randomUUID();
  const widgetId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Webchat routing test',
      slug: `webchat-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Chat' } });
  await owner.queue.create({
    data: { id: queueId, tenantId, teamId, name: 'Chat', channels: ['WEBCHAT'] },
  });
  await owner.webchatWidget.create({
    data: { tenantId, id: widgetId, queueId, allowedOrigins: ['https://shop.test'], enabled: true },
  });
  const agents: string[] = [];
  for (let index = 0; index < agentCount; index++) {
    const id = randomUUID();
    await owner.user.create({
      data: {
        id,
        tenantId,
        teamId,
        role: 'AGENT',
        displayName: `Agent ${index}`,
        email: `${id}@test.invalid`,
        passwordHash: 'unused',
        extension: `10${index}`,
      },
    });
    // Agents become available one second apart so "waited longest" is deterministic.
    await owner.agentStateLog.create({
      data: {
        tenantId,
        userId: id,
        state: 'AVAILABLE',
        startedAt: new Date(Date.now() - 60_000 + index * 1000),
      },
    });
    agents.push(id);
  }
  const run = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withTenantDatabaseTransaction(application, tenantId, work);
  const chat = async (now = new Date()) => {
    const sessionId = randomUUID();
    const conversation = await owner.conversation.create({
      data: {
        tenantId,
        channel: 'WEBCHAT',
        channelAccountId: widgetId,
        externalThreadId: sessionId,
      },
    });
    return run((tx) =>
      createWebchatInteraction(tx, {
        tenantId,
        queueId,
        conversationId: conversation.id,
        sessionId,
        widgetId,
        visitorLabel: 'A1B2',
        now,
      }),
    );
  };
  const offer = (interactionId: string, now = new Date(), maxChatsPerAgent = 3) =>
    run((tx) => offerQueuedWebchat(tx, { tenantId, interactionId, maxChatsPerAgent, now }));
  const accept = (interactionId: string, agentId: string, now = new Date()) =>
    run((tx) => acceptWebchatOffer(tx, { tenantId, interactionId, agentId, now }));
  const state = async (agentId: string) => {
    const latest = await owner.agentStateLog.findFirst({
      where: { tenantId, userId: agentId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
    });
    return `${latest?.state}:${latest?.reason ?? ''}`;
  };
  const interaction = (id: string) =>
    owner.interaction.findUniqueOrThrow({
      where: { id },
      select: {
        state: true,
        agentId: true,
        voiceWrapupPolicy: true,
        answeredAt: true,
        endedAt: true,
      },
    });
  return {
    tenantId,
    teamId,
    queueId,
    widgetId,
    agents,
    run,
    chat,
    offer,
    accept,
    state,
    interaction,
  };
}

test('the Agent state follows the chats in hand, and silence is counted only after the Agent spoke last', () => {
  assert.equal(desiredWebchatAgentState({ assigned: 1, active: 0, wrapup: 0 }), 'RESERVED');
  assert.equal(desiredWebchatAgentState({ assigned: 1, active: 0, wrapup: 2 }), 'ACW');
  assert.equal(desiredWebchatAgentState({ assigned: 1, active: 1, wrapup: 2 }), 'BUSY');
  assert.equal(desiredWebchatAgentState({ assigned: 0, active: 0, wrapup: 0 }), null);
  const at = (seconds: number) => new Date(Date.UTC(2026, 10, 27, 3, 0, seconds));
  assert.equal(
    webchatIdleDeadline({
      lastCustomerMessageAt: at(0),
      lastAgentMessageAt: null,
      idleTimeoutSec: 600,
    }),
    null,
  );
  assert.equal(
    webchatIdleDeadline({
      lastCustomerMessageAt: at(30),
      lastAgentMessageAt: at(10),
      idleTimeoutSec: 600,
    }),
    null,
  );
  assert.deepEqual(
    webchatIdleDeadline({
      lastCustomerMessageAt: at(10),
      lastAgentMessageAt: at(30),
      idleTimeoutSec: 600,
    }),
    new Date(at(30).getTime() + 600_000),
  );
});

test('a chat is offered, accepted, ended and leaves the Agent in after-call work until the result is saved', async () => {
  const f = await fixture(1);
  const [agentId] = f.agents;
  const id = await f.chat();
  assert.equal((await f.interaction(id)).voiceWrapupPolicy, 'VOICE_NOTE_V1');
  const offered = await f.offer(id);
  assert.equal(offered?.agentId, agentId);
  assert.equal((await f.interaction(id)).state, 'ASSIGNED');
  assert.equal(await f.state(agentId), 'RESERVED:webchat');

  assert.equal(await f.accept(id, agentId), 'ACCEPTED');
  assert.equal(await f.accept(id, agentId), 'ALREADY_ACCEPTED');
  assert.equal((await f.interaction(id)).state, 'ACTIVE');
  assert.equal(await f.state(agentId), 'BUSY:webchat');
  const [attribution] = await owner.voiceInteractionHandlingAttribution.findMany({
    where: { tenantId: f.tenantId, interactionId: id },
  });
  assert.equal(attribution?.agentId, agentId);
  assert.equal(attribution?.teamId, f.teamId);

  const ended = await f.run((tx) =>
    endWebchat(tx, {
      tenantId: f.tenantId,
      interactionId: id,
      reason: 'AGENT_ENDED',
      now: new Date(),
    }),
  );
  assert.deepEqual(ended, { state: 'WRAPUP', agentId });
  assert.equal(await f.state(agentId), 'ACW:webchat');
  assert.equal(
    await f.run((tx) =>
      endWebchat(tx, {
        tenantId: f.tenantId,
        interactionId: id,
        reason: 'CUSTOMER_ENDED',
        now: new Date(),
      }),
    ),
    null,
  );
});

test('chats go to the Agent with the fewest chats and stop at the limit', async () => {
  const f = await fixture(2);
  const [first, second] = f.agents;
  const chats = [await f.chat(), await f.chat(), await f.chat(), await f.chat(), await f.chat()];
  const taken: (string | undefined)[] = [];
  for (const id of chats) taken.push((await f.offer(id, new Date(), 2))?.agentId);
  assert.deepEqual(taken, [first, second, first, second, undefined]);
  assert.equal((await f.interaction(chats[4]!)).state, 'QUEUED');
});

test('an offer nobody accepts returns to the queue and skips that Agent for a while', async () => {
  const f = await fixture(2);
  const [first, second] = f.agents;
  const start = new Date();
  const id = await f.chat(start);
  const offered = await f.offer(id, start);
  assert.equal(offered?.agentId, first);
  const release = (now: Date) =>
    f.run((tx) =>
      releaseWebchatOffer(tx, { tenantId: f.tenantId, interactionId: id, agentId: first!, now }),
    );
  assert.equal(await release(new Date(offered!.expiresAt.getTime() - 1)), null);
  const expired = new Date(offered!.expiresAt.getTime());
  assert.deepEqual(await release(expired), { agentId: first, reason: 'TIMED_OUT' });
  assert.equal((await f.interaction(id)).state, 'QUEUED');
  assert.equal(await f.state(first!), 'AVAILABLE:webchat_released');
  assert.equal(await f.accept(id, first!, expired), 'OFFER_GONE');

  assert.equal((await f.offer(id, expired))?.agentId, second);
  const again = new Date(expired.getTime() + 1000);
  await f.run((tx) =>
    releaseWebchatOffer(tx, {
      tenantId: f.tenantId,
      interactionId: id,
      agentId: second!,
      now: new Date(again.getTime() + 3_600_000),
    }),
  );
  // Both Agents let it time out: nobody is offered it again until the cooldown has passed.
  assert.equal(await f.offer(id, again), null);
  const afterCooldown = new Date(again.getTime() + 3_600_000 + WEBCHAT_REOFFER_COOLDOWN_MS + 1);
  assert.ok(await f.offer(id, afterCooldown));
});

test('chat and voice are not mixed, and an Agent leaving after work gets no new chat', async () => {
  const f = await fixture(2);
  const [first, second] = f.agents;
  // The first Agent is on a call: the voice router has put them in a voice state.
  await owner.interaction.create({
    data: {
      tenantId: f.tenantId,
      channel: 'VOICE',
      direction: 'INBOUND',
      state: 'ACTIVE',
      agentId: first,
    },
  });
  await owner.agentStateLog.create({
    data: { tenantId: f.tenantId, userId: first!, state: 'BUSY', reason: randomUUID() },
  });
  const one = await f.chat();
  assert.equal((await f.offer(one))?.agentId, second);
  assert.equal(await f.accept(one, second!), 'ACCEPTED');
  // While holding a chat the Agent is not AVAILABLE, which is what the voice routers require.
  assert.equal(await f.state(second!), 'BUSY:webchat');

  const [reason] = await owner.$queryRaw<{ code: string }[]>`
    SELECT code FROM tenant_not_ready_reasons WHERE tenant_id = ${f.tenantId}::uuid LIMIT 1`;
  assert.ok(reason, 'every tenant has Not Ready reasons');
  await owner.agentAfterWorkState.create({
    data: { tenantId: f.tenantId, userId: second!, state: 'BREAK', reasonCode: reason.code },
  });
  const two = await f.chat();
  assert.equal(await f.offer(two), null);

  await f.run((tx) =>
    endWebchat(tx, {
      tenantId: f.tenantId,
      interactionId: one,
      reason: 'CUSTOMER_ENDED',
      now: new Date(),
    }),
  );
  await owner.interaction
    .update({ where: { id: one }, data: { state: 'COMPLETED', wrapUpCode: 'X' } })
    .catch(
      // The wrap-up guard requires a result row; this test only needs the chat out of the Agent's hands.
      () =>
        owner.$executeRaw`UPDATE interactions SET agent_id = NULL, state = 'ABANDONED' WHERE id = ${one}::uuid`,
    );
  await f.run((tx) => syncAgentWebchatState(tx, f.tenantId, second!, { workCompleted: true }));
  assert.equal(await f.state(second!), 'BREAK:after_work_not_ready');
  assert.equal(await f.offer(two), null);
});

test('a chat that ends before an Agent takes it is abandoned and frees the offer', async () => {
  const f = await fixture(1);
  const [agentId] = f.agents;
  const queued = await f.chat();
  assert.deepEqual(
    await f.run((tx) =>
      endWebchat(tx, {
        tenantId: f.tenantId,
        interactionId: queued,
        reason: 'CUSTOMER_LEFT',
        now: new Date(),
      }),
    ),
    { state: 'ABANDONED', agentId: null },
  );
  const offeredChat = await f.chat();
  await f.offer(offeredChat);
  assert.deepEqual(
    await f.run((tx) =>
      endWebchat(tx, {
        tenantId: f.tenantId,
        interactionId: offeredChat,
        reason: 'CUSTOMER_ENDED',
        now: new Date(),
      }),
    ),
    { state: 'ABANDONED', agentId },
  );
  assert.equal(await f.state(agentId!), 'AVAILABLE:webchat_released');
  assert.equal(
    await owner.webchatOffer.count({ where: { tenantId: f.tenantId, outcome: 'PENDING' } }),
    0,
  );
});

test('a queue is staffed only while an eligible Agent is signed in and not on a break', async () => {
  const f = await fixture(1);
  const [agentId] = f.agents;
  const staffed = () => f.run((tx) => isWebchatQueueStaffed(tx, f.tenantId, f.queueId));
  assert.equal(await staffed(), true);
  await owner.agentStateLog.create({
    data: { tenantId: f.tenantId, userId: agentId!, state: 'BREAK' },
  });
  assert.equal(await staffed(), false);
  await owner.agentStateLog.create({
    data: { tenantId: f.tenantId, userId: agentId!, state: 'OFFLINE' },
  });
  assert.equal(await staffed(), false);
  const queued = await f.chat();
  assert.equal(await f.offer(queued), null);
  // An Agent of another team does not staff this queue.
  const otherTeam = randomUUID();
  const outsider = randomUUID();
  await owner.team.create({ data: { id: otherTeam, tenantId: f.tenantId, name: 'Other' } });
  await owner.user.create({
    data: {
      id: outsider,
      tenantId: f.tenantId,
      teamId: otherTeam,
      role: 'AGENT',
      displayName: 'Outsider',
      email: `${outsider}@test.invalid`,
      passwordHash: 'unused',
    },
  });
  await owner.agentStateLog.create({
    data: { tenantId: f.tenantId, userId: outsider, state: 'AVAILABLE' },
  });
  assert.equal(await staffed(), false);
  assert.equal(await f.offer(queued), null);
});

test('an offer returned to the queue by a work-session takeover is closed so the chat is offered again', async () => {
  const f = await fixture(2);
  const [first, second] = f.agents;
  const id = await f.chat();
  await f.offer(id);
  // What a takeover does: the Interaction goes back to the queue and the Agent goes offline.
  await owner.interaction.update({
    where: { id },
    data: { state: 'QUEUED', agentId: null, offerExpiresAt: null },
  });
  await owner.agentStateLog.create({
    data: { tenantId: f.tenantId, userId: first!, state: 'OFFLINE' },
  });
  assert.deepEqual(await f.run((tx) => closeOrphanWebchatOffers(tx, f.tenantId, new Date())), [
    first,
  ]);
  assert.equal((await f.offer(id))?.agentId, second);
});

test('another tenant cannot see or move a chat', async () => {
  const f = await fixture(1);
  const other = await fixture(1);
  const id = await f.chat();
  const result = await withTenantDatabaseTransaction(application, other.tenantId, (tx) =>
    offerQueuedWebchat(tx, {
      tenantId: other.tenantId,
      interactionId: id,
      maxChatsPerAgent: 3,
      now: new Date(),
    }),
  );
  assert.equal(result, null);
  assert.equal((await f.interaction(id)).state, 'QUEUED');
});
