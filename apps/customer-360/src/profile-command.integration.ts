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
 * Cus360 C1 (#791) S2: command engine on real PostgreSQL with the application role —
 * crash before/after effect/commit, concurrent same/different payload, no-op/stale revision,
 * reconcile-vs-late POST and tombstone per E1 B
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
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'Test customer' } });
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

/** sample effect: edit company with CAS against profileRevision under the contact row lock */
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

test('S2: digest is canonical and the actor key is not bound to session/token', () => {
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

test('S2: APPLIED writes effect+audit+receipt atomically, replay returns the original receipt with no duplicate effect, and the receipt holds no PII', async () => {
  const f = await fixture();
  const input = companyCommand(f, 'Example Company Ltd.');
  let effects = 0;
  const first = await executeC360ProfileCommand(
    app,
    f.actor,
    input,
    f.authorization,
    updateCompany(f, 'Example Company Ltd.', () => (effects += 1)),
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
    updateCompany(f, 'Example Company Ltd.', () => (effects += 1)),
  );
  assert.deepEqual(replay, first);
  assert.equal(effects, 1);
  const after = await state(f, input.commandId);
  assert.equal(after.contact.company, 'Example Company Ltd.');
  assert.equal(after.contact.profileRevision, 1n);
  assert.equal(after.audits, 1);
  assert.equal(after.command?.isTombstone, false);
  // receipt/command holds no payload or edited PII value
  const stored = JSON.stringify({ command: after.command, receipt: after.receipt }, (_, value) =>
    typeof value === 'bigint' ? `${value}` : value,
  );
  assert.equal(stored.includes('Example Company'), false);
  assert.equal(stored.includes('Test customer'), false);
  assert.ok(f.authorizeCalls() >= 4, 'authorize must be called in every transaction');
});

test('S2: the same command with a different payload gets COMMAND_PAYLOAD_MISMATCH and has no effect', async () => {
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

test('S2: NO_OP after a matching revision has a receipt but adds no revision/audit; a stale revision gets REJECTED and rolls back the effect', async () => {
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
      // write first and then reject, to prove the savepoint reverts the effect already made
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

test('S2: crash before commit → PENDING, reconcile closes it as NOT_APPLIED and a late POST does not execute', async () => {
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
  assert.ok(after.command, 'admission must persist');
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

test('S2: crash after commit before responding → the receipt is already APPLIED and retry/reconcile do not repeat it', async () => {
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

test('S2: reconcile before POST creates a tombstone and a late POST gets the original NOT_APPLIED; not found is UNKNOWN', async () => {
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
  // no payload can execute any more (a tombstone has no digest so it is not a mismatch)
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

test('S2: reconcile while execute holds the lock gets 202 PENDING and after commit reads the APPLIED result without overwriting', async () => {
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

test('S2: concurrent identical POST → one effect; the other side gets the original receipt or a retryable RESOURCE_BUSY', async () => {
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

test('S2: concurrent commands with different IDs on the same revision → one APPLIED, the other REJECTED or busy, with no duplicate effect', async () => {
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
  // the first side holds the contact row lock: NOWAIT makes the second side get busy after retries instead of waiting forever
  await assert.rejects(
    executeC360ProfileCommand(app, f.actor, second, f.authorization, updateCompany(f, 'B')),
    (error) =>
      error instanceof C360ProfileCommandError &&
      error.code === 'RESOURCE_BUSY' &&
      error.httpStatus === 503,
  );
  gate.release();
  await running;
  // the second side's original ID is still PENDING; retrying with that ID after the first side commits must get a revision conflict
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

test('S2: the transaction sets lock_timeout/statement_timeout per E1 G and losing permission before commit leaves no receipt', async () => {
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
      // the user is disabled during the effect: authorize before commit must fail the whole transaction
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

test('S2: the receipt hides resource refs the current reader has no permission for', async () => {
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
  // another tenant cannot see this command through RLS
  const outsiders = await withTenantDatabaseTransaction(app, randomUUID(), (tx) =>
    tx.c360ProfileCommand.count({ where: { commandId: input.commandId } }),
  );
  assert.equal(outsiders, 0);
});
