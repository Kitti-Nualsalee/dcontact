import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import type { AuthorizationOutcome, AuthorizeAndReserveInput } from '@d-contact/cxa-contracts';
import { AgentCallbackError, AgentCallbacks } from '@d-contact/dialer';
import {
  governanceDecider,
  managedCallbackCalls,
  type CallbackGovernance,
} from './agent-callbacks-api.js';

/** #1061 agent-scheduled callbacks against a real database; Contact Governance is a fake. */

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

class FakeGovernance implements CallbackGovernance {
  decision: AuthorizationOutcome['decision'] = 'ALLOW';
  nextEligibleAt: string | undefined;
  asked: AuthorizeAndReserveInput[] = [];
  released: string[] = [];
  confirmed: string[] = [];
  async authorizeAndReserve(_tenantId: string, input: AuthorizeAndReserveInput) {
    this.asked.push(input);
    const reservationId = this.decision === 'ALLOW' ? randomUUID() : undefined;
    return {
      decisionId: randomUUID(),
      decision: this.decision,
      reasonCode: this.decision === 'ALLOW' ? 'ALLOWED' : `TEST_${this.decision}`,
      policyVersion: 1,
      trace: [],
      ...(reservationId ? { reservationId } : {}),
      ...(this.nextEligibleAt ? { nextEligibleAt: this.nextEligibleAt } : {}),
    } satisfies AuthorizationOutcome;
  }
  async changeReservationState(_tenantId: string, reservationId: string, command: unknown) {
    (command === 'CONFIRM' ? this.confirmed : this.released).push(reservationId);
    return {};
  }
}

let extension = 1100;
async function agent(tenantId: string, teamId: string | null) {
  const id = randomUUID();
  await owner.user.create({
    data: {
      id,
      tenantId,
      teamId,
      role: 'AGENT',
      displayName: `Agent ${id.slice(0, 4)}`,
      email: `${id}@test.invalid`,
      passwordHash: 'unused',
      extension: String((extension += 1)),
    },
  });
  await owner.agentStateLog.create({ data: { tenantId, userId: id, state: 'AVAILABLE' } });
  return { tenantId, userId: id };
}

async function fixture(options: { voiceQueue?: boolean } = {}) {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const voiceQueueId = randomUUID();
  const chatQueueId = randomUUID();
  await owner.tenant.create({
    data: { id: tenantId, name: 'Demo', slug: `cb-${tenantId}`, sipDomain: `${tenantId}.test` },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Care' } });
  await owner.queue.create({
    data: {
      id: voiceQueueId,
      tenantId,
      teamId,
      name: 'Voice',
      channels: ['VOICE'],
      voiceConfigVersion: 1,
      voiceWrapupPolicy: 'VOICE_NOTE_V1',
    },
  });
  await owner.queue.create({
    data: { id: chatQueueId, tenantId, teamId, name: 'Chat', channels: ['WEBCHAT'] },
  });
  if (options.voiceQueue !== false) {
    await owner.$executeRaw`INSERT INTO voice_managed_queue_policies(tenant_id,queue_id) VALUES(${tenantId}::uuid,${voiceQueueId}::uuid)`;
    const destinationId = randomUUID();
    await owner.voiceDestination.create({
      data: { id: destinationId, tenantId, queueId: voiceQueueId, destination: '2000' },
    });
    await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,destination_pool)
      VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',10,10,10,10,'test',clock_timestamp(),'test','test',${JSON.stringify([{ destinationId, telephonyNodeId: 'fs-test' }])}::jsonb)`;
    await owner.$executeRaw`INSERT INTO voice_managed_runtime_readiness(tenant_id,telephony_node_id,version,direct_wired,expires_at)
      VALUES(${tenantId}::uuid,'fs-test',1,true,clock_timestamp()+interval '1 hour')`;
  }
  const me = await agent(tenantId, teamId);
  const mate = await agent(tenantId, teamId);
  const otherTeamId = randomUUID();
  await owner.team.create({ data: { id: otherTeamId, tenantId, name: 'Sales' } });
  const stranger = await agent(tenantId, otherTeamId);
  const contactId = randomUUID();
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'Khun Malee' } });
  const internal = await owner.contactIdentity.create({
    data: {
      tenantId,
      contactId,
      type: 'PHONE',
      value: `1${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`,
    },
  });
  const external = await owner.contactIdentity.create({
    data: { tenantId, contactId, type: 'PHONE', value: `+66${Math.floor(Math.random() * 1e9)}` },
  });
  /** work the Agent holds, linked to the customer */
  const work = async (
    who = me,
    state: 'ACTIVE' | 'WRAPUP' | 'ABANDONED' = 'ACTIVE',
    queueId = chatQueueId,
    channel: 'VOICE' | 'WEBCHAT' = 'WEBCHAT',
  ) => {
    const interaction = await owner.interaction.create({
      data: {
        tenantId,
        queueId,
        channel,
        direction: 'INBOUND',
        state,
        agentId: who.userId,
        contactId,
      },
    });
    return interaction.id;
  };
  let now = new Date();
  const governance = new FakeGovernance();
  const writer = new AgentCallbacks(application, { calls: managedCallbackCalls, now: () => now });
  // the same calls the controller makes, with Governance asked through the API's decider
  const decide = () => governanceDecider(governance, tenantId);
  const callbacks = {
    options: writer.options.bind(writer),
    list: writer.list.bind(writer),
    reschedule: writer.reschedule.bind(writer),
    cancel: writer.cancel.bind(writer),
    maintain: writer.maintain.bind(writer),
    schedule: (actor: { tenantId: string; userId: string }, body: Record<string, unknown>) =>
      writer.schedule(actor, body, decide()),
    dial: (
      actor: { tenantId: string; userId: string },
      id: string,
      body: Record<string, unknown>,
    ) => writer.dial(actor, id, body, decide()),
  };
  /** a Work Session for the Agent, as Workspace holds one while signed in */
  const session = (who = me) =>
    owner.agentWorkSessionLease.create({
      data: {
        id: randomUUID(),
        tenantId,
        userId: who.userId,
        surface: 'workspace',
        acquiredAt: now,
        heartbeatAt: now,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
      },
    });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
  return {
    tenantId,
    teamId,
    voiceQueueId,
    me,
    mate,
    stranger,
    contactId,
    internal,
    external,
    work,
    governance,
    callbacks,
    session,
    advance,
    at,
    now: () => now,
  };
}

const code = (expected: string) => (error: unknown) =>
  error instanceof AgentCallbackError && error.code === expected;

test('an Agent schedules a callback from the chat they hold; it lands on the team voice queue and lists as theirs', async () => {
  const f = await fixture();
  const interactionId = await f.work();
  const options = await f.callbacks.options(f.me, interactionId);
  assert.equal(options.contactName, 'Khun Malee');
  assert.deepEqual(
    options.numbers.map((n) => [n.identityId, n.dialable]).sort(),
    [
      [f.internal.id, true],
      [f.external.id, false],
    ].sort(),
  );
  assert.equal(options.queue?.id, f.voiceQueueId);

  const body = {
    commandId: randomUUID(),
    interactionId,
    identityId: f.internal.id,
    requestedFor: f.at(30 * 60_000),
    note: '  Wants the new price  ',
  };
  const ref = await f.callbacks.schedule(f.me, body);
  assert.equal(ref.version, 1);
  // Governance was asked about the customer and number, and the check reservation was given back
  assert.equal(f.governance.asked.length, 1);
  assert.equal(f.governance.asked[0]!.contactId, f.contactId);
  assert.equal(f.governance.asked[0]!.identityId, f.internal.id);
  assert.equal(f.governance.asked[0]!.purpose, 'SERVICE');
  assert.equal(f.governance.released.length, 1);

  // resending the same command answers the same callback without asking Governance again
  assert.deepEqual(await f.callbacks.schedule(f.me, body), ref);
  assert.equal(f.governance.asked.length, 1);

  const row = await owner.obCallback.findUniqueOrThrow({ where: { id: ref.callbackId } });
  assert.equal(row.origin, 'AGENT');
  assert.equal(row.queueId, f.voiceQueueId);
  assert.equal(row.agentId, f.me.userId);
  assert.equal(row.note, 'Wants the new price');
  assert.equal(row.expiresAt.getTime() - row.requestedFor.getTime(), 24 * 60 * 60_000);

  const mine = await f.callbacks.list(f.me);
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0]!.number, f.internal.value);
  assert.equal(mine.items[0]!.due, false);
  assert.equal(mine.items[0]!.mine, true);
  // a teammate does not see it while it is still the Agent's
  assert.equal((await f.callbacks.list(f.mate)).items.length, 0);

  // one open callback per customer, even from another work item
  await assert.rejects(
    f.callbacks.schedule(f.me, { ...body, commandId: randomUUID(), interactionId: await f.work() }),
    code('CALLBACK_EXISTS'),
  );
  const events = await owner.obCallbackEvent.findMany({ where: { callbackId: ref.callbackId } });
  assert.deepEqual(
    events.map((e) => e.kind),
    ['SCHEDULED'],
  );
  assert.ok(!JSON.stringify(events).includes(f.internal.value));
});

test('scheduling is refused for work the Agent does not hold, external numbers, past times and Governance BLOCK', async () => {
  const f = await fixture();
  const base = (interactionId: string) => ({
    commandId: randomUUID(),
    interactionId,
    identityId: f.internal.id,
    requestedFor: f.at(10 * 60_000),
  });
  await assert.rejects(
    f.callbacks.schedule(f.me, base(await f.work(f.mate))),
    code('WORK_NOT_FOUND'),
  );
  await assert.rejects(
    f.callbacks.schedule(f.me, base(await f.work(f.me, 'ABANDONED'))),
    code('WORK_NOT_ACTIVE'),
  );
  const held = await f.work();
  await assert.rejects(
    f.callbacks.schedule(f.me, { ...base(held), identityId: f.external.id }),
    code('NUMBER_NOT_DIALABLE'),
  );
  await assert.rejects(
    f.callbacks.schedule(f.me, { ...base(held), requestedFor: f.at(30_000) }),
    code('INVALID_INPUT'),
  );
  await assert.rejects(
    f.callbacks.schedule(f.me, { ...base(held), requestedFor: f.at(31 * 24 * 60 * 60_000) }),
    code('INVALID_INPUT'),
  );
  f.governance.decision = 'BLOCK';
  await assert.rejects(f.callbacks.schedule(f.me, base(held)), code('GOVERNANCE_BLOCKED'));
  f.governance.decision = 'REVIEW';
  await assert.rejects(f.callbacks.schedule(f.me, base(held)), code('GOVERNANCE_REVIEW'));
  assert.equal(await owner.obCallback.count({ where: { tenantId: f.tenantId } }), 0);
  // DEFER only says "not right now": the time is checked again when dialing
  f.governance.decision = 'DEFER';
  await f.callbacks.schedule(f.me, base(held));
  assert.equal(await owner.obCallback.count({ where: { tenantId: f.tenantId } }), 1);
});

test('a team without a managed voice queue cannot schedule', async () => {
  const f = await fixture({ voiceQueue: false });
  const interactionId = await f.work();
  assert.equal((await f.callbacks.options(f.me, interactionId)).queue, null);
  await assert.rejects(
    f.callbacks.schedule(f.me, {
      commandId: randomUUID(),
      interactionId,
      identityId: f.internal.id,
      requestedFor: f.at(10 * 60_000),
    }),
    code('NO_VOICE_QUEUE'),
  );
});

test('reschedule and cancel need the current version; other teams and tenants cannot see or change it', async () => {
  const f = await fixture();
  const ref = await f.callbacks.schedule(f.me, {
    commandId: randomUUID(),
    interactionId: await f.work(),
    identityId: f.internal.id,
    requestedFor: f.at(10 * 60_000),
  });
  const moved = await f.callbacks.reschedule(f.me, ref.callbackId, {
    commandId: randomUUID(),
    expectedVersion: 1,
    requestedFor: f.at(60 * 60_000),
  });
  assert.equal(moved.version, 2);
  await assert.rejects(
    f.callbacks.cancel(f.me, ref.callbackId, { commandId: randomUUID(), expectedVersion: 1 }),
    code('VERSION_CONFLICT'),
  );
  for (const outsider of [f.mate, f.stranger])
    await assert.rejects(
      f.callbacks.cancel(outsider, ref.callbackId, { commandId: randomUUID(), expectedVersion: 2 }),
      code('CALLBACK_NOT_FOUND'),
    );
  const other = await fixture();
  await assert.rejects(
    other.callbacks.cancel(other.me, ref.callbackId, {
      commandId: randomUUID(),
      expectedVersion: 2,
    }),
    code('CALLBACK_NOT_FOUND'),
  );
  await f.callbacks.cancel(f.me, ref.callbackId, { commandId: randomUUID(), expectedVersion: 2 });
  assert.equal((await f.callbacks.list(f.me)).items.length, 0);
  const row = await owner.obCallback.findUniqueOrThrow({ where: { id: ref.callbackId } });
  assert.equal(row.state, 'CANCELLED');
  assert.equal(row.cancelReasonCode, 'AGENT_CANCELLED');
  // a cancelled callback frees the customer for a new one
  await f.callbacks.schedule(f.me, {
    commandId: randomUUID(),
    interactionId: await f.work(),
    identityId: f.internal.id,
    requestedFor: f.at(10 * 60_000),
  });
});

test('15 minutes after the time an offline Agent loses the callback to the team; an online Agent keeps it; it expires after 24 hours', async () => {
  const f = await fixture();
  const ref = await f.callbacks.schedule(f.me, {
    commandId: randomUUID(),
    interactionId: await f.work(),
    identityId: f.internal.id,
    requestedFor: f.at(5 * 60_000),
  });
  // the Agent holds a Work Session: still theirs after the 15 minutes
  const lease = await owner.agentWorkSessionLease.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      userId: f.me.userId,
      surface: 'workspace',
      acquiredAt: f.now(),
      heartbeatAt: f.now(),
      expiresAt: new Date(f.now().getTime() + 60 * 60_000),
    },
  });
  f.advance(21 * 60_000);
  assert.equal((await f.callbacks.list(f.me)).items[0]!.due, true);
  assert.equal((await f.callbacks.maintain(f.tenantId)).escalated, 0);
  // the Work Session ends: the next round moves it to the team
  // a short reconnect does not lose the callback: only 2 minutes away moves it
  await owner.agentWorkSessionLease.update({
    where: { id: lease.id },
    data: { releasedAt: new Date(f.now().getTime() - 60_000), releaseReason: 'released' },
  });
  assert.equal((await f.callbacks.maintain(f.tenantId)).escalated, 0);
  await owner.agentWorkSessionLease.update({
    where: { id: lease.id },
    data: { releasedAt: new Date(f.now().getTime() - 3 * 60_000) },
  });
  assert.equal((await f.callbacks.maintain(f.tenantId)).escalated, 1);
  assert.equal((await f.callbacks.maintain(f.tenantId)).escalated, 0);
  const teamView = await f.callbacks.list(f.mate);
  assert.equal(teamView.items.length, 1);
  assert.equal(teamView.items[0]!.team, true);
  assert.equal(teamView.items[0]!.version, 2);
  assert.equal((await f.callbacks.list(f.stranger)).items.length, 0);
  // a teammate may move it; the round then expires it 24 hours after the new time
  await f.callbacks.reschedule(f.mate, ref.callbackId, {
    commandId: randomUUID(),
    expectedVersion: 2,
    requestedFor: f.at(2 * 60_000),
  });
  f.advance(24 * 60 * 60_000 + 3 * 60_000);
  assert.equal((await f.callbacks.maintain(f.tenantId)).expired, 1);
  const row = await owner.obCallback.findUniqueOrThrow({ where: { id: ref.callbackId } });
  assert.equal(row.state, 'CANCELLED');
  assert.equal(row.cancelReasonCode, 'EXPIRED');
  const kinds = (
    await owner.obCallbackEvent.findMany({
      where: { callbackId: ref.callbackId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    })
  ).map((e) => e.kind);
  assert.deepEqual(kinds, ['SCHEDULED', 'ESCALATED', 'RESCHEDULED', 'EXPIRED']);
});

async function scheduled(f: Awaited<ReturnType<typeof fixture>>) {
  // the source work ends before the callback is dialed, as it would in Workspace
  const interactionId = await f.work();
  const ref = await f.callbacks.schedule(f.me, {
    commandId: randomUUID(),
    interactionId,
    identityId: f.internal.id,
    requestedFor: f.at(5 * 60_000),
  });
  await owner.interaction.update({ where: { id: interactionId }, data: { state: 'ABANDONED' } });
  return ref;
}

test('dialing places a callback call for the Agent; when the Agent does not answer it is scheduled again, when answered it is done', async () => {
  const f = await fixture();
  const ref = await scheduled(f);
  await assert.rejects(
    f.callbacks.dial(f.me, ref.callbackId, { commandId: randomUUID(), expectedVersion: 1 }),
    code('NO_WORK_SESSION'),
  );
  await f.session();
  const command = { commandId: randomUUID(), expectedVersion: 1 };
  const dialing = await f.callbacks.dial(f.me, ref.callbackId, command);
  assert.equal(dialing.status, 'DIALING');
  assert.equal(dialing.version, 2);
  // the reservation stays open until the attempt settles
  assert.equal(f.governance.confirmed.length, 0);
  assert.ok(
    f.governance.asked.at(-1)!.actionKey.startsWith(`agent-callback-dial:${command.commandId}:`),
  );
  // resending the same command answers the same attempt
  assert.deepEqual(await f.callbacks.dial(f.me, ref.callbackId, command), dialing);
  const interactionId = dialing.status === 'DIALING' ? dialing.interactionId : '';
  const call = await owner.interaction.findUniqueOrThrow({ where: { id: interactionId } });
  assert.equal(call.direction, 'OUTBOUND');
  assert.equal(call.state, 'ASSIGNED');
  assert.equal(call.agentId, f.me.userId);
  assert.equal(call.queueId, f.voiceQueueId);
  assert.equal((await f.callbacks.list(f.me)).items[0]!.state, 'ORIGINATING');
  assert.equal((await f.callbacks.maintain(f.tenantId)).notConnected, 0);

  // the Agent did not answer D-Phone: the runtime abandoned the call, the round puts the callback back
  await owner.interaction.update({ where: { id: interactionId }, data: { state: 'ABANDONED' } });
  const missed = await f.callbacks.maintain(f.tenantId);
  assert.equal(missed.notConnected, 1);
  // nothing reached the customer: the reservation is given back
  assert.deepEqual(
    missed.reservations.map((item) => item.placed),
    [false],
  );
  let row = await owner.obCallback.findUniqueOrThrow({ where: { id: ref.callbackId } });
  assert.equal(row.state, 'SCHEDULED');
  assert.equal(row.lastReasonCode, 'AGENT_NOT_ANSWERED');
  assert.equal(row.attemptCount, 1);

  // the Agent is Ready again and dials once more; this time the Agent answers
  await owner.agentStateLog.create({
    data: { tenantId: f.tenantId, userId: f.me.userId, state: 'AVAILABLE' },
  });
  const again = await f.callbacks.dial(f.me, ref.callbackId, {
    commandId: randomUUID(),
    expectedVersion: row.version,
  });
  assert.equal(again.status, 'DIALING');
  const second = again.status === 'DIALING' ? again.interactionId : '';
  await owner.interaction.update({
    where: { id: second },
    data: { state: 'WRAPUP', answeredAt: new Date() },
  });
  const reached = await f.callbacks.maintain(f.tenantId);
  assert.equal(reached.connected, 1);
  assert.deepEqual(
    reached.reservations.map((item) => item.placed),
    [true],
  );
  row = await owner.obCallback.findUniqueOrThrow({ where: { id: ref.callbackId } });
  assert.equal(row.state, 'CONSUMED');
  assert.equal(row.attemptCount, 2);
  assert.equal((await f.callbacks.list(f.me)).items.length, 0);
  const kinds = (
    await owner.obCallbackEvent.findMany({
      where: { callbackId: ref.callbackId },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    })
  ).map((e) => e.kind);
  assert.deepEqual(kinds, [
    'SCHEDULED',
    'DIAL_STARTED',
    'NOT_CONNECTED',
    'DIAL_STARTED',
    'CONNECTED',
  ]);
});

test('Governance at dial time: DEFER moves the callback, REVIEW keeps it, BLOCK cancels it; nothing is dialed', async () => {
  const f = await fixture();
  const ref = await scheduled(f);
  await f.session();
  f.governance.decision = 'DEFER';
  f.governance.nextEligibleAt = f.at(14 * 60 * 60_000);
  const deferred = await f.callbacks.dial(f.me, ref.callbackId, {
    commandId: randomUUID(),
    expectedVersion: 1,
  });
  assert.equal(deferred.status, 'DEFERRED');
  assert.equal(
    deferred.status === 'DEFERRED' && deferred.requestedFor,
    f.governance.nextEligibleAt,
  );
  f.governance.decision = 'REVIEW';
  const review = await f.callbacks.dial(f.me, ref.callbackId, {
    commandId: randomUUID(),
    expectedVersion: deferred.version,
  });
  assert.equal(review.status, 'REVIEW');
  assert.equal((await f.callbacks.list(f.me)).items[0]!.state, 'SCHEDULED');
  f.governance.decision = 'BLOCK';
  const blocked = await f.callbacks.dial(f.me, ref.callbackId, {
    commandId: randomUUID(),
    expectedVersion: review.version,
  });
  assert.equal(blocked.status, 'BLOCKED');
  const row = await owner.obCallback.findUniqueOrThrow({ where: { id: ref.callbackId } });
  assert.equal(row.state, 'CANCELLED');
  assert.equal(row.cancelReasonCode, 'GOVERNANCE_BLOCKED');
  assert.equal(
    await owner.interaction.count({ where: { tenantId: f.tenantId, direction: 'OUTBOUND' } }),
    0,
  );
});

test('an Agent with other work cannot dial; the reservation is given back and the callback stays', async () => {
  const f = await fixture();
  const ref = await scheduled(f);
  await f.session();
  await f.work(); // the Agent is in another conversation
  const failedCommand = { commandId: randomUUID(), expectedVersion: 1 };
  await assert.rejects(
    f.callbacks.dial(f.me, ref.callbackId, failedCommand),
    code('AGENT_NOT_AVAILABLE'),
  );
  assert.equal(f.governance.released.length, 2); // schedule check + this dial
  assert.equal(f.governance.confirmed.length, 0);
  // the same command sent again after the Agent is free asks Governance again (no stale ALLOW)
  const asked = f.governance.asked.length;
  await owner.interaction.updateMany({
    where: { tenantId: f.tenantId, agentId: f.me.userId, state: 'ACTIVE' },
    data: { state: 'ABANDONED' },
  });
  f.governance.decision = 'DEFER';
  f.governance.nextEligibleAt = f.at(3 * 60 * 60_000);
  const retried = await f.callbacks.dial(f.me, ref.callbackId, failedCommand);
  assert.equal(retried.status, 'DEFERRED');
  assert.equal(f.governance.asked.length, asked + 1);
  const row = await owner.obCallback.findUniqueOrThrow({ where: { id: ref.callbackId } });
  assert.equal(row.state, 'SCHEDULED');
  // moved once by the DEFER of the retry, never dialed
  assert.equal(row.version, 2);
  assert.equal(row.attemptCount, 0);
});
