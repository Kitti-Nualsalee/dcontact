import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Prisma } from '@prisma/client';
import { PrismaClient, withTenantDatabaseTransaction } from './index.js';

/**
 * Cus360 C1 (#791): schema ตาม E1 A/H บน PostgreSQL จริง — composite tenant FK, RLS ด้วย
 * application role ที่ไม่ BYPASSRLS, append-only grants และ immutable/retire/epoch triggers
 */
const owner = new PrismaClient();
const app = new PrismaClient({
  datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
});
test.after(async () => {
  await app.$disconnect();
  await owner.$disconnect();
});

const NEW_TABLES = [
  'c360_profile_commands',
  'c360_profile_command_receipts',
  'c360_profile_audits',
  'c360_contact_points',
  'c360_contact_custodian_grants',
  'c360_contact_custodian_revocations',
  'c360_interaction_customer_changes',
  'c360_tags',
  'c360_contact_tags',
  'c360_work_mutation_auth',
];
const ACTOR_KEY = 'issuer|subject';
const DIGEST = 'a'.repeat(64);

function asApp<T>(tenantId: string, work: (tx: Prisma.TransactionClient) => Promise<T>) {
  return withTenantDatabaseTransaction(app, tenantId, work);
}

async function fixture() {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const adminId = randomUUID();
  const agentId = randomUUID();
  const otherAgentId = randomUUID();
  const outsiderId = randomUUID();
  const contactId = randomUUID();
  const secondContactId = randomUUID();
  const outsiderContactId = randomUUID();
  const identityId = randomUUID();
  const interactionId = randomUUID();
  const leaseId = randomUUID();
  const otherLeaseId = randomUUID();
  const commandId = randomUUID();
  await owner.tenant.createMany({
    data: [tenantId, otherTenantId].map((id) => ({
      id,
      name: 'Cus360 schema',
      slug: `c1-schema-${id}`,
      sipDomain: `${id}.c1.test`,
    })),
  });
  await owner.user.createMany({
    data: [
      { id: adminId, tenantId, role: 'ADMIN' as const },
      { id: agentId, tenantId, role: 'AGENT' as const },
      { id: otherAgentId, tenantId, role: 'AGENT' as const },
      { id: outsiderId, tenantId: otherTenantId, role: 'ADMIN' as const },
    ].map((user) => ({
      ...user,
      email: `${user.id}@c1.test`,
      displayName: 'C1 fixture',
      passwordHash: '!test-only',
    })),
  });
  await owner.contact.createMany({
    data: [
      { id: contactId, tenantId, displayName: 'Legacy' },
      { id: secondContactId, tenantId, displayName: 'Second' },
      { id: outsiderContactId, tenantId: otherTenantId, displayName: 'Outsider' },
    ],
  });
  await owner.contactIdentity.create({
    data: {
      id: identityId,
      tenantId,
      contactId,
      type: 'PHONE',
      value: `08${tenantId.slice(0, 8)}`,
    },
  });
  const now = new Date();
  await owner.agentWorkSessionLease.createMany({
    data: [
      { id: leaseId, userId: agentId },
      { id: otherLeaseId, userId: otherAgentId },
    ].map((lease) => ({
      ...lease,
      tenantId,
      surface: 'workspace',
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: new Date(now.getTime() + 60_000),
    })),
  });
  await owner.$executeRaw`INSERT INTO interactions (id, tenant_id, channel, direction, contact_id, agent_id) VALUES (${interactionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND', ${contactId}::uuid, ${agentId}::uuid)`;
  await asApp(tenantId, (tx) => admit(tx, tenantId, commandId, adminId));
  return {
    tenantId,
    otherTenantId,
    adminId,
    agentId,
    otherAgentId,
    outsiderId,
    contactId,
    secondContactId,
    outsiderContactId,
    identityId,
    interactionId,
    leaseId,
    otherLeaseId,
    commandId,
  };
}

function admit(
  tx: Prisma.TransactionClient,
  tenantId: string,
  commandId: string,
  actorUserId: string | null,
) {
  return tx.c360ProfileCommand.create({
    data: {
      tenantId,
      actorIdentityKey: ACTOR_KEY,
      commandId,
      actorUserId,
      action: 'PROFILE_UPDATE',
      resourceType: 'CONTACT',
      payloadDigest: DIGEST,
      normalizationContractVersion: 'cus360-v1',
      expectedRevisions: { profile: '0' },
    },
  });
}

function point(f: Awaited<ReturnType<typeof fixture>>, data: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    tenantId: f.tenantId,
    contactId: f.contactId,
    kind: 'PHONE',
    rawValue: '+66 81 234 5678',
    normalizedValue: '+66812345678',
    normalizationVersion: 'phone-v1',
    state: 'ACTIVE',
    sourceKind: 'PROFILE_COMMAND',
    createdActorIdentityKey: ACTOR_KEY,
    createdCommandId: f.commandId,
    ...data,
  } as Prisma.C360ContactPointUncheckedCreateInput;
}

test('C1 schema: ตารางใหม่ทุกตารางเปิด RLS พร้อม USING/WITH CHECK และ app role ไม่ bypass', async () => {
  const roles = await app.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  assert.deepEqual(roles, [{ rolsuper: false, rolbypassrls: false }]);
  const rows = await owner.$queryRaw<
    { relname: string; rls: boolean; qual: string; check: string }[]
  >`
    SELECT c.relname, c.relrowsecurity AS rls, p.qual, p.with_check AS check
    FROM pg_class c JOIN pg_policies p ON p.tablename = c.relname AND p.policyname = 'tenant_isolation'
    WHERE c.relname = ANY(${NEW_TABLES})`;
  assert.deepEqual(rows.map((row) => row.relname).sort(), [...NEW_TABLES].sort());
  for (const row of rows) {
    assert.equal(row.rls, true, row.relname);
    assert.match(row.qual, /app\.tenant_id/, row.relname);
    assert.match(row.check, /app\.tenant_id/, row.relname);
  }
});

test('C1 schema: tenant อื่นมองไม่เห็นและเขียนข้าม tenant ไม่ได้', async () => {
  const f = await fixture();
  await asApp(f.tenantId, (tx) => tx.c360ContactPoint.create({ data: point(f) }));
  for (const [tenantId, expected] of [
    [f.tenantId, 1],
    [f.otherTenantId, 0],
  ] as const) {
    assert.equal(
      await asApp(tenantId, (tx) =>
        tx.c360ProfileCommand.count({ where: { commandId: f.commandId } }),
      ),
      expected,
    );
    assert.equal(
      await asApp(tenantId, (tx) =>
        tx.c360ContactPoint.count({ where: { contactId: f.contactId } }),
      ),
      expected,
    );
  }
  // WITH CHECK: context ของ tenant อื่นสร้างแถวของ tenant นี้ไม่ได้
  await assert.rejects(
    asApp(f.otherTenantId, (tx) => admit(tx, f.tenantId, randomUUID(), f.adminId)),
    /row-level security/,
  );
  // composite FK: แถวของ tenant หนึ่งอ้าง contact/user ของอีก tenant ไม่ได้ แม้ owner เขียนเอง
  const outsiderCommand = randomUUID();
  await owner.c360ProfileCommand.create({
    data: {
      tenantId: f.otherTenantId,
      actorIdentityKey: ACTOR_KEY,
      commandId: outsiderCommand,
      actorUserId: f.outsiderId,
      action: 'PROFILE_UPDATE',
      resourceType: 'CONTACT',
      payloadDigest: DIGEST,
      normalizationContractVersion: 'cus360-v1',
    },
  });
  await assert.rejects(
    owner.c360ContactPoint.create({
      data: point(f, { tenantId: f.otherTenantId, createdCommandId: outsiderCommand }),
    }),
    /c360_contact_points_contact_fkey/,
  );
  await assert.rejects(
    owner.c360ProfileCommand.create({
      data: {
        tenantId: f.tenantId,
        actorIdentityKey: ACTOR_KEY,
        commandId: randomUUID(),
        actorUserId: f.outsiderId,
        action: 'PROFILE_UPDATE',
        resourceType: 'CONTACT',
        payloadDigest: DIGEST,
        normalizationContractVersion: 'cus360-v1',
      },
    }),
    /c360_profile_commands_actor_fkey/,
  );
});

test('C1 schema: command admission/tombstone/receipt และหลักฐาน append-only สำหรับ app role', async () => {
  const f = await fixture();
  // คำสั่งเดิมซ้ำไม่ได้ (PK เป็นฐานของ COMMAND_PAYLOAD_MISMATCH/replay)
  await assert.rejects(
    asApp(f.tenantId, (tx) => admit(tx, f.tenantId, f.commandId, f.adminId)),
    /Unique constraint/,
  );
  // tombstone ไม่มี payload; admission จริงต้องมี digest/version
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ProfileCommand.create({
        data: {
          tenantId: f.tenantId,
          actorIdentityKey: ACTOR_KEY,
          commandId: randomUUID(),
          isTombstone: true,
          action: 'PROFILE_UPDATE',
          payloadDigest: DIGEST,
        },
      }),
    ),
    /c360_profile_commands_admission_check/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ProfileCommand.create({
        data: {
          tenantId: f.tenantId,
          actorIdentityKey: ACTOR_KEY,
          commandId: randomUUID(),
          action: 'PROFILE_UPDATE',
          resourceType: 'CONTACT',
        },
      }),
    ),
    /c360_profile_commands_admission_check/,
  );
  const tombstoneId = randomUUID();
  await asApp(f.tenantId, async (tx) => {
    await tx.c360ProfileCommand.create({
      data: {
        tenantId: f.tenantId,
        actorIdentityKey: ACTOR_KEY,
        commandId: tombstoneId,
        isTombstone: true,
      },
    });
    await tx.c360ProfileCommandReceipt.create({
      data: {
        tenantId: f.tenantId,
        actorIdentityKey: ACTOR_KEY,
        commandId: tombstoneId,
        outcome: 'REJECTED',
        code: 'COMMAND_NOT_APPLIED',
        httpStatus: 409,
      },
    });
  });
  // REJECTED ต้องมี code; receipt เดียวต่อ command
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ProfileCommandReceipt.create({
        data: {
          tenantId: f.tenantId,
          actorIdentityKey: ACTOR_KEY,
          commandId: f.commandId,
          outcome: 'REJECTED',
          httpStatus: 409,
        },
      }),
    ),
    /c360_profile_command_receipts_code_check/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ProfileCommandReceipt.create({
        data: {
          tenantId: f.tenantId,
          actorIdentityKey: ACTOR_KEY,
          commandId: tombstoneId,
          outcome: 'APPLIED',
          httpStatus: 200,
        },
      }),
    ),
    /Unique constraint/,
  );
  await asApp(f.tenantId, (tx) =>
    tx.c360ProfileAudit.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        actorIdentityKey: ACTOR_KEY,
        commandId: f.commandId,
        actorUserId: f.adminId,
        operation: 'PROFILE_UPDATE',
        resourceType: 'CONTACT',
        resourceId: f.contactId,
        changedFields: ['company'],
      },
    }),
  );
  for (const table of [
    'c360_profile_commands',
    'c360_profile_command_receipts',
    'c360_profile_audits',
  ]) {
    await assert.rejects(
      asApp(f.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE ${table} SET tenant_id = tenant_id WHERE tenant_id = $1::uuid`,
          f.tenantId,
        ),
      ),
      /permission denied/,
      table,
    );
    await assert.rejects(
      asApp(f.tenantId, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, f.tenantId),
      ),
      /permission denied/,
      table,
    );
  }
});

test('C1 schema: contact point เป็น retire+insert ไม่มี unique ข้าม contact และ legacy source ต้องเป็นของ contact เดียวกัน', async () => {
  const f = await fixture();
  const active = point(f);
  await asApp(f.tenantId, (tx) => tx.c360ContactPoint.create({ data: active }));
  // ค่าเดียวกันซ้ำบน contact เดิมไม่ได้ แต่ contact อื่นใช้ได้
  await assert.rejects(
    asApp(f.tenantId, (tx) => tx.c360ContactPoint.create({ data: point(f) })),
    /Unique constraint/,
  );
  await asApp(f.tenantId, (tx) =>
    tx.c360ContactPoint.create({ data: point(f, { contactId: f.secondContactId }) }),
  );

  for (const [data, constraint] of [
    [{ normalizedValue: null, normalizationVersion: null }, 'c360_contact_points_active_check'],
    [{ state: 'REVIEW_REQUIRED' }, 'c360_contact_points_review_check'],
    [{ normalizationVersion: null }, 'c360_contact_points_normalized_check'],
    [{ sourceKind: 'LEGACY_IDENTITY' }, 'c360_contact_points_source_check'],
    [{ explicitCountry: 'th' }, 'c360_contact_points_country_check'],
    [{ kind: 'LINE' }, 'c360_contact_points_kind_check'],
  ] as const) {
    await assert.rejects(
      asApp(f.tenantId, (tx) => tx.c360ContactPoint.create({ data: point(f, data) })),
      new RegExp(constraint),
    );
  }

  // legacy identity ของ contact หนึ่งเชื่อมกับอีก contact ไม่ได้ และ import ซ้ำไม่ได้
  const legacy = {
    rawValue: '0812345678',
    normalizedValue: null,
    normalizationVersion: null,
    state: 'REVIEW_REQUIRED',
    sourceKind: 'LEGACY_IDENTITY',
    sourceIdentityId: f.identityId,
  };
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ContactPoint.create({ data: point(f, { ...legacy, contactId: f.secondContactId }) }),
    ),
    /c360_contact_points_source_identity_fkey/,
  );
  await asApp(f.tenantId, (tx) => tx.c360ContactPoint.create({ data: point(f, legacy) }));
  await assert.rejects(
    asApp(f.tenantId, (tx) => tx.c360ContactPoint.create({ data: point(f, legacy) })),
    /Unique constraint/,
  );

  // แก้ค่าทับไม่ได้; retire ได้ครั้งเดียว; ลบไม่ได้
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ContactPoint.update({
        where: { id: active.id },
        data: { rawValue: '+66 81 000 0000' },
      }),
    ),
    /C360_POINT_IMMUTABLE/,
  );
  const retireCommand = randomUUID();
  await asApp(f.tenantId, async (tx) => {
    await admit(tx, f.tenantId, retireCommand, f.adminId);
    await tx.c360ContactPoint.update({
      where: { id: active.id },
      data: {
        state: 'RETIRED',
        retiredAt: new Date(),
        retiredActorIdentityKey: ACTOR_KEY,
        retiredCommandId: retireCommand,
      },
    });
    // retire แล้วเพิ่มค่าเดิมกลับใน transaction เดียวกันได้ (partial unique เฉพาะ ACTIVE)
    await tx.c360ContactPoint.create({ data: point(f, { createdCommandId: retireCommand }) });
  });
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ContactPoint.update({
        where: { id: active.id },
        data: {
          state: 'ACTIVE',
          retiredAt: null,
          retiredActorIdentityKey: null,
          retiredCommandId: null,
        },
      }),
    ),
    /C360_POINT_IMMUTABLE/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) => tx.c360ContactPoint.delete({ where: { id: active.id } })),
    /permission denied/,
  );
});

test('C1 schema: custodian grant/revocation เป็นหลักฐาน append-only และ creator ให้สิทธิ์ตัวเองแบบ MANAGE เท่านั้น', async () => {
  const f = await fixture();
  const grant = (data: Record<string, unknown>) =>
    ({
      id: randomUUID(),
      tenantId: f.tenantId,
      contactId: f.contactId,
      granteeUserId: f.adminId,
      permission: 'MANAGE',
      origin: 'CREATOR',
      actorIdentityKey: ACTOR_KEY,
      commandId: f.commandId,
      actorUserId: f.adminId,
      ...data,
    }) as Prisma.C360ContactCustodianGrantUncheckedCreateInput;
  for (const data of [{ permission: 'READ' }, { granteeUserId: f.agentId }]) {
    await assert.rejects(
      asApp(f.tenantId, (tx) => tx.c360ContactCustodianGrant.create({ data: grant(data) })),
      /c360_contact_custodian_grants_creator_check/,
    );
  }
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ContactCustodianGrant.create({
        data: grant({ origin: 'OPERATOR', actorUserId: null }),
      }),
    ),
    /c360_contact_custodian_grants_evidence_check/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ContactCustodianGrant.create({ data: grant({ granteeUserId: f.outsiderId }) }),
    ),
    /c360_contact_custodian_grants/,
  );
  const creator = grant({});
  const operator = grant({
    origin: 'OPERATOR',
    permission: 'READ',
    granteeUserId: f.agentId,
    actorUserId: null,
    evidenceRef: 'TICKET-1',
  });
  await asApp(f.tenantId, async (tx) => {
    await tx.c360ContactCustodianGrant.create({ data: creator });
    await tx.c360ContactCustodianGrant.create({ data: operator });
  });
  const revocation = (grantId: string) => ({
    id: randomUUID(),
    tenantId: f.tenantId,
    grantId,
    actorIdentityKey: ACTOR_KEY,
    commandId: f.commandId,
    reason: 'role change',
    evidenceRef: 'TICKET-2',
  });
  await asApp(f.tenantId, (tx) =>
    tx.c360ContactCustodianRevocation.create({ data: revocation(operator.id) }),
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ContactCustodianRevocation.create({ data: revocation(operator.id) }),
    ),
    /Unique constraint/,
  );
  for (const table of ['c360_contact_custodian_grants', 'c360_contact_custodian_revocations']) {
    await assert.rejects(
      asApp(f.tenantId, (tx) =>
        tx.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, f.tenantId),
      ),
      /permission denied/,
      table,
    );
    await assert.rejects(
      asApp(f.tenantId, (tx) =>
        tx.$executeRawUnsafe(
          `UPDATE ${table} SET evidence_ref = 'x' WHERE tenant_id = $1::uuid`,
          f.tenantId,
        ),
      ),
      /permission denied/,
      table,
    );
  }
});

test('C1 schema: linkage history ตรวจ action/reason/revision และ lease ต้องเป็นของ actor', async () => {
  const f = await fixture();
  const change = (data: Record<string, unknown>) =>
    ({
      id: randomUUID(),
      tenantId: f.tenantId,
      interactionId: f.interactionId,
      action: 'RELINK',
      beforeContactId: f.contactId,
      afterContactId: f.secondContactId,
      beforeLinkRevision: 0n,
      afterLinkRevision: 1n,
      actorUserId: f.agentId,
      leaseId: f.leaseId,
      actorIdentityKey: ACTOR_KEY,
      commandId: f.commandId,
      reason: 'ลูกค้าแจ้งชื่อใหม่',
      ...data,
    }) as Prisma.C360InteractionCustomerChangeUncheckedCreateInput;
  for (const [data, pattern] of [
    [{ reason: null }, /c360_interaction_customer_changes_reason_check/],
    [{ reason: ' padded ' }, /c360_interaction_customer_changes_reason_check/],
    [{ reason: 'x'.repeat(501) }, /c360_interaction_customer_changes_reason_check/],
    [{ action: 'LINK', beforeContactId: null }, /c360_interaction_customer_changes_reason_check/],
    [{ afterContactId: f.contactId }, /c360_interaction_customer_changes_action_check/],
    [{ action: 'DETACH' }, /c360_interaction_customer_changes_action_check/],
    [{ afterLinkRevision: 2n }, /c360_interaction_customer_changes_revisions_check/],
    [{ leaseId: f.otherLeaseId }, /c360_interaction_customer_changes_lease_fkey/],
  ] as const) {
    await assert.rejects(
      asApp(f.tenantId, (tx) => tx.c360InteractionCustomerChange.create({ data: change(data) })),
      pattern,
      Object.keys(data).join(','),
    );
  }
  await asApp(f.tenantId, async (tx) => {
    await tx.c360InteractionCustomerChange.create({ data: change({}) });
    await tx.interaction.update({
      where: { id: f.interactionId },
      data: { contactId: f.secondContactId, customerLinkRevision: 1n },
    });
  });
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360InteractionCustomerChange.create({ data: change({ reason: 'ซ้ำ' }) }),
    ),
    /Unique constraint/,
  );
  await asApp(f.tenantId, (tx) =>
    tx.c360InteractionCustomerChange.create({
      data: change({
        action: 'DETACH',
        beforeContactId: f.secondContactId,
        afterContactId: null,
        beforeLinkRevision: 1n,
        afterLinkRevision: 2n,
      }),
    }),
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE c360_interaction_customer_changes SET reason = 'x' WHERE tenant_id = $1::uuid`,
        f.tenantId,
      ),
    ),
    /permission denied/,
  );
});

test('C1 schema: tag ใช้ nameKey แบบ binary, ชื่อ RETIRED สงวนไว้ และแนบ tag ที่ retire แล้วไม่ได้', async () => {
  const f = await fixture();
  const tag = (name: string, nameKey: string) => ({
    id: randomUUID(),
    tenantId: f.tenantId,
    name,
    nameKey,
    actorIdentityKey: ACTOR_KEY,
    commandId: f.commandId,
  });
  const vip = tag('VIP', 'vip');
  const gold = tag('Gold', 'gold');
  await asApp(f.tenantId, async (tx) => {
    await tx.c360Tag.create({ data: vip });
    await tx.c360Tag.create({ data: gold });
    // binary equality: key ต่างกันเพียง case หรือ combining sequence ถือเป็นคนละ key ที่ระดับ DB
    await tx.c360Tag.create({ data: tag('VIP upper', 'VIP') });
    await tx.c360Tag.create({ data: tag('e acute', 'é') });
    await tx.c360Tag.create({ data: tag('é', 'é') });
  });
  await assert.rejects(
    asApp(f.tenantId, (tx) => tx.c360Tag.create({ data: tag('vip', 'vip') })),
    /Unique constraint/,
  );
  // ต่าง tenant ใช้ชื่อเดียวกันได้
  const outsiderCommand = randomUUID();
  await asApp(f.otherTenantId, async (tx) => {
    await admit(tx, f.otherTenantId, outsiderCommand, f.outsiderId);
    await tx.c360Tag.create({
      data: { ...tag('VIP', 'vip'), tenantId: f.otherTenantId, commandId: outsiderCommand },
    });
  });

  await asApp(f.tenantId, (tx) =>
    tx.c360ContactTag.create({
      data: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        tagId: vip.id,
        actorIdentityKey: ACTOR_KEY,
        commandId: f.commandId,
      },
    }),
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360Tag.update({ where: { id: vip.id }, data: { name: 'V.I.P.', revision: 1n } }),
    ),
    /C360_TAG_IMMUTABLE/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360Tag.update({
        where: { id: gold.id },
        data: { state: 'RETIRED', retiredAt: new Date() },
      }),
    ),
    /C360_TAG_REVISION/,
  );
  await asApp(f.tenantId, (tx) =>
    tx.c360Tag.update({
      where: { id: gold.id },
      data: { state: 'RETIRED', retiredAt: new Date(), revision: 1n },
    }),
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360Tag.update({
        where: { id: gold.id },
        data: { state: 'ACTIVE', retiredAt: null, revision: 2n },
      }),
    ),
    /C360_TAG_RETIRED/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) => tx.c360Tag.create({ data: tag('GOLD', 'gold') })),
    /Unique constraint/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360ContactTag.create({
        data: {
          tenantId: f.tenantId,
          contactId: f.contactId,
          tagId: gold.id,
          actorIdentityKey: ACTOR_KEY,
          commandId: f.commandId,
        },
      }),
    ),
    /C360_TAG_RETIRED/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) => tx.c360Tag.delete({ where: { id: vip.id } })),
    /permission denied/,
  );
  // relation ปัจจุบัน: detach = DELETE ได้ แต่ UPDATE ไม่ได้
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.$executeRawUnsafe(
        `UPDATE c360_contact_tags SET attached_at = now() WHERE tenant_id = $1::uuid`,
        f.tenantId,
      ),
    ),
    /permission denied/,
  );
  assert.equal(
    (
      await asApp(f.tenantId, (tx) =>
        tx.c360ContactTag.deleteMany({ where: { contactId: f.contactId } }),
      )
    ).count,
    1,
  );
});

test('C1 schema: work mutation auth ผูก lease ของ user จริงและทุกการเปลี่ยน binding ต้องเพิ่ม epoch', async () => {
  const f = await fixture();
  const auth = {
    tenantId: f.tenantId,
    userId: f.agentId,
    leaseId: f.leaseId,
    authState: 'ACTIVE',
    issuer: 'https://idp.test/realms/c1',
    subject: randomUUID(),
    sid: 'sid-1',
    tokenFingerprint: 'b'.repeat(64),
    tokenExpiresAt: new Date(Date.now() + 300_000),
  };
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360WorkMutationAuth.create({ data: { ...auth, leaseId: f.otherLeaseId } }),
    ),
    /c360_work_mutation_auth_lease_fkey/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360WorkMutationAuth.create({ data: { ...auth, tokenFingerprint: 'raw-token' } }),
    ),
    /c360_work_mutation_auth_fingerprint_check/,
  );
  await asApp(f.tenantId, (tx) => tx.c360WorkMutationAuth.create({ data: auth }));
  const key = {
    tenantId_userId_leaseId: { tenantId: f.tenantId, userId: f.agentId, leaseId: f.leaseId },
  };

  // บันทึกเวลา online check ไม่ต้องเพิ่ม epoch
  await asApp(f.tenantId, (tx) =>
    tx.c360WorkMutationAuth.update({ where: key, data: { lastOnlineCheckStartedAt: new Date() } }),
  );
  for (const [data, pattern] of [
    [{ authState: 'REAUTH_REQUIRED', invalidationReason: 'TOKEN_EXPIRED' }, /C360_WORK_AUTH_EPOCH/],
    [{ sid: 'sid-2' }, /C360_WORK_AUTH_EPOCH/],
    [{ authEpoch: 1n, authState: 'REAUTH_REQUIRED' }, /c360_work_mutation_auth_reason_check/],
    [{ authEpoch: 1n, subject: randomUUID() }, /C360_WORK_AUTH_IDENTITY/],
  ] as const) {
    await assert.rejects(
      asApp(f.tenantId, (tx) => tx.c360WorkMutationAuth.update({ where: key, data })),
      pattern,
      JSON.stringify(data, (_, value) => (typeof value === 'bigint' ? `${value}` : value)),
    );
  }
  await asApp(f.tenantId, (tx) =>
    tx.c360WorkMutationAuth.update({
      where: key,
      data: { authEpoch: 1n, authState: 'REAUTH_REQUIRED', invalidationReason: 'TOKEN_EXPIRED' },
    }),
  );
  // reauth ด้วย sid ใหม่ของ subject เดิมผ่านได้เมื่อ CAS เพิ่ม epoch
  await asApp(f.tenantId, (tx) =>
    tx.c360WorkMutationAuth.update({
      where: key,
      data: {
        authEpoch: 2n,
        authState: 'ACTIVE',
        invalidationReason: null,
        sid: 'sid-2',
        tokenFingerprint: 'c'.repeat(64),
      },
    }),
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) =>
      tx.c360WorkMutationAuth.update({ where: key, data: { authEpoch: 1n } }),
    ),
    /C360_WORK_AUTH_EPOCH/,
  );
  await assert.rejects(
    asApp(f.tenantId, (tx) => tx.c360WorkMutationAuth.delete({ where: key })),
    /permission denied/,
  );
});
