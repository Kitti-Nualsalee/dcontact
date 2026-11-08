import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import { C360WorkAuthError, C360WorkAuthService } from './customer-360-work-auth.js';
import { coreFixture } from './tenant-core-test-fixtures.js';
import { WorkSessionLeases } from './work-session.js';

// ใช้ฐาน integration แยกเท่านั้น ห้ามใช้ฐานพัฒนาร่วม
test('C5 durable auth: PostgreSQL/RLS, epoch CAS, reauth และ Voice lease invariants', async (t) => {
  const owner = new URL(process.env.DATABASE_URL ?? 'postgresql://invalid/none');
  assert.ok(owner.pathname !== '/dcontact' && owner.port !== '5433', 'ต้องใช้ฐานทดสอบแยก');
  assert.ok(process.env.APPLICATION_DATABASE_URL, 'ต้องมี application role เพื่อพิสูจน์ RLS');
  const f = await coreFixture();
  t.after(() => f.close());
  const agent = f.actors.get('agent')!;
  const actor = { tenantId: f.tenantId, userId: agent.id };
  const leases = new WorkSessionLeases(f.db);
  const lease = await leases.acquire(
    actor,
    { surface: 'workspace', hostOrigin: null },
    'auth-fixture',
  );
  const leaseId = lease.leaseId;
  const expires = Math.floor(Date.now() / 1000) + 3600;
  let active = true;
  let unavailable = false;
  let onlineGate: Promise<void> | undefined;
  let onlineStarted: (() => void) | undefined;
  const claims = (token: string) => ({
    iss: 'https://core-idp.test/realms/dcontact',
    sub: token === 'wrong-subject' ? randomUUID() : agent.id,
    azp: 'dcontact-console',
    tenant_id: f.tenantId,
    tenant_slug: `core-${f.tenantId}`,
    organization: { [`core-${f.tenantId}`]: { tenant_id: [f.tenantId] } },
    dc_user_id: agent.id,
    sid: `sid-${token}`,
    exp: expires,
    realm_access: { roles: ['agent'] },
  });
  const service = new C360WorkAuthService(
    f.db,
    { verifyAccessToken: async (token) => claims(token) },
    {
      async introspect(token) {
        onlineStarted?.();
        if (onlineGate) await onlineGate;
        if (unavailable) throw new C360WorkAuthError(503, 'WORK_IDENTITY_UNAVAILABLE', true);
        return {
          active,
          iss: claims(token).iss,
          sub: claims(token).sub,
          sid: claims(token).sid,
          exp: expires,
        };
      },
    },
  );
  const row = () =>
    f.owner.c360WorkMutationAuth.findUniqueOrThrow({
      where: { tenantId_userId_leaseId: { ...actor, leaseId } },
    });
  const check = (proof: Awaited<ReturnType<typeof service.verifyOnline>>) =>
    withTenantDatabaseTransaction(f.db, actor.tenantId, (tx) =>
      service.assertOnlineProof(tx, proof),
    );
  let binding = await service.reauthenticate({ accessToken: 'first', leaseId });
  await t.test('initial trusted binding และ online proof ไม่เก็บ token ดิบ', async () => {
    assert.equal(binding.authEpoch, '0');
    const proof = await service.verifyOnline({ accessToken: 'first', leaseId });
    await check(proof);
    assert.equal((await row()).lastOnlineCheckStartedAt?.getTime(), proof.checkStartedAt.getTime());
    assert.notEqual((await row()).tokenFingerprint, 'first');
    await assert.rejects(
      () => service.verifyOnline({ accessToken: 'second', leaseId }),
      /WORK_REAUTH_REQUIRED/,
      'token เปลี่ยนต้องผ่าน explicit reauth',
    );
  });
  await f.owner.interaction.create({
    data: {
      tenantId: f.tenantId,
      id: randomUUID(),
      agentId: agent.id,
      channel: 'VOICE',
      direction: 'INBOUND',
      state: 'ACTIVE',
    },
  });
  await t.test(
    'revoke ขณะ ACTIVE persist REAUTH_REQUIRED ก่อน busy return; heartbeat ไม่คืน auth',
    async () => {
      assert.equal(await leases.revokeForAuth(actor, leaseId, 'actual-revoke', binding), false);
      assert.equal((await row()).authState, 'REAUTH_REQUIRED');
      assert.equal((await row()).authEpoch, 1n);
      assert.equal(
        (await f.owner.agentWorkSessionLease.findUniqueOrThrow({ where: { id: leaseId } }))
          .releasedAt,
        null,
      );
      assert.equal((await leases.heartbeat(actor, leaseId)).status, 'ACTIVE');
      assert.equal((await row()).authState, 'REAUTH_REQUIRED');
    },
  );
  await t.test(
    'fresh sid subject เดิมกลับงานเดิมได้; callback เก่าไม่ invalidate epoch ใหม่',
    async () => {
      const previous = binding;
      binding = await service.reauthenticate({
        accessToken: 'second',
        leaseId,
        expected: previous,
      });
      assert.equal(binding.authEpoch, '2');
      assert.equal(binding.sid, 'sid-second');
      assert.equal(await service.invalidateCaptured(previous, 'OLD_CALLBACK'), false);
      assert.equal(await leases.revokeForAuth(actor, leaseId, 'old-callback', previous), false);
      assert.equal((await row()).authState, 'ACTIVE');
      assert.equal((await row()).authEpoch, 2n);
      assert.equal(
        (await f.owner.agentWorkSessionLease.findUniqueOrThrow({ where: { id: leaseId } }))
          .releasedAt,
        null,
      );
    },
  );
  await t.test('online active:false persist invalidation แล้ว login ใหม่กลับได้', async () => {
    active = false;
    await assert.rejects(
      () => service.verifyOnline({ accessToken: 'second', leaseId }),
      /WORK_REAUTH_REQUIRED/,
    );
    assert.equal((await row()).authState, 'REAUTH_REQUIRED');
    assert.equal((await row()).authEpoch, 3n);
    active = true;
    binding = await service.reauthenticate({ accessToken: 'third', leaseId });
    assert.equal(binding.authEpoch, '4');
  });
  await t.test(
    'invalidation ชนะระหว่าง network check ทำให้ proof เก่าถูกปฏิเสธก่อน effect',
    async () => {
      let release!: () => void;
      onlineGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        onlineStarted = resolve;
      });
      const pending = service.verifyOnline({ accessToken: 'third', leaseId });
      await started;
      assert.equal(await service.invalidateCaptured(binding, 'LOCAL_REVOKE'), true);
      release();
      const proof = await pending;
      onlineGate = undefined;
      onlineStarted = undefined;
      await assert.rejects(() => check(proof), /WORK_REAUTH_REQUIRED/);
      assert.equal((await row()).authEpoch, 5n);
      binding = await service.reauthenticate({ accessToken: 'fourth', leaseId });
    },
  );
  await t.test(
    'IdP unavailable fail closed เฉพาะ auth และ reauth ไม่เปลี่ยน lease/work',
    async () => {
      unavailable = true;
      await assert.rejects(
        () => service.verifyOnline({ accessToken: 'fourth', leaseId }),
        /WORK_IDENTITY_UNAVAILABLE/,
      );
      assert.equal((await row()).authState, 'REAUTH_REQUIRED');
      unavailable = false;
      binding = await service.reauthenticate({ accessToken: 'fifth', leaseId });
      assert.equal(
        await f.owner.interaction.count({
          where: { tenantId: f.tenantId, agentId: agent.id, state: 'ACTIVE' },
        }),
        1,
      );
      assert.equal(
        (await f.owner.agentWorkSessionLease.findUniqueOrThrow({ where: { id: leaseId } }))
          .releasedAt,
        null,
      );
    },
  );
  await t.test(
    'proof deadline หมดก่อน transaction และ subject mismatch ไม่เขียน auth ใหม่',
    async () => {
      const proof = await service.verifyOnline({ accessToken: 'fifth', leaseId });
      await assert.rejects(
        () => check({ ...proof, deadline: new Date(0) }),
        /WORK_AUTH_PROOF_EXPIRED/,
      );
      const before = (await row()).authEpoch;
      await assert.rejects(
        () => service.reauthenticate({ accessToken: 'wrong-subject', leaseId }),
        /WORK_REAUTH_REQUIRED/,
      );
      assert.equal((await row()).authEpoch, before);
    },
  );
  await t.test(
    'takeover ที่ชนะ online check ปฏิเสธ proof เก่าและ callback ไม่แตะ lease ใหม่',
    async () => {
      await f.owner.interaction.updateMany({
        where: { tenantId: actor.tenantId, agentId: actor.userId },
        data: { state: 'COMPLETED' },
      });
      let release!: () => void;
      onlineGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        onlineStarted = resolve;
      });
      const pending = service.verifyOnline({ accessToken: 'fifth', leaseId });
      await started;
      const moved = await leases.takeover(
        actor,
        { surface: 'workspace', hostOrigin: null, expectedLeaseId: leaseId },
        'actual-takeover',
      );
      release();
      const proof = await pending;
      onlineGate = undefined;
      onlineStarted = undefined;
      await assert.rejects(() => check(proof), /WORK_AUTH_CHANGED/);
      assert.equal(await service.invalidateCaptured(binding, 'OLD_LEASE_CALLBACK'), false);
      assert.notEqual(moved.leaseId, leaseId);
      assert.equal(
        (await f.owner.agentWorkSessionLease.findUniqueOrThrow({ where: { id: moved.leaseId } }))
          .releasedAt,
        null,
      );
    },
  );
});
