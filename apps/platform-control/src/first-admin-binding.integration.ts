/**
 * #901: positive identity binding of the first admin from Platform provisioning — real Postgres, no Keycloak needed
 *
 * - the saga records the binding in the same transaction in which the request becomes SUCCEEDED and the tenant ACTIVE
 * - the DB reads the subject/Organization from the FIRST_ADMIN/KEYCLOAK_ORGANIZATION step results and the attester from requested_by
 *   the caller can send only the deployment's issuer/client
 * - evidence that does not match = tenant not ACTIVE (the whole transaction rolls back); calling again with the same values creates no new revision
 * - the tenant app can read under RLS but cannot call the function or write itself
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

/** port returning a uuid external ref stable per request (in place of the Keycloak Organization) */
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

/** creates the first admin's users row with the same provisioner role as FirstAdminPort and returns the subject */
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
  const grantContactCreate = (client: Fixture['platform']) =>
    client.$queryRaw<{ outcome: string }[]>`
      SELECT dc_platform_grant_first_admin_contact_create(${accepted.tenantId}::uuid,
        ${accepted.requestId}::uuid) AS outcome`;
  const capability = async () => ({
    grants: await f.owner.c360ActorCapabilityGrant.findMany({
      where: { tenantId: accepted.tenantId },
    }),
    commands: await f.owner.c360ProfileCommand.findMany({ where: { tenantId: accepted.tenantId } }),
    receipts: await f.owner.c360ProfileCommandReceipt.findMany({
      where: { tenantId: accepted.tenantId },
    }),
    audits: await f.owner.c360ProfileAudit.findMany({ where: { tenantId: accepted.tenantId } }),
  });
  return {
    f,
    accepted,
    drain,
    state,
    bindings,
    audits,
    bind,
    grantContactCreate,
    capability,
    organizations,
    subjects,
  };
}

async function rejects(work: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(work, (error: unknown) => {
    assert.match(String(error), pattern);
    return true;
  });
}

test('the saga records the first admin binding together with ACTIVE from the evidence of the request itself', async (t) => {
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
  // the attester comes from the request, not from the worker
  assert.equal(binding.verifiedByOperatorSubject, OPERATOR.subject);
  assert.deepEqual([binding.revision, binding.isActive], [1, true]);
  assert.equal((await s.audits()).length, 1);

  // calling again with the same values = returns the same revision, no extra audit; different values = conflict
  assert.deepEqual(await s.bind(s.f.platform), [{ revision: 1 }]);
  await rejects(
    s.bind(s.f.platform, { ...TENANT_CONSOLE, clientId: 'another-console' }),
    /PLATFORM_BINDING_CONFLICT/,
  );
  assert.equal((await s.audits()).length, 1);
});

test('first admin evidence that does not match = tenant not ACTIVE and no binding', async (t) => {
  const s = await setup(t, {
    email: () => `someone-else-${randomUUID().slice(0, 8)}@example.test`,
  });
  await rejects(s.drain(), /PLATFORM_BINDING_FIRST_ADMIN_MISMATCH/);
  const final = await s.state();
  assert.deepEqual([final.status, final.tenant.lifecycleStatus], ['RUNNING', 'PROVISIONING']);
  assert.equal((await s.bindings()).length, 0);
});

test('a repository without the tenant Console configured records no binding (the Platform API does not close the saga)', async (t) => {
  const s = await setup(t, { tenantConsole: null });
  await s.drain();
  assert.equal((await s.state()).status, 'SUCCEEDED');
  assert.equal((await s.bindings()).length, 0);
  // an operator backfills later with the platform role using the same evidence
  assert.deepEqual(await s.bind(s.f.platform), [{ revision: 1 }]);
  assert.equal((await s.bindings()).length, 1);
});

test('rejects before the request succeeds, a context that is not the tenant Console, and any role other than platform', async (t) => {
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

test('the tenant app can read the binding under RLS but cannot write it', async (t) => {
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
    // the same query findTenantConfigurationActor uses to check the positive binding
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

test('#914: the saga grants CONTACT_CREATE to the first admin with command/receipt/audit and a repeat does not duplicate', async (t) => {
  const s = await setup(t);
  await s.drain();
  const userId = firstAdminUserId(s.accepted.requestId);
  const evidence = `platform-provisioning:${s.accepted.requestId}`;
  const first = await s.capability();
  assert.equal(first.grants.length, 1);
  const [grant] = first.grants;
  assert.deepEqual(
    [grant!.granteeUserId, grant!.capability, grant!.evidenceRef, grant!.actorUserId],
    [userId, 'CONTACT_CREATE', evidence, null],
  );
  assert.equal(first.commands.length, 1);
  const [command] = first.commands;
  assert.deepEqual(
    [command!.action, command!.resourceType, command!.resourceId, command!.isTombstone],
    ['CAPABILITY_GRANT', 'USER', userId, false],
  );
  assert.equal(command!.commandId, grant!.commandId);
  assert.match(command!.payloadDigest ?? '', /^[a-f0-9]{64}$/);
  assert.deepEqual(
    first.receipts.map((receipt) => [receipt.outcome, receipt.httpStatus, receipt.resourceRefs]),
    [['APPLIED', 200, [{ type: 'USER', id: userId }]]],
  );
  assert.deepEqual(
    first.audits.map((audit) => [audit.operation, audit.resourceId, audit.evidenceRefs]),
    [['CAPABILITY_GRANT', userId, [evidence, `requested-by:${OPERATOR.subject}`]]],
  );

  // calling again (e.g. a repeated backfill) = NO_OP, no new rows
  assert.deepEqual(await s.grantContactCreate(s.f.platform), [{ outcome: 'NO_OP' }]);
  const again = await s.capability();
  assert.deepEqual(
    [again.grants.length, again.commands.length, again.receipts.length, again.audits.length],
    [1, 1, 1, 1],
  );

  // the same query as authorizeC360ContactCreate under the tenant app's RLS
  const allowed = await s.f.application.$transaction(async (transaction) => {
    await transaction.$executeRawUnsafe(
      `SELECT set_config('app.tenant_id', $1, true)`,
      s.accepted.tenantId,
    );
    return transaction.$queryRaw<{ allowed: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM users u
        JOIN c360_actor_capability_grants g
          ON g.tenant_id = u.tenant_id AND g.grantee_user_id = u.id AND g.capability = 'CONTACT_CREATE'
        WHERE u.tenant_id = ${s.accepted.tenantId}::uuid AND u.id = ${userId}::uuid
          AND u.is_active AND u.role::text = 'ADMIN'
          AND NOT EXISTS (SELECT 1 FROM c360_actor_capability_revocations r
                          WHERE r.tenant_id = g.tenant_id AND r.grant_id = g.id)
      ) AS allowed`;
  });
  assert.deepEqual(allowed, [{ allowed: true }]);
});

test('#914: after revoking, a repeat does not grant again; a binding is required first; only the platform role can call it', async (t) => {
  const s = await setup(t, { tenantConsole: null });
  await s.drain();
  assert.equal((await s.state()).status, 'SUCCEEDED');
  // no binding for this request = we do not know who the verified first admin is
  await rejects(s.grantContactCreate(s.f.platform), /PLATFORM_CAPABILITY_BINDING_MISSING/);
  await rejects(s.grantContactCreate(s.f.provisioner), /permission denied/);
  await rejects(s.grantContactCreate(s.f.application), /permission denied/);

  // backfill of an existing tenant: bind then grant with the platform role
  await s.bind(s.f.platform);
  assert.deepEqual(await s.grantContactCreate(s.f.platform), [{ outcome: 'APPLIED' }]);
  const [grant] = (await s.capability()).grants;
  await s.f.owner.c360ActorCapabilityRevocation.create({
    data: {
      id: randomUUID(),
      tenantId: s.accepted.tenantId,
      grantId: grant!.id,
      actorIdentityKey: grant!.actorIdentityKey,
      commandId: grant!.commandId,
      actorUserId: null,
      reason: 'TEST_REVOKE',
      evidenceRef: 'ticket:TEST-914',
    },
  });
  assert.deepEqual(await s.grantContactCreate(s.f.platform), [{ outcome: 'NO_OP' }]);
  assert.equal((await s.capability()).grants.length, 1);
});
