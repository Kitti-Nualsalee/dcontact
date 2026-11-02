import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction, type Prisma } from '@d-contact/db';
import {
  C360ProfileCommandError,
  C360ProfileCommandRejection,
  c360ActorIdentityKey,
  executeC360ProfileCommand,
  lookupC360ProfileCommand,
  prepareC360ProfileCommand,
  reconcileC360ProfileCommand,
  type C360CommandActor,
  type C360CommandAuthorization,
  type C360ProfileCommandInput,
  type C360ProfileEffect,
} from './profile-command.js';

/**
 * Cus360 C1 (#791) S2: command engine บน PostgreSQL จริงด้วย application role —
 * crash ก่อน/หลัง effect/commit, concurrent same/different payload, no-op/stale revision,
 * reconcile-vs-late POST และ tombstone ตาม E1 B
 */
const owner = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
const app = new PrismaClient({
  datasources: { db: { url: process.env.APPLICATION_DATABASE_URL } },
});
test.after(async () => {
  await Promise.all([owner.$disconnect(), app.$disconnect()]);
});

async function fixture() {
  const tenantId = randomUUID();
  const userId = randomUUID();
  const contactId = randomUUID();
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: 'C1 command',
      slug: `c1-cmd-${tenantId}`,
      sipDomain: `${tenantId}.cmd.test`,
    },
  });
  await owner.user.create({
    data: {
      id: userId,
      tenantId,
      role: 'ADMIN',
      email: `${userId}@cmd.test`,
      displayName: 'C1 admin',
      passwordHash: '!test-only',
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'ลูกค้าทดสอบ' } });
  const actor: C360CommandActor = {
    tenantId,
    actorUserId: userId,
    actorIdentityKey: c360ActorIdentityKey({
      issuer: 'https://idp.test/realms/c1',
      subject: userId,
      tenantId,
      userId,
    }),
  };
  let authorizeCalls = 0;
  const authorization: C360CommandAuthorization = {
    authorize: async (tx) => {
      authorizeCalls += 1;
      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user?.isActive || user.role !== 'ADMIN') throw new Error('ACCESS_DENIED');
    },
  };
  return {
    tenantId,
    userId,
    contactId,
    actor,
    authorization,
    authorizeCalls: () => authorizeCalls,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function companyCommand(
  f: Fixture,
  company: string | null,
  expected = '0',
  commandId: string = randomUUID(),
) {
  return {
    commandId,
    action: 'PROFILE_UPDATE',
    resourceType: 'CONTACT',
    resourceId: f.contactId,
    expectedRevisions: { profile: expected },
    normalizationContractVersion: 'cus360-v1',
    normalizedRequest: { company },
  } satisfies C360ProfileCommandInput;
}

/** effect ตัวอย่าง: แก้ company แบบ CAS กับ profileRevision ใต้ row lock ของ contact */
function updateCompany(f: Fixture, company: string | null, onEffect?: () => void) {
  return async (
    tx: Prisma.TransactionClient,
    command: { expectedRevisions: Record<string, string> },
  ): Promise<C360ProfileEffect> => {
    const [row] = await tx.$queryRaw<{ company: string | null; profile_revision: bigint }[]>`
      SELECT company, profile_revision FROM contacts WHERE id = ${f.contactId}::uuid FOR NO KEY UPDATE NOWAIT`;
    if (!row) throw new C360ProfileCommandRejection('RESOURCE_NOT_FOUND', 404);
    if (`${row.profile_revision}` !== command.expectedRevisions.profile)
      throw new C360ProfileCommandRejection('PROFILE_REVISION_CONFLICT', 409);
    const before = `${row.profile_revision}`;
    if (row.company === company)
      return {
        outcome: 'NO_OP',
        committedRevisions: { profile: before },
        resourceRefs: [{ type: 'CONTACT', id: f.contactId }],
      };
    const after = `${row.profile_revision + 1n}`;
    await tx.contact.update({
      where: { id: f.contactId },
      data: { company, profileRevision: BigInt(after) },
    });
    onEffect?.();
    return {
      outcome: 'APPLIED',
      httpStatus: 200,
      committedRevisions: { profile: after },
      resourceRefs: [{ type: 'CONTACT', id: f.contactId }],
      audits: [
        {
          operation: 'PROFILE_UPDATE',
          resourceType: 'CONTACT',
          resourceId: f.contactId,
          changedFields: ['company'],
          beforeRevisions: { profile: before },
          afterRevisions: { profile: after },
        },
      ],
    };
  };
}

async function state(f: Fixture, commandId: string) {
  const key = { tenantId: f.tenantId, actorIdentityKey: f.actor.actorIdentityKey, commandId };
  const [contact, command, receipt, audits] = await Promise.all([
    owner.contact.findUniqueOrThrow({ where: { id: f.contactId } }),
    owner.c360ProfileCommand.findUnique({ where: { tenantId_actorIdentityKey_commandId: key } }),
    owner.c360ProfileCommandReceipt.findUnique({
      where: { tenantId_actorIdentityKey_commandId: key },
    }),
    owner.c360ProfileAudit.count({ where: key }),
  ]);
  return { contact, command, receipt, audits };
}

function barrier() {
  let release!: () => void;
  let reached!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  return {
    wait: async () => {
      reached();
      await released;
    },
    arrived,
    release,
  };
}

test('S2: digest เป็น canonical และ actor key ไม่ผูกกับ session/token', () => {
  const base = {
    commandId: randomUUID(),
    action: 'PROFILE_UPDATE',
    resourceType: 'CONTACT',
    resourceId: randomUUID(),
    expectedRevisions: { profile: '1', tag: '0' },
    normalizationContractVersion: 'cus360-v1',
    normalizedRequest: { company: 'A', displayName: 'B' },
  };
  const reordered = prepareC360ProfileCommand({
    ...base,
    expectedRevisions: { tag: '0', profile: '1' },
    normalizedRequest: { displayName: 'B', company: 'A' },
  });
  assert.equal(prepareC360ProfileCommand(base).payloadDigest, reordered.payloadDigest);
  for (const changed of [
    { expectedRevisions: { profile: '2', tag: '0' } },
    { normalizedRequest: { company: 'A ', displayName: 'B' } },
    { normalizationContractVersion: 'cus360-v2' },
    { action: 'PROFILE_CREATE' },
  ])
    assert.notEqual(
      prepareC360ProfileCommand({ ...base, ...changed }).payloadDigest,
      reordered.payloadDigest,
    );
  for (const invalid of [
    { commandId: 'not-a-uuid' },
    { expectedRevisions: { profile: '01' } },
    { expectedRevisions: { profile: '9223372036854775808' } },
    { expectedRevisions: { profile: 1 as unknown as string } },
    { normalizedRequest: { at: new Date() } },
    { normalizedRequest: { n: Number.NaN } },
  ])
    assert.throws(
      () => prepareC360ProfileCommand({ ...base, ...invalid }),
      C360ProfileCommandError,
    );

  const tenantId = randomUUID();
  const userId = randomUUID();
  const identity = { issuer: 'https://idp.test/realms/c1', subject: 'sub-1', tenantId, userId };
  assert.equal(c360ActorIdentityKey(identity), c360ActorIdentityKey({ ...identity }));
  assert.notEqual(
    c360ActorIdentityKey(identity),
    c360ActorIdentityKey({ ...identity, subject: 'sub-2' }),
  );
  assert.notEqual(
    c360ActorIdentityKey(identity),
    c360ActorIdentityKey({ ...identity, userId: null }),
  );
  assert.match(c360ActorIdentityKey(identity), /^[0-9a-f]{64}$/);
});

test('S2: APPLIED เขียน effect+audit+receipt atomic, replay คืน receipt เดิมไม่มี effect ซ้ำ และ receipt ไม่มี PII', async () => {
  const f = await fixture();
  const input = companyCommand(f, 'บริษัท ตัวอย่าง จำกัด');
  let effects = 0;
  const first = await executeC360ProfileCommand(
    app,
    f.actor,
    input,
    f.authorization,
    updateCompany(f, 'บริษัท ตัวอย่าง จำกัด', () => (effects += 1)),
  );
  assert.equal(first.state, 'TERMINAL');
  assert.equal(first.status, 200);
  if (first.state !== 'TERMINAL') return;
  assert.equal(first.receipt.outcome, 'APPLIED');
  assert.deepEqual(first.receipt.committedRevisions, { profile: '1' });
  assert.equal(first.receipt.readbackRequired, true);

  const replay = await executeC360ProfileCommand(
    app,
    f.actor,
    input,
    f.authorization,
    updateCompany(f, 'บริษัท ตัวอย่าง จำกัด', () => (effects += 1)),
  );
  assert.deepEqual(replay, first);
  assert.equal(effects, 1);
  const after = await state(f, input.commandId);
  assert.equal(after.contact.company, 'บริษัท ตัวอย่าง จำกัด');
  assert.equal(after.contact.profileRevision, 1n);
  assert.equal(after.audits, 1);
  assert.equal(after.command?.isTombstone, false);
  // receipt/command ไม่มี payload หรือค่า PII ที่แก้
  const stored = JSON.stringify({ command: after.command, receipt: after.receipt }, (_, value) =>
    typeof value === 'bigint' ? `${value}` : value,
  );
  assert.equal(stored.includes('บริษัท'), false);
  assert.equal(stored.includes('ลูกค้าทดสอบ'), false);
  assert.ok(f.authorizeCalls() >= 4, 'authorize ต้องถูกเรียกในทุก transaction');
});

test('S2: command เดิม payload ต่างได้ COMMAND_PAYLOAD_MISMATCH และไม่มี effect', async () => {
  const f = await fixture();
  const commandId = randomUUID();
  await executeC360ProfileCommand(
    app,
    f.actor,
    companyCommand(f, 'A', '0', commandId),
    f.authorization,
    updateCompany(f, 'A'),
  );
  await assert.rejects(
    executeC360ProfileCommand(
      app,
      f.actor,
      companyCommand(f, 'B', '0', commandId),
      f.authorization,
      updateCompany(f, 'B'),
    ),
    (error) =>
      error instanceof C360ProfileCommandError &&
      error.code === 'COMMAND_PAYLOAD_MISMATCH' &&
      error.httpStatus === 409,
  );
  const after = await state(f, commandId);
  assert.equal(after.contact.company, 'A');
  assert.equal(after.audits, 1);
});

test('S2: NO_OP หลัง revision ตรงมี receipt แต่ไม่เพิ่ม revision/audit; stale revision ได้ REJECTED และ rollback effect', async () => {
  const f = await fixture();
  await owner.contact.update({
    where: { id: f.contactId },
    data: { company: 'A', profileRevision: 3n },
  });
  const noop = companyCommand(f, 'A', '3');
  const noopResult = await executeC360ProfileCommand(
    app,
    f.actor,
    noop,
    f.authorization,
    updateCompany(f, 'A'),
  );
  assert.equal(noopResult.state === 'TERMINAL' && noopResult.receipt.outcome, 'NO_OP');
  let after = await state(f, noop.commandId);
  assert.equal(after.contact.profileRevision, 3n);
  assert.equal(after.audits, 0);

  const stale = companyCommand(f, 'B', '2');
  const rejected = await executeC360ProfileCommand(
    app,
    f.actor,
    stale,
    f.authorization,
    async (tx, command) => {
      // เขียนก่อนแล้วจึงปฏิเสธ เพื่อพิสูจน์ว่า savepoint คืนค่า effect ที่ทำไปแล้ว
      await tx.contact.update({ where: { id: f.contactId }, data: { company: 'leaked' } });
      return updateCompany(f, 'B')(tx, command);
    },
  );
  assert.equal(rejected.status, 409);
  assert.equal(rejected.state === 'TERMINAL' && rejected.receipt.code, 'PROFILE_REVISION_CONFLICT');
  assert.equal(rejected.state === 'TERMINAL' && rejected.receipt.readbackRequired, false);
  after = await state(f, stale.commandId);
  assert.equal(after.contact.company, 'A');
  assert.equal(after.receipt?.outcome, 'REJECTED');
  assert.equal(after.audits, 0);
});

test('S2: crash ก่อน commit → PENDING, reconcile ปิดเป็น NOT_APPLIED และ late POST ไม่ execute', async () => {
  const f = await fixture();
  const input = companyCommand(f, 'A');
  await assert.rejects(
    executeC360ProfileCommand(app, f.actor, input, f.authorization, updateCompany(f, 'A'), {
      afterEffect: async () => {
        throw new Error('process crashed before commit');
      },
    }),
    /process crashed/,
  );
  let after = await state(f, input.commandId);
  assert.equal(after.contact.company, null);
  assert.ok(after.command, 'admission ต้องคงอยู่');
  assert.equal(after.receipt, null);
  assert.deepEqual(await lookupC360ProfileCommand(app, f.actor, input.commandId, f.authorization), {
    status: 202,
    state: 'PENDING',
    commandId: input.commandId,
  });

  const reconciled = await reconcileC360ProfileCommand(
    app,
    f.actor,
    input.commandId,
    {},
    f.authorization,
  );
  assert.equal(reconciled.state === 'TERMINAL' && reconciled.receipt.code, 'COMMAND_NOT_APPLIED');
  let effects = 0;
  const late = await executeC360ProfileCommand(
    app,
    f.actor,
    input,
    f.authorization,
    updateCompany(f, 'A', () => (effects += 1)),
  );
  assert.deepEqual(late, reconciled);
  assert.equal(effects, 0);
  after = await state(f, input.commandId);
  assert.equal(after.contact.company, null);
  assert.equal(after.command?.isTombstone, false);
});

test('S2: crash หลัง commit ก่อนตอบ → receipt APPLIED อยู่แล้ว retry/reconcile ไม่ทำซ้ำ', async () => {
  const f = await fixture();
  const input = companyCommand(f, 'A');
  await assert.rejects(
    executeC360ProfileCommand(app, f.actor, input, f.authorization, updateCompany(f, 'A'), {
      afterCommit: async () => {
        throw new Error('response lost');
      },
    }),
    /response lost/,
  );
  const lookup = await lookupC360ProfileCommand(app, f.actor, input.commandId, f.authorization);
  assert.equal(lookup.state === 'TERMINAL' && lookup.receipt.outcome, 'APPLIED');
  const reconciled = await reconcileC360ProfileCommand(
    app,
    f.actor,
    input.commandId,
    {},
    f.authorization,
  );
  assert.deepEqual(reconciled, lookup);
  let effects = 0;
  await executeC360ProfileCommand(
    app,
    f.actor,
    input,
    f.authorization,
    updateCompany(f, 'A', () => (effects += 1)),
  );
  assert.equal(effects, 0);
  assert.equal((await state(f, input.commandId)).audits, 1);
});

test('S2: reconcile ก่อน POST สร้าง tombstone และ late POST ได้ NOT_APPLIED เดิม; ไม่พบคือ UNKNOWN', async () => {
  const f = await fixture();
  const commandId = randomUUID();
  assert.deepEqual(await lookupC360ProfileCommand(app, f.actor, commandId, f.authorization), {
    status: 404,
    state: 'UNKNOWN',
    commandId,
  });
  await assert.rejects(
    reconcileC360ProfileCommand(app, f.actor, commandId, { commandId }, f.authorization),
    (error) => error instanceof C360ProfileCommandError && error.code === 'INVALID_REQUEST',
  );
  const tomb = await reconcileC360ProfileCommand(app, f.actor, commandId, {}, f.authorization);
  assert.equal(tomb.status, 409);
  assert.equal(tomb.state === 'TERMINAL' && tomb.receipt.code, 'COMMAND_NOT_APPLIED');
  // payload ใด ๆ ก็ execute ไม่ได้อีก (tombstone ไม่มี digest จึงไม่เป็น mismatch)
  let effects = 0;
  const late = await executeC360ProfileCommand(
    app,
    f.actor,
    companyCommand(f, 'A', '0', commandId),
    f.authorization,
    updateCompany(f, 'A', () => (effects += 1)),
  );
  assert.deepEqual(late, tomb);
  assert.equal(effects, 0);
  const after = await state(f, commandId);
  assert.equal(after.command?.isTombstone, true);
  assert.equal(after.contact.company, null);
});

test('S2: reconcile ระหว่าง execute ถือ lock ได้ 202 PENDING และหลัง commit อ่านผล APPLIED โดยไม่ทับ', async () => {
  const f = await fixture();
  const input = companyCommand(f, 'A');
  const gate = barrier();
  const running = executeC360ProfileCommand(
    app,
    f.actor,
    input,
    f.authorization,
    updateCompany(f, 'A'),
    {
      afterCommandLock: gate.wait,
    },
  );
  await gate.arrived;
  assert.deepEqual(
    await reconcileC360ProfileCommand(app, f.actor, input.commandId, {}, f.authorization),
    {
      status: 202,
      state: 'PENDING',
      commandId: input.commandId,
    },
  );
  gate.release();
  const done = await running;
  assert.equal(done.state === 'TERMINAL' && done.receipt.outcome, 'APPLIED');
  assert.deepEqual(
    await reconcileC360ProfileCommand(app, f.actor, input.commandId, {}, f.authorization),
    done,
  );
});

test('S2: concurrent POST เดิม → effect ครั้งเดียว อีกฝ่ายได้ receipt เดิมหรือ RESOURCE_BUSY retryable', async () => {
  const f = await fixture();
  const input = companyCommand(f, 'A');
  let effects = 0;
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      executeC360ProfileCommand(
        app,
        f.actor,
        input,
        f.authorization,
        updateCompany(f, 'A', () => (effects += 1)),
      ),
    ),
  );
  assert.equal(effects, 1);
  for (const result of results) {
    if (result.status === 'fulfilled')
      assert.equal(result.value.state === 'TERMINAL' && result.value.receipt.outcome, 'APPLIED');
    else
      assert.ok(
        result.reason instanceof C360ProfileCommandError &&
          result.reason.code === 'RESOURCE_BUSY' &&
          result.reason.retryable,
        String(result.reason),
      );
  }
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  assert.equal((await state(f, input.commandId)).audits, 1);
});

test('S2: concurrent command ต่าง ID บน revision เดียวกัน → APPLIED หนึ่ง อีกฝ่าย REJECTED หรือ busy โดยไม่มี effect ซ้ำ', async () => {
  const f = await fixture();
  const first = companyCommand(f, 'A');
  const second = companyCommand(f, 'B');
  const gate = barrier();
  const running = executeC360ProfileCommand(
    app,
    f.actor,
    first,
    f.authorization,
    updateCompany(f, 'A'),
    {
      afterEffect: gate.wait,
    },
  );
  await gate.arrived;
  // ฝ่ายแรกถือ row lock ของ contact: NOWAIT ทำให้ฝ่ายที่สองได้ busy หลัง retry ไม่รอค้าง
  await assert.rejects(
    executeC360ProfileCommand(app, f.actor, second, f.authorization, updateCompany(f, 'B')),
    (error) =>
      error instanceof C360ProfileCommandError &&
      error.code === 'RESOURCE_BUSY' &&
      error.httpStatus === 503,
  );
  gate.release();
  await running;
  // ID เดิมของฝ่ายที่สองยังค้าง PENDING; retry ด้วย ID เดิมหลังฝ่ายแรก commit ต้องได้ revision conflict
  assert.equal(
    (await lookupC360ProfileCommand(app, f.actor, second.commandId, f.authorization)).state,
    'PENDING',
  );
  const retried = await executeC360ProfileCommand(
    app,
    f.actor,
    second,
    f.authorization,
    updateCompany(f, 'B'),
  );
  assert.equal(retried.state === 'TERMINAL' && retried.receipt.code, 'PROFILE_REVISION_CONFLICT');
  const after = await state(f, first.commandId);
  assert.equal(after.contact.company, 'A');
  assert.equal(after.contact.profileRevision, 1n);
});

test('S2: transaction ตั้ง lock_timeout/statement_timeout ตาม E1 G และหมดสิทธิ์ก่อน commit ไม่มี receipt', async () => {
  const f = await fixture();
  const seen: string[] = [];
  await executeC360ProfileCommand(
    app,
    f.actor,
    companyCommand(f, 'A'),
    f.authorization,
    async (tx, command) => {
      const [row] = await tx.$queryRaw<{ lock: string; statement: string }[]>`
      SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement`;
      seen.push(row!.lock, row!.statement);
      return updateCompany(f, 'A')(tx, command);
    },
  );
  assert.deepEqual(seen, ['250ms', '2s']);

  const input = companyCommand(f, 'B', '1');
  await assert.rejects(
    executeC360ProfileCommand(app, f.actor, input, f.authorization, updateCompany(f, 'B'), {
      // ผู้ใช้ถูก disable ระหว่าง effect: authorize ก่อน commit ต้องล้มทั้ง transaction
      afterEffect: async () => {
        await owner.user.update({ where: { id: f.userId }, data: { isActive: false } });
      },
    }),
    /ACCESS_DENIED/,
  );
  const after = await state(f, input.commandId);
  assert.equal(after.contact.company, 'A');
  assert.equal(after.receipt, null);
  await assert.rejects(
    lookupC360ProfileCommand(app, f.actor, input.commandId, f.authorization),
    /ACCESS_DENIED/,
  );
});

test('S2: receipt ซ่อน resource refs ที่ผู้อ่านปัจจุบันไม่มีสิทธิ์', async () => {
  const f = await fixture();
  const input = companyCommand(f, 'A');
  await executeC360ProfileCommand(app, f.actor, input, f.authorization, updateCompany(f, 'A'));
  const hidden = await lookupC360ProfileCommand(app, f.actor, input.commandId, {
    ...f.authorization,
    canReadRef: async () => false,
  });
  assert.equal(hidden.state, 'TERMINAL');
  if (hidden.state !== 'TERMINAL') return;
  assert.deepEqual(hidden.receipt.resourceRefs, []);
  assert.equal(hidden.receipt.resourceId, null);
  // tenant อื่นมองไม่เห็น command นี้ผ่าน RLS
  const outsiders = await withTenantDatabaseTransaction(app, randomUUID(), (tx) =>
    tx.c360ProfileCommand.count({ where: { commandId: input.commandId } }),
  );
  assert.equal(outsiders, 0);
});
