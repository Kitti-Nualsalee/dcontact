import assert from 'node:assert/strict';
import test from 'node:test';
import { ManagedVoiceReconciliationRequiredError } from './managed-voice-adapter.js';
import type { ManagedVoiceDirectCommand } from '@d-contact/router';
import {
  FreeSwitchManagedVoiceAdapter,
  type ManagedVoiceEslTransport,
} from './managed-voice-adapter.js';

const command: ManagedVoiceDirectCommand = {
  commandId: 'a0000000-0000-4000-8000-000000000001',
  tenantId: 'a0000000-0000-4000-8000-000000000002',
  interactionId: 'a0000000-0000-4000-8000-000000000003',
  callUuid: 'a0000000-0000-4000-8000-000000000004',
  offerId: 'a0000000-0000-4000-8000-000000000005',
  blegUuid: 'a0000000-0000-4000-8000-000000000006',
  agentId: 'a0000000-0000-4000-8000-000000000007',
  telephonyNodeId: 'fs-test',
  agentExtension: '1101',
  type: 'offer.create',
  expiresAt: new Date(Date.now() + 20000).toISOString(),
};

class Switch implements ManagedVoiceEslTransport {
  channels = new Map<string, Record<string, string>>();
  commands: string[] = [];
  retainOnKill = false;
  globals = new Map<string, string>();
  deferOriginate = false;
  loseReply = false;
  constructor() {
    this.channels.set(command.callUuid, {
      dcontact_tenant_id: command.tenantId,
      dcontact_node_id: command.telephonyNodeId,
      dcontact_call_uuid: command.callUuid,
    });
  }
  async request(value: string) {
    this.commands.push(value);
    const [, action, channel, name] = value.split(' ');
    if (action === 'global_getvar') return this.globals.get(channel) ?? '-ERR no reply';
    if (action === 'global_setvar') {
      const separator = channel.indexOf('=');
      this.globals.set(channel.slice(0, separator), channel.slice(separator + 1));
      return '+OK';
    }
    if (action === 'uuid_exists') return String(this.channels.has(channel));
    if (action === 'uuid_getvar') return this.channels.get(channel)?.[name] ?? '_undef_';
    if (action === 'uuid_setvar') {
      this.channels.get(channel)![name] = value.split(' ')[4];
      return '+OK';
    }
    if (action === 'originate') {
      const variables = Object.fromEntries(
        [...value.matchAll(/([a-z_]+)=([^,}]+)/g)].map((match) => [match[1], match[2]]),
      );
      if (!this.deferOriginate) this.channels.set(variables.origination_uuid, variables);
      if (this.loseReply) throw new Error('response lost');
      return '+OK Job-UUID: a0000000-0000-4000-8000-000000000008';
    }
    if (action === 'uuid_kill') {
      if (!this.retainOnKill) this.channels.delete(channel);
      return '+OK';
    }
    if (action === 'uuid_bridge') {
      this.channels.get(channel)!.bridge_uuid = name;
      return '+OK';
    }
    throw new Error(`Unexpected command ${value}`);
  }
}

test('offer replay ใช้ stable B-leg และ exact variables โดยไม่ originate ซ้ำ', async () => {
  const transport = new Switch();
  const adapter = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  assert.deepEqual(await adapter.execute(command), { confirmed: true });
  assert.deepEqual(await adapter.execute(command), { confirmed: true });
  assert.equal(transport.commands.filter((value) => value.startsWith('bgapi originate')).length, 1);
  assert.equal(transport.channels.get(command.blegUuid)?.dcontact_offer_id, command.offerId);
  assert.equal(transport.channels.get(command.blegUuid)?.dcontact_agent_id, command.agentId);
  assert.deepEqual(await adapter.execute({ ...command, type: 'call.bridge' }), { confirmed: true });
  assert.deepEqual(await adapter.execute({ ...command, type: 'call.bridge' }), { confirmed: true });
  assert.equal(transport.commands.filter((value) => value.startsWith('api uuid_bridge')).length, 1);
});

test('cancel ตรวจ teardown จริงและไม่ฆ่า caller; restart adapter reconcile จาก switch', async () => {
  const transport = new Switch();
  await new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local').execute(command);
  const restarted = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  transport.retainOnKill = true;
  assert.deepEqual(await restarted.execute({ ...command, type: 'offer.cancel' }), {
    confirmed: false,
  });
  transport.retainOnKill = false;
  assert.deepEqual(await restarted.execute({ ...command, type: 'offer.cancel' }), {
    confirmed: true,
  });
  assert.equal(transport.channels.has(command.callUuid), true);
  assert.deepEqual(await restarted.execute({ ...command, type: 'call.hangup' }), {
    confirmed: true,
  });
  assert.equal(transport.channels.size, 0);
});

test('scope mismatch และ injection ถูกปฏิเสธก่อน destructive dispatch', async () => {
  const transport = new Switch();
  const adapter = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  await assert.rejects(
    adapter.execute({ ...command, telephonyNodeId: 'other' }),
    /INVALID_COMMAND/,
  );
  await assert.rejects(
    adapter.execute({ ...command, agentExtension: '1101 &shutdown()' }),
    /INVALID_OFFER/,
  );
  transport.channels.get(command.callUuid)!.dcontact_tenant_id = 'another-tenant';
  await assert.rejects(adapter.execute({ ...command, type: 'call.hangup' }), /SCOPE_MISMATCH/);
  assert.equal(
    transport.commands.some((value) => value.includes('uuid_kill')),
    false,
  );
});

test('ambiguous originate ไม่ส่งซ้ำหลัง restart; absence ยังไม่ใช่ quiescence จน real job จบ', async () => {
  const transport = new Switch();
  transport.deferOriginate = true;
  const adapter = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  assert.deepEqual(await adapter.execute(command), { confirmed: false });
  const restarted = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  assert.deepEqual(await restarted.execute(command), { confirmed: false });
  await assert.rejects(
    restarted.execute({ ...command, type: 'offer.cancel' }),
    ManagedVoiceReconciliationRequiredError,
  );
  await restarted.backgroundJob('a0000000-0000-4000-8000-000000000008');
  assert.deepEqual(await restarted.execute({ ...command, type: 'offer.cancel' }), {
    confirmed: true,
  });
  assert.equal(transport.commands.filter((value) => value.startsWith('bgapi originate')).length, 1);
});

test('response lost และ concurrent replay reconcile B-leg เดิม และ payload mismatch ไม่ถูกยอมรับ', async () => {
  const transport = new Switch();
  transport.loseReply = true;
  const adapter = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  await assert.rejects(adapter.execute(command), /response lost/);
  const restarted = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  const results = await Promise.all([restarted.execute(command), restarted.execute(command)]);
  assert.deepEqual(results, [{ confirmed: true }, { confirmed: true }]);
  assert.equal(transport.commands.filter((value) => value.startsWith('bgapi originate')).length, 1);
  await assert.rejects(
    restarted.execute({ ...command, agentExtension: '1102' }),
    /PAYLOAD_MISMATCH/,
  );
});

test('late B-leg หลัง cancel absence ถูก teardown ก่อนยืนยัน cleanup', async () => {
  const transport = new Switch();
  transport.deferOriginate = true;
  const adapter = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  await adapter.execute(command);
  await assert.rejects(
    adapter.execute({ ...command, type: 'offer.cancel' }),
    ManagedVoiceReconciliationRequiredError,
  );
  const originate = transport.commands.find((value) => value.startsWith('bgapi originate'))!;
  transport.deferOriginate = false;
  await transport.request(originate);
  assert.deepEqual(await adapter.execute({ ...command, type: 'offer.cancel' }), {
    confirmed: true,
  });
  assert.equal(transport.channels.has(command.callUuid), true);
  assert.equal(transport.channels.has(command.blegUuid), false);
});

test('readiness รับ actual FreeSWITCH UP และปฏิเสธ error response', async () => {
  assert.equal(
    await new FreeSwitchManagedVoiceAdapter(
      { request: async () => 'UP 0 years, 0 days\n1 session(s) since startup' },
      'fs-test',
      'test.local',
    ).ready(),
    true,
  );
  assert.equal(
    await new FreeSwitchManagedVoiceAdapter(
      { request: async () => '-ERR unavailable' },
      'fs-test',
      'test.local',
    ).ready(),
    false,
  );
});

test('BACKGROUND_JOB ที่มาถึงก่อน Job-UUID mapping ยังใช้ reconcile absence ได้', async () => {
  const transport = new Switch();
  transport.deferOriginate = true;
  const esl: ManagedVoiceEslTransport = {
    request: async (value) => {
      const response = await transport.request(value);
      if (value.startsWith('bgapi originate'))
        await adapter.backgroundJob('a0000000-0000-4000-8000-000000000008');
      return response;
    },
  };
  const adapter = new FreeSwitchManagedVoiceAdapter(esl, 'fs-test', 'test.local');
  assert.deepEqual(await adapter.execute(command), { confirmed: false });
  assert.deepEqual(await adapter.execute({ ...command, type: 'offer.cancel' }), {
    confirmed: true,
  });
});

test('restart หลัง completion หายระหว่าง listener down: deadline ผ่านแล้วยังคง UNKNOWN/ACTION_REQUIRED', async () => {
  const transport = new Switch();
  const adapter = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  await adapter.execute(command);
  transport.channels.delete(command.blegUuid);
  const restarted = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  await assert.rejects(
    restarted.execute({ ...command, type: 'offer.cancel', expiresAt: '2000-01-01T00:00:00.000Z' }),
    (error: unknown) =>
      error instanceof ManagedVoiceReconciliationRequiredError &&
      error.code === 'MANAGED_VOICE_ORIGINATE_OUTCOME_UNKNOWN' &&
      error.actionRequired,
  );
  assert.deepEqual(await restarted.execute(command), { confirmed: false });
  assert.equal(transport.commands.filter((value) => value.startsWith('bgapi originate')).length, 1);
  assert.equal(transport.channels.has(command.callUuid), true);
});

test('ACTIVE readback หลัง listener restart ตรวจ absence จริงโดยไม่ teardown แม้ offer deadline ผ่านแล้ว', async () => {
  const transport = new Switch();
  await new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local').execute(command);
  const restarted = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  const active = {
    ...command,
    type: 'call.bridge' as const,
    expiresAt: '2000-01-01T00:00:00.000Z',
  };
  transport.commands.length = 0;
  assert.deepEqual(await restarted.readback(active), { callerExists: true, blegExists: true });
  transport.channels.delete(command.callUuid);
  assert.deepEqual(await restarted.readback(active), { callerExists: false, blegExists: true });
  transport.channels.delete(command.blegUuid);
  assert.deepEqual(await restarted.readback(active), { callerExists: false, blegExists: false });
  assert.equal(
    transport.commands.every((value) => /^api uuid_(exists|getvar) /.test(value)),
    true,
  );
});

test('ACTIVE readback ปฏิเสธ unknown probe และ foreign scope แทนการรายงาน absence', async () => {
  const unavailable = new FreeSwitchManagedVoiceAdapter(
    { request: async () => '-ERR unavailable' },
    'fs-test',
    'test.local',
  );
  await assert.rejects(unavailable.readback(command), /PROBE_UNCONFIRMED/);
  const transport = new Switch();
  const adapter = new FreeSwitchManagedVoiceAdapter(transport, 'fs-test', 'test.local');
  await assert.rejects(
    adapter.readback({ ...command, telephonyNodeId: 'wrong-node' }),
    /INVALID_COMMAND/,
  );
  transport.channels.get(command.callUuid)!.dcontact_tenant_id = 'foreign';
  await assert.rejects(adapter.readback(command), /SCOPE_MISMATCH/);
  assert.equal(
    transport.commands.some((value) => value.includes('uuid_kill')),
    false,
  );
});
