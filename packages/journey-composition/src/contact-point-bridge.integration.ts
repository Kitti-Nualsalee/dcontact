import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { tenantId as toTenantId } from '@d-contact/cxa-contracts';
import { PrismaClient } from '@d-contact/db';
import { createJourneyFoundationPorts } from './index.js';

/**
 * Cus360 C3 (#793) S4: the journey resolver through the contact point bridge on real PostgreSQL/RLS.
 * Point state is created through the owner connection under a synthetic command (the real writer is tested separately in C3 S2/S3)
 */
const OWNER_DATABASE_URL = process.env.DATABASE_URL;
const APPLICATION_DATABASE_URL = process.env.APPLICATION_DATABASE_URL;
const PHONE_VERSION = 'c360-phone-v1+libphonenumber-js@1.13.15/max';
const at = '2099-01-01T00:00:00.000Z';

async function fixture(t: TestContext) {
  // No default to the shared DB: a separate DB for the work must always be set
  assert.ok(
    OWNER_DATABASE_URL && APPLICATION_DATABASE_URL,
    'DATABASE_URL and APPLICATION_DATABASE_URL must be set',
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
  const laterCommandId = randomUUID();
  for (const id of [commandId, laterCommandId])
    await owner.c360ProfileCommand.create({
      data: {
        tenantId,
        actorIdentityKey,
        commandId: id,
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
    state: 'ACTIVE' | 'REVIEW_REQUIRED' | 'RETIRED' | 'SUPERSEDED',
    sourceIdentityId: string | null,
  ) =>
    owner.$executeRaw`INSERT INTO c360_contact_points
      (id, tenant_id, contact_id, kind, raw_value, normalized_value, normalization_version, state,
       source_kind, source_identity_id, created_actor_identity_key, created_command_id,
       retired_at, retired_actor_identity_key, retired_command_id)
      VALUES (${randomUUID()}::uuid, ${tenantId}::uuid, ${contactId}::uuid, 'PHONE', 'fixture',
        ${normalized}, ${normalized === null ? null : PHONE_VERSION},
        ${state === 'SUPERSEDED' ? 'RETIRED' : state},
        ${sourceIdentityId ? 'LEGACY_IDENTITY' : 'PROFILE_COMMAND'}, ${sourceIdentityId}::uuid,
        ${actorIdentityKey}, ${commandId}::uuid,
        ${state === 'RETIRED' || state === 'SUPERSEDED' ? new Date() : null},
        ${state === 'RETIRED' || state === 'SUPERSEDED' ? actorIdentityKey : null},
        ${state === 'SUPERSEDED' ? commandId : state === 'RETIRED' ? laterCommandId : null}::uuid)`;
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

test('journey bridge: not yet imported = DEFERRED, ACTIVE = RESOLVED, REVIEW/RETIRED = NOT_FOUND, shared = AMBIGUOUS', async (t) => {
  const f = await fixture(t);
  const a = await f.contact();
  const b = await f.contact();

  // Not yet imported: cannot be decided, must not become a permanent NOT_FOUND and must not fall back to the raw value
  const pending = await f.identity(a, 'PHONE', '+66812345670');
  assert.deepEqual(await f.resolve('PHONE', '+66812345670'), {
    status: 'DEFERRED',
    reasonCode: 'IDENTITY_MAPPING_PENDING',
  });
  await f.point(a, '+66812345670', 'ACTIVE', pending);
  const resolved = await f.resolve('PHONE', '+66812345670');
  assert.equal(resolved.status, 'RESOLVED');
  assert.equal(resolved.status === 'RESOLVED' && resolved.identityId, pending);

  // The same value ACTIVE on another contact (even from a profile command) = ambiguous
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

  // No identity at all = NOT_FOUND; a channel that is not a contact point (LINE) does not go through the bridge
  assert.equal((await f.resolve('PHONE', '+66812345679')).status, 'NOT_FOUND');
  const line = await f.identity(b, 'LINE', 'U-bridge-line');
  const lineResolved = await f.resolve('LINE', 'U-bridge-line');
  assert.equal(lineResolved.status === 'RESOLVED' && lineResolved.identityId, line);
});

test('journey bridge: a duplicate identity on one contact that was replaced since import is decided by the same single ACTIVE', async (t) => {
  const f = await fixture(t);
  const a = await f.contact();
  const first = await f.identity(a, 'PHONE', '+66812345680');
  const second = await f.identity(a, 'PHONE', '+66 81 234 5680');
  await f.point(a, '+66812345680', 'ACTIVE', first);
  await f.point(a, '+66812345680', 'SUPERSEDED', second);
  // Both entry forms resolve to the same contact regardless of which form was entered
  for (const value of ['+66812345680', '+66 81 234 5680']) {
    const result = await f.resolve('PHONE', value);
    assert.equal(result.status === 'RESOLVED' && result.contactId, a);
  }
  // A point retired later by another command does not count as replaced, even when the same value is still ACTIVE
  const later = await f.identity(a, 'PHONE', '+668 1234 5680');
  await f.point(a, '+66812345680', 'RETIRED', later);
  assert.equal((await f.resolve('PHONE', '+668 1234 5680')).status, 'NOT_FOUND');
});

test('journey bridge: an ACTIVE point retired and then re-added via a profile command makes the replaced row usable again', async (t) => {
  const f = await fixture(t);
  const a = await f.contact();
  const original = await f.identity(a, 'PHONE', '+66812345690');
  const superseded = await f.identity(a, 'PHONE', '+66 81 234 5690');
  // X (ACTIVE at import) is retired by another command, then the same value is added back as an ACTIVE without a legacy identity
  await f.point(a, '+66812345690', 'RETIRED', original);
  await f.point(a, '+66812345690', 'SUPERSEDED', superseded);
  await f.point(a, '+66812345690', 'ACTIVE', null);
  // Decided as agreed: this value is ACTIVE on the same contact again, so the replaced row lets journey reach the contact
  // The identity of X that was retired still cannot be used (consent tied to X lapsed at retire)
  const revived = await f.resolve('PHONE', '+66 81 234 5690');
  assert.equal(revived.status, 'RESOLVED');
  assert.equal(revived.status === 'RESOLVED' && revived.contactId, a);
  assert.equal(revived.status === 'RESOLVED' && revived.identityId, superseded);
  assert.deepEqual(await f.resolve('PHONE', '+66812345690'), {
    status: 'NOT_FOUND',
    reasonCode: 'IDENTITY_NOT_FOUND',
  });
  assert.notEqual(original, superseded);
});
