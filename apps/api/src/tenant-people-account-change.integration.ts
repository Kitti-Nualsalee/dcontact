import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { HttpException, Module, type INestApplication } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  acceptPeopleAccountChange,
  runPeopleAccountChange,
} from './tenant-people-account-change.js';
import type {
  PeopleAccountOutcome,
  PeopleAccountProbe,
  TenantPeopleAccountPort,
} from './tenant-people-account-keycloak.js';
import { acceptPeopleDisable, runPeopleDisable } from './tenant-people-disable.js';
import type { TenantPeopleDisablePort } from './tenant-people-disable-keycloak.js';
import { acceptPeopleTeamChange } from './tenant-people-team-change.js';
import type { VoiceActor } from './tenant-voice-catalog.js';
import { readPeopleOperation } from './tenant-people-operations.js';
import { readPeopleDirectory } from './tenant-people-directory.js';
import { TenantPeopleController, TENANT_PEOPLE_READINESS } from './tenant-people-api.js';
import { TenantVoiceCatalogController, TENANT_VOICE_DATABASE } from './tenant-voice-catalog-api.js';
import {
  OidcGlobalGuard,
  OIDC_ACCESS_TOKEN_VERIFIER,
  TENANT_LIFECYCLE,
  GATEWAY_DIAGNOSTICS,
} from './gateway-auth.js';
import { TenantPeopleRuntime } from './tenant-people-runtime.js';

async function readObject(response: Response): Promise<Record<string, unknown>> {
  const value: unknown = await response.json();
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return Object.fromEntries(Object.entries(value));
}

function rejectsWith(status: number, code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof HttpException, String(error));
    assert.equal(error.getStatus(), status, JSON.stringify(error.getResponse()));
    assert.match(JSON.stringify(error.getResponse()), new RegExp(code));
    return true;
  };
}

test('#998 rename and re-enable: app changes only after a successful receipt, and reconcile does not resend a mutation', async () => {
  const owner = new PrismaClient();
  const application = new PrismaClient({
    datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
  });
  const workerUrl = new URL(process.env.DATABASE_URL!);
  const principal = `account_${randomUUID().replaceAll('-', '')}`;
  workerUrl.username = principal;
  workerUrl.password = randomUUID();
  workerUrl.searchParams.set('options', '-c role=dcontact_tenant_people_worker');
  const worker = new PrismaClient({ datasources: { db: { url: workerUrl.toString() } } });
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    otherTeamId = randomUUID(),
    adminId = randomUUID(),
    agentId = randomUUID(),
    secondId = randomUUID(),
    thirdId = randomUUID();
  const slug = `p998-${tenantId}`;
  const actor: VoiceActor = {
    tenantId,
    userId: adminId,
    roles: ['admin'],
    caller: {
      issuer: 'https://p998-idp.test/realms/dcontact',
      subject: adminId,
      clientId: 'dcontact-console',
      tenantSlug: slug,
    },
  };
  // fake provider that counts mutations and reads separately, to prove that after attempted only the receipt is read
  let mutations = 0,
    reads = 0,
    probes = 0;
  let probeResult: PeopleAccountProbe = { outcome: 'READY' };
  let mutateResult: (identityId: string) => PeopleAccountOutcome = () => ({ outcome: 'UNKNOWN' });
  let readResult: (identityId: string) => PeopleAccountOutcome = () => ({ outcome: 'UNKNOWN' });
  const provider: TenantPeopleAccountPort = {
    async probe() {
      probes++;
      return probeResult;
    },
    async mutate(attempt) {
      assert.equal(attempt.reconcileOnly, false);
      mutations++;
      return mutateResult(attempt.identityId);
    },
    async readOutcome(attempt) {
      reads++;
      return readResult(attempt.identityId);
    },
  };
  const disableProvider: TenantPeopleDisablePort = {
    async probe() {
      return { outcome: 'READY' };
    },
    async disable(attempt) {
      return {
        outcome: 'SUCCEEDED',
        reasonCode: 'DISABLED',
        identityId: attempt.identityId,
        receiptRef: 'e'.repeat(64),
      };
    },
    async readOutcome() {
      return { outcome: 'UNKNOWN' };
    },
  };
  const user = (id: string) => owner.user.findUniqueOrThrow({ where: { id } });
  const reserved = async () =>
    (
      await withTenantDatabaseTransaction(
        application,
        tenantId,
        (transaction) =>
          transaction.$queryRaw<
            { count: number }[]
          >`SELECT dc_people_reserved_accounts(${tenantId}::uuid,false)::integer AS count`,
      )
    )[0].count;
  const changes = async () =>
    Number(
      (
        await owner.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) AS count FROM tenant_people_account_changes WHERE tenant_id=${tenantId}::uuid`
      )[0].count,
    );
  const disable = async (id: string) => {
    const current = await user(id);
    const accepted = await acceptPeopleDisable(
      application,
      actor,
      id,
      {
        commandId: randomUUID(),
        expectedRevision: current.configRevision,
        reasonCode: 'OPERATOR_REQUEST',
        reason: 'Disabled to test re-enabling',
      },
      disableProvider,
    );
    assert.equal(
      await runPeopleDisable(
        worker,
        disableProvider,
        { async flush() {} },
        tenantId,
        accepted.operationId,
      ),
      'SUCCEEDED',
    );
  };
  const detail = async (id: string) => {
    const value = await readPeopleDirectory(application, actor, {}, id);
    assert.ok('accountState' in value);
    return value;
  };
  let app: INestApplication | undefined;
  let runtime: TenantPeopleRuntime | undefined;
  try {
    await owner.$executeRawUnsafe(
      `CREATE ROLE "${principal}" LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS PASSWORD '${workerUrl.password}'`,
    );
    await owner.$executeRawUnsafe(`GRANT dcontact_tenant_people_worker TO "${principal}"`);
    await owner.tenant.create({
      data: { id: tenantId, name: 'P998 account change', slug, sipDomain: `${slug}.test` },
    });
    await owner.team.create({ data: { id: teamId, tenantId, name: 'P998 team' } });
    await owner.team.create({ data: { id: otherTeamId, tenantId, name: 'P998 other team' } });
    for (const [id, role, extension] of [
      [adminId, 'ADMIN', null],
      [agentId, 'AGENT', '1101'],
      [secondId, 'AGENT', '1102'],
      [thirdId, 'SUPERVISOR', null],
    ] as const) {
      await owner.user.create({
        data: {
          id,
          tenantId,
          teamId,
          keycloakId: id,
          email: `${id}@p998.test`,
          displayName: `P998 ${role}`,
          role,
          extension,
          passwordHash: '!keycloak-managed',
        },
      });
      await owner.$executeRaw`INSERT INTO tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,verified_at,revision,is_active)
        VALUES(${tenantId}::uuid,${id}::uuid,${actor.caller!.issuer},${id},'dcontact-console',${slug},${tenantId}::uuid,'TENANT_USER','BOOTSTRAP_MANIFEST','isolated-p998',${'a'.repeat(64)},'sandbox-operator',now(),1,true)`;
    }
    // 4 accounts over a limit of 3 is intentional: rename skips the quota check, but re-enable must check it
    await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,extension_pool)
      VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',3,2,3,3,'sandbox-operator',now(),'isolated-p998','Account change test','[]'::jsonb)`;
    await owner.$executeRaw`INSERT INTO tenant_people_worker_bindings(tenant_id,database_principal,approval_ref) VALUES(${tenantId}::uuid,${principal},'isolated-p998')`;

    let accountReady = false;
    @Module({
      controllers: [TenantPeopleController, TenantVoiceCatalogController],
      providers: [
        { provide: TENANT_VOICE_DATABASE, useValue: application },
        {
          provide: TENANT_PEOPLE_READINESS,
          useValue: {
            isReady: async () => false,
            canChangeAccount: async () => accountReady,
            accountPortForTenant: () => provider,
          },
        },
        {
          provide: OIDC_ACCESS_TOKEN_VERIFIER,
          useValue: {
            verifyAccessToken: async (token: string) => {
              if (!['admin', 'agent', 'protected'].includes(token))
                throw Error('invalid fixture token');
              return {
                iss: actor.caller!.issuer,
                sub: adminId,
                azp: actor.caller!.clientId,
                tenant_id: tenantId,
                tenant_slug: slug,
                organization: { [slug]: { tenant_id: [tenantId] } },
                dc_user_id: adminId,
                sid: 'p998-fixture',
                exp: 2_000_000_000,
                realm_access: { roles: token === 'agent' ? ['agent'] : ['admin'] },
                dc_identity_class: token === 'protected' ? 'PLATFORM_USER' : 'TENANT_USER',
              };
            },
          },
        },
        { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
        { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
        { provide: APP_GUARD, useClass: OidcGlobalGuard },
      ],
    })
    class TestModule {}
    app = await NestFactory.create(TestModule, { logger: false });
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}/api/v1/tenant-voice`;
    const request = (path: string, body?: unknown, token = 'admin', method?: string) =>
      fetch(base + path, {
        method: method ?? (body ? 'POST' : 'GET'),
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10_000),
      });
    const profile = (id: string, body: unknown, token = 'admin') =>
      request(`/people/users/${id}/profile`, body, token, 'PATCH');

    // --- 1B rename the display name ---
    const rename = {
      commandId: randomUUID(),
      expectedRevision: 1,
      displayName: '  Somchai   Jaidee ',
      reason: 'User asked for a name change',
    };
    assert.equal((await profile(agentId, rename)).status, 503);
    accountReady = true;
    assert.equal((await profile(agentId, rename, 'invalid')).status, 401);
    assert.equal((await profile(agentId, rename, 'agent')).status, 403);
    assert.equal((await profile(agentId, rename, 'protected')).status, 403);
    assert.equal((await profile(randomUUID(), rename)).status, 404);
    assert.equal((await profile(agentId, { ...rename, role: 'ADMIN' })).status, 400);
    assert.equal((await profile(agentId, { ...rename, displayName: 'P998 AGENT' })).status, 400);
    assert.equal((await profile(agentId, { ...rename, displayName: 'x'.repeat(121) })).status, 400);
    assert.equal((await profile(agentId, { ...rename, expectedRevision: 9 })).status, 409);
    const capabilities = await readObject(await request('/capabilities'));
    assert.deepEqual(capabilities.accountChange, { ready: true, reasons: [] });
    assert.equal(probes, 0);

    const renameResponse = await profile(agentId, rename);
    assert.equal(renameResponse.status, 202, await renameResponse.clone().text());
    assert.equal(renameResponse.headers.get('cache-control'), 'no-store');
    const renamed = await readObject(renameResponse);
    assert.equal(renamed.kind, 'UPDATE_PROFILE');
    assert.equal(renameResponse.headers.get('location'), renamed.location);
    const renameOperation = String(renamed.operationId);
    assert.equal(probes, 1);
    // the name in app does not change until the Keycloak receipt succeeds
    assert.equal((await user(agentId)).displayName, 'P998 AGENT');
    const pendingRename = await detail(agentId);
    assert.deepEqual(pendingRename.accountChange, {
      operationId: renameOperation,
      commandId: rename.commandId,
      kind: 'UPDATE_PROFILE',
      state: 'QUEUED',
    });
    // replaying the same command gives the same result; a different payload with the same commandId is rejected
    assert.deepEqual(await readObject(await profile(agentId, rename)), renamed);
    assert.equal((await profile(agentId, { ...rename, displayName: 'Other' })).status, 409);
    assert.equal(probes, 1);
    // one pending command per user, and a disable cannot slip in
    await assert.rejects(
      acceptPeopleAccountChange(
        application,
        actor,
        'UPDATE_PROFILE',
        agentId,
        { ...rename, commandId: randomUUID(), displayName: 'Second name' },
        provider,
      ),
      rejectsWith(409, 'CONFIG_BUSY'),
    );
    // worker holds the lease: disable must wait (CONFIG_BUSY) and not cut off the command in progress
    await owner.$executeRaw`UPDATE tenant_people_account_changes SET revision=revision+1,lease_owner=gen_random_uuid(),lease_expires_at=clock_timestamp()+interval '1 minute'
      WHERE tenant_id=${tenantId}::uuid AND id=${renameOperation}::uuid`;
    await assert.rejects(
      acceptPeopleDisable(
        application,
        actor,
        agentId,
        {
          commandId: randomUUID(),
          expectedRevision: 1,
          reasonCode: 'OPERATOR_REQUEST',
          reason: 'Slip in',
        },
        disableProvider,
      ),
      rejectsWith(409, 'CONFIG_BUSY'),
    );
    await owner.$executeRaw`UPDATE tenant_people_account_changes SET revision=revision+1,lease_owner=NULL,lease_expires_at=NULL
      WHERE tenant_id=${tenantId}::uuid AND id=${renameOperation}::uuid`;
    // unclear outcome: keep the old name as ACTION_REQUIRED
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, renameOperation),
      'ACTION_REQUIRED',
    );
    assert.equal(mutations, 1);
    assert.equal(reads, 1);
    assert.equal((await user(agentId)).displayName, 'P998 AGENT');
    assert.equal(
      (await readPeopleOperation(application, actor, renameOperation)).state,
      'ACTION_REQUIRED',
    );
    // reconcile is read-only until a receipt confirms, then changes the name and revision
    readResult = (identityId) => ({
      outcome: 'SUCCEEDED',
      reasonCode: 'PROFILE_UPDATED',
      identityId,
      receiptRef: 'b'.repeat(64),
    });
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, renameOperation),
      'SUCCEEDED',
    );
    assert.equal(mutations, 1);
    assert.equal(reads, 2);
    const afterRename = await user(agentId);
    assert.equal(afterRename.displayName, 'Somchai Jaidee');
    assert.equal(afterRename.configRevision, 2);
    const renameRead = await readPeopleOperation(application, actor, renameOperation);
    assert.equal(renameRead.step, 'UPDATE_PROFILE');
    assert.equal(renameRead.state, 'SUCCEEDED');
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, renameOperation),
      'NOT_ELIGIBLE',
    );

    // receipt rejected: the name does not change
    mutateResult = (identityId) => ({
      outcome: 'REJECTED_NO_EFFECT',
      reasonCode: 'PROTECTED_OR_FOREIGN_IDENTITY',
      identityId,
      receiptRef: 'c'.repeat(64),
    });
    const refused = await acceptPeopleAccountChange(
      application,
      actor,
      'UPDATE_PROFILE',
      thirdId,
      {
        commandId: randomUUID(),
        expectedRevision: 1,
        displayName: 'New supervisor',
        reason: 'Test',
      },
      provider,
    );
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, refused.operationId),
      'REJECTED',
    );
    assert.equal((await user(thirdId)).displayName, 'P998 SUPERVISOR');
    // a receipt for another identity counts as UNKNOWN and does not change the name
    mutateResult = () => ({
      outcome: 'SUCCEEDED',
      reasonCode: 'PROFILE_UPDATED',
      identityId: randomUUID(),
      receiptRef: 'd'.repeat(64),
    });
    readResult = () => ({ outcome: 'UNKNOWN' });
    const foreign = await acceptPeopleAccountChange(
      application,
      actor,
      'UPDATE_PROFILE',
      thirdId,
      {
        commandId: randomUUID(),
        expectedRevision: 1,
        displayName: 'New supervisor',
        reason: 'Test',
      },
      provider,
    );
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, foreign.operationId),
      'ACTION_REQUIRED',
    );
    assert.equal((await user(thirdId)).displayName, 'P998 SUPERVISOR');
    // reconcile got a rejected receipt matching the identity, so it can close the pending command
    readResult = (identityId) => ({
      outcome: 'REJECTED_NO_EFFECT',
      reasonCode: 'IDENTITY_STATE_CONFLICT',
      identityId,
      receiptRef: '8'.repeat(64),
    });
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, foreign.operationId),
      'REJECTED',
    );
    assert.equal(mutations, 3, 'a command that was already attempted is not mutated again');
    readResult = () => ({ outcome: 'UNKNOWN' });
    // probe clearly rejects, or the identity does not answer: no command is created
    const before = await changes();
    probeResult = { outcome: 'REJECTED', reasonCode: 'PROTECTED_OR_FOREIGN_IDENTITY' };
    await assert.rejects(
      acceptPeopleAccountChange(
        application,
        actor,
        'UPDATE_PROFILE',
        secondId,
        { commandId: randomUUID(), expectedRevision: 1, displayName: 'New', reason: 'Test' },
        provider,
      ),
      rejectsWith(409, 'PROTECTED_OR_FOREIGN_IDENTITY'),
    );
    probeResult = { outcome: 'UNKNOWN' };
    await assert.rejects(
      acceptPeopleAccountChange(
        application,
        actor,
        'UPDATE_PROFILE',
        secondId,
        { commandId: randomUUID(), expectedRevision: 1, displayName: 'New', reason: 'Test' },
        provider,
      ),
      rejectsWith(503, 'IDENTITY_UNAVAILABLE'),
    );
    assert.equal(await changes(), before);
    probeResult = { outcome: 'READY' };

    // --- 2 re-enable the account ---
    const enable = (id: string, body: unknown, token = 'admin') =>
      request(`/people/users/${id}/enable`, body, token);
    assert.equal(
      (await enable(agentId, { commandId: randomUUID(), expectedRevision: 2, reason: 'Back' }))
        .status,
      409,
      'an account that is still active cannot be re-enabled',
    );
    await disable(agentId);
    const disabledAgent = await user(agentId);
    assert.equal(disabledAgent.isActive, false);
    assert.equal((await detail(agentId)).accountState, 'DISABLED');
    // #1000: a disabled account cannot change team or be renamed
    await assert.rejects(
      acceptPeopleTeamChange(application, actor, agentId, {
        commandId: randomUUID(),
        expectedRevision: disabledAgent.configRevision,
        teamId: otherTeamId,
        reason: 'Change team',
      }),
      rejectsWith(409, 'ACCOUNT_STATE_CONFLICT'),
    );
    await assert.rejects(
      acceptPeopleAccountChange(
        application,
        actor,
        'UPDATE_PROFILE',
        agentId,
        {
          commandId: randomUUID(),
          expectedRevision: disabledAgent.configRevision,
          displayName: 'Name at disable',
          reason: 'Test',
        },
        provider,
      ),
      rejectsWith(409, 'ACCOUNT_STATE_CONFLICT'),
    );
    // admin + second + third = 3 = limit → re-enable would exceed the quota
    assert.equal(await reserved(), 3);
    const enableCommand = {
      commandId: randomUUID(),
      expectedRevision: disabledAgent.configRevision,
      reason: 'User returned to work',
    };
    const overQuota = await enable(agentId, enableCommand);
    assert.equal(overQuota.status, 429, await overQuota.clone().text());
    assert.equal(await changes(), before, 'no command is created when over quota');
    await disable(thirdId);
    assert.equal(await reserved(), 2);
    // incomplete credentials (probe) are rejected before the command is accepted
    probeResult = { outcome: 'REJECTED', reasonCode: 'CREDENTIALS_NOT_READY' };
    const noCredentials = await enable(agentId, { ...enableCommand, commandId: randomUUID() });
    assert.equal(noCredentials.status, 409);
    assert.equal((await readObject(noCredentials)).code, 'CREDENTIALS_NOT_READY');
    probeResult = { outcome: 'READY' };
    // the agent body must not contain displayName/role
    assert.equal((await enable(agentId, { ...enableCommand, displayName: 'x' })).status, 400);

    mutations = 0;
    reads = 0;
    mutateResult = () => ({ outcome: 'UNKNOWN' });
    readResult = () => ({ outcome: 'UNKNOWN' });
    const enableResponse = await enable(agentId, enableCommand);
    assert.equal(enableResponse.status, 202, await enableResponse.clone().text());
    const enabled = await readObject(enableResponse);
    assert.equal(enabled.kind, 'ENABLE_ACCOUNT');
    const enableOperation = String(enabled.operationId);
    // the seat is reserved from when the command is accepted, but the account is still disabled
    assert.equal(await reserved(), 3);
    assert.equal((await user(agentId)).isActive, false);
    assert.equal((await detail(agentId)).accountState, 'DISABLED');
    // another disabled account cannot be re-enabled because the reserved seat makes it full
    await assert.rejects(
      acceptPeopleAccountChange(
        application,
        actor,
        'ENABLE_ACCOUNT',
        thirdId,
        {
          commandId: randomUUID(),
          expectedRevision: (await user(thirdId)).configRevision,
          reason: 'Quota test',
        },
        provider,
      ),
      rejectsWith(429, 'RESOURCE_LIMIT_REACHED'),
    );
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, enableOperation),
      'ACTION_REQUIRED',
    );
    assert.equal((await user(agentId)).isActive, false);
    assert.equal((await detail(agentId)).accountState, 'ATTENTION_REQUIRED');
    assert.equal(
      (await readPeopleOperation(application, actor, enableOperation)).accountState,
      'ATTENTION_REQUIRED',
    );
    // a receipt with the wrong reasonCode for the step is rejected by the database (proof mismatch) without enabling the account
    readResult = (identityId) => ({
      outcome: 'SUCCEEDED',
      reasonCode: 'PROFILE_UPDATED',
      identityId,
      receiptRef: 'f'.repeat(64),
    });
    await assert.rejects(
      runPeopleAccountChange(worker, provider, tenantId, enableOperation),
      /PROOF_MISMATCH/,
    );
    assert.equal((await user(agentId)).isActive, false);
    await owner.$executeRaw`UPDATE tenant_people_account_changes SET revision=revision+1,lease_owner=NULL,lease_expires_at=NULL
      WHERE tenant_id=${tenantId}::uuid AND id=${enableOperation}::uuid`;
    readResult = (identityId) => ({
      outcome: 'SUCCEEDED',
      reasonCode: 'ENABLED',
      identityId,
      receiptRef: 'a'.repeat(64),
    });
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, enableOperation),
      'SUCCEEDED',
    );
    assert.equal(mutations, 1, 'ENABLE_ACCOUNT is not sent again after attempted');
    const reenabled = await user(agentId);
    assert.equal(reenabled.isActive, true);
    assert.equal(reenabled.configRevision, disabledAgent.configRevision + 1);
    assert.equal(reenabled.extension, '1101');
    assert.equal(reenabled.teamId, teamId);
    const reenabledDetail = await detail(agentId);
    assert.notEqual(reenabledDetail.accountState, 'DISABLED');
    assert.equal(reenabledDetail.isActive, true);
    assert.equal(await reserved(), 3);
    // after re-enabling, changing team works as usual (#1000)
    const moved = await acceptPeopleTeamChange(application, actor, agentId, {
      commandId: randomUUID(),
      expectedRevision: reenabled.configRevision,
      teamId: otherTeamId,
      reason: 'Move after re-enable',
    });
    assert.equal(moved.teamId, otherTeamId);
    // renaming works again after re-enabling
    const secondRename = await acceptPeopleAccountChange(
      application,
      actor,
      'UPDATE_PROFILE',
      agentId,
      {
        commandId: randomUUID(),
        expectedRevision: moved.configRevision,
        displayName: 'Somchai Returned',
        reason: 'Test',
      },
      provider,
    );
    assert.equal(secondRename.kind, 'UPDATE_PROFILE');

    // receipt rejects the re-enable: the account stays disabled and the seat is returned
    mutateResult = (identityId) => ({
      outcome: 'REJECTED_NO_EFFECT',
      reasonCode: 'CREDENTIALS_NOT_READY',
      identityId,
      receiptRef: '9'.repeat(64),
    });
    await disable(secondId);
    assert.equal(await reserved(), 2);
    const refusedEnable = await acceptPeopleAccountChange(
      application,
      actor,
      'ENABLE_ACCOUNT',
      secondId,
      {
        commandId: randomUUID(),
        expectedRevision: (await user(secondId)).configRevision,
        reason: 'Reject test',
      },
      provider,
    );
    assert.equal(await reserved(), 3);
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, refusedEnable.operationId),
      'REJECTED',
    );
    assert.equal((await user(secondId)).isActive, false);
    assert.equal((await detail(secondId)).accountState, 'DISABLED');
    assert.equal(await reserved(), 2);

    // database-level blockers: a team that is missing or disabled, and a tombstoned extension
    const [blockers] = await withTenantDatabaseTransaction(
      application,
      tenantId,
      (transaction) =>
        transaction.$queryRaw<{ team: string | null; agentWithoutTeam: string | null }[]>`
        SELECT dc_people_account_change_blocker(${tenantId}::uuid,'ENABLE_ACCOUNT',
          jsonb_build_object('id',${secondId}::text,'role','AGENT','team_id',${randomUUID()}::text,'is_active',false,'disable_operation_id',${randomUUID()}::text)) AS team,
          dc_people_account_change_blocker(${tenantId}::uuid,'ENABLE_ACCOUNT',
          jsonb_build_object('id',${secondId}::text,'role','AGENT','team_id',null,'is_active',false,'disable_operation_id',${randomUUID()}::text)) AS "agentWithoutTeam"`,
    );
    assert.equal(blockers.team, 'REFERENCE_SCOPE_MISMATCH');
    assert.equal(blockers.agentWithoutTeam, 'REFERENCE_SCOPE_MISMATCH');

    // the app cannot edit the ledger/receipt or bypass the accept function
    await assert.rejects(
      withTenantDatabaseTransaction(
        application,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`UPDATE tenant_people_account_changes SET state='SUCCEEDED' WHERE tenant_id=${tenantId}::uuid`,
      ),
      /permission denied/,
    );
    await assert.rejects(
      runPeopleAccountChange(worker, provider, randomUUID(), enableOperation),
      /SCOPE_DENIED/,
    );
    // RLS: another tenant does not see the command
    const [{ count: leaked }] = await withTenantDatabaseTransaction(
      application,
      randomUUID(),
      (transaction) =>
        transaction.$queryRaw<
          { count: bigint }[]
        >`SELECT count(*) AS count FROM tenant_people_account_changes`,
    );
    assert.equal(Number(leaked), 0);

    // the app cannot bypass the accept function: a row that did not go through accept (revision=1) fails to commit, and cannot be created with another status
    const bypassCommand = randomUUID(),
      bypassOperation = randomUUID();
    await assert.rejects(
      withTenantDatabaseTransaction(application, tenantId, async (transaction) => {
        await transaction.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,expected_revision,command_kind)
          VALUES(${tenantId}::uuid,${bypassCommand}::uuid,${adminId}::uuid,'UPDATE_PROFILE',${secondId}::uuid,${'1'.repeat(64)},1,'PEOPLE_ACCOUNT_CHANGE')`;
        await transaction.$executeRaw`INSERT INTO tenant_people_account_changes(tenant_id,id,kind,command_id,actor_user_id,user_id,identity_id,role,expected_revision,snapshot,display_name,payload_digest,issuer,client_id,tenant_slug,reason)
          VALUES(${tenantId}::uuid,${bypassOperation}::uuid,'UPDATE_PROFILE',${bypassCommand}::uuid,${adminId}::uuid,${secondId}::uuid,${secondId}::uuid,'AGENT',1,'{}'::jsonb,'Bypass',${'2'.repeat(64)},'x','x','x','Bypass')`;
        await transaction.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${tenantId}::uuid,${bypassCommand}::uuid,'{}'::jsonb)`;
        await transaction.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,reason_code,correlation_id)
          VALUES(${randomUUID()}::uuid,${tenantId}::uuid,${adminId}::uuid,${secondId}::uuid,${bypassCommand}::uuid,'UPDATE_PROFILE','ACCEPTED','OPERATOR_REQUEST','bypass')`;
      }),
      /ADMISSION_REQUIRED/,
    );
    await assert.rejects(
      withTenantDatabaseTransaction(
        application,
        tenantId,
        (transaction) =>
          transaction.$executeRaw`INSERT INTO tenant_people_account_changes(tenant_id,id,kind,command_id,actor_user_id,user_id,identity_id,role,expected_revision,snapshot,display_name,payload_digest,issuer,client_id,tenant_slug,reason,state,revision)
          VALUES(${tenantId}::uuid,${randomUUID()}::uuid,'UPDATE_PROFILE',${randomUUID()}::uuid,${adminId}::uuid,${secondId}::uuid,${secondId}::uuid,'AGENT',1,'{}'::jsonb,'Bypass',${'2'.repeat(64)},'x','x','x','Bypass','QUEUED',2)`,
      ),
      /IMMUTABLE/,
    );

    // a rename stuck with unknown outcome: repeated reconcile does not add an audit row every round
    mutateResult = () => ({ outcome: 'UNKNOWN' });
    readResult = () => ({ outcome: 'UNKNOWN' });
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, secondRename.operationId),
      'ACTION_REQUIRED',
    );
    const audits = async () =>
      Number(
        (
          await owner.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*) AS count FROM voice_config_audit
            WHERE tenant_id=${tenantId}::uuid AND correlation_id=${secondRename.operationId}`
        )[0].count,
      );
    const firstAudits = await audits();
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, secondRename.operationId),
      'ACTION_REQUIRED',
    );
    assert.equal(
      await audits(),
      firstAudits,
      'repeated reconcile with unknown outcome does not add audit',
    );
    // disable must not be blocked forever: a stuck rename command is closed as REJECTED (SUPERSEDED_BY_DISABLE) and the account can be disabled
    await disable(agentId);
    const [superseded] = await owner.$queryRaw<{ state: string; error_code: string }[]>`
      SELECT state,error_code FROM tenant_people_account_changes WHERE tenant_id=${tenantId}::uuid AND id=${secondRename.operationId}::uuid`;
    assert.deepEqual(superseded, { state: 'REJECTED', error_code: 'SUPERSEDED_BY_DISABLE' });
    assert.equal((await user(agentId)).isActive, false);
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, secondRename.operationId),
      'NOT_ELIGIBLE',
    );
    assert.equal((await user(agentId)).displayName, 'Somchai Jaidee');

    // pending command with unknown outcome: runtime reconciles with GET after a 60-second pause (tested by shifting updated_at)
    const adminRename = await acceptPeopleAccountChange(
      application,
      actor,
      'UPDATE_PROFILE',
      adminId,
      {
        commandId: randomUUID(),
        expectedRevision: (await user(adminId)).configRevision,
        displayName: 'Admin New Name',
        reason: 'Runtime test',
      },
      provider,
    );
    assert.equal(
      await runPeopleAccountChange(worker, provider, tenantId, adminRename.operationId),
      'ACTION_REQUIRED',
    );
    await owner.$executeRaw`UPDATE tenant_people_account_changes SET revision=revision+1,updated_at=clock_timestamp()-interval '2 minutes'
      WHERE tenant_id=${tenantId}::uuid AND id=${adminRename.operationId}::uuid`;
    const mutationsBeforeRuntime = mutations;
    readResult = (identityId) => ({
      outcome: 'SUCCEEDED',
      reasonCode: 'PROFILE_UPDATED',
      identityId,
      receiptRef: '7'.repeat(64),
    });

    // runtime picks up the pending command through the worker binding and only reads the receipt
    runtime = new TenantPeopleRuntime(
      worker,
      new Map([
        [
          tenantId,
          {
            async isReady() {
              return true;
            },
            async mutateStep() {
              assert.fail('account scheduler must not provision');
            },
            async readOutcome() {
              assert.fail('account scheduler must not reconcile provisioning');
            },
          },
        ],
      ]),
      {
        intervalMs: 60_000,
        accounts: new Map([
          [
            tenantId,
            {
              ...provider,
              async isReady() {
                return true;
              },
            },
          ],
        ]),
      },
    );
    assert.equal(await runtime.canChangeAccount(tenantId), false);
    runtime.onModuleInit();
    await runtime.runOnce();
    assert.equal(await runtime.canChangeAccount(tenantId), true);
    assert.equal((await user(adminId)).displayName, 'Admin New Name');
    assert.equal(
      mutations,
      mutationsBeforeRuntime,
      'runtime does not resend UPDATE_PROFILE after attempted',
    );
    await runtime.onModuleDestroy();
    assert.equal(await runtime.canChangeAccount(tenantId), false);
  } finally {
    await runtime?.onModuleDestroy();
    await app?.close();
    await Promise.all([owner.$disconnect(), application.$disconnect(), worker.$disconnect()]);
  }
});
