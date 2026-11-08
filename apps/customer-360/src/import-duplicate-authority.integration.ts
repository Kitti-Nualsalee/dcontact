import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { createC360ImportDuplicateAuthority } from './import-duplicate-authority.js';
import { c360IdentityFenceKey } from './profile-fences.js';
import { normalizeC360CreateProfile } from './profile-write.js';

/** รันเฉพาะ disposable database; สร้างข้อมูล synthetic ไม่ใช้ shared DB */
test('M2 duplicate warnings คืนเฉพาะสิทธิ์ปัจจุบัน, fail closed เมื่อ scope stale', async (t) => {
  assert.ok(process.env.DATABASE_URL && process.env.APPLICATION_DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(url.pathname !== '/dcontact' && url.port !== '5433');
  const owner = new PrismaClient();
  const app = new PrismaClient({
    datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
  });
  t.after(async () => {
    await Promise.all([owner.$disconnect(), app.$disconnect()]);
  });
  const [role] = await app.$queryRaw<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  const tenant = randomUUID(),
    otherTenant = randomUUID(),
    team = randomUUID(),
    user = randomUUID();
  const readable = randomUUID(),
    hidden = randomUUID(),
    foreign = randomUUID();
  await owner.tenant.createMany({
    data: [tenant, otherTenant].map((id) => ({
      id,
      name: 'synthetic',
      slug: `dupe-${id}`,
      sipDomain: `${id}.test`,
    })),
  });
  await owner.team.create({ data: { id: team, tenantId: tenant, name: 'fixture' } });
  await owner.user.create({
    data: {
      id: user,
      tenantId: tenant,
      teamId: team,
      email: `${user}@test.local`,
      displayName: 'fixture',
      passwordHash: '!fixture',
      role: 'ADMIN',
    },
  });
  await owner.contact.createMany({
    data: [
      { id: readable, tenantId: tenant },
      { id: hidden, tenantId: tenant },
      { id: foreign, tenantId: otherTenant },
    ].map((x) => ({ ...x, displayName: 'fixture' })),
  });
  const command = randomUUID(),
    otherCommand = randomUUID();
  for (const [tenantId, commandId] of [
    [tenant, command],
    [otherTenant, otherCommand],
  ] as const) {
    await owner.c360ProfileCommand.create({
      data: {
        tenantId,
        actorIdentityKey: 'fixture',
        commandId,
        action: 'FIXTURE',
        resourceType: 'CONTACT',
        payloadDigest: 'a'.repeat(64),
        normalizationContractVersion: 'test',
      },
    });
  }
  await owner.c360ActorCapabilityGrant.create({
    data: {
      id: randomUUID(),
      tenantId: tenant,
      granteeUserId: user,
      capability: 'CONTACT_CREATE',
      evidenceRef: 'test',
      actorIdentityKey: 'fixture',
      commandId: command,
    },
  });
  await owner.c360ContactCustodianGrant.create({
    data: {
      id: randomUUID(),
      tenantId: tenant,
      contactId: readable,
      granteeUserId: user,
      permission: 'READ',
      origin: 'OPERATOR',
      evidenceRef: 'test',
      actorIdentityKey: 'fixture',
      commandId: command,
    },
  });
  for (const [tenantId, contactId, value, commandId] of [
    [tenant, readable, 'visible@example.test', command],
    [tenant, hidden, 'hidden@example.test', command],
    [otherTenant, foreign, 'foreign@example.test', otherCommand],
  ] as const) {
    await owner.$executeRaw`INSERT INTO c360_contact_points (id,tenant_id,contact_id,kind,raw_value,normalized_value,normalization_version,state,source_kind,created_actor_identity_key,created_command_id) VALUES (${randomUUID()}::uuid,${tenantId}::uuid,${contactId}::uuid,'EMAIL',${value},${value},'fixture','ACTIVE','PROFILE_COMMAND','fixture',${commandId}::uuid)`;
  }
  const actor = { tenantId: tenant, userId: user, role: 'ADMIN' as const, teamId: team };
  const profile = (email: string) =>
    normalizeC360CreateProfile({ displayName: 'test', points: [{ kind: 'EMAIL', value: email }] });
  const run = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
    withTenantDatabaseTransaction(app, tenant, work, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 15_000,
    });
  const results = await run((tx) =>
    createC360ImportDuplicateAuthority(tx, actor).findReadableDuplicates([
      profile('visible@example.test'),
      profile('hidden@example.test'),
      profile('foreign@example.test'),
      profile('none@example.test'),
    ]),
  );
  assert.deepEqual(results, [true, false, false, false]);
  const repeated = await run((tx) =>
    createC360ImportDuplicateAuthority(tx, actor).findReadableDuplicates(
      Array.from({ length: 300 }, () => profile('visible@example.test')),
    ),
  );
  assert.equal(repeated.length, 300);
  assert.ok(repeated.every(Boolean));
  const noCapability = randomUUID();
  await owner.user.create({
    data: { id: noCapability, tenantId: tenant, teamId: team, email: `${noCapability}@test.local`, displayName: 'fixture', passwordHash: '!fixture', role: 'ADMIN' },
  });
  await assert.rejects(
    run((tx) => createC360ImportDuplicateAuthority(tx, { ...actor, userId: noCapability }).findReadableDuplicates([profile('visible@example.test')])),
    { code: 'SCOPE_UNAVAILABLE' },
  );
  let release!: () => void;
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const ready = new Promise<void>((resolve) => { reached = resolve; });
  const holder = owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${c360IdentityFenceKey(tenant, readable)}))`;
    reached();
    await waiting;
  }, { timeout: 10_000 });
  try {
    await ready;
    await assert.rejects(
      run((tx) => createC360ImportDuplicateAuthority(tx, actor).findReadableDuplicates([profile('visible@example.test')])),
      { code: 'SCOPE_UNAVAILABLE' },
    );
  } finally {
    release();
    await holder;
  }
  await assert.rejects(
    run((tx) =>
      createC360ImportDuplicateAuthority(tx, { ...actor, role: 'AGENT' }).findReadableDuplicates([
        profile('visible@example.test'),
      ]),
    ),
  );
  await owner.user.update({ where: { id: user }, data: { isActive: false } });
  await assert.rejects(
    run((tx) =>
      createC360ImportDuplicateAuthority(tx, actor).findReadableDuplicates([
        profile('visible@example.test'),
      ]),
    ),
  );
  await owner.user.update({ where: { id: user }, data: { isActive: true } });
  const grantId = randomUUID(),
    segmentId = `segment:${randomUUID()}`;
  await owner.iamTeamSegmentScopeGrant.create({
    data: {
      id: grantId,
      tenantId: tenant,
      teamId: team,
      segmentId,
      permission: 'VIEW',
      grantVersion: 1,
    },
  });
  await owner.iamTeamSegmentScopeActiveGrant.create({
    data: { tenantId: tenant, teamId: team, segmentId, permission: 'VIEW', grantId },
  });
  await owner.iamContactSegmentScopeProjection.create({
    data: {
      tenantId: tenant,
      contactId: hidden,
      segmentId,
      state: 'INVALIDATED',
      membershipRevision: 1,
      sourceEventId: 'fixture',
      sourceOccurredAt: new Date(),
    },
  });
  await assert.rejects(
    run((tx) =>
      createC360ImportDuplicateAuthority(tx, actor).findReadableDuplicates([
        profile('none@example.test'),
      ]),
    ),
    { code: 'SCOPE_UNAVAILABLE' },
  );
});
