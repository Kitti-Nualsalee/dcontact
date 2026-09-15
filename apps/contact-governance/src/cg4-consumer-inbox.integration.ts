import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg4ConsumerInbox, cg4ScopeRefFor, type Cg4InboundEvent } from './cg4-consumer-inbox.js';

/**
 * CG4.6 (#189): the inbox and scope-pause behaviour from #179 §4, driven through the
 * application role so RLS and the append-only grants are part of what is asserted.
 */

const NOW = new Date('2026-01-05T12:00:00.000Z');
const GROUP = 'cg4-test-consumer-v1';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

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
  const tenant = randomUUID();

  t.after(async () => {
    await owner.cgScopePause.deleteMany({ where: { tenantId: tenant } });
    await owner.cgConsumerInbox.deleteMany({ where: { tenantId: tenant } });
    await owner.tenant.deleteMany({ where: { id: tenant } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenant,
      name: `CG4.6 ${tenant}`,
      slug: `cg46-${tenant}`,
      sipDomain: `${tenant}.cg46.test`,
    },
  });

  return {
    owner,
    tenant,
    contactId: randomUUID(),
    inbox: new Cg4ConsumerInbox(application, GROUP, { now: () => NOW }),
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    mutationId: randomUUID(),
    transitionKind: 'EXCEPTION_APPROVED',
    subjectId: randomUUID(),
    subjectVersion: 1,
    state: 'APPROVED',
    effectiveAt: NOW.toISOString(),
    affectedScope: { scopeKey: 'channel=VOICE|contactKind=*|purpose=*|sourceType=*' },
    scopeDigest: 'c'.repeat(64),
    ruleRegistryVersion: 'CG4_RULE_REGISTRY_V1',
    policySchemaVersion: 1,
    evaluatorVersion: 'CG4_EVALUATOR_V1',
    stateDigest: 'd'.repeat(64),
    restrictiveness: 'RELAXATION',
    ...overrides,
  };
}

function event(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Cg4InboundEvent> = {},
): Cg4InboundEvent {
  return {
    tenantId: f.tenant,
    eventId: randomUUID(),
    eventType: 'exception.changed',
    aggregateType: 'CONTACT',
    aggregateId: f.contactId,
    aggregateVersion: 1,
    payloadHash: HASH_A,
    payload: payload(),
    receivedAt: NOW,
    ...overrides,
  };
}

test('event ที่ต่อเนื่องกัน apply ได้และเดิน cursor โดยไม่ pause scope', async (t) => {
  const f = await fixture(t);
  const first = await f.inbox.record(event(f, { aggregateVersion: 1, payloadHash: HASH_A }));
  const second = await f.inbox.record(event(f, { aggregateVersion: 2, payloadHash: HASH_B }));
  assert.equal(first.decision.kind, 'APPLY');
  assert.equal(second.decision.kind, 'APPLY');
  assert.equal(second.applied, true);
  assert.equal(await f.inbox.isPaused(f.tenant, { kind: 'CONTACT', ref: f.contactId }), false);
  assert.equal(
    await f.owner.cgConsumerInbox.count({ where: { tenantId: f.tenant, state: 'APPLIED' } }),
    2,
  );
});

test('redelivery ของ eventId เดิมเป็น duplicate โดยไม่แตะ cursor และไม่ pause', async (t) => {
  const f = await fixture(t);
  const original = event(f, { aggregateVersion: 1 });
  await f.inbox.record(original);
  const replay = await f.inbox.record(original);
  assert.equal(replay.decision.kind, 'DUPLICATE');
  assert.equal(replay.recorded, false);
  assert.equal(replay.applied, true);
  // ต้องยัง apply version ถัดไปได้ตามปกติ
  const next = await f.inbox.record(event(f, { aggregateVersion: 2, payloadHash: HASH_B }));
  assert.equal(next.decision.kind, 'APPLY');
  assert.equal(await f.inbox.isPaused(f.tenant, { kind: 'CONTACT', ref: f.contactId }), false);
});

test('version ที่ข้ามไป pause scope ไว้ และ reload canonical เท่านั้นที่ปลดได้', async (t) => {
  const f = await fixture(t);
  await f.inbox.record(event(f, { aggregateVersion: 1 }));
  const gap = await f.inbox.record(event(f, { aggregateVersion: 5, payloadHash: HASH_B }));
  assert.equal(gap.decision.kind, 'GAP');
  assert.ok(gap.pauseId);
  assert.equal(await f.inbox.isPaused(f.tenant, { kind: 'CONTACT', ref: f.contactId }), true);

  const pause = await f.owner.cgScopePause.findFirstOrThrow({ where: { id: gap.pauseId } });
  assert.equal(pause.reason, 'EVENT_GAP');
  assert.equal(pause.expectedVersion, 2);
  assert.equal(pause.observedVersion, 5);

  const resumed = await f.inbox.resumeFromCanonical({
    tenantId: f.tenant,
    scope: { kind: 'CONTACT', ref: f.contactId },
    aggregateType: 'CONTACT',
    aggregateId: f.contactId,
    canonicalVersion: 5,
    canonicalDigest: HASH_B,
    eventType: 'exception.changed',
  });
  assert.equal(resumed.cleared, 1);
  assert.equal(await f.inbox.isPaused(f.tenant, { kind: 'CONTACT', ref: f.contactId }), false);

  // cursor ต้องกระโดดไปที่ 5 แล้ว ไม่งั้น event ถัดไปจะ pause ซ้ำทันที
  const next = await f.inbox.record(event(f, { aggregateVersion: 6, payloadHash: HASH_A }));
  assert.equal(next.decision.kind, 'APPLY');
});

test('version เดิมแต่ digest ต่างถูก quarantine และ pause ด้วย HASH_CONFLICT', async (t) => {
  const f = await fixture(t);
  await f.inbox.record(event(f, { aggregateVersion: 1, payloadHash: HASH_A }));
  const conflict = await f.inbox.record(event(f, { aggregateVersion: 1, payloadHash: HASH_B }));
  assert.equal(conflict.decision.kind, 'QUARANTINE');
  const pause = await f.owner.cgScopePause.findFirstOrThrow({ where: { id: conflict.pauseId } });
  assert.equal(pause.reason, 'HASH_CONFLICT');
  assert.equal(
    (await f.owner.cgConsumerInbox.findFirstOrThrow({ where: { id: conflict.inboxId } })).state,
    'QUARANTINED',
  );
});

test('event ที่ย้อนหลังด้วย eventId ใหม่ถือเป็น out-of-order และ pause scope', async (t) => {
  const f = await fixture(t);
  await f.inbox.record(event(f, { aggregateVersion: 1, payloadHash: HASH_A }));
  await f.inbox.record(event(f, { aggregateVersion: 2, payloadHash: HASH_B }));
  const stale = await f.inbox.record(event(f, { aggregateVersion: 1, payloadHash: HASH_A }));
  assert.equal(stale.decision.kind, 'OUT_OF_ORDER');
  const pause = await f.owner.cgScopePause.findFirstOrThrow({ where: { id: stale.pauseId } });
  assert.equal(pause.reason, 'EVENT_OUT_OF_ORDER');
});

test('contract version ที่ไม่รองรับถูกกักไว้เป็น UNSUPPORTED ไม่ใช่ apply', async (t) => {
  const f = await fixture(t);
  const unsupported = await f.inbox.record(
    event(f, { aggregateVersion: 1, payload: payload({ contractVersion: 99 }) }),
  );
  assert.equal(unsupported.decision.kind, 'UNSUPPORTED');
  assert.equal(unsupported.applied, false);
  const pause = await f.owner.cgScopePause.findFirstOrThrow({ where: { id: unsupported.pauseId } });
  assert.equal(pause.reason, 'UNSUPPORTED_CONTRACT');
});

test('anomaly ซ้ำบน scope เดิมไม่ซ้อน pause ใหม่ แต่ปรับ reason ของอันเดิม', async (t) => {
  const f = await fixture(t);
  await f.inbox.record(event(f, { aggregateVersion: 1 }));
  const gap = await f.inbox.record(event(f, { aggregateVersion: 4, payloadHash: HASH_B }));
  const conflict = await f.inbox.record(event(f, { aggregateVersion: 1, payloadHash: HASH_B }));
  assert.equal(gap.pauseId, conflict.pauseId);
  assert.equal(
    await f.owner.cgScopePause.count({ where: { tenantId: f.tenant, state: 'ACTIVE' } }),
    1,
  );
  const pause = await f.owner.cgScopePause.findFirstOrThrow({ where: { id: gap.pauseId } });
  assert.equal(pause.reason, 'HASH_CONFLICT');
});

test('policy event pause ที่ scopeKey ไม่ใช่ทั้ง policy series', async (t) => {
  const f = await fixture(t);
  const policyId = randomUUID();
  const scopeKey = 'channel=EMAIL|contactKind=*|purpose=BILLING|sourceType=*';
  const result = await f.inbox.record(
    event(f, {
      aggregateType: 'POLICY',
      aggregateId: policyId,
      aggregateVersion: 3,
      eventType: 'policy.changed',
      payload: payload({ affectedScope: { scopeKey }, transitionKind: 'POLICY_ACTIVATED' }),
    }),
  );
  assert.equal(result.decision.kind, 'GAP');
  const pause = await f.owner.cgScopePause.findFirstOrThrow({ where: { id: result.pauseId } });
  assert.equal(pause.scopeKind, 'POLICY_SCOPE');
  assert.equal(pause.scopeRef, scopeKey);
  assert.equal(await f.inbox.isPaused(f.tenant, { kind: 'POLICY_SCOPE', ref: scopeKey }), true);
  // scope อื่นของ tenant เดียวกันต้องไม่ถูกกักไปด้วย
  assert.equal(await f.inbox.isPaused(f.tenant, { kind: 'CONTACT', ref: f.contactId }), false);
});

test('scope ref ของ policy event ถอยไปใช้ aggregateId เมื่อ payload ไม่มี scopeKey', () => {
  assert.deepEqual(cg4ScopeRefFor({ aggregateType: 'POLICY', aggregateId: 'p1', payload: {} }), {
    kind: 'POLICY_SCOPE',
    ref: 'p1',
  });
  assert.deepEqual(
    cg4ScopeRefFor({
      aggregateType: 'CONTACT',
      aggregateId: 'c1',
      payload: { affectedScope: { scopeKey: 'x' } },
    }),
    { kind: 'CONTACT', ref: 'c1' },
  );
});

test('inbox เป็น append-only ผ่าน application role', async (t) => {
  const f = await fixture(t);
  const applied = await f.inbox.record(event(f, { aggregateVersion: 1 }));
  const application = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  t.after(() => application.$disconnect());
  await assert.rejects(
    application.$executeRawUnsafe(
      `UPDATE cg_consumer_inbox SET state = 'DUPLICATE' WHERE id = '${applied.inboxId}'`,
    ),
  );
  await assert.rejects(
    application.$executeRawUnsafe(`DELETE FROM cg_consumer_inbox WHERE id = '${applied.inboxId}'`),
  );
});
