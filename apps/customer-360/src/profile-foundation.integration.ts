import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';

test('Cus360 profile foundation: defaults, revision constraints และ tenant isolation ใน PostgreSQL', async (t) => {
  assert.ok(process.env.DATABASE_URL, 'ต้องระบุ owner database ของ sandbox');
  assert.ok(process.env.APPLICATION_DATABASE_URL, 'ต้องระบุ application role ของ sandbox');
  const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const application = new PrismaClient({
    datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
  });
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const contactId = randomUUID();
  const interactionId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  t.after(async () => {
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  const roles = await application.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user
  `;
  assert.deepEqual(roles, [{ rolsuper: false, rolbypassrls: false }]);
  await owner.tenant.createMany({
    data: [
      {
        id: tenantId,
        name: 'Cus360 profile',
        slug: `c1-${suffix}`,
        sipDomain: `${suffix}.c1.test`,
      },
      {
        id: otherTenantId,
        name: 'Cus360 other',
        slug: `c1-other-${suffix}`,
        sipDomain: `${suffix}.other.c1.test`,
      },
    ],
  });
  // ใช้ SQL โดยไม่ระบุ columns ใหม่ เพื่อทดสอบ defaults ที่ old writer จะได้รับ
  await owner.$executeRaw`INSERT INTO contacts (id, tenant_id, display_name) VALUES (${contactId}::uuid, ${tenantId}::uuid, 'Legacy contact')`;
  await owner.$executeRaw`INSERT INTO interactions (id, tenant_id, channel, direction, contact_id) VALUES (${interactionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND', ${contactId}::uuid)`;
  const contact = await owner.contact.findUniqueOrThrow({ where: { id: contactId } });
  assert.equal(contact.company, null);
  assert.equal(contact.vip, false);
  assert.equal(contact.vipSource, 'LEGACY_DEFAULT');
  assert.equal(contact.profileRevision, 0n);
  assert.equal(contact.tagRevision, 0n);
  assert.equal(
    (await owner.interaction.findUniqueOrThrow({ where: { id: interactionId } }))
      .customerLinkRevision,
    0n,
  );

  for (const query of [
    () =>
      owner.$executeRaw`UPDATE contacts SET profile_revision = -1 WHERE id = ${contactId}::uuid`,
    () => owner.$executeRaw`UPDATE contacts SET tag_revision = -1 WHERE id = ${contactId}::uuid`,
    () =>
      owner.$executeRaw`UPDATE contacts SET vip_source = 'UNKNOWN' WHERE id = ${contactId}::uuid`,
    () =>
      owner.$executeRaw`UPDATE interactions SET customer_link_revision = -1 WHERE id = ${interactionId}::uuid`,
  ])
    await assert.rejects(query);

  assert.equal(
    await withTenantDatabaseTransaction(application, tenantId, (tx) =>
      tx.contact.count({ where: { id: contactId } }),
    ),
    1,
  );
  assert.equal(
    await withTenantDatabaseTransaction(application, otherTenantId, (tx) =>
      tx.contact.count({ where: { id: contactId } }),
    ),
    0,
  );
  assert.equal(
    await withTenantDatabaseTransaction(application, otherTenantId, (tx) =>
      tx.interaction.count({ where: { id: interactionId } }),
    ),
    0,
  );
  assert.equal(
    (
      await withTenantDatabaseTransaction(application, otherTenantId, (tx) =>
        tx.interaction.updateMany({
          where: { id: interactionId },
          data: { customerLinkRevision: 1n },
        }),
      )
    ).count,
    0,
  );
  assert.equal(
    (await owner.interaction.findUniqueOrThrow({ where: { id: interactionId } }))
      .customerLinkRevision,
    0n,
  );
  const forbiddenInteractionId = randomUUID();
  await assert.rejects(
    withTenantDatabaseTransaction(
      application,
      otherTenantId,
      (tx) =>
        tx.$executeRaw`INSERT INTO interactions (id, tenant_id, channel, direction, contact_id) VALUES (${forbiddenInteractionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND', ${contactId}::uuid)`,
    ),
  );
  assert.equal(await owner.interaction.count({ where: { id: forbiddenInteractionId } }), 0);
});
