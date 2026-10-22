import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { AddressInfo } from 'node:net';
import { HttpException, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { TenantPeopleController, TENANT_PEOPLE_READINESS } from './tenant-people-api.js';
import { TENANT_VOICE_DATABASE, TenantVoiceCatalogController } from './tenant-voice-catalog-api.js';
import {
  OidcGlobalGuard,
  OIDC_ACCESS_TOKEN_VERIFIER,
  TENANT_LIFECYCLE,
  GATEWAY_DIAGNOSTICS,
} from './gateway-auth.js';
import type { VoiceActor } from './tenant-voice-catalog.js';
import { TenantPeopleRuntime } from './tenant-people-runtime.js';
import { runPeopleActivation } from './tenant-people-activation.js';
import {
  claimPeopleOperation,
  recordPeopleStep,
  runPeopleWorkerStep,
  type PeopleStepOutcome,
} from './tenant-people-worker.js';
import {
  runPeopleInvitationAttempt,
  reconcilePeopleInvitationAttempt,
  type PeopleInvitationAttempt,
} from './tenant-people-invitation-worker.js';

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const body = await response.json();
  assert.ok(body && typeof body === 'object' && !Array.isArray(body));
  return Object.fromEntries(Object.entries(body));
}

async function readAccepted(response: Response) {
  const body = await readObject(response);
  assert.ok(typeof body.operationId === 'string');
  assert.ok(typeof body.userId === 'string');
  assert.ok(typeof body.location === 'string');
  assert.equal(body.status, 'ACCEPTED');
  return {
    operationId: body.operationId,
    userId: body.userId,
    location: body.location,
    status: body.status,
  };
}

test('People authenticated HTTP → PostgreSQL/RLS: acceptance/readback/replay และ quota/สิทธิ์', async () => {
  const owner = new PrismaClient();
  const workerUrl = new URL(
    process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:15438/dcontact',
  );
  workerUrl.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
  const worker = new PrismaClient({ datasources: { db: { url: workerUrl.toString() } } });
  const application = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@127.0.0.1:15438/dcontact?schema=public',
      },
    },
  });
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    adminId = randomUUID();
  const slug = `b2-${tenantId}`;
  const node = {
    telephonyNodeId: 'sandbox-node',
    releaseDigest: 'b'.repeat(64),
    dialplanDigest: 'c'.repeat(64),
    extensions: ['1104', '1105'],
  };
  const pool = node.extensions.map((ref) => ({
    ref,
    telephonyNodeId: node.telephonyNodeId,
    releaseDigest: node.releaseDigest,
    dialplanDigest: node.dialplanDigest,
  }));
  let app: INestApplication | undefined;
  try {
    await owner.tenant.create({
      data: { id: tenantId, name: 'B2 isolated acceptance', slug, sipDomain: `${slug}.test` },
    });
    await owner.team.create({ data: { id: teamId, tenantId, name: 'B2 isolated team' } });
    await owner.user.create({
      data: {
        id: adminId,
        tenantId,
        teamId,
        keycloakId: adminId,
        email: `${adminId}@b2.test`,
        displayName: 'B2 Admin',
        role: 'ADMIN',
        passwordHash: '!keycloak-managed',
      },
    });
    await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active) VALUES(${tenantId}::uuid,${adminId}::uuid,'https://b2-idp.test/realms/dcontact',${adminId},'dcontact-console',${slug},${tenantId}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','isolated-bootstrap-manifest',${'a'.repeat(64)},'sandbox-operator',now(),1,true)`;
    await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,extension_pool) VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',5,1,1,1,'sandbox-operator',now(),'isolated-test','ทดสอบ reservation เท่านั้น',${JSON.stringify(pool)}::jsonb)`;
    const actor: VoiceActor = {
      tenantId,
      userId: adminId,
      roles: ['admin'],
      caller: {
        issuer: 'https://b2-idp.test/realms/dcontact',
        subject: adminId,
        clientId: 'dcontact-console',
        tenantSlug: slug,
      },
    };
    const command = {
      commandId: randomUUID(),
      teamId,
      displayName: 'B2 ผู้ทดสอบ',
      email: `${randomUUID()}@b2.test`,
      role: 'AGENT',
      extensionRef: '1104',
    };
    let ready = false;
    let reconcileReady = false;
    let resendReady = false;
    const verifyAccessToken = async (token: string) => {
      if (!['admin', 'protected', 'agent'].includes(token)) throw Error('invalid test token');
      return {
        iss: actor.caller!.issuer,
        sub: adminId,
        azp: 'dcontact-console',
        tenant_id: tenantId,
        tenant_slug: slug,
        organization: { [slug]: { tenant_id: [tenantId] } },
        dc_user_id: adminId,
        sid: 'b2-test-session',
        exp: 2_000_000_000,
        realm_access: { roles: token === 'agent' ? ['agent'] : ['admin'] },
        dc_identity_class: token === 'protected' ? 'PLATFORM_USER' : 'TENANT_USER',
      };
    };
    @Module({
      controllers: [TenantPeopleController, TenantVoiceCatalogController],
      providers: [
        { provide: TENANT_VOICE_DATABASE, useValue: application },
        {
          provide: TENANT_PEOPLE_READINESS,
          useValue: {
            isReady: async () => ready,
            nodesForTenant: () => [node],
            canReconcileInvitation: async () => reconcileReady,
            canResendInvitation: async () => resendReady,
          },
        },
        { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: { verifyAccessToken } },
        { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
        { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
        { provide: APP_GUARD, useClass: OidcGlobalGuard },
      ],
    })
    class TestModule {}
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/tenant-voice`;
    const request = (path: string, body?: unknown, token = 'admin') =>
      fetch(base + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    assert.equal((await request('/people/users', command)).status, 503);
    ready = true;
    assert.equal((await request('/people/users', command, 'invalid')).status, 401);
    assert.equal((await request('/people/users', command, 'agent')).status, 403);
    assert.equal((await request('/people/users', command, 'protected')).status, 403);
    assert.equal(
      (await request('/people/users', { ...command, tenantId: randomUUID() })).status,
      400,
    );
    const response = await request('/people/users', command);
    const failure = response.status === 202 ? '' : await response.clone().text();
    assert.equal(response.status, 202, failure);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const accepted = await readAccepted(response);
    assert.equal(response.headers.get('location'), accepted.location);
    assert.equal(accepted.status, 'ACCEPTED');
    const replay = await request('/people/users', command);
    assert.equal(replay.status, 202);
    assert.deepEqual(await replay.json(), accepted);
    const readback = await request(`/operations/${accepted.operationId}`);
    assert.equal(readback.status, 200);
    const operation = await readObject(readback);
    assert.equal(operation.state, 'QUEUED');
    assert.equal(operation.accountState, 'PROVISIONING');
    assert.equal(operation.activationState, 'PENDING');
    for (const field of ['email', 'payload', 'password', 'leaseOwner', 'fencingToken'])
      assert.equal(field in operation, false);
    assert.equal(
      (await request(`/operations/${accepted.operationId}`, undefined, 'agent')).status,
      403,
    );
    assert.equal((await request(`/operations/${randomUUID()}`)).status, 404);
    const state = await withTenantDatabaseTransaction(
      application,
      tenantId,
      async (transaction) => {
        const user = await transaction.user.findUniqueOrThrow({ where: { id: accepted.userId } });
        const operations = await transaction.$queryRaw<
          { state: string; step: string }[]
        >`SELECT state,step FROM tenant_people_operations WHERE tenant_id=${tenantId}::uuid AND id=${accepted.operationId}::uuid`;
        const reservations = await transaction.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM tenant_identity_reservations WHERE tenant_id=${tenantId}::uuid AND target_user_id=${accepted.userId}::uuid`;
        const lifecycle = await transaction.$queryRaw<
          { accountState: string; activationState: string }[]
        >`SELECT account_state AS "accountState",activation_state AS "activationState" FROM tenant_user_lifecycles WHERE tenant_id=${tenantId}::uuid AND user_id=${accepted.userId}::uuid`;
        return { user, operations, reservations, lifecycle };
      },
    );
    assert.equal(state.user.isActive, false);
    assert.equal(state.user.keycloakId, null);
    assert.equal(state.user.passwordHash, '!keycloak-managed');
    assert.deepEqual(state.operations, [{ state: 'QUEUED', step: 'RESERVE' }]);
    assert.equal(state.reservations[0].count, 2n);
    await assert.rejects(
      () =>
        owner.$executeRaw`UPDATE tenant_voice_provisioning_policies SET revision=revision+1,accounts_limit=accounts_limit+1 WHERE tenant_id=${tenantId}::uuid`,
    );
    assert.deepEqual(state.lifecycle, [
      { accountState: 'PROVISIONING', activationState: 'PENDING' },
    ]);
    const changed = await request('/people/users', { ...command, displayName: 'different' });
    assert.equal(changed.status, 409);
    assert.equal((await readObject(changed)).code, 'COMMAND_PAYLOAD_MISMATCH');
    const quota = await request('/people/users', {
      ...command,
      commandId: randomUUID(),
      email: `${randomUUID()}@b2.test`,
      extensionRef: '1105',
    });
    assert.equal(quota.status, 429);
    assert.equal((await readObject(quota)).code, 'RESOURCE_LIMIT_REACHED');
    const count = await withTenantDatabaseTransaction(application, tenantId, (transaction) =>
      transaction.user.count({ where: { tenantId } }),
    );
    assert.equal(count, 2);
    const supervisorCommand = {
      commandId: randomUUID(),
      teamId,
      displayName: 'B2 Supervisor',
      email: `${randomUUID()}@b2.test`,
      role: 'SUPERVISOR',
    };
    const concurrent = await Promise.all([
      request('/people/users', supervisorCommand),
      request('/people/users', supervisorCommand),
    ]);
    for (const concurrentResponse of concurrent) assert.equal(concurrentResponse.status, 202);
    const supervisor = await readAccepted(concurrent[0]);
    assert.deepEqual(await readAccepted(concurrent[1]), supervisor);
    const adminResponse = await request('/people/users', {
      commandId: randomUUID(),
      teamId,
      displayName: 'B2 Pending Admin',
      email: `${randomUUID()}@b2.test`,
      role: 'ADMIN',
    });
    assert.equal(adminResponse.status, 202);
    const pendingAdmin = await readAccepted(adminResponse);
    const createdRoles = await withTenantDatabaseTransaction(application, tenantId, (transaction) =>
      transaction.user.findMany({
        where: { id: { in: [supervisor.userId, pendingAdmin.userId] } },
        select: { role: true, isActive: true, keycloakId: true, extension: true },
        orderBy: { role: 'asc' },
      }),
    );
    assert.deepEqual(createdRoles, [
      { role: 'SUPERVISOR', isActive: false, keycloakId: null, extension: null },
      { role: 'ADMIN', isActive: false, keycloakId: null, extension: null },
    ]);
    const expiredLeaseUser = await readAccepted(
      await request('/people/users', {
        ...supervisorCommand,
        commandId: randomUUID(),
        email: `${randomUUID()}@b2.test`,
      }),
    );
    const exhausted = await request('/people/users', {
      ...supervisorCommand,
      commandId: randomUUID(),
      email: `${randomUUID()}@b2.test`,
    });
    assert.equal(exhausted.status, 429);
    const afterConcurrent = await withTenantDatabaseTransaction(
      application,
      tenantId,
      (transaction) => transaction.user.count({ where: { tenantId } }),
    );
    assert.equal(afterConcurrent, 5);
    await owner.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref) VALUES(${tenantId}::uuid,session_user,'isolated-worker-boundary')`;
    const workerRole = await worker.$queryRaw<{ role: string }[]>`SELECT current_user AS role`;
    assert.equal(workerRole[0].role, 'dcontact_tenant_people_worker');
    const roleFlags = await worker.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }[]
    >`SELECT rolsuper,rolbypassrls,rolcanlogin FROM pg_roles WHERE rolname=current_user`;
    assert.deepEqual(roleFlags, [{ rolsuper: false, rolbypassrls: false, rolcanlogin: false }]);
    await owner.user.update({
      where: { id: accepted.userId },
      data: { displayName: 'Changed after acceptance' },
    });
    const contenders = await Promise.all([
      claimPeopleOperation(worker, tenantId, accepted.operationId, 'worker-first'),
      claimPeopleOperation(worker, tenantId, accepted.operationId, 'worker-second'),
    ]);
    assert.equal(contenders.filter(Boolean).length, 1);
    const firstClaim = contenders.find((claim) => claim !== null);
    assert.ok(firstClaim);
    assert.equal(firstClaim.step, 'CREATE_IDENTITY');
    assert.equal(firstClaim.command.displayName, command.displayName);
    assert.equal(firstClaim.reconcileOnly, false);
    assert.equal(
      await recordPeopleStep(
        worker,
        { ...firstClaim, owner: 'worker-unrelated' },
        { outcome: 'SUCCEEDED', receiptRef: 'sandbox-receipt' },
      ),
      'STALE',
    );
    assert.equal(await recordPeopleStep(worker, firstClaim, { outcome: 'UNKNOWN' }), 'RECORDED');
    assert.equal(await recordPeopleStep(worker, firstClaim, { outcome: 'UNKNOWN' }), 'RECORDED');
    const unknown = await readObject(await request(`/operations/${accepted.operationId}`));
    assert.equal(unknown.state, 'WAITING_EXTERNAL');
    assert.equal(unknown.provisioningState, 'UNKNOWN');
    const reconcile = await claimPeopleOperation(
      worker,
      tenantId,
      accepted.operationId,
      'worker-reconcile',
    );
    assert.ok(reconcile);
    assert.equal(reconcile.reconcileOnly, true);
    assert.equal(reconcile.step, 'CREATE_IDENTITY');
    assert.ok(BigInt(reconcile.fencingToken) > BigInt(firstClaim.fencingToken));
    assert.equal(
      await recordPeopleStep(worker, reconcile, {
        outcome: 'SUCCEEDED',
        receiptRef: 'sandbox-correlated-receipt',
      }),
      'RECORDED',
    );
    const next = await claimPeopleOperation(worker, tenantId, accepted.operationId, 'worker-next');
    assert.ok(next);
    assert.equal(next.step, 'TENANT_ROLE');
    await owner.$executeRaw`UPDATE tenant_people_operations SET lease_expires_at=clock_timestamp()-interval '1 second',revision=revision+1 WHERE tenant_id=${tenantId}::uuid AND id=${accepted.operationId}::uuid`;
    const recovered = await claimPeopleOperation(
      worker,
      tenantId,
      accepted.operationId,
      'worker-after-expiry',
    );
    assert.ok(recovered);
    assert.equal(recovered.reconcileOnly, true);
    assert.equal(recovered.step, 'TENANT_ROLE');
    assert.equal(
      await recordPeopleStep(worker, next, { outcome: 'SUCCEEDED', receiptRef: 'late-old-worker' }),
      'STALE',
    );
    assert.equal(await recordPeopleStep(worker, recovered, { outcome: 'UNKNOWN' }), 'RECORDED');
    await assert.rejects(() =>
      withTenantDatabaseTransaction(
        worker,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`INSERT INTO tenant_people_step_receipts(tenant_id,operation_id,step,fencing_token,payload_digest,outcome) VALUES(${tenantId}::uuid,${accepted.operationId}::uuid,'TENANT_ROLE',9999,${recovered.payloadDigest},'UNKNOWN')`,
      ),
    );
    await assert.rejects(() =>
      withTenantDatabaseTransaction(
        worker,
        tenantId,
        (transaction) =>
          transaction.$queryRaw`SELECT email FROM users WHERE id=${accepted.userId}::uuid`,
      ),
    );
    await assert.rejects(() =>
      withTenantDatabaseTransaction(
        worker,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`UPDATE tenant_people_operations SET payload_digest=${'0'.repeat(64)} WHERE id=${accepted.operationId}::uuid`,
      ),
    );
    await assert.rejects(() =>
      withTenantDatabaseTransaction(
        worker,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref) VALUES(${tenantId}::uuid,'unapproved-worker','not-allowed')`,
      ),
    );
    await owner.$executeRaw`UPDATE tenant_people_operations SET step='VERIFY_PROVISIONED',revision=revision+1 WHERE tenant_id=${tenantId}::uuid AND id=${pendingAdmin.operationId}::uuid`;
    const terminal = await claimPeopleOperation(
      worker,
      tenantId,
      pendingAdmin.operationId,
      'worker-terminal',
    );
    assert.ok(terminal);
    await assert.rejects(
      () =>
        recordPeopleStep(worker, terminal, {
          outcome: 'SUCCEEDED',
          receiptRef: 'unverified-identity',
        }),
      (error) => {
        assert.ok(error instanceof HttpException);
        assert.equal(error.getStatus(), 409);
        assert.deepEqual(error.getResponse(), { code: 'PEOPLE_IDENTITY_NOT_VERIFIED' });
        return true;
      },
    );
    assert.equal(
      await recordPeopleStep(worker, terminal, {
        outcome: 'UNKNOWN',
        reasonCode: 'CORRELATION_CONFLICT',
      }),
      'RECORDED',
    );
    assert.equal(
      await recordPeopleStep(worker, terminal, {
        outcome: 'UNKNOWN',
        reasonCode: 'CORRELATION_CONFLICT',
      }),
      'RECORDED',
    );
    const attention = await readObject(await request(`/operations/${pendingAdmin.operationId}`));
    assert.equal(attention.state, 'ACTION_REQUIRED');
    assert.equal(attention.errorCode, 'CORRELATION_CONFLICT');
    assert.equal(attention.accountState, 'ATTENTION_REQUIRED');
    assert.equal(
      await claimPeopleOperation(worker, tenantId, pendingAdmin.operationId, 'worker-must-stop'),
      null,
    );
    const anotherTenant = randomUUID(),
      foreignUser = randomUUID();
    await owner.tenant.create({
      data: {
        id: anotherTenant,
        name: 'Unbound worker tenant',
        slug: `b2-${anotherTenant}`,
        sipDomain: `${anotherTenant}.test`,
      },
    });
    await owner.user.create({
      data: {
        id: foreignUser,
        tenantId: anotherTenant,
        email: `${foreignUser}@b2.test`,
        displayName: 'Foreign worker target',
        passwordHash: '!keycloak-managed',
      },
    });
    const deniedWorkerRows = await withTenantDatabaseTransaction(
      worker,
      anotherTenant,
      (transaction) => transaction.$queryRaw`SELECT id FROM users WHERE id=${foreignUser}::uuid`,
    );
    assert.deepEqual(deniedWorkerRows, []);
    const retained = await withTenantDatabaseTransaction(application, tenantId, (transaction) =>
      transaction.user.findUniqueOrThrow({
        where: { id: accepted.userId },
        select: { isActive: true, keycloakId: true },
      }),
    );
    assert.deepEqual(retained, { isActive: false, keycloakId: null });
    let mutationAttempts = 0,
      readAttempts = 0;
    const identityPort = {
      async mutateStep(): Promise<PeopleStepOutcome> {
        mutationAttempts++;
        throw Error('simulated response lost after possible provider effect');
      },
      async readOutcome(): Promise<PeopleStepOutcome> {
        readAttempts++;
        return readAttempts === 1
          ? { outcome: 'UNKNOWN' }
          : { outcome: 'SUCCEEDED', receiptRef: 'correlated-readback-receipt' };
      },
    };
    assert.equal(
      await runPeopleWorkerStep(
        worker,
        identityPort,
        tenantId,
        supervisor.operationId,
        'orchestrator-first',
      ),
      'RECORDED',
    );
    assert.equal(
      await runPeopleWorkerStep(
        worker,
        identityPort,
        tenantId,
        supervisor.operationId,
        'orchestrator-reconcile-one',
      ),
      'RECORDED',
    );
    assert.equal(
      await runPeopleWorkerStep(
        worker,
        identityPort,
        tenantId,
        supervisor.operationId,
        'orchestrator-reconcile-two',
      ),
      'RECORDED',
    );
    assert.equal(mutationAttempts, 1);
    assert.equal(readAttempts, 2);
    const recoveredStatus = await readObject(
      await request(`/operations/${supervisor.operationId}`),
    );
    assert.equal(recoveredStatus.state, 'QUEUED');
    assert.equal(recoveredStatus.step, 'TENANT_ROLE');
    assert.equal(recoveredStatus.provisioningState, 'PENDING');
    const beforeInvitation = await readObject(await request(`/people/users/${supervisor.userId}`));
    assert.equal(beforeInvitation.deliveryState, 'NOT_STARTED');
    assert.equal(beforeInvitation.invitationGeneration, null);
    for (const step of [
      'TENANT_ROLE',
      'ORG_MEMBERSHIP',
      'VERIFY_MAPPING',
      'INVITATION_INTENT',
      'VERIFY_PROVISIONED',
    ]) {
      const provision = await claimPeopleOperation(
        worker,
        tenantId,
        supervisor.operationId,
        'worker-provision',
      );
      assert.ok(provision);
      assert.equal(provision.step, step);
      if (step === 'VERIFY_MAPPING' || step === 'VERIFY_PROVISIONED') {
        await assert.rejects(() =>
          recordPeopleStep(worker, provision, {
            outcome: 'SUCCEEDED',
            receiptRef: `missing-proof-${step}`,
          }),
        );
      }
      assert.equal(
        await recordPeopleStep(worker, provision, {
          outcome: 'SUCCEEDED',
          receiptRef: `verified-${step}`,
          ...(step === 'VERIFY_MAPPING' || step === 'VERIFY_PROVISIONED'
            ? { identityId: supervisor.userId }
            : {}),
        }),
        'RECORDED',
      );
    }
    const provisionedStatus = await readObject(
      await request(`/operations/${supervisor.operationId}`),
    );
    assert.equal(provisionedStatus.state, 'SUCCEEDED');
    assert.equal(provisionedStatus.provisioningState, 'PROVISIONED');
    assert.equal(provisionedStatus.accountState, 'PENDING_ACTIVATION');
    assert.equal(provisionedStatus.activationState, 'PENDING');
    const pendingInvitation = await readObject(await request(`/people/users/${supervisor.userId}`));
    assert.equal(pendingInvitation.deliveryState, 'INTENT');
    assert.equal(pendingInvitation.invitationGeneration, 1);
    assert.equal(pendingInvitation.invitationExpiresAt, null);
    assert.equal(pendingInvitation.activationState, 'PENDING');
    assert.equal(pendingInvitation.isActive, false);
    assert.equal('providerAttemptRef' in pendingInvitation, false);
    assert.equal('actionLink' in pendingInvitation, false);
    assert.deepEqual(
      await readAccepted(await request('/people/users', supervisorCommand)),
      supervisor,
    );
    assert.equal(
      await runPeopleWorkerStep(
        worker,
        {
          async mutateStep() {
            assert.fail('completed provisioning must not dispatch an invitation');
          },
          async readOutcome() {
            assert.fail('completed provisioning has no provider step to reconcile');
          },
        },
        tenantId,
        supervisor.operationId,
        'worker-after-provisioned',
      ),
      'BUSY',
    );
    assert.deepEqual(
      await readObject(await request(`/people/users/${supervisor.userId}`)),
      pendingInvitation,
    );
    assert.deepEqual(
      await withTenantDatabaseTransaction(
        application,
        randomUUID(),
        (transaction) =>
          transaction.$queryRaw`SELECT generation FROM tenant_people_invitation_intents WHERE user_id=${supervisor.userId}::uuid`,
      ),
      [],
    );
    for (const principal of [application, worker]) {
      await assert.rejects(() =>
        withTenantDatabaseTransaction(
          principal,
          tenantId,
          (transaction) =>
            transaction.$executeRaw`UPDATE tenant_people_invitation_intents SET generation=generation+1 WHERE user_id=${supervisor.userId}::uuid`,
        ),
      );
      await assert.rejects(() =>
        withTenantDatabaseTransaction(
          principal,
          tenantId,
          (transaction) =>
            transaction.$executeRaw`DELETE FROM tenant_people_invitation_intents WHERE user_id=${supervisor.userId}::uuid`,
        ),
      );
    }
    let invitationSends = 0;
    reconcileReady = true;
    const notStarted = await readAccepted(
      await request(`/people/users/${supervisor.userId}/reconcile`, {
        commandId: randomUUID(),
        expectedRevision: 1,
        reasonCode: 'DELIVERY_CHECK',
        reason: 'ตรวจโดยไม่เริ่มส่งคำเชิญ',
      }),
    );
    const reconcileWorker = await import('./tenant-people-invitation-reconcile.js');
    assert.equal(
      await reconcileWorker.runNextPeopleInvitationReconcile(
        worker,
        {
          async readOutcome() {
            assert.fail('reconcile INTENT ต้องไม่เรียก provider');
          },
        },
        tenantId,
      ),
      true,
    );
    const notStartedResult = await readObject(
      await request(`/operations/${notStarted.operationId}`),
    );
    assert.equal(notStartedResult.state, 'ACTION_REQUIRED');
    assert.equal(notStartedResult.errorCode, 'INVITATION_DISPATCH_NOT_STARTED');
    reconcileReady = false;
    assert.equal(
      await reconcilePeopleInvitationAttempt(
        worker,
        {
          async readOutcome() {
            assert.fail('INTENT ไม่มี frozen dispatch ให้ reconcile');
          },
        },
        tenantId,
        supervisor.operationId,
      ),
      'NOT_ELIGIBLE',
    );
    assert.equal(
      (await readObject(await request(`/people/users/${supervisor.userId}`))).deliveryState,
      'INTENT',
    );
    let invitationLookups = 0;
    let dispatchObservedState: unknown;
    const invitationProvider = {
      async dispatch() {
        invitationSends++;
        dispatchObservedState = (
          await readObject(await request(`/people/users/${supervisor.userId}`))
        ).deliveryState;
        throw new Error('response lost after provider admission');
      },
      async readOutcome() {
        invitationLookups++;
        return { outcome: 'UNKNOWN' as const };
      },
    };
    await Promise.all(
      ['invitation-worker-a', 'invitation-worker-b', 'invitation-worker-c'].map((ownerId) =>
        runPeopleInvitationAttempt(
          worker,
          invitationProvider,
          tenantId,
          supervisor.operationId,
          ownerId,
        ),
      ),
    );
    assert.equal(invitationSends, 1);
    assert.equal(invitationLookups, 2);
    assert.ok(['DISPATCHING', 'AMBIGUOUS'].includes(String(dispatchObservedState)));
    const ambiguousInvitation = await readObject(
      await request(`/people/users/${supervisor.userId}`),
    );
    assert.equal(ambiguousInvitation.deliveryState, 'AMBIGUOUS');
    assert.equal(ambiguousInvitation.invitationGeneration, 1);
    assert.equal(ambiguousInvitation.activationState, 'PENDING');
    await reconcilePeopleInvitationAttempt(
      worker,
      invitationProvider,
      tenantId,
      supervisor.operationId,
    );
    assert.equal(invitationSends, 1);
    assert.equal(invitationLookups, 3);
    const reconcileCommand = {
      commandId: randomUUID(),
      expectedRevision: 1,
      reasonCode: 'DELIVERY_CHECK',
      reason: 'ตรวจผลการส่งเดิมโดยไม่ส่งใหม่',
    };
    const reconcilePath = `/people/users/${supervisor.userId}/reconcile`;
    assert.equal((await request(reconcilePath, reconcileCommand)).status, 503);
    reconcileReady = true;
    assert.equal((await request(reconcilePath, reconcileCommand, 'agent')).status, 403);
    assert.equal((await request(reconcilePath, reconcileCommand, 'protected')).status, 403);
    assert.equal((await request(reconcilePath, { ...reconcileCommand, tenantId })).status, 400);
    assert.equal((await request(reconcilePath, { ...reconcileCommand, reason: '' })).status, 400);
    assert.equal(
      (await request(`/people/users/${randomUUID()}/reconcile`, reconcileCommand)).status,
      404,
    );
    assert.equal(
      (await request(reconcilePath, { ...reconcileCommand, expectedRevision: 2 })).status,
      409,
    );
    const reconcileResponse = await request(reconcilePath, reconcileCommand);
    assert.equal(reconcileResponse.status, 202);
    assert.equal(reconcileResponse.headers.get('cache-control'), 'no-store');
    const reconcileAccepted = await readAccepted(reconcileResponse);
    assert.equal(reconcileResponse.headers.get('location'), reconcileAccepted.location);
    assert.deepEqual(
      await readAccepted(await request(reconcilePath, reconcileCommand)),
      reconcileAccepted,
    );
    const concurrentReplays = await Promise.all([
      request(reconcilePath, reconcileCommand),
      request(reconcilePath, reconcileCommand),
    ]);
    for (const replayResponse of concurrentReplays)
      assert.deepEqual(await readAccepted(replayResponse), reconcileAccepted);
    assert.deepEqual(
      (await readObject(await request(`/commands/${reconcileCommand.commandId}`))).result,
      { ...reconcileAccepted, generation: 1 },
    );
    assert.equal(
      (await request(reconcilePath, { ...reconcileCommand, reason: 'เหตุผลคนละค่า' })).status,
      409,
    );
    assert.equal(
      (await readObject(await request(`/operations/${reconcileAccepted.operationId}`))).state,
      'QUEUED',
    );
    const { runNextPeopleInvitationReconcile } =
      await import('./tenant-people-invitation-reconcile.js');
    assert.equal(
      await runNextPeopleInvitationReconcile(
        worker,
        { readOutcome: invitationProvider.readOutcome },
        tenantId,
      ),
      true,
    );
    const reconcileResult = await readObject(
      await request(`/operations/${reconcileAccepted.operationId}`),
    );
    assert.equal(reconcileResult.state, 'ACTION_REQUIRED');
    assert.equal(reconcileResult.errorCode, 'INVITATION_DELIVERY_AMBIGUOUS');
    assert.equal(invitationSends, 1);
    assert.equal(invitationLookups, 4);
    const audit = await owner.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM voice_config_audit WHERE tenant_id=${tenantId}::uuid AND command_id=${reconcileCommand.commandId}::uuid AND action='RECONCILE_TENANT_INVITATION' AND outcome='ACCEPTED' AND reason_code='DELIVERY_CHECK'`;
    assert.equal(audit[0]?.count, 1n);
    for (const principal of [application, worker]) {
      await assert.rejects(() =>
        withTenantDatabaseTransaction(
          principal,
          tenantId,
          (transaction) =>
            transaction.$executeRaw`UPDATE tenant_people_invitation_reconciles SET reason='เปลี่ยนเหตุผล' WHERE id=${reconcileAccepted.operationId}::uuid`,
        ),
      );
      await assert.rejects(() =>
        withTenantDatabaseTransaction(
          principal,
          tenantId,
          (transaction) =>
            transaction.$executeRaw`DELETE FROM tenant_people_invitation_reconciles WHERE id=${reconcileAccepted.operationId}::uuid`,
        ),
      );
      assert.deepEqual(
        await withTenantDatabaseTransaction(
          principal,
          randomUUID(),
          (transaction) =>
            transaction.$queryRaw`SELECT id FROM tenant_people_invitation_reconciles WHERE id=${reconcileAccepted.operationId}::uuid`,
        ),
        [],
      );
    }
    assert.equal(
      (await readObject(await request(`/people/users/${supervisor.userId}`))).configRevision,
      1,
    );
    for (const field of ['providerAttemptRef', 'leaseOwner', 'payload', 'reason', 'actionLink'])
      assert.equal(field in reconcileResult, false);
    const completionProof = (attempt: PeopleInvitationAttempt) => ({
      ...attempt,
      outcome: 'SENT' as const,
      receiptRef: 'd'.repeat(64),
      quiescent: true as const,
      notBeforeEpoch: 4102444800,
      issuedAtEpoch: 4102444800,
    });
    let rejectedProofDispatches = 0;
    for (const mismatch of [
      { tenantId: randomUUID() },
      { operationId: randomUUID() },
      { userId: randomUUID() },
      { generation: 2 },
      { providerAttemptRef: randomUUID() },
      { payloadDigest: 'e'.repeat(64) },
      { fencingToken: '2' },
      { leaseOwner: 'different-send-lease' },
      { quiescent: false },
      { notBeforeEpoch: 4102444801 },
      { issuedAtEpoch: 1.5 },
      { receiptRef: 'not-an-exact-provider-receipt' },
    ]) {
      assert.equal(
        await runPeopleInvitationAttempt(
          worker,
          {
            async dispatch() {
              rejectedProofDispatches++;
              assert.fail('ambiguous attempt must not send again');
            },
            async readOutcome(attempt) {
              return { ...completionProof(attempt), ...mismatch };
            },
          },
          tenantId,
          supervisor.operationId,
          'wrong-attempt-proof',
        ),
        'AMBIGUOUS',
      );
      assert.equal(
        (await readObject(await request(`/people/users/${supervisor.userId}`))).deliveryState,
        'AMBIGUOUS',
      );
    }
    assert.equal(rejectedProofDispatches, 0);
    assert.equal(
      await runPeopleInvitationAttempt(
        worker,
        {
          async dispatch() {
            assert.fail('late receipt must reconcile without another send');
          },
          async readOutcome(attempt) {
            return completionProof(attempt);
          },
        },
        tenantId,
        supervisor.operationId,
        'exact-attempt-proof',
      ),
      'RECORDED',
    );
    const sentInvitation = await readObject(await request(`/people/users/${supervisor.userId}`));
    assert.equal(sentInvitation.deliveryState, 'SENT');
    assert.equal(sentInvitation.invitationExpiresAt, '2100-01-04T00:00:00.000Z');
    assert.equal(sentInvitation.activationState, 'PENDING');
    assert.equal(sentInvitation.isActive, false);
    assert.equal('receiptRef' in sentInvitation, false);
    assert.equal(
      await runPeopleInvitationAttempt(
        worker,
        {
          async dispatch() {
            assert.fail('finished receipt must not dispatch');
          },
          async readOutcome() {
            assert.fail('finished receipt must not call the provider again');
          },
        },
        tenantId,
        supervisor.operationId,
        'finished-attempt-reader',
      ),
      'RECORDED',
    );
    for (const step of [
      'CREATE_IDENTITY',
      'TENANT_ROLE',
      'ORG_MEMBERSHIP',
      'VERIFY_MAPPING',
      'INVITATION_INTENT',
      'VERIFY_PROVISIONED',
    ]) {
      if (step === 'INVITATION_INTENT') {
        await owner.$executeRaw`INSERT INTO tenant_people_invitation_intents(tenant_id,operation_id,user_id,created_at)
          VALUES(${tenantId}::uuid,${expiredLeaseUser.operationId}::uuid,${expiredLeaseUser.userId}::uuid,clock_timestamp()-interval '1 day')`;
      }
      const provision = await claimPeopleOperation(
        worker,
        tenantId,
        expiredLeaseUser.operationId,
        'expired-lease-provisioner',
      );
      assert.ok(provision);
      assert.equal(provision.step, step);
      await recordPeopleStep(worker, provision, {
        outcome: 'SUCCEEDED',
        receiptRef: `expired-lease-${step}`,
        ...(step.startsWith('VERIFY_') ? { identityId: expiredLeaseUser.userId } : {}),
      });
    }
    await owner.$executeRaw`INSERT INTO tenant_people_invitation_dispatches
      (tenant_id,operation_id,user_id,generation,provider_attempt_ref,lease_owner,started_at,lease_expires_at)
      SELECT tenant_id,operation_id,user_id,generation,provider_attempt_ref,'crashed-old-send',clock_timestamp()-interval '3 minutes',clock_timestamp()-interval '2 minutes'
      FROM tenant_people_invitation_intents WHERE tenant_id=${tenantId}::uuid AND operation_id=${expiredLeaseUser.operationId}::uuid`;
    assert.equal(
      (await readObject(await request(`/people/users/${expiredLeaseUser.userId}`))).deliveryState,
      'DISPATCHING',
    );
    assert.equal(
      await runPeopleInvitationAttempt(
        worker,
        {
          async dispatch() {
            assert.fail('old intent and expired send lease are not retry authority');
          },
          async readOutcome(attempt) {
            assert.equal(attempt.leaseOwner, 'crashed-old-send');
            return {
              ...completionProof(attempt),
              notBeforeEpoch: 946684800,
              issuedAtEpoch: 946684800,
            };
          },
        },
        tenantId,
        expiredLeaseUser.operationId,
        'expired-lease-reconciler',
      ),
      'RECORDED',
    );
    const expiredInvitation = await readObject(
      await request(`/people/users/${expiredLeaseUser.userId}`),
    );
    assert.equal(expiredInvitation.deliveryState, 'EXPIRED');
    assert.equal(expiredInvitation.invitationGeneration, 1);
    assert.equal(expiredInvitation.invitationExpiresAt, '2000-01-04T00:00:00.000Z');
    assert.equal(expiredInvitation.isActive, false);
    await assert.rejects(() =>
      runPeopleInvitationAttempt(
        application,
        invitationProvider,
        tenantId,
        supervisor.operationId,
        'application-cannot-dispatch',
      ),
    );
    for (const table of [
      'tenant_people_invitation_dispatches',
      'tenant_people_invitation_ambiguities',
      'tenant_people_invitation_receipts',
    ]) {
      assert.deepEqual(
        await withTenantDatabaseTransaction(application, randomUUID(), (transaction) =>
          transaction.$queryRaw(Prisma.sql`SELECT tenant_id FROM ${Prisma.raw(table)}`),
        ),
        [],
      );
      for (const principal of [application, worker]) {
        await assert.rejects(() =>
          withTenantDatabaseTransaction(principal, tenantId, (transaction) =>
            transaction.$executeRaw(
              Prisma.sql`UPDATE ${Prisma.raw(table)} SET tenant_id=tenant_id WHERE tenant_id=${tenantId}::uuid`,
            ),
          ),
        );
        await assert.rejects(() =>
          withTenantDatabaseTransaction(principal, tenantId, (transaction) =>
            transaction.$executeRaw(
              Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE tenant_id=${tenantId}::uuid`,
            ),
          ),
        );
      }
    }
    const provisionedUser = await owner.user.findUniqueOrThrow({
      where: { id: supervisor.userId },
    });
    assert.equal(provisionedUser.keycloakId, supervisor.userId);
    assert.equal(provisionedUser.isActive, false);
    assert.equal(provisionedUser.extension, null);
    assert.equal(provisionedUser.passwordHash, '!keycloak-managed');
    const oldReconcile = await readAccepted(
      await request(`/people/users/${supervisor.userId}/reconcile`, {
        commandId: randomUUID(),
        expectedRevision: 1,
        reasonCode: 'DELIVERY_CHECK',
        reason: 'อ่านผลรุ่นเดิมหลังมีรุ่นใหม่',
      }),
    );
    const nextAttempt = randomUUID();
    await withTenantDatabaseTransaction(
      worker,
      tenantId,
      (transaction) =>
        transaction.$executeRaw`INSERT INTO tenant_people_invitation_intents(tenant_id,operation_id,user_id,generation,provider_attempt_ref) VALUES(${tenantId}::uuid,${supervisor.operationId}::uuid,${supervisor.userId}::uuid,2,${nextAttempt}::uuid)`,
    );
    const secondIntent = await readObject(await request(`/people/users/${supervisor.userId}`));
    assert.equal(secondIntent.invitationGeneration, 2);
    assert.equal(secondIntent.deliveryState, 'INTENT');
    assert.equal(
      await runPeopleInvitationAttempt(
        worker,
        {
          async dispatch() {
            assert.fail('generation ใหม่ยังไม่มี preparation barrier จึงห้าม dispatch');
          },
          async readOutcome() {
            assert.fail('ต้องไม่หยิบ receipt รุ่นเดิมมาแทนรุ่นใหม่');
          },
        },
        tenantId,
        supervisor.operationId,
        'no-unprepared-generation',
        { generation: 2, providerAttemptRef: nextAttempt },
      ),
      'NOT_ELIGIBLE',
    );
    assert.equal(
      await runNextPeopleInvitationReconcile(
        worker,
        {
          async readOutcome() {
            assert.fail('receipt รุ่นเดิมจบแล้ว ไม่ต้องอ่าน provider ใหม่');
          },
        },
        tenantId,
      ),
      true,
    );
    assert.equal(
      (await readObject(await request(`/operations/${oldReconcile.operationId}`))).state,
      'SUCCEEDED',
    );
    assert.equal(
      (await readObject(await request(`/people/users/${supervisor.userId}`))).deliveryState,
      'INTENT',
    );
    await withTenantDatabaseTransaction(
      worker,
      tenantId,
      (transaction) =>
        transaction.$executeRaw`INSERT INTO tenant_people_invitation_dispatches(tenant_id,operation_id,user_id,generation,provider_attempt_ref,fencing_token,lease_owner) VALUES(${tenantId}::uuid,${supervisor.operationId}::uuid,${supervisor.userId}::uuid,2,${nextAttempt}::uuid,2,'frozen-generation-two')`,
    );
    const secondReconcile = await readAccepted(
      await request(`/people/users/${supervisor.userId}/reconcile`, {
        commandId: randomUUID(),
        expectedRevision: 1,
        reasonCode: 'DELIVERY_CHECK',
        reason: 'อ่าน proof ของ generation สองเท่านั้น',
      }),
    );
    let secondGenerationReads = 0;
    assert.equal(
      await runNextPeopleInvitationReconcile(
        worker,
        {
          async readOutcome(attempt) {
            secondGenerationReads++;
            assert.equal(attempt.generation, 2);
            assert.equal(attempt.providerAttemptRef, nextAttempt);
            assert.equal(attempt.fencingToken, '2');
            assert.equal(attempt.leaseOwner, 'frozen-generation-two');
            return completionProof(attempt);
          },
        },
        tenantId,
      ),
      true,
    );
    assert.equal(secondGenerationReads, 1);
    assert.equal(
      (await readObject(await request(`/operations/${secondReconcile.operationId}`))).state,
      'SUCCEEDED',
    );
    const secondSent = await readObject(await request(`/people/users/${supervisor.userId}`));
    assert.equal(secondSent.invitationGeneration, 2);
    assert.equal(secondSent.deliveryState, 'SENT');
    assert.equal(secondSent.configRevision, 1);
    const resendPath = `/people/users/${supervisor.userId}/invitation/resend`;
    const resendCommand = {
      commandId: randomUUID(),
      expectedRevision: 1,
      reasonCode: 'REQUEST_RESEND',
      reason: 'ส่งคำเชิญใหม่สำหรับผู้ทดสอบ',
    };
    assert.equal((await request(resendPath, resendCommand)).status, 503);
    resendReady = true;
    assert.equal((await request(resendPath, resendCommand, 'agent')).status, 403);
    assert.equal((await request(resendPath, resendCommand, 'protected')).status, 403);
    assert.equal(
      (await request(resendPath, { ...resendCommand, expectedRevision: 2 })).status,
      409,
    );
    assert.equal(
      (await request(resendPath, { ...resendCommand, actionLink: 'forbidden' })).status,
      400,
    );
    const resendResponse = await request(resendPath, resendCommand);
    assert.equal(resendResponse.status, 202);
    assert.equal(resendResponse.headers.get('cache-control'), 'no-store');
    const resend = await readObject(resendResponse);
    assert.equal(resend.generation, 3);
    assert.equal(resendResponse.headers.get('location'), resend.location);
    assert.deepEqual(await readObject(await request(resendPath, resendCommand)), resend);
    assert.equal(
      (await request(resendPath, { ...resendCommand, reason: 'เปลี่ยนเหตุผล' })).status,
      409,
    );
    const pendingResend = await readObject(await request(`/operations/${resend.operationId}`));
    assert.equal(pendingResend.state, 'QUEUED');
    assert.equal(pendingResend.step, 'PREPARE_INVITATION');
    assert.deepEqual(
      (await readObject(await request(`/commands/${resendCommand.commandId}`))).result,
      resend,
    );
    const afterResend = await readObject(await request(`/people/users/${supervisor.userId}`));
    assert.equal(afterResend.invitationGeneration, 2);
    assert.equal(afterResend.configRevision, 1);
    for (const field of ['providerAttemptRef', 'payloadDigest', 'reason', 'actionLink']) {
      assert.equal(field in resend, false);
      assert.equal(field in pendingResend, false);
    }
    const duplicateResends = await Promise.all([
      request(resendPath, { ...resendCommand, commandId: randomUUID() }),
      request(resendPath, { ...resendCommand, commandId: randomUUID() }),
    ]);
    for (const duplicate of duplicateResends) assert.equal(duplicate.status, 409);
    async function finishResendFixture(operationId: unknown, generation: number) {
      assert.equal(typeof operationId, 'string');
      const preparedAttempts = await withTenantDatabaseTransaction(
        worker,
        tenantId,
        async (transaction) => {
          await transaction.$executeRaw`INSERT INTO tenant_people_invitation_intents(tenant_id,operation_id,user_id,generation,provider_attempt_ref)
          SELECT tenant_id,source_operation_id,user_id,generation,provider_attempt_ref FROM tenant_people_invitation_resends WHERE tenant_id=${tenantId}::uuid AND id=${operationId}::uuid
          ON CONFLICT(tenant_id,operation_id,generation) DO NOTHING`;
          return transaction.$queryRaw<
            { attempt: string }[]
          >`SELECT provider_attempt_ref AS attempt FROM tenant_people_invitation_resends WHERE tenant_id=${tenantId}::uuid AND id=${operationId}::uuid`;
        },
      );
      assert.equal(
        (await request(resendPath, { ...resendCommand, commandId: randomUUID() })).status,
        409,
      );
      await withTenantDatabaseTransaction(
        worker,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`INSERT INTO tenant_people_invitation_dispatches(tenant_id,operation_id,user_id,generation,provider_attempt_ref,fencing_token,lease_owner)
          VALUES(${tenantId}::uuid,${supervisor.operationId}::uuid,${supervisor.userId}::uuid,${generation},${preparedAttempts[0].attempt}::uuid,${generation},'resend-boundary-fixture')`,
      );
      assert.equal(
        await reconcilePeopleInvitationAttempt(
          worker,
          {
            async readOutcome(attempt) {
              assert.equal(attempt.generation, generation);
              assert.equal(attempt.providerAttemptRef, preparedAttempts[0].attempt);
              return completionProof(attempt);
            },
          },
          tenantId,
          supervisor.operationId,
          { generation, providerAttemptRef: preparedAttempts[0].attempt },
        ),
        'RECORDED',
      );
    }
    const { runPeopleInvitationPreparation } =
      await import('./tenant-people-invitation-preparation.js');
    let preparations = 0;
    let preparationReads = 0;
    let providerClock = 4102444800;
    let frozenPreparation: PeopleInvitationAttempt | undefined;
    const preparingPort = {
      async prepare(attempt: PeopleInvitationAttempt) {
        preparations++;
        assert.equal(attempt.generation, 3);
        frozenPreparation = attempt;
        throw new Error('response lost after provider preparation commit');
      },
      async readPreparation(attempt: PeopleInvitationAttempt) {
        preparationReads++;
        assert.deepEqual(attempt, frozenPreparation);
        return {
          outcome: 'INTENT' as const,
          intentRef: 'f'.repeat(64),
          notBeforeEpoch: 4102444801,
          serverEpoch: providerClock,
          clockReached: providerClock >= 4102444801,
        };
      },
    };
    const { runPeopleInvitationResend } = await import('./tenant-people-invitation-sender.js');
    let resendDispatches = 0;
    let resendOutcomeReads = 0;
    let allowResendProof = false;
    let resendLeaseExpiresAt = 0;
    let markDispatchStarted: () => void = () => {};
    let releaseDispatch: () => void = () => {};
    const dispatchStarted = new Promise<void>((resolve) => {
      markDispatchStarted = resolve;
    });
    const dispatchReleased = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    const resendPort = {
      async dispatchPrepared(
        attempt: PeopleInvitationAttempt,
        proof: { intentRef: string; notBeforeEpoch: number },
      ) {
        resendDispatches++;
        assert.ok(frozenPreparation);
        assert.equal(attempt.providerAttemptRef, frozenPreparation.providerAttemptRef);
        assert.equal(attempt.leaseOwner, frozenPreparation.leaseOwner);
        assert.equal(attempt.fencingToken, frozenPreparation.fencingToken);
        assert.equal(proof.intentRef, 'f'.repeat(64));
        assert.equal(proof.notBeforeEpoch, 4102444801);
        resendLeaseExpiresAt = attempt.leaseExpiresAt.getTime();
        markDispatchStarted();
        await dispatchReleased;
        throw new Error('SMTP response lost after provider send');
      },
      async readOutcome(attempt: PeopleInvitationAttempt) {
        resendOutcomeReads++;
        if (!allowResendProof) return { outcome: 'UNKNOWN' as const };
        return {
          ...completionProof(attempt),
          notBeforeEpoch: 4102444801,
          issuedAtEpoch: 4102444801,
        };
      },
    };
    assert.equal(
      await runPeopleInvitationPreparation(
        worker,
        preparingPort,
        tenantId,
        String(resend.operationId),
      ),
      'WAITING_READBACK',
    );
    assert.equal(
      (await readObject(await request(`/operations/${resend.operationId}`))).step,
      'READ_INVITATION_FENCE',
    );
    assert.equal(preparations, 1);
    assert.equal(
      await runPeopleInvitationResend(worker, resendPort, tenantId, String(resend.operationId)),
      'NOT_ELIGIBLE',
    );
    assert.equal(resendDispatches, 0);
    assert.equal(resendOutcomeReads, 0);
    const repeatedPreparation = await Promise.all([
      runPeopleInvitationPreparation(worker, preparingPort, tenantId, String(resend.operationId)),
      runPeopleInvitationPreparation(worker, preparingPort, tenantId, String(resend.operationId)),
    ]);
    assert.deepEqual(repeatedPreparation, ['WAITING_READBACK', 'WAITING_READBACK']);
    assert.equal(preparations, 1);
    providerClock = 4102444801;
    assert.equal(
      await runPeopleInvitationPreparation(
        worker,
        preparingPort,
        tenantId,
        String(resend.operationId),
      ),
      'READY',
    );
    assert.equal(
      await runPeopleInvitationPreparation(
        worker,
        preparingPort,
        tenantId,
        String(resend.operationId),
      ),
      'READY',
    );
    assert.equal(preparations, 1);
    assert.equal(preparationReads, 4);
    for (const table of [
      'tenant_people_invitation_preparations',
      'tenant_people_invitation_preparation_proofs',
    ]) {
      for (const principal of [application, worker]) {
        assert.deepEqual(
          await withTenantDatabaseTransaction(principal, randomUUID(), (transaction) =>
            transaction.$queryRaw(Prisma.sql`SELECT tenant_id FROM ${Prisma.raw(table)}`),
          ),
          [],
        );
        for (const statement of [
          Prisma.sql`UPDATE ${Prisma.raw(table)} SET tenant_id=tenant_id WHERE tenant_id=${tenantId}::uuid`,
          Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE tenant_id=${tenantId}::uuid`,
        ])
          await assert.rejects(() =>
            withTenantDatabaseTransaction(principal, tenantId, (transaction) =>
              transaction.$executeRaw(statement),
            ),
          );
      }
    }
    assert.equal(
      (await readObject(await request(`/operations/${resend.operationId}`))).step,
      'DISPATCH_INVITATION',
    );
    assert.equal(
      (await readObject(await request(`/people/users/${supervisor.userId}`))).deliveryState,
      'INTENT',
    );
    const sending = runPeopleInvitationResend(
      worker,
      resendPort,
      tenantId,
      String(resend.operationId),
    );
    await dispatchStarted;
    assert.ok(resendLeaseExpiresAt > 0 && resendLeaseExpiresAt < Date.now() + 35_000);
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, resendLeaseExpiresAt - Date.now() + 25)),
    );
    assert.ok(resendLeaseExpiresAt < Date.now());
    assert.equal(
      (await request(resendPath, { ...resendCommand, commandId: randomUUID() })).status,
      409,
    );
    assert.equal(
      await runPeopleInvitationResend(worker, resendPort, tenantId, String(resend.operationId)),
      'AMBIGUOUS',
    );
    assert.equal(resendDispatches, 1);
    releaseDispatch();
    assert.equal(await sending, 'AMBIGUOUS');
    assert.equal(
      (await readObject(await request(`/operations/${resend.operationId}`))).state,
      'ACTION_REQUIRED',
    );
    allowResendProof = true;
    assert.equal(
      await runPeopleInvitationResend(worker, resendPort, tenantId, String(resend.operationId)),
      'RECORDED',
    );
    assert.equal(
      await runPeopleInvitationResend(worker, resendPort, tenantId, String(resend.operationId)),
      'RECORDED',
    );
    assert.equal(resendDispatches, 1);
    assert.equal(resendOutcomeReads, 2);
    const completedResend = await readObject(await request(`/operations/${resend.operationId}`));
    assert.equal(completedResend.state, 'SUCCEEDED');
    assert.equal(completedResend.errorCode, null);
    assert.equal(
      (await readObject(await request(`/people/users/${supervisor.userId}`))).configRevision,
      1,
    );
    const secondResend = await readObject(
      await request(resendPath, { ...resendCommand, commandId: randomUUID() }),
    );
    assert.equal(secondResend.generation, 4);
    const runtimePrincipal = `v710_runtime_${randomUUID().replaceAll('-', '')}`;
    const runtimePassword = randomUUID().replaceAll('-', '');
    const runtimeUrl = new URL(workerUrl);
    runtimeUrl.username = runtimePrincipal;
    runtimeUrl.password = runtimePassword;
    const runtimeDatabase = new PrismaClient({
      datasources: { db: { url: runtimeUrl.toString() } },
    });
    let scheduled: TenantPeopleRuntime | undefined;
    let runtimeRoleCreated = false;
    let schedulerReady = false;
    let scheduledPreparations = 0;
    let scheduledDispatches = 0;
    let runtimeClock = 4102444801;
    let markPreparationStarted: () => void = () => {};
    let releasePreparation: () => void = () => {};
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve;
    });
    const preparationReleased = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const resends = new Map([
      [
        tenantId,
        {
          isReady: async () => schedulerReady,
          async prepare() {
            scheduledPreparations++;
            markPreparationStarted();
            await preparationReleased;
          },
          async readPreparation() {
            return {
              outcome: 'INTENT' as const,
              intentRef: 'e'.repeat(64),
              notBeforeEpoch: 4102444802,
              serverEpoch: runtimeClock,
              clockReached: runtimeClock >= 4102444802,
            };
          },
          async dispatchPrepared(attempt: PeopleInvitationAttempt) {
            scheduledDispatches++;
            assert.equal(attempt.generation, 4);
            return {
              ...completionProof(attempt),
              notBeforeEpoch: 4102444802,
              issuedAtEpoch: 4102444802,
            };
          },
          async readOutcome() {
            assert.fail('finished scheduler attempt must not be read or sent again');
          },
        },
      ],
    ]);
    const identities = new Map([
      [
        tenantId,
        {
          isReady: async () => true,
          async mutateStep() {
            assert.fail('scheduler test must not mutate provisioning');
          },
          async readOutcome() {
            assert.fail('scheduler test must not read provisioning');
          },
        },
      ],
    ]);
    const createScheduled = () =>
      new TenantPeopleRuntime(runtimeDatabase, identities, {
        intervalMs: 60_000,
        batchSize: 1,
        resends,
      });
    try {
      await owner.$executeRawUnsafe(
        `CREATE ROLE "${runtimePrincipal}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${runtimePassword}'`,
      );
      runtimeRoleCreated = true;
      await owner.$executeRawUnsafe(`GRANT dcontact_tenant_people_worker TO "${runtimePrincipal}"`);
      await owner.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref) VALUES(${tenantId}::uuid,${runtimePrincipal},'isolated-resend-scheduler')`;
      const unwired = new TenantPeopleRuntime(runtimeDatabase, identities, {
        intervalMs: 60_000,
        batchSize: 1,
      });
      unwired.onModuleInit();
      try {
        await unwired.runOnce();
        assert.equal(await unwired.canResendInvitation(tenantId), false);
        assert.equal(scheduledPreparations, 0);
      } finally {
        await unwired.onModuleDestroy();
      }
      scheduled = createScheduled();
      assert.equal(await scheduled.canResendInvitation(tenantId), false);
      scheduled.onModuleInit();
      await scheduled.runOnce();
      assert.equal(await scheduled.canResendInvitation(tenantId), false);
      assert.equal(scheduledPreparations, 0);
      schedulerReady = true;
      assert.equal(await scheduled.canResendInvitation(tenantId), true);
      assert.equal(await scheduled.canResendInvitation(randomUUID()), false);
      for (let retry = 0; retry < 8 && scheduledPreparations === 0; retry++) {
        await Promise.race([scheduled.runOnce(), preparationStarted]);
      }
      assert.equal(scheduledPreparations, 1);
      assert.equal(scheduledDispatches, 0);
      let shutdownComplete = false;
      const stopping = scheduled.onModuleDestroy().then(() => {
        shutdownComplete = true;
      });
      await Promise.resolve();
      assert.equal(shutdownComplete, false);
      releasePreparation();
      await stopping;
      assert.equal(shutdownComplete, true);
      assert.equal(await scheduled.canResendInvitation(tenantId), false);
      runtimeClock = 4102444802;
      schedulerReady = false;
      scheduled = createScheduled();
      scheduled.onModuleInit();
      for (let retry = 0; retry < 4; retry++) await scheduled.runOnce();
      assert.equal(scheduledDispatches, 0);
      assert.equal(await scheduled.canResendInvitation(tenantId), false);
      schedulerReady = true;
      for (let retry = 0; retry < 10 && scheduledDispatches === 0; retry++)
        await scheduled.runOnce();
      assert.equal(scheduledPreparations, 1);
      assert.equal(scheduledDispatches, 1);
      await scheduled.runOnce();
      assert.equal(scheduledDispatches, 1);
      assert.equal(
        (await readObject(await request(`/operations/${secondResend.operationId}`))).state,
        'SUCCEEDED',
      );
    } finally {
      releasePreparation();
      await scheduled?.onModuleDestroy();
      await runtimeDatabase.$disconnect();
      if (runtimeRoleCreated) {
        await owner.$executeRaw`DELETE FROM tenant_people_worker_bindings WHERE tenant_id=${tenantId}::uuid AND database_principal=${runtimePrincipal}`;
        await owner.$executeRawUnsafe(`DROP ROLE "${runtimePrincipal}"`);
      }
    }
    const lastSlot = await Promise.all([
      request(resendPath, { ...resendCommand, commandId: randomUUID() }),
      request(resendPath, { ...resendCommand, commandId: randomUUID() }),
    ]);
    assert.equal(lastSlot.filter((response) => response.status === 202).length, 1);
    assert.ok(lastSlot.every((response) => [202, 409, 429].includes(response.status)));
    const winner = lastSlot.find((response) => response.status === 202);
    assert.ok(winner);
    const thirdResend = await readObject(winner);
    assert.equal(thirdResend.generation, 5);
    await finishResendFixture(thirdResend.operationId, 5);
    const capped = await request(resendPath, { ...resendCommand, commandId: randomUUID() });
    assert.equal(capped.status, 429);
    assert.equal((await readObject(capped)).code, 'INVITATION_RESEND_LIMIT');
    assert.deepEqual(await readObject(await request(resendPath, resendCommand)), resend);
    const acceptedResends = await owner.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM voice_config_audit WHERE tenant_id=${tenantId}::uuid AND resource_id=${supervisor.userId}::uuid AND action='RESEND_TENANT_INVITATION' AND outcome='ACCEPTED'`;
    assert.equal(acceptedResends[0].count, 3n);
    for (const principal of [application, worker]) {
      for (const statement of [
        Prisma.sql`UPDATE tenant_people_invitation_resends SET reason=reason WHERE tenant_id=${tenantId}::uuid`,
        Prisma.sql`DELETE FROM tenant_people_invitation_resends WHERE tenant_id=${tenantId}::uuid`,
      ])
        await assert.rejects(() =>
          withTenantDatabaseTransaction(principal, tenantId, (transaction) =>
            transaction.$executeRaw(statement),
          ),
        );
    }
    assert.deepEqual(
      await withTenantDatabaseTransaction(
        application,
        randomUUID(),
        (transaction) => transaction.$queryRaw`SELECT id FROM tenant_people_invitation_resends`,
      ),
      [],
    );
    await assert.rejects(
      () =>
        withTenantDatabaseTransaction(
          application,
          tenantId,
          (transaction) =>
            transaction.$executeRaw`INSERT INTO tenant_people_invitation_resends(tenant_id,id,command_id,actor_user_id,user_id,source_operation_id,previous_generation,previous_attempt_ref,generation,provider_attempt_ref,expected_revision,status_revision,reason_code,reason)
              SELECT tenant_id,${randomUUID()}::uuid,${randomUUID()}::uuid,${adminId}::uuid,user_id,operation_id,generation,provider_attempt_ref,generation+1,${randomUUID()}::uuid,1,
                (SELECT revision FROM tenant_user_lifecycles WHERE tenant_id=${tenantId}::uuid AND user_id=${supervisor.userId}::uuid),
                'REQUEST_RESEND','ตรวจ cap ที่ DB' FROM tenant_people_invitation_intents WHERE tenant_id=${tenantId}::uuid AND user_id=${supervisor.userId}::uuid AND generation=5`,
        ),
      /INVITATION_RESEND_LIMIT/,
    );
    const activationPrincipal = `activation_${randomUUID().replaceAll('-', '')}`;
    const activationUrl = new URL(process.env.DATABASE_URL!);
    activationUrl.username = activationPrincipal;
    activationUrl.password = randomUUID();
    activationUrl.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
    const activationWorker = new PrismaClient({
      datasources: { db: { url: activationUrl.toString() } },
    });
    await owner.$executeRawUnsafe(
      `CREATE ROLE "${activationPrincipal}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${activationUrl.password}'`,
    );
    try {
      await owner.$executeRawUnsafe(
        `GRANT dcontact_tenant_people_worker TO "${activationPrincipal}"`,
      );
      await owner.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref) VALUES(${tenantId}::uuid,${activationPrincipal},'isolated-activation-test')`;
      const activationOperation = supervisor.operationId;
      const proof = async (
        activationClaim: Parameters<
          import('./tenant-people-activation.js').TenantPeopleActivationPort['readActivation']
        >[0],
      ) => ({
        outcome: 'VERIFIED' as const,
        tenantId: activationClaim.tenantId,
        operationId: activationClaim.operationId,
        userId: activationClaim.userId,
        payloadDigest: activationClaim.payloadDigest,
        probeRef: randomUUID(),
        serverEpoch: 100,
      });
      assert.equal(
        await runPeopleActivation(
          activationWorker,
          { readActivation: async () => ({ outcome: 'UNKNOWN' }) },
          tenantId,
          activationOperation,
        ),
        'UNKNOWN',
      );
      assert.equal(
        await runPeopleActivation(
          activationWorker,
          { readActivation: async (claim) => ({ ...(await proof(claim)), outcome: 'PENDING' }) },
          tenantId,
          activationOperation,
        ),
        'PENDING',
      );
      assert.equal(
        await runPeopleActivation(
          activationWorker,
          { readActivation: async (claim) => ({ ...(await proof(claim)), userId: randomUUID() }) },
          tenantId,
          activationOperation,
        ),
        'UNKNOWN',
      );
      assert.equal(
        (await owner.user.findUniqueOrThrow({ where: { id: supervisor.userId } })).isActive,
        false,
      );
      assert.equal(
        await runPeopleActivation(
          activationWorker,
          {
            async readActivation(claim) {
              await owner.$executeRaw`UPDATE users SET config_revision=config_revision+1 WHERE tenant_id=${tenantId}::uuid AND id=${supervisor.userId}::uuid`;
              return proof(claim);
            },
          },
          tenantId,
          activationOperation,
        ),
        'STALE',
      );
      assert.equal(
        await runPeopleActivation(
          activationWorker,
          {
            async readActivation(claim) {
              await new Promise((resolve) => setTimeout(resolve, 30_100));
              return proof(claim);
            },
          },
          tenantId,
          activationOperation,
        ),
        'STALE',
      );
      await assert.rejects(
        () =>
          runPeopleActivation(
            activationWorker,
            {
              async readActivation(claim) {
                await owner.$executeRaw`UPDATE tenant_people_worker_bindings SET enabled=false WHERE tenant_id=${tenantId}::uuid AND database_principal=${activationPrincipal}`;
                return proof(claim);
              },
            },
            tenantId,
            activationOperation,
          ),
        /PEOPLE_ACTIVATION_SCOPE_DENIED/,
      );
      await owner.$executeRaw`UPDATE tenant_people_worker_bindings SET enabled=true WHERE tenant_id=${tenantId}::uuid AND database_principal=${activationPrincipal}`;
      const fault = `activation_fault_${randomUUID().replaceAll('-', '')}`;
      await owner.$executeRawUnsafe(
        `CREATE FUNCTION ${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id='${tenantId}'::uuid AND NEW.action='ACTIVATE_TENANT_USER' THEN RAISE EXCEPTION 'ACTIVATION_TEST_AUDIT_FAILURE'; END IF; RETURN NEW; END $$`,
      );
      await owner.$executeRawUnsafe(
        `CREATE TRIGGER ${fault} BEFORE INSERT ON voice_config_audit FOR EACH ROW EXECUTE FUNCTION ${fault}()`,
      );
      try {
        await assert.rejects(
          () =>
            runPeopleActivation(
              activationWorker,
              { readActivation: proof },
              tenantId,
              activationOperation,
            ),
          /ACTIVATION_TEST_AUDIT_FAILURE/,
        );
        assert.equal(
          (await owner.user.findUniqueOrThrow({ where: { id: supervisor.userId } })).isActive,
          false,
        );
        const rolledBackReceipts = await owner.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) FROM tenant_people_activation_receipts WHERE tenant_id=${tenantId}::uuid`;
        assert.equal(rolledBackReceipts[0].count, 0n);
      } finally {
        await owner.$executeRawUnsafe(`DROP TRIGGER ${fault} ON voice_config_audit`);
        await owner.$executeRawUnsafe(`DROP FUNCTION ${fault}()`);
      }
      const beforeActivation = await owner.user.findUniqueOrThrow({
        where: { id: supervisor.userId },
      });
      await assert.rejects(() =>
        withTenantDatabaseTransaction(
          application,
          tenantId,
          (transaction) =>
            transaction.$queryRaw`SELECT * FROM dc_people_claim_activation(${tenantId}::uuid,${activationOperation}::uuid,${randomUUID()}::uuid)`,
        ),
      );
      await assert.rejects(() =>
        withTenantDatabaseTransaction(
          activationWorker,
          tenantId,
          (transaction) =>
            transaction.$executeRaw`UPDATE users SET is_active=true WHERE tenant_id=${tenantId}::uuid AND id=${supervisor.userId}::uuid`,
        ),
      );
      await assert.rejects(() =>
        runPeopleActivation(
          activationWorker,
          { readActivation: proof },
          randomUUID(),
          activationOperation,
        ),
      );
      let releaseActivation!: () => void;
      let bothProbes!: () => void;
      const activationReleased = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      const probesStarted = new Promise<void>((resolve) => {
        bothProbes = resolve;
      });
      let activationReads = 0;
      const concurrentPort = {
        async readActivation(claim: Parameters<typeof proof>[0]) {
          activationReads++;
          if (activationReads === 2) bothProbes();
          await activationReleased;
          return proof(claim);
        },
      };
      const activating = Promise.all([
        runPeopleActivation(activationWorker, concurrentPort, tenantId, activationOperation),
        runPeopleActivation(activationWorker, concurrentPort, tenantId, activationOperation),
      ]);
      await probesStarted;
      releaseActivation();
      assert.deepEqual((await activating).sort(), ['ACTIVATED', 'STALE']);
      assert.equal(
        await runPeopleActivation(
          activationWorker,
          { readActivation: proof },
          tenantId,
          activationOperation,
        ),
        'NOT_ELIGIBLE',
      );
      const activatedUser = await owner.user.findUniqueOrThrow({
        where: { id: supervisor.userId },
      });
      assert.equal(activatedUser.isActive, true);
      assert.equal(activatedUser.configRevision, beforeActivation.configRevision);
      const lifecycle = await owner.$queryRaw<
        { account: string; activation: string }[]
      >`SELECT account_state AS account,activation_state AS activation FROM tenant_user_lifecycles WHERE tenant_id=${tenantId}::uuid AND user_id=${supervisor.userId}::uuid`;
      assert.deepEqual(lifecycle, [{ account: 'ACTIVE', activation: 'ACTIVATED' }]);
      const activationAudits = await owner.$queryRaw<
        { count: bigint }[]
      >`SELECT count(*) FROM voice_config_audit WHERE tenant_id=${tenantId}::uuid AND resource_id=${supervisor.userId}::uuid AND action='ACTIVATE_TENANT_USER'`;
      assert.equal(activationAudits[0].count, 1n);
      assert.equal(
        await owner.agentSipCredential.count({ where: { tenantId, userId: supervisor.userId } }),
        0,
      );
      assert.equal(
        await owner.agentWorkSessionLease.count({ where: { tenantId, userId: supervisor.userId } }),
        0,
      );
      for (const table of [
        'tenant_people_activation_attempts',
        'tenant_people_activation_receipts',
      ]) {
        assert.deepEqual(
          await withTenantDatabaseTransaction(application, randomUUID(), (transaction) =>
            transaction.$queryRaw(Prisma.sql`SELECT tenant_id FROM ${Prisma.raw(table)}`),
          ),
          [],
        );
        await assert.rejects(() =>
          withTenantDatabaseTransaction(activationWorker, tenantId, (transaction) =>
            transaction.$executeRaw(
              Prisma.sql`DELETE FROM ${Prisma.raw(table)} WHERE tenant_id=${tenantId}::uuid`,
            ),
          ),
        );
      }
    } finally {
      await activationWorker.$disconnect();
      await owner.$executeRaw`DELETE FROM tenant_people_worker_bindings WHERE tenant_id=${tenantId}::uuid AND database_principal=${activationPrincipal}`;
      await owner.$executeRawUnsafe(`DROP ROLE "${activationPrincipal}"`);
    }
    const foreignRows = await withTenantDatabaseTransaction(
      application,
      randomUUID(),
      (transaction) =>
        transaction.$queryRaw`SELECT id FROM tenant_people_operations WHERE id=${accepted.operationId}::uuid`,
    );
    assert.deepEqual(foreignRows, []);
    await assert.rejects(() =>
      withTenantDatabaseTransaction(
        application,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`UPDATE tenant_people_operations SET state='SUCCEEDED',revision=revision+1 WHERE id=${accepted.operationId}::uuid`,
      ),
    );
    await assert.rejects(() =>
      withTenantDatabaseTransaction(
        application,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`DELETE FROM tenant_identity_reservations WHERE operation_id=${accepted.operationId}::uuid`,
      ),
    );
    assert.equal(
      await runPeopleWorkerStep(
        worker,
        {
          async mutateStep() {
            assert.fail('mapping conflict must not retry a mutation');
          },
          async readOutcome() {
            return { outcome: 'UNKNOWN', reasonCode: 'IDENTITY_MAPPING_CONFLICT' };
          },
        },
        tenantId,
        accepted.operationId,
        'mapping-conflict-reader',
      ),
      'RECORDED',
    );
    const mappingConflict = await readObject(await request(`/operations/${accepted.operationId}`));
    assert.equal(mappingConflict.state, 'ACTION_REQUIRED');
    assert.equal(mappingConflict.errorCode, 'IDENTITY_MAPPING_CONFLICT');
    assert.equal(
      await claimPeopleOperation(
        worker,
        tenantId,
        accepted.operationId,
        'mapping-conflict-must-stop',
      ),
      null,
    );
  } finally {
    await app?.close();
    await Promise.all([owner.$disconnect(), application.$disconnect(), worker.$disconnect()]);
  }
});
