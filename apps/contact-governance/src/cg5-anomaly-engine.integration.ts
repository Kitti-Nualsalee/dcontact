import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5AnomalyEngine } from './cg5-anomaly-engine.js';

const NOW = new Date('2026-09-20T12:00:00.000Z');
async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  const tenantId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG5.6 engine ${tenantId}`,
      slug: `cg56-engine-${tenantId}`,
      sipDomain: `${tenantId}.cg56-engine.test`,
    },
  });
  t.after(async () => {
    await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
    await owner.cg5AlertTransition.deleteMany({ where: { tenantId } });
    await owner.cg5AlertState.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return { owner, application, tenantId };
}

test('CG5.6 ข้อมูลฐานไม่พอเปิด alert จริงและ suppress กฎเทียบฐานโดยไม่แตะ canonical', async (t) => {
  const f = await fixture(t);
  await new Cg5AnomalyEngine(f.application, () => NOW).evaluateTenant(f.tenantId);
  const alerts = await f.owner.cg5AlertState.findMany({ where: { tenantId: f.tenantId } });
  assert.equal(alerts.length, 10);
  assert.equal(alerts.find((row) => row.ruleCode === 'CG5_BASELINE_UNAVAILABLE')?.state, 'OPEN');
  assert.equal(alerts.find((row) => row.ruleCode === 'CG5_BLOCK_RATE_SHIFT')?.state, 'SUPPRESSED');
  assert.equal(await f.owner.cg4Policy.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.cg4ExceptionHead.count({ where: { tenantId: f.tenantId } }), 0);
});
