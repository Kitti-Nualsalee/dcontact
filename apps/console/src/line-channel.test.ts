import assert from 'node:assert/strict';
import test from 'node:test';
import { LineApiError, createLineApi, isLineSettings } from './line-channel/api.js';
import type { LineChannel, LineSettings } from './line-channel/api.js';
import {
  draftFrom,
  enableRequirements,
  hintText,
  isDirty,
  saveInput,
  serverFieldError,
  validateDraft,
  webhookUrl,
} from './line-channel/model.js';

const SECRET = '0123456789abcdef0123456789abcdef';
const TOKEN = 'abcdefghijklmnopqrstuvwxyz0123456789+/=._-';

const channel = (change: Partial<LineChannel> = {}): LineChannel => ({
  id: 'ch-1',
  revision: 3,
  enabled: true,
  queueId: 'q1',
  lineChannelId: '1234567890',
  autoReplyText: 'We will be right with you',
  idleTimeoutSec: 1800,
  hasChannelSecret: true,
  hasAccessToken: true,
  channelSecretHint: 'cdef',
  accessTokenHint: '._-x',
  botName: 'Demo Shop',
  credentialsVerifiedAt: '2026-11-27T03:00:00.000Z',
  webhookPath: '/api/v1/line/webhook/t1/ch-1',
  ...change,
});
const never = (): LineChannel =>
  channel({
    id: null,
    revision: 0,
    enabled: false,
    queueId: null,
    lineChannelId: '',
    autoReplyText: '',
    hasChannelSecret: false,
    hasAccessToken: false,
    channelSecretHint: null,
    accessTokenHint: null,
    botName: '',
    credentialsVerifiedAt: null,
    webhookPath: null,
  });
const settings = (change: Partial<LineChannel> = {}, canEdit = true): LineSettings => ({
  tenantId: 't1',
  canEdit,
  channel: channel(change),
  lastSaved: null,
  queues: [{ id: 'q1', name: 'LINE Support', teamName: null }],
});

test('a channel that was never saved starts from the documented defaults', () => {
  const draft = draftFrom(never());
  assert.equal(draft.idleMinutes, '30');
  assert.equal(draft.enabled, false);
  assert.equal(draft.channelSecret, '');
  assert.equal(draft.accessToken, '');
});

test('a saved channel loads without any secret in the form and is not dirty', () => {
  const draft = draftFrom(channel());
  assert.equal(draft.channelSecret, '');
  assert.equal(draft.accessToken, '');
  assert.equal(isDirty(draft, draftFrom(channel())), false);
  assert.equal(isDirty({ ...draft, accessToken: ' ' }, draftFrom(channel())), false);
  assert.equal(isDirty({ ...draft, accessToken: TOKEN }, draftFrom(channel())), true);
  assert.equal(isDirty({ ...draft, idleMinutes: '45' }, draftFrom(channel())), true);
});

test('turning on needs a queue, a secret and a token, stored or typed now', () => {
  const draft = { ...draftFrom(never()), enabled: true };
  assert.deepEqual(validateDraft(draft, never()), {
    queue: 'errors.queueRequired',
    channelSecret: 'errors.secretRequired',
    accessToken: 'errors.tokenRequired',
  });
  assert.deepEqual(
    enableRequirements({ ...draft, queueId: 'q1', channelSecret: SECRET }, never()),
    { queue: true, secret: true, token: false },
  );
  // stored values count, so a later edit does not have to retype them
  assert.deepEqual(validateDraft(draftFrom(channel()), channel()), {});
  // a channel that is off can be saved half done
  assert.deepEqual(validateDraft(draftFrom(never()), never()), {});
});

test('each value is checked with the rules the server applies', () => {
  const draft = {
    ...draftFrom(channel()),
    lineChannelId: '12ab',
    channelSecret: 'xyz',
    accessToken: 'short',
    autoReplyText: 'x'.repeat(501),
    idleMinutes: '0',
  };
  assert.deepEqual(validateDraft(draft, channel()), {
    lineChannelId: 'errors.channelIdInvalid',
    channelSecret: 'errors.secretInvalid',
    accessToken: 'errors.tokenInvalid',
    autoReply: 'errors.autoReplyTooLong',
    idle: 'errors.idleRange',
  });
  assert.equal(
    validateDraft({ ...draftFrom(channel()), idleMinutes: '1441' }, channel()).idle,
    'errors.idleRange',
  );
  assert.equal(
    validateDraft({ ...draftFrom(channel()), idleMinutes: '1440' }, channel()).idle,
    undefined,
  );
  assert.equal(
    validateDraft({ ...draftFrom(channel()), idleMinutes: '1.5' }, channel()).idle,
    'errors.idleRange',
  );
  // 500 characters are fine, counted as characters rather than UTF-16 units
  assert.equal(
    validateDraft({ ...draftFrom(channel()), autoReplyText: '😀'.repeat(500) }, channel())
      .autoReply,
    undefined,
  );
  assert.equal(
    validateDraft({ ...draftFrom(channel()), lineChannelId: '' }, channel()).lineChannelId,
    undefined,
  );
});

test('a save sends a secret or a token only when one was typed', () => {
  const kept = saveInput(draftFrom(channel()), 3);
  assert.equal('channelSecret' in kept, false);
  assert.equal('accessToken' in kept, false);
  assert.deepEqual(kept, {
    expectedRevision: 3,
    enabled: true,
    queueId: 'q1',
    lineChannelId: '1234567890',
    autoReplyText: 'We will be right with you',
    idleTimeoutSec: 1800,
  });
  const replaced = saveInput(
    { ...draftFrom(channel()), channelSecret: ` ${SECRET} `, accessToken: TOKEN, idleMinutes: '5' },
    3,
  );
  assert.equal(replaced.channelSecret, SECRET);
  assert.equal(replaced.accessToken, TOKEN);
  assert.equal(replaced.idleTimeoutSec, 300);
});

test('server rejections land under the field they belong to', () => {
  const draft = draftFrom(channel());
  assert.deepEqual(serverFieldError({ code: 'LINE_TOKEN_REJECTED', field: 'accessToken' }, draft), {
    field: 'accessToken',
    messageKey: 'errors.tokenRejected',
  });
  assert.equal(
    serverFieldError({ code: 'VALIDATION_FAILED', field: 'queueId' }, draft)?.field,
    'queue',
  );
  assert.equal(
    serverFieldError({ code: 'VALIDATION_FAILED', field: 'channelSecret' }, draft)?.field,
    'channelSecret',
  );
  assert.equal(
    serverFieldError({ code: 'VALIDATION_FAILED', field: 'idleTimeoutSec' }, draft)?.field,
    'idle',
  );
  assert.equal(serverFieldError({ code: 'VALIDATION_FAILED', field: 'enabled' }, draft), undefined);
});

test('the webhook URL appears only after the first save and uses the API origin', () => {
  assert.equal(webhookUrl(null, '', 'https://console.example.com'), undefined);
  assert.equal(
    webhookUrl('/api/v1/line/webhook/t1/ch-1', '', 'https://console.example.com'),
    'https://console.example.com/api/v1/line/webhook/t1/ch-1',
  );
  assert.equal(
    webhookUrl(
      '/api/v1/line/webhook/t1/ch-1',
      'https://api.example.com/',
      'https://console.example.com',
    ),
    'https://api.example.com/api/v1/line/webhook/t1/ch-1',
  );
  assert.equal(hintText('cdef'), '…cdef');
});

test('the client reads the documented shape and turns error JSON into a typed error', async () => {
  assert.equal(isLineSettings(settings()), true);
  assert.equal(isLineSettings({ ...settings(), channel: undefined }), false);
  assert.equal(isLineSettings({ ...settings(), queues: 'x' }), false);
  const calls: { method?: string; body?: unknown; auth?: string }[] = [];
  const respond = (status: number, json: unknown) =>
    (async (_url: unknown, init?: RequestInit) => {
      calls.push({
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
        auth: (init?.headers as Record<string, string>).authorization,
      });
      return new Response(JSON.stringify(json), { status });
    }) as typeof fetch;
  const ok = createLineApi({
    baseUrl: 'https://api.example.com/',
    accessToken: () => 't',
    fetch: respond(200, settings()),
  });
  assert.equal((await ok.get()).channel.botName, 'Demo Shop');
  await ok.save({
    expectedRevision: 3,
    enabled: true,
    queueId: 'q1',
    lineChannelId: '',
    autoReplyText: '',
    idleTimeoutSec: 60,
  });
  assert.deepEqual(
    calls.map((call) => [call.method, call.auth]),
    [
      ['GET', 'Bearer t'],
      ['PUT', 'Bearer t'],
    ],
  );
  assert.equal('channelSecret' in (calls[1]!.body as object), false);
  const rejected = createLineApi({
    baseUrl: 'https://api.example.com',
    accessToken: () => 't',
    fetch: respond(422, { code: 'LINE_TOKEN_REJECTED', field: 'accessToken' }),
  });
  await assert.rejects(rejected.get(), (error: unknown) => {
    assert.ok(error instanceof LineApiError);
    assert.deepEqual(
      [error.status, error.code, error.field],
      [422, 'LINE_TOKEN_REJECTED', 'accessToken'],
    );
    return true;
  });
  const bad = createLineApi({
    baseUrl: 'https://api.example.com',
    accessToken: () => 't',
    fetch: respond(200, { nope: 1 }),
  });
  await assert.rejects(bad.get(), (error: unknown) => (error as LineApiError).status === 502);
  const anonymous = createLineApi({
    baseUrl: 'https://api.example.com',
    accessToken: () => undefined,
    fetch: respond(200, settings()),
  });
  await assert.rejects(anonymous.get(), (error: unknown) => (error as LineApiError).status === 401);
});
