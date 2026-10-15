import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { E1VoiceCommandPublisher } from './e1-voice-command-publisher.js';

const secret = 'a'.repeat(64);
const input = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  command: {
    type: 'call.originate' as const,
    vendor: 'freeswitch' as const,
    telephonyNodeId: 'e1-uat-sandbox',
    deliveryId: 'delivery-1',
    providerRequestKey: 'request-1',
    originationUuid: '00000000-0000-4000-8000-000000000002',
    agentExtension: '1101',
    targetIdentityId: '00000000-0000-4000-8000-000000000003',
  },
};

test('E1 publisher ส่ง command opaque ด้วย secret แยกและไม่ตาม redirect', async (context) => {
  let requests = 0;
  const server = createServer(async (request, response) => {
    requests += 1;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/commands');
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    let body = '';
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), input);
    response.writeHead(307, { location: '/unexpected' }).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  const publisher = new E1VoiceCommandPublisher(secret, async (_url, options) =>
    fetch(`http://127.0.0.1:${port}/commands`, options),
  );
  await assert.rejects(publisher.publish(input), /E1_VOICE_COMMAND_UNCONFIRMED/);
  assert.equal(requests, 1);
});

test('E1 publisher ส่ง flush แบบ opaque ผ่าน endpoint แยกโดยไม่ retry', async () => {
  const registration = {
    tenantId: input.tenantId,
    telephonyNodeId: 'e1-uat-sandbox',
    extension: '1101',
    sipDomain: 'dcontact-uat.sip.internal',
    workSessionLeaseId: input.command.originationUuid,
  };
  let attempts = 0;
  const publisher = new E1VoiceCommandPublisher(secret, async (url, options) => {
    attempts += 1;
    assert.equal(url, 'http://e1-sandbox:3001/registrations/flush');
    assert.equal(options?.redirect, 'error');
    const { tenantId, ...command } = registration;
    assert.deepEqual(JSON.parse(String(options?.body)), {
      tenantId,
      command: { ...command, type: 'sip.registration.flush', vendor: 'freeswitch' },
    });
    return new Response(null, { status: 409 });
  });
  await assert.rejects(publisher.flush(registration), /UNCONFIRMED/);
  assert.equal(attempts, 1);
});

test('E1 publisher ยืนยันเฉพาะ 202 และไม่ retry เมื่อ timeout/ผลไม่แน่นอน', async () => {
  let attempts = 0;
  const publisher = new E1VoiceCommandPublisher(secret, async (url, options) => {
    attempts += 1;
    assert.equal(url, 'http://e1-sandbox:3001/commands');
    assert.equal(options?.redirect, 'error');
    assert.ok(options?.signal);
    throw new Error('timeout');
  });
  await assert.rejects(publisher.publish(input), /E1_VOICE_COMMAND_UNCONFIRMED/);
  assert.equal(attempts, 1);
  await new E1VoiceCommandPublisher(
    secret,
    async () => new Response(null, { status: 202 }),
  ).publish(input);
  assert.throws(() => new E1VoiceCommandPublisher(''), /E1_VOICE_COMMAND_SECRET_REQUIRED/);
});
