import { teamWriterRace } from '@d-contact/db/testing/team-reference-races.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5AlertRepository, Cg5AlertVersionConflictError } from './cg5-alert-repository.js';

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
    await owner.team.deleteMany({ where: { tenantId } });
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
  await assert.rejects(
    () =>
      repository.acknowledge({
        tenantId: f.tenantId,
        alertId: alert.id,
        expectedVersion: 1,
        actorRef: 'supervisor-2',
      }),
    (error: unknown) => {
      assert.ok(error instanceof Cg5AlertVersionConflictError);
      assert.equal(error.expectedVersion, 1);
      assert.equal(error.actualVersion, 2);
      return true;
    },
  );
  assert.equal(
    (
      await f.owner.cg5AlertState.findUniqueOrThrow({
        where: { tenantId_id: { tenantId: f.tenantId, id: alert.id } },
      })
    ).state,
    'ACKED',
  );
  const [transition, outbox] = await Promise.all([
    f.owner.cg5AlertTransition.findFirstOrThrow({
      where: { tenantId: f.tenantId, alertId: alert.id, toState: 'ACKED' },
    }),
    f.owner.cgEventOutbox.findFirstOrThrow({
      where: { tenantId: f.tenantId, aggregateId: alert.id, aggregateVersion: 2 },
    }),
  ]);
  assert.match(transition.evidenceRef, /^cg5-alert-ack:CG5_PROJECTION_LAG:[a-f0-9]{64}$/);
  assert.equal(outbox.orderingKey, `${f.tenantId}:${alert.id}`);
});

for (const order of ['writer-first', 'deactivate-first'] as const)
  test(`Core Team fence: actual CG alert opening ${order}`, async (t) => {
    const f = await fixture(t);
    const teamId = randomUUID();
    await f.owner.team.create({ data: { id: teamId, tenantId: f.tenantId, name: 'Alert writer' } });
    const repository = new Cg5AlertRepository(f.application);
    await teamWriterRace({
      owner: f.owner,
      tenantId: f.tenantId,
      teamId,
      table: 'cg5_alert_state',
      order,
      write: () =>
        repository.record({
          tenantId: f.tenantId,
          ruleCode: 'CG5_PROJECTION_LAG',
          scope: { channel: 'VOICE', purpose: 'SUPPORT', teamId },
          state: 'OPEN',
          severity: 'CRITICAL',
          value: 301,
          threshold: 300,
        }),
    });
  });

for (const operation of ['ack', 'resolve', 'reopen'] as const)
  for (const order of ['writer-first', 'deactivate-first'] as const)
    test(`Core Team fence: actual alert ${operation} ${order}`, async (t) => {
      const f = await fixture(t);
      const teamId = randomUUID();
      await f.owner.team.create({
        data: { id: teamId, tenantId: f.tenantId, name: 'Alert transitions' },
      });
      const repository = new Cg5AlertRepository(f.application);
      const input = {
        tenantId: f.tenantId,
        ruleCode: 'CG5_PROJECTION_LAG' as const,
        scope: { channel: 'VOICE' as const, purpose: 'SUPPORT', teamId },
        severity: 'CRITICAL' as const,
        value: 301,
        threshold: 300,
      };
      const alert = await repository.record({
        ...input,
        state: operation === 'reopen' ? 'RESOLVED' : 'OPEN',
      });
      await teamWriterRace({
        owner: f.owner,
        tenantId: f.tenantId,
        teamId,
        table: 'cg5_alert_state',
        order,
        existingReferences: operation !== 'reopen',
        write: () =>
          operation === 'ack'
            ? repository.acknowledge({
                tenantId: f.tenantId,
                alertId: alert.id,
                expectedVersion: alert.version,
                actorRef: 'isolated-operator',
              })
            : repository.record({ ...input, state: operation === 'resolve' ? 'RESOLVED' : 'OPEN' }),
      });
    });
