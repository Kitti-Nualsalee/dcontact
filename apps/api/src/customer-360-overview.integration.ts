import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setup as fixtureSetup, ownerCommit, deliverToIam } from './customer-360-test-fixtures.js';
import { contact, grant, head } from './customer-360-read-test-fixtures.js';
import { Customer360ReadController } from './customer-360-read-api.js';
import { Customer360OverviewController } from './customer-360-overview-api.js';
import { Customer360TagCatalogController } from './customer-360-tag-catalog-api.js';

async function setup(...args: Parameters<typeof fixtureSetup>) {
  const f = await fixtureSetup(...args);
  const [role] = await f.db.$queryRaw<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  assert.equal(role?.rolsuper, false);
  assert.equal(role?.rolbypassrls, false);

  return {
    ...f,
    request: async (...input: Parameters<typeof f.request>) => {
      const response = await f.request(...input);
      return {
        ...response,
        body: response.body as typeof response.body & {
          count: string;
          activeCount: string;
          retiredCount: string;
          version: string;
          fields: unknown;
          error: { code: string };
        },
      };
    },
  };
}

test('M1 Overview: actual list predicate, missing-head/ambiguous/merged, 2 tenants และ grant revoke', async (t) => {
  const f = await setup([Customer360ReadController, Customer360OverviewController]);
  t.after(() => f.close());
  for (const state of ['ACTIVE', 'AMBIGUOUS', 'LEGACY'] as const) {
    const id = await contact(f);
    if (state !== 'LEGACY') await head(f, id, state);
    await grant(f, 'admin', id, 'READ');
  }
  const source = await contact(f);
  const target = await contact(f);
  await grant(f, 'admin', source, 'READ');
  await f.memberships.recordIdentityTransition({
    tenantId: f.tenantId,
    commandId: randomUUID(),
    operation: 'MERGE',
    sourceContactId: source,
    targetContactId: target,
    expectedSourceLineageRevision: 0,
    correlationId: 'overview-merged',
  });
  const hidden = await contact(f);
  await contact(f, { tenantId: f.otherTenantId });
  const list = await f.request('customer-360/contacts/search', 'admin', {});
  const overview = await f.request('customer-360/overview/customers', 'admin');
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get('cache-control'), 'no-store');
  const count = overview.body as unknown as { count: string; asOf: string };
  assert.equal(
    count.count,
    String((list.body as unknown as { accessibleCount: { value: number } }).accessibleCount.value),
  );
  assert.equal(count.count, '3');
  assert.ok(!JSON.stringify(overview.body).includes(hidden));
  assert.ok(Number.isFinite(Date.parse(count.asOf)));
  for (const actor of ['admin-two', 'foreign'])
    assert.equal((await f.request('customer-360/overview/customers', actor)).body.count, '0');
  const g = await f.owner.c360ContactCustodianGrant.findFirstOrThrow({
    where: { granteeUserId: f.actors.get('admin')!.id },
  });
  await f.owner.c360ContactCustodianRevocation.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      grantId: g.id,
      actorIdentityKey: g.actorIdentityKey,
      commandId: g.commandId,
      reason: 'fixture',
      evidenceRef: 'fixture',
    },
  });
  const after = await f.request('customer-360/overview/customers', 'admin');
  const listAfter = await f.request('customer-360/contacts/search', 'admin', {});
  assert.equal(
    after.body.count,
    String(
      (listAfter.body as unknown as { accessibleCount: { value: number } }).accessibleCount.value,
    ),
  );
});

test('M1 Overview: stale IAM ไม่แปลงเป็น zero และ current role/proof ตรวจทุก endpoint', async (t) => {
  const f = await setup([Customer360OverviewController]);
  t.after(() => f.close());
  await f.scopes.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: f.segmentId,
    permission: 'VIEW',
    correlationId: 'overview-scope',
  });
  await ownerCommit(f, 'GOLD');
  await deliverToIam(f);
  // Admin ใช้ IAM team scope ได้ด้วย แต่ stale owner ต้องไม่รายงาน total ที่ดูครบ
  await ownerCommit(f, 'SILVER');
  const stale = await f.request('customer-360/overview/customers', 'admin');
  assert.equal(stale.status, 503);
  assert.equal(stale.body.error.code, 'SCOPE_UNAVAILABLE');
  const actor = f.actors.get('admin')!;
  for (const update of [
    { isActive: false },
    { keycloakId: randomUUID() },
    { role: 'SUPERVISOR' as const },
  ]) {
    await f.owner.user.update({ where: { id: actor.id }, data: update });
    for (const route of ['overview/customers', 'overview/tags', 'field-rules'])
      assert.equal((await f.request(`customer-360/${route}`, 'admin')).status, 403);
    await f.owner.user.update({
      where: { id: actor.id },
      data: { isActive: true, keycloakId: actor.id, role: 'ADMIN' },
    });
  }
  for (const route of ['overview/customers', 'overview/tags', 'field-rules']) {
    for (const actor of ['supervisor', 'agent', 'compliance', 'disabled', 'unbound'])
      assert.equal(
        (await f.request(`customer-360/${route}`, actor)).status,
        403,
        `${route}/${actor}`,
      );
    assert.equal((await f.request(`customer-360/${route}?unknown=1`, 'admin')).status, 400);
  }
});

test('M1 Overview: catalog counts มาจาก owner จริงและ rules ใช้ registry/writer เดียวกัน', async (t) => {
  const f = await setup([Customer360OverviewController, Customer360TagCatalogController]);
  t.after(() => f.close());
  assert.deepEqual((await f.request('customer-360/overview/tags', 'admin')).body.activeCount, '0');
  const created = await f.request('customer-360/tags', 'admin', {
    commandId: randomUUID(),
    name: 'Overview fixture',
  });
  assert.equal(created.status, 201);
  const id = (created.body as unknown as { command: { resourceRefs: { id: string }[] } }).command
    .resourceRefs[0]!.id;
  await f.request(`customer-360/tags/${id}/retire`, 'admin', {
    commandId: randomUUID(),
    expectedRevision: '0',
  });
  const counts = await f.request('customer-360/overview/tags', 'admin');
  assert.equal(counts.body.activeCount, '0');
  assert.equal(counts.body.retiredCount, '1');
  const rules = await f.request('customer-360/field-rules', 'admin');
  assert.equal(rules.status, 200);
  assert.equal(rules.body.version, 'c360-profile-v1');
  const fields = rules.body.fields as unknown as {
    name: string;
    required: boolean;
    type: string;
  }[];
  assert.equal(fields.find((x) => x.name === 'company')!.required, false);
  assert.equal(fields.find((x) => x.name === 'vip')!.type, 'boolean');
});

test('M1 Rules: writer registry unavailable เป็น 503 ไม่ส่ง guessed rules', async (t) => {
  const f = await setup([Customer360OverviewController], undefined, { ready: false });
  t.after(() => f.close());
  const r = await f.request('customer-360/field-rules', 'admin');
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'RULES_UNAVAILABLE');
  assert.equal(r.body.fields, undefined);
  f.tagRuntime.ready = false;
  for (const path of ['overview/customers', 'overview/tags', 'field-rules']) {
    assert.equal((await f.request(`customer-360/${path}`, 'admin')).status, 503, path);
  }
});
