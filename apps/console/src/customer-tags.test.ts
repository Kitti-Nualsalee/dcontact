import assert from 'node:assert/strict';
import test from 'node:test';
import { createCustomerTagsApi } from './customer-tags/api.js';

const id = '7f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';

test('catalog client ส่งคำสั่งเดิมผ่าน body และคืน terminal แม้ HTTP เป็น conflict', async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        state: 'TERMINAL',
        command: { outcome: 'REJECTED', code: 'REVISION_CONFLICT' },
      }),
      { status: 409 },
    );
  }) as typeof fetch;
  try {
    const api = createCustomerTagsApi({ baseUrl: 'https://api.test/', accessToken: () => 'token' });
    const result = await api.rename(id, { commandId: id, expectedRevision: '3', name: 'ตัวอย่าง' });
    assert.equal(result.state, 'TERMINAL');
    assert.equal(calls[0]!.url, `https://api.test/api/v1/customer-360/tags/${id}`);
    assert.equal(calls[0]!.init.method, 'PATCH');
    assert.equal(calls[0]!.init.cache, 'no-store');
    assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
      commandId: id,
      expectedRevision: '3',
      name: 'ตัวอย่าง',
    });
    await assert.rejects(api.detail('invalid'), { status: 404 });
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('catalog client แยก UNKNOWN, field error และ session ที่หมดอายุ', async () => {
  const original = globalThis.fetch;
  let token: string | undefined;
  try {
    const api = createCustomerTagsApi({ baseUrl: 'https://api.test', accessToken: () => token });
    await assert.rejects(api.list({ state: 'ALL' }), { status: 401 });
    token = 'token';
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ state: 'UNKNOWN', commandId: id }), {
        status: 404,
      })) as typeof fetch;
    assert.equal((await api.command(id)).state, 'UNKNOWN');
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'VALIDATION_FAILED',
            fieldErrors: [{ field: 'name', code: 'TAG_NAME_INVALID' }],
          },
        }),
        { status: 400 },
      )) as typeof fetch;
    await assert.rejects(api.create({ commandId: id, name: 'x' }), {
      status: 400,
      code: 'VALIDATION_FAILED',
      fieldErrors: [{ field: 'name', code: 'TAG_NAME_INVALID' }],
    });
  } finally {
    globalThis.fetch = original;
  }
});
