import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Customer360ImportController } from './customer-360-import-api.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { Customer360ReadController } from './customer-360-read-api.js';
import { setup, type Fixture } from './customer-360-test-fixtures.js';

/**
 * CSV import (#909): real HTTP → current authorization → a create command per row → PostgreSQL/RLS
 * uses an application role that does not bypass RLS and synthetic data only
 */

const mapping = {
  version: 1,
  columns: { displayName: 'name', company: 'company', phone: 'phone', email: 'email' },
  defaultPhoneCountry: 'TH',
};
const csv = (lines: string[]) => ['name,company,phone,email', ...lines].join('\n');
const GOOD = csv([
  'สมชาย ใจดี,บริษัท เอ,0812345678,somchai@example.test', // allow-thai: Thai CSV import row
  'Jane Roe,Acme,+14155550123,jane@example.test',
  'No Contact,,,',
]);

async function post(
  f: Fixture,
  path: 'preview' | 'confirm',
  token: string,
  csvText: string,
  fields: Record<string, string> = {},
  mapped: unknown = mapping,
) {
  const form = new FormData();
  form.set('mapping', JSON.stringify(mapped));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  form.set('file', new Blob([csvText], { type: 'text/csv' }), 'import.csv');
  const response = await fetch(`${f.base}/api/v1/customer-360/imports/${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = (await response.json()) as Record<string, any>;
  return { status: response.status, body };
}

async function allowCreate(f: Fixture, token = 'admin') {
  const grant = await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-909',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get(token)!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  assert.equal(grant.status, 201);
}

const fixture = () =>
  setup([Customer360OperatorController, Customer360ReadController, Customer360ImportController]);
const contactCount = (f: Fixture) => f.owner.contact.count({ where: { tenantId: f.tenantId } });

test('the application role does not bypass RLS', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const [role] = await f.db.$queryRaw<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
});

test('preview creates no data; confirm creates only the rows that pass and reads back per permission', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  const before = await contactCount(f);
  const commandsBefore = await f.owner.c360ProfileCommand.count({
    where: { tenantId: f.tenantId },
  });
  const text = csv([...GOOD.split('\n').slice(1), 'Bad Phone,,123,']);
  const preview = await post(f, 'preview', 'admin', text);
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.counts, { valid: 3, invalid: 1, warning: 0 });
  assert.match(preview.body.planHash, /^[0-9a-f]{64}$/);
  assert.equal(await contactCount(f), before, 'preview creates no Contact');
  assert.equal(
    await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId } }),
    commandsBefore,
    'preview creates no command',
  );

  const commandId = randomUUID();
  const done = await post(f, 'confirm', 'admin', text, {
    commandId,
    planHash: preview.body.planHash,
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.state, 'COMPLETED');
  assert.deepEqual(done.body.counts, {
    applied: 3,
    rejected: 0,
    notSelected: 1,
    pending: 0,
    unknown: 0,
    notAttempted: 0,
  });
  assert.equal(await contactCount(f), before + 3);
  const bad = done.body.rows.find((row: { rowNo: number }) => row.rowNo === 4);
  assert.equal(bad.state, 'NOT_SELECTED');
  assert.deepEqual(bad.fieldErrors, [{ field: 'phone', code: 'PHONE_INVALID' }]);
  assert.ok(!JSON.stringify(done.body).includes('สมชาย'), 'the per-row result has no raw value'); // allow-thai: Thai CSV import row

  // read back through HTTP per the current permission: the creator gets MANAGE, another Admin does not see it
  const first = done.body.rows[0];
  assert.equal(first.state, 'APPLIED');
  const profile = await f.request(`customer-360/contacts/${first.contactId}`, 'admin');
  assert.equal(profile.status, 200);
  assert.equal(
    (profile.body as unknown as { contact: { displayName: string } }).contact.displayName,
    'สมชาย ใจดี', // allow-thai: Thai CSV import row
  );
  assert.equal(
    (await f.request(`customer-360/contacts/${first.contactId}`, 'admin-two')).status,
    404,
  );
  assert.equal(
    await f.owner.c360ContactPoint.count({
      where: { tenantId: f.tenantId, contactId: first.contactId },
    }),
    2,
  );

  // resending with the original commandId must not create the customer again and gets the original result
  const replay = await post(f, 'confirm', 'admin', text, {
    commandId,
    planHash: preview.body.planHash,
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, done.body);
  assert.equal(await contactCount(f), before + 3);
});

test('confirm fails when the file/mapping changes or the planHash is wrong, and creates no data', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  const before = await contactCount(f);
  const preview = await post(f, 'preview', 'admin', GOOD);
  const planHash = preview.body.planHash as string;
  const stale = [
    await post(f, 'confirm', 'admin', GOOD + '\nExtra,,,', { commandId: randomUUID(), planHash }),
    await post(
      f,
      'confirm',
      'admin',
      GOOD,
      { commandId: randomUUID(), planHash },
      {
        ...mapping,
        defaultPhoneCountry: 'US',
      },
    ),
    await post(f, 'confirm', 'admin', GOOD, { commandId: randomUUID(), planHash: 'f'.repeat(64) }),
  ];
  for (const response of stale) {
    assert.equal(response.status, 409);
    assert.equal(response.body.error.code, 'PREVIEW_STALE');
  }
  const noValid = csv(['Bad,,123,']);
  const noValidPreview = await post(f, 'preview', 'admin', noValid);
  const rejected = await post(f, 'confirm', 'admin', noValid, {
    commandId: randomUUID(),
    planHash: noValidPreview.body.planHash,
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'NO_VALID_ROWS');
  assert.equal((await post(f, 'confirm', 'admin', GOOD, { planHash })).status, 400);
  assert.equal(await contactCount(f), before);
});

test('an invalid file/mapping returns an error that does not echo the data and creates no data', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  const secret = 'secret-must-not-leak';
  const cases: [string, number, string, unknown?][] = [
    [`name,name\n${secret},x`, 400, 'CSV_INVALID'],
    [`name,company,phone,email\n"${secret}`, 400, 'CSV_INVALID'],
    [csv(Array.from({ length: 1001 }, (_, i) => `n${i},,,`)), 413, 'IMPORT_LIMIT_EXCEEDED'],
    [GOOD, 400, 'MAPPING_INVALID', { version: 1, columns: { displayName: 'missing' } }],
    [GOOD, 400, 'MAPPING_INVALID', 'not-an-object'],
  ];
  for (const [text, status, code, mapped] of cases) {
    const result = await post(f, 'preview', 'admin', text, {}, mapped ?? mapping);
    assert.equal(result.status, status, code);
    assert.equal(result.body.error.code, code);
    assert.ok(!JSON.stringify(result.body).includes(secret));
  }
  const max = csv(Array.from({ length: 1000 }, (_, i) => `n${i},,,`));
  assert.equal((await post(f, 'preview', 'admin', max)).body.counts.valid, 1000);
});

test('must be an Admin with CONTACT_CREATE; an Agent/no capability/another tenant is rejected without creating data', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const before = await contactCount(f);
  const fields = { commandId: randomUUID(), planHash: 'a'.repeat(64) };
  for (const token of ['admin', 'agent', 'supervisor', 'compliance', 'unbound', 'disabled']) {
    for (const path of ['preview', 'confirm'] as const) {
      const result = await post(f, path, token, GOOD, fields);
      assert.equal(result.status, 403, `${token} ${path}`);
    }
  }
  assert.equal(await contactCount(f), before);

  await allowCreate(f);
  const preview = await post(f, 'preview', 'admin', GOOD);
  assert.equal(preview.status, 200);
  // admin-two does not get the capability even in the same tenant
  assert.equal((await post(f, 'preview', 'admin-two', GOOD)).status, 403);
  // a token of another tenant cannot create data in this tenant
  const foreign = await post(f, 'confirm', 'foreign', GOOD, {
    commandId: randomUUID(),
    planHash: preview.body.planHash,
  });
  assert.notEqual(foreign.status, 200);
  assert.equal(await contactCount(f), before);
});

test('a duplicate of a readable customer is a warning that can still be confirmed, and does not reveal an unreadable customer', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  const seed = csv(['Dup One,,,dup@example.test']);
  const first = await post(f, 'preview', 'admin', seed);
  const created = await post(f, 'confirm', 'admin', seed, {
    commandId: randomUUID(),
    planHash: first.body.planHash,
  });
  assert.equal(created.body.counts.applied, 1);
  const again = await post(f, 'preview', 'admin', seed);
  assert.deepEqual(again.body.counts, { valid: 1, invalid: 0, warning: 1 });
  assert.deepEqual(again.body.rows[0].warnings, ['READABLE_DUPLICATE']);
  // another Admin who cannot see the existing customer must not get a warning (no existence oracle)
  await allowCreate(f, 'admin-two');
  const other = await post(f, 'preview', 'admin-two', seed);
  assert.deepEqual(other.body.counts, { valid: 1, invalid: 0, warning: 0 });
});

test('permission revoked midway: committed rows stay, the rest are not started, and resending does not duplicate', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  const adminId = f.actors.get('admin')!.id;
  const before = await contactCount(f);
  const text = csv(Array.from({ length: 6 }, (_, i) => `Customer ${i + 1},,,`));
  const preview = await post(f, 'preview', 'admin', text);
  assert.equal(preview.body.counts.valid, 6);
  // synthetic trigger: disables the Admin inside the transaction of row 3 (the permission is lost before that row commits)
  await f.owner.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION test_909_revoke() RETURNS trigger AS $$
    BEGIN
      IF (SELECT count(*) FROM contacts WHERE tenant_id = NEW.tenant_id) >= ${before + 3} THEN
        UPDATE users SET is_active = false WHERE id = '${adminId}'::uuid;
      END IF;
      RETURN NEW;
    END $$ LANGUAGE plpgsql`);
  await f.owner.$executeRawUnsafe(
    'CREATE TRIGGER test_909_revoke AFTER INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION test_909_revoke()',
  );
  t.after(async () => {
    await f.owner.$executeRawUnsafe('DROP TRIGGER IF EXISTS test_909_revoke ON contacts');
    await f.owner.$executeRawUnsafe('DROP FUNCTION IF EXISTS test_909_revoke()');
  });
  const commandId = randomUUID();
  const partial = await post(f, 'confirm', 'admin', text, {
    commandId,
    planHash: preview.body.planHash,
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.state, 'INCOMPLETE');
  const applied = partial.body.rows.filter(
    (row: { state: string }) => row.state === 'APPLIED',
  ).length;
  assert.equal(
    applied,
    2,
    'rows 1-2 are committed and row 3 rolls back because the permission was lost before commit',
  );
  assert.equal(partial.body.rows[2].code, 'CUSTOMER_ACCESS_DENIED');
  assert.equal(
    partial.body.rows.filter((row: { state: string }) => row.state === 'NOT_ATTEMPTED').length,
    6 - applied,
  );
  assert.equal(await contactCount(f), before + applied);
  // the trigger is reverted together with row 3; actually disable the Admin then resend must be rejected without creating more
  await f.owner.$executeRawUnsafe('DROP TRIGGER test_909_revoke ON contacts');
  await f.owner.user.update({ where: { id: adminId }, data: { isActive: false } });
  const denied = await post(f, 'confirm', 'admin', text, {
    commandId,
    planHash: preview.body.planHash,
  });
  assert.equal(denied.status, 403);
  assert.equal(await contactCount(f), before + applied);
  // re-enable the permission then resend with the original commandId: all 6 customers, no duplicates
  await f.owner.user.update({ where: { id: adminId }, data: { isActive: true } });
  const resumed = await post(f, 'confirm', 'admin', text, {
    commandId,
    planHash: preview.body.planHash,
  });
  assert.equal(resumed.body.state, 'COMPLETED');
  assert.equal(resumed.body.counts.applied, 6);
  assert.equal(await contactCount(f), before + 6);
});
