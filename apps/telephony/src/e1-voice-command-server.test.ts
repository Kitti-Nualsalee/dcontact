import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createE1VoiceCommandServer, type E1VoiceCommandInput } from './e1-voice-command-server.js';

const secret = 'a'.repeat(64);
const input: E1VoiceCommandInput = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  command: {
    type: 'call.originate',
    vendor: 'freeswitch',
    telephonyNodeId: 'e1-uat-sandbox',
    deliveryId: 'delivery-1',
    providerRequestKey: 'request-1',
    agentExtension: '1101',
    originationUuid: '00000000-0000-4000-8000-000000000002',
    targetIdentityId: '00000000-0000-4000-8000-000000000003',
  },
};

test('internal gateway ตรวจ auth/schema/tenant/node ก่อน durable claim และไม่เปิด ESL ทั่วไป', async (context) => {
  let claims = 0;
  let commands = 0;
  let allow = false;
  const server = createE1VoiceCommandServer({
    secret,
    tenantId: input.tenantId,
    nodeId: 'e1-uat-sandbox',
    authority: {
      claim: async (received) => {
        assert.deepEqual(received, input);
        claims += 1;
        return allow;
      },
    },
    adapter: {
      handle: async () => {
        commands += 1;
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/commands`;
  const send = (value: unknown, token = secret) =>
    fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  assert.equal((await send(input, 'b'.repeat(64))).status, 401);
  for (const invalid of [
    { ...input, tenantId: '00000000-0000-4000-8000-000000000004' },
    { ...input, command: { ...input.command, telephonyNodeId: 'other-node' } },
    { ...input, command: { ...input.command, type: 'call.bridge' } },
    { ...input, command: { ...input.command, agentExtension: '1101\napi shutdown' } },
    { ...input, command: { ...input.command, phoneNumber: '0812345678' } },
    { ...input, command: { ...input.command, originationUuid: 'invalid' } },
  ])
    assert.equal((await send(invalid)).status, 400);
  assert.equal((await send('a'.repeat(5000))).status, 413);
  assert.equal(claims, 0);
  assert.equal(commands, 0);
  assert.equal((await send(input)).status, 409);
  assert.equal(commands, 0);
  allow = true;
  assert.equal((await send(input)).status, 202);
  assert.equal(claims, 2);
  assert.equal(commands, 1);
});

test('gateway ไม่ตอบ success เมื่อ ESL ล้มและไม่ส่งซ้ำหลัง durable claim', async (context) => {
  let claimed = false;
  let commands = 0;
  const server = createE1VoiceCommandServer({
    secret,
    tenantId: input.tenantId,
    nodeId: 'e1-uat-sandbox',
    authority: {
      claim: async () => {
        if (claimed) return false;
        claimed = true;
        return true;
      },
    },
    adapter: {
      handle: async () => {
        commands += 1;
        throw new Error('ESL timeout');
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const send = () =>
    fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/commands`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
  assert.equal((await send()).status, 503);
  assert.equal((await send()).status, 409);
  assert.equal(commands, 1);
});

test('registration endpoint รับเฉพาะ tenant/node/domain/lease ที่กำหนด และไม่ผ่าน originate authority', async (context) => {
  let flushes = 0;
  const server = createE1VoiceCommandServer({
    secret,
    tenantId: input.tenantId,
    nodeId: 'e1-uat-sandbox',
    authority: {
      claim: async () => {
        throw new Error('must not claim voice delivery');
      },
    },
    adapter: {
      handle: async () => {
        throw new Error('must not originate/cancel');
      },
    },
    registrations: {
      flush: async () => {
        flushes += 1;
        return true;
      },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const registration = {
    tenantId: input.tenantId,
    command: {
      type: 'sip.registration.flush',
      vendor: 'freeswitch',
      telephonyNodeId: 'e1-uat-sandbox',
      sipDomain: 'dcontact-uat.sip.internal',
      extension: '1101',
      workSessionLeaseId: input.command.originationUuid,
    },
  };
  const send = (value: unknown, token = secret) =>
    fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/registrations/flush`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
  assert.equal((await send(registration, 'wrong')).status, 401);
  for (const invalid of [
    input,
    { ...registration, tenantId: 'other-tenant' },
    { ...registration, command: { ...registration.command, telephonyNodeId: 'other-node' } },
    { ...registration, command: { ...registration.command, sipDomain: 'other.internal' } },
    { ...registration, command: { ...registration.command, extension: '1101\napi shutdown' } },
    { ...registration, command: { ...registration.command, workSessionLeaseId: 'invalid' } },
    { ...registration, command: { ...registration.command, phoneNumber: '0812345678' } },
  ])
    assert.equal((await send(invalid)).status, 400);
  assert.equal(flushes, 0);
  assert.equal((await send(registration)).status, 202);
  assert.equal(flushes, 1);
});
