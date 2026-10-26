import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { ManagedVoiceRuntime } from './managed-voice-runtime.js';
import type {
  ManagedVoiceDirectCommand,
  ManagedVoiceDirectPort,
  ManagedVoiceEvent,
} from './managed-voice-contracts.js';

async function handleAndFlush(runtime: ManagedVoiceRuntime, event: ManagedVoiceEvent) {
  const result = await runtime.handle(event);
  await runtime.flushCommands(event.tenantId, event.telephonyNodeId);
  return result;
}

async function tickAndFlush(runtime: ManagedVoiceRuntime, tenantId: string, nodeId: string) {
  await runtime.tick(tenantId, nodeId);
  await runtime.flushCommands(tenantId, nodeId);
}

async function fixture(enteredAgo = 0, agents = 2) {
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    queueId = randomUUID(),
    skillId = randomUUID(),
    destinationId = randomUUID(),
    callUuid = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Managed runtime test',
      slug: `managed-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Routing' } });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      teamId,
      name: 'Managed',
      channels: ['VOICE'],
      voiceConfigVersion: 1,
      voiceWrapupPolicy: 'VOICE_NOTE_V1',
    },
  });
  await owner.skill.create({
    data: {
      id: skillId,
      tenantId,
      teamId,
      code: 'ROUTING',
      name: 'Routing',
      voiceConfigVersion: 1,
    },
  });
  await owner.queueSkill.create({ data: { tenantId, queueId, skillId, minLevel: 1 } });
  await owner.$executeRaw`INSERT INTO voice_managed_queue_policies(tenant_id,queue_id) VALUES(${tenantId}::uuid,${queueId}::uuid)`;
  await owner.voiceDestination.create({
    data: { id: destinationId, tenantId, queueId, destination: '2000' },
  });
  await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,destination_pool)
    VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',10,10,10,10,'test',clock_timestamp(),'test','test',${JSON.stringify([{ destinationId, telephonyNodeId: 'fs-test' }])}::jsonb)`;
  for (let index = 0; index < agents; index++) {
    const id = randomUUID();
    await owner.user.create({
      data: {
        id,
        tenantId,
        teamId,
        role: 'AGENT',
        displayName: 'Agent',
        email: `${id}@test.invalid`,
        passwordHash: 'unused',
        extension: `100${index}`,
      },
    });
    await owner.agentSkill.create({ data: { tenantId, userId: id, skillId, level: 1 } });
    await owner.agentStateLog.create({ data: { tenantId, userId: id, state: 'AVAILABLE' } });
  }
  if (enteredAgo) {
    const interaction = await owner.interaction.create({
      data: { tenantId, queueId, channel: 'VOICE', direction: 'INBOUND', externalId: callUuid },
    });
    await owner.$executeRaw`INSERT INTO voice_managed_calls(tenant_id,interaction_id,telephony_node_id,call_uuid,first_queue_entered_at,preanswer_deadline)
      SELECT ${tenantId}::uuid,${interaction.id}::uuid,'fs-test',${callUuid},stamp,stamp+interval '60 seconds' FROM (SELECT clock_timestamp()-${enteredAgo}*interval '1 second' AS stamp) times`;
  }
  const event: ManagedVoiceEvent = {
    tenantId,
    telephonyNodeId: 'fs-test',
    callUuid,
    type: 'call.created',
    destination: '2000',
  };
  const commands: ManagedVoiceDirectCommand[] = [];
  const port: ManagedVoiceDirectPort = {
    readback: async () => ({ callerExists: true, blegExists: true }),
    execute: async (command) => {
      commands.push(command);
      return { confirmed: true };
    },
  };
  const dispatchApplication = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  const runtime = new ManagedVoiceRuntime(application, port, dispatchApplication);
  return {
    owner,
    application,
    dispatchApplication,
    tenantId,
    queueId,
    event,
    commands,
    port,
    runtime,
    close: async () => {
      await Promise.all([
        owner.$disconnect(),
        application.$disconnect(),
        dispatchApplication.$disconnect(),
      ]);
    },
  };
}

test('managed answer correlation, duplicate events, caller cancel and ACTIVE timer safety', async (testContext) => {
  const context = await fixture();
  testContext.after(context.close);
  const { runtime, event, commands, owner, application, tenantId } = context;
  const created = await handleAndFlush(runtime, event);
  assert.equal(created?.status, 'ASSIGNED');
  const offer = commands.find((command) => command.type === 'offer.create')!;
  assert.ok(offer.offerId);
  assert.ok(offer.blegUuid);
  const answer: ManagedVoiceEvent = {
    ...event,
    type: 'call.answered',
    agentId: offer.agentId,
    offerId: offer.offerId!,
    blegUuid: offer.blegUuid,
  };
  assert.equal(
    (await handleAndFlush(runtime, { ...answer, agentId: randomUUID() }))?.status,
    'ASSIGNED',
  );
  assert.equal(await handleAndFlush(runtime, { ...answer, tenantId: randomUUID() }), null);
  assert.equal((await handleAndFlush(runtime, answer))?.status, 'ACTIVE');
  await handleAndFlush(runtime, answer);
  await handleAndFlush(runtime, { ...answer, type: 'call.bridge' });
  await tickAndFlush(runtime, tenantId, event.telephonyNodeId);
  assert.equal(commands.filter((command) => command.type === 'call.bridge').length, 1);
  assert.equal(
    (await owner.interaction.findUniqueOrThrow({ where: { id: created!.interactionId } })).state,
    'ACTIVE',
  );
  await assert.rejects(
    withTenantDatabaseTransaction(application, tenantId, (transaction) =>
      transaction.interaction.update({
        where: { id: created!.interactionId },
        data: { state: 'ABANDONED' },
      }),
    ),
    /VOICE_CONFIG_V1_REQUIRED/,
  );
  await handleAndFlush(runtime, { ...event, type: 'call.hangup' });
  await handleAndFlush(runtime, { ...event, type: 'call.hangup' });
  assert.equal(
    await owner.interactionEvent.count({ where: { tenantId, type: 'interaction.ended' } }),
    1,
  );
  assert.equal(
    (await owner.interaction.findUniqueOrThrow({ where: { id: created!.interactionId } })).state,
    'WRAPUP',
  );
});

test('restart preserves capped deadline; terminal and all teardown intents survive response loss', async (testContext) => {
  const context = await fixture(59);
  testContext.after(context.close);
  const { runtime, event, owner, application, tenantId } = context;
  const created = await handleAndFlush(runtime, event);
  assert.equal(created?.status, 'ASSIGNED');
  const [offer] = await owner.$queryRaw<
    { expiresAt: Date; deadline: Date; id: string }[]
  >`SELECT o.id,o.expires_at AS "expiresAt",c.preanswer_deadline AS deadline FROM voice_managed_offers o JOIN voice_managed_calls c ON c.tenant_id=o.tenant_id AND c.interaction_id=o.interaction_id WHERE o.tenant_id=${tenantId}::uuid`;
  assert.equal(offer.expiresAt.getTime(), offer.deadline.getTime());
  await delay(1100);
  const failing = new ManagedVoiceRuntime(
    application,
    {
      execute: async () => {
        throw new Error('response lost');
      },
    },
    context.dispatchApplication,
  );
  await tickAndFlush(failing, tenantId, event.telephonyNodeId);
  const terminal = await owner.interaction.findUniqueOrThrow({
    where: { id: created!.interactionId },
  });
  assert.equal(terminal.state, 'ABANDONED');
  assert.equal(
    await owner.interactionEvent.count({
      where: { tenantId, type: 'interaction.managed_terminal' },
    }),
    1,
  );
  const pending = await owner.$queryRaw<
    { count: bigint }[]
  >`SELECT count(*) AS count FROM voice_managed_commands WHERE tenant_id=${tenantId}::uuid AND status='PENDING'`;
  assert.ok(pending[0].count >= 2n);
  await tickAndFlush(runtime, tenantId, event.telephonyNodeId);
  assert.equal(
    (
      await owner.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) AS count FROM voice_managed_commands WHERE tenant_id=${tenantId}::uuid AND status='PENDING'`
    )[0].count,
    0n,
  );
  const original = context.commands.find((command) => command.type === 'offer.create')!;
  assert.equal(
    (
      await handleAndFlush(runtime, {
        ...event,
        type: 'call.answered',
        agentId: original.agentId,
        offerId: original.offerId!,
        blegUuid: original.blegUuid,
      })
    )?.status,
    'ABANDONED',
  );
  await assert.rejects(
    withTenantDatabaseTransaction(
      application,
      tenantId,
      (transaction) =>
        transaction.$executeRaw`UPDATE voice_managed_calls SET first_queue_entered_at=first_queue_entered_at+interval '1 second',preanswer_deadline=preanswer_deadline+interval '1 second' WHERE tenant_id=${tenantId}::uuid`,
    ),
    /MANAGED_RUNTIME_IMMUTABLE/,
  );
});

test('dispatch is serialized across workers; next offer waits for actual old leg cancellation', async (testContext) => {
  const context = await fixture();
  testContext.after(context.close);
  const { runtime, event, owner, application, tenantId } = context;
  await handleAndFlush(runtime, event);
  const first = context.commands.find((command) => command.type === 'offer.create')!;
  await owner.$executeRaw`UPDATE voice_managed_offers SET expires_at=clock_timestamp() WHERE tenant_id=${tenantId}::uuid AND id=${first.offerId}::uuid`;
  let executing = 0,
    maxExecuting = 0,
    cancellationConfirmed = false;
  const commands: ManagedVoiceDirectCommand[] = [];
  const port: ManagedVoiceDirectPort = {
    execute: async (command) => {
      executing++;
      maxExecuting = Math.max(maxExecuting, executing);
      commands.push(command);
      await delay(50);
      executing--;
      return { confirmed: command.type === 'offer.cancel' ? cancellationConfirmed : true };
    },
  };
  const one = new ManagedVoiceRuntime(application, port, context.dispatchApplication),
    two = new ManagedVoiceRuntime(application, port, context.dispatchApplication);
  await Promise.all([
    tickAndFlush(one, tenantId, event.telephonyNodeId),
    tickAndFlush(two, tenantId, event.telephonyNodeId),
  ]);
  assert.equal(maxExecuting, 1);
  assert.equal(commands.filter((command) => command.type === 'offer.create').length, 0);
  const otherCall = { ...event, callUuid: randomUUID() };
  assert.equal((await handleAndFlush(one, otherCall))?.status, 'QUEUED');
  const reserved = await owner.agentStateLog.findFirst({
    where: { tenantId, userId: first.agentId },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  });
  assert.equal(reserved?.state, 'RESERVED');
  cancellationConfirmed = true;
  await tickAndFlush(one, tenantId, event.telephonyNodeId);
  assert.equal(commands.filter((command) => command.type === 'offer.create').length, 1);
  assert.notEqual(
    commands.find((command) => command.type === 'offer.create')!.agentId,
    first.agentId,
  );
  await handleAndFlush(runtime, { ...event, type: 'call.hangup' });
  const late = {
    ...event,
    type: 'call.answered' as const,
    offerId: first.offerId!,
    agentId: first.agentId,
    blegUuid: first.blegUuid,
  };
  assert.equal((await handleAndFlush(runtime, late))?.status, 'ABANDONED');
});

test('teardown acknowledgement does not overwrite a newer BUSY agent state', async (testContext) => {
  const context = await fixture(0, 1);
  testContext.after(context.close);
  const { runtime, event, owner, application, tenantId } = context;
  await handleAndFlush(runtime, event);
  const offer = context.commands.find((command) => command.type === 'offer.create')!;
  const blocked = new ManagedVoiceRuntime(
    application,
    {
      execute: async () => ({ confirmed: false }),
    },
    context.dispatchApplication,
  );
  await handleAndFlush(blocked, { ...event, type: 'call.hangup' });
  assert.equal(
    (
      await owner.agentStateLog.findFirst({
        where: { tenantId, userId: offer.agentId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      })
    )?.state,
    'RESERVED',
  );
  await owner.agentStateLog.create({
    data: { tenantId, userId: offer.agentId!, state: 'BUSY', reason: 'newer-state' },
  });
  await tickAndFlush(runtime, tenantId, event.telephonyNodeId);
  assert.equal(
    (
      await owner.agentStateLog.findFirst({
        where: { tenantId, userId: offer.agentId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      })
    )?.state,
    'BUSY',
  );
});

test('managed admission rejects inactive queues, non-direct entry and unsupported media policy', async (testContext) => {
  const context = await fixture();
  testContext.after(context.close);
  const { runtime, event, owner, tenantId, queueId } = context;
  for (const data of [
    { isActive: false },
    { isActive: true, recordingEnabled: true },
    { recordingEnabled: false, autoQmEnabled: true },
    { autoQmEnabled: false, routingStrategy: 'ROUND_ROBIN' as const },
  ]) {
    await owner.queue.update({ where: { id: queueId }, data });
    assert.equal(await handleAndFlush(runtime, { ...event, callUuid: randomUUID() }), null);
  }
  await owner.queue.update({
    where: { id: queueId },
    data: { routingStrategy: 'LONGEST_AVAILABLE_IDLE' },
  });
  await owner.voiceDestination.updateMany({ where: { tenantId }, data: { entryMode: 'IVR' } });
  assert.equal(await handleAndFlush(runtime, { ...event, callUuid: randomUUID() }), null);
  assert.equal(await owner.interaction.count({ where: { tenantId } }), 0);
});

test('old writer waiting on an interaction cannot win managed answer CAS', async (testContext) => {
  const context = await fixture();
  testContext.after(context.close);
  const { runtime, event, owner, application, tenantId } = context;
  const created = await handleAndFlush(runtime, event);
  const offer = context.commands.find((command) => command.type === 'offer.create')!;
  let unlock!: () => void, locked!: () => void;
  const lockAcquired = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const releaseLock = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const blocker = owner.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT id FROM interactions WHERE id=${created!.interactionId}::uuid FOR UPDATE`;
    locked();
    await releaseLock;
  });
  await lockAcquired;
  let writerStarted!: (backendPid: number) => void;
  const writerBackend = new Promise<number>((resolve) => {
    writerStarted = resolve;
  });
  const oldWriter = withTenantDatabaseTransaction(application, tenantId, async (transaction) => {
    const [backend] = await transaction.$queryRaw<
      { pid: number }[]
    >`SELECT pg_backend_pid() AS pid`;
    writerStarted(backend.pid);
    return transaction.interaction.update({
      where: { id: created!.interactionId },
      data: { state: 'ACTIVE' },
    });
  }).then(
    () => ({ rejected: false }),
    (error) => ({ rejected: /VOICE_CONFIG_V1_REQUIRED/.test(String(error)) }),
  );
  const writerPid = await writerBackend;
  try {
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const [activity] = await owner.$queryRaw<{ waiting: boolean }[]>`
        SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=${writerPid}`;
      if (activity?.waiting) {
        waiting = true;
        break;
      }
      await delay(10);
    }
    assert.equal(waiting, true, 'old writer must be waiting on the held interaction row');
  } catch (error) {
    unlock();
    await Promise.allSettled([blocker, oldWriter]);
    throw error;
  }
  const answer = handleAndFlush(runtime, {
    ...event,
    type: 'call.answered',
    agentId: offer.agentId,
    offerId: offer.offerId!,
    blegUuid: offer.blegUuid,
  });
  unlock();
  await blocker;
  const [writerResult, answerResult] = await Promise.all([oldWriter, answer]);
  assert.equal(writerResult.rejected, true);
  assert.equal(answerResult?.status, 'ACTIVE');
  assert.equal(
    await owner.interactionEvent.count({ where: { tenantId, type: 'interaction.answered' } }),
    1,
  );
});

test('unknown originate outcome remains durable action required without repeated reconciliation events', async (testContext) => {
  const context = await fixture(0, 1);
  testContext.after(context.close);
  const { runtime, event, application, owner, tenantId } = context;
  await handleAndFlush(runtime, event);
  const failure = Object.assign(new Error('private provider details'), {
    code: 'MANAGED_VOICE_ORIGINATE_OUTCOME_UNKNOWN',
  });
  const restarted = new ManagedVoiceRuntime(
    application,
    {
      execute: async () => {
        throw failure;
      },
    },
    context.dispatchApplication,
  );
  await handleAndFlush(restarted, { ...event, type: 'call.hangup' });
  const count = await owner.interactionEvent.count({
    where: { tenantId, type: 'interaction.managed_reconciliation_required' },
  });
  assert.ok(count > 0);
  await tickAndFlush(restarted, tenantId, event.telephonyNodeId);
  assert.equal(
    await owner.interactionEvent.count({
      where: { tenantId, type: 'interaction.managed_reconciliation_required' },
    }),
    count,
  );
  const pending = await owner.$queryRaw<
    { status: string; lastError: string }[]
  >`SELECT status,last_error AS "lastError" FROM voice_managed_commands WHERE tenant_id=${tenantId}::uuid AND command_type IN ('offer.cancel','call.hangup')`;
  assert.ok(
    pending.every(
      (command) =>
        command.status === 'PENDING' &&
        command.lastError === 'MANAGED_VOICE_ORIGINATE_OUTCOME_UNKNOWN',
    ),
  );
});

test('readiness is tenant/node/version/expiry scoped and legacy writes cannot extend managed calls', async (testContext) => {
  const context = await fixture();
  testContext.after(context.close);
  const { runtime, event, application, tenantId } = context;
  await runtime.heartbeat(tenantId, 'fs-test');
  await withTenantDatabaseTransaction(application, tenantId, async (transaction) => {
    const [ready] = await transaction.$queryRaw<
      { ready: boolean; wrong: boolean }[]
    >`SELECT dc_voice_managed_runtime_ready(${tenantId}::uuid,'fs-test') AS ready,dc_voice_managed_runtime_ready(${tenantId}::uuid,'other') AS wrong`;
    assert.equal(ready.ready, true);
    assert.equal(ready.wrong, false);
    assert.equal(
      (
        await transaction.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) AS count FROM voice_managed_runtime_readiness WHERE tenant_id=${randomUUID()}::uuid`
      )[0].count,
      0n,
    );
  });
  const created = await handleAndFlush(runtime, event);
  await assert.rejects(
    withTenantDatabaseTransaction(application, tenantId, (transaction) =>
      transaction.interaction.update({
        where: { id: created!.interactionId },
        data: { offerExpiresAt: new Date(Date.now() + 120000) },
      }),
    ),
    /VOICE_CONFIG_V1_REQUIRED/,
  );
});
