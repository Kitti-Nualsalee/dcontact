import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { assertInteractionOutcomeEnvelope } from '@d-contact/cxa-contracts';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { saveAgentWrapup } from './agent-wrapup-v1.js';
import { InteractionOutcomeRelay } from './interaction-outcome-outbox.js';

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

async function fixture() {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const queueId = randomUUID();
  const userId = randomUUID();
  const contactId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Outcome outbox',
      slug: `outcome-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Support' } });
  await owner.queue.create({
    data: { id: queueId, tenantId, teamId, name: 'Voice', voiceWrapupPolicy: 'VOICE_NOTE_V1' },
  });
  await owner.user.create({
    data: {
      id: userId,
      tenantId,
      teamId,
      role: 'AGENT',
      displayName: 'Agent',
      email: `${userId}@test.invalid`,
      passwordHash: 'unused',
    },
  });
  await owner.agentStateLog.create({ data: { tenantId, userId, state: 'AVAILABLE' } });
  await owner.contact.create({ data: { id: contactId, tenantId } });
  const interaction = (withContact = true) =>
    owner.interaction.create({
      data: {
        tenantId,
        agentId: userId,
        queueId,
        ...(withContact ? { contactId } : {}),
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'WRAPUP',
      },
    });
  const outbox = () =>
    owner.interactionOutcomeOutbox.findMany({ where: { tenantId }, orderBy: { createdAt: 'asc' } });
  return { tenantId, actor: { tenantId, userId }, contactId, interaction, outbox };
}

test('recording a disposition writes one outcome fact with the wrap-up result, and a replay writes no second one', async () => {
  const f = await fixture();
  const work = await f.interaction();
  const input = { commandId: randomUUID(), disposition: 'FOLLOW_UP_REQUIRED', note: 'call back' };
  const saved = await saveAgentWrapup(application, f.actor, work.id, input, { emitOutcome: true });
  await saveAgentWrapup(application, f.actor, work.id, input, { emitOutcome: true });

  const rows = await f.outbox();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.state, 'PENDING');
  assert.equal(rows[0]!.correlationId, input.commandId);
  assert.deepEqual(rows[0]!.payload, {
    contractVersion: 1,
    outcomeType: 'INTERACTION_DISPOSITION_RECORDED',
    outcomeId: work.id,
    outcomeVersion: 1,
    interactionId: work.id,
    contactId: f.contactId,
    outcomeCode: 'FOLLOW_UP_REQUIRED',
    effectiveAt: saved.recordedAt,
  });
  // the note is free text of the Agent and never leaves with the outcome fact
  assert.equal(JSON.stringify(rows[0]).includes('call back'), false);
});

test('nothing is written while the deployment flag is off', async () => {
  const f = await fixture();
  const work = await f.interaction();
  await saveAgentWrapup(application, f.actor, work.id, {
    commandId: randomUUID(),
    disposition: 'FOLLOW_UP_REQUIRED',
    note: 'call back',
  });
  assert.deepEqual(await f.outbox(), []);
});

test('work without a linked customer writes no outcome fact', async () => {
  const f = await fixture();
  const work = await f.interaction(false);
  await saveAgentWrapup(
    application,
    f.actor,
    work.id,
    { commandId: randomUUID(), disposition: 'FOLLOW_UP_REQUIRED', note: 'x' },
    { emitOutcome: true },
  );
  assert.deepEqual(await f.outbox(), []);
});

test('the relay publishes the canonical V2 envelope and marks the row SENT only after the broker accepts it', async () => {
  const f = await fixture();
  const first = await f.interaction();
  const second = await f.interaction();
  for (const work of [first, second])
    await saveAgentWrapup(
      application,
      f.actor,
      work.id,
      { commandId: randomUUID(), disposition: 'CUSTOMER_ASSISTED', note: 'done' },
      { emitOutcome: true },
    );
  const [firstRow] = await f.outbox();

  let now = new Date();
  const sent: Array<{ topic: string; event: unknown }> = [];
  let failing = true;
  const relay = new InteractionOutcomeRelay(
    application,
    {
      async send(topic, event) {
        if (failing) throw new Error('broker down: secret detail');
        sent.push({ topic, event });
      },
    },
    { now: () => now, retryDelayMs: 1_000, log: () => undefined },
  );

  assert.equal(await relay.publishNext(f.tenantId), 'RETRY');
  const retried = (await f.outbox())[0]!;
  assert.equal(retried.state, 'PENDING');
  assert.equal(retried.attempts, 1);
  assert.equal(retried.lastError, 'Error');

  failing = false;
  // the failed row waits for its retry time; the other row goes first
  assert.equal(await relay.publishNext(f.tenantId), 'SENT');
  assert.equal(await relay.publishNext(f.tenantId), undefined);
  now = new Date(now.getTime() + 2_000);
  assert.equal(await relay.publishNext(f.tenantId), 'SENT');
  assert.equal(await relay.publishNext(f.tenantId), undefined);

  assert.deepEqual(
    sent.map(({ topic }) => topic),
    [KAFKA_TOPICS.INTERACTION_EVENTS, KAFKA_TOPICS.INTERACTION_EVENTS],
  );
  const envelopes = sent.map(({ event }) => assertInteractionOutcomeEnvelope(event));
  assert.equal(envelopes[0]!.orderingKey, second.id);
  const published = envelopes[1]!;
  assert.equal(published.eventId, firstRow!.id);
  assert.equal(published.tenantId, f.tenantId);
  assert.equal(published.orderingKey, first.id);
  assert.equal(published.aggregateId, first.id);
  assert.equal(published.payload.outcomeCode, 'CUSTOMER_ASSISTED');
  assert.equal(published.payload.contactId, f.contactId);
  const rows = await f.outbox();
  assert.deepEqual(
    rows.map((row) => [row.state, row.sentAt !== null, row.lastError]),
    [
      ['SENT', true, null],
      ['SENT', true, null],
    ],
  );
});

test('the relay of one tenant never publishes the outcome of another tenant', async () => {
  const a = await fixture();
  const b = await fixture();
  const work = await a.interaction();
  await saveAgentWrapup(
    application,
    a.actor,
    work.id,
    { commandId: randomUUID(), disposition: 'FOLLOW_UP_REQUIRED', note: 'x' },
    { emitOutcome: true },
  );
  const relay = new InteractionOutcomeRelay(application, {
    async send() {
      throw new Error('must not publish');
    },
  });
  assert.equal(await relay.publishNext(b.tenantId), undefined);
  assert.equal((await a.outbox())[0]!.attempts, 0);
});
