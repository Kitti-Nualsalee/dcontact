import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { tenantId as toTenantId } from '@d-contact/cxa-contracts';
import { PrismaClient } from '@d-contact/db';
import { createJourneyFoundationPorts } from './index.js';

/**
 * Cus360 C3 (#793) S4: resolver ของ journey ผ่าน contact point bridge บน PostgreSQL/RLS จริง
 * สถานะของ point สร้างผ่าน owner connection ใต้ command สังเคราะห์ (writer จริงทดสอบแยกใน C3 S2/S3)
 */
const OWNER_DATABASE_URL = process.env.DATABASE_URL;
const APPLICATION_DATABASE_URL = process.env.APPLICATION_DATABASE_URL;
const PHONE_VERSION = 'c360-phone-v1+libphonenumber-js@1.13.15/max';
const at = '2099-01-01T00:00:00.000Z';

async function fixture(t: TestContext) {
  // ไม่มี default ไป DB ร่วม: ต้องตั้ง DB แยกของงานเสมอ
  assert.ok(
    OWNER_DATABASE_URL && APPLICATION_DATABASE_URL,
    'ต้องตั้ง DATABASE_URL และ APPLICATION_DATABASE_URL',
  );
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_DATABASE_URL } } });
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const commandId = randomUUID();
  const actorIdentityKey = `bridge-fixture-${tenantId}`;
  t.after(async () => {
    for (const table of ['c360_contact_points', 'c360_profile_commands'])
      await owner.$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = $1::uuid`, tenantId);
    await owner.contactIdentity.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'Journey bridge test',
      slug: `journey-bridge-${tenantId}`,
      sipDomain: `${tenantId}.journey-bridge.test`,
    },
  });
  await owner.c360ProfileCommand.create({
    data: {
      tenantId,
      actorIdentityKey,
      commandId,
      action: 'FIXTURE_POINT',
      resourceType: 'CONTACT',
      payloadDigest: '0'.repeat(64),
      normalizationContractVersion: 'fixture',
    },
  });
  const contact = async () => {
    const id = randomUUID();
    await owner.contact.create({ data: { id, tenantId } });
    return id;
  };
  const point = async (
    contactId: string,
    normalized: string | null,
    state: 'ACTIVE' | 'REVIEW_REQUIRED' | 'RETIRED',
    sourceIdentityId: string | null,
  ) =>
    owner.$executeRaw`INSERT INTO c360_contact_points
      (id, tenant_id, contact_id, kind, raw_value, normalized_value, normalization_version, state,
       source_kind, source_identity_id, created_actor_identity_key, created_command_id,
       retired_at, retired_actor_identity_key, retired_command_id)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${contactId}::uuid, 'PHONE', 'fixture',
        ${normalized}, ${normalized === null ? null : PHONE_VERSION}, ${state},
        ${sourceIdentityId ? 'LEGACY_IDENTITY' : 'PROFILE_COMMAND'}, ${sourceIdentityId}::uuid,
        ${actorIdentityKey}, ${commandId}::uuid,
        ${state === 'RETIRED' ? new Date() : null},
        ${state === 'RETIRED' ? actorIdentityKey : null},
        ${state === 'RETIRED' ? commandId : null}::uuid)`;
  const identity = async (contactId: string, type: 'PHONE' | 'LINE', value: string) =>
    (await owner.contactIdentity.create({ data: { tenantId, contactId, type, value } })).id;
  const ports = createJourneyFoundationPorts(application);
  const resolve = (kind: 'PHONE' | 'LINE', value: string) =>
    ports.customerContextReader.resolveCurrentContext({
      tenantId: toTenantId(tenantId),
      contactRef: { kind, value },
      at,
    });
  return { contact, point, identity, resolve };
}

test('bridge ของ journey: ยังไม่ import = DEFERRED, ACTIVE = RESOLVED, REVIEW/RETIRED = NOT_FOUND, shared = AMBIGUOUS', async (t) => {
  const f = await fixture(t);
  const a = await f.contact();
  const b = await f.contact();

  // ยังไม่ import: ตัดสินไม่ได้ ต้องไม่เป็น NOT_FOUND ถาวรและไม่ fallback ไป raw value
  const pending = await f.identity(a, 'PHONE', '+66812345670');
  assert.deepEqual(await f.resolve('PHONE', '+66812345670'), {
    status: 'DEFERRED',
    reasonCode: 'IDENTITY_MAPPING_PENDING',
  });
  await f.point(a, '+66812345670', 'ACTIVE', pending);
  const resolved = await f.resolve('PHONE', '+66812345670');
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.status === 'RESOLVED' && resolved.identityId, pending);

  // ค่าเดียวกัน ACTIVE บนอีก contact (แม้มาจาก profile command) = กำกวม
  await f.point(b, '+66812345670', 'ACTIVE', null);
  assert.deepEqual(await f.resolve('PHONE', '+66812345670'), {
    status: 'AMBIGUOUS',
    reasonCode: 'IDENTITY_AMBIGUOUS',
  });

  const review = await f.identity(a, 'PHONE', '0812345671');
  await f.point(a, null, 'REVIEW_REQUIRED', review);
  assert.deepEqual(await f.resolve('PHONE', '0812345671'), {
    status: 'NOT_FOUND',
    reasonCode: 'IDENTITY_NOT_FOUND',
  });

  const retired = await f.identity(a, 'PHONE', '+66812345672');
  await f.point(a, '+66812345672', 'RETIRED', retired);
  assert.deepEqual(await f.resolve('PHONE', '+66812345672'), {
    status: 'NOT_FOUND',
    reasonCode: 'IDENTITY_NOT_FOUND',
  });

  // ไม่มี identity เลย = NOT_FOUND; ช่องทางที่ไม่ใช่ contact point (LINE) ไม่ผ่าน bridge
  assert.equal((await f.resolve('PHONE', '+66812345679')).status, 'NOT_FOUND');
  const line = await f.identity(b, 'LINE', 'U-bridge-line');
  const lineResolved = await f.resolve('LINE', 'U-bridge-line');
  assert.equal(lineResolved.status === 'RESOLVED' && lineResolved.identityId, line);
});
