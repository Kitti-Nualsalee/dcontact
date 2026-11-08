import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createC360CursorCodec, type C360CursorPayload } from '@d-contact/customer-360';
import { Customer360ActivityController } from './customer-360-activity-api.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { Customer360TagCatalogController } from './customer-360-tag-catalog-api.js';
import { contact, grant } from './customer-360-read-test-fixtures.js';
import { deliverToIam, ownerCommit, setup, type Fixture } from './customer-360-test-fixtures.js';

const KEY = randomBytes(32);
process.env.CUSTOMER_360_CURSOR_KEYS = `test:${KEY.toString('base64')}`;
const ACTIVITY = 'customer-360/activity';
type Page = {
  items: {
    id: string;
    occurredAt: string;
    operation: string;
    actorDisplay: null;
    resourceRef: string;
    changedFields: string[];
  }[];
  coverage: { status: string; intervals: unknown[]; gaps: { reasonCode: string }[] };
  asOf: string;
  nextCursor: string | null;
};
const page = (body: unknown) => body as Page;
const resource = (body: unknown) =>
  (body as { command: { resourceRefs: { id: string }[] } }).command.resourceRefs[0]!.id;
async function fixture() {
  const f = await setup([
    Customer360ActivityController,
    Customer360OperatorController,
    Customer360TagCatalogController,
  ]);
  const [role] = await f.db.$queryRaw<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
    SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
  return f;
}
async function auditFixture(
  f: Fixture,
  resourceId: string,
  operation: string,
  createdAt = new Date(),
  tenantId = f.tenantId,
) {
  const commandId = randomUUID();
  const actorIdentityKey = 'actor-private-sentinel';
  await f.owner.c360ProfileCommand.create({
    data: {
      tenantId,
      commandId,
      actorIdentityKey,
      action: 'FIXTURE',
      resourceType: 'CONTACT',
      resourceId,
      payloadDigest: 'b'.repeat(64),
      normalizationContractVersion: 'fixture',
    },
  });
  const row = await f.owner.c360ProfileAudit.create({
    data: {
      tenantId,
      commandId,
      actorIdentityKey,
      id: randomUUID(),
      operation,
      resourceType: 'CONTACT',
      resourceId,
      createdAt,
      changedFields: ['company', 'secret@example.test'],
      beforeRevisions: { notes: 'before-private-sentinel' },
      afterRevisions: { notes: 'after-private-sentinel' },
      evidenceRefs: ['/private/owner-evidence'],
    },
  });
  return row.id;
}

test('Activity maps actual owner effects, without duplicating replay/no-op/failed write', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const permit = await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-ACTIVITY',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  assert.equal(permit.status, 201);
  const create = { commandId: randomUUID(), displayName: 'secret-created-name' };
  const created = await f.request('customer-360/contacts', 'admin', create);
  assert.equal(created.status, 201);
  assert.deepEqual((await f.request('customer-360/contacts', 'admin', create)).body, created.body);
  const id = resource(created.body);
  const patch = {
    commandId: randomUUID(),
    expectedProfileRevision: '0',
    expectedLineageRevision: '0',
    company: 'secret-company',
  };
  assert.equal(
    (await f.request(`customer-360/contacts/${id}`, 'admin', patch, 'PATCH')).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        `customer-360/contacts/${id}`,
        'admin',
        { ...patch, commandId: randomUUID(), expectedProfileRevision: '1' },
        'PATCH',
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(
        `customer-360/contacts/${id}`,
        'admin',
        { ...patch, commandId: randomUUID(), company: 'secret-conflict' },
        'PATCH',
      )
    ).status,
    409,
  );

  const tagged = await f.request('customer-360/tags', 'admin', {
    commandId: randomUUID(),
    name: 'secret-tag',
  });
  assert.equal(tagged.status, 201);
  const tagId = resource(tagged.body);
  assert.equal(
    (
      await f.request(
        `customer-360/tags/${tagId}`,
        'admin',
        { commandId: randomUUID(), expectedRevision: '0', name: 'secret-renamed' },
        'PATCH',
      )
    ).status,
    200,
  );
  for (const [revision, attach] of [
    ['0', true],
    ['1', false],
  ] as const) {
    const result = await f.request(
      `customer-360/contacts/${id}/tags`,
      'admin',
      {
        commandId: randomUUID(),
        expectedTagRevision: revision,
        expectedLineageRevision: '0',
        attachTagIds: attach ? [tagId] : [],
        detachTagIds: attach ? [] : [tagId],
      },
      'PATCH',
    );
    assert.equal(result.status, 200);
  }
  assert.equal(
    (
      await f.request(`customer-360/tags/${tagId}/retire`, 'admin', {
        commandId: randomUUID(),
        expectedRevision: '1',
      })
    ).status,
    200,
  );

  const result = await f.request(ACTIVITY, 'admin');
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const all = page(result.body);
  assert.deepEqual(all.items.map((item) => item.operation).sort(), [
    'CONTACT_CREATED',
    'PROFILE_UPDATED',
    'TAG_ATTACHED',
    'TAG_CREATED',
    'TAG_DETACHED',
    'TAG_RENAMED',
    'TAG_RETIRED',
  ]);
  assert.ok(all.items.every((item) => item.actorDisplay === null));
  assert.ok(all.items.every((item) => item.resourceRef === id || item.resourceRef === tagId));
  assert.doesNotMatch(
    JSON.stringify(all),
    /secret-|actorIdentityKey|beforeRevisions|afterRevisions|evidenceRefs/,
  );
  assert.equal(all.coverage.status, 'UNKNOWN');
  assert.equal(page((await f.request(ACTIVITY, 'admin-two')).body).items.length, 3);
  assert.equal(page((await f.request(ACTIVITY, 'foreign')).body).items.length, 0);
  for (const actor of ['supervisor', 'agent', 'compliance', 'disabled', 'unbound'])
    assert.equal((await f.request(ACTIVITY, actor)).status, 403, actor);
});

test('Activity authorization before keyset limit, exact time bounds, encrypted cursor and revoke', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const first = await contact(f);
  const hidden = await contact(f);
  const foreign = await contact(f, { tenantId: f.otherTenantId });
  const visible = await grant(f, 'admin', first, 'READ');
  const timestamp = new Date(Date.now() - 60_000);
  const ids = [
    await auditFixture(f, first, 'CONTACT_UPDATE', timestamp),
    await auditFixture(f, first, 'CONTACT_UPDATE', timestamp),
  ]
    .sort()
    .reverse();
  await auditFixture(f, hidden, 'CONTACT_UPDATE');
  await auditFixture(f, foreign, 'CONTACT_UPDATE', new Date(), f.otherTenantId);
  await auditFixture(f, first, 'LEGACY_UNMAPPED_PRIVATE');
  await auditFixture(f, first, 'CONTACT_UPDATE', new Date(Date.now() - 31 * 86_400_000));
  const path = `${ACTIVITY}?type=PROFILE_UPDATED&limit=1`;
  const response = await f.request(path, 'admin');
  assert.equal(response.status, 200);
  const one = page(response.body);
  assert.deepEqual(
    one.items.map((item) => item.id),
    [ids[0]],
  );
  assert.deepEqual(one.items[0]?.changedFields, ['company']);
  assert.doesNotMatch(
    JSON.stringify(one),
    /private-sentinel|secret@example|owner-evidence|LEGACY_UNMAPPED_PRIVATE/,
  );
  assert.ok(one.nextCursor);
  assert.equal(one.coverage.gaps[0]?.reasonCode, 'UNMAPPED_EVENT');
  const next = (cursor: string) => `${path}&cursor=${encodeURIComponent(cursor)}`;
  const two = page((await f.request(next(one.nextCursor), 'admin')).body);
  assert.deepEqual(
    two.items.map((item) => item.id),
    [ids[1]],
  );
  assert.equal(two.nextCursor, null);
  const [, , encoded] = one.nextCursor.split('.');
  const raw = Buffer.from(encoded!, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
  decipher.setAAD(Buffer.from('c360-cursor-v1:test'));
  decipher.setAuthTag(raw.subarray(-16));
  const payload = JSON.parse(
    Buffer.concat([decipher.update(raw.subarray(12, -16)), decipher.final()]).toString(),
  ) as C360CursorPayload;
  const expired = createC360CursorCodec(
    [{ id: 'test', key: KEY }],
    () => Date.now() - 16 * 60_000,
  ).seal(payload);
  assert.equal((await f.request(next(expired), 'admin')).body.error.code, 'CURSOR_EXPIRED');
  const tamper = one.nextCursor.replace(
    /(\.[^.]+\.)(.)/,
    (_, prefix, byte) => prefix + (byte === 'A' ? 'B' : 'A'),
  );
  assert.equal((await f.request(next(tamper), 'admin')).body.error.code, 'INVALID_CURSOR');
  assert.equal(
    (await f.request(next(one.nextCursor), 'admin-two')).body.error.code,
    'INVALID_CURSOR',
  );
  assert.equal(
    (await f.request(next(one.nextCursor), 'foreign')).body.error.code,
    'INVALID_CURSOR',
  );
  assert.equal(
    (await f.request(next(one.nextCursor).replace('limit=1', 'limit=2'), 'admin')).body.error.code,
    'INVALID_CURSOR',
  );

  const window = (from: Date, to: Date) =>
    `${ACTIVITY}?${new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })}`;
  assert.equal(
    page((await f.request(window(timestamp, new Date(+timestamp + 1)), 'admin')).body).items.length,
    2,
  );
  assert.equal(
    page((await f.request(window(new Date(+timestamp - 1), timestamp), 'admin')).body).items.length,
    0,
  );
  for (const query of [
    'limit=0',
    'limit=101',
    'type=ALL&type=TAG_CREATED',
    'type=RAW',
    'foo=1',
    'from=2026-01-01',
    'from=2026-02-30T00:00:00Z&to=2026-03-01T00:00:00Z',
    'from=2025-01-01T00:00:00Z&to=2025-05-01T00:00:00Z',
  ])
    assert.equal((await f.request(`${ACTIVITY}?${query}`, 'admin')).status, 400, query);
  await f.owner.c360ContactCustodianRevocation.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenantId,
      grantId: visible.id,
      actorIdentityKey: visible.actorIdentityKey,
      commandId: visible.commandId,
      reason: 'fixture',
      evidenceRef: 'fixture',
    },
  });
  assert.equal(
    (await f.request(next(one.nextCursor), 'admin')).body.error.code,
    'CURSOR_CONTEXT_CHANGED',
  );
  assert.equal(page((await f.request(path, 'admin')).body).items.length, 0);
});

test('Activity stale IAM is 503 and matching coverage is never inferred from audit rows', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await f.scopes.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: f.segmentId,
    permission: 'VIEW',
    correlationId: 'activity-scope',
  });
  await auditFixture(f, f.contactId, 'CONTACT_UPDATE');
  await auditFixture(f, f.contactId, 'CONTACT_UPDATE');
  await ownerCommit(f, 'GOLD');
  const stale = await f.request(ACTIVITY, 'admin');
  assert.equal(stale.status, 503);
  assert.equal(stale.body.error.code, 'SCOPE_UNAVAILABLE');
  await deliverToIam(f);
  const available = page((await f.request(ACTIVITY, 'admin')).body);
  assert.equal(available.items.length, 2);
  assert.equal(available.coverage.status, 'UNKNOWN');
  const first = page((await f.request(`${ACTIVITY}?limit=1`, 'admin')).body);
  assert.ok(first.nextCursor);
  await ownerCommit(f, 'SILVER');
  const stalePage = await f.request(
    `${ACTIVITY}?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`,
    'admin',
  );
  assert.equal(stalePage.status, 503);
  assert.equal(stalePage.body.error.code, 'SCOPE_UNAVAILABLE');
  f.tagRuntime.ready = false;
  const gated = await f.request(ACTIVITY, 'admin');
  assert.equal(gated.status, 503);
  assert.equal(gated.body.error.code, 'AUDIT_UNAVAILABLE');
});
