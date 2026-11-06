import assert from 'node:assert/strict';
import test from 'node:test';
import { CustomersApiError, createCustomersApi } from './customers/api.js';
import {
  closesCustomerData,
  customersHref,
  errorKind,
  fieldErrorKey,
  parseCustomersRoute,
  validPurpose,
} from './customers/model.js';

const ID = '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

test('errorKind: DENY กับไม่พบเป็น notFound เหมือนกัน และ SCOPE_UNAVAILABLE ไม่ใช่ notFound/empty', () => {
  assert.equal(errorKind(new CustomersApiError(404, 'RESOURCE_NOT_FOUND')), 'notFound');
  assert.equal(errorKind(new CustomersApiError(503, 'SCOPE_UNAVAILABLE', true)), 'scope');
  assert.equal(errorKind(new CustomersApiError(503, 'RESOURCE_BUSY', true)), 'failed');
  assert.equal(errorKind(new CustomersApiError(401, 'SESSION_REQUIRED')), 'session');
  assert.equal(errorKind(new CustomersApiError(403, 'CUSTOMER_ACCESS_DENIED')), 'forbidden');
  assert.equal(errorKind(new CustomersApiError(429, 'RATE_LIMITED', true, 7)), 'rateLimited');
  assert.equal(errorKind(new CustomersApiError(410, 'CURSOR_EXPIRED')), 'cursor');
  assert.equal(errorKind(new CustomersApiError(400, 'CURSOR_INVALID')), 'cursor');
  assert.equal(errorKind(new CustomersApiError(400, 'VALIDATION_FAILED')), 'validation');
  assert.equal(errorKind(new CustomersApiError(0, 'NETWORK_ERROR', true)), 'failed');
  assert.equal(errorKind(new Error('x')), 'failed');
});

test('closesCustomerData: session/สิทธิ์/scope เปลี่ยนต้องปิดข้อมูลลูกค้า; network ชั่วคราวไม่ปิดเอง', () => {
  for (const kind of ['session', 'forbidden', 'notFound', 'scope'] as const)
    assert.equal(closesCustomerData(kind), true, kind);
  for (const kind of ['failed', 'rateLimited', 'cursor', 'validation'] as const)
    assert.equal(closesCustomerData(kind), false, kind);
});

test('fieldErrorKey: ใช้เฉพาะ code ที่รู้จัก ที่เหลือเป็นข้อความทั่วไปโดยไม่สะท้อนค่าที่กรอก', () => {
  const field = (code: string) =>
    new CustomersApiError(400, 'VALIDATION_FAILED', false, undefined, [{ field: 'query', code }]);
  assert.equal(
    fieldErrorKey(field('PHONE_INTERNATIONAL_REQUIRED')),
    'PHONE_INTERNATIONAL_REQUIRED',
  );
  assert.equal(fieldErrorKey(field('<script>')), 'GENERIC');
  assert.equal(fieldErrorKey(new CustomersApiError(400, 'VALIDATION_FAILED')), 'GENERIC');
  assert.equal(fieldErrorKey(new CustomersApiError(404, 'RESOURCE_NOT_FOUND')), undefined);
});

test('route: query ค้นหาไม่อยู่ใน URL; contact ต้องเป็น UUID มิฉะนั้นเหมือนไม่พบ', () => {
  assert.deepEqual(parseCustomersRoute(new URL('https://c.test/?view=customers')), {});
  assert.deepEqual(
    parseCustomersRoute(new URL(`https://c.test/?view=customers&contact=${ID.toUpperCase()}`)),
    { contactId: ID },
  );
  assert.deepEqual(parseCustomersRoute(new URL('https://c.test/?view=customers&contact=x')), {
    contactId: null,
  });
  assert.equal(customersHref('demo'), '/?view=customers&tenant=demo');
  assert.equal(customersHref(undefined, ID), `/?view=customers&contact=${ID}`);
});

test('validPurpose: 1–64 ตัวอักษรและไม่มี control', () => {
  assert.equal(validPurpose('SERVICE'), true);
  assert.equal(validPurpose('  '), false);
  assert.equal(validPurpose('x'.repeat(65)), false);
  assert.equal(validPurpose('a\nb'), false);
});

test('api: ไม่ยิง read/write ถ้าไม่มี token หรือ id ไม่ใช่ UUID และ query อยู่ใน body ไม่ใช่ URL', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({ items: [], nextCursor: null, scope: { state: 'COMPLETE' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  try {
    let token: string | undefined;
    const api = createCustomersApi({ baseUrl: 'https://api.test/', accessToken: () => token });
    await assert.rejects(api.search({ type: 'DIRECTORY' }), { status: 401 });
    await assert.rejects(
      api.create({ commandId: ID, displayName: 'test', company: null, vip: false, points: [] }),
      { status: 401 },
    );
    assert.equal(calls.length, 0);
    token = 'tok';
    await assert.rejects(api.profile('not-a-uuid'), { status: 404 });
    await assert.rejects(
      api.update('not-a-uuid', {
        commandId: ID,
        expectedProfileRevision: '0',
        expectedLineageRevision: '0',
        displayName: 'test',
        company: null,
        vip: false,
      }),
      { status: 404 },
    );
    assert.equal(calls.length, 0);

    await api.search({ type: 'NAME', query: 'สมชาย' });
    const [call] = calls;
    assert.equal(call!.url, 'https://api.test/api/v1/customer-360/contacts/search');
    assert.equal(call!.url.includes('%E0'), false);
    assert.equal(call!.init.method, 'POST');
    assert.deepEqual(JSON.parse(call!.init.body as string), { type: 'NAME', query: 'สมชาย' });
    assert.equal(call!.init.cache, 'no-store');
    await api.search({ type: 'DIRECTORY', query: 'ignored' });
    assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { type: 'DIRECTORY' });

    await api.timeline(ID, 'cur sor');
    assert.equal(
      calls[2]!.url,
      `https://api.test/api/v1/customer-360/contacts/${ID}/timeline?cursor=cur%20sor`,
    );
    await api.governance(ID);
    assert.deepEqual(JSON.parse(calls[3]!.init.body as string), {});
    await api.governance(ID, { channel: 'VOICE', purpose: 'SERVICE' });
    assert.deepEqual(JSON.parse(calls[4]!.init.body as string), {
      channel: 'VOICE',
      purpose: 'SERVICE',
    });
  } finally {
    globalThis.fetch = original;
  }
});

test('api: แปลง error body/Retry-After โดยไม่ throw ถ้า body ไม่ใช่ JSON', async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_FAILED',
            retryable: false,
            fieldErrors: [{ field: 'query', code: 'NAME_TOO_SHORT' }],
          },
        }),
        { status: 400, headers: { 'retry-after': '3' } },
      )) as typeof fetch;
    const api = createCustomersApi({ baseUrl: '', accessToken: () => 'tok' });
    await assert.rejects(api.search({ type: 'NAME', query: 'a' }), (error: unknown) => {
      assert.ok(error instanceof CustomersApiError);
      assert.equal(error.status, 400);
      assert.equal(error.retryAfterSeconds, 3);
      assert.equal(fieldErrorKey(error), 'NAME_TOO_SHORT');
      return true;
    });
    globalThis.fetch = (async () => new Response('<html>', { status: 502 })) as typeof fetch;
    await assert.rejects(api.profile(ID), { status: 502, code: 'REQUEST_FAILED', retryable: true });
    globalThis.fetch = (async () => {
      throw new TypeError('network');
    }) as typeof fetch;
    await assert.rejects(api.profile(ID), { status: 0, code: 'NETWORK_ERROR', retryable: true });
  } finally {
    globalThis.fetch = original;
  }
});
