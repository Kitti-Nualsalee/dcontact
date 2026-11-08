import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';
import { createC360CursorCodec, reconcileC360ProfileCommand } from '@d-contact/customer-360';
import {
  commandActor,
  commandAuthorization,
  type C360RequestIdentity,
} from './customer-360-api.js';
import { admitC360Import, updateC360ImportMapping } from './customer-360-import-intake.js';
import { C360ImportObjectStorage } from './customer-360-import-storage.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { readC360ImportPreview } from './customer-360-import-preview.js';
import { grantCustodian, ownerCommit, setup, type Fixture } from './customer-360-test-fixtures.js';

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

test('M2 mapping: เฉพาะเจ้าของ job; revision conflict และ replay ไม่มี raw cells ใน receipt', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  await permit(f);
  const actor = identity(f, 'admin');
  const files = new Map<string, Buffer>();
  let storageDown = false;
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        if (command instanceof PutObjectCommand) {
          files.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array));
          return {};
        }
        if (command instanceof GetObjectCommand)
          if (storageDown) throw Error('storage unavailable');
          else return { Body: Readable.from([files.get(command.input.Key!)!]) };
        throw Error('unexpected');
      },
    },
    'isolated',
  );
  const upload = await admitC360Import({
    db: f.db,
    storage,
    identity: actor,
    commandId: randomUUID(),
    bytes: Buffer.from('name,email\nsecret-name,secret@example.test'),
  });
  assert.equal(upload.state, 'TERMINAL');
  if (upload.state !== 'TERMINAL') throw Error('expected terminal');
  const jobId = upload.receipt.resourceRefs[0]!.id;
  const mapping = { version: 1, columns: { displayName: 'name', email: 'email' } };
  const commandId = randomUUID();
  const input = {
    db: f.db,
    storage,
    identity: actor,
    jobId,
    commandId,
    expectedRevision: '0',
    mapping,
  };
  const result = await updateC360ImportMapping(input);
  assert.equal(result.state, 'TERMINAL');
  if (result.state !== 'TERMINAL') throw Error('expected terminal');
  assert.equal(result.receipt.committedRevisions.job, '1');
  assert.doesNotMatch(JSON.stringify(result), /secret-name|secret@example/);
  assert.deepEqual(await updateC360ImportMapping(input), result);
  const conflict = await updateC360ImportMapping({ ...input, commandId: randomUUID() });
  assert.equal(conflict.state, 'TERMINAL');
  if (conflict.state !== 'TERMINAL') throw Error('expected terminal');
  assert.equal(conflict.receipt.code, 'JOB_REVISION_CONFLICT');
  await assert.rejects(
    updateC360ImportMapping({
      ...input,
      commandId: randomUUID(),
      identity: identity(f, 'admin-two'),
    }),
    { code: 'CUSTOMER_ACCESS_DENIED' },
  );
  await assert.rejects(
    updateC360ImportMapping({
      ...input,
      commandId: randomUUID(),
      mapping: { version: 1, columns: { displayName: 'missing' } },
    }),
    { code: 'MAPPING_INVALID' },
  );
  const other = identity(f, 'admin-two');
  const grant = await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-M2-OTHER',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: other.userId,
      capability: 'CONTACT_CREATE',
    },
  });
  assert.equal(grant.status, 201);
  await assert.rejects(
    updateC360ImportMapping({ ...input, commandId: randomUUID(), identity: other }),
    { status: 404, code: 'RESOURCE_NOT_FOUND' },
  );
  await assert.rejects(
    updateC360ImportMapping({ ...input, commandId: randomUUID(), jobId: randomUUID() }),
    { status: 404, code: 'RESOURCE_NOT_FOUND' },
  );
  const foreign = identity(f, 'foreign');
  const foreignCommand = randomUUID();
  await f.owner.c360ProfileCommand.create({
    data: {
      tenantId: foreign.tenantId,
      actorIdentityKey: 'fixture-operator',
      commandId: foreignCommand,
      action: 'CAPABILITY_GRANT',
      resourceType: 'USER',
      resourceId: foreign.userId,
      payloadDigest: 'a'.repeat(64),
      normalizationContractVersion: 'fixture',
    },
  });
  await f.owner.c360ActorCapabilityGrant.create({
    data: {
      id: randomUUID(),
      tenantId: foreign.tenantId,
      granteeUserId: foreign.userId,
      capability: 'CONTACT_CREATE',
      evidenceRef: 'fixture',
      actorIdentityKey: 'fixture-operator',
      commandId: foreignCommand,
    },
  });
  await assert.rejects(
    updateC360ImportMapping({ ...input, commandId: randomUUID(), identity: foreign }),
    { status: 404, code: 'RESOURCE_NOT_FOUND' },
  );

  await f.owner.c360ImportJob.update({
    where: { tenantId_id: { tenantId: f.tenantId, id: jobId } },
    data: { sourceExpiresAt: new Date(Date.now() - 1000), state: 'EXPIRED' },
  });
  storageDown = true;
  assert.deepEqual(await updateC360ImportMapping(input), result);
  await assert.rejects(
    updateC360ImportMapping({
      ...input,
      mapping: { version: 1, columns: { displayName: 'different' } },
    }),
    { code: 'COMMAND_PAYLOAD_MISMATCH' },
  );
  await assert.rejects(updateC360ImportMapping({ ...input, commandId: randomUUID() }), {
    status: 410,
    code: 'SOURCE_EXPIRED',
  });
});

test('M2 mapping: source หมดอายุระหว่าง effect และ receipt ต้อง rollback', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  await permit(f);
  const actor = identity(f, 'admin');
  const files = new Map<string, Buffer>();
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        if (command instanceof PutObjectCommand) {
          files.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array));
          return {};
        }
        if (command instanceof GetObjectCommand)
          return { Body: Readable.from([files.get(command.input.Key!)!]) };
        throw Error('unexpected');
      },
    },
    'isolated',
  );
  const upload = await admitC360Import({
    db: f.db,
    storage,
    identity: actor,
    commandId: randomUUID(),
    bytes: Buffer.from('name\nfixture'),
  });
  assert.equal(upload.state, 'TERMINAL');
  if (upload.state !== 'TERMINAL') throw Error('expected terminal');
  const jobId = upload.receipt.resourceRefs[0]!.id;
  const commandId = randomUUID();
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION c360_test_delay_mapping_837() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'IMPORT_MAPPING' THEN PERFORM pg_sleep(0.8); END IF; RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER c360_test_delay_mapping_837 BEFORE INSERT ON c360_import_control_audits FOR EACH ROW EXECUTE FUNCTION c360_test_delay_mapping_837()`,
  );
  t.after(async () => {
    await f.owner.$executeRawUnsafe(
      'DROP TRIGGER IF EXISTS c360_test_delay_mapping_837 ON c360_import_control_audits',
    );
    await f.owner.$executeRawUnsafe('DROP FUNCTION IF EXISTS c360_test_delay_mapping_837()');
  });
  await f.owner
    .$executeRaw`UPDATE c360_import_jobs SET source_expires_at=clock_timestamp()+interval '500 milliseconds' WHERE tenant_id=${f.tenantId}::uuid AND id=${jobId}::uuid`;
  await assert.rejects(
    updateC360ImportMapping({
      db: f.db,
      storage,
      identity: actor,
      jobId,
      commandId,
      expectedRevision: '0',
      mapping: { version: 1, columns: { displayName: 'name' } },
    }),
    { code: 'SOURCE_EXPIRED', status: 410 },
  );
  const job = await f.owner.c360ImportJob.findUniqueOrThrow({
    where: { tenantId_id: { tenantId: f.tenantId, id: jobId } },
  });
  assert.equal(job.revision, 0n);
  assert.equal(job.mapping, null);
  assert.equal(
    await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId, commandId } }),
    1,
  );
  assert.equal(
    await f.owner.c360ProfileCommandReceipt.count({ where: { tenantId: f.tenantId, commandId } }),
    0,
  );
  assert.equal(
    await f.owner.c360ImportControlAudit.count({ where: { tenantId: f.tenantId, commandId } }),
    0,
  );
});

test('M2 mapping: source หมดอายุระหว่าง storage failure ตอบ SOURCE_EXPIRED หลังตรวจสิทธิ์ซ้ำ', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  await permit(f);
  const actor = identity(f, 'admin');
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
        if (command instanceof PutObjectCommand) return {};
        if (command instanceof GetObjectCommand) {
          reached();
          await waiting;
          throw Error('storage unavailable');
        }
        throw Error('unexpected');
      },
    },
    'isolated',
  );
  const upload = await admitC360Import({
    db: f.db,
    storage,
    identity: actor,
    commandId: randomUUID(),
    bytes: Buffer.from('name\nfixture'),
  });
  if (upload.state !== 'TERMINAL') throw Error('expected terminal');
  const jobId = upload.receipt.resourceRefs[0]!.id;
  const pending = updateC360ImportMapping({
    db: f.db,
    storage,
    identity: actor,
    jobId,
    commandId: randomUUID(),
    expectedRevision: '0',
    mapping: { version: 1, columns: { displayName: 'name' } },
  });
  try {
    await Promise.race([
      started,
      pending.then(() => {
        throw Error('storage barrier not reached');
      }),
    ]);
    await f.owner.c360ImportJob.update({
      where: { tenantId_id: { tenantId: f.tenantId, id: jobId } },
      data: { sourceExpiresAt: new Date(Date.now() - 1000) },
    });
  } finally {
    release();
  }
  await assert.rejects(pending, { status: 410, code: 'SOURCE_EXPIRED' });
});

test('M2 preview: อ่านแบบแบ่งหน้าเฉพาะ owner โดยไม่มี Contact side effect และ cursor เดิมใช้ไม่ได้หลังเปลี่ยน mapping', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  await permit(f);
  const actor = identity(f, 'admin');
  const files = new Map<string, Buffer>();
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        if (command instanceof PutObjectCommand) {
          files.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array));
          return {};
        }
        if (command instanceof GetObjectCommand)
          return { Body: Readable.from([files.get(command.input.Key!)!]) };
        throw Error('unexpected');
      },
    },
    'isolated',
  );
  const csv = `name,email\n${Array.from({ length: 22 }, (_, i) => `name${i},person${i}@example.test`).join('\n')}`;
  const upload = await admitC360Import({
    db: f.db,
    storage,
    identity: actor,
    commandId: randomUUID(),
    bytes: Buffer.from(csv),
  });
  if (upload.state !== 'TERMINAL') throw Error('expected terminal');
  const jobId = upload.receipt.resourceRefs[0]!.id;
  const mapping = { version: 1, columns: { displayName: 'name', email: 'email' } };
  await updateC360ImportMapping({
    db: f.db,
    storage,
    identity: actor,
    jobId,
    commandId: randomUUID(),
    expectedRevision: '0',
    mapping,
  });
  const count = await f.owner.contact.count({ where: { tenantId: f.tenantId } });
  const codec = createC360CursorCodec([{ id: 'test', key: Buffer.alloc(32, 7) }]);
  const first = await readC360ImportPreview({ db: f.db, storage, identity: actor, codec, jobId });
  assert.equal(first.rows.length, 20);
  assert.deepEqual(first.counts, { valid: 22, invalid: 0, warning: 0 });
  assert.ok(first.nextCursor);
  const second = await readC360ImportPreview({
    db: f.db,
    storage,
    identity: actor,
    codec,
    jobId,
    previewRef: first.previewRef,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.rows.map((row) => row.rowNo),
    [21, 22],
  );
  assert.equal(second.nextCursor, null);
  assert.equal(await f.owner.contact.count({ where: { tenantId: f.tenantId } }), count);
  // สิทธิ์ VIEW เปลี่ยนแม้ไม่มี duplicate warning ใหม่ ต้องไม่ใช้ cursor เดิม
  await assert.rejects(
    readC360ImportPreview({
      db: f.db,
      storage,
      identity: actor,
      codec,
      jobId,
      hooks: {
        async afterInitialFingerprint() {
          await grantCustodian(f, 'admin', 'READ');
        },
      },
    }),
    { code: 'SCOPE_UNAVAILABLE' },
  );
  await assert.rejects(
    readC360ImportPreview({
      db: f.db,
      storage,
      identity: actor,
      codec,
      jobId,
      previewRef: first.previewRef,
      cursor: first.nextCursor,
    }),
    { code: 'CURSOR_CONTEXT_CHANGED' },
  );
  await assert.rejects(
    readC360ImportPreview({ db: f.db, storage, identity: identity(f, 'admin-two'), codec, jobId }),
    { code: 'CUSTOMER_ACCESS_DENIED' },
  );
  await updateC360ImportMapping({
    db: f.db,
    storage,
    identity: actor,
    jobId,
    commandId: randomUUID(),
    expectedRevision: '1',
    mapping: { version: 1, columns: { displayName: 'name' } },
  });
  await assert.rejects(
    readC360ImportPreview({
      db: f.db,
      storage,
      identity: actor,
      codec,
      jobId,
      previewRef: first.previewRef,
      cursor: first.nextCursor,
    }),
  );
});

test('M2 preview: แถว invalid ทั้งหมดก็ต้องตรวจ scope ที่ยัง stale', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  await permit(f);
  const actor = identity(f, 'admin');
  const files = new Map<string, Buffer>();
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        if (command instanceof PutObjectCommand) {
          files.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array));
          return {};
        }
        if (command instanceof GetObjectCommand)
          return { Body: Readable.from([files.get(command.input.Key!)!]) };
        throw Error('unexpected');
      },
    },
    'isolated',
  );
  const upload = await admitC360Import({
    db: f.db,
    storage,
    identity: actor,
    commandId: randomUUID(),
    bytes: Buffer.from('name\n""'),
  });
  if (upload.state !== 'TERMINAL') throw Error('expected terminal');
  const jobId = upload.receipt.resourceRefs[0]!.id;
  await updateC360ImportMapping({
    db: f.db,
    storage,
    identity: actor,
    jobId,
    commandId: randomUUID(),
    expectedRevision: '0',
    mapping: { version: 1, columns: { displayName: 'name' } },
  });
  const codec = createC360CursorCodec([{ id: 'test', key: Buffer.alloc(32, 7) }]);
  const before = await readC360ImportPreview({ db: f.db, storage, identity: actor, codec, jobId });
  assert.deepEqual(before.counts, { valid: 0, invalid: 1, warning: 0 });
  await f.scopes.grant({
    tenantId: f.tenantId,
    teamId: f.teamId,
    segmentId: f.segmentId,
    permission: 'VIEW',
    correlationId: 'm2-preview-test',
  });
  await ownerCommit(f, 'GOLD');
  await assert.rejects(
    readC360ImportPreview({ db: f.db, storage, identity: actor, codec, jobId }),
    { code: 'SCOPE_UNAVAILABLE' },
  );
});

test('M2 preview: source หมดอายุหลัง scope fingerprint ต้องไม่คืน raw rows', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  await permit(f);
  const actor = identity(f, 'admin');
  const files = new Map<string, Buffer>();
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        if (command instanceof PutObjectCommand) {
          files.set(command.input.Key!, Buffer.from(command.input.Body as Uint8Array));
          return {};
        }
        if (command instanceof GetObjectCommand)
          return { Body: Readable.from([files.get(command.input.Key!)!]) };
        throw Error('unexpected');
      },
    },
    'isolated',
  );
  const upload = await admitC360Import({
    db: f.db,
    storage,
    identity: actor,
    commandId: randomUUID(),
    bytes: Buffer.from('name\nprivate-row'),
  });
  if (upload.state !== 'TERMINAL') throw Error('expected terminal');
  const jobId = upload.receipt.resourceRefs[0]!.id;
  await updateC360ImportMapping({
    db: f.db,
    storage,
    identity: actor,
    jobId,
    commandId: randomUUID(),
    expectedRevision: '0',
    mapping: { version: 1, columns: { displayName: 'name' } },
  });
  await f.owner
    .$executeRaw`UPDATE c360_import_jobs SET source_expires_at=clock_timestamp()+interval '2 seconds' WHERE tenant_id=${f.tenantId}::uuid AND id=${jobId}::uuid`;
  const codec = createC360CursorCodec([{ id: 'test', key: Buffer.alloc(32, 7) }]);
  let reached = false;
  await assert.rejects(
    readC360ImportPreview({
      db: f.db,
      storage,
      identity: actor,
      codec,
      jobId,
      hooks: {
        async beforeFinalClock() {
          reached = true;
          await new Promise((resolve) => setTimeout(resolve, 2200));
        },
      },
    }),
    { code: 'SOURCE_EXPIRED', status: 410 },
  );
  assert.ok(reached, 'expiry ต้องเกิดหลัง fingerprint');
});
