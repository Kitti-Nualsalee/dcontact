import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfigApi } from './voice-routing/config-api.js';
import { CatalogApiError } from './voice-routing/api.js';

test('B4 ใช้ scoped endpoints พร้อม no-store และ PUT envelope/configRevision แยกจาก status', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json({ configRevision: 8, items: [], nextCursor: null });
  };
  try {
    const api = createConfigApi({ baseUrl: 'https://api.example/', accessToken: () => 'token' });
    await api.roster('scoped+/cursor');
    await api.skills('people/users', 'agent');
    const command = {
      commandId: 'same-command',
      expectedRevision: 7,
      reasonCode: 'ADMIN_CONFIGURATION',
      reason: 'ทดสอบ',
      items: [{ skillId: 'thai', level: 3 }],
    };
    const result = await api.replace('people/users', 'agent', command);
    await api.replace('queues', 'queue', { ...command, items: [{ skillId: 'thai', minLevel: 2 }] });
    await api.bind('destination', { ...command, queueId: 'queue', isActive: false });
    await api.eligibility('queue/?&');
    assert.equal(result.configRevision, 8);
    assert.equal(new URL(requests[0].url).searchParams.get('cursor'), 'scoped+/cursor');
    assert.match(requests[1].url, /people\/users\/agent\/skills$/);
    assert.deepEqual(JSON.parse(String(requests[2].init?.body)), command);
    assert.match(requests[3].url, /queues\/queue\/required-skills$/);
    assert.equal(JSON.parse(String(requests[4].init?.body)).isActive, false);
    assert.equal(new URL(requests[5].url).searchParams.get('queueId'), 'queue/?&');
    for (const request of requests) {
      assert.equal(request.init?.cache, 'no-store');
      assert.equal(request.init?.redirect, 'error');
      assert.equal(new Headers(request.init?.headers).get('authorization'), 'Bearer token');
    }
    assert.equal(requests[2].init?.method, 'PUT');
  } finally {
    globalThis.fetch = original;
  }
});
test('B4 ส่ง conflict กลับ UI และ unknown ไม่มี implicit retry หรือสร้าง command ใหม่', async () => {
  const original = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = async () => {
    writes++;
    return Response.json({ code: 'REVISION_CONFLICT', currentRevision: 9 }, { status: 409 });
  };
  try {
    const api = createConfigApi({ baseUrl: '', accessToken: () => 'token' });
    await assert.rejects(
      api.skills('queues', 'queue'),
      (error: unknown) => error instanceof CatalogApiError && error.code === 'REVISION_CONFLICT',
    );
    assert.equal(writes, 1);
    globalThis.fetch = async () => {
      writes++;
      throw new TypeError('response lost');
    };
    await assert.rejects(
      api.replace('queues', 'queue', {
        commandId: 'original',
        expectedRevision: 4,
        reasonCode: 'CONFIG_CHANGE',
        reason: 'ทดสอบ',
        items: [],
      }),
    );
    assert.equal(writes, 2);
    const unauthenticated = createConfigApi({ baseUrl: '', accessToken: () => undefined });
    await assert.rejects(
      unauthenticated.roster(),
      (error: unknown) => error instanceof CatalogApiError && error.status === 401,
    );
    assert.equal(writes, 2);
  } finally {
    globalThis.fetch = original;
  }
});
