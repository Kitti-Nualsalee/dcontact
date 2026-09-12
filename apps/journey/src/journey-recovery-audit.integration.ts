import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { JourneyRecoveryAuditLog } from './journey-recovery-audit.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.3 recovery audit ${suffix}`,
      slug: `j2-3-recovery-audit-${suffix}`,
      sipDomain: `${suffix}.j2-3-recovery-audit.test`,
    },
  });
  t.after(async () => {
    await owner.jrRecoveryAudit.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return { owner, application, tenantId };
}

test('record บันทึก manual recovery แบบ append-only และ findFor เรียงตามเวลา', async (t) => {
  const f = await fixture(t);
  const auditLog = new JourneyRecoveryAuditLog(f.application);
  const actorId = randomUUID();
  const actionKey = `enrollment-1:1:ensure-case`;

  await auditLog.record({
    tenantId: f.tenantId,
    operation: 'RECONCILE',
    targetKind: 'ACTION',
    targetRef: actionKey,
    reasonCode: 'ACK_UNKNOWN_TIMEOUT',
    actorId,
    evidenceRef: 'evidence-1',
  });
  await auditLog.record({
    tenantId: f.tenantId,
    operation: 'CANCEL',
    targetKind: 'ACTION',
    targetRef: actionKey,
    reasonCode: 'MANUAL_CANCEL',
    actorId,
  });

  const history = await auditLog.findFor(f.tenantId, 'ACTION', actionKey);
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((entry) => entry.operation),
    ['RECONCILE', 'CANCEL'],
  );
  assert.equal(history[0]?.evidenceRef, 'evidence-1');
  assert.equal(await f.owner.jrRecoveryAudit.count({ where: { tenantId: f.tenantId } }), 2);
});

test('tenant คนละใบไม่เห็น recovery audit ของกันและกัน', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const auditLog = new JourneyRecoveryAuditLog(a.application);
  const otherAuditLog = new JourneyRecoveryAuditLog(b.application);
  const targetRef = 'shared-looking-action-key';

  await auditLog.record({
    tenantId: a.tenantId,
    operation: 'REPLAY',
    targetKind: 'RECEIPT',
    targetRef,
    reasonCode: 'MANUAL_REPLAY',
    actorId: randomUUID(),
  });

  const otherView = await otherAuditLog.findFor(b.tenantId, 'RECEIPT', targetRef);
  assert.deepEqual(otherView, []);
});
