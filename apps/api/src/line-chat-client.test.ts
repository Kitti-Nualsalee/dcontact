import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import { parseLineChannelInput } from './line-chat-channel.js';
import { LineChatClient, verifyLineSignature } from './line-chat-client.js';
import { resolveLineApiBaseUrl, resolveLineChat } from './line-chat-config.js';
import { WebchatError } from './webchat-errors.js';

const secret = '0123456789abcdef0123456789abcdef';

test('a LINE signature is checked over the exact bytes received', () => {
  const body = Buffer.from('{"destination":"U1","events":[]}');
  const signature = createHmac('sha256', secret).update(body).digest('base64');
  assert.equal(verifyLineSignature(body, signature, secret), true);
  // re-serialized JSON is other bytes
  assert.equal(
    verifyLineSignature(Buffer.from('{"destination": "U1","events":[]}'), signature, secret),
    false,
  );
  assert.equal(verifyLineSignature(body, signature, 'f'.repeat(32)), false);
  assert.equal(verifyLineSignature(body, undefined, secret), false);
  assert.equal(verifyLineSignature(body, '', secret), false);
  assert.equal(verifyLineSignature(body, 'x'.repeat(500), secret), false);
});

function fakeFetch(status: number, body = '{}', headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(status === 204 ? null : body, { status, headers });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

test('a push carries the retry key and its answer says whether to try again', async () => {
  const ok = fakeFetch(200, '{"sentMessages":[]}');
  const client = new LineChatClient('http://line.test', ok.fetcher);
  assert.equal((await client.push('token', 'U1', 'hi', 'key-1')).kind, 'OK');
  const headers = ok.calls[0]!.init.headers as Record<string, string>;
  assert.equal(headers['x-line-retry-key'], 'key-1');
  assert.equal(headers.authorization, 'Bearer token');
  assert.equal(ok.calls[0]!.url, 'http://line.test/v2/bot/message/push');
  assert.deepEqual(JSON.parse(ok.calls[0]!.init.body as string), {
    to: 'U1',
    messages: [{ type: 'text', text: 'hi' }],
  });

  const accepted = fakeFetch(409, '{}', { 'x-line-accepted-request-id': 'abc' });
  assert.equal(
    (await new LineChatClient('http://line.test', accepted.fetcher).push('t', 'U1', 'hi', 'k'))
      .kind,
    'ALREADY_ACCEPTED',
  );
  const limited = fakeFetch(429, '{}', { 'retry-after': '12' });
  assert.deepEqual(
    await new LineChatClient('http://line.test', limited.fetcher).push('t', 'U1', 'hi', 'k'),
    { kind: 'RETRY', status: 429, retryAfterSec: 12 },
  );
  const refused = fakeFetch(400);
  assert.deepEqual(
    await new LineChatClient('http://line.test', refused.fetcher).push('t', 'U1', 'hi', 'k'),
    { kind: 'REJECTED', status: 400 },
  );
  const down = (async () => {
    throw new TypeError('fetch failed');
  }) as unknown as typeof fetch;
  assert.equal(
    (await new LineChatClient('http://line.test', down).push('t', 'U1', 'hi', 'k')).kind,
    'RETRY',
  );
});

test('the bot of a token, or null when LINE does not accept it', async () => {
  const ok = fakeFetch(200, '{"userId":"Uabc","displayName":"Shop"}');
  assert.deepEqual(await new LineChatClient('http://line.test', ok.fetcher).botInfo('t'), {
    userId: 'Uabc',
    displayName: 'Shop',
  });
  const refused = fakeFetch(401);
  assert.equal(await new LineChatClient('http://line.test', refused.fetcher).botInfo('t'), null);
  const down = fakeFetch(503);
  assert.equal(
    await new LineChatClient('http://line.test', down.fetcher).botInfo('t'),
    'UNAVAILABLE',
  );
});

const field = (name: string) => (error: unknown) =>
  error instanceof WebchatError && error.detail.field === name;
const base = { expectedRevision: 0, enabled: false, queueId: null, idleTimeoutSec: 1800 };

test('the LINE channel settings are checked before anything is stored', () => {
  const parsed = parseLineChannelInput({
    ...base,
    channelSecret: ` ${secret} `,
    accessToken: 'abcdefghijklmnopqrstuvwxyz0123456789+/=',
    autoReplyText: '  thanks  ',
  });
  assert.equal(parsed.channelSecret, secret);
  assert.equal(parsed.settings.autoReplyText, 'thanks');
  // leaving the secrets out keeps the stored ones
  assert.equal(parseLineChannelInput(base).channelSecret, undefined);
  assert.throws(
    () => parseLineChannelInput({ ...base, channelSecret: 'short' }),
    field('channelSecret'),
  );
  assert.throws(
    () => parseLineChannelInput({ ...base, accessToken: 'has space in it 12345678' }),
    field('accessToken'),
  );
  assert.throws(() => parseLineChannelInput({ ...base, enabled: true }), field('queueId'));
  assert.throws(
    () => parseLineChannelInput({ ...base, idleTimeoutSec: 90 }),
    field('idleTimeoutSec'),
  );
  assert.throws(
    () => parseLineChannelInput({ ...base, lineChannelId: 'abc' }),
    field('lineChannelId'),
  );
  assert.throws(() => parseLineChannelInput({ ...base, extra: 1 }), field('extra'));
  assert.throws(
    () => parseLineChannelInput({ ...base, autoReplyText: 'x'.repeat(501) }),
    field('autoReplyText'),
  );
});

test('LINE chat is off unless the deployment turns it on; the API base can be a local simulator', () => {
  assert.equal(resolveLineChat({}), false);
  assert.equal(resolveLineChat({ LINE_CHAT: 'on' }), true);
  assert.throws(() => resolveLineChat({ LINE_CHAT: 'yes' }));
  assert.equal(resolveLineApiBaseUrl({}), 'https://api.line.me');
  assert.equal(
    resolveLineApiBaseUrl({ LINE_API_BASE_URL: 'http://127.0.0.1:8890/' }),
    'http://127.0.0.1:8890',
  );
  assert.throws(() =>
    resolveLineApiBaseUrl({ LINE_API_BASE_URL: 'http://line.example', NODE_ENV: 'production' }),
  );
});
