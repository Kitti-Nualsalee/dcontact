import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { reconcileC360ProfileCommand } from '@d-contact/customer-360';
import {
  commandActor,
  commandAuthorization,
  type C360RequestIdentity,
} from './customer-360-api.js';
import { admitC360Import } from './customer-360-import-intake.js';
import { C360ImportObjectStorage } from './customer-360-import-storage.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { setup, type Fixture } from './customer-360-test-fixtures.js';

function identity(f: Fixture, name: string): C360RequestIdentity {
  const actor = f.actors.get(name)!;
  return {
    tenantId: actor.tenantId,
    userId: actor.id,
    roles: [actor.role.toLowerCase()],
    caller: {
      issuer: 'https://core-idp.test/realms/dcontact',
      subject: actor.id,
      clientId: 'dcontact-console',
      tenantSlug: `core-${actor.tenantId}`,
    },
  };
}
async function permit(f: Fixture) {
  const result = await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-M2',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  assert.equal(result.status, 201);
}

test('M2 intake: capability, receipt/replay และ job ของ actor บน PostgreSQL/RLS', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  const actor = identity(f, 'admin');
  const id = randomUUID();
  let puts = 0;
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        assert.ok(command instanceof PutObjectCommand);
        puts++;
        return {};
      },
    },
    'isolated',
  );
  const payload = {
    db: f.db,
    storage,
    identity: actor,
    commandId: id,
    bytes: Buffer.from('name\nsecret-fixture'),
  };
  await assert.rejects(admitC360Import(payload), { code: 'CUSTOMER_ACCESS_DENIED' });
  assert.equal(puts, 0);
  await permit(f);
  const result = await admitC360Import(payload);
  assert.equal(result.state, 'TERMINAL');
  if (result.state !== 'TERMINAL') throw Error('expected terminal');
  assert.equal(result.receipt.outcome, 'APPLIED');
  const jobId = result.receipt.resourceRefs[0]?.id;
  assert.ok(jobId);
  assert.equal(result.receipt.resourceRefs[0]?.type, 'IMPORT_JOB');
  assert.doesNotMatch(JSON.stringify(result), /secret-fixture/);
  const job = await f.owner.c360ImportJob.findUniqueOrThrow({
    where: { tenantId_id: { tenantId: f.tenantId, id: jobId } },
  });
  assert.equal(job.ownerUserId, actor.userId);
  assert.equal(job.state, 'DRAFT');
  const readback = await f.request(`customer-360/commands/${id}`, 'admin');
  assert.equal(readback.status, 201);
  const receipt = readback.body as unknown as {
    command: { resourceId: string | null; resourceRefs: { type: string; id: string }[] };
  };
  assert.equal(receipt.command.resourceId, jobId);
  assert.deepEqual(receipt.command.resourceRefs, [{ type: 'IMPORT_JOB', id: jobId }]);
  const otherAdmin = await f.request(`customer-360/commands/${id}`, 'admin-two');
  assert.equal(otherAdmin.status, 404);
  assert.doesNotMatch(JSON.stringify(otherAdmin.body), new RegExp(jobId));
  assert.equal(puts, 1);
  assert.deepEqual(await admitC360Import(payload), result);
  assert.equal(puts, 1);
  await assert.rejects(admitC360Import({ ...payload, bytes: Buffer.from('name\nchanged') }), {
    code: 'COMMAND_PAYLOAD_MISMATCH',
  });
});

test('M2 intake: reconcile ที่ชนะ PUT ค้างไม่ให้ attach late object หรือสร้าง success receipt', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  await permit(f);
  const actor = identity(f, 'admin');
  const id = randomUUID();
  let release!: () => void, reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        assert.ok(command instanceof PutObjectCommand);
        reached();
        await waiting;
        return {};
      },
    },
    'isolated',
  );
  const pending = admitC360Import({
    db: f.db,
    storage,
    identity: actor,
    commandId: id,
    bytes: Buffer.from('name\nlate'),
  });
  await Promise.race([
    started,
    pending.then(() => {
      throw Error('PUT barrier not reached');
    }),
  ]);
  const reconciled = await reconcileC360ProfileCommand(
    f.db,
    commandActor(actor),
    id,
    {},
    commandAuthorization(actor),
  );
  assert.equal(reconciled.state, 'TERMINAL');
  if (reconciled.state !== 'TERMINAL') throw Error('expected terminal');
  assert.equal(reconciled.receipt.code, 'COMMAND_NOT_APPLIED');
  release();
  const result = await pending;
  assert.equal(result.state, 'TERMINAL');
  if (result.state !== 'TERMINAL') throw Error('expected terminal');
  assert.equal(result.receipt.code, 'COMMAND_NOT_APPLIED');
  const rows = await f.owner.c360ImportJob.findMany({
    where: { tenantId: f.tenantId, ownerUserId: actor.userId },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.sourceObjectId, null);
  assert.equal(
    (
      await f.owner.c360ImportUploadAttempt.findMany({
        where: { tenantId: f.tenantId, jobId: rows[0]!.id },
      })
    )[0]!.state,
    'UPLOADING',
  );
});

test('M2 intake: ถอนสิทธิ์ระหว่าง PUT ต้องไม่ attach หรือสร้าง success receipt', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  await permit(f);
  const actor = identity(f, 'admin');
  const commandId = randomUUID();
  let release!: () => void, reached!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        assert.ok(command instanceof PutObjectCommand);
        reached();
        await waiting;
        return {};
      },
    },
    'isolated',
  );
  const pending = admitC360Import({
    db: f.db,
    storage,
    identity: actor,
    commandId,
    bytes: Buffer.from('name\nlate'),
  });
  try {
    await Promise.race([
      started,
      pending.then(() => {
        throw Error('PUT barrier not reached');
      }),
    ]);
    await f.owner.user.update({ where: { id: actor.userId }, data: { isActive: false } });
  } finally {
    release();
  }
  await assert.rejects(pending, { code: 'CUSTOMER_ACCESS_DENIED' });
  const jobs = await f.owner.c360ImportJob.findMany({
    where: { tenantId: f.tenantId, ownerUserId: actor.userId },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.sourceObjectId, null);
  const receipts = await f.owner.c360ProfileCommandReceipt.findMany({
    where: { tenantId: f.tenantId, commandId },
  });
  assert.equal(receipts.length, 0);
});
