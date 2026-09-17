/**
 * J2.9 (#137) — rollout gate ของ originate barrier ต้อง durable: แชร์ข้าม instance, อยู่รอดหลัง restart,
 * maker-checker จริง, kill ยกเลิกไม่ได้ และ audit เป็น append-only — ทั้งในโค้ดและที่ฐานข้อมูล
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  DialerGateAuthorizationError,
  DialerGateInvalidTransitionError,
  DialerGateSelfApprovalError,
  DialerOwnerBarrierGate,
} from './dialer-owner-barrier-gate.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

const admin = { role: 'TENANT_ADMIN' as const, ref: 'admin-1' };
const compliance = { role: 'COMPLIANCE' as const, ref: 'compliance-1' };
const operator = { role: 'PLATFORM_OPERATOR' as const, ref: 'operator-1' };

async function tenant(owner: PrismaClient, t: TestContext) {
  const tenantId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.9 gate ${tenantId.slice(0, 8)}`,
      slug: `j2-9-gate-${tenantId.slice(0, 8)}`,
      sipDomain: `${tenantId.slice(0, 8)}.j2-9-gate.test`,
    },
  });
  t.after(async () => {
    await owner.obOriginateRolloutAudit.deleteMany({ where: { tenantId } });
    await owner.obOriginateRolloutScope.deleteMany({ where: { tenantId } });
    await owner.obOriginateRollout.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
  });
  return tenantId;
}

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  t.after(() => Promise.all([owner.$disconnect(), application.$disconnect()]));
  const tenantId = await tenant(owner, t);
  return { owner, application, tenantId, gate: new DialerOwnerBarrierGate(application) };
}

test('gate เริ่มที่ DISABLED และเลื่อนได้ทีละขั้นผ่าน maker-checker ที่เป็นคนละคน', async (t) => {
  const f = await fixture(t);
  assert.equal(await f.gate.currentState(f.tenantId), 'DISABLED');

  for (const state of ['SHADOW_RECEIPT', 'OWNER_CONFORMANCE', 'SCOPED_INTERNAL_ENABLED'] as const) {
    await f.gate.propose(f.tenantId, admin, state);
    assert.notEqual(
      await f.gate.currentState(f.tenantId),
      state,
      'propose ยังไม่มีผลจนกว่าจะอนุมัติ',
    );
    await f.gate.approve(f.tenantId, compliance);
    assert.equal(await f.gate.currentState(f.tenantId), state);
  }

  const audit = await f.gate.auditFor(f.tenantId);
  assert.deepEqual(
    audit.map(({ action, actorRef }) => `${action}:${actorRef}`),
    [
      'PROPOSE:admin-1',
      'APPROVE:compliance-1',
      'PROPOSE:admin-1',
      'APPROVE:compliance-1',
      'PROPOSE:admin-1',
      'APPROVE:compliance-1',
    ],
  );
});

test('ข้ามขั้น, role ไม่ตรง และอนุมัติคำเสนอของตัวเองถูกปฏิเสธ', async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    () => f.gate.propose(f.tenantId, admin, 'OWNER_CONFORMANCE'),
    DialerGateInvalidTransitionError,
  );
  await assert.rejects(
    () => f.gate.propose(f.tenantId, compliance, 'SHADOW_RECEIPT'),
    DialerGateAuthorizationError,
  );
  await f.gate.propose(f.tenantId, admin, 'SHADOW_RECEIPT');
  await assert.rejects(() => f.gate.approve(f.tenantId, admin), DialerGateAuthorizationError);
  await assert.rejects(
    () => f.gate.approve(f.tenantId, { role: 'COMPLIANCE', ref: admin.ref }),
    DialerGateSelfApprovalError,
  );
  await assert.rejects(
    () => f.gate.allowScope(f.tenantId, admin, 'CAMPAIGN', randomUUID()),
    DialerGateAuthorizationError,
  );
  assert.equal(await f.gate.currentState(f.tenantId), 'DISABLED');
});

test('kill บน instance หนึ่งมีผลกับทุก instance, อยู่รอดหลัง restart และยกเลิกไม่ได้', async (t) => {
  const f = await fixture(t);
  await f.gate.propose(f.tenantId, admin, 'SHADOW_RECEIPT');
  await f.gate.approve(f.tenantId, compliance);

  await new DialerOwnerBarrierGate(f.application).kill(
    f.tenantId,
    operator,
    'PROVIDER_TRAFFIC_DETECTED',
  );
  // kill ซ้ำด้วย trigger อื่นไม่เขียนทับเหตุแรก
  await f.gate.systemKill(f.tenantId, 'RESERVATION_REUSE');

  // client ใหม่ทั้งตัว = process ที่เพิ่ง restart
  const restarted = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  t.after(() => restarted.$disconnect());
  const afterRestart = new DialerOwnerBarrierGate(restarted);
  assert.equal(await afterRestart.currentState(f.tenantId), 'KILLED');
  assert.equal(await afterRestart.killTriggerFor(f.tenantId), 'PROVIDER_TRAFFIC_DETECTED');
  await assert.rejects(
    () => afterRestart.propose(f.tenantId, admin, 'OWNER_CONFORMANCE'),
    DialerGateInvalidTransitionError,
  );
  await assert.rejects(
    () => f.gate.kill(f.tenantId, admin, 'SCOPE_BYPASS'),
    DialerGateAuthorizationError,
  );

  // ฐานข้อมูลปฏิเสธการยก kill แม้เขียนตรงด้วย application role
  await assert.rejects(() =>
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.obOriginateRollout.update({
        where: { tenantId: f.tenantId },
        data: { killed: false, killTrigger: null, killedAt: null, version: { increment: 1 } },
      }),
    ),
  );
  const audit = await afterRestart.auditFor(f.tenantId);
  assert.deepEqual(
    audit.filter(({ action }) => action === 'KILL').map(({ detail }) => detail),
    ['PROVIDER_TRAFFIC_DETECTED', 'SYSTEM:RESERVATION_REUSE'],
  );
});

test('ฐานข้อมูลบังคับ state เดินหน้าทีละขั้น และ audit แก้ย้อนหลังหรือลบไม่ได้', async (t) => {
  const f = await fixture(t);
  await f.gate.propose(f.tenantId, admin, 'SHADOW_RECEIPT');
  await f.gate.approve(f.tenantId, compliance);

  const write = (data: Record<string, unknown>) =>
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.obOriginateRollout.update({
        where: { tenantId: f.tenantId },
        data: { ...data, version: { increment: 1 } },
      }),
    );
  await assert.rejects(() => write({ state: 'DISABLED' }), 'ย้อน state ไม่ได้');
  await assert.rejects(() => write({ state: 'SCOPED_INTERNAL_ENABLED' }), 'ข้ามขั้นไม่ได้');

  await assert.rejects(() =>
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.obOriginateRolloutAudit.updateMany({
        where: { tenantId: f.tenantId },
        data: { detail: 'rewritten' },
      }),
    ),
  );
  await assert.rejects(() =>
    withTenantDatabaseTransaction(f.application, f.tenantId, (transaction) =>
      transaction.obOriginateRolloutAudit.deleteMany({ where: { tenantId: f.tenantId } }),
    ),
  );
  assert.equal((await f.gate.auditFor(f.tenantId)).length, 2);
});

test('state, allowlist และ audit แยกต่อ tenant', async (t) => {
  const f = await fixture(t);
  const other = await tenant(f.owner, t);
  const campaignId = randomUUID();

  await f.gate.propose(f.tenantId, admin, 'SHADOW_RECEIPT');
  await f.gate.approve(f.tenantId, compliance);
  await f.gate.allowScope(f.tenantId, compliance, 'CAMPAIGN', campaignId);
  await f.gate.kill(f.tenantId, compliance, 'CROSS_TENANT_LEAK');

  assert.equal(await f.gate.currentState(other), 'DISABLED');
  assert.equal(await f.gate.isScopeAllowed(other, 'CAMPAIGN', campaignId), false);
  assert.equal(await f.gate.isScopeAllowed(f.tenantId, 'CAMPAIGN', campaignId), true);
  assert.deepEqual(await f.gate.auditFor(other), []);
  // RLS: context ของ tenant อื่นมองไม่เห็นแถวของ tenant นี้
  const leaked = await withTenantDatabaseTransaction(f.application, other, (transaction) =>
    transaction.obOriginateRollout.count({ where: { tenantId: f.tenantId } }),
  );
  assert.equal(leaked, 0);
});

test('allowlist: Compliance เพิ่ม scope ได้ Platform Operator ถอนได้ทันที', async (t) => {
  const f = await fixture(t);
  const queueId = randomUUID();

  await f.gate.allowScope(f.tenantId, compliance, 'CALLBACK_QUEUE', queueId);
  await f.gate.allowScope(f.tenantId, compliance, 'CALLBACK_QUEUE', queueId);
  assert.equal(await f.gate.isScopeAllowed(f.tenantId, 'CALLBACK_QUEUE', queueId), true);
  assert.equal(await f.gate.isScopeAllowed(f.tenantId, 'CAMPAIGN', queueId), false);

  await f.gate.revokeScope(f.tenantId, operator, 'CALLBACK_QUEUE', queueId);
  assert.equal(await f.gate.isScopeAllowed(f.tenantId, 'CALLBACK_QUEUE', queueId), false);
  assert.deepEqual(
    (await f.gate.auditFor(f.tenantId)).map(({ action }) => action),
    ['SCOPE_ALLOW', 'SCOPE_ALLOW', 'SCOPE_REVOKE'],
  );
});
