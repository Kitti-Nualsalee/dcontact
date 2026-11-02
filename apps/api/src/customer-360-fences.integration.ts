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
 * Cus360 C1 (#791) S4: owner fences ตาม E1 G แข่งกับ actual owner writers ทั้งสองลำดับ
 *
 * ลำดับที่ 1: Cus360 ถือ fence อยู่ แล้ว owner writer เริ่ม
 * ลำดับที่ 2: owner writer ถูกหยุดกลาง transaction (trigger barrier หลังได้ lock แล้ว) แล้ว Cus360 เริ่ม
 * ตรวจ final DB state/revisions ไม่ใช่แค่ status และไม่มี unsafe ALLOW หรือ tenant-wide exclusive lock
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

/** เปิด Cus360 transaction ที่ถือ fence ค้างไว้จนกว่าจะ release */
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
  assert.ok(access, 'Cus360 ต้องได้ fence ก่อนเริ่ม owner writer');
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

/** ตรวจว่ามี session ที่ถูก `blocker` กันอยู่จริง (owner writer รอ fence ไม่ได้แค่ช้า) */
async function waitUntilBlocked(f: Fixture, blocker: number, settled: () => boolean) {
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline && !settled()) {
    const [row] = await f.owner.$queryRaw<{ waiting: boolean }[]>`
      SELECT EXISTS (SELECT 1 FROM pg_stat_activity
        WHERE ${blocker}::int = ANY (pg_blocking_pids(pid))) AS waiting`;
    if (row?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('owner writer ต้องรอ fence ของ Cus360 แต่ไม่ได้รอ');
}

/**
 * หยุด actual owner writer หลัง INSERT/UPDATE แถวแรกของ table ใน tenant นี้ (หลังได้ fences แล้ว)
 * แล้วรัน `during` ระหว่างที่ writer ยังถือ lock อยู่
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
  // identifiers/literals ทั้งหมดสร้างใน test (UUID ที่ตรวจแล้วและ integer สุ่ม) ไม่มี input ภายนอก
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
      if (performance.now() > deadline) assert.fail(`writer ไม่ถึง barrier ของ ${table}`);
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

test('S4: canonical MERGE กับ Cus360 identity fence ทั้งสองลำดับ; contact อื่นไม่ถูกล็อกทั้ง tenant', async () => {
  const f = await setup();
  try {
    await grantCustodian(f, 'admin', 'MANAGE');
    await activeHead(f);
    const target = await contact(f, 'ปลายทาง');
    const admin = actor(f, 'admin');

    // ลำดับ 1: Cus360 ถือ shared identity fence → canonical writer ได้ RESOURCE_BUSY ไม่เขียนอะไร
    const held = await holdFence(f, admin, [f.contactId]);
    assert.deepEqual(held.access.get(f.contactId), {
      decision: 'ALLOW',
      read: true,
      manage: true,
      basis: 'CUSTODIAN_MANAGE',
      identity: 'ACTIVE',
    });
    const otherSource = await contact(f, 'ไม่เกี่ยว ก');
    const otherTarget = await contact(f, 'ไม่เกี่ยว ข');
    try {
      await assert.rejects(
        merge(f, f.contactId, target),
        (error) => error instanceof C360MembershipRepositoryError && error.code === 'RESOURCE_BUSY',
      );
      assert.equal(await f.owner.c360IdentityLineage.count({ where: { tenantId: f.tenantId } }), 0);
      assert.equal((await identityHead(f, f.contactId)).state, 'ACTIVE');
      // ไม่มี tenant-wide exclusive lock: transition ของ contact คู่อื่นผ่านได้ระหว่างนั้น
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

    // ลำดับ 2: canonical writer ถือ exclusive identity fence กลาง transaction → Cus360 fail fast
    const third = await contact(f, 'ปลายทางสอง');
    const started = performance.now();
    await pausedWriter(
      f,
      'c360_identity_lineage',
      () => merge(f, target, third),
      async () => {
        await assert.rejects(fence(f, admin, [target]), isBusy);
        assert.ok(performance.now() - started < 2500, 'Cus360 ต้อง fail fast ไม่รอ canonical');
      },
    );
    assert.equal((await identityHead(f, target)).state, 'MERGED');
    // descendant ที่ merge ไว้ใต้ target ถูก repoint ตามไปที่ third ไม่ชี้ค้างที่ contact ที่ไม่ใช่ canonical
    const repointed = await identityHead(f, f.contactId);
    assert.equal(repointed.canonicalContactId, third);
    assert.equal(repointed.lineageRevision, 2);
  } finally {
    await f.close();
  }
});

test('S4: fence ของ descendant กัน canonical ทั้ง closure และ membership commit แข่ง MERGE ทั้งสองลำดับ', async () => {
  const f = await setup();
  try {
    const admin = actor(f, 'admin');
    const anchor = await contact(f, 'anchor');
    const target = await contact(f, 'target');
    await merge(f, f.contactId, anchor); // f.contactId เป็น descendant ของ anchor

    // Cus360 ถือ fence เฉพาะ descendant: MERGE anchor→target ต้อง busy เพราะ closure รวม descendant
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

    // ลำดับ 1: membership commit ของ anchor ถือ identity(shared)+stream แล้วหยุด → MERGE busy
    // หลัง commit แล้ว MERGE ต้องเห็น head ใหม่และ invalidate ต่อจาก revision ล่าสุด
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

    // ลำดับ 2: MERGE ถือ exclusive closure กลาง transaction → membership commit ของ source รอ
    // แล้วเห็น MERGED จึง quarantine ไม่เขียน head ทับ invalidation
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

test('S4: IAM projection consumer กับ Cus360 freshness fence ทั้งสองลำดับ รวม membership change ก่อน Kafka', async () => {
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

    // owner ออกจาก segment ก่อน Kafka: Cus360 ที่ตัดสินหลังจากนั้นต้อง DEFER แม้ projection ยัง IN
    await ownerCommit(f, 'SILVER');
    const lagging = await holdFence(f, supervisor, [f.contactId]);
    assert.deepEqual(lagging.access.get(f.contactId), {
      decision: 'DEFER',
      reasonCode: 'SCOPE_CONTEXT_STALE',
    });
    // ลำดับ 1: Cus360 ถือ projection fence → consumer รอจน Cus360 จบ แล้วจึง apply
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

    // ลำดับ 2: consumer ถือ projection fence กลาง upsert → Cus360 fail fast; หลัง commit ตัดสินจากค่าใหม่
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

test('S4: IAM grant revoke กับ scope-version fence ทั้งสองลำดับ ไม่มี ALLOW หลัง revoke commit', async () => {
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

    // ลำดับ 1: Cus360 ถือ scope-version FOR SHARE → revoke UPDATE รอจน Cus360 จบ
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

    // ลำดับ 2: grant ใหม่ถูกหยุดหลัง UPDATE scope-version → Cus360 fail fast; หลัง commit เห็น grant ใหม่
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
