/**
 * A1.4 (#409) fast gate บน Postgres จริง — ไม่ต้องใช้ Keycloak
 *
 * - #388 decision "Tenant bootstrap write boundary": `dcontact_provisioner` เขียน users ได้เฉพาะ tenant
 *   ที่ยัง PROVISIONING, ตั้ง `app.tenant_id` เองก็หนีไม่ได้ และไม่มีสิทธิ์บน business tables
 * - `pf_invitations`: lifespan 72 ชั่วโมง, generation ต่อเนื่อง, supersede ก่อน resend,
 *   resend ≤ 3 ครั้ง/ชั่วโมง, AMBIGUOUS ห้ามถือว่าไม่ได้ส่ง, ลบไม่ได้, tenant app มองไม่เห็น
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { createPlatformFixture, digest, OPERATOR } from './platform-fixture.js';

async function setup(t: TestContext) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const accept = async () => {
    const key = `idem-${randomUUID()}`;
    const result = await f.repository().accept({
      idempotencyKey: key,
      input: f.input(),
      plan: f.plan,
      actor: OPERATOR,
      correlationId: `corr-${key}`,
    });
    f.track(result.tenantId);
    return result;
  };
  return { f, accept };
}

function userRow(tenantId: string) {
  return {
    id: randomUUID(),
    tenantId,
    email: `first-admin-${randomUUID().slice(0, 8)}@example.test`,
    passwordHash: '!keycloak-managed',
    displayName: 'First Admin',
    role: 'ADMIN' as const,
  };
}

async function rejects(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => {
    assert.match(String(error), pattern);
    return true;
  });
}

test('provisioner เขียน users ได้เฉพาะ tenant ที่ยัง PROVISIONING', async (t) => {
  const { f, accept } = await setup(t);
  const accepted = await accept();
  const row = userRow(accepted.tenantId);
  await f.provisioner.user.create({ data: row });
  const seen = await f.provisioner.user.findUnique({ where: { id: row.id } });
  assert.equal(seen?.tenantId, accepted.tenantId);
  const mapped = await f.provisioner.user.updateMany({
    where: { id: row.id },
    data: { keycloakId: randomUUID() },
  });
  assert.equal(mapped.count, 1);
  // column grant: แก้ได้เฉพาะ keycloak_id
  await rejects(
    f.provisioner.user.update({ where: { id: row.id }, data: { role: 'AGENT' } }),
    /permission denied/,
  );
});

test('provisioner แตะ tenant ACTIVE ไม่ได้ แม้ตั้ง app.tenant_id เอง (RESTRICTIVE policy)', async (t) => {
  const { f } = await setup(t);
  // tenant ACTIVE ที่มีผู้ใช้อยู่แล้ว (สร้างเองเพราะ fast gate ไม่มี seed)
  const label = `a14-active-${randomUUID().slice(0, 8)}`;
  const active = await f.owner.tenant.create({
    data: { name: label, slug: label, sipDomain: `${label}.sip.test` },
    select: { id: true },
  });
  f.track(active.id);
  await f.owner.user.create({ data: userRow(active.id) });
  const visible = await f.provisioner.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(`SELECT set_config('app.tenant_id', $1, true)`, active.id);
    return transaction.user.count({ where: { tenantId: active.id } });
  });
  assert.equal(visible, 0);
  assert.equal(await f.owner.user.count({ where: { tenantId: active.id } }), 1);
  await rejects(
    f.provisioner.$transaction(async (transaction) => {
      await transaction.$executeRawUnsafe(
        `SELECT set_config('app.tenant_id', $1, true)`,
        active.id,
      );
      await transaction.user.create({ data: userRow(active.id) });
    }),
    /row-level security/,
  );
});

test('provisioner ไม่มีสิทธิ์บน business tables และ control plane', async (t) => {
  const { f } = await setup(t);
  for (const table of [
    'contacts',
    'interactions',
    'messages',
    'recordings',
    'pf_provisioning_requests',
  ]) {
    await rejects(
      f.provisioner.$queryRawUnsafe(`SELECT 1 FROM "${table}" LIMIT 1`),
      /permission denied/,
    );
  }
  await rejects(
    f.provisioner.$queryRawUnsafe(`SELECT "name" FROM "tenants" LIMIT 1`),
    /permission denied/,
  );
  await rejects(
    f.provisioner.$executeRawUnsafe(`DELETE FROM "users" WHERE false`),
    /permission denied/,
  );
});

test('pf_invitations: generation, supersede, resend cap 3/ชั่วโมง และ state machine', async (t) => {
  const { f, accept } = await setup(t);
  const accepted = await accept();
  const at = new Date('2026-09-24T03:00:00.000Z');
  const base = {
    requestId: accepted.requestId,
    tenantId: accepted.tenantId,
    keycloakUserId: randomUUID(),
    recipientHash: digest('recipient'),
    lifespanSeconds: 259200,
  };
  const create = (generation: number, minutes: number) =>
    f.platform.pfInvitation.create({
      data: {
        ...base,
        id: randomUUID(),
        generation,
        requestedByKind: generation === 1 ? 'SYSTEM' : 'PLATFORM_OPERATOR',
        requestedBy: generation === 1 ? 'provisioning-worker' : OPERATOR.subject,
        reasonCode: generation === 1 ? null : 'RECIPIENT_REQUESTED',
        createdAt: new Date(at.getTime() + minutes * 60_000),
      },
    });
  const supersede = async (generation: number) => {
    const row = await f.platform.pfInvitation.findFirstOrThrow({
      where: { requestId: accepted.requestId, generation },
    });
    await f.platform.pfInvitation.update({
      where: { id: row.id },
      data: { supersededAt: at, revision: { increment: 1 } },
    });
  };

  await rejects(
    f.platform.pfInvitation.create({
      data: {
        ...base,
        id: randomUUID(),
        generation: 1,
        lifespanSeconds: 3600,
        requestedByKind: 'SYSTEM',
        requestedBy: 'w',
        createdAt: at,
      },
    }),
    /pf_invitations_values_check/,
  );
  const first = await create(1, 0);
  await rejects(create(2, 1), /PF_INVITATION_NOT_SUPERSEDED/);
  await supersede(1);
  await rejects(create(3, 1), /PF_INVITATION_GENERATION/);
  await create(2, 1);
  await supersede(2);
  await create(3, 2);
  await supersede(3);
  await create(4, 3);
  await supersede(4);
  // resend ครั้งที่ 4 ภายในชั่วโมงเดียวกัน
  await rejects(create(5, 4), /PF_INVITATION_RESEND_LIMIT/);
  // พ้นหน้าต่างหนึ่งชั่วโมงจาก resend แรกแล้วส่งได้
  await create(5, 62);

  // SENT ต้องมี sent_at และ expires_at = sent_at + 72 ชั่วโมง
  await rejects(
    f.platform.pfInvitation.update({
      where: { id: first.id },
      data: { state: 'SENT', revision: { increment: 1 } },
    }),
    /pf_invitations_values_check/,
  );
  await f.platform.pfInvitation.update({
    where: { id: first.id },
    data: { state: 'AMBIGUOUS', revision: { increment: 1 } },
  });
  // ไม่รู้ผลห้ามถือว่าไม่ได้ส่ง
  await rejects(
    f.platform.pfInvitation.update({
      where: { id: first.id },
      data: { state: 'FAILED', revision: { increment: 1 } },
    }),
    /PF_INVITATION_TRANSITION/,
  );
  await rejects(
    f.platform.pfInvitation.update({
      where: { id: first.id },
      data: { generation: 9, revision: { increment: 1 } },
    }),
    /PF_INVITATION_IDENTITY_IMMUTABLE/,
  );
  await rejects(f.owner.pfInvitation.delete({ where: { id: first.id } }), /PF_RETAINED/);
  await rejects(
    f.application.$queryRawUnsafe('SELECT 1 FROM "pf_invitations" LIMIT 1'),
    /permission denied/,
  );
});
