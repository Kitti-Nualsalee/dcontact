import assert from 'node:assert/strict';
import test from 'node:test';
import { JourneyAuthoringApiError } from './journey-authoring/api.js';
import { createUatApi } from './journey-authoring/uat-api.js';

type Call = { url: string; init: RequestInit };

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  }) as typeof globalThis.fetch;
  return { calls, fetch };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('U1.4 runtime profile: 404 หรือไม่ใช่ JSON = ไม่ใช่ UAT, route public ไม่ส่ง token', async () => {
  const notUat = fakeFetch(() => json(404, { message: 'Not Found' }));
  assert.equal(
    await createUatApi({
      baseUrl: 'https://api.example/',
      accessToken: () => 't',
      fetch: notUat.fetch,
    }).runtimeProfile(),
    null,
  );
  const html = fakeFetch(() => new Response('<!doctype html>', { status: 200 }));
  assert.equal(
    await createUatApi({ baseUrl: '', accessToken: () => 't', fetch: html.fetch }).runtimeProfile(),
    null,
  );
  const uat = fakeFetch(() => json(200, { profile: 'uat', kafka: 'DISABLED' }));
  const profile = await createUatApi({
    baseUrl: 'https://api.example/',
    accessToken: () => 't',
    fetch: uat.fetch,
  }).runtimeProfile();
  assert.equal(profile?.profile, 'uat');
  assert.equal(uat.calls[0]!.url, 'https://api.example/api/v1/runtime-profile');
  assert.equal(new Headers(uat.calls[0]!.init.headers).get('authorization'), null);
});

test('U1.4 UAT run: ไม่มี run = null, mutation ส่ง Idempotency-Key และ error คืน code/safeParams', async () => {
  const { calls, fetch } = fakeFetch((url, init) => {
    if (url.endsWith('/current')) return json(404, { code: 'UAT_RUN_NOT_FOUND' });
    if (init.method === 'POST' && url.endsWith('/start'))
      return json(409, {
        code: 'UAT_RUN_PENDING_REVIEW',
        safeParams: { nextSafeAction: 'DECIDE_REVIEW' },
      });
    return json(401, { message: 'Unauthorized' });
  });
  const api = createUatApi({ baseUrl: '', accessToken: () => 'token-1', fetch });
  assert.equal(await api.current(), null);
  await assert.rejects(
    api.start({ environment: 'uat', packVersion: 'p1', expectedRevision: 2 }, 'uat-start-1'),
    (error: unknown) =>
      error instanceof JourneyAuthoringApiError &&
      error.status === 409 &&
      error.code === 'UAT_RUN_PENDING_REVIEW' &&
      error.safeParams.nextSafeAction === 'DECIDE_REVIEW',
  );
  const start = calls.find((call) => call.url.endsWith('/start'))!;
  const headers = new Headers(start.init.headers);
  assert.equal(headers.get('idempotency-key'), 'uat-start-1');
  assert.equal(headers.get('authorization'), 'Bearer token-1');
  assert.deepEqual(JSON.parse(String(start.init.body)), {
    environment: 'uat',
    packVersion: 'p1',
    expectedRevision: 2,
  });
  // session หมด: 401 ไม่ถูกกลืนเป็น "ไม่มี run"
  await assert.rejects(
    api.recordStepResult('run-1', { stepId: 'S01', outcome: 'PASS', actual: 'ok' }, 'k'),
    (error: unknown) => error instanceof JourneyAuthoringApiError && error.status === 401,
  );
  assert.equal(calls.at(-1)!.url, '/api/v1/uat-runs/run-1/step-results');
});

test('U1.5 หลักฐาน: อัปโหลด raw PNG พร้อม bearer/key/step header, 415 คืน code และ bundle ไม่มี token ใน URL', async () => {
  const { calls, fetch } = fakeFetch((url, init) => {
    if (init.method === 'POST' && url.endsWith('/evidence')) {
      const type = new Headers(init.headers).get('content-type');
      return type === 'image/png'
        ? json(200, { evidenceId: 'e-1', stepId: 'LOGIN', sha256: 'a'.repeat(64) })
        : json(415, { code: 'EVIDENCE_TYPE_REJECTED', safeParams: { reason: 'CONTENT_TYPE' } });
    }
    if (url.endsWith('/evidence')) return json(200, { runId: 'run-1', items: [] });
    return json(200, { schema: 'UatEvidenceBundleV1', digest: 'b'.repeat(64) });
  });
  const api = createUatApi({ baseUrl: '', accessToken: () => 'token-1', fetch });
  const shot = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
  assert.equal(
    (await api.uploadEvidence('run-1', 'LOGIN', shot, 'uat-evidence-1')).evidenceId,
    'e-1',
  );
  const upload = calls[0]!;
  const headers = new Headers(upload.init.headers);
  assert.equal(upload.url, '/api/v1/uat-runs/run-1/evidence');
  assert.equal(headers.get('authorization'), 'Bearer token-1');
  assert.equal(headers.get('idempotency-key'), 'uat-evidence-1');
  assert.equal(headers.get('x-uat-step-id'), 'LOGIN');
  assert.equal(upload.init.body, shot);

  const trace = new Blob([new Uint8Array([0x50, 0x4b, 3, 4])], { type: 'application/zip' });
  await assert.rejects(
    api.uploadEvidence('run-1', 'LOGIN', trace, 'uat-evidence-2'),
    (error: unknown) =>
      error instanceof JourneyAuthoringApiError &&
      error.status === 415 &&
      error.code === 'EVIDENCE_TYPE_REJECTED',
  );
  assert.deepEqual(await api.listEvidence('run-1'), { runId: 'run-1', items: [] });
  assert.equal((await api.exportBundle('run-1')).digest, 'b'.repeat(64));
  assert.equal(calls.at(-1)!.url, '/api/v1/uat-runs/run-1/bundle');
  for (const call of calls) assert.doesNotMatch(call.url, /token|bearer/i);
});
