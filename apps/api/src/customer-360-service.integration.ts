import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import {
  C360_OPERATOR_CONTRACT_VERSION,
  c360ActorIdentityKey,
  c360ServiceActor,
  executeC360ProfileCommand,
  lockC360ServicePrincipal,
  authorizeC360ServiceCapability,
  authorizeC360ServiceContact,
  recordC360ServiceCreateEvidence,
} from '@d-contact/customer-360';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { setup, type Fixture } from './customer-360-test-fixtures.js';

type Command = Record<string, unknown>;
const receipt = (r: { body: unknown }) =>
  (
    r.body as {
      command: {
        action: string | null;
        outcome: string;
        code: string;
        resourceRefs: { id: string }[];
        committedRevisions: Record<string, string>;
      };
    }
  ).command;
const operate = (
  f: Fixture,
  c: Command,
  options: { id?: string; dryRun?: boolean; token?: string } = {},
) =>
  f.request(
    'customer-360/operator/commands',
    options.token ?? 'operator',
    {
      commandId: options.id ?? randomUUID(),
      evidenceRef: 'ticket:M3-841',
      reasonCode: 'APPROVED_INTEGRATION',
      dryRun: options.dryRun ?? false,
      command: c,
    },
    'POST',
  );
async function bind(f: Fixture) {
  const identity = {
    tenantId: f.tenantId,
    issuer: 'https://service.test/realms/dcontact',
    subject: randomUUID(),
    clientId: 'reference-841',
  };
  const command = {
    action: 'SERVICE_BIND_CREATE',
    ...identity,
    custodianAdminId: f.actors.get('admin')!.id,
  };
  delete (command as Record<string, unknown>).tenantId;
  const r = await operate(f, command);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const id = receipt(r).resourceRefs[0]!.id;
  return { identity, id, command };
}

test('M3-A HTTP: non-domain operator อ่าน receipt และ reconcile ได้เฉพาะ actor namespace ของตน', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    const operatorId = f.actors.get('operator')!.id;
    assert.equal(await f.owner.user.count({ where: { id: operatorId } }), 0);
    f.actors.set('other-operator', {
      id: randomUUID(),
      role: 'PLATFORM-OPERATOR',
      tenantId: f.tenantId,
    });
    f.actors.set('foreign-operator', {
      id: randomUUID(),
      role: 'PLATFORM-OPERATOR',
      tenantId: f.otherTenantId,
    });
    const command = {
      action: 'SERVICE_BIND_CREATE',
      issuer: 'https://service.test',
      subject: randomUUID(),
      clientId: 'recover-841',
      custodianAdminId: f.actors.get('admin')!.id,
    };
    const commandId = randomUUID();
    const path = `customer-360/operator/commands/${commandId}`;
    const crash = new Error('isolated fixture crash after admission');
    await assert.rejects(
      executeC360ProfileCommand(
        f.db,
        {
          tenantId: f.tenantId,
          actorUserId: null,
          actorIdentityKey: c360ActorIdentityKey({
            issuer: 'https://core-idp.test/realms/dcontact',
            subject: operatorId,
            tenantId: f.tenantId,
            userId: operatorId,
          }),
        },
        {
          commandId,
          action: 'OPERATOR_SERVICE_BIND_CREATE',
          resourceType: 'OPERATOR_TARGET',
          resourceId: null,
          expectedRevisions: {},
          normalizationContractVersion: C360_OPERATOR_CONTRACT_VERSION,
          normalizedRequest: {
            command,
            evidenceRef: 'ticket:M3-841',
            reasonCode: 'APPROVED_INTEGRATION',
          },
        },
        { authorize: async () => undefined },
        async () => assert.fail('fixture must stop after admission'),
        {
          afterAdmission: async () => {
            throw crash;
          },
        },
      ),
      (error) => error === crash,
    );
    assert.deepEqual((await f.request(path, 'operator')).body, { state: 'PENDING', commandId });
    for (const token of ['other-operator', 'foreign-operator']) {
      assert.deepEqual((await f.request(path, token)).body, { state: 'UNKNOWN', commandId });
      assert.equal(receipt(await f.request(`${path}/reconcile`, token, {})).action, null);
      assert.deepEqual((await f.request(path, 'operator')).body, { state: 'PENDING', commandId });
    }
    assert.equal((await f.request(`${path}/reconcile`, 'operator', { command })).status, 400);
    const recovered = await f.request(`${path}/reconcile`, 'operator', {});
    assert.equal(recovered.status, 409);
    assert.equal(receipt(recovered).code, 'COMMAND_NOT_APPLIED');
    assert.deepEqual((await operate(f, command, { id: commandId })).body, recovered.body);

    const unseen = randomUUID();
    const tombstone = await f.request(
      `customer-360/operator/commands/${unseen}/reconcile`,
      'operator',
      undefined,
      'POST',
    );
    assert.equal(tombstone.status, 409);
    assert.equal(receipt(tombstone).code, 'COMMAND_NOT_APPLIED');
    assert.deepEqual((await operate(f, command, { id: unseen })).body, tombstone.body);
    assert.equal(await f.owner.intServicePrincipal.count({ where: { tenantId: f.tenantId } }), 0);

    const appliedId = randomUUID();
    const applied = await operate(f, command, { id: appliedId });
    assert.equal(applied.status, 201);
    const readback = `customer-360/operator/commands/${appliedId}`;
    const read = await f.request(readback, 'operator');
    assert.equal(read.headers.get('cache-control'), 'no-store');
    assert.deepEqual(read.body, applied.body);
    assert.deepEqual((await f.request(`${readback}/reconcile`, 'operator', {})).body, applied.body);
  } finally {
    await f.close();
  }
});

test('M3-A HTTP: operator-only, dry-run zero effect, idempotency และ provenance/epoch', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    const command = {
      action: 'SERVICE_BIND_CREATE',
      issuer: 'https://service.test',
      subject: randomUUID(),
      clientId: 'reference',
      custodianAdminId: f.actors.get('admin')!.id,
    };
    for (const token of ['admin', 'agent', 'supervisor', 'compliance'])
      assert.equal((await operate(f, command, { token })).status, 403);
    const preview = await operate(f, command, { dryRun: true });
    assert.equal(preview.status, 200);
    assert.equal((preview.body as unknown as { outcome: string }).outcome, 'WOULD_APPLY');
    assert.equal(await f.owner.intServicePrincipal.count({ where: { tenantId: f.tenantId } }), 0);
    assert.equal(await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId } }), 0);
    assert.equal(await f.owner.c360ProfileAudit.count({ where: { tenantId: f.tenantId } }), 0);
    const id = randomUUID(),
      a = await operate(f, command, { id }),
      b = await operate(f, command, { id });
    assert.equal(
      (
        await operate(f, {
          ...command,
          subject: randomUUID(),
          custodianAdminId: f.actors.get('foreign')!.id,
        })
      ).status,
      404,
    );
    assert.equal((await operate(f, { ...command, tenantId: f.otherTenantId })).status, 400);
    assert.equal(a.status, 201);
    assert.deepEqual(receipt(a), receipt(b));
    assert.equal((await operate(f, { ...command, clientId: 'different' }, { id })).status, 409);
    const p = await f.owner.intServicePrincipal.findFirstOrThrow({
      where: { tenantId: f.tenantId },
    });
    assert.equal(p.authzEpoch, 0n);
    assert.equal(p.evidenceRef, 'ticket:M3-841');
    assert.notEqual(p.serviceActorIdentityKey, p.actorIdentityKey);
    assert.equal(
      p.serviceActorIdentityKey,
      c360ServiceActor(
        {
          tenantId: f.tenantId,
          issuer: command.issuer,
          subject: command.subject,
          clientId: command.clientId,
        },
        p.id,
      ).actorIdentityKey,
    );
    const metadata = await f.request(
      `customer-360/operator/service-principals/${p.id}`,
      'operator',
    );
    assert.equal(metadata.status, 200);
    assert.ok(!JSON.stringify(metadata.body).includes(command.subject));
    assert.equal(
      (await f.request(`customer-360/operator/service-principals/${p.id}`, 'admin')).status,
      403,
    );
    assert.equal((await operate(f, command)).status, 200);
    assert.equal(await f.owner.intServicePrincipal.count({ where: { tenantId: f.tenantId } }), 1);
    await assert.rejects(
      () => f.owner.intServicePrincipal.delete({ where: { id: p.id } }),
      /SERVICE_EVIDENCE_APPEND_ONLY/,
    );
  } finally {
    await f.close();
  }
});

test('M3-A: explicit grants/current custodian, stale epoch, no-op, revoke และ ไม่มี tenant-wide READ', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    const { identity, id } = await bind(f);
    const authorized = () =>
      withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
        const p = await lockC360ServicePrincipal(tx, identity);
        return {
          create: await authorizeC360ServiceCapability(tx, p),
          read: await authorizeC360ServiceContact(tx, p, f.contactId),
        };
      });
    assert.deepEqual(await authorized(), { create: false, read: false });
    const grant = {
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId: id,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    };
    const dry = await operate(f, grant, { dryRun: true });
    assert.equal(dry.status, 200);
    assert.equal(
      (await f.owner.intServicePrincipal.findUniqueOrThrow({ where: { id } })).authzEpoch,
      0n,
    );
    assert.equal((await operate(f, grant)).status, 201);
    assert.deepEqual(await authorized(), { create: true, read: false });
    assert.equal((await operate(f, grant)).status, 409);
    const noop = await operate(f, { ...grant, expectedAuthzEpoch: '1' });
    assert.equal(receipt(noop).outcome, 'NO_OP');
    assert.equal(
      (await f.owner.intServicePrincipal.findUniqueOrThrow({ where: { id } })).authzEpoch,
      1n,
    );
    const rg = await operate(f, {
      action: 'SERVICE_CONTACT_GRANT',
      bindingId: id,
      expectedAuthzEpoch: '1',
      contactId: f.contactId,
      permission: 'READ',
    });
    assert.equal(rg.status, 201);
    assert.deepEqual(await authorized(), { create: true, read: true });
    const foreign = randomUUID();
    await f.owner.contact.create({ data: { id: foreign, tenantId: f.otherTenantId } });
    assert.equal(
      await withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) =>
        authorizeC360ServiceContact(tx, await lockC360ServicePrincipal(tx, identity), foreign),
      ),
      false,
    );
    const cg = await f.owner.intServiceCapabilityGrant.findFirstOrThrow({
      where: { principalId: id },
    });
    assert.equal(
      (
        await operate(f, {
          action: 'SERVICE_CAPABILITY_REVOKE',
          grantId: cg.id,
          expectedAuthzEpoch: '2',
        })
      ).status,
      201,
    );
    assert.deepEqual(await authorized(), { create: false, read: true });
    await f.owner.user.update({
      where: { id: f.actors.get('admin')!.id },
      data: { isActive: false },
    });
    assert.equal(
      (
        await operate(f, {
          action: 'SERVICE_CAPABILITY_GRANT',
          bindingId: id,
          expectedAuthzEpoch: '3',
          capability: 'CONTACT_CREATE',
        })
      ).status,
      422,
    );
    assert.equal(
      (
        await operate(f, {
          action: 'SERVICE_BIND_REPLACE_CUSTODIAN',
          bindingId: id,
          expectedAuthzEpoch: '3',
          custodianAdminId: f.actors.get('admin-two')!.id,
        })
      ).status,
      201,
    );
    assert.equal(
      (await operate(f, { action: 'SERVICE_BIND_DISABLE', bindingId: id, expectedAuthzEpoch: '4' }))
        .status,
      201,
    );
    await assert.rejects(authorized, /INVALID_REQUEST/);
  } finally {
    await f.close();
  }
});

test('M3-A: tenant RLS/FK และ append-only evidence หลัง reapply RLS', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    const { id } = await bind(f);
    const [role] = await f.db.$queryRaw<
      { rolsuper: boolean; rolbypassrls: boolean }[]
    >`SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
    await operate(f, {
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId: id,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    });
    const g = await f.owner.intServiceCapabilityGrant.findFirstOrThrow({
      where: { principalId: id },
    });
    assert.equal(
      await withTenantDatabaseTransaction(f.db, f.otherTenantId, (tx) =>
        tx.intServicePrincipal.count({ where: { id } }),
      ),
      0,
    );
    await assert.rejects(
      () =>
        withTenantDatabaseTransaction(f.db, f.otherTenantId, (tx) =>
          tx.intServiceCapabilityRevocation.create({
            data: {
              id: randomUUID(),
              tenantId: f.otherTenantId,
              grantId: g.id,
              evidenceRef: 'ticket:foreign',
              reasonCode: 'REVOKE',
              actorIdentityKey: g.actorIdentityKey,
              commandId: g.commandId,
            },
          }),
        ),
      /foreign key|violates|constraint/i,
    );
    await assert.rejects(
      () =>
        withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
          tx.intServiceCapabilityGrant.update({
            where: { id: g.id },
            data: { capability: 'OTHER' },
          }),
        ),
      /permission denied|APPEND_ONLY/i,
    );
    await assert.rejects(
      () =>
        f.owner.intServiceCapabilityGrant.update({
          where: { id: g.id },
          data: { capability: 'OTHER' },
        }),
      /APPEND_ONLY/i,
    );
    await assert.rejects(
      () =>
        withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
          tx.intServicePrincipal.update({ where: { id }, data: { subject: 'other' } }),
        ),
      /permission denied|IMMUTABLE/i,
    );
  } finally {
    await f.close();
  }
});

test('M3-A: actual authorization guard แข่ง operator revoke ทั้งสองลำดับ', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    const { id, identity } = await bind(f);
    await operate(f, {
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId: id,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    });
    const g = await f.owner.intServiceCapabilityGrant.findFirstOrThrow({
      where: { principalId: id },
    });
    const revoke = { action: 'SERVICE_CAPABILITY_REVOKE', grantId: g.id, expectedAuthzEpoch: '1' };
    await withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
      const p = await lockC360ServicePrincipal(tx, identity);
      assert.equal(await authorizeC360ServiceCapability(tx, p), true);
      const raced = await operate(f, revoke);
      assert.equal(raced.status, 503);
      assert.equal(await authorizeC360ServiceCapability(tx, p), true);
    });
    assert.equal((await operate(f, revoke)).status, 201);
    await withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
      const p = await lockC360ServicePrincipal(tx, identity);
      assert.equal(await authorizeC360ServiceCapability(tx, p), false);
      await assert.rejects(
        () => lockC360ServicePrincipal(tx, identity, '1'),
        /SERVICE_AUTHORIZATION_CHANGED/,
      );
    });
  } finally {
    await f.close();
  }
});

test('M3-A: rebind และ current User disable serialize กับ locked authorization', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    const { id, identity } = await bind(f);
    await operate(f, {
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId: id,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    });
    const rebind = {
      action: 'SERVICE_BIND_REPLACE_CUSTODIAN',
      bindingId: id,
      expectedAuthzEpoch: '1',
      custodianAdminId: f.actors.get('admin-two')!.id,
    };
    await withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
      const p = await lockC360ServicePrincipal(tx, identity);
      assert.equal(await authorizeC360ServiceCapability(tx, p), true);
      assert.equal((await operate(f, rebind)).status, 503);
      await assert.rejects(
        () =>
          f.owner.$transaction(async (owner) => {
            await owner.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
            await owner.user.update({
              where: { id: f.actors.get('admin')!.id },
              data: { isActive: false },
            });
          }),
        /timeout|55P03|lock/i,
      );
    });
    assert.equal((await operate(f, rebind)).status, 201);
    await f.owner.user.update({
      where: { id: f.actors.get('admin-two')!.id },
      data: { isActive: false },
    });
    await withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
      const p = await lockC360ServicePrincipal(tx, identity);
      assert.equal(p.custodian_admin_id, f.actors.get('admin-two')!.id);
      assert.equal(await authorizeC360ServiceCapability(tx, p), false);
    });
    // Disable/revoke ต้องทำได้แม้ custodian ใช้งานไม่ได้แล้ว
    assert.equal(
      (await operate(f, { action: 'SERVICE_BIND_DISABLE', bindingId: id, expectedAuthzEpoch: '2' }))
        .status,
      201,
    );
  } finally {
    await f.close();
  }
});

test('M3-A: INTEGRATION custody ต้อง exact create-purpose ledger ไม่ใช่ operator/คนละ Contact/tombstone', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    const { id, identity } = await bind(f);
    await operate(f, {
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId: id,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    });
    const actor = c360ServiceActor(identity, id),
      good = randomUUID(),
      wrong = randomUUID(),
      otherContact = randomUUID();
    await f.owner.contact.create({ data: { id: otherContact, tenantId: f.tenantId } });
    for (const [commandId, action, resourceId] of [
      [good, 'CONTACT_CREATE', f.contactId],
      [wrong, 'CONTACT_CREATE', otherContact],
    ] as const) {
      await f.owner.c360ProfileCommand.create({
        data: {
          tenantId: f.tenantId,
          actorIdentityKey: actor.actorIdentityKey,
          actorUserId: null,
          commandId,
          action,
          resourceType: 'CONTACT',
          resourceId,
          payloadDigest: 'a'.repeat(64),
          normalizationContractVersion: 'fixture-v1',
        },
      });
    }
    const data = (commandId: string) => ({
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId: f.contactId,
      granteeUserId: f.actors.get('admin')!.id,
      permission: 'MANAGE',
      origin: 'INTEGRATION',
      integrationPrincipalId: id,
      actorIdentityKey: actor.actorIdentityKey,
      actorUserId: null,
      commandId,
      evidenceRef: 'ticket:INTEGRATION-841',
    });
    await assert.rejects(
      () =>
        withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
          tx.c360ContactCustodianGrant.create({ data: data(good) }),
        ),
      /INTEGRATION_CUSTODY_EVIDENCE_REQUIRED/,
    );
    await assert.rejects(
      () =>
        withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
          const p = await lockC360ServicePrincipal(tx, identity);
          await recordC360ServiceCreateEvidence(
            tx,
            p,
            { commandId: wrong, actorIdentityKey: actor.actorIdentityKey },
            f.contactId,
          );
        }),
      /SERVICE_CREATE_PURPOSE_REQUIRED/,
    );
    const unrelated = randomUUID();
    await f.owner.c360ProfileCommand.create({
      data: {
        tenantId: f.tenantId,
        actorIdentityKey: actor.actorIdentityKey,
        commandId: unrelated,
        action: 'SERVICE_READ',
        resourceType: 'CONTACT',
        resourceId: f.contactId,
        payloadDigest: 'a'.repeat(64),
        normalizationContractVersion: 'fixture-v1',
      },
    });
    await assert.rejects(
      () =>
        withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
          const p = await lockC360ServicePrincipal(tx, identity);
          await recordC360ServiceCreateEvidence(
            tx,
            p,
            { commandId: unrelated, actorIdentityKey: actor.actorIdentityKey },
            f.contactId,
          );
        }),
      /SERVICE_CREATE_PURPOSE_REQUIRED/,
    );
    const tombstone = randomUUID();
    await f.owner.c360ProfileCommand.create({
      data: {
        tenantId: f.tenantId,
        actorIdentityKey: actor.actorIdentityKey,
        commandId: tombstone,
        isTombstone: true,
      },
    });
    await assert.rejects(
      () =>
        withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
          const p = await lockC360ServicePrincipal(tx, identity);
          await recordC360ServiceCreateEvidence(
            tx,
            p,
            { commandId: tombstone, actorIdentityKey: actor.actorIdentityKey },
            f.contactId,
          );
        }),
      /SERVICE_CREATE_PURPOSE_REQUIRED/,
    );
    await withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
      const p = await lockC360ServicePrincipal(tx, identity);
      await recordC360ServiceCreateEvidence(
        tx,
        p,
        { commandId: good, actorIdentityKey: actor.actorIdentityKey },
        f.contactId,
      );
      await tx.c360ContactCustodianGrant.create({ data: data(good) });
    });
    const stored = await f.owner.c360ContactCustodianGrant.findFirstOrThrow({
      where: { integrationPrincipalId: id },
    });
    assert.equal(stored.origin, 'INTEGRATION');
    assert.equal(stored.actorUserId, null);
    assert.equal(
      await f.owner.intServiceCommandEvidence.count({ where: { tenantId: f.tenantId } }),
      1,
    );
    await assert.rejects(
      () => f.owner.intServiceCommandEvidence.deleteMany({ where: { tenantId: f.tenantId } }),
      /APPEND_ONLY/,
    );
  } finally {
    await f.close();
  }
});
