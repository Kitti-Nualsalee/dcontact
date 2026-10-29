import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { E1EslCommandClient } from './e1-esl-command-client.js';
import { FreeSwitchManagedVoiceAdapter } from './managed-voice-adapter.js';
import type { ManagedVoiceDirectCommand } from '@d-contact/router';

test('direct adapter กับ authenticated ESL TCP: probe error ไม่ใช่ absence และ retry ยืนยัน actual teardown', async (context) => {
  const command: ManagedVoiceDirectCommand = {
    commandId: 'b0000000-0000-4000-8000-000000000001',
    tenantId: 'b0000000-0000-4000-8000-000000000002',
    interactionId: 'b0000000-0000-4000-8000-000000000003',
    callUuid: 'b0000000-0000-4000-8000-000000000004',
    offerId: 'b0000000-0000-4000-8000-000000000005',
    blegUuid: 'b0000000-0000-4000-8000-000000000006',
    telephonyNodeId: 'fs-integration',
    type: 'call.hangup',
  };
  const channels = new Set([command.callUuid, command.blegUuid]);
  let brokenProbe = true;
  let retainBleg = true;
  const killed: string[] = [];
  const server = net.createServer((socket) => {
    socket.write('Content-Type: auth/request\n\n');
    let authenticated = false;
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (!buffer.endsWith('\n\n')) return;
      const request = buffer.trim();
      buffer = '';
      if (!authenticated) {
        assert.equal(request, 'auth fixture-only');
        authenticated = true;
        socket.write('Content-Type: command/reply\nReply-Text: +OK accepted\n\n');
        return;
      }
      const [, action, channel, name] = request.split(' ');
      let response = '-ERR unexpected request';
      if (action === 'uuid_exists')
        response = brokenProbe ? '-ERR lookup unavailable' : String(channels.has(channel));
      if (action === 'uuid_getvar') {
        const variables: Record<string, string> = {
          dcontact_tenant_id: command.tenantId,
          dcontact_node_id: command.telephonyNodeId,
          dcontact_call_uuid: command.callUuid,
          dcontact_offer_id: command.offerId!,
          dcontact_bleg_uuid: command.blegUuid,
        };
        response = variables[name] ?? '_undef_';
      }
      if (action === 'uuid_kill') {
        killed.push(channel);
        if (channel !== command.blegUuid || !retainBleg) channels.delete(channel);
        response = '+OK';
      }
      if (action === 'global_setvar') response = '+OK';
      if (action === 'global_getvar') response = 'SETTLED';
      socket.write(
        `Content-Type: api/response\nContent-Length: ${Buffer.byteLength(response)}\n\n${response}`,
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const transport = new E1EslCommandClient({
    host: '127.0.0.1',
    port: address.port,
    password: 'fixture-only',
  });
  const adapter = new FreeSwitchManagedVoiceAdapter(
    transport,
    command.telephonyNodeId,
    'fixture.test',
  );
  await assert.rejects(adapter.execute(command), /PROBE_UNCONFIRMED/);
  assert.equal(killed.length, 0);
  brokenProbe = false;
  assert.deepEqual(await adapter.execute(command), { confirmed: false });
  retainBleg = false;
  const restarted = new FreeSwitchManagedVoiceAdapter(
    transport,
    command.telephonyNodeId,
    'fixture.test',
  );
  assert.deepEqual(await restarted.execute(command), { confirmed: true });
  assert.deepEqual(await restarted.readback(command), { callerExists: false, blegExists: false });
});
