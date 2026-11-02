import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  C360SegmentEvaluator,
  C360SegmentMembershipRepository,
  C360SegmentRepository,
  c360ActorIdentityKey,
  c360DeferredContactSql,
  c360ReadableContactSql,
  type C360VerifiedActor,
} from '@d-contact/customer-360';
import { Prisma, withTenantDatabaseTransaction } from '@d-contact/db';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
import type { SegmentMembershipChangePayloadV1 } from '@d-contact/cxa-contracts';
import { Customer360Controller } from './customer-360-api.js';
import { coreFixture } from './tenant-core-test-fixtures.js';

/**
 * Cus360 C1 (#791) S3: HTTP จริง → predicate → PostgreSQL/RLS ด้วย application role
 * ใช้ owner writers จริง (segment/membership ของ C360 และ grant/projection ของ IAM) ไม่เขียน head ปลอม
 */
type Fixture = Awaited<ReturnType<typeof setup>>;

async function setup() {
  const f = await coreFixture([Customer360Controller]);
  const contactId = randomUUID();
  await f.owner.contact.create({
    data: { id: contactId, tenantId: f.tenantId, displayName: 'ลูกค้า C1' },
  });
  const segmentId = `segment:c1-${f.tenantId.slice(0, 8)}`;
  const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
  const segments = new C360SegmentRepository(f.db, evaluator);
  const draft = await segments.createVersion({
    tenantId: f.tenantId,
    segmentId,
    version: 1,
    definition: {
      contractVersion: 1,
      name: 'C1 VIEW',
      expression: {
        language: 'DC_EXPR',
        version: 1,
        expression: {
          type: 'comparison',
          operator: 'eq',
          left: { type: 'ref', path: ['contact', 'tier'] },
          right: { type: 'literal', value: 'GOLD' },
        },
      },
    },
    correlationId: 'c1-s3-definition',
  });
  await segments.publishVersion({
    tenantId: f.tenantId,
    segmentId,
    version: 1,
    expectedContentDigest: draft.contentDigest,
    expectedHeadVersion: 0,
  });
  return {
    ...f,
    contactId,
    segmentId,
    segments,
    memberships: new C360SegmentMembershipRepository(f.db, evaluator),
    scopes: new IamTeamSegmentScopeRepository(f.db),
    snapshotVersion: 0,
    membershipRevision: 0,
  };
}

/** owner commit (C360) โดยไม่ส่งต่อให้ IAM — จำลอง projection lag ก่อน Kafka */
async function ownerCommit(f: Fixture, tier: 'GOLD' | 'SILVER') {
  f.snapshotVersion += 1;
  await f.segments.recordFactSnapshot({
    tenantId: f.tenantId,
    contactId: f.contactId,
    snapshotVersion: f.snapshotVersion,
    attributes: { tier: { type: 'STRING', value: tier } },
    computed: {},
    sourceCutoffAt: new Date().toISOString(),
    correlationId: `c1-s3-snapshot-${f.snapshotVersion}`,
  });
  const result = await f.memberships.commitEvaluation({
    tenantId: f.tenantId,
    contactId: f.contactId,
    segmentId: f.segmentId,
    segmentDefinitionVersion: 1,
    snapshotVersion: f.snapshotVersion,
    expectedMembershipRevision: f.membershipRevision,
    commandId: `command:${randomUUID()}`,
    correlationId: `c1-s3-${randomUUID()}`,
  });
  f.membershipRevision = result.membershipRevision;
}

/** IAM consumer รับ event ของ head ปัจจุบัน (เส้นทางเดียวกับ Kafka consumer จริง) */
async function deliverToIam(
  f: Fixture,
  changeKind?: SegmentMembershipChangePayloadV1['changeKind'],
) {
  const head = await f.owner.c360SegmentMembershipHead.findUniqueOrThrow({
    where: {
      tenantId_contactId_segmentId: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        segmentId: f.segmentId,
      },
    },
  });
  await f.scopes.applyMembershipChange({
    tenantId: f.tenantId,
    eventId: randomUUID(),
    occurredAt: new Date().toISOString(),
    consumerGroup: 'iam-scope-c1-s3',
    payload: {
      contractVersion: 1,
      changeKind: changeKind ?? (head.state === 'IN' ? 'ENTERED' : 'LEFT'),
      contactId: head.contactId,
      segmentId: head.segmentId,
      entryId: head.entryId,
      segmentDefinitionVersion: head.segmentDefinitionVersion,
      membershipRevision: head.membershipRevision,
      snapshotVersion: head.snapshotVersion,
      evaluatedAt: head.evaluatedAt.toISOString(),
      stateDigest: head.stateDigest,
      evidenceRef: head.evidenceRef,
    } as unknown as SegmentMembershipChangePayloadV1,
  });
}

async function grantCustodian(f: Fixture, token: string, permission: 'READ' | 'MANAGE') {
  const actor = f.actors.get(token)!;
  const commandId = randomUUID();
  const actorIdentityKey = 'operator-fixture';
  await f.owner.c360ProfileCommand.create({
    data: {
      tenantId: f.tenantId,
      actorIdentityKey,
      commandId,
      action: 'CUSTODIAN_GRANT',
      resourceType: 'CONTACT',
      resourceId: f.contactId,
      payloadDigest: 'f'.repeat(64),
      normalizationContractVersion: 'cus360-v1',
    },
  });
  const grant = await f.owner.c360ContactCustodianGrant.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId: f.contactId,
      granteeUserId: actor.id,
      permission,
      origin: 'OPERATOR',
      evidenceRef: 'fixture-evidence',
      actorIdentityKey,
      commandId,
    },
  });
  return { grant, commandId, actorIdentityKey };
}

async function activeHead(f: Fixture) {
  await f.owner.c360IdentityHead.create({
    data: {
      tenantId: f.tenantId,
      contactId: f.contactId,
      canonicalContactId: f.contactId,
      state: 'ACTIVE',
      stateDigest: 'e'.repeat(64),
    },
  });
}

const capabilities = (f: Fixture, token: string, contactId = f.contactId) =>
  f.request(`customer-360/contacts/${contactId}/capabilities`, token);

test('S3 HTTP: Admin ต้องมี custodian grant ของ contact นั้น; Admin อีกคนและ contact ที่ไม่มีอยู่ได้ 404 แบบเดียวกัน', async () => {
  const f = await setup();
  try {
    const missing = await capabilities(f, 'admin', randomUUID());
    const hidden = await capabilities(f, 'admin');
    assert.equal(missing.status, 404);
    assert.equal(hidden.status, 404);
    assert.deepEqual(hidden.body.error, missing.body.error);

    await grantCustodian(f, 'admin', 'MANAGE');
    // legacy ที่ยังไม่มี identity head: อ่านได้แต่แก้ไม่ได้ และ GET ไม่สร้าง head
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
    // ถอน grant แบบ append-only แล้วสิทธิ์หายทันที
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

test('S3 HTTP: Agent, Compliance, unbound proof, disabled และต่าง tenant ไม่มี generic route', async () => {
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
      assert.equal(JSON.stringify(response.body).includes('ลูกค้า C1'), false);
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

test('S3 HTTP: current User/proof เปลี่ยนแล้วสิทธิ์หายทันที (subject proof, role, disable)', async () => {
  const f = await setup();
  try {
    await grantCustodian(f, 'admin', 'MANAGE');
    const adminId = f.actors.get('admin')!.id;
    assert.equal((await capabilities(f, 'admin')).status, 200);
    // subject ของ token ไม่ตรงกับ User ปัจจุบันอีกแล้ว (proof เปลี่ยน) → ปฏิเสธ แล้วกลับมาได้เมื่อ proof ตรง
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

test('S3 HTTP: Supervisor อ่านได้เมื่อ IAM VIEW ตรงกับ owner revision; projection lag/INVALIDATED เป็น 503 ไม่ใช่ ALLOW', async () => {
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
    // owner บอกว่าเป็นสมาชิกแล้วแต่ IAM ยังไม่ได้รับ event → DEFER
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

    // owner ออกจาก segment ก่อน Kafka ถึง IAM: projection IN เดิมต้องไม่ให้ ALLOW
    await ownerCommit(f, 'SILVER');
    assert.equal((await capabilities(f, 'supervisor')).status, 503);
    await deliverToIam(f);
    assert.equal((await capabilities(f, 'supervisor')).status, 404);

    await ownerCommit(f, 'GOLD');
    await deliverToIam(f, 'IDENTITY_INVALIDATED');
    assert.equal((await capabilities(f, 'supervisor')).status, 503);

    // event revision เดิมส่งซ้ำไม่ล้าง INVALIDATED; ต้องมี owner revision ใหม่ที่ IAM ตามทัน
    await deliverToIam(f, 'ENTERED');
    assert.equal((await capabilities(f, 'supervisor')).status, 503);
    await ownerCommit(f, 'SILVER');
    await deliverToIam(f);
    await ownerCommit(f, 'GOLD');
    await deliverToIam(f);
    assert.equal((await capabilities(f, 'supervisor')).status, 200);

    // Admin ในทีมเดียวกันอ่านผ่าน VIEW ได้ แต่ไม่ได้สิทธิ์แก้; Agent ในทีมเดียวกันยังไม่มี generic route
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

test('S3: list/count/detail ใช้ predicate เดียวกัน และ DEFER ไม่ถูกนับเป็นรายการที่อ่านได้', async () => {
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
    // ต่าง tenant: RLS + predicate ไม่คืนอะไรเลย
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

test('S3 HTTP: command receipt/reconcile ผ่าน gate และ receipt ซ่อน ref เมื่อผู้อ่านหมดสิทธิ์', async () => {
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

    // receipt ที่ commit แล้วของ admin; ref ชี้ contact ที่ admin ไม่มีสิทธิ์อ่าน → ไม่คืน ref
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
    // admin อีกคนมองไม่เห็น command ของคนอื่น (key ผูกกับ actor)
    assert.equal(
      (await f.request(`customer-360/commands/${key.commandId}`, 'admin-two')).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test('S3: create capability ต้องมาจาก operator grant ที่ยังไม่ถูกถอน และให้สิทธิ์ตัวเองไม่ได้', async () => {
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
    // role ไม่ใช่ ADMIN แล้ว capability ใช้ไม่ได้
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
