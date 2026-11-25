import { withTenantDatabaseTransaction } from '@d-contact/db';
import { coreNameFixtures, coreTimeZoneFixtures } from '@d-contact/shared';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { coreFixture } from './tenant-core-test-fixtures.js';

test('Organization: an Admin reads an existing tenant with no defaults and a Supervisor can read without enabling Voice', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const result = await f.request('tenant/core-settings/organization');
  assert.equal(result.status, 200);
  const organization = result.body as unknown as {
    organization: { id: string; defaults: null; revision: string };
  };
  assert.equal(organization.organization.id, f.tenantId);
  assert.equal(organization.organization.defaults, null);
  assert.equal(organization.organization.revision, '0');
  assert.equal((await f.request('tenant/core-settings/organization', 'supervisor')).status, 200);
});

test('Organization: rename via PATCH then read back revision 1 without creating defaults, and a replay does not duplicate', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const body = {
    commandId: 'f7e4aba1-dc3c-4f02-9f3b-e050ee5ef7a0',
    expectedRevision: '0',
    patch: { displayName: ' Test company ' },
  };
  const result = await f.request('tenant/core-settings/organization', 'admin', body, 'PATCH');
  assert.equal(result.status, 200);
  assert.equal(result.body.command.outcome, 'APPLIED');
  const read = (await f.request('tenant/core-settings/organization')).body as unknown as {
    organization: { displayName: string; revision: string; defaults: null };
  };
  assert.equal(read.organization.displayName, 'Test company');
  assert.equal(read.organization.revision, '1');
  assert.equal(read.organization.defaults, null);
  assert.deepEqual(
    (await f.request('tenant/core-settings/organization', 'admin', body, 'PATCH')).body,
    result.body,
  );
});

test('Organization: an existing tenant starts both defaults with CORE_ADMIN and keeps provenance on the next edit', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const result = await f.request(
    'tenant/core-settings/organization',
    'admin',
    {
      commandId: '2a71963f-8f34-4c70-8111-9ca6fa1818cf',
      expectedRevision: '0',
      patch: { defaults: { locale: 'en', timeZone: 'Asia/Bangkok' } },
    },
    'PATCH',
  );
  assert.equal(result.status, 200);
  const read = (await f.request('tenant/core-settings/organization')).body as unknown as {
    organization: {
      defaults: { locale: string; timeZone: string; initializationSource: string };
      revision: string;
    };
  };
  assert.deepEqual(read.organization.defaults, {
    locale: 'en',
    timeZone: 'Asia/Bangkok',
    initializationSource: 'CORE_ADMIN',
  });
  assert.equal(read.organization.revision, '1');
  const renamed = await f.request(
    'tenant/core-settings/organization',
    'admin',
    {
      commandId: '784fe481-f120-4df4-a914-e8cde2c69cbd',
      expectedRevision: '1',
      patch: {
        displayName: 'Configured organization',
        defaults: { locale: 'th', timeZone: 'UTC' },
      },
    },
    'PATCH',
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.command.committedRevision, '2');
});

test('Organization: strict shape before admission and semantic validation keeps REJECTED without changing the revision', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  for (const patch of [
    {},
    null,
    { unknown: 'x' },
    { defaults: { locale: 'th' } },
    { displayName: 23 },
    { defaults: { locale: 'th', timeZone: 'UTC', extra: true } },
  ]) {
    const commandId = randomUUID();
    const result = await f.request(
      'tenant/core-settings/organization',
      'admin',
      { commandId, expectedRevision: '0', patch },
      'PATCH',
    );
    assert.equal(result.status, 400);
    assert.equal((await f.request(`tenant/core-settings/commands/${commandId}`)).status, 404);
  }
  for (const patch of [
    ...coreNameFixtures.filter((f) => !f.valid).map((f) => ({ displayName: f.value })),
    ...coreTimeZoneFixtures
      .filter((f) => !f.valid)
      .map((f) => ({ defaults: { locale: 'th', timeZone: f.value } })),
    { defaults: { locale: 'fr', timeZone: 'UTC' } },
  ]) {
    const body = { commandId: randomUUID(), expectedRevision: '0', patch };
    const result = await f.request('tenant/core-settings/organization', 'admin', body, 'PATCH');
    assert.equal(result.status, 422);
    assert.equal(result.body.command.outcome, 'REJECTED');
    assert.deepEqual(
      (await f.request('tenant/core-settings/organization', 'admin', body, 'PATCH')).body.command,
      result.body.command,
    );
    assert.equal(
      (
        await f.request(
          'tenant/core-settings/organization',
          'admin',
          { ...body, patch: { displayName: 'Edited draft' } },
          'PATCH',
        )
      ).body.error.code,
      'COMMAND_PAYLOAD_MISMATCH',
    );
  }
  const read = (await f.request('tenant/core-settings/organization')).body as unknown as {
    organization: { revision: string };
  };
  assert.equal(read.organization.revision, '0');
});
test('Organization: the UTF-16 boundary and defaults that are not edited keep the legacy value/provisioning evidence', async (t) => {
  const f = await coreFixture([], undefined, { locale: 'legacy-locale', timeZone: 'legacy-zone' });
  t.after(() => f.close());
  const requestId = (
    await f.owner.tenantSettings.findUniqueOrThrow({ where: { tenantId: f.tenantId } })
  ).provisioningRequestId;
  const body = {
    commandId: randomUUID(),
    expectedRevision: '0',
    patch: { displayName: '😀'.repeat(60) },
  };
  assert.equal(
    (await f.request('tenant/core-settings/organization', 'admin', body, 'PATCH')).status,
    200,
  );
  const settings = await f.owner.tenantSettings.findUniqueOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(settings.locale, 'legacy-locale');
  assert.equal(settings.initializationSource, 'PROVISIONING');
  assert.equal(settings.provisioningRequestId, requestId);
  assert.equal(settings.initializedByCommandId, null);
  const changed = await f.request(
    'tenant/core-settings/organization',
    'admin',
    {
      commandId: randomUUID(),
      expectedRevision: '1',
      patch: { defaults: { locale: 'th', timeZone: 'America/New_York' } },
    },
    'PATCH',
  );
  assert.equal(changed.status, 200);
  const preserved = await f.owner.tenantSettings.findUniqueOrThrow({
    where: { tenantId: f.tenantId },
  });
  assert.equal(preserved.provisioningRequestId, requestId);
  assert.equal(preserved.initializationSource, 'PROVISIONING');
});
test('Organization: a stale CAS comes before no-op and validation; a no-op does not increase the revision/audit', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const initial = (await f.request('tenant/core-settings/organization')).body as unknown as {
    organization: { displayName: string };
  };
  const noop = await f.request(
    'tenant/core-settings/organization',
    'admin',
    {
      commandId: randomUUID(),
      expectedRevision: '0',
      patch: { displayName: ` ${initial.organization.displayName} ` },
    },
    'PATCH',
  );
  assert.equal(noop.body.command.outcome, 'NO_OP');
  assert.equal(noop.body.command.committedRevision, '0');
  const changed = await f.request(
    'tenant/core-settings/organization',
    'admin',
    { commandId: randomUUID(), expectedRevision: '0', patch: { displayName: 'New name' } },
    'PATCH',
  );
  assert.equal(changed.status, 200);
  for (const displayName of ['New name', ' ']) {
    const conflict = await f.request(
      'tenant/core-settings/organization',
      'admin',
      { commandId: randomUUID(), expectedRevision: '0', patch: { displayName } },
      'PATCH',
    );
    assert.equal(conflict.body.error.code, 'REVISION_CONFLICT');
    assert.equal(conflict.body.command.outcome, 'REJECTED');
  }
  assert.equal(await f.owner.tenantCoreConfigAudit.count({ where: { tenantId: f.tenantId } }), 1);
});
test('Organization: role/proof/tenant isolation cover read/write/navigation while Home is still reachable', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  for (const alias of ['agent', 'compliance', 'unbound', 'disabled']) {
    assert.equal((await f.request('tenant/core-settings/organization', alias)).status, 403);
    assert.equal(
      (
        await f.request(
          'tenant/core-settings/organization',
          alias,
          { commandId: randomUUID(), expectedRevision: '0', patch: { displayName: 'Not allowed' } },
          'PATCH',
        )
      ).status,
      403,
    );
    const nav = await f.request('me/navigation', alias);
    assert.equal(nav.status, 200);
    const apps = (nav.body as unknown as { apps: { id: string }[] }).apps;
    assert.ok(apps.some((a) => a.id === 'home'));
    assert.ok(!apps.some((a) => a.id === 'core-settings'));
  }
  assert.equal(
    (
      await f.request(
        'tenant/core-settings/organization',
        'supervisor',
        { commandId: randomUUID(), expectedRevision: '0', patch: { displayName: 'Not allowed' } },
        'PATCH',
      )
    ).status,
    403,
  );
  const foreign = (await f.request('tenant/core-settings/organization', 'foreign'))
    .body as unknown as { organization: { id: string } };
  assert.equal(foreign.organization.id, f.otherTenantId);
  const nav = await f.request('me/navigation');
  assert.ok(
    (nav.body as unknown as { apps: { id: string }[] }).apps.some((a) => a.id === 'core-settings'),
  );
  const locale = await f.request('tenant/locale-defaults');
  assert.deepEqual(locale.body, { locale: null, timeZone: null });
});

test('Organization: initialization metadata matches the real actor/command and the app cannot change the source or create a fake bootstrap', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const commandId = randomUUID();
  assert.equal(
    (
      await f.request(
        'tenant/core-settings/organization',
        'admin',
        {
          commandId,
          expectedRevision: '0',
          patch: { defaults: { locale: 'th', timeZone: 'UTC' } },
        },
        'PATCH',
      )
    ).status,
    200,
  );
  const row = await f.owner.tenantSettings.findUniqueOrThrow({ where: { tenantId: f.tenantId } });
  assert.equal(row.initializedByUserId, f.actors.get('admin')!.id);
  assert.equal(row.initializedByCommandId, commandId);
  assert.match(row.initializedByIdentityKey!, /^[a-f0-9]{64}$/);
  assert.equal(row.bootstrapTemplateVersion, null);
  assert.equal(row.bootstrapTemplateDigest, null);
  assert.equal(row.provisioningRequestId, null);
  await assert.rejects(
    withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
      tx.tenantSettings.update({
        where: { tenantId: f.tenantId },
        data: { initializedByCommandId: randomUUID() },
      }),
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
      tx.tenantSettings.delete({ where: { tenantId: f.tenantId } }),
    ),
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.db, f.otherTenantId, (tx) =>
      tx.tenantSettings.create({
        data: {
          tenantId: f.otherTenantId,
          locale: 'th',
          timezone: 'UTC',
          bootstrapTemplateVersion: 'fake',
          bootstrapTemplateDigest: 'a'.repeat(64),
          provisioningRequestId: randomUUID(),
        },
      }),
    ),
  );
  const privilege = await f.owner.$queryRaw<
    { allowed: boolean }[]
  >`SELECT has_function_privilege('dcontact_app','dc_core_capture_organization_effect()','EXECUTE') AS allowed`;
  assert.equal(privilege[0]?.allowed, false);
});

test('Organization: GET during a defaults save must get an aggregate of a single revision', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const write = async (revision: number) => {
    const result = await f.request(
      'tenant/core-settings/organization',
      'admin',
      {
        commandId: randomUUID(),
        expectedRevision: String(revision - 1),
        patch: {
          ...(revision === 1 ? { displayName: 'Snapshot test organization' } : {}),
          defaults: {
            locale: revision % 2 ? 'th' : 'en',
            timeZone: revision % 2 ? 'UTC' : 'Asia/Bangkok',
          },
        },
      },
      'PATCH',
    );
    assert.equal(result.status, 200);
  };
  await write(1);
  await Promise.all([
    (async () => {
      for (let i = 2; i <= 21; i++) await write(i);
    })(),
    ...Array.from({ length: 3 }, () =>
      (async () => {
        for (let i = 0; i < 25; i++) {
          const read = await f.request('tenant/core-settings/organization');
          assert.equal(read.status, 200);
          const org = (
            read.body as unknown as {
              organization: {
                displayName: string;
                revision: string;
                defaults: { locale: string; timeZone: string };
              };
            }
          ).organization;
          const revision = Number(org.revision);
          assert.equal(org.displayName, 'Snapshot test organization');
          assert.equal(org.defaults.locale, revision % 2 ? 'th' : 'en');
          assert.equal(org.defaults.timeZone, revision % 2 ? 'UTC' : 'Asia/Bangkok');
        }
      })(),
    ),
  ]);
});
