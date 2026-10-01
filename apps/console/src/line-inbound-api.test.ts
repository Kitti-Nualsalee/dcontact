import assert from 'node:assert/strict';
import test from 'node:test';
import { createLineInboundApi, LineInboundApiError } from './line-inbound/api.js';

function fakeFetch(respond: (url: string) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input));
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('#566 availability: 404 = ไม่มี overlay, 403 = ไม่มีสิทธิ์, 204 = ใช้ได้; ใช้ /access ที่ไม่อ่านข้อความ', async () => {
  const cases: Array<[number, string]> = [
    [404, 'UNAVAILABLE'],
    [403, 'FORBIDDEN'],
    [204, 'AVAILABLE'],
  ];
  for (const [status, expected] of cases) {
    const fake = fakeFetch(() =>
      status === 204 ? new Response(null, { status }) : json(status, {}),
    );
    const api = createLineInboundApi({
      baseUrl: 'https://uat.example/',
      accessToken: () => 'token-1',
      fetch: fake.fetch,
    });
    assert.equal(await api.availability(), expected);
    assert.equal(fake.calls[0]?.url, 'https://uat.example/api/v1/line-pilot/access');
    assert.deepEqual(fake.calls[0]?.init.headers, { authorization: 'Bearer token-1' });
  }
  const broken = fakeFetch(() => json(500, {}));
  await assert.rejects(
    createLineInboundApi({
      baseUrl: '',
      accessToken: () => 't',
      fetch: broken.fetch,
    }).availability(),
    LineInboundApiError,
  );
});

test('#566 list: ส่ง cursor ต่อหน้า และ error คง status ไว้ให้หน้าแสดงผลถูก', async () => {
  const page = { items: [], quarantined: 2, nextCursor: 'next' };
  const fake = fakeFetch(() => json(200, page));
  const api = createLineInboundApi({ baseUrl: '', accessToken: () => 't', fetch: fake.fetch });
  assert.deepEqual(await api.list({ limit: 20, before: 'abc' }), page);
  assert.equal(fake.calls[0]?.url, '/api/v1/line-pilot/inbound?limit=20&before=abc');

  const forbidden = fakeFetch(() => json(403, {}));
  await assert.rejects(
    createLineInboundApi({ baseUrl: '', accessToken: () => 't', fetch: forbidden.fetch }).list(),
    (error: unknown) => error instanceof LineInboundApiError && error.status === 403,
  );
});

test('#567 trialStatus: 404 = ไม่ได้เปิด trial (null), 200 = สถานะ', async () => {
  const off = fakeFetch(() => json(404, {}));
  assert.equal(
    await createLineInboundApi({
      baseUrl: '',
      accessToken: () => 't',
      fetch: off.fetch,
    }).trialStatus(),
    null,
  );
  assert.equal(off.calls[0]?.url, '/api/v1/line-pilot/trial');
  const status = {
    active: true,
    killed: false,
    expiresAt: null,
    recipients: 5,
    last24h: 2,
    per24h: 100,
    perRecipientPer24h: 20,
  };
  const on = fakeFetch(() => json(200, status));
  assert.deepEqual(
    await createLineInboundApi({
      baseUrl: '',
      accessToken: () => 't',
      fetch: on.fetch,
    }).trialStatus(),
    status,
  );
});

test('#567 reply: ส่ง text + idempotencyKey แบบ POST และแปลง code ทั้งรูปตรงและรูปที่ Nest ห่อ', async () => {
  const sent = fakeFetch(() => json(200, { status: 'SENT', deliveryId: 'dlv_1' }));
  const api = createLineInboundApi({ baseUrl: '', accessToken: () => 't', fetch: sent.fetch });
  assert.deepEqual(await api.reply('id-1', 'hi', 'reply-key-1'), {
    status: 'SENT',
    deliveryId: 'dlv_1',
  });
  assert.equal(sent.calls[0]?.url, '/api/v1/line-pilot/inbound/id-1/reply');
  assert.equal(sent.calls[0]?.init.method, 'POST');
  assert.deepEqual(JSON.parse(String(sent.calls[0]?.init.body)), {
    text: 'hi',
    idempotencyKey: 'reply-key-1',
  });
  for (const body of [
    { status: 'FAILED', code: 'CAP_EXCEEDED' },
    { message: { code: 'CAP_EXCEEDED' } },
  ]) {
    const failed = fakeFetch(() => json(429, body));
    assert.deepEqual(
      await createLineInboundApi({
        baseUrl: '',
        accessToken: () => 't',
        fetch: failed.fetch,
      }).reply('id-1', 'hi', 'reply-key-2'),
      { status: 'FAILED', code: 'CAP_EXCEEDED' },
    );
  }
  const expired = fakeFetch(() => json(401, {}));
  await assert.rejects(
    createLineInboundApi({ baseUrl: '', accessToken: () => 't', fetch: expired.fetch }).reply(
      'id-1',
      'hi',
      'k-12345678',
    ),
    LineInboundApiError,
  );
});

test('#567 kill: POST และ error คง status', async () => {
  const ok = fakeFetch(() => json(200, { killed: true }));
  await createLineInboundApi({ baseUrl: '', accessToken: () => 't', fetch: ok.fetch }).kill();
  assert.equal(ok.calls[0]?.url, '/api/v1/line-pilot/kill');
  const forbidden = fakeFetch(() => json(403, {}));
  await assert.rejects(
    createLineInboundApi({ baseUrl: '', accessToken: () => 't', fetch: forbidden.fetch }).kill(),
    (error: unknown) => error instanceof LineInboundApiError && error.status === 403,
  );
});
