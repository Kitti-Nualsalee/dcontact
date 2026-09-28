import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createWorkSessionApi,
  LEASE_REQUIRED_CLOSE_CODE,
  WorkSessionClient,
  WorkSessionRequestError,
  type WorkSessionApi,
  type WorkSessionHolder,
  type WorkSessionLease,
  type WorkSessionStatus,
  type WorkSessionTimers,
} from './work-session.js';

/** นาฬิกา + timer จำลอง — เดินเวลาเองด้วย `advance` */
function fakeClock(start = Date.parse('2026-09-28T09:00:00.000Z')) {
  let now = start;
  let nextId = 1;
  const tasks = new Map<number, { at: number; every?: number; run: () => void }>();
  const timers: WorkSessionTimers = {
    setInterval: (run, ms) => {
      const id = nextId++;
      tasks.set(id, { at: now + ms, every: ms, run });
      return id;
    },
    clearInterval: (id) => void tasks.delete(id as number),
    setTimeout: (run, ms) => {
      const id = nextId++;
      tasks.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout: (id) => void tasks.delete(id as number),
  };
  return {
    timers,
    now: () => now,
    pending: () => tasks.size,
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...tasks.entries()]
          .filter(([, task]) => task.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, task] = due;
        now = task.at;
        if (task.every) task.at += task.every;
        else tasks.delete(id);
        task.run();
        await flush();
      }
      now = until;
    },
  };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function leaseOf(id: string, at: number, surface: 'workspace' | 'dphone' = 'workspace') {
  return {
    leaseId: id,
    surface,
    hostOrigin: null,
    acquiredAt: new Date(at).toISOString(),
    expiresAt: new Date(at + 60_000).toISOString(),
    ttlSeconds: 60,
    heartbeatSeconds: 20,
  } satisfies WorkSessionLease;
}

const holderA: WorkSessionHolder = {
  leaseId: 'lease-a',
  surface: 'workspace',
  hostOrigin: null,
  acquiredAt: '2026-09-28T08:55:00.000Z',
  busy: false,
};

/** API จำลอง: บันทึกทุกคำขอ และตอบตามที่ test ตั้งไว้ */
interface FakeApi {
  status: WorkSessionStatus;
  acquireResult?: WorkSessionLease | WorkSessionRequestError;
  takeoverResult?: WorkSessionLease | WorkSessionRequestError;
  calls: string[];
  impl: WorkSessionApi;
}

function fakeApi(clock: ReturnType<typeof fakeClock>): FakeApi {
  const calls: string[] = [];
  const api: FakeApi = {
    status: { enforced: true, holder: null },
    calls,
    impl: {
      status: async () => {
        calls.push('status');
        return api.status;
      },
      acquire: async (surface) => {
        calls.push(`acquire:${surface}`);
        const result = api.acquireResult ?? leaseOf('lease-new', clock.now());
        if (result instanceof Error) throw result;
        return result;
      },
      takeover: async (surface, expected) => {
        calls.push(`takeover:${surface}:${expected}`);
        const result = api.takeoverResult ?? leaseOf('lease-moved', clock.now(), surface);
        if (result instanceof Error) throw result;
        return result;
      },
      release: async (leaseId) => {
        calls.push(`release:${leaseId}`);
      },
    },
  };
  return api;
}

function setup(options: { busy?: () => boolean; surface?: 'workspace' | 'dphone' } = {}) {
  const clock = fakeClock();
  const api = fakeApi(clock);
  const client = new WorkSessionClient({
    surface: options.surface ?? 'workspace',
    api: api.impl,
    busy: options.busy,
    now: clock.now,
    timers: clock.timers,
  });
  const phases: string[] = [];
  client.subscribe((state) => phases.push(state.phase));
  return { clock, api, client, phases };
}

test('flag ปิด → disabled: ไม่ขอ lease, ไม่มี timer — ผู้เรียกใช้พฤติกรรมเดิม', async () => {
  const { api, client, clock } = setup();
  api.status = { enforced: false, holder: null };
  await client.start({ autoAcquire: true });
  assert.equal(client.current().phase, 'disabled');
  assert.equal(client.ownsWork(), false);
  assert.deepEqual(api.calls, ['status']);
  assert.equal(clock.pending(), 0);
});

test('acquire → heartbeat ทุก 20 วินาทีผ่าน WS → lease.revoked (takeover) หยุดรับงานทันทีและแสดงผู้ถือใหม่', async () => {
  const { api, client, clock, phases } = setup();
  await client.start({ autoAcquire: true });
  assert.equal(client.current().phase, 'held');
  assert.equal(client.leaseId(), 'lease-new');
  assert.deepEqual(api.calls, ['status', 'acquire:workspace']);

  const sent: unknown[] = [];
  client.attachSocket({ send: (message) => sent.push(message) });
  await clock.advance(19_999);
  assert.equal(sent.length, 0);
  await clock.advance(1);
  assert.deepEqual(sent, [{ type: 'lease:heartbeat', leaseId: 'lease-new' }]);
  // server ต่ออายุ → ผ่านเลย TTL เดิมได้โดยไม่ถือว่าหมดอายุ
  client.handleSocketEvent({
    type: 'lease.active',
    leaseId: 'lease-new',
    expiresAt: new Date(clock.now() + 60_000).toISOString(),
  });
  await clock.advance(40_000);
  assert.equal(client.current().phase, 'held');
  assert.equal(sent.length, 3);

  // lease ของคนอื่น/เก่าไม่มีผล
  assert.equal(
    client.handleSocketEvent({ type: 'lease.revoked', leaseId: 'other', reason: 'takeover' }),
    true,
  );
  assert.equal(client.current().phase, 'held');

  api.status = { enforced: true, holder: { ...holderA, leaseId: 'lease-b', surface: 'dphone' } };
  client.handleSocketEvent({ type: 'lease.revoked', leaseId: 'lease-new', reason: 'takeover' });
  assert.equal(client.ownsWork(), false, 'หยุดรับงานทันทีก่อนคำตอบของ server');
  await flush();
  assert.deepEqual(client.current(), {
    phase: 'standby',
    holder: { ...holderA, leaseId: 'lease-b', surface: 'dphone' },
    loss: 'takeover',
  });
  // ไม่มี heartbeat อีกหลังเสีย lease
  await clock.advance(20_000);
  assert.equal(sent.length, 3);
  assert.deepEqual(phases.slice(0, 3), ['checking', 'acquiring', 'held']);
});

test('lease.expired และ WS ปิด 4409 = หมดอายุ; หลุด WS เกิน TTL ตอนว่างถือว่าหมดอายุเอง แต่ระหว่างมีงานไม่หมด', async () => {
  let busy = false;
  const expired = setup({ busy: () => busy });
  await expired.client.start({ autoAcquire: true });
  expired.client.handleSocketEvent({ type: 'lease.expired', leaseId: 'lease-new' });
  await flush();
  assert.deepEqual(expired.client.current(), { phase: 'standby', holder: null, loss: 'expired' });

  const rejected = setup();
  await rejected.client.start({ autoAcquire: true });
  rejected.client.handleSocketClosed(LEASE_REQUIRED_CLOSE_CODE);
  await flush();
  assert.equal(rejected.client.current().phase, 'standby');
  // WS ปิดด้วยเหตุอื่น (เช่นเครือข่าย) ไม่ใช่การเสีย lease
  const network = setup();
  await network.client.start({ autoAcquire: true });
  network.client.handleSocketClosed(1006);
  assert.equal(network.client.current().phase, 'held');

  // มีสายอยู่: WS หลุดนานเกิน TTL ก็ยังถือ lease (server ไม่ปล่อยระหว่างมีงาน — ADR-026 ข้อ 4)
  const silent = setup({ busy: () => busy });
  await silent.client.start({ autoAcquire: true });
  busy = true;
  await silent.clock.advance(120_000);
  assert.equal(silent.client.current().phase, 'held');
  busy = false;
  await silent.clock.advance(20_000);
  assert.deepEqual(silent.client.current(), { phase: 'standby', holder: null, loss: 'expired' });
});

test('มีผู้ถืออยู่ → standby พร้อมผู้ถือ; แท็บที่ไม่ใช่ leader ไม่ขอ lease เอง; ปล่อย lease ตอนปิดหน้า', async () => {
  const held = setup();
  held.api.acquireResult = new WorkSessionRequestError(409, 'WORK_SESSION_HELD', holderA);
  await held.client.start({ autoAcquire: true });
  assert.deepEqual(held.client.current(), { phase: 'standby', holder: holderA });

  const follower = setup();
  await follower.client.start({ autoAcquire: false });
  assert.deepEqual(follower.client.current(), { phase: 'standby', holder: null });
  assert.deepEqual(follower.api.calls, ['status']);
  // กลายเป็น leader ของ origin และไม่มีผู้ถือ → ขอเอง
  follower.client.setAutoAcquire(true);
  await flush();
  assert.equal(follower.client.current().phase, 'held');

  follower.client.releaseOnExit();
  await flush();
  assert.deepEqual(follower.api.calls.at(-1), 'release:lease-new');
  assert.equal(follower.clock.pending(), 0);
});

test('takeover: ยืนยันแล้วย้ายด้วย expectedLeaseId → ถือ lease ใหม่; ผู้ถือมีงาน = ไม่ส่งคำขอ', async () => {
  const { api, client } = setup({ surface: 'dphone' });
  api.status = { enforced: true, holder: { ...holderA, busy: true } };
  await client.start({ autoAcquire: true });
  assert.deepEqual(api.calls, ['status'], 'มีผู้ถือ → ไม่ยิง acquire');
  await client.takeover();
  assert.deepEqual(api.calls, ['status'], 'ผู้ถือมีงาน → ไม่ส่ง takeover');
  assert.deepEqual(client.current(), {
    phase: 'standby',
    holder: { ...holderA, busy: true },
    rejection: 'busy',
  });

  api.status = { enforced: true, holder: holderA };
  await client.refresh();
  assert.deepEqual(client.current(), { phase: 'standby', holder: holderA });
  await client.takeover();
  assert.deepEqual(api.calls.at(-1), 'takeover:dphone:lease-a');
  assert.equal(client.current().phase, 'held');
  assert.equal(client.leaseId(), 'lease-moved');
});

test('takeover ถูกปฏิเสธ (BUSY/CHANGED/เครือข่าย) → กลับ standby พร้อมเหตุผล ไม่ถือ lease และลองใหม่ได้', async () => {
  const { api, client, clock } = setup();
  api.status = { enforced: true, holder: holderA };
  await client.start({ autoAcquire: true });

  api.takeoverResult = new WorkSessionRequestError(409, 'WORK_SESSION_BUSY', {
    ...holderA,
    busy: true,
  });
  await client.takeover();
  assert.deepEqual(client.current(), {
    phase: 'standby',
    holder: { ...holderA, busy: true },
    rejection: 'busy',
  });
  assert.equal(client.ownsWork(), false);

  // รอบตรวจอัตโนมัติ: ผู้ถือจบงานแล้ว → ปุ่มย้ายเปิดเอง
  await clock.advance(20_000);
  assert.deepEqual(client.current(), { phase: 'standby', holder: holderA });

  const holderB = { ...holderA, leaseId: 'lease-b' };
  api.takeoverResult = new WorkSessionRequestError(409, 'WORK_SESSION_CHANGED');
  api.status = { enforced: true, holder: holderB };
  await client.takeover();
  assert.deepEqual(client.current(), { phase: 'standby', holder: holderB, rejection: 'changed' });

  api.takeoverResult = new WorkSessionRequestError(503);
  await client.takeover();
  assert.deepEqual(client.current(), { phase: 'standby', holder: holderB, rejection: 'failed' });

  api.takeoverResult = undefined;
  await client.takeover();
  assert.equal(client.current().phase, 'held');
  assert.deepEqual(
    api.calls.filter((call) => call.startsWith('takeover')),
    [
      'takeover:workspace:lease-a',
      'takeover:workspace:lease-a',
      'takeover:workspace:lease-b',
      'takeover:workspace:lease-b',
    ],
  );
});

test('คุยกับ server ไม่สำเร็จ → error แล้วลองใหม่อัตโนมัติ; คำตอบที่มาหลัง stop ถูกทิ้ง', async () => {
  const { api, client, clock } = setup();
  let fail = true;
  const status = api.impl.status;
  api.impl.status = async () => {
    if (fail) throw new WorkSessionRequestError(503);
    return status();
  };
  await client.start({ autoAcquire: true });
  assert.equal(client.current().phase, 'error');
  fail = false;
  await clock.advance(20_000);
  assert.equal(client.current().phase, 'held');

  const late = setup();
  let resolve!: (value: WorkSessionStatus) => void;
  late.api.impl.status = () => new Promise((done) => (resolve = done));
  const started = late.client.start({ autoAcquire: true });
  late.client.stop();
  resolve({ enforced: true, holder: null });
  await started;
  assert.equal(late.client.current().phase, 'checking');
  assert.deepEqual(late.api.calls, []);
});

test('HTTP: ส่ง bearer + surface, อ่าน envelope 409 พร้อมผู้ถือ, 404 = ไม่บังคับ, ปล่อยด้วย header', async () => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const replies: Response[] = [];
  const api = createWorkSessionApi({
    baseUrl: 'https://api.example/',
    accessToken: () => 'token-in-memory',
    fetch: async (input, init) => {
      requests.push({ url: String(input), init });
      return replies.shift()!;
    },
  });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  replies.push(json(200, { enforced: true, holder: holderA }));
  assert.deepEqual(await api.status(), { enforced: true, holder: holderA });
  assert.equal(requests[0]?.url, 'https://api.example/api/v1/me/work-session');
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>).authorization,
    'Bearer token-in-memory',
  );

  replies.push(new Response('not found', { status: 404 }));
  assert.deepEqual(await api.status(), { enforced: false, holder: null });
  replies.push(new Response('<html></html>', { status: 200 }));
  assert.deepEqual(await api.status(), { enforced: false, holder: null });
  replies.push(new Response('down', { status: 503 }));
  await assert.rejects(api.status(), WorkSessionRequestError);

  replies.push(json(409, { code: 'WORK_SESSION_HELD', holder: holderA }));
  await assert.rejects(api.acquire('workspace'), (error: WorkSessionRequestError) => {
    assert.equal(error.code, 'WORK_SESSION_HELD');
    assert.deepEqual(error.holder, holderA);
    return true;
  });
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), { surface: 'workspace' });

  replies.push(json(201, leaseOf('lease-x', Date.parse('2026-09-28T09:00:00.000Z'))));
  assert.equal((await api.takeover('workspace', 'lease-a')).leaseId, 'lease-x');
  assert.equal(requests.at(-1)?.url, 'https://api.example/api/v1/me/work-session/takeover');
  assert.deepEqual(JSON.parse(String(requests.at(-1)?.init?.body)), {
    surface: 'workspace',
    expectedLeaseId: 'lease-a',
  });

  replies.push(new Response(null, { status: 204 }));
  await api.release('lease-x', { keepalive: true });
  assert.equal(requests.at(-1)?.init?.method, 'DELETE');
  assert.equal(
    (requests.at(-1)?.init?.headers as Record<string, string>)['x-work-session-lease-id'],
    'lease-x',
  );
  assert.equal(requests.at(-1)?.init?.keepalive, true);
});
