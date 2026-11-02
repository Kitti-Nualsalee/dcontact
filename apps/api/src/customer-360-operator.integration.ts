import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  authorizeC360ContactAccess,
  authorizeC360ContactCreate,
  type C360VerifiedActor,
} from '@d-contact/customer-360';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { ownerCommit, deliverToIam, setup, type Fixture } from './customer-360-test-fixtures.js';

/**
 * Cus360 C1 (#791) S5: operator grant/revoke/recovery/seed/head-init ตาม E1 D ผ่าน HTTP จริง
 * และ synthetic fixture matrix (≥2 tenants, หลาย roles, legacy/shared/ambiguous/merged/revoked)
 */
async function operatorSetup() {
  return setup([Customer360OperatorController]);
}

type Body = Record<string, unknown>;

function operate(
  f: Fixture,
  command: Body,
  options: { token?: string; commandId?: string; dryRun?: boolean; evidenceRef?: string } = {},
) {
  return f.request(
    'customer-360/operator/commands',
    options.token ?? 'operator',
    {
      commandId: options.commandId ?? randomUUID(),
      evidenceRef: options.evidenceRef ?? 'ticket:OPS-791',
      reasonCode: 'APPROVED_CUSTODIAN',
      ...(options.dryRun ? { dryRun: true } : {}),
      command,
    },
    'POST',
  );
}

const receipt = (response: { body: unknown }) =>
  (response.body as { command: { outcome: string; code: string | null; resourceRefs: unknown[] } })
    .command;

function actor(f: Fixture, token: string, role: C360VerifiedActor['role'] = 'ADMIN') {
  return { tenantId: f.tenantId, userId: f.actors.get(token)!.id, role, teamId: f.teamId };
}

const access = (f: Fixture, who: C360VerifiedActor, contactId: string = f.contactId) =>
  withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
    authorizeC360ContactAccess(tx, who, contactId),
  );

async function contact(f: Fixture, tenantId = f.tenantId) {
  const id = randomUUID();
  await f.owner.contact.create({ data: { id, tenantId, displayName: `ลูกค้าสังเคราะห์ ${id}` } });
  return id;
}

test('S5 HTTP: custodian grant เฉพาะ platform-operator มี dry-run ไม่มี PII, evidence/audit และ idempotency', async () => {
  const f = await operatorSetup();
  try {
    const grant = {
      action: 'CUSTODIAN_GRANT',
      contactId: f.contactId,
      granteeUserId: f.actors.get('admin')!.id,
      permission: 'READ',
    };
    for (const token of ['admin', 'compliance', 'supervisor', 'agent'])
      assert.equal((await operate(f, grant, { token })).status, 403);

    const preview = await operate(f, grant, { dryRun: true });
    assert.equal(preview.status, 200);
    assert.equal((preview.body as unknown as Body).outcome, 'WOULD_APPLY');
    const text = JSON.stringify(preview.body);
    assert.ok(!text.includes('@core.test') && !text.includes('ลูกค้า'), 'preview ต้องไม่มี PII');
    assert.equal(await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId } }), 0);

    const commandId = randomUUID();
    const applied = await operate(f, grant, { commandId });
    assert.equal(applied.status, 201);
    assert.equal(receipt(applied).outcome, 'APPLIED');
    const rows = await f.owner.c360ContactCustodianGrant.findMany({
      where: { tenantId: f.tenantId },
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.origin, 'OPERATOR');
    assert.equal(rows[0]!.evidenceRef, 'ticket:OPS-791');
    assert.equal(rows[0]!.actorUserId, null);
    const audits = await f.owner.c360ProfileAudit.findMany({ where: { tenantId: f.tenantId } });
    assert.deepEqual(
      audits.map((row) => [row.operation, row.evidenceRefs]),
      [['CUSTODIAN_GRANT', ['ticket:OPS-791', 'reason:APPROVED_CUSTODIAN']]],
    );
    assert.deepEqual(await access(f, actor(f, 'admin')), {
      decision: 'ALLOW',
      read: true,
      manage: false,
      basis: 'CUSTODIAN_READ',
      identity: 'LEGACY_MISSING_HEAD',
    });

    // replay เดิมคืน receipt เดิม; payload ต่างใต้ ID เดิม 409; คำสั่งใหม่ซ้ำสิทธิ์เดิมเป็น NO_OP
    const replay = await operate(f, grant, { commandId });
    assert.deepEqual(receipt(replay), receipt(applied));
    assert.equal((await operate(f, { ...grant, permission: 'MANAGE' }, { commandId })).status, 409);
    const again = await operate(f, grant);
    assert.equal(receipt(again).outcome, 'NO_OP');
    assert.equal(
      await f.owner.c360ContactCustodianGrant.count({ where: { tenantId: f.tenantId } }),
      1,
    );
    assert.equal(await f.owner.c360ProfileAudit.count({ where: { tenantId: f.tenantId } }), 1);

    // evidence/reason เป็น reference และ code เท่านั้น
    assert.equal((await operate(f, grant, { evidenceRef: 'ข้อความอิสระ มี PII' })).status, 400);
  } finally {
    await f.close();
  }
});

test('S5: grantee ต้องเป็น active ADMIN ที่ไม่ใช่ operator เอง และ contact ต้องเป็น canonical ใน tenant', async () => {
  const f = await operatorSetup();
  try {
    const grant = (granteeUserId: string, contactId = f.contactId) => ({
      action: 'CUSTODIAN_GRANT',
      contactId,
      granteeUserId,
      permission: 'MANAGE',
    });
    const rejected = async (body: Body) => {
      const response = await operate(f, body);
      return [response.status, receipt(response).outcome, receipt(response).code];
    };
    assert.deepEqual(await rejected(grant(f.actors.get('supervisor')!.id)), [
      422,
      'REJECTED',
      'GRANTEE_NOT_ACTIVE_ADMIN',
    ]);
    assert.deepEqual(await rejected(grant(f.actors.get('disabled')!.id)), [
      422,
      'REJECTED',
      'GRANTEE_NOT_ACTIVE_ADMIN',
    ]);
    // บัญชี Admin ที่ผูก subject เดียวกับ operator = self-grant
    const self = randomUUID();
    await f.owner.user.create({
      data: {
        id: self,
        tenantId: f.tenantId,
        keycloakId: f.actors.get('operator')!.id,
        role: 'ADMIN',
        email: `${self}@core.test`,
        displayName: 'operator-self',
        passwordHash: '!keycloak-managed',
        isActive: true,
      },
    });
    assert.deepEqual(await rejected(grant(self)), [422, 'REJECTED', 'SELF_GRANT_FORBIDDEN']);
    // contact/grantee ต่าง tenant มองไม่เห็นผ่าน RLS
    const foreignContact = await contact(f, f.otherTenantId);
    assert.deepEqual(await rejected(grant(f.actors.get('admin')!.id, foreignContact)), [
      404,
      'REJECTED',
      'CONTACT_NOT_FOUND',
    ]);
    assert.deepEqual(await rejected(grant(f.actors.get('foreign')!.id)), [
      404,
      'REJECTED',
      'GRANTEE_NOT_FOUND',
    ]);
    assert.equal(
      await f.owner.c360ContactCustodianGrant.count({ where: { tenantId: f.tenantId } }),
      0,
    );
    assert.equal(await f.owner.c360ProfileAudit.count({ where: { tenantId: f.tenantId } }), 0);
  } finally {
    await f.close();
  }
});

test('S5: head init ผ่าน owner, recovery ถอน grant เดิมพร้อมให้ Admin ใหม่ใน transaction เดียว และ revoke idempotent', async () => {
  const f = await operatorSetup();
  try {
    const admin = f.actors.get('admin')!.id;
    const adminTwo = f.actors.get('admin-two')!.id;
    await operate(f, {
      action: 'CUSTODIAN_GRANT',
      contactId: f.contactId,
      granteeUserId: admin,
      permission: 'MANAGE',
    });
    assert.equal((await access(f, actor(f, 'admin'))).decision, 'ALLOW');
    assert.equal(((await access(f, actor(f, 'admin'))) as { manage: boolean }).manage, false);

    const init = await operate(f, { action: 'IDENTITY_HEAD_INIT', contactId: f.contactId });
    assert.equal(receipt(init).outcome, 'APPLIED');
    assert.equal(
      receipt(await operate(f, { action: 'IDENTITY_HEAD_INIT', contactId: f.contactId })).outcome,
      'NO_OP',
    );
    assert.equal(((await access(f, actor(f, 'admin'))) as { manage: boolean }).manage, true);

    // Admin เดิมถูกปิดบัญชี: สิทธิ์ใช้ไม่ได้ตาม active gate; operator กู้ไปที่ admin-two ตามหลักฐาน
    await f.owner.user.update({ where: { id: admin }, data: { isActive: false } });
    const [old] = await f.owner.c360ContactCustodianGrant.findMany({
      where: { tenantId: f.tenantId, granteeUserId: admin },
    });
    const otherContact = await contact(f);
    const foreignGrant = await operate(f, {
      action: 'CUSTODIAN_GRANT',
      contactId: otherContact,
      granteeUserId: adminTwo,
      permission: 'READ',
    });
    assert.equal(receipt(foreignGrant).outcome, 'APPLIED');
    const [otherGrant] = await f.owner.c360ContactCustodianGrant.findMany({
      where: { tenantId: f.tenantId, contactId: otherContact },
    });
    const recover = (revokeGrantIds: string[]) =>
      operate(f, {
        action: 'CUSTODIAN_RECOVER',
        contactId: f.contactId,
        granteeUserId: adminTwo,
        permission: 'MANAGE',
        revokeGrantIds,
      });
    assert.equal(receipt(await recover([otherGrant!.id])).code, 'GRANT_NOT_REVOCABLE');
    const recovered = await recover([old!.id]);
    assert.equal(receipt(recovered).outcome, 'APPLIED');
    assert.equal(
      await f.owner.c360ContactCustodianRevocation.count({
        where: { tenantId: f.tenantId, grantId: old!.id },
      }),
      1,
    );
    assert.deepEqual((await access(f, actor(f, 'admin-two'))) as unknown, {
      decision: 'ALLOW',
      read: true,
      manage: true,
      basis: 'CUSTODIAN_MANAGE',
      identity: 'ACTIVE',
    });
    // creator เดิมกลับมา active ก็ไม่ได้สิทธิ์คืน เพราะ grant ถูกถอนแบบ append-only
    await f.owner.user.update({ where: { id: admin }, data: { isActive: true } });
    assert.equal((await access(f, actor(f, 'admin'))).decision, 'DENY');
    const revokeAgain = await operate(f, { action: 'CUSTODIAN_REVOKE', grantId: old!.id });
    assert.equal(receipt(revokeAgain).outcome, 'NO_OP');
    // grant/revocation เป็นหลักฐาน append-only แม้ application role ก็แก้ไม่ได้
    await assert.rejects(
      f.db
        .$executeRaw`UPDATE c360_contact_custodian_grants SET permission = 'READ' WHERE id = ${old!.id}::uuid`,
    );
  } finally {
    await f.close();
  }
});

test('S5: create capability grant/revoke และ tag seed ใช้ validator เดียวกับ M1 พร้อม RETIRED reserve', async () => {
  const f = await operatorSetup();
  try {
    const adminTwo = actor(f, 'admin-two');
    const canCreate = () =>
      withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
        authorizeC360ContactCreate(tx, adminTwo),
      );
    const granted = await operate(f, {
      action: 'CAPABILITY_GRANT',
      granteeUserId: adminTwo.userId,
      capability: 'CONTACT_CREATE',
    });
    assert.equal(receipt(granted).outcome, 'APPLIED');
    assert.equal(await canCreate(), true);
    const [capability] = await f.owner.c360ActorCapabilityGrant.findMany({
      where: { tenantId: f.tenantId },
    });
    assert.equal(
      receipt(await operate(f, { action: 'CAPABILITY_REVOKE', grantId: capability!.id })).outcome,
      'APPLIED',
    );
    assert.equal(await canCreate(), false);
    assert.equal(
      receipt(await operate(f, { action: 'CAPABILITY_REVOKE', grantId: capability!.id })).outcome,
      'NO_OP',
    );

    const preview = await operate(
      f,
      { action: 'TAG_SEED', names: ['VIP', 'Straße'] },
      { dryRun: true },
    );
    assert.equal((preview.body as unknown as Body).outcome, 'WOULD_APPLY');
    assert.equal(await f.owner.c360Tag.count({ where: { tenantId: f.tenantId } }), 0);
    const seeded = await operate(f, { action: 'TAG_SEED', names: ['  VIP ', 'Straße'] });
    assert.equal(receipt(seeded).outcome, 'APPLIED');
    const tags = await f.owner.c360Tag.findMany({
      where: { tenantId: f.tenantId },
      orderBy: { nameKey: 'asc' },
    });
    assert.deepEqual(
      tags.map((tag) => [tag.name, tag.nameKey, tag.state, tag.evidenceRef]),
      [
        ['Straße', 'strasse', 'ACTIVE', 'ticket:OPS-791'],
        ['VIP', 'vip', 'ACTIVE', 'ticket:OPS-791'],
      ],
    );
    assert.equal(
      receipt(await operate(f, { action: 'TAG_SEED', names: ['vip', 'STRASSE'] })).outcome,
      'NO_OP',
    );
    assert.equal(
      receipt(await operate(f, { action: 'TAG_SEED', names: ['Gold', 'GOLD'] })).code,
      'TAG_NAME_DUPLICATE',
    );
    assert.equal((await operate(f, { action: 'TAG_SEED', names: ['x'.repeat(81)] })).status, 400);

    // ชื่อของ tag ที่ RETIRED แล้วถูกสงวน ไม่สร้างซ้ำ
    const vip = tags.find((tag) => tag.nameKey === 'vip')!;
    await f.owner.c360Tag.update({
      where: { id: vip.id },
      data: { state: 'RETIRED', retiredAt: new Date(), revision: vip.revision + 1n },
    });
    assert.equal(
      receipt(await operate(f, { action: 'TAG_SEED', names: ['Vip'] })).code,
      'TAG_NAME_RESERVED',
    );
  } finally {
    await f.close();
  }
});

test('S5 fixture: synthetic matrix ≥2 tenants/legacy/shared/ambiguous/merged/revoked ตัดสินตาม E1 และไม่แตะ tenant อื่น', async () => {
  const startedAt = new Date(Date.now() - 1000);
  const f = await operatorSetup();
  try {
    const admin = actor(f, 'admin');
    const adminId = admin.userId;
    const grant = (contactId: string, permission = 'MANAGE') =>
      operate(f, { action: 'CUSTODIAN_GRANT', contactId, granteeUserId: adminId, permission });

    // legacy: ไม่มี head, READ grant อ่านได้แต่แก้ไม่ได้
    const legacy = await contact(f);
    await grant(legacy, 'READ');
    // shared: point ค่าเดียวกันบนสอง contact (fixture ของ output C4 ใต้ command สังเคราะห์) ไม่รวมสิทธิ์กัน
    const sharedA = await contact(f);
    const sharedB = await contact(f);
    const fixtureKey = `synthetic-fixture-writer:${randomUUID()}`;
    const fixtureCommand = randomUUID();
    await f.owner.c360ProfileCommand.create({
      data: {
        tenantId: f.tenantId,
        actorIdentityKey: fixtureKey,
        commandId: fixtureCommand,
        action: 'FIXTURE_POINTS',
        resourceType: 'CONTACT',
        payloadDigest: '0'.repeat(64),
        normalizationContractVersion: 'fixture',
      },
    });
    for (const contactId of [sharedA, sharedB]) {
      await f.owner.$executeRaw`INSERT INTO c360_contact_points
        (id, tenant_id, contact_id, kind, raw_value, normalized_value, normalization_version, state,
         source_kind, created_actor_identity_key, created_command_id)
        VALUES (${randomUUID()}::uuid, ${f.tenantId}::uuid, ${contactId}::uuid, 'PHONE', '+1 213 373 4253',
          '+12133734253', 'fixture', 'ACTIVE', 'PROFILE_COMMAND', ${fixtureKey}, ${fixtureCommand}::uuid)`;
    }
    await grant(sharedA, 'READ');
    // ambiguous: head AMBIGUOUS จาก migration inventory ให้ operator grant ไม่ได้
    const ambiguous = await contact(f);
    await f.owner.c360IdentityHead.create({
      data: {
        tenantId: f.tenantId,
        contactId: ambiguous,
        canonicalContactId: ambiguous,
        state: 'AMBIGUOUS',
        stateDigest: 'a'.repeat(64),
      },
    });
    // merged: grant ไม่ตามไป canonical target และ grant ใหม่บน source ถูกปฏิเสธ
    const mergedSource = await contact(f);
    const mergedTarget = await contact(f);
    await grant(mergedSource, 'MANAGE');
    await f.memberships.recordIdentityTransition({
      tenantId: f.tenantId,
      commandId: `identity:${randomUUID()}`,
      operation: 'MERGE',
      sourceContactId: mergedSource,
      targetContactId: mergedTarget,
      expectedSourceLineageRevision: 0,
      correlationId: 'c1-s5-fixture-merge',
    });
    // revoked custodian และ revoked IAM scope
    const revoked = await contact(f);
    await grant(revoked, 'MANAGE');
    const [revokedGrant] = await f.owner.c360ContactCustodianGrant.findMany({
      where: { tenantId: f.tenantId, contactId: revoked },
    });
    await operate(f, { action: 'CUSTODIAN_REVOKE', grantId: revokedGrant!.id });
    const scope = await f.scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId: f.segmentId,
      permission: 'VIEW',
      correlationId: 'c1-s5-fixture-scope',
    });
    await ownerCommit(f, 'GOLD');
    await deliverToIam(f);
    const supervisor = actor(f, 'supervisor', 'SUPERVISOR');
    assert.equal((await access(f, supervisor)).decision, 'ALLOW');
    await f.scopes.revoke({
      tenantId: f.tenantId,
      grantId: scope.grant.id,
      reasonCode: 'C1_S5_FIXTURE',
      correlationId: 'c1-s5-fixture-revoke',
    });

    const summary = async (who: C360VerifiedActor, contactId: string) => {
      const result = await access(f, who, contactId);
      return result.decision === 'ALLOW'
        ? `ALLOW:${result.manage ? 'MANAGE' : 'READ'}:${result.identity}`
        : result.decision;
    };
    assert.deepEqual(
      {
        legacy: await summary(admin, legacy),
        sharedA: await summary(admin, sharedA),
        sharedB: await summary(admin, sharedB),
        ambiguous: await summary(admin, ambiguous),
        mergedSource: await summary(admin, mergedSource),
        mergedTarget: await summary(admin, mergedTarget),
        revoked: await summary(admin, revoked),
        revokedScope: await summary(supervisor, f.contactId),
        otherAdmin: await summary(actor(f, 'admin-two'), legacy),
        agent: await summary(actor(f, 'agent', 'AGENT'), legacy),
      },
      {
        legacy: 'ALLOW:READ:LEGACY_MISSING_HEAD',
        sharedA: 'ALLOW:READ:LEGACY_MISSING_HEAD',
        sharedB: 'DENY',
        ambiguous: 'DENY',
        mergedSource: 'ALLOW:READ:MERGED',
        mergedTarget: 'DENY',
        revoked: 'DENY',
        revokedScope: 'DENY',
        otherAdmin: 'DENY',
        agent: 'DENY',
      },
    );
    assert.equal(receipt(await grant(ambiguous)).code, 'CONTACT_NOT_CANONICAL');
    assert.equal(receipt(await grant(mergedSource)).code, 'CONTACT_NOT_CANONICAL');
    // tenant ที่สองมี Admin ของตัวเองแต่ไม่เห็นอะไรของ tenant แรก
    const foreign = {
      tenantId: f.otherTenantId,
      userId: f.actors.get('foreign')!.id,
      role: 'ADMIN' as const,
      teamId: null,
    };
    const crossTenant = await withTenantDatabaseTransaction(f.db, f.otherTenantId, (tx) =>
      authorizeC360ContactAccess(tx, foreign, legacy),
    );
    assert.equal(crossTenant.decision, 'DENY');
    // fixture เขียนเฉพาะ tenant สังเคราะห์ที่สร้างขึ้นใหม่ใน run นี้ ไม่แตะบัญชีจริง/บัญชีพักของ tenant อื่น
    const fixtureTenants = [f.tenantId, f.otherTenantId];
    const tenants = await f.owner.tenant.findMany({ where: { id: { in: fixtureTenants } } });
    assert.ok(tenants.every((tenant) => tenant.createdAt >= startedAt));
    const keys = (
      await f.owner.c360ProfileCommand.findMany({
        where: { tenantId: f.tenantId },
        select: { actorIdentityKey: true },
      })
    ).map((row) => row.actorIdentityKey);
    assert.equal(
      await f.owner.c360ProfileCommand.count({
        where: { actorIdentityKey: { in: keys }, tenantId: { notIn: fixtureTenants } },
      }),
      0,
    );
    assert.equal(
      await f.owner.user.count({
        where: {
          id: { in: [...f.actors.values()].map((a) => a.id) },
          tenantId: { notIn: fixtureTenants },
        },
      }),
      0,
    );
  } finally {
    await f.close();
  }
});
