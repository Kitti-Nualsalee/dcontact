import assert from 'node:assert/strict';
import test from 'node:test';
import { WebchatApiError, createWebchatApi, isWebchatSettings } from './webchat/api.js';
import type { WebchatSettings, WebchatWidget } from './webchat/api.js';
import {
  checkOrigin,
  draftFrom,
  embedSnippet,
  enableRequirements,
  isDirty,
  previewUrl,
  resolveApiBase,
  saveInput,
  serverFieldError,
  validateDraft,
} from './webchat/model.js';

const widget = (change: Partial<WebchatWidget> = {}): WebchatWidget => ({
  id: 'wc_7Hq2Lx9P',
  revision: 3,
  enabled: true,
  queueId: 'q1',
  allowedOrigins: ['https://shop.example.com'],
  greetingTh: 'สวัสดี', // allow-thai: Thai greeting is the data under test
  greetingEn: 'Hello',
  maxChatsPerAgent: 4,
  idleTimeoutSec: 900,
  ...change,
});
const settings = (change: Partial<WebchatWidget> = {}, canEdit = true): WebchatSettings => ({
  tenantId: '7a33ac96-d87d-4ca4-ab75-f27e40e94a01',
  canEdit,
  widget: widget(change),
  queues: [{ id: 'q1', name: 'Online Sales', teamName: null }],
});

test('a widget that was never saved starts from the documented defaults', () => {
  const draft = draftFrom(
    widget({ id: null, revision: 0, enabled: false, queueId: null, allowedOrigins: [] }),
  );
  assert.equal(draft.capacity, '3');
  assert.equal(draft.idleMinutes, '10');
  assert.equal(draft.enabled, false);
});

test('a saved widget shows its own capacity and idle time in minutes', () => {
  const draft = draftFrom(widget());
  assert.equal(draft.capacity, '4');
  assert.equal(draft.idleMinutes, '15');
  assert.equal(isDirty(draft, draftFrom(widget())), false);
  assert.equal(isDirty({ ...draft, origins: [] }, draftFrom(widget())), true);
});

test('validation points at the field and uses the same limits as the server', () => {
  const base = draftFrom(widget());
  assert.deepEqual(validateDraft(base), {});
  assert.equal(validateDraft({ ...base, capacity: '12' }).capacity, 'errors.capacityRange');
  assert.equal(validateDraft({ ...base, capacity: '' }).capacity, 'errors.capacityRange');
  assert.equal(validateDraft({ ...base, capacity: '2.5' }).capacity, 'errors.capacityRange');
  assert.equal(validateDraft({ ...base, idleMinutes: '61' }).idle, 'errors.idleRange');
  assert.equal(validateDraft({ ...base, idleMinutes: '0' }).idle, 'errors.idleRange');
  assert.equal(
    validateDraft({ ...base, greetingEn: 'x'.repeat(501) }).greetingEn,
    'errors.welcomeTooLong',
  );
  assert.deepEqual(validateDraft({ ...base, greetingEn: 'x'.repeat(500) }), {});
});

test('turning on needs a queue and a domain, turning off does not', () => {
  const empty = { ...draftFrom(widget()), queueId: null, origins: [] };
  assert.deepEqual(validateDraft({ ...empty, enabled: true }), {
    queue: 'errors.queueRequired',
    origins: 'errors.originRequired',
  });
  assert.deepEqual(validateDraft({ ...empty, enabled: false }), {});
  assert.deepEqual(enableRequirements(empty), { queue: false, origin: false });
});

test('the body sends minutes as seconds and the revision the page was opened at', () => {
  const body = saveInput({ ...draftFrom(widget()), capacity: ' 5 ', idleMinutes: '10' }, 3);
  assert.deepEqual(body, {
    expectedRevision: 3,
    enabled: true,
    queueId: 'q1',
    allowedOrigins: ['https://shop.example.com'],
    greetingTh: 'สวัสดี', // allow-thai: Thai greeting is the data under test
    greetingEn: 'Hello',
    maxChatsPerAgent: 5,
    idleTimeoutSec: 600,
  });
});

test('origins are normalized, and an origin with a path, a duplicate or an eleventh is refused', () => {
  assert.equal(checkOrigin('   ', []), null);
  assert.deepEqual(checkOrigin('HTTPS://Shop.Example.com:443/', []), {
    ok: true,
    origin: 'https://shop.example.com',
  });
  assert.deepEqual(checkOrigin('https://shop.example.com/checkout', []), {
    ok: false,
    messageKey: 'origins.invalid',
  });
  assert.deepEqual(checkOrigin('shop.example.com', []), {
    ok: false,
    messageKey: 'origins.invalid',
  });
  assert.deepEqual(checkOrigin('https://shop.example.com', ['https://shop.example.com']), {
    ok: false,
    messageKey: 'origins.duplicate',
  });
  assert.equal(checkOrigin('http://localhost:3000', [])?.ok, true);
  assert.equal(checkOrigin('http://shop.example.com', [])?.ok, false);
  const ten = Array.from({ length: 10 }, (_, index) => `https://s${index}.example.com`);
  assert.deepEqual(checkOrigin('https://new.example.com', ten), {
    ok: false,
    messageKey: 'origins.limit',
  });
});

test('a server rejection lands under the field it names', () => {
  const draft = draftFrom(widget());
  assert.deepEqual(serverFieldError({ field: 'allowedOrigins' }, draft), {
    field: 'origins',
    messageKey: 'origins.invalid',
  });
  assert.deepEqual(serverFieldError({ field: 'maxChatsPerAgent' }, draft), {
    field: 'capacity',
    messageKey: 'errors.capacityRange',
  });
  assert.deepEqual(serverFieldError({ field: 'queueId' }, { ...draft, queueId: null }), {
    field: 'queue',
    messageKey: 'errors.queueRequired',
  });
  assert.equal(serverFieldError({ field: 'somethingElse' }, draft), undefined);
  assert.equal(serverFieldError({}, draft), undefined);
});

test('the embed code uses the API base visitors reach, and a relative base uses this page', () => {
  assert.equal(
    resolveApiBase('https://api.dcontact.test/', 'https://console.dcontact.test'),
    'https://api.dcontact.test',
  );
  assert.equal(
    resolveApiBase('', 'https://console.dcontact.test'),
    'https://console.dcontact.test',
  );
  assert.equal(
    resolveApiBase('/gateway', 'https://console.dcontact.test'),
    'https://console.dcontact.test/gateway',
  );
  assert.equal(
    embedSnippet({
      apiBase: 'https://api.dcontact.test',
      tenantId: 't-1',
      widgetId: 'wc_7Hq2Lx9P',
    }),
    '<script src="https://api.dcontact.test/api/v1/webchat/widget.js" data-tenant="t-1" data-widget="wc_7Hq2Lx9P" async></script>',
  );
  assert.equal(
    previewUrl({ apiBase: 'https://api.dcontact.test', tenantId: 't-1', widgetId: 'w 1' }),
    'https://api.dcontact.test/api/v1/webchat/demo?tenant=t-1&widget=w+1',
  );
});

test('the client sends the token, parses the settings and reports the error code and field', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const respond = (status: number, body: unknown) =>
    (async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
  const ok = createWebchatApi({
    baseUrl: 'https://api.test/',
    accessToken: () => 'tok',
    fetch: respond(200, settings()),
  });
  assert.equal((await ok.get()).widget.id, 'wc_7Hq2Lx9P');
  assert.equal(calls[0]!.url, 'https://api.test/api/v1/webchat/widget');
  assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, 'Bearer tok');
  await ok.save(saveInput(draftFrom(widget()), 3));
  assert.equal(calls[1]!.init.method, 'PUT');
  assert.equal(JSON.parse(String(calls[1]!.init.body)).expectedRevision, 3);

  const conflict = createWebchatApi({
    baseUrl: '',
    accessToken: () => 'tok',
    fetch: respond(409, { code: 'REVISION_CONFLICT' }),
  });
  await assert.rejects(conflict.save(saveInput(draftFrom(widget()), 3)), (error: unknown) => {
    assert.ok(error instanceof WebchatApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, 'REVISION_CONFLICT');
    return true;
  });
  const invalid = createWebchatApi({
    baseUrl: '',
    accessToken: () => 'tok',
    fetch: respond(400, { code: 'VALIDATION_FAILED', field: 'allowedOrigins' }),
  });
  await assert.rejects(
    invalid.save(saveInput(draftFrom(widget()), 3)),
    (error: unknown) => error instanceof WebchatApiError && error.field === 'allowedOrigins',
  );
  const noToken = createWebchatApi({ baseUrl: '', accessToken: () => undefined });
  await assert.rejects(
    noToken.get(),
    (error: unknown) => (error as WebchatApiError).status === 401,
  );
});

test('a response without the documented shape is a server fault', async () => {
  assert.equal(isWebchatSettings(settings()), true);
  assert.equal(isWebchatSettings({ ...settings(), queues: undefined }), false);
  assert.equal(isWebchatSettings(null), false);
  const broken = createWebchatApi({
    baseUrl: '',
    accessToken: () => 'tok',
    fetch: (async () =>
      new Response(JSON.stringify({ tenantId: 1 }), { status: 200 })) as typeof fetch,
  });
  await assert.rejects(broken.get(), (error: unknown) => (error as WebchatApiError).status === 502);
});
