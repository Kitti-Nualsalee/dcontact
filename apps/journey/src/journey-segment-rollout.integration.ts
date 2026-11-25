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

/** walks to the desired stage one step at a time */
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

test('a tenant that was never enabled counts as DISABLED and cannot create effects yet', async (t) => {
  const f = await fixture(t);
  const view = await f.rollout.read(f.tenantId);
  assert.equal(view.stage, 'DISABLED');
  assert.equal(view.version, 0);
  assert.equal(await f.rollout.canEmitEffects(f.tenantId), false);
});

test('the stage moves forward one step at a time until fully enabled', async (t) => {
  const f = await fixture(t);
  const view = await advanceTo(f, 'SCOPED_INTERNAL_ENABLED');
  assert.equal(view.stage, 'SCOPED_INTERNAL_ENABLED');
  assert.ok(view.shadowStartedAt, 'it must record when shadow started');
  assert.ok(view.switchedAt, 'it must record when the switch happened');
  assert.equal(await f.rollout.canEmitEffects(f.tenantId), true);
});

test('stages cannot be skipped — shadow exists to see whether the computation matches Customer 360', async (t) => {
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

test('a stage cannot go backwards in either the code layer or the database', async (t) => {
  const f = await fixture(t);
  const enabled = await advanceTo(f, 'SCOPED_INTERNAL_ENABLED');

  // the code layer rejects first
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

  // and even a direct write into the database is still blocked by the trigger
  await assert.rejects(
    () =>
      f.owner.jrSegmentRolloutState.update({
        where: { tenantId: f.tenantId },
        data: { stage: 'SHADOW_MEMBERSHIP', version: { increment: 1 } },
      }),
    // Prisma escapes Thai in the error string, so match on the ASCII table name instead of the message
    /jr_segment_rollout_state/,
  );
});

test('a mismatched version is rejected — two operators cannot edit at the same time', async (t) => {
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

test('rollback is a freeze, not going back a stage, and it can be turned back on', async (t) => {
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
  assert.equal(frozen.stage, 'SCOPED_INTERNAL_ENABLED', 'freeze must not touch the stage');
  assert.equal(await f.rollout.canEmitEffects(f.tenantId), false, 'new effects must stop');

  const thawed = await f.rollout.setFrozen({
    tenantId: f.tenantId,
    frozen: false,
    expectedVersion: frozen.version,
    updatedByRef: 'operator:resolved',
  });
  assert.equal(thawed.mutationFrozen, false);
  assert.equal(
    await f.rollout.canEmitEffects(f.tenantId),
    true,
    'once fixed it can be turned back on',
  );
});

test('a shadow mismatch is recorded only when it does not match and is not recorded again every round', async (t) => {
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
    'once they match nothing needs to be recorded',
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

  // shadow goes round again and finds the same mismatch — must not bloat the report
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

test('a mismatch report keeps only a digest, no attribute values, and cannot be edited retroactively', async (t) => {
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
    assert.doesNotMatch(wire, new RegExp(forbidden, 'i'), `${forbidden} must not be in the report`);
  }

  // incident evidence must not be editable retroactively
  await assert.rejects(
    () =>
      f.owner.jrSegmentShadowMismatch.update({
        where: { id: row.id },
        data: { observedDigest: DIGEST_A },
      }),
    /jr_segment_shadow_mismatches|append-only/,
  );
});
