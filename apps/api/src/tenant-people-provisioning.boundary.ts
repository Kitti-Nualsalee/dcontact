import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import { KeycloakAccessTokenVerifier } from '@d-contact/workspace-session';
import { TenantPeopleController, TENANT_PEOPLE_READINESS } from './tenant-people-api.js';
import { TENANT_VOICE_DATABASE, TenantVoiceCatalogController } from './tenant-voice-catalog-api.js';
import { TenantPeopleKeycloak } from './tenant-people-keycloak.js';
import { DatabaseTenantPeopleReadiness } from './tenant-people-readiness.js';
import { TenantPeopleRuntime } from './tenant-people-runtime.js';
import type { TenantPeopleIdentityPort } from './tenant-people-worker.js';
import { runPeopleInvitationAttempt } from './tenant-people-invitation-worker.js';
import {
  OidcGlobalGuard,
  OIDC_ACCESS_TOKEN_VERIFIER,
  TENANT_LIFECYCLE,
  GATEWAY_DIAGNOSTICS,
} from './gateway-auth.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_BOUNDARY_CONFIGURATION:${name}`);
  return value;
}

test('real JWT HTTP → RLS worker → Keycloak/SMTP: สาม roles ยัง PENDING หลัง response loss และ read-only reconcile', async () => {
  const issuer = required('B2_KEYCLOAK_ISSUER');
  const tenantId = required('B2_KEYCLOAK_TENANT_ID');
  const adminId = required('B2_KEYCLOAK_ADMIN_SUBJECT');
  const slug = required('B2_KEYCLOAK_TENANT_SLUG');
  const adminToken = required('B2_KEYCLOAK_ADMIN_ACCESS_TOKEN');
  const owner = new PrismaClient({ datasources: { db: { url: required('DATABASE_URL') } } });
  const application = new PrismaClient({
    datasources: { db: { url: required('APPLICATION_DATABASE_URL') } },
  });
  const workerUrl = new URL(required('DATABASE_URL'));
  const workerPrincipal = `b2_worker_${randomUUID().replaceAll('-', '')}`;
  const workerPassword = randomUUID();
  workerUrl.username = workerPrincipal;
  workerUrl.password = workerPassword;
  workerUrl.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
  const worker = new PrismaClient({ datasources: { db: { url: workerUrl.toString() } } });
  const overprivilegedUrl = new URL(required('DATABASE_URL'));
  overprivilegedUrl.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
  const overprivileged = new PrismaClient({
    datasources: { db: { url: overprivilegedUrl.toString() } },
  });
  const adapter = new TenantPeopleKeycloak({
    issuer,
    tenantId,
    clientId: required('B2_KEYCLOAK_CLIENT_ID'),
    clientSecret: required('B2_KEYCLOAK_CLIENT_SECRET'),
  });
  const teamId = randomUUID();
  const node = {
    telephonyNodeId: 'sandbox-node',
    releaseDigest: 'b'.repeat(64),
    dialplanDigest: 'c'.repeat(64),
    extensions: ['1104'],
  };
  const pool = [
    {
      ref: '1104',
      telephonyNodeId: node.telephonyNodeId,
      releaseDigest: node.releaseDigest,
      dialplanDigest: node.dialplanDigest,
    },
  ];
  const readiness = new DatabaseTenantPeopleReadiness(worker, new Map([[tenantId, adapter]]));
  let app: Awaited<ReturnType<typeof NestFactory.create>> | undefined;
  try {
    await owner.$executeRawUnsafe(
      `CREATE ROLE "${workerPrincipal}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${workerPassword}'`,
    );
    await owner.$executeRawUnsafe(`GRANT dcontact_tenant_people_worker TO "${workerPrincipal}"`);
    await owner.tenant.create({
      data: { id: tenantId, slug, name: 'B2 synthetic tenant', sipDomain: `${slug}.test` },
    });
    await owner.team.create({ data: { id: teamId, tenantId, name: 'B2 synthetic team' } });
    await owner.user.create({
      data: {
        id: adminId,
        keycloakId: adminId,
        tenantId,
        teamId,
        role: 'ADMIN',
        email: `${adminId}@example.test`,
        displayName: 'B2 bootstrap',
        passwordHash: '!keycloak-managed',
      },
    });
    await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active) VALUES(${tenantId}::uuid,${adminId}::uuid,${issuer},${adminId},'b2-boundary-console',${slug},${required('B2_KEYCLOAK_ORGANIZATION_ID')}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','isolated-boundary-bootstrap',${'a'.repeat(64)},'sandbox-operator',now(),1,true)`;
    await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,extension_pool) VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',4,1,1,1,'sandbox-operator',now(),'isolated-boundary','ทดสอบ provisioning',${JSON.stringify(pool)}::jsonb)`;
    await owner.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref) VALUES(${tenantId}::uuid,${workerPrincipal},'isolated-boundary')`;
    assert.equal(await readiness.isReady(tenantId), true);
    assert.equal(await readiness.isReady(randomUUID()), false);
    await owner.$executeRawUnsafe(`ALTER ROLE "${workerPrincipal}" BYPASSRLS`);
    assert.equal(await readiness.isReady(tenantId), false);
    await owner.$executeRawUnsafe(`ALTER ROLE "${workerPrincipal}" NOBYPASSRLS`);
    await owner.$executeRawUnsafe(`GRANT dcontact_app TO "${workerPrincipal}"`);
    assert.equal(await readiness.isReady(tenantId), false);
    await owner.$executeRawUnsafe(`REVOKE dcontact_app FROM "${workerPrincipal}"`);
    await owner.$executeRaw`UPDATE tenant_people_worker_bindings SET enabled=false WHERE tenant_id=${tenantId}::uuid AND database_principal=${workerPrincipal}`;
    assert.equal(await readiness.isReady(tenantId), false);
    await owner.$executeRaw`UPDATE tenant_people_worker_bindings SET enabled=true WHERE tenant_id=${tenantId}::uuid AND database_principal=${workerPrincipal}`;
    await owner.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref) VALUES(${tenantId}::uuid,session_user,'isolated-overprivileged-principal-negative')`;
    assert.equal(
      await new DatabaseTenantPeopleReadiness(
        overprivileged,
        new Map([[tenantId, adapter]]),
      ).isReady(tenantId),
      false,
    );
    assert.equal(
      await new DatabaseTenantPeopleReadiness(owner, new Map([[tenantId, adapter]])).isReady(
        tenantId,
      ),
      false,
    );
    let mutations = 0,
      reconciliations = 0;
    const lossy: TenantPeopleIdentityPort = {
      async mutateStep(claim) {
        mutations++;
        const result = await adapter.mutateStep(claim);
        if (claim.step === 'CREATE_IDENTITY') throw new Error('synthetic lost response');
        return result;
      },
      readOutcome(claim) {
        reconciliations++;
        return adapter.readOutcome(claim);
      },
    };
    const runtime = new TenantPeopleRuntime(
      worker,
      new Map([[tenantId, { ...lossy, isReady: (scope: string) => adapter.isReady(scope) }]]),
      { intervalMs: 100, nodes: new Map([[tenantId, [node]]]) },
    );
    assert.equal(await runtime.isReady(tenantId), false);
    @Module({
      controllers: [TenantPeopleController, TenantVoiceCatalogController],
      providers: [
        { provide: TENANT_VOICE_DATABASE, useValue: application },
        { provide: TENANT_PEOPLE_READINESS, useValue: runtime },
        {
          provide: OIDC_ACCESS_TOKEN_VERIFIER,
          useValue: new KeycloakAccessTokenVerifier({
            issuer,
            audience: 'dcontact-api',
            jwksUri: `${issuer}/protocol/openid-connect/certs`,
          }),
        },
        { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
        { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
        { provide: APP_GUARD, useClass: OidcGlobalGuard },
      ],
    })
    class BoundaryModule {}
    app = await NestFactory.create(BoundaryModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    for (let attempt = 0; attempt < 100 && !(await runtime.isReady(tenantId)); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await runtime.isReady(tenantId), true);
    const read = async (path: string) => {
      const response = await fetch(`${base}/api/v1/tenant-voice/${path}`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      assert.equal(response.status, 200);
      const raw: unknown = await response.json();
      assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
      return Object.fromEntries(Object.entries(raw));
    };
    assert.deepEqual((await read('capabilities')).peopleProvisioning, { ready: true, reasons: [] });
    assert.deepEqual((await read('capabilities')).invitation, {
      ready: false,
      reasons: ['CAPABILITY_NOT_READY'],
    });
    assert.deepEqual((await read('extension-pool')).items, [{ ref: '1104' }]);
    for (const role of ['AGENT', 'SUPERVISOR', 'ADMIN']) {
      const command = {
        commandId: randomUUID(),
        displayName: `B2 ${role}`,
        email: `${role === 'ADMIN' ? 'Admin-' : ''}${randomUUID()}@example.test`,
        role,
        teamId,
        ...(role === 'AGENT' ? { extensionRef: '1104' } : {}),
      };
      const create = () =>
        fetch(`${base}/api/v1/tenant-voice/people/users`, {
          method: 'POST',
          headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
          body: JSON.stringify(command),
        });
      const response = await create();
      assert.equal(response.status, 202);
      const accepted: unknown = await response.json();
      assert.ok(
        accepted &&
          typeof accepted === 'object' &&
          'operationId' in accepted &&
          'userId' in accepted,
      );
      assert.equal(typeof accepted.operationId, 'string');
      assert.equal(typeof accepted.userId, 'string');
      const operationId = String(accepted.operationId),
        userId = String(accepted.userId);
      assert.deepEqual(await (await create()).json(), accepted);
      let body: Record<string, unknown> | undefined;
      for (let attempt = 0; attempt < 200; attempt++) {
        const status = await fetch(`${base}/api/v1/tenant-voice/operations/${operationId}`, {
          headers: { authorization: `Bearer ${adminToken}` },
        });
        assert.equal(status.status, 200);
        const raw: unknown = await status.json();
        assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
        const projection = Object.fromEntries(Object.entries(raw));
        if (projection.state === 'SUCCEEDED') {
          body = projection;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(body, 'durable runtime did not complete provisioning');
      assert.equal(body.state, 'SUCCEEDED');
      assert.equal(body.provisioningState, 'PROVISIONED');
      assert.equal(body.accountState, 'PENDING_ACTIVATION');
      assert.equal(body.activationState, 'PENDING');
      const user = await owner.user.findUniqueOrThrow({ where: { id: userId } });
      assert.equal(user.keycloakId, userId);
      assert.equal(user.isActive, false);
      assert.equal(user.role, role);
      assert.equal(user.teamId, teamId);
      assert.equal(user.email, command.email);
      assert.equal(user.passwordHash, '!keycloak-managed');
      assert.equal(user.extension, role === 'AGENT' ? '1104' : null);
      assert.equal(await owner.agentSipCredential.count({ where: { tenantId, userId } }), 0);
      assert.equal(await owner.agentWorkSessionLease.count({ where: { tenantId, userId } }), 0);
      const pendingInvitation = await read(`people/users/${userId}`);
      assert.equal(pendingInvitation.deliveryState, 'INTENT');
      let invitationPosts = 0;
      let invitationReads = 0;
      let malformedProofs = 0;
      const deliveryAdapter = new TenantPeopleKeycloak(
        {
          issuer,
          tenantId,
          clientId: required('B2_KEYCLOAK_CLIENT_ID'),
          clientSecret: required('B2_KEYCLOAK_CLIENT_SECRET'),
        },
        async (input, options) => {
          const response = await fetch(input, options);
          if (String(input).includes('/dispatch')) {
            if (options?.method === 'POST') {
              invitationPosts++;
              await response.arrayBuffer();
              throw new Error('synthetic SMTP response loss');
            }
            invitationReads++;
            if (malformedProofs === 0 && response.ok) {
              const proof: unknown = await response.json();
              if (
                proof &&
                typeof proof === 'object' &&
                'outcome' in proof &&
                proof.outcome === 'SENT'
              ) {
                malformedProofs++;
                return Response.json({ ...proof, unexpectedField: 'reject-this-proof' });
              }
              return Response.json(proof);
            }
          }
          return response;
        },
      );
      const delivery = deliveryAdapter.invitationPort();
      assert.equal(typeof pendingInvitation.operationId, 'string');
      const invitationOperationId = String(pendingInvitation.operationId);
      assert.equal(
        await runPeopleInvitationAttempt(
          worker,
          delivery,
          tenantId,
          invitationOperationId,
          'smtp-original-worker',
        ),
        'AMBIGUOUS',
      );
      let invitationResult = 'AMBIGUOUS';
      for (let attempt = 0; attempt < 50 && invitationResult !== 'RECORDED'; attempt++) {
        const previousMalformedProofs = malformedProofs;
        invitationResult = await runPeopleInvitationAttempt(
          worker,
          delivery,
          tenantId,
          invitationOperationId,
          'smtp-restarted-reader',
        );
        if (malformedProofs > previousMalformedProofs) assert.equal(invitationResult, 'AMBIGUOUS');
        if (invitationResult !== 'RECORDED')
          await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(invitationResult, 'RECORDED');
      assert.equal(invitationPosts, 1);
      assert.equal(malformedProofs, 1);
      assert.ok(invitationReads > 0);
      const sentInvitation = await read(`people/users/${userId}`);
      assert.equal(sentInvitation.deliveryState, 'SENT');
      assert.equal(sentInvitation.invitationGeneration, 1);
      assert.equal(sentInvitation.activationState, 'PENDING');
      assert.equal(sentInvitation.isActive, false);
      assert.equal(typeof sentInvitation.invitationExpiresAt, 'string');
      assert.equal(await owner.agentSipCredential.count({ where: { tenantId, userId } }), 0);
      assert.equal(await owner.agentWorkSessionLease.count({ where: { tenantId, userId } }), 0);
      for (const field of ['actionLink', 'providerAttemptRef', 'receiptRef', 'leaseOwner'])
        assert.equal(field in sentInvitation, false);
    }
    assert.equal(mutations, 15);
    assert.equal(reconciliations, 3);
    const directory = await read('people/users');
    assert.ok(Array.isArray(directory.items));
    assert.equal(directory.items.length, 4);
    for (const raw of directory.items) {
      assert.ok(raw && typeof raw === 'object');
      if ('id' in raw && raw.id !== adminId) {
        assert.ok(typeof raw.id === 'string');
        const detail = await read(`people/users/${raw.id}`);
        assert.equal(detail.accountState, 'PENDING_ACTIVATION');
        assert.equal(detail.configRevision, 1);
        assert.equal(detail.provisioningState, 'PROVISIONED');
        assert.equal(typeof detail.operationId, 'string');
        assert.equal(typeof detail.commandId, 'string');
        for (const field of ['passwordHash', 'payload', 'clientSecret', 'leaseOwner'])
          assert.equal(field in detail, false);
      }
    }
    assert.deepEqual((await read('extension-pool')).items, []);
    await owner.$executeRaw`UPDATE tenant_people_worker_bindings SET enabled=false WHERE tenant_id=${tenantId}::uuid AND database_principal=${workerPrincipal}`;
    assert.deepEqual((await read('capabilities')).peopleProvisioning, {
      ready: false,
      reasons: ['CAPABILITY_NOT_READY'],
    });
    const intents = await owner.$queryRaw<
      { count: bigint }[]
    >`SELECT count(*) FROM tenant_people_invitation_intents WHERE tenant_id=${tenantId}::uuid`;
    assert.equal(intents[0]?.count, 3n);
    await app.close();
    app = undefined;
    assert.equal(await runtime.isReady(tenantId), false);
  } finally {
    await app?.close();
    await Promise.all([
      owner.$disconnect(),
      application.$disconnect(),
      worker.$disconnect(),
      overprivileged.$disconnect(),
    ]);
  }
});
