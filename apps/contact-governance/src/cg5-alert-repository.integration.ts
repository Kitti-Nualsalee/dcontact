import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5AlertRepository } from './cg5-alert-repository.js';

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
      name: `CG5.6 ${tenantId}`,
      slug: `cg56-${tenantId}`,
      sipDomain: `${tenantId}.cg56.test`,
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

test('CG5.6 alert state, transition และ outbox ถูกเขียนครั้งเดียวโดยไม่แตะ Governance state', async (t) => {
  const f = await fixture(t);
  const repository = new Cg5AlertRepository(
    f.application,
    () => new Date('2026-09-20T00:00:00.000Z'),
  );
  const input = {
    tenantId: f.tenantId,
    ruleCode: 'CG5_PROJECTION_LAG' as const,
    scope: { channel: 'VOICE' as const, purpose: 'SUPPORT', teamId: null },
    state: 'OPEN' as const,
    severity: 'CRITICAL' as const,
    value: 301,
    threshold: 300,
  };
  const alert = await repository.record(input);
  assert.equal((await repository.record(input)).id, alert.id);
  const [transitions, outbox] = await Promise.all([
    f.owner.cg5AlertTransition.findMany({ where: { tenantId: f.tenantId } }),
    f.owner.cgEventOutbox.findMany({ where: { tenantId: f.tenantId } }),
  ]);
  assert.equal(transitions.length, 1);
  assert.equal(transitions[0]?.toState, 'OPEN');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]?.aggregateType, 'ALERT');
  assert.equal(outbox[0]?.eventType, 'governance.alert.changed');
  assert.equal(await f.owner.cg4Policy.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.cg4ExceptionHead.count({ where: { tenantId: f.tenantId } }), 0);
});

test('CG5.6 ACK ใช้ optimistic concurrency และไม่สร้าง event เมื่อ version เก่า', async (t) => {
  const f = await fixture(t);
  const repository = new Cg5AlertRepository(f.application);
  const alert = await repository.record({
    tenantId: f.tenantId,
    ruleCode: 'CG5_PROJECTION_LAG',
    scope: { channel: 'VOICE', purpose: 'SUPPORT', teamId: null },
    state: 'OPEN',
    severity: 'CRITICAL',
    value: 301,
    threshold: 300,
  });
  await repository.acknowledge({
    tenantId: f.tenantId,
    alertId: alert.id,
    expectedVersion: 1,
    actorRef: 'supervisor-1',
  });
  await assert.rejects(() =>
    repository.acknowledge({
      tenantId: f.tenantId,
      alertId: alert.id,
      expectedVersion: 1,
      actorRef: 'supervisor-2',
    }),
  );
  assert.equal(
    (
      await f.owner.cg5AlertState.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: f.tenantId, id: alert.id } },
      })
    ).state,
    'ACKED',
  );
  assert.equal(await f.owner.cgEventOutbox.count({ where: { tenantId: f.tenantId } }), 2);
});
