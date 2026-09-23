import assert from 'node:assert/strict';
import test from 'node:test';
import { HttpLineProviderTransport } from './line-provider-transport.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('S2-LINE-PR01 verifyToken คืน client_id และอายุที่เหลือ', async () => {
  const { fetchImpl } = fakeFetch(() => json({ client_id: '2007056595', expires_in: 3600 }));
  const transport = new HttpLineProviderTransport('https://line.test', 1_000, fetchImpl);
  assert.deepEqual(await transport.verifyToken('t'), {
    valid: true,
    clientId: '2007056595',
    expiresInSeconds: 3600,
  });
});

test('S2-LINE-PR01 webhook endpoint/test อ่านเฉพาะ field ที่รู้จัก และ HTTP error = ไม่ผ่าน', async () => {
  const ok = fakeFetch((call) =>
    call.url.endsWith('/test')
      ? json({ success: true, statusCode: 200, reason: 'OK', detail: 'ignored' })
      : json({ endpoint: 'https://pilot.example.test/webhook/line', active: true }),
  );
  const transport = new HttpLineProviderTransport('https://line.test', 1_000, ok.fetchImpl);
  assert.deepEqual(await transport.getWebhookEndpoint('t'), {
    endpoint: 'https://pilot.example.test/webhook/line',
    active: true,
  });
  assert.deepEqual(await transport.testWebhookEndpoint('t'), {
    success: true,
    statusCode: 200,
    reason: 'OK',
  });
  const failing = fakeFetch(() => json({}, 403));
  assert.deepEqual(
    await new HttpLineProviderTransport(
      'https://line.test',
      1_000,
      failing.fetchImpl,
    ).testWebhookEndpoint('t'),
    { success: false, statusCode: null, reason: 'HTTP_403' },
  );
});

test('S2-LINE-RB01 revokeToken: v2.1 ใช้ client credentials, long-lived ใช้ token เดียว, network error = ไม่ revoke', async () => {
  const { calls, fetchImpl } = fakeFetch(() => new Response(null, { status: 200 }));
  const transport = new HttpLineProviderTransport('https://line.test', 1_000, fetchImpl);
  assert.deepEqual(
    await transport.revokeToken({
      credentialKind: 'CHANNEL_ACCESS_TOKEN_V2_1',
      accessToken: 'tok',
      channelId: '2007056595',
      channelSecret: 'sec',
    }),
    { revoked: true, httpStatus: 200 },
  );
  assert.equal(calls[0]!.url, 'https://line.test/oauth2/v2.1/revoke');
  assert.equal(
    String(calls[0]!.init.body),
    'client_id=2007056595&client_secret=sec&access_token=tok',
  );
  await transport.revokeToken({
    credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
    accessToken: 'tok',
  });
  assert.equal(calls[1]!.url, 'https://line.test/v2/oauth/revoke');
  assert.equal(String(calls[1]!.init.body), 'access_token=tok');

  const broken = new HttpLineProviderTransport('https://line.test', 1_000, (async () => {
    throw new Error('socket hang up tok');
  }) as typeof globalThis.fetch);
  assert.deepEqual(
    await broken.revokeToken({
      credentialKind: 'CHANNEL_ACCESS_TOKEN_LONG_LIVED',
      accessToken: 'tok',
    }),
    { revoked: false, httpStatus: null },
  );
});
