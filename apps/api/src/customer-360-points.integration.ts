import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  addC360ContactPoint,
  c360ActorIdentityKey,
  executeC360ProfileCommand,
  fenceC360ContactMutation,
  replaceC360ContactPoint,
  retireC360ContactPoint,
  C360ProfileCommandRejection,
  type C360PointWriteContext,
  type C360ProfileCommandHooks,
  C360ProfileCommandError,
  type C360ProfileEffect,
  type C360VerifiedActor,
} from '@d-contact/customer-360';
import { Prisma, withTenantDatabaseTransaction } from '@d-contact/db';
import { activeHead, grantCustodian, setup, type Fixture } from './customer-360-test-fixtures.js';

/**
 * Cus360 C3 (#793) S2: owner point service ผ่าน S2 command engine จริงบน PostgreSQL/RLS
 * caller ถือ fences และตรวจ manage แบบเดียวกับที่ C4 จะใช้ ไม่เขียน point ผ่าน owner connection
 */
type Write = (
  tx: Prisma.TransactionClient,
  context: C360PointWriteContext,
) => Promise<C360ProfileEffect>;

function admin(f: Fixture): C360VerifiedActor {
  return {
    tenantId: f.tenantId,
    userId: f.actors.get('admin')!.id,
    role: 'ADMIN',
    teamId: f.teamId,
  };
}

async function manageable(f: Fixture, contactId = f.contactId) {
  await grantCustodian(f, 'admin', 'MANAGE');
  if (contactId === f.contactId) await activeHead(f);
}

async function point(
  f: Fixture,
  write: Write,
  options: {
    contactId?: string;
    expected?: string;
    commandId?: string;
    request?: unknown;
    hooks?: C360ProfileCommandHooks;
  } = {},
) {
  const verified = admin(f);
  const contactId = options.contactId ?? f.contactId;
  const actorIdentityKey = c360ActorIdentityKey({
    issuer: 'https://core-idp.test/realms/dcontact',
    subject: verified.userId,
    tenantId: f.tenantId,
    userId: verified.userId,
  });
  const expected =
    options.expected ??
    (
      await f.owner.contact.findUniqueOrThrow({ where: { id: contactId } })
    ).profileRevision.toString();
  const result = await executeC360ProfileCommand(
    f.db,
    { tenantId: f.tenantId, actorIdentityKey, actorUserId: verified.userId },
    {
      commandId: options.commandId ?? randomUUID(),
      action: 'CONTACT_POINT_TEST',
      resourceType: 'CONTACT',
      resourceId: contactId,
      expectedRevisions: { profile: expected },
      normalizationContractVersion: 'c360-test',
      normalizedRequest: options.request ?? { nonce: randomUUID() },
    },
    {
      authorize: async (tx) => {
        const access = await fenceC360ContactMutation(tx, verified, [contactId]);
        const decision = access.get(contactId);
        if (decision?.decision !== 'ALLOW' || !decision.manage) throw new Error('DENIED');
      },
    },
    (tx, command) =>
      write(tx, {
        tenantId: f.tenantId,
        contactId,
        actorIdentityKey,
        commandId: command.commandId,
        expectedProfileRevision: expected,
      }),
    options.hooks,
  );
  assert.equal(result.state, 'TERMINAL');
  return result.state === 'TERMINAL' ? result.receipt : assert.fail();
}

const phone =
  (value: string, country?: string) => (tx: Prisma.TransactionClient, c: C360PointWriteContext) =>
    addC360ContactPoint(tx, c, { kind: 'PHONE', value, explicitCountry: country });
const email = (value: string) => (tx: Prisma.TransactionClient, c: C360PointWriteContext) =>
  addC360ContactPoint(tx, c, { kind: 'EMAIL', value });

const points = (f: Fixture, contactId = f.contactId) =>
  f.owner.c360ContactPoint.findMany({
    where: { tenantId: f.tenantId, contactId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

const revision = async (f: Fixture, contactId = f.contactId) =>
  (
    await f.owner.contact.findUniqueOrThrow({ where: { id: contactId } })
  ).profileRevision.toString();

test('S2: add เก็บ provenance และเพิ่ม revision ครั้งเดียว; ค่าเดิมเป็น NO_OP; parser/revision ผิดถูก REJECTED ไม่มี effect', async () => {
  const f = await setup();
  try {
    await manageable(f);
    const added = await point(f, phone('(213) 373-4253', 'US'));
    assert.equal(added.outcome, 'APPLIED');
    assert.deepEqual(added.committedRevisions, { profile: '1' });
    const [row] = await points(f);
    assert.equal(row!.state, 'ACTIVE');
    assert.equal(row!.normalizedValue, '+12133734253');
    assert.equal(row!.rawValue, '(213) 373-4253');
    assert.equal(row!.explicitCountry, 'US');
    assert.equal(row!.sourceKind, 'PROFILE_COMMAND');
    assert.equal(row!.normalizationVersion, 'c360-phone-v1+libphonenumber-js@1.13.15/max');

    // ค่าเดียวกันในรูปแบบอื่นเป็น NO_OP: มี receipt แต่ไม่มี revision ใหม่หรือ change-audit
    const again = await point(f, phone('+1 213 373 4253'));
    assert.equal(again.outcome, 'NO_OP');
    assert.equal(await revision(f), '1');

    const extension = await point(f, phone('+1 213 373 4253 x12'));
    assert.deepEqual(
      [extension.outcome, extension.code],
      ['REJECTED', 'PHONE_EXTENSION_UNSUPPORTED'],
    );
    const stale = await point(f, email('a@example.com'), { expected: '0' });
    assert.deepEqual([stale.outcome, stale.code], ['REJECTED', 'REVISION_CONFLICT']);
    assert.equal((await points(f)).length, 1);
    assert.equal(await revision(f), '1');

    // audit ไม่มีค่า phone/email ก่อน–หลัง
    const audits = await f.owner.c360ProfileAudit.findMany({ where: { tenantId: f.tenantId } });
    assert.equal(audits.length, 1);
    assert.ok(
      !JSON.stringify(audits, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).includes(
        '213',
      ),
    );
  } finally {
    await f.close();
  }
});

test('S2: ค่าเดียวกันบนสอง contact เก็บได้; retire/replace เฉพาะรายไม่กระทบอีกคนหรือ identity เดิม', async () => {
  const f = await setup();
  try {
    await manageable(f);
    const other = randomUUID();
    await f.owner.contact.create({
      data: { id: other, tenantId: f.tenantId, displayName: 'อีกคน' },
    });
    await f.owner.c360IdentityHead.create({
      data: {
        tenantId: f.tenantId,
        contactId: other,
        canonicalContactId: other,
        state: 'ACTIVE',
        stateDigest: 'e'.repeat(64),
      },
    });
    const [grant] = await f.owner.c360ContactCustodianGrant.findMany({
      where: { tenantId: f.tenantId },
    });
    await f.owner.c360ContactCustodianGrant.create({
      data: { ...grant!, id: randomUUID(), contactId: other, grantedAt: undefined },
    });
    // legacy identity ค่าเดียวกันของ contact แรก: owner/value ต้องไม่ถูกแตะ
    const identity = await f.owner.contactIdentity.create({
      data: {
        tenantId: f.tenantId,
        contactId: f.contactId,
        type: 'EMAIL',
        value: 'Shared@Example.com',
      },
    });

    assert.equal((await point(f, email('Shared@EXAMPLE.COM'))).outcome, 'APPLIED');
    assert.equal(
      (await point(f, email('Shared@EXAMPLE.COM'), { contactId: other })).outcome,
      'APPLIED',
    );
    const [mine] = await points(f);
    const [theirs] = await points(f, other);
    assert.equal(mine!.normalizedValue, theirs!.normalizedValue);

    // point ของอีก contact ผ่าน context ของ contact นี้ = ไม่พบ
    const foreign = await point(f, (tx, c) => retireC360ContactPoint(tx, c, theirs!.id));
    assert.deepEqual([foreign.outcome, foreign.code], ['REJECTED', 'POINT_NOT_FOUND']);

    const replaced = await point(f, (tx, c) =>
      replaceC360ContactPoint(tx, c, mine!.id, { kind: 'EMAIL', value: 'new@example.com' }),
    );
    assert.equal(replaced.outcome, 'APPLIED');
    assert.deepEqual(replaced.committedRevisions, { profile: '2' });
    const after = await points(f);
    assert.deepEqual(
      after.map((row) => [row.normalizedValue, row.state]),
      [
        ['Shared@example.com', 'RETIRED'],
        ['new@example.com', 'ACTIVE'],
      ],
    );
    assert.equal(after[0]!.retiredCommandId, after[1]!.createdCommandId);
    assert.equal((await points(f, other))[0]!.state, 'ACTIVE');
    assert.deepEqual(
      await f.owner.contactIdentity.findUniqueOrThrow({ where: { id: identity.id } }),
      identity,
    );

    const same = await point(f, (tx, c) =>
      replaceC360ContactPoint(tx, c, after[1]!.id, { kind: 'EMAIL', value: ' new@EXAMPLE.com ' }),
    );
    assert.equal(same.outcome, 'NO_OP');
    const retiredAgain = await point(f, (tx, c) => retireC360ContactPoint(tx, c, mine!.id));
    assert.equal(retiredAgain.outcome, 'NO_OP');
    const replaceRetired = await point(f, (tx, c) =>
      replaceC360ContactPoint(tx, c, mine!.id, { kind: 'EMAIL', value: 'x@example.com' }),
    );
    assert.deepEqual([replaceRetired.outcome, replaceRetired.code], ['REJECTED', 'POINT_RETIRED']);
    // attribute เดิมแก้ไม่ได้แม้ผ่าน application role (DB trigger)
    await assert.rejects(
      f.db
        .$executeRaw`UPDATE c360_contact_points SET raw_value = 'x' WHERE id = ${after[1]!.id}::uuid`,
    );
    assert.equal(await revision(f), '2');
  } finally {
    await f.close();
  }
});

test('S2: quota 10 ACTIVE ต่อชนิด; legacy ที่เกินอยู่แล้ว retire/replace ได้แต่เพิ่มไม่ได้', async () => {
  const f = await setup();
  try {
    await manageable(f);
    for (let n = 0; n < 10; n += 1)
      assert.equal(
        (await point(f, phone(`+1 213 373 42${String(n).padStart(2, '0')}`))).outcome,
        'APPLIED',
      );
    const over = await point(f, phone('+1 213 373 4299'));
    assert.deepEqual([over.outcome, over.code], ['REJECTED', 'POINT_QUOTA_EXCEEDED']);
    // email มีเพดานแยก
    assert.equal((await point(f, email('a@example.com'))).outcome, 'APPLIED');

    // legacy เกินเพดาน: ข้อมูลเดิมไม่ถูกตัดทิ้ง (ใส่ผ่าน owner เหมือนผลของ migration เดิม)
    const [command] = await f.owner.c360ProfileCommand.findMany({
      where: { tenantId: f.tenantId },
      take: 1,
    });
    for (const value of ['+12133734290', '+12133734291'])
      await f.owner.c360ContactPoint.create({
        data: {
          id: randomUUID(),
          tenantId: f.tenantId,
          contactId: f.contactId,
          kind: 'PHONE',
          rawValue: value,
          normalizedValue: value,
          normalizationVersion: 'c360-phone-v1+libphonenumber-js@1.13.15/max',
          state: 'ACTIVE',
          sourceKind: 'PROFILE_COMMAND',
          createdActorIdentityKey: command!.actorIdentityKey,
          createdCommandId: command!.commandId,
        },
      });
    const active = () =>
      f.owner.c360ContactPoint.count({
        where: { tenantId: f.tenantId, contactId: f.contactId, kind: 'PHONE', state: 'ACTIVE' },
      });
    assert.equal(await active(), 12);
    assert.equal((await point(f, phone('+1 213 373 4298'))).code, 'POINT_QUOTA_EXCEEDED');
    const [first] = await points(f);
    assert.equal(
      (
        await point(f, (tx, c) =>
          replaceC360ContactPoint(tx, c, first!.id, { kind: 'PHONE', value: '+1 213 373 4297' }),
        )
      ).outcome,
      'APPLIED',
    );
    assert.equal(await active(), 12);
    assert.equal(
      (await point(f, (tx, c) => retireC360ContactPoint(tx, c, first!.id))).outcome,
      'NO_OP',
    );
    const [, second] = await points(f);
    assert.equal(
      (await point(f, (tx, c) => retireC360ContactPoint(tx, c, second!.id))).outcome,
      'APPLIED',
    );
    assert.equal(await active(), 11);
  } finally {
    await f.close();
  }
});

/**
 * หยุด writer ที่ insert point ค่า `value` หลังผ่าน lockContact และ insert แล้ว (ก่อนเพิ่ม revision/commit)
 * แล้วรัน `during` ระหว่างนั้น; trigger barrier เป็นของ test เท่านั้น
 */
async function pausedInsert<T>(
  f: Fixture,
  value: string,
  writer: () => Promise<T>,
  during: () => Promise<void>,
) {
  const suffix = randomUUID().replaceAll('-', '');
  const barrier = randomInt(1_000_000, 1_000_000_000);
  // ค่าทั้งหมดสร้างใน test (UUID/integer/E.164 ที่ตรวจแล้ว) ไม่มี input ภายนอก
  assert.match(value, /^\+[0-9]{8,15}$/);
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION public.c360_test_point_${suffix}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN IF NEW.normalized_value='${value}' THEN PERFORM set_config('lock_timeout','10s',true); PERFORM pg_advisory_xact_lock(${barrier}::bigint); END IF; RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER zz_c360_test_point_${suffix} AFTER INSERT ON public.c360_contact_points FOR EACH ROW EXECUTE FUNCTION public.c360_test_point_${suffix}()`,
  );
  let ready!: () => void;
  const held = new Promise<void>((resolve) => (ready = resolve));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const holder = f.owner.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1::bigint)', barrier);
      ready();
      await gate;
    },
    { timeout: 20000 },
  );
  try {
    await held;
    const running = writer().then(
      (value) => value,
      (error: unknown) => error,
    );
    for (let waited = 0; ; waited += 10) {
      const [row] = await f.owner.$queryRaw<{ waiting: boolean }[]>`
        SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND classid = 0
          AND objid = ${barrier}::bigint::oid AND NOT granted) AS waiting`;
      if (row?.waiting) break;
      if (waited > 3000) assert.fail('writer ไม่ถึง barrier');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await during();
    release();
    await holder;
    return await running;
  } finally {
    release();
    await holder.catch(() => undefined);
    await f.owner.$executeRawUnsafe(
      `DROP TRIGGER IF EXISTS zz_c360_test_point_${suffix} ON public.c360_contact_points`,
    );
    await f.owner.$executeRawUnsafe(`DROP FUNCTION IF EXISTS public.c360_test_point_${suffix}()`);
  }
}

test('S2: add แข่งกันที่ช่องสุดท้ายของ quota ทั้งสองลำดับ: ไม่เกินเพดาน และผู้แพ้ไม่มี effect', async () => {
  const f = await setup();
  try {
    await manageable(f);
    for (let n = 0; n < 9; n += 1)
      await point(f, phone(`+1 213 373 43${String(n).padStart(2, '0')}`));
    const expected = await revision(f);
    const active = () =>
      f.owner.c360ContactPoint.count({
        where: { tenantId: f.tenantId, contactId: f.contactId, state: 'ACTIVE' },
      });

    // ลำดับ 1: A อ่าน revision/quota และ insert แล้วแต่ยังไม่ commit; B ที่มาทีหลังต้องไม่เห็นช่องว่าง
    let late: unknown;
    const first = await pausedInsert(
      f,
      '+12133734380',
      () => point(f, phone('+1 213 373 4380'), { expected }),
      async () => {
        late = await point(f, phone('+1 213 373 4381'), { expected }).then(
          (receipt) => receipt,
          (error: unknown) => error,
        );
      },
    );
    assert.equal((first as { outcome: string }).outcome, 'APPLIED');
    assert.ok(
      late instanceof C360ProfileCommandError && late.code === 'RESOURCE_BUSY',
      `ผู้มาทีหลังต้องได้ RESOURCE_BUSY แต่ได้ ${JSON.stringify(late)}`,
    );
    assert.equal(await active(), 10);
    assert.equal(await revision(f), String(Number(expected) + 1));

    // ลำดับ 2: ผู้ชนะ commit ไปแล้ว คำสั่งที่ใช้ revision เดิมได้ REVISION_CONFLICT ไม่มี effect
    const retried = await point(f, phone('+1 213 373 4381'), { expected });
    assert.deepEqual([retried.outcome, retried.code], ['REJECTED', 'REVISION_CONFLICT']);
    assert.equal(await active(), 10);
  } finally {
    await f.close();
  }
});

test('S2: owner ปฏิเสธ contact ที่ไม่มี head ACTIVE แม้ caller ข้าม authorization', async () => {
  const f = await setup();
  try {
    await assert.rejects(
      withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
        addC360ContactPoint(
          tx,
          {
            tenantId: f.tenantId,
            contactId: f.contactId,
            actorIdentityKey: 'x',
            commandId: randomUUID(),
            expectedProfileRevision: '0',
          },
          { kind: 'PHONE', value: '+1 213 373 4253' },
        ),
      ),
      (error) =>
        error instanceof C360ProfileCommandRejection && error.code === 'IDENTITY_NOT_ACTIVE',
    );
    assert.equal((await points(f)).length, 0);
  } finally {
    await f.close();
  }
});
