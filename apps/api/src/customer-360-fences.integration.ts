import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  C360MembershipRepositoryError,
  C360ProfileCommandError,
  fenceC360ContactMutation,
  type C360ContactAccess,
  type C360VerifiedActor,
} from '@d-contact/customer-360';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import {
  activeHead,
  deliverToIam,
  grantCustodian,
  ownerCommit,
  setup,
  type Fixture,
} from './customer-360-test-fixtures.js';

/**
 * Cus360 C1 (#791) S4: owner fences per E1 G racing against the actual owner writers in both orders
 *
 * order 1: Cus360 holds the fence, then an owner writer starts
 * order 2: an owner writer is stopped mid-transaction (a trigger barrier after taking the lock), then Cus360 starts
 * check the final DB state/revisions, not only the status, and that there is no unsafe ALLOW or tenant-wide exclusive lock
 */

function actor(f: Fixture, token: 'admin' | 'supervisor'): C360VerifiedActor {
  return {
    tenantId: f.tenantId,
    userId: f.actors.get(token)!.id,
    role: token === 'admin' ? 'ADMIN' : 'SUPERVISOR',
    teamId: f.teamId,
  };
}

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

/** opens a Cus360 transaction that holds the fence until released */
async function holdFence(f: Fixture, who: C360VerifiedActor, contactIds: string[]) {
  const ready = gate();
  const release = gate();
  let access: Map<string, C360ContactAccess> | undefined;
  let pid = 0;
  const done = withTenantDatabaseTransaction(
    f.db,
    f.tenantId,
    async (tx) => {
      access = await fenceC360ContactMutation(tx, who, contactIds);
      pid = (await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`)[0]!.pid;
      ready.open();
      await release.promise;
    },
    { timeout: 15000 },
  );
  done.catch(() => ready.open());
  await ready.promise;
  assert.ok(access, 'Cus360 must get the fence before the owner writer starts');
  return {
    access,
    pid,
    async release() {
      release.open();
      await done;
    },
  };
}

const fence = (f: Fixture, who: C360VerifiedActor, contactIds: string[]) =>
  withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
    fenceC360ContactMutation(tx, who, contactIds),
  );

const isBusy = (error: unknown) =>
  error instanceof C360ProfileCommandError && error.code === 'RESOURCE_BUSY' && error.retryable;

/** checks that a session really is blocked by `blocker` (the owner writer cannot wait on the fence, not merely slow) */
async function waitUntilBlocked(f: Fixture, blocker: number, settled: () => boolean) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline && !settled()) {
    const [row] = await f.owner.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE ${blocker}::int = ANY (pg_blocking_pids(pid))) AS waiting`;
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the owner writer must wait for the Cus360 fence but did not wait');
}

/**
 * stops the actual owner writer after the first INSERT/UPDATE of a row of the table in this tenant (after taking the fences)
 * then runs `during` while the writer still holds the lock
 */
async function pausedWriter<T>(
  f: Fixture,
  table: string,
  writer: () => Promise<T>,
  during: (writerPid: number) => Promise<void>,
): Promise<T> {
  const suffix = randomUUID().replaceAll('-', '');
  const fn = `c360_test_pause_${suffix}`;
  const trigger = `zz_c360_test_pause_${suffix}`;
  const barrier = randomInt(1_000_000, 1_000_000_000);
  // identifiers/literals are all built in the test (validated UUIDs and random integers), with no external input
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION public.${fn}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.tenant_id='${f.tenantId}'::uuid THEN PERFORM set_config('lock_timeout','10s',true); PERFORM pg_advisory_xact_lock(${barrier}::bigint); END IF; RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER ${trigger} AFTER INSERT OR UPDATE ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}()`,
  );
  const ready = gate();
  const release = gate();
  const holder = f.owner.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1::bigint)', barrier);
      ready.open();
      await release.promise;
    },
    { timeout: 20000 },
  );
  try {
    await ready.promise;
    let settled = false;
    const running = writer().finally(() => (settled = true));
    running.catch(() => undefined);
    const deadline = performance.now() + 3000;
    let writerPid = 0;
    for (;;) {
      const [row] = await f.owner.$queryRaw<{ pid: number | null }[]>`
        SELECT (SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND classid = 0
          AND objid = ${barrier}::bigint::oid AND NOT granted LIMIT 1) AS pid`;
      if (row?.pid) {
        writerPid = row.pid;
        break;
      }
      if (settled) return await running;
      if (performance.now() > deadline)
        assert.fail(`the writer did not reach the barrier of ${table}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await during(writerPid);
    release.open();
    await holder;
    return await running;
  } finally {
    release.open();
    await holder.catch(() => undefined);
    await f.owner.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${trigger} ON public.${table}`);
    await f.owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.${fn}()`);
  }
}

async function contact(f: Fixture, name: string) {
  const id = randomUUID();
  await f.owner.contact.create({ data: { id, tenantId: f.tenantId, displayName: name } });
  return id;
}

let commandSequence = 0;
const merge = (f: Fixture, sourceContactId: string, targetContactId: string, expected = 0) =>
  f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: `identity:${randomUUID()}`,
    operation: 'MERGE',
    sourceContactId,
    targetContactId,
    expectedSourceLineageRevision: expected,
    correlationId: `c1-s4-merge-${(commandSequence += 1)}`,
  });

const identityHead = (f: Fixture, contactId: string) =>
  f.owner.c360IdentityHead.findUniqueOrThrow({
    where: { tenantId_contactId: { tenantId: f.tenantId, contactId } },
  });

const membershipHead = (f: Fixture, contactId = f.contactId) =>
  f.owner.c360SegmentMembershipHead.findUnique({
    where: {
      tenantId_contactId_segmentId: { tenantId: f.tenantId, contactId, segmentId: f.segmentId },
    },
  });

test('S4: canonical MERGE with the Cus360 identity fence in both orders; other contacts are not locked tenant-wide', async () => {
  const f = await setup();
  try {
    await grantCustodian(f, 'admin', 'MANAGE');
    await activeHead(f);
    const target = await contact(f, 'Target');
    const admin = actor(f, 'admin');

    // order 1: Cus360 holds the shared identity fence → the canonical writer gets RESOURCE_BUSY and writes nothing
    const held = await holdFence(f, admin, [f.contactId]);
    assert.deepEqual(held.access.get(f.contactId), {
      decision: 'ALLOW',
      read: true,
      manage: true,
      basis: 'CUSTODIAN_MANAGE',
      identity: 'ACTIVE',
    });
    const otherSource = await contact(f, 'Unrelated A');
    const otherTarget = await contact(f, 'Unrelated B');
    try {
      await assert.rejects(
        merge(f, f.contactId, target),
        (error) => error instanceof C360MembershipRepositoryError && error.code === 'RESOURCE_BUSY',
      );
      assert.equal(await f.owner.c360IdentityLineage.count({ where: { tenantId: f.tenantId } }), 0);
      assert.equal((await identityHead(f, f.contactId)).state, 'ACTIVE');
      // no tenant-wide exclusive lock: transitions of another pair of contacts pass meanwhile
      await merge(f, otherSource, otherTarget);
    } finally {
      await held.release();
    }
    const merged = await merge(f, f.contactId, target);
    assert.equal(merged.lineageRevision, 1);
    assert.equal((await identityHead(f, f.contactId)).state, 'MERGED');
    const after = await fence(f, admin, [f.contactId]);
    assert.deepEqual(after.get(f.contactId), {
      decision: 'ALLOW',
      read: true,
      manage: false,
      basis: 'CUSTODIAN_MANAGE',
      identity: 'MERGED',
    });

    // order 2: the canonical writer holds the exclusive identity fence mid-transaction → Cus360 fails fast
    const third = await contact(f, 'Target two');
    const started = performance.now();
    await pausedWriter(
      f,
      'c360_identity_lineage',
      () => merge(f, target, third),
      async () => {
        await assert.rejects(fence(f, admin, [target]), isBusy);
        assert.ok(
          performance.now() - started < 2500,
          'Cus360 must fail fast and not wait for the canonical writer',
        );
      },
    );
    assert.equal((await identityHead(f, target)).state, 'MERGED');
    // a descendant merged under the target is repointed to third and does not stay pointing at a contact that is not canonical
    const repointed = await identityHead(f, f.contactId);
    assert.equal(repointed.canonicalContactId, third);
    assert.equal(repointed.lineageRevision, 2);
  } finally {
    await f.close();
  }
});

test('S4: the descendant fence stops the whole canonical closure and a membership commit racing MERGE in both orders', async () => {
  const f = await setup();
  try {
    const admin = actor(f, 'admin');
    const anchor = await contact(f, 'anchor');
    const target = await contact(f, 'target');
    await merge(f, f.contactId, anchor); // f.contactId is a descendant of anchor

    // Cus360 holds a fence on the descendant only: MERGE anchor→target must be busy because the closure includes the descendant
    const held = await holdFence(f, admin, [f.contactId]);
    try {
      await assert.rejects(
        merge(f, anchor, target),
        (error) => error instanceof C360MembershipRepositoryError && error.code === 'RESOURCE_BUSY',
      );
      assert.equal((await identityHead(f, f.contactId)).canonicalContactId, anchor);
    } finally {
      await held.release();
    }

    // order 1: the membership commit of anchor holds identity(shared)+stream then stops → MERGE is busy
    // after the commit MERGE must see the new head and invalidate following the latest revision
    const commitFor = (contactId: string, snapshotVersion: number, expected: number) =>
      f.segments
        .recordFactSnapshot({
          tenantId: f.tenantId,
          contactId,
          snapshotVersion,
          attributes: { tier: { type: 'STRING', value: 'GOLD' } },
          computed: {},
          sourceCutoffAt: new Date().toISOString(),
          correlationId: `c1-s4-snapshot-${randomUUID()}`,
        })
        .then(() =>
          f.memberships.commitEvaluation({
            tenantId: f.tenantId,
            contactId,
            segmentId: f.segmentId,
            segmentDefinitionVersion: 1,
            snapshotVersion,
            expectedMembershipRevision: expected,
            commandId: `command:${randomUUID()}`,
            correlationId: `c1-s4-${randomUUID()}`,
          }),
        );
    await f.segments.recordFactSnapshot({
      tenantId: f.tenantId,
      contactId: anchor,
      snapshotVersion: 1,
      attributes: { tier: { type: 'STRING', value: 'GOLD' } },
      computed: {},
      sourceCutoffAt: new Date().toISOString(),
      correlationId: 'c1-s4-anchor-snapshot',
    });
    const entered = await pausedWriter(
      f,
      'c360_segment_membership_changes',
      () =>
        f.memberships.commitEvaluation({
          tenantId: f.tenantId,
          contactId: anchor,
          segmentId: f.segmentId,
          segmentDefinitionVersion: 1,
          snapshotVersion: 1,
          expectedMembershipRevision: 0,
          commandId: `command:${randomUUID()}`,
          correlationId: 'c1-s4-anchor-commit',
        }),
      async () => {
        await assert.rejects(
          merge(f, anchor, target),
          (error) =>
            error instanceof C360MembershipRepositoryError && error.code === 'RESOURCE_BUSY',
        );
      },
    );
    assert.equal(entered.status, 'TRANSITIONED');
    assert.equal(entered.membershipRevision, 1);
    const transition = await merge(f, anchor, target);
    const anchorHead = await membershipHead(f, anchor);
    assert.equal(anchorHead?.state, 'INVALIDATED');
    assert.equal(anchorHead?.membershipRevision, 2);
    assert.equal(anchorHead?.lineageRevision, transition.lineageRevision);
    assert.equal((await identityHead(f, f.contactId)).canonicalContactId, target);

    // order 2: MERGE holds the exclusive closure mid-transaction → the membership commit of the source waits
    // then sees MERGED so it quarantines and does not write a head over the invalidation
    const source = await contact(f, 'source');
    const sink = await contact(f, 'sink');
    let commit: ReturnType<typeof commitFor> | undefined;
    await pausedWriter(
      f,
      'c360_identity_lineage',
      () => merge(f, source, sink),
      async (writerPid) => {
        let settled = false;
        commit = commitFor(source, 1, 0);
        void commit.finally(() => (settled = true)).catch(() => undefined);
        await waitUntilBlocked(f, writerPid, () => settled);
        assert.equal(settled, false);
      },
    );
    const quarantined = await commit!;
    assert.equal(quarantined.status, 'QUARANTINED');
    assert.equal(await membershipHead(f, source), null);
    assert.equal(
      await f.owner.c360MembershipQuarantine.count({
        where: { tenantId: f.tenantId, contactId: source, errorCode: 'IDENTITY_LINEAGE_CONFLICT' },
      }),
      1,
    );
  } finally {
    await f.close();
  }
});

test('S4: the IAM projection consumer with the Cus360 freshness fence in both orders, including a membership change before Kafka', async () => {
  const f = await setup();
  try {
    const supervisor = actor(f, 'supervisor');
    await f.scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId: f.segmentId,
      permission: 'VIEW',
      correlationId: 'c1-s4-grant',
    });
    await ownerCommit(f, 'GOLD');
    await deliverToIam(f);
    assert.equal((await fence(f, supervisor, [f.contactId])).get(f.contactId)?.decision, 'ALLOW');

    // the owner leaves the segment before Kafka: a Cus360 that decides after that must DEFER even though the projection is still IN
    await ownerCommit(f, 'SILVER');
    const lagging = await holdFence(f, supervisor, [f.contactId]);
    assert.deepEqual(lagging.access.get(f.contactId), {
      decision: 'DEFER',
      reasonCode: 'SCOPE_CONTEXT_STALE',
    });
    // order 1: Cus360 holds the projection fence → the consumer waits until Cus360 finishes, then applies
    let settled = false;
    const delivered = deliverToIam(f).finally(() => (settled = true));
    try {
      await waitUntilBlocked(f, lagging.pid, () => settled);
      assert.equal(settled, false);
    } finally {
      await lagging.release();
    }
    await delivered;
    assert.equal((await fence(f, supervisor, [f.contactId])).get(f.contactId)?.decision, 'DENY');

    // order 2: the consumer holds the projection fence mid-upsert → Cus360 fails fast; after the commit it decides from the new value
    await ownerCommit(f, 'GOLD');
    await pausedWriter(
      f,
      'iam_contact_segment_scope_projection',
      () => deliverToIam(f),
      async () => {
        await assert.rejects(fence(f, supervisor, [f.contactId]), isBusy);
      },
    );
    const projection = await f.owner.iamContactSegmentScopeProjection.findUniqueOrThrow({
      where: {
        tenantId_contactId_segmentId: {
          tenantId: f.tenantId,
          contactId: f.contactId,
          segmentId: f.segmentId,
        },
      },
    });
    assert.equal(projection.state, 'IN');
    assert.equal(projection.membershipRevision, f.membershipRevision);
    assert.equal((await fence(f, supervisor, [f.contactId])).get(f.contactId)?.decision, 'ALLOW');
  } finally {
    await f.close();
  }
});

test('S4: IAM grant revoke with the scope-version fence in both orders, no ALLOW after the revoke commits', async () => {
  const f = await setup();
  try {
    const supervisor = actor(f, 'supervisor');
    const granted = await f.scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId: f.segmentId,
      permission: 'VIEW',
      correlationId: 'c1-s4-grant',
    });
    await ownerCommit(f, 'GOLD');
    await deliverToIam(f);

    // order 1: Cus360 holds the scope-version FOR SHARE → the revoke UPDATE waits until Cus360 finishes
    const held = await holdFence(f, supervisor, [f.contactId]);
    assert.equal(held.access.get(f.contactId)?.decision, 'ALLOW');
    let settled = false;
    const revoked = f.scopes
      .revoke({
        tenantId: f.tenantId,
        grantId: granted.grant.id,
        reasonCode: 'C1_S4_TEST',
        correlationId: 'c1-s4-revoke',
      })
      .finally(() => (settled = true));
    try {
      await waitUntilBlocked(f, held.pid, () => settled);
      assert.equal(settled, false);
    } finally {
      await held.release();
    }
    assert.equal((await revoked).outcome, 'REVOKED');
    assert.equal((await fence(f, supervisor, [f.contactId])).get(f.contactId)?.decision, 'DENY');

    // order 2: a new grant is stopped after the scope-version UPDATE → Cus360 fails fast; after the commit it sees the new grant
    await pausedWriter(
      f,
      'iam_team_segment_scope_grants',
      () =>
        f.scopes.grant({
          tenantId: f.tenantId,
          teamId: f.teamId,
          segmentId: f.segmentId,
          permission: 'VIEW',
          correlationId: 'c1-s4-regrant',
        }),
      async () => {
        await assert.rejects(fence(f, supervisor, [f.contactId]), isBusy);
      },
    );
    const version = await f.owner.iamTeamScopeVersion.findUniqueOrThrow({
      where: { tenantId_teamId: { tenantId: f.tenantId, teamId: f.teamId } },
    });
    assert.equal(version.scopeVersion, 3);
    assert.equal((await fence(f, supervisor, [f.contactId])).get(f.contactId)?.decision, 'ALLOW');
  } finally {
    await f.close();
  }
});
