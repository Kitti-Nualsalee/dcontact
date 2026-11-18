import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Customer360ImportController } from './customer-360-import-api.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { Customer360ReadController } from './customer-360-read-api.js';
import { setup, type Fixture } from './customer-360-test-fixtures.js';

/**
 * CSV import (#909): HTTP จริง → current authorization → create command ต่อแถว → PostgreSQL/RLS
 * ใช้ application role ที่ไม่ bypass RLS และข้อมูลสังเคราะห์เท่านั้น
 */

const mapping = {
  version: 1,
  columns: { displayName: 'name', company: 'company', phone: 'phone', email: 'email' },
  defaultPhoneCountry: 'TH',
};
const csv = (lines: string[]) => ['name,company,phone,email', ...lines].join('\n');
const GOOD = csv([
  'สมชาย ใจดี,บริษัท เอ,0812345678,somchai@example.test',
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

test('application role ไม่ bypass RLS', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  const [role] = await f.db.$queryRaw<
    { rolsuper: boolean; rolbypassrls: boolean }[]
  >`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
  assert.deepEqual(role, { rolsuper: false, rolbypassrls: false });
});

test('preview ไม่สร้างข้อมูล; confirm สร้างเฉพาะแถวที่ผ่านและอ่านกลับตามสิทธิ์ได้', async (t) => {
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
  assert.equal(await contactCount(f), before, 'preview ไม่สร้าง Contact');
  assert.equal(
    await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId } }),
    commandsBefore,
    'preview ไม่สร้าง command',
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
  assert.ok(!JSON.stringify(done.body).includes('สมชาย'), 'ผลรายแถวไม่มีค่า raw');

  // อ่านกลับผ่าน HTTP ตามสิทธิ์ปัจจุบัน: creator ได้ MANAGE, Admin อีกคนไม่เห็น
  const first = done.body.rows[0];
  assert.equal(first.state, 'APPLIED');
  const profile = await f.request(`customer-360/contacts/${first.contactId}`, 'admin');
  assert.equal(profile.status, 200);
  assert.equal(
    (profile.body as unknown as { contact: { displayName: string } }).contact.displayName,
    'สมชาย ใจดี',
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

  // ส่งซ้ำด้วย commandId เดิมต้องไม่สร้างลูกค้าซ้ำ และได้ผลเดิม
  const replay = await post(f, 'confirm', 'admin', text, {
    commandId,
    planHash: preview.body.planHash,
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, done.body);
  assert.equal(await contactCount(f), before + 3);
});

test('confirm ไม่ผ่านเมื่อไฟล์/mapping เปลี่ยนหรือ planHash ผิด และไม่สร้างข้อมูล', async (t) => {
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

test('ไฟล์/mapping ที่ผิดคืน error ที่ไม่สะท้อนข้อมูลและไม่สร้างข้อมูล', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  const secret = 'ความลับ-ห้ามหลุด';
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

test('ต้องเป็น Admin ที่มี CONTACT_CREATE; Agent/ไม่มี capability/ต่าง tenant ถูกปฏิเสธโดยไม่สร้างข้อมูล', async (t) => {
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
  // admin-two ไม่ได้รับ capability แม้อยู่ tenant เดียวกัน
  assert.equal((await post(f, 'preview', 'admin-two', GOOD)).status, 403);
  // token ของ tenant อื่นสร้างข้อมูลใน tenant นี้ไม่ได้
  const foreign = await post(f, 'confirm', 'foreign', GOOD, {
    commandId: randomUUID(),
    planHash: preview.body.planHash,
  });
  assert.notEqual(foreign.status, 200);
  assert.equal(await contactCount(f), before);
});

test('ซ้ำกับลูกค้าที่อ่านได้เป็น warning ที่ยังยืนยันได้ และไม่เปิดเผยลูกค้าที่อ่านไม่ได้', async (t) => {
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
  // Admin อีกคนที่ไม่เห็นลูกค้าเดิมต้องไม่ได้ warning (ไม่มี existence oracle)
  await allowCreate(f, 'admin-two');
  const other = await post(f, 'preview', 'admin-two', seed);
  assert.deepEqual(other.body.counts, { valid: 1, invalid: 0, warning: 0 });
});

test('สิทธิ์ถูกถอนกลางทาง: แถวที่ commit แล้วคงอยู่ ที่เหลือไม่ถูกเริ่ม และส่งซ้ำไม่สร้างซ้ำ', async (t) => {
  const f = await fixture();
  t.after(() => f.close());
  await allowCreate(f);
  const adminId = f.actors.get('admin')!.id;
  const before = await contactCount(f);
  const text = csv(Array.from({ length: 6 }, (_, i) => `ลูกค้า ${i + 1},,,`));
  const preview = await post(f, 'preview', 'admin', text);
  assert.equal(preview.body.counts.valid, 6);
  // trigger สังเคราะห์: ปิด Admin ใน transaction ของแถวที่ 3 (สิทธิ์หายก่อน commit แถวนั้น)
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
  assert.equal(applied, 2, 'แถวที่ 1-2 commit แล้ว แถวที่ 3 rollback เพราะสิทธิ์หายก่อน commit');
  assert.equal(partial.body.rows[2].code, 'CUSTOMER_ACCESS_DENIED');
  assert.equal(
    partial.body.rows.filter((row: { state: string }) => row.state === 'NOT_ATTEMPTED').length,
    6 - applied,
  );
  assert.equal(await contactCount(f), before + applied);
  // trigger ย้อนกลับพร้อมแถวที่ 3; ปิด Admin จริงแล้วส่งซ้ำต้องถูกปฏิเสธโดยไม่สร้างเพิ่ม
  await f.owner.$executeRawUnsafe('DROP TRIGGER test_909_revoke ON contacts');
  await f.owner.user.update({ where: { id: adminId }, data: { isActive: false } });
  const denied = await post(f, 'confirm', 'admin', text, {
    commandId,
    planHash: preview.body.planHash,
  });
  assert.equal(denied.status, 403);
  assert.equal(await contactCount(f), before + applied);
  // เปิดสิทธิ์กลับแล้วส่งซ้ำด้วย commandId เดิม: ครบ 6 ราย ไม่ซ้ำ
  await f.owner.user.update({ where: { id: adminId }, data: { isActive: true } });
  const resumed = await post(f, 'confirm', 'admin', text, {
    commandId,
    planHash: preview.body.planHash,
  });
  assert.equal(resumed.body.state, 'COMPLETED');
  assert.equal(resumed.body.counts.applied, 6);
  assert.equal(await contactCount(f), before + 6);
});
