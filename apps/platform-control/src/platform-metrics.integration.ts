/**
 * A1.8 (#413) บน Postgres จริง: query ของ PlatformHealthCollector รันได้ด้วย role `dcontact_platform`,
 * งานที่จบปกติไม่ทำให้ invariant ขยับ และการละเมิดแต่ละแบบถูกนับ (วัดเป็นส่วนต่าง — DB ใช้ร่วมกับเทสต์อื่น)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Registry } from 'prom-client';
import { createPlatformFixture, OPERATOR, SIP_BASE } from './platform-fixture.js';
import { PlatformHealthCollector } from './platform-metrics.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import { ProvisioningSagaWorker } from './provisioning-saga.js';

async function setup(t: TestContext) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const tenants: string[] = [];
  const saga = new ProvisioningSagaWorker(f.platform, createFakeProvisioningPorts().ports, {
    workerId: `metrics-${randomUUID().slice(0, 8)}`,
    sipBaseDomain: SIP_BASE,
    scope: () => ({ tenantId: { in: [...tenants] } }),
    backoffBaseMs: 1,
    backoffMaxMs: 1,
  });
  const registry = new Registry();
  new PlatformHealthCollector(f.platform, registry, { minIntervalMs: 0 });
  const read = async () => {
    const text = await registry.metrics();
    assert.match(text, /dcontact_platform_health_scrape_success 1/, text);
    const value = (series: string) =>
      Number(new RegExp(`^${series.replace(/[{}"]/g, '\\$&')} (\\S+)$`, 'm').exec(text)?.[1]);
    return {
      invariant: (name: string) =>
        value(`dcontact_platform_invariant_violations{invariant="${name}"}`),
      age: (queue: string) => value(`dcontact_platform_oldest_age_seconds{queue="${queue}"}`),
      requests: (status: string) => value(`dcontact_platform_requests{status="${status}"}`) || 0,
    };
  };
  const accept = async () => {
    const key = `idem-${randomUUID()}`;
    const result = await f.repository().accept({
      idempotencyKey: key,
      input: f.input(),
      plan: f.plan,
      actor: OPERATOR,
      correlationId: `corr-${key}`,
    });
    f.track(result.tenantId);
    tenants.push(result.tenantId);
    return result;
  };
  return { f, saga, read, accept };
}

const INVARIANTS = [
  'premature_active',
  'readiness_bypass',
  'duplicate_ownership',
  'cross_tenant_reference',
  'audit_gap',
];

test('คำขอที่จบปกติไม่ทำให้ invariant ขยับ; backlog และอายุคิว PENDING สะท้อนคำขอใหม่', async (t) => {
  const s = await setup(t);
  const before = await s.read();
  const accepted = await s.accept();
  const pending = await s.read();
  assert.equal(pending.requests('PENDING'), before.requests('PENDING') + 1);
  assert.ok(pending.age('pending_request') >= 0);
  await s.saga.drain();
  assert.equal(
    (await s.f.owner.pfProvisioningRequest.findUniqueOrThrow({ where: { id: accepted.requestId } }))
      .status,
    'SUCCEEDED',
  );
  const after = await s.read();
  for (const invariant of INVARIANTS) {
    assert.equal(after.invariant(invariant), before.invariant(invariant), invariant);
  }
});

test('ละเมิด invariant แล้วถูกนับ: premature ACTIVE, readiness bypass และ audit gap', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const before = await s.read();
  // DB trigger กันทั้งสองแบบไว้แล้ว — จำลองการหลุดโดย bypass trigger (แบบเดียวกับ fixture cleanup)
  // เพื่อพิสูจน์ว่า tripwire ของ metrics จับได้แม้ guard ใน DB ถูกเลี่ยง
  await s.f.owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    // tenant ถูกเปิดทั้งที่ saga ยังไม่เริ่ม (ข้าม readiness)
    await transaction.$executeRawUnsafe(
      `UPDATE tenants SET lifecycle_status = 'ACTIVE' WHERE id = $1::uuid`,
      accepted.tenantId,
    );
    // audit ของการรับคำขอหาย
    await transaction.$executeRawUnsafe(
      `DELETE FROM pf_action_history WHERE request_id = $1::uuid AND action = 'REQUEST_ACCEPTED'`,
      accepted.requestId,
    );
  });
  const after = await s.read();
  assert.equal(after.invariant('premature_active'), before.invariant('premature_active') + 1);
  assert.equal(after.invariant('readiness_bypass'), before.invariant('readiness_bypass') + 1);
  assert.equal(after.invariant('audit_gap'), before.invariant('audit_gap') + 1);
});
