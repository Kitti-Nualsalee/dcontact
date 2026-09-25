import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Registry } from 'prom-client';
import {
  PlatformHealthCollector,
  PlatformWorkerMetrics,
  metricCode,
  startMetricsServer,
} from './platform-metrics.js';
import { PlatformRollout } from './platform-rollout.js';
import { createPlatformWorkerLoop } from './platform-worker.js';

const REQUEST = '6f1c2b1e-8e0a-4d6b-9a57-0d6f3c1b2a90';
const TENANT = '0b8e7f5d-3c2a-4e19-8d76-5a4b3c2d1e0f';

function queue<T>(items: T[], idle: T) {
  return { runOnce: async () => items.shift() ?? idle };
}

test('worker loop นับผลตาม source/kind/step/code และไม่มี id/PII ใน label', async () => {
  const registry = new Registry();
  const database = {
    pfProvisioningRequest: {
      findUnique: async () => ({
        acceptedAt: new Date('2026-09-25T00:00:00Z'),
        terminalAt: new Date('2026-09-25T00:01:30Z'),
      }),
    },
  };
  const metrics = new PlatformWorkerMetrics(registry, database as never);
  const loop = createPlatformWorkerLoop({
    workerId: 'w-1',
    saga: queue<any>(
      [
        {
          kind: 'STEP_SUCCEEDED',
          requestId: REQUEST,
          stepKey: 'KEYCLOAK_ORGANIZATION',
          adopted: true,
        },
        {
          kind: 'ACTION_REQUIRED',
          requestId: REQUEST,
          stepKey: 'INVITATION',
          code: 'ATTEMPTS_EXHAUSTED',
        },
        { kind: 'LEASE_LOST', requestId: REQUEST, stepKey: 'READINESS' },
        { kind: 'COMPLETED', requestId: REQUEST, tenantId: TENANT },
      ],
      { kind: 'IDLE' },
    ),
    commands: queue<any>(
      [
        { kind: 'FINISHED', commandId: REQUEST, state: 'SUCCEEDED', errorCode: null },
        { kind: 'RETRY_LATER', commandId: REQUEST, errorCode: 'owner@example.test' },
      ],
      { kind: 'IDLE' },
    ),
    rollout: PlatformRollout.fixed({ enabled: true, allowlist: [] }),
    metrics,
  });
  while (await loop.tick());
  const text = await registry.metrics();
  for (const series of [
    'dcontact_platform_worker_results_total{source="saga",kind="STEP_SUCCEEDED",step="KEYCLOAK_ORGANIZATION",code="none"} 1',
    'dcontact_platform_worker_results_total{source="saga",kind="ACTION_REQUIRED",step="INVITATION",code="ATTEMPTS_EXHAUSTED"} 1',
    'dcontact_platform_worker_results_total{source="saga",kind="LEASE_LOST",step="READINESS",code="LEASE_LOST"} 1',
    'dcontact_platform_worker_results_total{source="command",kind="FINISHED",step="none",code="SUCCEEDED"} 1',
    // code ที่ไม่ใช่ stable code (เช่นมี email) ถูกแทนด้วย OTHER
    'dcontact_platform_worker_results_total{source="command",kind="RETRY_LATER",step="none",code="OTHER"} 1',
    'dcontact_platform_provisioning_duration_seconds_sum 90',
    'dcontact_platform_worker_claims_enabled 1',
  ]) {
    assert.ok(text.includes(series), `ขาด ${series}\n${text}`);
  }
  for (const leaked of [REQUEST, TENANT, 'w-1', '@']) {
    assert.equal(text.includes(leaked), false, `metrics รั่ว ${leaked}`);
  }
  assert.equal(metricCode('RETRY_LATER'), 'RETRY_LATER');
  assert.equal(metricCode('lower'), 'OTHER');
});

test('worker loop ที่ rollout ปิดรายงาน claims_enabled 0 และไม่นับผลใดๆ', async () => {
  const registry = new Registry();
  const loop = createPlatformWorkerLoop({
    workerId: 'w-2',
    saga: queue<any>([{ kind: 'COMPLETED', requestId: REQUEST, tenantId: TENANT }], {
      kind: 'IDLE',
    }),
    commands: queue<any>([], { kind: 'IDLE' }),
    rollout: PlatformRollout.fixed({ enabled: false, allowlist: [] }),
    metrics: new PlatformWorkerMetrics(registry),
  });
  assert.equal(await loop.tick(), false);
  const text = await registry.metrics();
  assert.ok(text.includes('dcontact_platform_worker_claims_enabled 0'));
  assert.equal(text.includes('dcontact_platform_worker_results_total{'), false);
});

test('health collector: อายุคิว/invariant จาก DB, cache ระหว่าง scrape และ DB ล้ม = success 0', async () => {
  const now = new Date('2026-09-25T01:00:00Z');
  let calls = 0;
  let broken = false;
  const database = {
    $queryRawUnsafe: async (sql: string) => {
      calls += 1;
      if (broken) throw new Error('connection refused postgres://secret');
      if (sql.includes("status = 'PENDING'")) return [{ at: new Date('2026-09-25T00:54:00Z') }];
      if (sql.includes('min(')) return [{ at: null }];
      if (sql.includes("lifecycle_status = 'ACTIVE' AND r.status")) return [{ n: 2 }];
      if (sql.includes('GROUP BY status')) return [{ status: 'PENDING', n: 3 }];
      if (sql.includes('GROUP BY state')) return [{ state: 'SENT', n: 1 }];
      return [{ n: 0 }];
    },
  };
  const registry = new Registry();
  new PlatformHealthCollector(database, registry, { now: () => now, minIntervalMs: 60_000 });
  // scrape แรกต้องสะท้อนผลของ scrape นั้นเอง (เคยช้าไปหนึ่งรอบ = 0 ทั้งที่อ่านสำเร็จ — พบใน UAT)
  const text = await registry.metrics();
  for (const series of [
    'dcontact_platform_oldest_age_seconds{queue="pending_request"} 360',
    'dcontact_platform_oldest_age_seconds{queue="invitation_outbox"} 0',
    'dcontact_platform_invariant_violations{invariant="premature_active"} 2',
    'dcontact_platform_invariant_violations{invariant="audit_gap"} 0',
    'dcontact_platform_requests{status="PENDING"} 3',
    'dcontact_platform_invitations{state="SENT"} 1',
    'dcontact_platform_health_scrape_success 1',
  ]) {
    assert.ok(text.includes(series), `ขาด ${series}\n${text}`);
  }
  const perScrape = calls;
  await registry.metrics();
  assert.equal(calls, perScrape, 'scrape ภายใน minInterval ต้องใช้ cache');

  // DB ล่มระหว่างทาง: scrape นั้นต้องได้ 0 ทันที และไม่รายงาน invariant/อายุคิวค่าเก่า
  const flapping = new Registry();
  broken = false;
  new PlatformHealthCollector(database, flapping, { now: () => now, minIntervalMs: 0 });
  assert.ok((await flapping.metrics()).includes('dcontact_platform_health_scrape_success 1'));
  broken = true;
  const down = await flapping.metrics();
  assert.ok(down.includes('dcontact_platform_health_scrape_success 0'), down);
  assert.equal(down.includes('dcontact_platform_invariant_violations{'), false, down);
  assert.equal(down.includes('secret'), false);
});

test('metrics server ตอบเฉพาะ GET /metrics', async (t) => {
  const registry = new Registry();
  new PlatformWorkerMetrics(registry).claimsEnabled(true);
  const server = await startMetricsServer(registry, { port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ok = await fetch(`${base}/metrics`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('content-type') ?? '', /text\/plain/);
  assert.match(await ok.text(), /dcontact_platform_worker_claims_enabled 1/);
  assert.equal((await fetch(`${base}/`)).status, 404);
  assert.equal((await fetch(`${base}/metrics`, { method: 'POST' })).status, 404);
});
