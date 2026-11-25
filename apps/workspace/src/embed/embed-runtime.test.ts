import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ActivityMessage,
  CallRequestMessage,
  DphoneToHostMessage,
} from '@d-contact/dphone-embed';
import { EmbedRuntime } from './embed-runtime.js';

const HOST = 'https://crm.example.test';
const interaction = {
  id: 'int-1',
  state: 'WRAPUP' as const,
  direction: 'INBOUND' as const,
  version: '3',
  caller: '0812345678',
  queue: { id: 'q-1', name: 'Customer service' },
  offerExpiresAt: null,
  answeredAt: '2026-09-28T10:00:00.000Z',
  endedAt: '2026-09-28T10:03:05.000Z',
};

function runtime(
  options: {
    screenPopLevel?: 'off' | 'ids' | 'contact';
    respond?: (url: string, init: RequestInit) => Response | Promise<Response>;
  } = {},
) {
  const sent: DphoneToHostMessage[] = [];
  const activities: ActivityMessage[] = [];
  const requests: { url: string; init: RequestInit }[] = [];
  let id = 0;
  const rt = new EmbedRuntime({
    apiBaseUrl: 'https://api.dcontact.test',
    hostOrigin: HOST,
    screenPopLevel: options.screenPopLevel ?? 'ids',
    authorizedFetch: async (url, init) => {
      requests.push({ url, init });
      return options.respond ? options.respond(url, init) : Response.json({}, { status: 500 });
    },
    send: (message) => (sent.push(message), true),
    enqueueActivity: (message) => activities.push(message),
    requestId: () => `gen-${++id}`,
    now: () => new Date('2026-09-28T10:05:00.000Z'),
  });
  return { rt, sent, activities, requests };
}

const call = (requestId: string): CallRequestMessage => ({
  v: 1,
  type: 'dphone.call',
  requestId,
  number: '0812345678',
});

test('dphone.call from the host only fills in the number (prefilled) — no server call until the agent presses call', () => {
  const r = runtime();
  r.rt.setLease('lease-1');
  r.rt.prefillFromHost(call('h1'));
  assert.equal(r.rt.state.phase, 'prefilled');
  assert.deepEqual(r.sent, [
    { v: 1, type: 'dphone.call.result', requestId: 'h1', status: 'prefilled', blocked: false },
  ]);
  assert.equal(r.requests.length, 0);
});

test('no lease yet → unavailable immediately; a new request replaces the old one (the old gets cancelled)', () => {
  const r = runtime();
  r.rt.prefillFromHost(call('h0'));
  const first = r.sent.at(-1)!;
  assert.equal(first.type === 'dphone.call.result' && first.status, 'unavailable');
  r.rt.setLease('lease-1');
  r.rt.prefillFromHost(call('h1'));
  r.rt.prefillFromHost(call('h2'));
  const statuses = r.sent.map((m) =>
    m.type === 'dphone.call.result' ? [m.requestId, m.status] : [],
  );
  assert.deepEqual(statuses.slice(1), [
    ['h1', 'prefilled'],
    ['h1', 'cancelled'],
    ['h2', 'prefilled'],
  ]);
});

test('agent presses call → calls click-to-call with the lease header, then sends the server result to the host', async () => {
  const blocked = {
    v: 1,
    type: 'dphone.call.result',
    requestId: 'h1',
    status: 'blocked',
    blocked: true,
    reasonCode: 'QUIET_HOURS',
    decisionId: 'dec-1',
  };
  const r = runtime({
    respond: () => Response.json({ status: 'result', hostOrigin: HOST, message: blocked }),
  });
  r.rt.setLease('lease-1');
  r.rt.prefillFromHost(call('h1'));
  await r.rt.dial();
  const [request] = r.requests;
  assert.equal(request!.url, 'https://api.dcontact.test/api/v1/workspace/agent/click-to-call');
  assert.equal(new Headers(request!.init.headers).get('x-work-session-lease-id'), 'lease-1');
  assert.deepEqual(JSON.parse(String(request!.init.body)), {
    requestId: 'h1',
    number: '0812345678',
  });
  assert.deepEqual(r.sent.at(-1), blocked);
  assert.equal(r.rt.state.phase, 'result');
});

test('after the server answers dialing, the cancel button calls durable cancel with requestId + lease', async () => {
  let requestCount = 0;
  const r = runtime({
    respond: () => {
      requestCount += 1;
      return requestCount === 1
        ? Response.json({
            status: 'result',
            hostOrigin: HOST,
            message: {
              v: 1,
              type: 'dphone.call.result',
              requestId: 'h1',
              status: 'dialing',
              blocked: false,
            },
          })
        : Response.json({
            status: 'result',
            hostOrigin: HOST,
            result: { requestId: 'h1', status: 'reconciling' },
          });
    },
  });
  r.rt.setLease('lease-1');
  r.rt.prefillFromHost(call('h1'));
  await r.rt.dial();
  await r.rt.cancel();
  assert.equal(
    r.requests[1]!.url,
    'https://api.dcontact.test/api/v1/workspace/agent/click-to-call/cancel',
  );
  assert.equal(new Headers(r.requests[1]!.init.headers).get('x-work-session-lease-id'), 'lease-1');
  assert.deepEqual(JSON.parse(String(r.requests[1]!.init.body)), { requestId: 'h1' });
  assert.equal(r.rt.state.phase, 'idle');
  const result = r.sent.at(-1);
  assert.equal(
    result?.type === 'dphone.call.result' && result.reasonCode,
    'VOICE_CANCEL_RECONCILING',
  );
});

test('server answers a hostOrigin that does not match the locked origin → the server result is not sent to the host', async () => {
  const r = runtime({
    respond: () =>
      Response.json({
        status: 'result',
        hostOrigin: 'https://other.example.test',
        message: {
          v: 1,
          type: 'dphone.call.result',
          requestId: 'h1',
          status: 'blocked',
          blocked: true,
        },
      }),
  });
  r.rt.setLease('lease-1');
  r.rt.prefillFromHost(call('h1'));
  await r.rt.dial();
  const last = r.sent.at(-1)!;
  assert.equal(last.type === 'dphone.call.result' && last.reasonCode, 'SERVER_UNAVAILABLE');
});

test('screen-pop: off = no server request; on = send the server payload only when hostOrigin matches', async () => {
  const off = runtime({ screenPopLevel: 'off' });
  off.rt.setLease('lease-1');
  off.rt.onCallEvent({ type: 'offered', interaction: { ...interaction, state: 'ASSIGNED' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(off.requests.length, 0);

  const payload = {
    v: 1,
    type: 'dphone.screenpop',
    requestId: 'gen-1',
    level: 'ids',
    interactionId: 'int-1',
    policyVersion: 'p',
    decisionId: 'd',
  };
  let origin = HOST;
  const on = runtime({
    respond: () => Response.json({ status: 'sent', hostOrigin: origin, message: payload }),
  });
  on.rt.setLease('lease-1');
  on.rt.onCallEvent({ type: 'offered', interaction: { ...interaction, state: 'ASSIGNED' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(on.sent, [payload]);
  assert.equal(new Headers(on.requests[0]!.init.headers).get('x-work-session-lease-id'), 'lease-1');

  origin = 'https://other.example.test';
  on.rt.onCallEvent({ type: 'answered', interaction: { ...interaction, state: 'ACTIVE' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(on.sent.length, 1);
});

test('wrap-up finished → activity is queued with no number/audio/transcript/note', () => {
  const r = runtime();
  r.rt.onCallEvent({ type: 'wrapup.completed', interaction, disposition: 'CUSTOMER_ASSISTED' });
  assert.deepEqual(r.activities, [
    {
      v: 1,
      type: 'dphone.activity',
      requestId: 'gen-1',
      interactionId: 'int-1',
      direction: 'INBOUND',
      startedAt: '2026-09-28T10:00:00.000Z',
      endedAt: '2026-09-28T10:03:05.000Z',
      durationSeconds: 185,
      disposition: 'CUSTOMER_ASSISTED',
      queue: { id: 'q-1', name: 'Customer service' },
    },
  ]);
  assert.equal(JSON.stringify(r.activities).includes('0812345678'), false);
});

test('a call arrives before the lease is obtained → request screen-pop as soon as the lease is obtained', async () => {
  const r = runtime({ respond: () => Response.json({ status: 'off' }) });
  r.rt.onCallEvent({ type: 'offered', interaction: { ...interaction, state: 'ASSIGNED' } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.requests.length, 0);
  r.rt.setLease('lease-late');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(r.requests.length, 1);
  assert.equal(
    new Headers(r.requests[0]!.init.headers).get('x-work-session-lease-id'),
    'lease-late',
  );
});
