import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  c360ActorIdentityKey,
  c360DeferredContactSql,
  c360ReadableContactSql,
  type C360VerifiedActor,
} from '@d-contact/customer-360';
import { Prisma, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  activeHead,
  deliverToIam,
  grantCustodian,
  ownerCommit,
  setup,
  type Fixture,
} from './customer-360-test-fixtures.js';

/**
 * Cus360 C1 (#791) S3: real HTTP → predicate → PostgreSQL/RLS with the application role
 * uses the real owner writers (the C360 segment/membership and the IAM grant/projection), never writing a fake head
 */

const capabilities = (f: Fixture, token: string, contactId = f.contactId) =>
  f.request(`customer-360/contacts/${contactId}/capabilities`, token);

test('S3 HTTP: an Admin needs a custodian grant for that contact; another Admin and a nonexistent contact get the same 404', async () => {
  const f = await setup();
  try {
    const missing = await capabilities(f, 'admin', randomUUID());
    const hidden = await capabilities(f, 'admin');
    assert.equal(missing.status, 404);
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body.error, missing.body.error);

    await grantCustodian(f, 'admin', 'MANAGE');
    // a legacy contact with no identity head yet: readable but not editable, and GET creates no head
    const legacy = await capabilities(f, 'admin');
    assert.equal(legacy.status, 200);
    assert.deepEqual(legacy.body, {
      contactId: f.contactId,
      identity: 'LEGACY_MISSING_HEAD',
      capabilities: { read: true, manage: false },
    } as unknown);
    assert.equal(await f.owner.c360IdentityHead.count({ where: { tenantId: f.tenantId } }), 0);

    await activeHead(f);
    const active = await capabilities(f, 'admin');
    assert.deepEqual((active.body as unknown as { capabilities: unknown }).capabilities, {
      read: true,
      manage: true,
    });
    assert.equal((await capabilities(f, 'admin-two')).status, 404);

    const readOnly = await grantCustodian(f, 'admin-two', 'READ');
    assert.deepEqual(
      ((await capabilities(f, 'admin-two')).body as unknown as { capabilities: unknown })
        .capabilities,
      { read: true, manage: false },
    );
    // revoke the grant append-only and the permission is gone at once
    await f.owner.c360ContactCustodianRevocation.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        grantId: readOnly.grant.id,
        actorIdentityKey: readOnly.actorIdentityKey,
        commandId: readOnly.commandId,
        reason: 'fixture revoke',
        evidenceRef: 'fixture-evidence',
      },
    });
    assert.equal((await capabilities(f, 'admin-two')).status, 404);
  } finally {
    await f.close();
  }
});

test('S3 HTTP: Agent, Compliance, an unbound proof, disabled and another tenant have no generic route', async () => {
  const f = await setup();
  try {
    await grantCustodian(f, 'admin', 'MANAGE');
    for (const [token, status] of [
      ['agent', 403],
      ['compliance', 403],
      ['unbound', 403],
      ['disabled', 403],
      ['foreign', 404],
    ] as const) {
      const response = await capabilities(f, token);
      assert.equal(response.status, status, token);
      assert.equal(JSON.stringify(response.body).includes('ลูกค้า C1'), false); // allow-thai: shared fixture name also asserted by the Console e2e
    }
    for (const token of ['agent', 'supervisor', 'compliance']) {
      assert.equal(
        (await f.request(`customer-360/commands/${randomUUID()}`, token)).status,
        403,
        token,
      );
      assert.equal(
        (await f.request(`customer-360/commands/${randomUUID()}/reconcile`, token, {})).status,
        403,
        token,
      );
    }
  } finally {
    await f.close();
  }
});

test('S3 HTTP: when the current User/proof changes the permission is gone at once (subject proof, role, disable)', async () => {
  const f = await setup();
  try {
    await grantCustodian(f, 'admin', 'MANAGE');
    const adminId = f.actors.get('admin')!.id;
    assert.equal((await capabilities(f, 'admin')).status, 200);
    // the token subject no longer matches the current User (the proof changed) → rejected, and it works again when the proof matches
    await f.owner.user.update({ where: { id: adminId }, data: { keycloakId: randomUUID() } });
    assert.equal((await capabilities(f, 'admin')).status, 403);
    await f.owner.user.update({ where: { id: adminId }, data: { keycloakId: adminId } });
    assert.equal((await capabilities(f, 'admin')).status, 200);
    await f.owner.user.update({ where: { id: adminId }, data: { role: 'SUPERVISOR' } });
    assert.equal((await capabilities(f, 'admin')).status, 403);
    await f.owner.user.update({ where: { id: adminId }, data: { role: 'ADMIN' } });
    assert.equal((await capabilities(f, 'admin')).status, 200);
    await f.owner.user.update({ where: { id: adminId }, data: { isActive: false } });
    assert.equal((await capabilities(f, 'admin')).status, 403);
  } finally {
    await f.close();
  }
});

test('S3 HTTP: a Supervisor can read when IAM VIEW matches the owner revision; projection lag/INVALIDATED is 503, not ALLOW', async () => {
  const f = await setup();
  try {
    assert.equal((await capabilities(f, 'supervisor')).status, 404);
    await f.scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId: f.segmentId,
      permission: 'VIEW',
      correlationId: 'c1-s3-grant',
    });
    // the owner says a member but IAM has not received the event → DEFER
    await ownerCommit(f, 'GOLD');
    const lagging = await capabilities(f, 'supervisor');
    assert.equal(lagging.status, 503);
    assert.equal(lagging.body.error.code, 'SCOPE_UNAVAILABLE');
    assert.equal(lagging.body.error.retryable, true);

    await deliverToIam(f);
    const fresh = await capabilities(f, 'supervisor');
    assert.equal(fresh.status, 200);
    assert.deepEqual((fresh.body as unknown as { capabilities: unknown }).capabilities, {
      read: true,
      manage: false,
    });

    // the owner leaves the segment before Kafka reaches IAM: the old projection IN must not give ALLOW
    await ownerCommit(f, 'SILVER');
    assert.equal((await capabilities(f, 'supervisor')).status, 503);
    await deliverToIam(f);
    assert.equal((await capabilities(f, 'supervisor')).status, 404);

    await ownerCommit(f, 'GOLD');
    await deliverToIam(f, 'IDENTITY_INVALIDATED');
    assert.equal((await capabilities(f, 'supervisor')).status, 503);

    // a resent event of the same revision does not clear INVALIDATED; there must be a new owner revision that IAM catches up with
    await deliverToIam(f, 'ENTERED');
    assert.equal((await capabilities(f, 'supervisor')).status, 503);
    await ownerCommit(f, 'SILVER');
    await deliverToIam(f);
    await ownerCommit(f, 'GOLD');
    await deliverToIam(f);
    assert.equal((await capabilities(f, 'supervisor')).status, 200);

    // an Admin in the same team reads through VIEW but gets no edit permission; an Agent in the same team still has no generic route
    const admin = await capabilities(f, 'admin');
    assert.deepEqual((admin.body as unknown as { capabilities: unknown }).capabilities, {
      read: true,
      manage: false,
    });
    assert.equal((await capabilities(f, 'agent')).status, 403);
  } finally {
    await f.close();
  }
});

test('S3: list/count/detail use the same predicate and DEFER is not counted as a readable item', async () => {
  const f = await setup();
  try {
    await f.scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId: f.segmentId,
      permission: 'VIEW',
      correlationId: 'c1-s3-grant',
    });
    await ownerCommit(f, 'GOLD');
    const supervisor = f.actors.get('supervisor')!;
    const actor: C360VerifiedActor = {
      tenantId: f.tenantId,
      userId: supervisor.id,
      role: 'SUPERVISOR',
      teamId: f.teamId,
    };
    const counts = () =>
      withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
        const [row] = await tx.$queryRaw<{ readable: bigint; deferred: bigint }[]>(Prisma.sql`
          SELECT count(*) FILTER (WHERE ${c360ReadableContactSql(actor)}) AS readable,
                 count(*) FILTER (WHERE ${c360DeferredContactSql(actor)}) AS deferred
          FROM contacts c`);
        return { readable: Number(row!.readable), deferred: Number(row!.deferred) };
      });
    assert.deepEqual(await counts(), { readable: 0, deferred: 1 });
    assert.equal((await capabilities(f, 'supervisor')).status, 503);
    await deliverToIam(f);
    assert.deepEqual(await counts(), { readable: 1, deferred: 0 });
    assert.equal((await capabilities(f, 'supervisor')).status, 200);
    // another tenant: RLS + the predicate return nothing at all
    const outsider = await withTenantDatabaseTransaction(f.db, f.otherTenantId, (tx) =>
      tx.$queryRaw<{ n: bigint }[]>(
        Prisma.sql`SELECT count(*) AS n FROM contacts c WHERE ${c360ReadableContactSql(actor)}`,
      ),
    );
    assert.equal(Number(outsider[0]!.n), 0);
  } finally {
    await f.close();
  }
});

test('S3 HTTP: command receipt/reconcile pass the gate and the receipt hides the ref when the reader loses permission', async () => {
  const f = await setup();
  try {
    const admin = f.actors.get('admin')!;
    const commandId = randomUUID();
    assert.equal((await f.request(`customer-360/commands/${commandId}`)).status, 404);
    const bad = await f.request(`customer-360/commands/${commandId}/reconcile`, 'admin', {
      commandId,
    });
    assert.equal(bad.status, 400);
    const pending = await f.request(`customer-360/commands/not-a-uuid`);
    assert.equal(pending.status, 400);

    const tomb = await f.request(`customer-360/commands/${commandId}/reconcile`, 'admin', {});
    assert.equal(tomb.status, 409);
    assert.equal(
      (tomb.body as unknown as { command: { code: string } }).command.code,
      'COMMAND_NOT_APPLIED',
    );

    // an admin's receipt already committed; the ref points to a contact the admin has no permission to read → the ref is not returned
    const key = {
      tenantId: f.tenantId,
      actorIdentityKey: c360ActorIdentityKey({
        issuer: 'https://core-idp.test/realms/dcontact',
        subject: admin.id,
        tenantId: f.tenantId,
        userId: admin.id,
      }),
      commandId: randomUUID(),
    };
    await f.owner.c360ProfileCommand.create({
      data: {
        ...key,
        actorUserId: admin.id,
        action: 'PROFILE_UPDATE',
        resourceType: 'CONTACT',
        resourceId: f.contactId,
        payloadDigest: 'a'.repeat(64),
        normalizationContractVersion: 'cus360-v1',
      },
    });
    await f.owner.c360ProfileCommandReceipt.create({
      data: {
        ...key,
        outcome: 'APPLIED',
        httpStatus: 200,
        committedRevisions: { profile: '1' },
        resourceRefs: [{ type: 'CONTACT', id: f.contactId }],
      },
    });
    type ReceiptBody = {
      command: { resourceRefs: unknown[]; resourceId: string | null; outcome: string };
    };
    const hiddenRef = (await f.request(`customer-360/commands/${key.commandId}`))
      .body as unknown as ReceiptBody;
    assert.equal(hiddenRef.command.outcome, 'APPLIED');
    assert.deepEqual(hiddenRef.command.resourceRefs, []);
    assert.equal(hiddenRef.command.resourceId, null);
    await grantCustodian(f, 'admin', 'READ');
    const visible = (await f.request(`customer-360/commands/${key.commandId}`))
      .body as unknown as ReceiptBody;
    assert.deepEqual(visible.command.resourceRefs, [{ type: 'CONTACT', id: f.contactId }]);
    // another admin cannot see someone else's command (the key is bound to the actor)
    assert.equal(
      (await f.request(`customer-360/commands/${key.commandId}`, 'admin-two')).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test('S3: create capability must come from an operator grant that is not revoked, and one cannot grant it to oneself', async () => {
  const f = await setup();
  try {
    const { authorizeC360ContactCreate } = await import('@d-contact/customer-360');
    const admin = f.actors.get('admin')!;
    const actor: C360VerifiedActor = {
      tenantId: f.tenantId,
      userId: admin.id,
      role: 'ADMIN',
      teamId: f.teamId,
    };
    const allowed = () =>
      withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
        authorizeC360ContactCreate(tx, actor),
      );
    assert.equal(await allowed(), false);
    const commandId = randomUUID();
    await f.owner.c360ProfileCommand.create({
      data: {
        tenantId: f.tenantId,
        actorIdentityKey: 'operator-fixture',
        commandId,
        actorUserId: admin.id,
        action: 'CAPABILITY_GRANT',
        resourceType: 'USER',
        resourceId: admin.id,
        payloadDigest: 'b'.repeat(64),
        normalizationContractVersion: 'cus360-v1',
      },
    });
    const grant = {
      id: randomUUID(),
      tenantId: f.tenantId,
      granteeUserId: admin.id,
      capability: 'CONTACT_CREATE',
      evidenceRef: 'fixture-evidence',
      actorIdentityKey: 'operator-fixture',
      commandId,
    };
    await assert.rejects(
      withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
        tx.c360ActorCapabilityGrant.create({ data: { ...grant, actorUserId: admin.id } }),
      ),
      /c360_actor_capability_grants_self_check/,
    );
    await withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
      tx.c360ActorCapabilityGrant.create({ data: grant }),
    );
    assert.equal(await allowed(), true);
    // the role is no longer ADMIN so the capability cannot be used
    assert.equal(
      await withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
        authorizeC360ContactCreate(tx, { ...actor, role: 'SUPERVISOR' }),
      ),
      false,
    );
    await withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
      tx.c360ActorCapabilityRevocation.create({
        data: {
          id: randomUUID(),
          tenantId: f.tenantId,
          grantId: grant.id,
          actorIdentityKey: 'operator-fixture',
          commandId,
          reason: 'fixture revoke',
          evidenceRef: 'fixture-evidence',
        },
      }),
    );
    assert.equal(await allowed(), false);
    await assert.rejects(
      withTenantDatabaseTransaction(
        f.db,
        f.tenantId,
        (tx) =>
          tx.$executeRaw`DELETE FROM c360_actor_capability_revocations WHERE tenant_id = ${f.tenantId}::uuid`,
      ),
      /permission denied/,
    );
  } finally {
    await f.close();
  }
});
