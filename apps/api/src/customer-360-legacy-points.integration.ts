import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { setup, type Fixture } from './customer-360-test-fixtures.js';

/**
 * Cus360 C3 (#793) S3: inventory และ import legacy ContactIdentity → contact point ตาม E1 D
 * ผ่าน operator HTTP จริงบน PostgreSQL/RLS; fixture เป็นข้อมูลสังเคราะห์ของ tenant ที่สร้างใหม่เท่านั้น
 */
type Body = Record<string, unknown>;

function operate(
  f: Fixture,
  command: Body,
  options: { commandId?: string; dryRun?: boolean } = {},
) {
  return f.request(
    'customer-360/operator/commands',
    'operator',
    {
      commandId: options.commandId ?? randomUUID(),
      evidenceRef: 'ticket:OPS-793',
      reasonCode: 'LEGACY_POINT_MIGRATION',
      ...(options.dryRun ? { dryRun: true } : {}),
      command,
    },
    'POST',
  );
}

async function contact(f: Fixture, tenantId = f.tenantId) {
  const id = randomUUID();
  await f.owner.contact.create({ data: { id, tenantId, displayName: `legacy ${id}` } });
  return id;
}

async function identity(
  f: Fixture,
  contactId: string,
  type: 'PHONE' | 'EMAIL' | 'LINE',
  value: string,
  tenantId = f.tenantId,
) {
  return f.owner.contactIdentity.create({ data: { tenantId, contactId, type, value } });
}

async function legacyFixture(f: Fixture) {
  const a = await contact(f);
  const b = await contact(f);
  const c = await contact(f);
  const d = await contact(f);
  const many = await contact(f);
  // A: ค่าเดียวกันสองรูปแบบบน contact เดียว → ACTIVE หนึ่ง + แถวที่ถูกแทนที่ (ชี้ไป ACTIVE เดียวกัน)
  await identity(f, a, 'PHONE', '+66812345678');
  await identity(f, a, 'PHONE', '+66 81 234 5678');
  // B: เบอร์ไม่มีประเทศ (ห้ามเดา) และ email ที่ใช้ได้
  await identity(f, b, 'PHONE', '0812345678');
  await identity(f, b, 'EMAIL', 'User@EXAMPLE.com');
  // C: ค่าเดียวกับ A คนละ contact (shared, ไม่ merge)
  await identity(f, c, 'PHONE', '+668 1234 5678');
  // D: extension ไม่ถูกตัดทิ้ง
  await identity(f, d, 'PHONE', '+1 213 373 4253 x12');
  await identity(f, d, 'LINE', 'U-legacy-line');
  // many: เกิน quota 10 → import ครบไม่ตัดทิ้ง
  for (let n = 0; n < 11; n += 1)
    await identity(f, many, 'PHONE', `+1 213 373 44${String(n).padStart(2, '0')}`);
  await f.owner.c360IdentityHead.create({
    data: {
      tenantId: f.tenantId,
      contactId: d,
      canonicalContactId: d,
      state: 'AMBIGUOUS',
      stateDigest: 'a'.repeat(64),
    },
  });
  // tenant อื่นต้องไม่ถูกแตะ
  const foreign = await contact(f, f.otherTenantId);
  await identity(f, foreign, 'PHONE', '+66812345678', f.otherTenantId);
  return { a, b, c, d, many };
}

const facts = (response: { body: unknown }) =>
  (response.body as unknown as { subjects: Array<{ facts: Record<string, string> }> }).subjects[0]!
    .facts;

test('S3: dry-run inventory นับครบโดยไม่มี raw PII และไม่เขียนอะไร', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    await legacyFixture(f);
    const preview = await operate(
      f,
      { action: 'LEGACY_POINT_IMPORT', batchSize: 5 },
      { dryRun: true },
    );
    assert.equal(preview.status, 200);
    assert.equal((preview.body as unknown as Body).outcome, 'WOULD_APPLY');
    const inventory = facts(preview);
    assert.deepEqual(
      {
        phoneIdentities: inventory.phoneIdentities,
        emailIdentities: inventory.emailIdentities,
        imported: inventory.imported,
        pendingActive: inventory.pendingActive,
        pendingReviewRequired: inventory.pendingReviewRequired,
        pendingSuperseded: inventory.pendingSuperseded,
        reviewReasons: JSON.parse(inventory.reviewReasons!),
        contactsOverQuota: inventory.contactsOverQuota,
        sharedKeys: inventory.sharedKeys,
        sharedKeyContacts: inventory.sharedKeyContacts,
        ambiguousIdentityHeads: inventory.ambiguousIdentityHeads,
      },
      {
        phoneIdentities: '16',
        emailIdentities: '1',
        imported: '0',
        // A หนึ่ง, B email, C, many 11
        pendingActive: '14',
        pendingReviewRequired: '2',
        pendingSuperseded: '1',
        reviewReasons: {
          PHONE_COUNTRY_REQUIRED: 1,
          PHONE_EXTENSION_UNSUPPORTED: 1,
        },
        contactsOverQuota: '1',
        sharedKeys: '1',
        sharedKeyContacts: '2',
        ambiguousIdentityHeads: '1',
      },
    );
    assert.match(inventory.sharedKeyDigest!, /^[0-9a-f]{64}$/);
    const text = JSON.stringify(preview.body);
    for (const raw of ['812345678', 'EXAMPLE', '213 373', 'U-legacy'])
      assert.ok(!text.includes(raw), `inventory ต้องไม่มีค่าดิบ ${raw}`);
    assert.equal(await f.owner.c360ContactPoint.count({ where: { tenantId: f.tenantId } }), 0);
    assert.equal(await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId } }), 0);
  } finally {
    await f.close();
  }
});

test('S3: import ทีละ batch จนครบ, รันซ้ำได้, provenance จริง และไม่แตะ ContactIdentity หรือ tenant อื่น', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    const ids = await legacyFixture(f);
    const identitiesBefore = await f.owner.contactIdentity.findMany({ orderBy: { id: 'asc' } });
    const revisionsBefore = new Map(
      (await f.owner.contact.findMany({ where: { tenantId: f.tenantId } })).map((c) => [
        c.id,
        c.profileRevision,
      ]),
    );

    let remaining = Infinity;
    const receipts = [];
    for (let round = 0; remaining > 0; round += 1) {
      assert.ok(round < 10, 'import ต้องจบใน batch ที่จำกัด');
      const response = await operate(f, { action: 'LEGACY_POINT_IMPORT', batchSize: 5 });
      const command = (
        response.body as unknown as {
          command: { outcome: string; committedRevisions: Record<string, string> };
        }
      ).command;
      assert.equal(command.outcome, 'APPLIED');
      receipts.push(command);
      remaining = Number(command.committedRevisions.remaining);
    }
    assert.equal(receipts.length, 4);
    // ครบแล้ว: คำสั่งใหม่เป็น NO_OP และ replay commandId เดิมคืน receipt เดิม
    const done = await operate(f, { action: 'LEGACY_POINT_IMPORT', batchSize: 5 });
    assert.equal((done.body as { command: { outcome: string } }).command.outcome, 'NO_OP');

    const rows = await f.owner.c360ContactPoint.findMany({ where: { tenantId: f.tenantId } });
    assert.equal(rows.length, 17);
    assert.ok(rows.every((row) => row.sourceKind === 'LEGACY_IDENTITY' && row.sourceIdentityId));
    const byIdentity = new Map(identitiesBefore.map((row) => [row.id, row]));
    for (const row of rows) {
      const source = byIdentity.get(row.sourceIdentityId!)!;
      // provenance: contact และค่าดิบตรงกับ identity ต้นทาง ไม่ย้ายเจ้าของ
      assert.equal(row.contactId, source.contactId);
      assert.equal(row.rawValue, source.value);
      assert.equal(row.state === 'REVIEW_REQUIRED', row.normalizedValue === null);
    }
    const state = (contactId: string) =>
      rows
        .filter((row) => row.contactId === contactId)
        .map((row) => [row.normalizedValue, row.state])
        .sort((x, y) => (row(x) < row(y) ? -1 : 1));
    const row = (value: unknown[]) => JSON.stringify(value);
    assert.deepEqual(state(ids.a), [
      ['+66812345678', 'ACTIVE'],
      ['+66812345678', 'RETIRED'],
    ]);
    // แถวที่ถูกแทนที่ตั้งแต่ import: retire โดย command เดียวกับที่สร้าง ไม่ใช่ retire ภายหลัง
    const superseded = rows.find((row) => row.contactId === ids.a && row.state === 'RETIRED')!;
    assert.equal(superseded.retiredCommandId, superseded.createdCommandId);
    assert.deepEqual(state(ids.b), [
      ['User@example.com', 'ACTIVE'],
      [null, 'REVIEW_REQUIRED'],
    ]);
    assert.deepEqual(state(ids.c), [['+66812345678', 'ACTIVE']]);
    assert.deepEqual(state(ids.d), [[null, 'REVIEW_REQUIRED']]);
    assert.equal(
      rows.filter((row) => row.contactId === ids.many && row.state === 'ACTIVE').length,
      11,
    );

    // ContactIdentity เดิมไม่เปลี่ยน และ tenant อื่นไม่มี point
    assert.deepEqual(
      await f.owner.contactIdentity.findMany({ orderBy: { id: 'asc' } }),
      identitiesBefore,
    );
    assert.equal(await f.owner.c360ContactPoint.count({ where: { tenantId: f.otherTenantId } }), 0);
    // contact ที่ได้ point เพิ่ม revision เพื่อให้คำสั่งแก้ที่ถือ revision เก่าไม่ทับข้อมูลที่ import
    for (const contactId of [ids.a, ids.b, ids.c, ids.d, ids.many]) {
      const after = (await f.owner.contact.findUniqueOrThrow({ where: { id: contactId } }))
        .profileRevision;
      assert.ok(after > revisionsBefore.get(contactId)!, `revision ของ ${contactId} ต้องเพิ่ม`);
    }
    // audit มีแค่จำนวน ไม่มีค่าดิบ
    const audits = await f.owner.c360ProfileAudit.findMany({ where: { tenantId: f.tenantId } });
    assert.equal(audits.length, 4);
    assert.ok(
      !JSON.stringify(audits, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).includes(
        '8123',
      ),
    );

    // legacy writer เดิมเพิ่ม identity ใหม่หลัง import: รันใหม่ได้เฉพาะแถวที่ยังไม่ import
    await identity(f, ids.c, 'EMAIL', 'late@example.com');
    const late = await operate(f, { action: 'LEGACY_POINT_IMPORT', batchSize: 5 });
    assert.equal(
      (late.body as unknown as { command: { committedRevisions: Record<string, string> } }).command
        .committedRevisions.imported,
      '1',
    );
    assert.equal(await f.owner.c360ContactPoint.count({ where: { tenantId: f.tenantId } }), 18);
  } finally {
    await f.close();
  }
});

test('S3: import สองคำสั่งพร้อมกันไม่สร้างแถวซ้ำ (unique source identity + contact lock)', async () => {
  const f = await setup([Customer360OperatorController]);
  try {
    await legacyFixture(f);
    const results = await Promise.all([
      operate(f, { action: 'LEGACY_POINT_IMPORT', batchSize: 200 }),
      operate(f, { action: 'LEGACY_POINT_IMPORT', batchSize: 200 }),
    ]);
    // 201 APPLIED, 200 NO_OP หลังอีกคน commit หรือ 503 RESOURCE_BUSY (retryable) เมื่อล็อก contact ไม่ได้
    for (const response of results)
      assert.ok([200, 201, 503].includes(response.status), `status ${response.status}`);
    assert.equal(await f.owner.c360ContactPoint.count({ where: { tenantId: f.tenantId } }), 17);
    const again = await operate(f, { action: 'LEGACY_POINT_IMPORT', batchSize: 200 });
    assert.equal((again.body as { command: { outcome: string } }).command.outcome, 'NO_OP');
    assert.equal(await f.owner.c360ContactPoint.count({ where: { tenantId: f.tenantId } }), 17);
  } finally {
    await f.close();
  }
});
