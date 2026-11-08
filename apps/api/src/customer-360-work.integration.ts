import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { OidcAccessTokenVerifier } from '@d-contact/workspace-session';
import type { PrismaClient } from '@d-contact/db';
import { normalizeC360Email } from '@d-contact/contact-points';
import { setup, ownerCommit, deliverToIam } from './customer-360-test-fixtures.js';
import { Customer360WorkController, CUSTOMER_360_WORK_AUTH } from './customer-360-work-api.js';
import { CUSTOMER_360_DATABASE } from './customer-360-api.js';
import { OIDC_ACCESS_TOKEN_VERIFIER } from './gateway-auth.js';
import { C360WorkAuthService } from './customer-360-work-auth.js';
import { WorkSessionLeases } from './work-session.js';

type WorkTestBody = {
  state: string;
  items: { candidateRef: string }[];
  verified: boolean;
  command: { outcome: string };
  contact: { id: string; displayName: string };
  revisions: { profile: string; lineage: string };
  canEdit: boolean;
};
/** HTTP/PG/RLS ใช้ verifier/introspection สังเคราะห์; actual Keycloak อยู่ boundary แยก */
async function fixture() {
  let online = true;
  let shortProof = false;
  let service!: C360WorkAuthService;
  const f = await setup([Customer360WorkController], undefined, undefined, [
    {
      provide: CUSTOMER_360_WORK_AUTH,
      inject: [CUSTOMER_360_DATABASE, OIDC_ACCESS_TOKEN_VERIFIER],
      useFactory: (db: PrismaClient, verifier: OidcAccessTokenVerifier) => {
        service = new C360WorkAuthService(db, verifier, {
          introspect: async () => ({ active: online }),
        });
        const verify = service.verifyOnline.bind(service);
        service.verifyOnline = async (input) => {
          const proof = await verify(input);
          return shortProof
            ? { ...proof, deadline: new Date(proof.checkStartedAt.getTime() + 600) }
            : proof;
        };
        return service;
      },
    },
  ]);
  const actor = f.actors.get('agent')!;
  const leases = new WorkSessionLeases(f.db);
  const lease = await leases.acquire(
    { tenantId: f.tenantId, userId: actor.id },
    { surface: 'workspace', hostOrigin: null },
    'work-fixture',
  );
  const interactionId = randomUUID();
  await f.owner.interaction.create({
    data: {
      id: interactionId,
      tenantId: f.tenantId,
      agentId: actor.id,
      channel: 'VOICE',
      direction: 'INBOUND',
      state: 'ACTIVE',
    },
  });
  await f.scopes.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: f.segmentId,
    permission: 'WORK',
    correlationId: 'work-grant',
  });
  await f.scopes.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: f.segmentId,
    permission: 'VIEW',
    correlationId: 'view-grant',
  });
  await ownerCommit(f, 'GOLD');
  await deliverToIam(f);
  const email = normalizeC360Email('work@example.test');
  const commandId = randomUUID();
  await f.owner.c360ProfileCommand.create({
    data: {
      tenantId: f.tenantId,
      actorIdentityKey: 'work-fixture',
      commandId,
      action: 'FIXTURE_POINTS',
      resourceType: 'CONTACT',
      payloadDigest: 'f'.repeat(64),
      normalizationContractVersion: 'fixture',
    },
  });
  await f.owner.c360ContactPoint.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId: f.contactId,
      kind: 'EMAIL',
      rawValue: email.rawValue,
      normalizedValue: email.normalizedValue,
      normalizationVersion: email.normalizationVersion,
      state: 'ACTIVE',
      sourceKind: 'PROFILE_COMMAND',
      createdActorIdentityKey: 'work-fixture',
      createdCommandId: commandId,
    },
  });
  await service.reauthenticate({ accessToken: 'agent', leaseId: lease.leaseId });
  const call = async (
    path: string,
    body?: unknown,
    method = body ? 'POST' : 'GET',
    token = 'agent',
    work = interactionId,
  ) => {
    const response = await fetch(`${f.base}/api/v1/customer-360/work/${work}/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-work-session-lease-id': lease.leaseId,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: (await response.json()) as WorkTestBody };
  };
  const search = () => call('candidates/search', { type: 'EMAIL', query: 'work@example.test' });
  return {
    ...f,
    service,
    leases,
    lease,
    interactionId,
    call,
    search,
    setOnline: (value: boolean) => {
      online = value;
    },
    shortenProof: () => {
      shortProof = true;
    },
  };
}

test('C5 HTTP/PG/RLS: explicit opaque candidate, link/replay, จำกัด fields และ completed read-only', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const initial = await f.call('customer');
  assert.equal(initial.status, 200);
  assert.equal(initial.body.state, 'UNLINKED');
  const result = await f.search();
  assert.equal(result.status, 201);
  assert.equal(result.body.items.length, 1);
  assert.equal(result.body.verified, false);
  const candidate = result.body.items[0];
  assert.equal(JSON.stringify(candidate).includes('work@example.test'), false);
  assert.equal(candidate.candidateRef.includes(f.contactId), false);
  assert.equal('contactId' in candidate, false);
  const payload = {
    commandId: randomUUID(),
    expectedLinkageRevision: '0',
    candidateRef: candidate.candidateRef,
  };
  const linked = await f.call('customer-link', payload);
  assert.equal(linked.status, 200);
  assert.equal(linked.body.command.outcome, 'APPLIED');
  // Ref ผูก linkageRevision=0; replay หลัง link=1 ต้องไม่เปิด ref ใหม่หรือ execute ซ้ำ
  assert.deepEqual((await f.call('customer-link', payload)).body, linked.body);
  assert.equal(
    await f.owner.c360InteractionCustomerChange.count({ where: { tenantId: f.tenantId } }),
    1,
  );
  let current = await f.call('customer');
  assert.equal(current.body.contact.id, f.contactId);
  assert.equal(current.body.canEdit, true);
  const update = {
    commandId: randomUUID(),
    expectedLinkageRevision: '1',
    expectedProfileRevision: current.body.revisions.profile,
    expectedLineageRevision: current.body.revisions.lineage,
    displayName: 'ชื่อจากงาน',
    company: 'บริษัทจากงาน',
  };
  assert.equal((await f.call('customer', update, 'PATCH')).status, 200);
  const audits = await f.owner.c360ProfileAudit.count({ where: { tenantId: f.tenantId } });
  assert.equal(
    (
      await f.call(
        'customer',
        { ...update, commandId: randomUUID(), expectedProfileRevision: '1', vip: true },
        'PATCH',
      )
    ).status,
    400,
  );
  assert.equal(await f.owner.c360ProfileAudit.count({ where: { tenantId: f.tenantId } }), audits);
  assert.equal(
    (await f.call('customer', { ...update, commandId: randomUUID() }, 'PATCH')).status,
    409,
  );
  assert.equal((await f.call('customer', undefined, 'GET', 'supervisor')).status, 403);
  assert.equal((await f.call('customer', undefined, 'GET', 'foreign')).status, 403);
  await f.owner.interaction.update({
    where: { id: f.interactionId },
    data: { state: 'COMPLETED' },
  });
  current = await f.call('customer');
  assert.equal(current.status, 200);
  assert.equal(current.body.canEdit, false);
  assert.equal(current.body.contact.displayName, 'ชื่อจากงาน');
  assert.equal(
    (
      await f.call('customer-link', {
        commandId: randomUUID(),
        expectedLinkageRevision: '1',
        candidateRef: null,
        reason: 'จบงาน',
        confirmed: true,
      })
    ).status,
    409,
  );
});

test('C5 deadline หมดระหว่าง receipt INSERT ต้อง rollback link/history/audit/receipt ทั้งชุด', async (t) => {
  const f = await fixture();
  const candidate = (await f.search()).body.items[0]!.candidateRef;
  const commandId = randomUUID();
  // ใช้ trigger wait จริงใน PostgreSQL หลัง effect/audit ก่อน receipt เพื่อพิสูจน์ last-moment check
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION c5_receipt_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command_id='${commandId}'::uuid THEN PERFORM pg_sleep(0.9); END IF; RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    'CREATE TRIGGER c5_receipt_wait BEFORE INSERT ON c360_profile_command_receipts FOR EACH ROW EXECUTE FUNCTION c5_receipt_wait()',
  );
  t.after(async () => {
    await f.owner.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS c5_receipt_wait ON c360_profile_command_receipts',
    );
    await f.owner.$executeRawUnsafe('DROP FUNCTION IF EXISTS c5_receipt_wait()');
    await f.close();
  });
  f.shortenProof();
  const result = await f.call('customer-link', {
    commandId,
    expectedLinkageRevision: '0',
    candidateRef: candidate,
  });
  assert.equal(result.status, 503);
  assert.equal(
    (result.body as unknown as { error: { code: string } }).error.code,
    'WORK_AUTH_PROOF_EXPIRED',
  );
  assert.equal(
    (await f.owner.interaction.findUniqueOrThrow({ where: { id: f.interactionId } })).contactId,
    null,
  );
  assert.equal(
    await f.owner.c360InteractionCustomerChange.count({ where: { tenantId: f.tenantId } }),
    0,
  );
  assert.equal(
    await f.owner.c360ProfileAudit.count({ where: { tenantId: f.tenantId, commandId } }),
    0,
  );
  assert.equal(
    await f.owner.c360ProfileCommandReceipt.count({ where: { tenantId: f.tenantId, commandId } }),
    0,
  );
});

test('C5 reauth/IdP fault: ปิด Cus360 แต่ไม่แก้ Voice state/lease แล้วกู้ binding เดิม', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  f.setOnline(false);
  const denied = await f.search();
  assert.equal(denied.status, 401);
  const row = await f.owner.c360WorkMutationAuth.findFirstOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(row.authState, 'REAUTH_REQUIRED');
  assert.equal(
    (await f.owner.interaction.findUniqueOrThrow({ where: { id: f.interactionId } })).state,
    'ACTIVE',
  );
  assert.equal(
    (await f.owner.agentWorkSessionLease.findUniqueOrThrow({ where: { id: f.lease.leaseId } }))
      .releasedAt,
    null,
  );
  f.setOnline(true);
  assert.equal((await f.call('reauthenticate', {})).status, 201);
  assert.equal((await f.search()).body.items.length, 1);
  await ownerCommit(f, 'SILVER');
  const stale = await f.search();
  assert.equal(stale.status, 503);
  assert.equal(JSON.stringify(stale.body).includes('work@example.test'), false);
});

test('C5 relink/detach: reason+confirmation, history/audit atomically และไม่คืน receipt ข้ามงาน', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const candidate = (await f.search()).body.items[0].candidateRef;
  const firstId = randomUUID();
  assert.equal(
    (
      await f.call('customer-link', {
        commandId: firstId,
        expectedLinkageRevision: '0',
        candidateRef: candidate,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call('customer-link', {
        commandId: randomUUID(),
        expectedLinkageRevision: '1',
        candidateRef: null,
      })
    ).status,
    400,
  );
  const detached = await f.call('customer-link', {
    commandId: randomUUID(),
    expectedLinkageRevision: '1',
    candidateRef: null,
    reason: 'ผู้ใช้เลือกยกเลิกการเชื่อม',
    confirmed: true,
  });
  assert.equal(detached.status, 200);
  assert.equal((await f.call('customer')).body.state, 'UNLINKED');
  const events = await f.owner.c360InteractionCustomerChange.findMany({
    where: { tenantId: f.tenantId },
    orderBy: { afterLinkRevision: 'asc' },
  });
  assert.deepEqual(
    events.map((e) => [e.action, String(e.afterLinkRevision)]),
    [
      ['LINK', '1'],
      ['DETACH', '2'],
    ],
  );
  const another = randomUUID();
  await f.owner.interaction.create({
    data: {
      id: another,
      tenantId: f.tenantId,
      agentId: f.actors.get('agent')!.id,
      channel: 'VOICE',
      direction: 'INBOUND',
      state: 'WRAPUP',
    },
  });
  assert.equal(
    (await f.call(`commands/${firstId}`, undefined, 'GET', 'agent', another)).status,
    404,
  );
});
