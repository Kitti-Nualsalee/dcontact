import assert from 'node:assert/strict';
import test from 'node:test';
import { createCg5ConsoleApi } from './cg5-console-api.js';

test('CG5 Console client เรียกเฉพาะ contract routes และไม่ส่ง tenant/actor', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const api = createCg5ConsoleApi({
    baseUrl: 'https://api.example/',
    accessToken: () => 'token',
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    },
  });
  await api.alerts({ states: ['OPEN'], severities: ['CRITICAL'] });
  await api.requestExport({
    datasets: ['DECISION_TRACE'],
    rangeFrom: '2026-09-01T00:00:00.000Z',
    rangeTo: '2026-09-02T00:00:00.000Z',
    evidenceLevel: 'SUMMARY',
    reason: 'audit',
    idempotencyKey: 'intent-1',
  });
  assert.match(requests[0]?.url ?? '', /\/alerts\?limit=50&state=OPEN&severity=CRITICAL$/);
  assert.deepEqual(requests[1]?.init?.headers, {
    authorization: 'Bearer token',
    'content-type': 'application/json',
    'idempotency-key': 'intent-1',
  });
  const body = JSON.parse(requests[1]?.init?.body as string) as Record<string, unknown>;
  assert.equal('tenantId' in body, false);
  assert.equal('actorRef' in body, false);
});
