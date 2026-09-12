import assert from 'node:assert/strict';
import test from 'node:test';
import { createConsoleApi } from './console-api.js';

test('Preference Center เรียกเฉพาะ D-Contact canonical API พร้อม bearer และ idempotency key', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const api = createConsoleApi({
    baseUrl: 'https://api.example',
    accessToken: () => 'token-in-memory',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('/preferences') && init?.method !== 'POST') {
        return new Response(JSON.stringify({ preferences: [], callbacks: [] }), {
          status: 200,
          headers: { etag: 'cg-contact-v4', 'content-type': 'application/json' },
        });
      }
      if (String(url).includes('effective-preference')) {
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { etag: 'cg-contact-v4', 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ aggregateVersion: 5, preference: { id: 'pref-1', version: 5 } }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const contactId = '9a8a5477-aa53-4254-ae68-a21ab64cc2bb';
  const history = await api.preferenceHistory(contactId);
  await api.effectivePreference({ contactId, channel: 'LINE', purpose: 'MARKETING' });
  await api.setPreference({
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'BLOCK',
    timezone: 'Asia/Bangkok',
    preferredWindows: [{ daysOfWeek: [1, 2, 3, 4, 5], startLocal: '09:00', endLocal: '18:00' }],
    evidenceRef: 'customer-request',
    expectedVersion: 4,
    commandId: '04e5b24d-f298-4e5e-83d9-2cadfd7ed204',
  });

  assert.equal(history.aggregateVersion, 4);
  assert.equal(
    requests[0]?.url,
    `https://api.example/api/v1/contact-governance/contacts/${contactId}/preferences`,
  );
  assert.match(requests[1]?.url ?? '', /effective-preference\?channel=LINE&purpose=MARKETING$/);
  assert.equal(requests[2]?.url, 'https://api.example/api/v1/contact-governance/preferences');
  assert.deepEqual(requests[2]?.init?.headers, {
    authorization: 'Bearer token-in-memory',
    'content-type': 'application/json',
    'idempotency-key': '04e5b24d-f298-4e5e-83d9-2cadfd7ed204',
  });
  const body = JSON.parse(requests[2]?.init?.body as string) as Record<string, unknown>;
  assert.equal(body.tenantId, undefined);
  assert.deepEqual(body.preferredWindows, [
    { daysOfWeek: [1, 2, 3, 4, 5], startLocal: '09:00', endLocal: '18:00' },
  ]);
});
