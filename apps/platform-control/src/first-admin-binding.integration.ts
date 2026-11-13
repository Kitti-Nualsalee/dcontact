/**
 * #901: positive identity binding ของ first admin จาก Platform provisioning — Postgres จริง ไม่ต้องใช้ Keycloak
 *
 * - saga บันทึก binding ใน transaction เดียวกับที่ request เป็น SUCCEEDED และ tenant เป็น ACTIVE
 * - DB อ่าน subject/Organization จากผลขั้น FIRST_ADMIN/KEYCLOAK_ORGANIZATION และผู้รับรองจาก requested_by
 *   ผู้เรียกส่งได้เพียง issuer/client ของ deployment
 * - หลักฐานไม่ตรง = tenant ไม่ ACTIVE (rollback ทั้ง transaction); เรียกซ้ำด้วยค่าเดิมไม่สร้าง revision ใหม่
 * - tenant app อ่านได้ภายใต้ RLS แต่เรียกฟังก์ชันหรือเขียนเองไม่ได้
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { KEYCLOAK_MANAGED_PASSWORD } from './keycloak-provisioning-ports.js';
import { createPlatformFixture, OPERATOR, SIP_BASE, TENANT_CONSOLE } from './platform-fixture.js';
import { createFakeProvisioningPorts } from './provisioning-fakes.js';
import {
  ProvisioningSagaWorker,
  type ProvisioningStepContext,
  type ProvisioningStepPort,
} from './provisioning-saga.js';
import { firstAdminUserId } from './provisioning-ids.js';
import type { TenantConsoleContext } from './tenant-console-context.js';

type Fixture = Awaited<ReturnType<typeof createPlatformFixture>>;

/** port ที่คืน external ref แบบ uuid คงที่ต่อ request (แทน Organization ของ Keycloak) */
function organizationPort(refs: Map<string, string>): ProvisioningStepPort {
  return {
    async find(context) {
      const ref = refs.get(context.requestId);
      return ref ? { status: 'FOUND', externalRef: ref } : { status: 'NOT_FOUND' };
    },
    async execute(context) {
      const ref = refs.get(context.requestId) ?? randomUUID();
      refs.set(context.requestId, ref);
      return { externalRef: ref };
    },
  };
}

/** สร้างแถว users ของ first admin ด้วย role provisioner แบบเดียวกับ FirstAdminPort แล้วคืน subject */
function firstAdminPort(
  f: Fixture,
  subjects: Map<string, string>,
  options: { email?: (context: ProvisioningStepContext) => string } = {},
): ProvisioningStepPort {
  return {
    async find(context) {
      const subject = subjects.get(context.requestId);
      return subject ? { status: 'FOUND', externalRef: subject } : { status: 'NOT_FOUND' };
    },
    async execute(context) {
      const subject = subjects.get(context.requestId) ?? randomUUID();
      subjects.set(context.requestId, subject);
      await f.provisioner.user.createMany({
        data: [
          {
            id: firstAdminUserId(context.requestId),
            tenantId: context.tenantId,
            email: options.email?.(context) ?? context.request.firstAdminEmail,
            passwordHash: KEYCLOAK_MANAGED_PASSWORD,
            displayName: context.request.firstAdminDisplayName,
            role: 'ADMIN',
            keycloakId: subject,
          },
        ],
        skipDuplicates: true,
      });
      return { externalRef: subject };
    },
  };
}

async function setup(
  t: TestContext,
  options: {
    tenantConsole?: TenantConsoleContext | null;
    email?: (context: ProvisioningStepContext) => string;
  } = {},
) {
  const f = await createPlatformFixture();
  t.after(() => f.dispose());
  const organizations = new Map<string, string>();
  const subjects = new Map<string, string>();
  const fakes = createFakeProvisioningPorts();
  const tenants: string[] = [];
  const tenantConsole =
    options.tenantConsole === null ? undefined : (options.tenantConsole ?? TENANT_CONSOLE);
  const worker = new ProvisioningSagaWorker(
    f.platform,
    {
      ...fakes.ports,
      KEYCLOAK_ORGANIZATION: organizationPort(organizations),
      FIRST_ADMIN: firstAdminPort(f, subjects, options.email ? { email: options.email } : {}),
    },
    {
      workerId: `binding-${randomUUID().slice(0, 8)}`,
      sipBaseDomain: SIP_BASE,
      scope: () => ({ tenantId: { in: [...tenants] } }),
      timeoutMs: 2_000,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
      ...(tenantConsole ? { tenantConsole } : {}),
    },
  );
  const key = `idem-${randomUUID()}`;
  const accepted = await f.repository().accept({
    idempotencyKey: key,
    input: f.input(),
    plan: f.plan,
    actor: OPERATOR,
    correlationId: `corr-${key}`,
  });
  f.track(accepted.tenantId);
  tenants.push(accepted.tenantId);
  const drain = async () => {
    for (let round = 0; round < 20; round += 1) {
      const results = await worker.drain();
      if (results.length === 0) break;
    }
  };
  const state = () =>
    f.owner.pfProvisioningRequest.findUniqueOrThrow({
      where: { id: accepted.requestId },
      include: { tenant: true },
    });
  const bindings = () =>
    f.owner.tenantVoiceIdentityBinding.findMany({ where: { tenantId: accepted.tenantId } });
  const audits = () =>
    f.owner.tenantVoiceIdentityBindingAudit.findMany({ where: { tenantId: accepted.tenantId } });
  const bind = (client: Fixture['platform'], context: TenantConsoleContext = TENANT_CONSOLE) =>
    client.$queryRaw<{ revision: number }[]>`
      SELECT dc_platform_bind_first_admin(${accepted.tenantId}::uuid, ${accepted.requestId}::uuid,
        ${context.issuer}, ${context.clientId}) AS revision`;
  return { f, accepted, drain, state, bindings, audits, bind, organizations, subjects };
}

async function rejects(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => {
    assert.match(String(error), pattern);
    return true;
  });
}

test('saga บันทึก binding ของ first admin พร้อม ACTIVE จากหลักฐานของ request เอง', async (t) => {
  const s = await setup(t);
  await s.drain();
  const final = await s.state();
  assert.deepEqual([final.status, final.tenant.lifecycleStatus], ['SUCCEEDED', 'ACTIVE']);
  const [binding, ...others] = await s.bindings();
  assert.equal(others.length, 0);
  assert.ok(binding);
  assert.equal(binding.userId, firstAdminUserId(s.accepted.requestId));
  assert.equal(binding.subjectId, s.subjects.get(s.accepted.requestId));
  assert.equal(binding.organizationId, s.organizations.get(s.accepted.requestId));
  assert.equal(binding.issuer, TENANT_CONSOLE.issuer);
  assert.equal(binding.clientId, TENANT_CONSOLE.clientId);
  assert.equal(binding.tenantSlug, final.slug);
  assert.equal(binding.identityClass, 'TENANT_USER');
  assert.equal(binding.sourceKind, 'PLATFORM_PROVISIONING');
  assert.equal(binding.evidenceRef, `platform-provisioning:${s.accepted.requestId}`);
  assert.match(binding.evidenceDigest, /^[a-f0-9]{64}$/);
  // ผู้รับรองมาจาก request ไม่ใช่จาก worker
  assert.equal(binding.verifiedByOperatorSubject, OPERATOR.subject);
  assert.deepEqual([binding.revision, binding.isActive], [1, true]);
  assert.equal((await s.audits()).length, 1);

  // เรียกซ้ำด้วยค่าเดิม = คืน revision เดิม ไม่เพิ่ม audit; ค่าต่าง = conflict
  assert.deepEqual(await s.bind(s.f.platform), [{ revision: 1 }]);
  await rejects(
    s.bind(s.f.platform, { ...TENANT_CONSOLE, clientId: 'another-console' }),
    /PLATFORM_BINDING_CONFLICT/,
  );
  assert.equal((await s.audits()).length, 1);
});

test('หลักฐาน first admin ไม่ตรง = tenant ไม่ ACTIVE และไม่มี binding', async (t) => {
  const s = await setup(t, {
    email: () => `someone-else-${randomUUID().slice(0, 8)}@example.test`,
  });
  await rejects(s.drain(), /PLATFORM_BINDING_FIRST_ADMIN_MISMATCH/);
  const final = await s.state();
  assert.deepEqual([final.status, final.tenant.lifecycleStatus], ['RUNNING', 'PROVISIONING']);
  assert.equal((await s.bindings()).length, 0);
});

test('repository ที่ไม่ได้ตั้ง tenant Console ไม่บันทึก binding (Platform API ไม่ปิดงาน saga)', async (t) => {
  const s = await setup(t, { tenantConsole: null });
  await s.drain();
  assert.equal((await s.state()).status, 'SUCCEEDED');
  assert.equal((await s.bindings()).length, 0);
  // operator backfill ภายหลังด้วย role platform ใช้หลักฐานเดียวกัน
  assert.deepEqual(await s.bind(s.f.platform), [{ revision: 1 }]);
  assert.equal((await s.bindings()).length, 1);
});

test('ปฏิเสธก่อน request สำเร็จ, context ที่ไม่ใช่ tenant Console และ role อื่นนอกจาก platform', async (t) => {
  const s = await setup(t);
  await rejects(s.bind(s.f.platform), /PLATFORM_BINDING_REQUEST_NOT_SUCCEEDED/);
  await s.drain();
  await rejects(
    s.bind(s.f.platform, { ...TENANT_CONSOLE, clientId: 'platform-console' }),
    /PLATFORM_BINDING_CONTEXT_INVALID/,
  );
  await rejects(
    s.bind(s.f.platform, { ...TENANT_CONSOLE, issuer: 'not-an-issuer' }),
    /PLATFORM_BINDING_CONTEXT_INVALID/,
  );
  await rejects(s.bind(s.f.provisioner), /permission denied/);
  await rejects(s.bind(s.f.application), /permission denied/);
});

test('tenant app อ่าน binding ได้ภายใต้ RLS แต่เขียนเองไม่ได้', async (t) => {
  const s = await setup(t);
  await s.drain();
  const final = await s.state();
  const userId = firstAdminUserId(s.accepted.requestId);
  await rejects(
    s.f.application.$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=false
      WHERE tenant_id=${s.accepted.tenantId}::uuid`,
    /permission denied/,
  );
  const seen = await s.f.application.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT set_config('app.tenant_id', $1, true)`,
      s.accepted.tenantId,
    );
    // query เดียวกับที่ findTenantConfigurationActor ใช้ตรวจ positive binding
    return transaction.$queryRaw<{ revision: number }[]>`
      SELECT revision FROM tenant_voice_identity_bindings
      WHERE tenant_id=${s.accepted.tenantId}::uuid AND user_id=${userId}::uuid
        AND subject_id=${s.subjects.get(s.accepted.requestId)!} AND issuer=${TENANT_CONSOLE.issuer}
        AND client_id=${TENANT_CONSOLE.clientId} AND tenant_slug=${final.slug}
        AND identity_class='TENANT_USER' AND is_active`;
  });
  assert.deepEqual(
    seen.map((row) => row.revision),
    [1],
  );
});
