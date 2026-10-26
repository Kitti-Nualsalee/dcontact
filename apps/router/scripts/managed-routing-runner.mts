import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '@d-contact/db';
import { ManagedVoiceRuntime } from '../src/managed-voice-runtime.js';
import type {
  ManagedVoiceDirectCommand,
  ManagedVoiceEvent,
} from '../src/managed-voice-contracts.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const evidence = process.env.MANAGED_EVIDENCE!;
const prefix = process.env.MANAGED_PREFIX!;
const nodeId = 'managed-local';
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const owner = new PrismaClient();
const source = (name: string) => new URL(`../../telephony/src/${name}.ts`, import.meta.url).href;
const { E1EslCommandClient } = await import(source('e1-esl-command-client'));
const { FreeSwitchManagedVoiceAdapter } = await import(source('managed-voice-adapter'));
const { normalizeManagedVoiceEvent } = await import(source('managed-voice-events'));
const esl = new E1EslCommandClient({
  host: '127.0.0.1',
  port: Number(process.env.MANAGED_ESL_PORT),
  password: 'managed-local-only',
});
const adapter = new FreeSwitchManagedVoiceAdapter(esl, nodeId, 'managed.test');
const audit = (value: unknown) =>
  appendFileSync(resolve(evidence, 'runtime.jsonl'), `${JSON.stringify(value)}\n`);

async function until<T>(
  read: () => Promise<T>,
  accept: (value: T) => boolean,
  timeout = 15000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (accept(value)) return value;
    await wait(150);
  }
  throw new Error(`รอหลักฐานเกิน ${timeout}ms`);
}

interface Fixture {
  tenantId: string;
  destination: string;
  agents: string[];
  delayAnswer?: boolean;
}
const fixturesPath = resolve(evidence, 'fixtures.json');

async function runtimeChild() {
  const fixtures: Fixture[] = JSON.parse(readFileSync(fixturesPath, 'utf8'));
  const applicationUrl = new URL(process.env.APPLICATION_DATABASE_URL!);
  applicationUrl.searchParams.set('connection_limit', '1');
  const application = new PrismaClient({
    datasources: { db: { url: applicationUrl.href } },
  });
  const dispatchApplication = new PrismaClient({
    datasources: { db: { url: applicationUrl.href } },
  });
  const [databaseRole] = await application.$queryRaw<
    { role: string; bypass: boolean }[]
  >`SELECT current_user AS role,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`;
  assert.equal(databaseRole.role, 'dcontact_app');
  assert.equal(databaseRole.bypass, false);
  audit({ databaseRole });
  const runtime = new ManagedVoiceRuntime(
    application,
    {
      readback: (command: ManagedVoiceDirectCommand) => adapter.readback(command),
      async execute(command: ManagedVoiceDirectCommand) {
        audit({ at: new Date(), command });
        if (
          command.type === 'call.hangup' &&
          existsSync(resolve(evidence, 'hold-dispatch')) &&
          command.tenantId === fixtures[2].tenantId
        ) {
          writeFileSync(resolve(evidence, 'dispatch-blocked.json'), JSON.stringify(command));
          return new Promise<{ confirmed: boolean }>(() => {});
        }
        const result = await adapter.execute(command);
        const channels = await adapter.readback(command);
        audit({
          at: new Date(),
          commandResult: { commandId: command.commandId, ...result },
          channels,
          blegUuid: command.blegUuid,
        });
        return result;
      },
    },
    dispatchApplication,
  );
  assert.equal(await adapter.ready(), true);
  let work = Promise.resolve();
  const enqueue = (action: () => Promise<unknown>) => {
    work = work
      .then(async () => {
        await action();
      })
      .catch((error) => {
        audit({ fatal: String(error), stack: error.stack });
        console.error(error);
        process.exit(1);
      });
  };
  const socket = net.createConnection({
    host: '127.0.0.1',
    port: Number(process.env.MANAGED_ESL_PORT),
  });
  let buffer = Buffer.alloc(0);
  let stage = 0;
  socket.on('error', (error) => {
    console.error(error);
    process.exit(1);
  });
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const end = buffer.indexOf('\n\n');
      if (end < 0) return;
      const header = buffer.subarray(0, end).toString();
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
      if (buffer.length < end + 2 + length) return;
      const body = buffer.subarray(end + 2, end + 2 + length).toString();
      buffer = buffer.subarray(end + 2 + length);
      if (stage === 0) {
        socket.write('auth managed-local-only\n\n');
        stage = 1;
        continue;
      }
      if (stage === 1) {
        assert.match(header, /\+OK accepted/);
        socket.write(
          'event json CHANNEL_PARK CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE BACKGROUND_JOB\n\n',
        );
        stage = 2;
        continue;
      }
      if (!body || !/text\/event-json/.test(header)) continue;
      const event = JSON.parse(body);
      if (event['Event-Name'] === 'BACKGROUND_JOB') {
        audit({ backgroundJob: event });
        enqueue(() => adapter.backgroundJob(event['Job-UUID']));
        continue;
      }
      const fixture = fixtures.find(
        (item) =>
          item.tenantId === event.variable_dcontact_tenant_id ||
          (event['Event-Name'] === 'CHANNEL_PARK' &&
            item.destination === event['Caller-Destination-Number'] &&
            !event.variable_dcontact_offer_id),
      );
      if (!fixture) continue;
      enqueue(async () => {
        if (event['Event-Name'] === 'CHANNEL_PARK' && !event.variable_dcontact_offer_id) {
          await adapter.bindCaller(fixture.tenantId, event['Unique-ID']);
          event['Event-Name'] = 'CHANNEL_CREATE';
        }
        const normalized: ManagedVoiceEvent | undefined = normalizeManagedVoiceEvent(
          event,
          fixture.tenantId,
          nodeId,
        );
        if (!normalized) return;
        audit({ at: new Date(), event: normalized });
        if (
          fixture.delayAnswer &&
          normalized.type === 'call.answered' &&
          event.variable_dcontact_agent_id === fixture.agents[0]
        ) {
          setTimeout(
            () =>
              enqueue(async () => {
                audit({ lateReplay: normalized, at: new Date() });
                await runtime.handle(normalized);
              }),
            25000,
          );
        } else await runtime.handle(normalized);
      });
    }
  });
  for (const fixture of fixtures) await runtime.heartbeat(fixture.tenantId, nodeId);
  const dueBusy = new Set<string>();
  const dispatchBusy = new Set<string>();
  const pump = (busy: Set<string>, action: (fixture: Fixture) => Promise<void>, fatal = true) => {
    for (const fixture of fixtures) {
      if (busy.has(fixture.tenantId)) continue;
      busy.add(fixture.tenantId);
      void action(fixture)
        .catch((error) => {
          audit({ [fatal ? 'fatal' : 'dispatchRetry']: String(error), stack: error.stack });
          if (fatal) {
            console.error(error);
            process.exit(1);
          }
        })
        .finally(() => busy.delete(fixture.tenantId));
    }
  };
  const tick = setInterval(
    () =>
      pump(dueBusy, async (fixture) => {
        await runtime.heartbeat(fixture.tenantId, nodeId);
        await runtime.tick(fixture.tenantId, nodeId);
      }),
    1000,
  );
  const dispatch = setInterval(
    () =>
      pump(
        dispatchBusy,
        async (fixture) => {
          await runtime.flushCommands(fixture.tenantId, nodeId);
        },
        false,
      ),
    150,
  );
  process.once('SIGTERM', () => {
    clearInterval(tick);
    clearInterval(dispatch);
    socket.destroy();
    void Promise.all([application.$disconnect(), dispatchApplication.$disconnect()]).finally(() =>
      process.exit(),
    );
  });
  await wait(500);
  writeFileSync(resolve(evidence, 'runtime-ready'), String(process.pid));
}

async function seed(destination: string, count: number, delayAnswer = false): Promise<Fixture> {
  const tenantId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Managed ${destination}`,
      slug: `managed-${tenantId}`,
      sipDomain: `${tenantId}.test`,
    },
  });
  const team = await owner.team.create({ data: { tenantId, name: 'Managed team' } });
  const queue = await owner.queue.create({
    data: {
      tenantId,
      name: 'Managed queue',
      teamId: team.id,
      channels: ['VOICE'],
      voiceConfigVersion: 1,
      voiceWrapupPolicy: 'VOICE_NOTE_V1',
    },
  });
  const skill = await owner.skill.create({
    data: {
      tenantId,
      teamId: team.id,
      name: 'Managed skill',
      code: 'MANAGED',
      voiceConfigVersion: 1,
    },
  });
  await owner.voiceManagedQueuePolicy.create({ data: { tenantId, queueId: queue.id } });
  await owner.queueSkill.create({
    data: { tenantId, queueId: queue.id, skillId: skill.id, minLevel: 2 },
  });
  const binding = await owner.voiceDestination.create({
    data: { tenantId, queueId: queue.id, destination, voiceConfigVersion: 1 },
  });
  await owner.tenantVoiceProvisioningPolicy.create({
    data: {
      tenantId,
      revision: 1,
      sourceKind: 'UAT_EXPLICIT',
      accountsLimit: 10,
      agentsLimit: 10,
      voiceQueuesLimit: 5,
      skillsLimit: 5,
      approvedByOperatorSubject: 'managed-acceptance',
      approvedAt: new Date(),
      approvalRef: '#712',
      reason: 'isolated SIP acceptance',
      destinationPool: [{ destinationId: binding.id, telephonyNodeId: nodeId }],
    },
  });
  const agents: string[] = [];
  for (let index = 1; index <= count; index++) {
    const user = await owner.user.create({
      data: {
        tenantId,
        teamId: team.id,
        email: `agent${index}@${tenantId}.test`,
        passwordHash: '-',
        displayName: `Agent ${index}`,
        role: 'AGENT',
        extension: `100${index}`,
      },
    });
    agents.push(user.id);
    await owner.agentSkill.create({
      data: { tenantId, userId: user.id, skillId: skill.id, level: 3 },
    });
    await owner.agentStateLog.create({
      data: {
        tenantId,
        userId: user.id,
        state: 'AVAILABLE',
        startedAt: new Date(Date.now() - 10000 + index * 1000),
      },
    });
  }
  return { tenantId, destination, agents, delayAnswer };
}

function docker(...args: string[]) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 0, `${args.join(' ')} ${result.stderr}`);
  return result.stdout.trim();
}

async function suite() {
  const fixtures = [
    await seed('2000', 2),
    await seed('2001', 0),
    await seed('2002', 3),
    await seed('2003', 2, true),
  ];
  writeFileSync(fixturesPath, JSON.stringify(fixtures));
  writeFileSync(resolve(evidence, 'hold-dispatch'), 'commit-before-dispatch');
  let worker: ChildProcess | undefined;
  const callers: string[] = [];
  const { unlinkSync } = await import('node:fs');
  async function startWorker() {
    try {
      unlinkSync(resolve(evidence, 'runtime-ready'));
    } catch {}
    worker = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], {
      env: { ...process.env, MANAGED_RUNTIME_CHILD: '1' },
      stdio: 'inherit',
    });
    await until(async () => existsSync(resolve(evidence, 'runtime-ready')), Boolean);
  }
  const state = async (fixture: Fixture) => {
    const rows = await owner.$queryRawUnsafe<any[]>(
      `SELECT c.*,i.state,i.ended_at FROM voice_managed_calls c JOIN interactions i ON i.id=c.interaction_id AND i.tenant_id=c.tenant_id WHERE c.tenant_id=$1::uuid`,
      fixture.tenantId,
    );
    return rows[0];
  };
  const offers = (fixture: Fixture) =>
    owner.$queryRawUnsafe<any[]>(
      'SELECT * FROM voice_managed_offers WHERE tenant_id=$1::uuid ORDER BY assigned_at',
      fixture.tenantId,
    );
  const exists = async (uuid: string) => (await esl.request(`api uuid_exists ${uuid}`)) === 'true';
  const cases: unknown[] = [];
  function caller(fixture: Fixture) {
    const name = `${prefix}-caller-${fixture.destination}`;
    callers.push(name);
    docker(
      'run',
      '-d',
      '--name',
      name,
      '--network',
      process.env.MANAGED_NETWORK!,
      '--memory',
      '96m',
      '--memory-swap',
      '96m',
      '--cpus',
      '0.5',
      '--pids-limit',
      '64',
      '--log-opt',
      'max-size=2m',
      '-v',
      `${resolve(root, 'scripts/fixtures')}:/fixtures:ro`,
      '-v',
      `${evidence}:/evidence`,
      '--entrypoint',
      'sh',
      process.env.MANAGED_SIPP_IMAGE!,
      '-c',
      `cd /evidence && exec sipp freeswitch:5060 -sf /fixtures/${fixture.delayAnswer ? 'managed-caller-hangup.xml' : 'managed-caller.xml'} -s ${fixture.destination} -i $(hostname -i) -p 5060 -m 1 -nostdin -trace_msg -trace_err -message_file caller-${fixture.destination}-messages.log -error_file caller-${fixture.destination}-errors.log`,
    );
  }
  async function callerPassed(fixture: Fixture) {
    await until(
      async () =>
        docker(
          'inspect',
          '--format',
          '{{.State.Status}}',
          `${prefix}-caller-${fixture.destination}`,
        ),
      (value) => value === 'exited',
    );
    assert.equal(
      docker(
        'inspect',
        '--format',
        '{{.State.ExitCode}}',
        `${prefix}-caller-${fixture.destination}`,
      ),
      '0',
    );
    assert.match(
      readFileSync(resolve(evidence, `caller-${fixture.destination}-messages.log`), 'utf8'),
      /BYE sip:/,
    );
    const trace = readFileSync(
      resolve(evidence, `caller-${fixture.destination}-messages.log`),
      'utf8',
    );
    const byeBlock = trace.split(/(?=-{20,} \d{4}-)/).find((block) => /^BYE sip:/m.test(block));
    const stamp = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+/.exec(byeBlock ?? '')?.[0];
    assert.ok(stamp);
    const byeAt = new Date(`${stamp.replace(' ', 'T').slice(0, 23)}Z`);
    const call = await state(fixture);
    const actualSipSeconds = (byeAt.getTime() - call.first_queue_entered_at.getTime()) / 1000;
    assert.ok(
      actualSipSeconds >= 60 && actualSipSeconds < 80,
      `SIP BYE timing: ${actualSipSeconds}`,
    );
    return { byeAt, actualSipSeconds };
  }
  try {
    await startWorker();
    caller(fixtures[2]);
    await until(
      () => state(fixtures[2]),
      (value) => Boolean(value),
    );
    await wait(1500);
    for (const fixture of fixtures.slice(0, 2)) caller(fixture);
    for (const fixture of [fixtures[0], fixtures[2]]) {
      const initial = await until(
        () => offers(fixture),
        (value) => value.length > 0,
      );
      await until(() => exists(initial[0].bleg_uuid), Boolean, 5000);
    }
    await until(
      async () => offers(fixtures[0]),
      (value) => value.length === 2,
      30000,
    );
    const firstOffers = await offers(fixtures[0]);
    writeFileSync(resolve(evidence, 'first-offers.json'), JSON.stringify(firstOffers, null, 2));
    assert.equal(firstOffers[0].agent_id, fixtures[0].agents[0]);
    assert.equal(firstOffers[1].agent_id, fixtures[0].agents[1]);
    assert.equal(firstOffers[0].outcome, 'TIMED_OUT');
    assert.equal(firstOffers[0].expires_at.getTime() - firstOffers[0].assigned_at.getTime(), 20000);
    const elapsed = firstOffers[1].assigned_at.getTime() - firstOffers[0].assigned_at.getTime();
    assert.ok(elapsed >= 20000 && elapsed < 23000, `20s: ${elapsed}`);
    assert.equal(await exists(firstOffers[0].bleg_uuid), false);
    cases.push({ name: 'twoAgents-noanswer20s-skip-next', elapsed });
    await until(async () => existsSync(resolve(evidence, 'dispatch-blocked.json')), Boolean, 50000);
    const blocked = JSON.parse(readFileSync(resolve(evidence, 'dispatch-blocked.json'), 'utf8'));
    const before = await state(fixtures[2]);
    assert.equal(before.state, 'ABANDONED');
    assert.equal(await exists(blocked.callUuid), true);
    const blegAliveBeforeRestart = await exists(blocked.blegUuid);
    const pending = await owner.$queryRawUnsafe<any[]>(
      'SELECT status FROM voice_managed_commands WHERE id=$1::uuid',
      blocked.commandId,
    );
    assert.equal(pending[0].status, 'PENDING');
    const otherDeadlines = [];
    for (const fixture of fixtures.slice(0, 2)) {
      const terminal = await until(
        () => state(fixture),
        (value) => value?.state === 'ABANDONED',
        15000,
      );
      const elapsed = terminal.ended_at.getTime() - terminal.first_queue_entered_at.getTime();
      assert.ok(elapsed >= 60000 && elapsed < 62500, `DB deadline while RPC blocked: ${elapsed}`);
      otherDeadlines.push({ destination: fixture.destination, elapsed });
    }
    assert.equal(await exists(blocked.callUuid), true);
    const stillPending = await owner.$queryRawUnsafe<{ status: string }[]>(
      'SELECT status FROM voice_managed_commands WHERE id=$1::uuid',
      blocked.commandId,
    );
    assert.equal(stillPending[0].status, 'PENDING');
    cases.push({
      name: 'blocked-dispatch-A-does-not-stop-B-deadline',
      connectionLimit: 1,
      blockedCallerStillExists: true,
      otherDeadlines,
      checkedAt: new Date(),
    });
    worker!.kill('SIGKILL');
    await new Promise((done) => worker!.once('exit', done));
    unlinkSync(resolve(evidence, 'hold-dispatch'));
    await startWorker();
    await until(
      async () => exists(blocked.callUuid),
      (value) => !value,
    );
    assert.equal(await exists(blocked.blegUuid), false);
    await until(
      () =>
        owner.$queryRawUnsafe<{ status: string }[]>(
          'SELECT status FROM voice_managed_commands WHERE id=$1::uuid',
          blocked.commandId,
        ),
      (value) => value[0]?.status === 'CONFIRMED',
    );
    const after = await state(fixtures[2]);
    assert.equal(after.preanswer_deadline.toISOString(), before.preanswer_deadline.toISOString());
    const restartSip = await callerPassed(fixtures[2]);
    cases.push({
      name: 'restart-after-DBcommit-before-dispatch-actual-caller-and-Bleg',
      commandId: blocked.commandId,
      blegAliveBeforeRestart,
      ...restartSip,
      deadline: after.preanswer_deadline,
    });
    for (const fixture of fixtures.slice(0, 2)) {
      const terminal = await until(
        () => state(fixture),
        (value) => value?.state === 'ABANDONED',
      );
      const seconds = (Date.now() - terminal.first_queue_entered_at.getTime()) / 1000;
      assert.ok(seconds >= 60 && seconds < 75);
      assert.equal(terminal.terminal_reason, 'PREANSWER_DEADLINE_EXCEEDED');
      if (fixture.agents.length) assert.equal((await offers(fixture)).length, 2);
      else assert.equal((await offers(fixture)).length, 0);
      const sip = await callerPassed(fixture);
      cases.push({
        name: fixture.agents.length
          ? 'total60s-real-caller-hangup-no-repeat'
          : 'noeligible-total60s-real-hangup',
        seconds,
        ...sip,
      });
    }
    for (const index of [1, 2]) {
      docker('rm', '-f', `${prefix}-agent${index}`);
      docker(
        'run',
        '-d',
        '--name',
        `${prefix}-agent${index}`,
        '--network',
        process.env.MANAGED_NETWORK!,
        '--network-alias',
        `agent${index}`,
        '--memory',
        '96m',
        '--memory-swap',
        '96m',
        '--cpus',
        '0.5',
        '--pids-limit',
        '64',
        '--log-opt',
        'max-size=2m',
        '-v',
        `${resolve(root, 'scripts/fixtures')}:/fixtures:ro`,
        '-v',
        `${evidence}:/evidence`,
        '--entrypoint',
        'sh',
        process.env.MANAGED_SIPP_IMAGE!,
        '-c',
        `cd /evidence && exec sipp -sf /fixtures/managed-answer.xml -i $(hostname -i) -p 5060 -nostdin -trace_msg -trace_err -message_file answered-agent${index}-messages.log -error_file answered-agent${index}-errors.log`,
      );
    }
    caller(fixtures[3]);
    const active = await until(
      () => state(fixtures[3]),
      (value) => value?.state === 'ACTIVE',
      35000,
    );
    const activeOffers = await offers(fixtures[3]);
    assert.equal(activeOffers.length, 2);
    assert.equal(activeOffers[0].outcome, 'TIMED_OUT');
    assert.equal(activeOffers[1].outcome, 'ANSWERED');
    const bridge = await until(
      async () => esl.request(`api uuid_getvar ${active.call_uuid} bridge_uuid`),
      (value) => value === activeOffers[1].bleg_uuid,
    );
    await wait(Math.max(0, active.preanswer_deadline.getTime() + 3000 - Date.now()));
    assert.equal((await state(fixtures[3])).state, 'ACTIVE');
    assert.equal(await exists(active.call_uuid), true);
    assert.equal(await exists(bridge), true);
    assert.match(readFileSync(resolve(evidence, 'runtime.jsonl'), 'utf8'), /lateReplay/);
    const bridgeCount = await owner.$queryRawUnsafe<any[]>(
      "SELECT count(*)::int AS count FROM voice_managed_commands WHERE tenant_id=$1::uuid AND command_type='call.bridge'",
      fixtures[3].tenantId,
    );
    assert.equal(bridgeCount[0].count, 1);
    cases.push({
      name: 'late-real-answer-fenced-ACTIVE-survives60s',
      bridge,
      callerUuid: active.call_uuid,
      checkedAt: new Date(),
      originalDeadline: active.preanswer_deadline,
      offers: activeOffers,
    });
    worker!.kill('SIGKILL');
    await new Promise((done) => worker!.once('exit', done));
    await callerPassed(fixtures[3]);
    const callerTrace = readFileSync(
      resolve(evidence, `caller-${fixtures[3].destination}-messages.log`),
      'utf8',
    );
    const callerBye = callerTrace
      .split(/(?=-{20,} \d{4}-)/)
      .find((block) => /^BYE sip:/m.test(block));
    assert.match(callerBye ?? '', /UDP message sent/);
    assert.equal(await exists(active.call_uuid), false);
    const blegAliveBeforeRecovery = await exists(bridge);
    assert.equal((await state(fixtures[3])).state, 'ACTIVE');
    await startWorker();
    const recovered = await until(
      () => state(fixtures[3]),
      (value) => value?.state === 'WRAPUP',
    );
    await until(
      async () => exists(bridge),
      (value) => !value,
    );
    assert.equal(await exists(active.call_uuid), false);
    assert.equal(
      recovered.preanswer_deadline.toISOString(),
      active.preanswer_deadline.toISOString(),
    );
    const endedEvents = () =>
      owner.interactionEvent.count({
        where: {
          tenantId: fixtures[3].tenantId,
          interactionId: active.interaction_id,
          type: 'interaction.ended',
        },
      });
    assert.equal(await endedEvents(), 1);
    await wait(1500);
    assert.equal(await endedEvents(), 1);
    cases.push({
      name: 'active-restart-missed-hangup-real-caller-BYE-wrapup',
      callerUuid: active.call_uuid,
      blegUuid: bridge,
      blegAliveBeforeRecovery,
      state: recovered.state,
      checkedAt: new Date(),
    });
    const journal = readFileSync(resolve(evidence, 'runtime.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    for (const fixture of fixtures) {
      for (const offer of await offers(fixture)) {
        assert.ok(
          journal.some(
            (entry) => entry.blegUuid === offer.bleg_uuid && entry.channels?.blegExists === true,
          ),
          `ไม่เคยพบ B-leg จริง ${offer.bleg_uuid}`,
        );
        assert.equal(await exists(offer.bleg_uuid), false);
      }
      const call = await state(fixture);
      assert.equal(await exists(call.call_uuid), false);
    }
    for (const index of [1, 2, 3]) {
      assert.match(
        readFileSync(resolve(evidence, `agent${index}-messages.log`), 'utf8'),
        /INVITE sip:/,
      );
      assert.match(
        readFileSync(resolve(evidence, `agent${index}-messages.log`), 'utf8'),
        /CANCEL sip:/,
      );
    }
    writeFileSync(
      resolve(evidence, 'result.json'),
      JSON.stringify({ status: 'PASS', cases }, null, 2),
    );
  } finally {
    writeFileSync(resolve(evidence, 'progress.json'), JSON.stringify({ cases }, null, 2));
    worker?.kill('SIGKILL');
    for (const name of callers) spawnSync('docker', ['rm', '-f', name], { timeout: 15000 });
    await owner.$disconnect();
  }
}

if (process.env.MANAGED_RUNTIME_CHILD === '1') await runtimeChild();
else await suite();
