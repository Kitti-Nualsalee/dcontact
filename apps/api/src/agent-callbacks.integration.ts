import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import type { AuthorizationOutcome, AuthorizeAndReserveInput } from '@d-contact/cxa-contracts';
import { AgentCallbackError, AgentCallbacks, type CallbackGovernance } from '@d-contact/dialer';

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
  async changeReservationState(_tenantId: string, reservationId: string) {
    this.released.push(reservationId);
    return {};
  }
}

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
    },
  });
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
    data: { id: voiceQueueId, tenantId, teamId, name: 'Voice', channels: ['VOICE'] },
  });
  await owner.queue.create({
    data: { id: chatQueueId, tenantId, teamId, name: 'Chat', channels: ['WEBCHAT'] },
  });
  if (options.voiceQueue !== false)
    await owner.$executeRaw`INSERT INTO voice_managed_queue_policies(tenant_id,queue_id) VALUES(${tenantId}::uuid,${voiceQueueId}::uuid)`;
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
  const callbacks = new AgentCallbacks(application, { governance, now: () => now });
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
  await owner.agentWorkSessionLease.update({
    where: { id: lease.id },
    data: { releasedAt: f.now(), releaseReason: 'released' },
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
