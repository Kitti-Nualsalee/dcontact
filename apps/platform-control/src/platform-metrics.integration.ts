/**
 * A1.8 (#413) on real Postgres: the PlatformHealthCollector queries run with role `dcontact_platform`,
 * normally completed work does not move any invariant, and each kind of violation is counted (measured as a delta — the DB is shared with other tests)
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

test('a normally completed request does not move any invariant; backlog and PENDING queue age reflect a new request', async (t) => {
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

test('invariant violations are counted: premature ACTIVE, readiness bypass and audit gap', async (t) => {
  const s = await setup(t);
  const accepted = await s.accept();
  const before = await s.read();
  // DB triggers already prevent both kinds — simulate the slip by bypassing the trigger (same as fixture cleanup)
  // to prove the metrics tripwire catches it even when the DB guard is circumvented
  await s.f.owner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    // the tenant was activated although the saga has not started (skipping readiness)
    await transaction.$executeRawUnsafe(
      `UPDATE tenants SET lifecycle_status = 'ACTIVE' WHERE id = $1::uuid`,
      accepted.tenantId,
    );
    // the audit of accepting the request is missing
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
