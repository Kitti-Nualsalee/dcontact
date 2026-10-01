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

test('#566 availability: 404 = ไม่มี overlay, 403 = ไม่มีสิทธิ์, 200 = ใช้ได้; ส่ง bearer และ limit=1', async () => {
  const cases: Array<[number, string]> = [
    [404, 'UNAVAILABLE'],
    [403, 'FORBIDDEN'],
    [200, 'AVAILABLE'],
  ];
  for (const [status, expected] of cases) {
    const fake = fakeFetch(() => json(status, { items: [], quarantined: 0, nextCursor: null }));
    const api = createLineInboundApi({
      baseUrl: 'https://uat.example/',
      accessToken: () => 'token-1',
      fetch: fake.fetch,
    });
    assert.equal(await api.availability(), expected);
    assert.equal(fake.calls[0]?.url, 'https://uat.example/api/v1/line-pilot/inbound?limit=1');
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
