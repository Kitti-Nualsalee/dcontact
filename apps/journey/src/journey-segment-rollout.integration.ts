import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  JourneySegmentRollout,
  SegmentRolloutTransitionError,
  SegmentRolloutVersionConflictError,
  type SegmentRolloutStage,
} from './journey-segment-rollout.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

const FORWARD: SegmentRolloutStage[] = [
  'OWNER_BACKFILL',
  'SHADOW_MEMBERSHIP',
  'SHADOW_RECEIPT_REFILTER',
  'SCOPED_INTERNAL_ENABLED',
];

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
  const contactId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  t.after(async () => {
    await owner.jrSegmentShadowMismatch.deleteMany({ where: { tenantId } });
    await owner.jrSegmentRolloutState.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J3.10 rollout ${suffix}`,
      slug: `j3-10-rollout-${suffix}`,
      sipDomain: `${suffix}.j3-10-rollout.test`,
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId } });

  return {
    owner,
    tenantId,
    contactId,
    segmentId: `segment-gold-${suffix}`,
    rollout: new JourneySegmentRollout(application),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** เดินไปจนถึง stage ที่ต้องการทีละขั้น */
async function advanceTo(f: Fixture, target: SegmentRolloutStage) {
  let view = await f.rollout.read(f.tenantId);
  for (const stage of FORWARD) {
    view = await f.rollout.advance({
      tenantId: f.tenantId,
      to: stage,
      expectedVersion: view.version,
      updatedByRef: 'operator:test',
    });
    if (stage === target) break;
  }
  return view;
}

test('tenant ที่ไม่เคยเปิดถือว่า DISABLED และยังสร้าง effect ไม่ได้', async (t) => {
  const f = await fixture(t);
  const view = await f.rollout.read(f.tenantId);
  assert.equal(view.stage, 'DISABLED');
  assert.equal(view.version, 0);
  assert.equal(await f.rollout.canEmitEffects(f.tenantId), false);
});

test('stage เดินหน้าทีละขั้นจนเปิดเต็มรูปแบบ', async (t) => {
  const f = await fixture(t);
  const view = await advanceTo(f, 'SCOPED_INTERNAL_ENABLED');
  assert.equal(view.stage, 'SCOPED_INTERNAL_ENABLED');
  assert.ok(view.shadowStartedAt, 'ต้องบันทึกว่าเริ่ม shadow เมื่อไร');
  assert.ok(view.switchedAt, 'ต้องบันทึกว่าสลับเมื่อไร');
  assert.equal(await f.rollout.canEmitEffects(f.tenantId), true);
});

test('ข้ามขั้นไม่ได้ — shadow มีไว้เพื่อดูว่าคำนวณตรงกับ Customer 360 ไหม', async (t) => {
  const f = await fixture(t);
  const backfill = await advanceTo(f, 'OWNER_BACKFILL');

  await assert.rejects(
    () =>
      f.rollout.advance({
        tenantId: f.tenantId,
        to: 'SCOPED_INTERNAL_ENABLED',
        expectedVersion: backfill.version,
        updatedByRef: 'operator:test',
      }),
    (error: unknown) => {
      assert.ok(error instanceof SegmentRolloutTransitionError);
      assert.equal(error.from, 'OWNER_BACKFILL');
      return true;
    },
  );
  assert.equal((await f.rollout.read(f.tenantId)).stage, 'OWNER_BACKFILL');
});

test('ย้อน stage ไม่ได้ทั้งที่ชั้นโค้ดและที่ฐานข้อมูล', async (t) => {
  const f = await fixture(t);
  const enabled = await advanceTo(f, 'SCOPED_INTERNAL_ENABLED');

  // ชั้นโค้ดปฏิเสธก่อน
  await assert.rejects(
    () =>
      f.rollout.advance({
        tenantId: f.tenantId,
        to: 'SHADOW_MEMBERSHIP',
        expectedVersion: enabled.version,
        updatedByRef: 'operator:test',
      }),
    SegmentRolloutTransitionError,
  );

  // และถึงจะเขียนตรงเข้าฐานข้อมูล trigger ก็ยังกัน
  await assert.rejects(
    () =>
      f.owner.jrSegmentRolloutState.update({
        where: { tenantId: f.tenantId },
        data: { stage: 'SHADOW_MEMBERSHIP', version: { increment: 1 } },
      }),
    // Prisma escape ภาษาไทยใน error string จึงจับด้วยชื่อตารางที่เป็น ASCII แทนข้อความ
    /jr_segment_rollout_state/,
  );
});

test('version ที่ไม่ตรงถูกปฏิเสธ — operator สองคนแก้พร้อมกันไม่ได้', async (t) => {
  const f = await fixture(t);
  const view = await advanceTo(f, 'OWNER_BACKFILL');

  await assert.rejects(
    () =>
      f.rollout.advance({
        tenantId: f.tenantId,
        to: 'SHADOW_MEMBERSHIP',
        expectedVersion: view.version - 1,
        updatedByRef: 'operator:stale',
      }),
    (error: unknown) => {
      assert.ok(error instanceof SegmentRolloutVersionConflictError);
      assert.equal(error.actualVersion, view.version);
      return true;
    },
  );
});

test('rollback คือ freeze ไม่ใช่ย้อน stage และเปิดกลับได้', async (t) => {
  const f = await fixture(t);
  const enabled = await advanceTo(f, 'SCOPED_INTERNAL_ENABLED');
  assert.equal(await f.rollout.canEmitEffects(f.tenantId), true);

  const frozen = await f.rollout.setFrozen({
    tenantId: f.tenantId,
    frozen: true,
    expectedVersion: enabled.version,
    updatedByRef: 'operator:incident',
  });
  assert.equal(frozen.mutationFrozen, true);
  assert.equal(frozen.stage, 'SCOPED_INTERNAL_ENABLED', 'freeze ต้องไม่แตะ stage');
  assert.equal(await f.rollout.canEmitEffects(f.tenantId), false, 'effect ใหม่ต้องหยุด');

  const thawed = await f.rollout.setFrozen({
    tenantId: f.tenantId,
    frozen: false,
    expectedVersion: frozen.version,
    updatedByRef: 'operator:resolved',
  });
  assert.equal(thawed.mutationFrozen, false);
  assert.equal(await f.rollout.canEmitEffects(f.tenantId), true, 'แก้เสร็จแล้วเปิดกลับได้');
});

test('shadow mismatch บันทึกเฉพาะตอนไม่ตรง และไม่บันทึกซ้ำทุกรอบ', async (t) => {
  const f = await fixture(t);
  await advanceTo(f, 'SHADOW_MEMBERSHIP');

  const matched = await f.rollout.recordMismatch({
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: 1,
    expectedDigest: DIGEST_A,
    observedDigest: DIGEST_A,
  });
  assert.equal(matched, 'MATCHED');
  assert.equal(
    await f.owner.jrSegmentShadowMismatch.count({ where: { tenantId: f.tenantId } }),
    0,
    'ตรงกันแล้วไม่ต้องบันทึกอะไร',
  );

  const first = await f.rollout.recordMismatch({
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: 2,
    expectedDigest: DIGEST_A,
    observedDigest: DIGEST_B,
  });
  assert.equal(first, 'RECORDED');

  // shadow วนรอบอีกครั้งเจอ mismatch เดิม — ต้องไม่ทำให้รายงานบวม
  const again = await f.rollout.recordMismatch({
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: 2,
    expectedDigest: DIGEST_A,
    observedDigest: DIGEST_B,
  });
  assert.equal(again, 'DUPLICATE');
  assert.equal(await f.owner.jrSegmentShadowMismatch.count({ where: { tenantId: f.tenantId } }), 1);
});

test('mismatch report เก็บได้แค่ digest ไม่มีค่า attribute และแก้ย้อนหลังไม่ได้', async (t) => {
  const f = await fixture(t);
  await advanceTo(f, 'SHADOW_MEMBERSHIP');
  await f.rollout.recordMismatch({
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId: f.segmentId,
    membershipRevision: 3,
    expectedDigest: DIGEST_A,
    observedDigest: DIGEST_B,
  });

  const row = await f.owner.jrSegmentShadowMismatch.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(row.expectedDigest, DIGEST_A);
  assert.equal(row.mismatchKind, 'STATE_DIGEST');
  const wire = JSON.stringify(row);
  for (const forbidden of ['attributes', 'tier', 'phone', 'email', 'payload']) {
    assert.doesNotMatch(wire, new RegExp(forbidden, 'i'), `${forbidden} ต้องไม่อยู่ใน report`);
  }

  // หลักฐานของ incident ต้องแก้ย้อนหลังไม่ได้
  await assert.rejects(
    () =>
      f.owner.jrSegmentShadowMismatch.update({
        where: { id: row.id },
        data: { observedDigest: DIGEST_A },
      }),
    /jr_segment_shadow_mismatches|append-only/,
  );
});
