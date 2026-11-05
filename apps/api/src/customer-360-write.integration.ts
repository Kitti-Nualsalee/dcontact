import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertC360ContactPointRuntime } from '@d-contact/contact-points/runtime-manifest';
import { C360_PARSER_INTEGRITY, createC360WriteRuntime } from './customer-360-write-runtime.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { Customer360ReadController } from './customer-360-read-api.js';
import { setup } from './customer-360-test-fixtures.js';

test('production writer เปิดเฉพาะ release manifest ที่ตรง runtime, image และ lockfile', () => {
  const parser = assertC360ContactPointRuntime();
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  const release = {
    imageDigest,
    nodeVersion: parser.nodeVersion,
    icuVersion: process.versions.icu,
    unicodeVersion: process.versions.unicode,
    phoneMetadataSha256: parser.phoneMetadataSha256,
    normalizationVersions: parser.normalizationVersions,
    packageIntegrity: C360_PARSER_INTEGRITY,
  };
  const env = {
    NODE_ENV: 'production',
    C360_IMAGE_DIGEST: imageDigest,
    C360_WRITE_RELEASE_MANIFEST: JSON.stringify(release),
  };
  assert.equal(createC360WriteRuntime({ NODE_ENV: 'production' }).ready, false);
  assert.equal(createC360WriteRuntime(env).ready, true);
  assert.equal(
    createC360WriteRuntime({ ...env, C360_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}` }).ready,
    false,
  );
  assert.equal(
    createC360WriteRuntime({
      ...env,
      C360_WRITE_RELEASE_MANIFEST: JSON.stringify({ ...release, nodeVersion: 'v0' }),
    }).ready,
    false,
  );
  assert.equal(
    createC360WriteRuntime({
      ...env,
      C360_WRITE_RELEASE_MANIFEST: JSON.stringify({ ...release, packageIntegrity: {} }),
    }).ready,
    false,
  );
  const lock = readFileSync(resolve(__dirname, '../../../pnpm-lock.yaml'), 'utf8');
  for (const [name, integrity] of Object.entries(C360_PARSER_INTEGRITY)) {
    assert.ok(lock.includes(`  ${name}:\n    resolution: {integrity: ${integrity}}`), name);
  }
});

/** C4: public HTTP → current authorization → command/receipt → PostgreSQL RLS */
test('Admin สร้างลูกค้าได้เมื่อมี capability; creator อ่านกลับได้และ replay ไม่สร้างซ้ำ', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  const commandId = randomUUID();
  const payload = { commandId, displayName: '  ลูกค้าทดสอบ  ', company: '  บริษัทตัวอย่าง  ' };
  const denied = await f.request('customer-360/contacts', 'admin', payload);
  assert.equal(denied.status, 403);
  const grant = await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  assert.equal(grant.status, 201);
  const result = await f.request('customer-360/contacts', 'admin', payload);
  assert.equal(result.status, 201);
  const command = (
    result.body as unknown as {
      command: { outcome: string; resourceRefs: { type: string; id: string }[] };
    }
  ).command;
  assert.equal(command.outcome, 'APPLIED');
  const id = command.resourceRefs.find((ref) => ref.type === 'CONTACT')?.id;
  assert.ok(id);
  const profile = await f.request(`customer-360/contacts/${id}`, 'admin');
  assert.equal(profile.status, 200);
  const contact = (profile.body as unknown as { contact: { displayName: string; company: string } })
    .contact;
  assert.equal(contact.displayName, 'ลูกค้าทดสอบ');
  assert.equal(contact.company, 'บริษัทตัวอย่าง');
  assert.equal((await f.request(`customer-360/contacts/${id}`, 'admin-two')).status, 404);
  const replay = await f.request('customer-360/contacts', 'admin', payload);
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, result.body);
  assert.equal(await f.owner.contact.count({ where: { id, tenantId: f.tenantId } }), 1);
  assert.ok(!JSON.stringify(result.body).includes('ลูกค้าทดสอบ'), 'receipt ไม่มี snapshot PII');
});

test('สร้างลูกค้าพร้อมเบอร์และอีเมลแบบ atomic; ข้อมูลผิดไม่สร้าง contact หรือ receipt', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  const granted = await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  assert.equal(granted.status, 201);
  const invalidCommand = randomUUID();
  const before = await f.owner.contact.count({ where: { tenantId: f.tenantId } });
  const missingName = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: '  ',
  });
  assert.equal(missingName.status, 400);
  assert.deepEqual(
    (missingName.body as unknown as { error: { fieldErrors: unknown } }).error.fieldErrors,
    [{ field: 'displayName', code: 'FIELD_INVALID' }],
  );
  const invalid = await f.request('customer-360/contacts', 'admin', {
    commandId: invalidCommand,
    displayName: 'ข้อมูลไม่ถูก',
    points: [{ kind: 'PHONE', value: '123' }],
  });
  assert.equal(invalid.status, 400);
  assert.equal(await f.owner.contact.count({ where: { tenantId: f.tenantId } }), before);
  assert.equal(
    await f.owner.c360ProfileCommand.count({
      where: { tenantId: f.tenantId, commandId: invalidCommand },
    }),
    0,
  );
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'ลูกค้าพร้อมช่องทาง',
    vip: true,
    points: [
      { kind: 'PHONE', value: '+1 213 373 4253' },
      { kind: 'EMAIL', value: 'User+Tag@EXAMPLE.COM' },
    ],
  });
  assert.equal(created.status, 201);
  const command = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command;
  const id = command.resourceRefs.find((ref) => ref.type === 'CONTACT')?.id;
  assert.ok(id);
  const profile = await f.request(`customer-360/contacts/${id}`, 'admin');
  assert.equal(profile.status, 200);
  const data = profile.body as unknown as {
    contact: { vip: boolean };
    contactPoints: { kind: string; value: string }[];
  };
  assert.equal(data.contact.vip, true);
  assert.deepEqual(data.contactPoints.map((point) => point.kind).sort(), ['EMAIL', 'PHONE']);
  const points = await f.owner.c360ContactPoint.findMany({
    where: { tenantId: f.tenantId, contactId: id },
  });
  assert.deepEqual(points.map((point) => point.normalizedValue).sort(), [
    '+12133734253',
    'User+Tag@example.com',
  ]);
  assert.equal(
    await f.owner.contactIdentity.count({ where: { tenantId: f.tenantId, contactId: id } }),
    0,
  );
});

test('แก้โปรไฟล์ตรวจสิทธิ์และ revision: conflict ไม่ทับข้อมูล และ no-op ไม่เพิ่ม revision', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  const grant = await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  assert.equal(grant.status, 201);
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'ชื่อเดิม',
  });
  const refs = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command.resourceRefs;
  const id = refs.find((ref) => ref.type === 'CONTACT')?.id;
  assert.ok(id);
  const commandId = randomUUID();
  const update = {
    commandId,
    expectedProfileRevision: '0',
    expectedLineageRevision: '0',
    displayName: 'ชื่อใหม่',
    vip: true,
  };
  const changed = await f.request(`customer-360/contacts/${id}`, 'admin', update, 'PATCH');
  assert.equal(changed.status, 200);
  assert.equal(
    (changed.body as unknown as { command: { outcome: string } }).command.outcome,
    'APPLIED',
  );
  assert.deepEqual(
    (await f.request(`customer-360/contacts/${id}`, 'admin', update, 'PATCH')).body,
    changed.body,
  );
  const conflict = await f.request(
    `customer-360/contacts/${id}`,
    'admin',
    { ...update, commandId: randomUUID(), displayName: 'ห้ามทับ' },
    'PATCH',
  );
  assert.equal(conflict.status, 409);
  assert.equal(
    (conflict.body as unknown as { command: { code: string } }).command.code,
    'REVISION_CONFLICT',
  );
  const noop = await f.request(
    `customer-360/contacts/${id}`,
    'admin',
    { ...update, commandId: randomUUID(), expectedProfileRevision: '1' },
    'PATCH',
  );
  assert.equal(noop.status, 200);
  assert.equal((noop.body as unknown as { command: { outcome: string } }).command.outcome, 'NO_OP');
  assert.equal(
    (
      await f.request(
        `customer-360/contacts/${id}`,
        'admin-two',
        { ...update, commandId: randomUUID() },
        'PATCH',
      )
    ).status,
    404,
  );
  const profile = await f.request(`customer-360/contacts/${id}`, 'admin');
  const data = profile.body as unknown as {
    contact: { displayName: string; vip: boolean };
    revisions: { profile: string };
  };
  assert.equal(data.contact.displayName, 'ชื่อใหม่');
  assert.equal(data.contact.vip, true);
  assert.equal(data.revisions.profile, '1');
});

test('จัดการ contact points ผ่าน command เดิม: replace เก็บประวัติและใช้ revision ปัจจุบัน', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'ลูกค้าทดสอบ',
    points: [{ kind: 'PHONE', value: '+1 213 373 4253' }],
  });
  const refs = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command.resourceRefs;
  const id = refs.find((ref) => ref.type === 'CONTACT')?.id;
  assert.ok(id);
  const [oldPoint] = await f.owner.c360ContactPoint.findMany({
    where: { tenantId: f.tenantId, contactId: id },
  });
  assert.ok(oldPoint);
  const replace = await f.request(
    `customer-360/contacts/${id}/contact-points/${oldPoint.id}/replace`,
    'admin',
    {
      commandId: randomUUID(),
      expectedProfileRevision: '0',
      expectedLineageRevision: '0',
      kind: 'PHONE',
      value: '+44 20 7946 0018',
    },
  );
  assert.equal(replace.status, 200);
  const points = await f.owner.c360ContactPoint.findMany({
    where: { tenantId: f.tenantId, contactId: id },
    orderBy: { createdAt: 'asc' },
  });
  assert.deepEqual(
    points.map((point) => point.state),
    ['RETIRED', 'ACTIVE'],
  );
  assert.equal(points[1]!.normalizedValue, '+442079460018');
  assert.equal((await f.owner.contact.findUniqueOrThrow({ where: { id } })).profileRevision, 1n);
  assert.equal(
    await f.owner.contactIdentity.count({ where: { tenantId: f.tenantId, contactId: id } }),
    0,
  );
});

test('เพิ่มและยกเลิกช่องทางติดต่อด้วย revision และไม่สร้าง identity', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'ลูกค้าช่องทาง',
  });
  const refs = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command.resourceRefs;
  const id = refs.find((ref) => ref.type === 'CONTACT')?.id;
  assert.ok(id);
  const added = await f.request(`customer-360/contacts/${id}/contact-points`, 'admin', {
    commandId: randomUUID(),
    expectedProfileRevision: '0',
    expectedLineageRevision: '0',
    kind: 'EMAIL',
    value: 'User@EXAMPLE.COM',
  });
  assert.equal(added.status, 200);
  const [point] = await f.owner.c360ContactPoint.findMany({
    where: { tenantId: f.tenantId, contactId: id },
  });
  assert.ok(point);
  assert.equal(point.normalizedValue, 'User@example.com');
  const retired = await f.request(
    `customer-360/contacts/${id}/contact-points/${point.id}/retire`,
    'admin',
    {
      commandId: randomUUID(),
      expectedProfileRevision: '1',
      expectedLineageRevision: '0',
    },
  );
  assert.equal(retired.status, 200);
  assert.equal(
    (await f.owner.c360ContactPoint.findUniqueOrThrow({ where: { id: point.id } })).state,
    'RETIRED',
  );
  assert.equal((await f.owner.contact.findUniqueOrThrow({ where: { id } })).profileRevision, 2n);
  assert.equal(
    await f.owner.contactIdentity.count({ where: { tenantId: f.tenantId, contactId: id } }),
    0,
  );
});

test('tag selector ใช้ catalog ที่อนุมัติแล้ว; attach/detach ตรวจ revision และไม่ attach RETIRED', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  const op = (command: unknown) =>
    f.request('customer-360/operator/commands', 'operator', {
      commandId: randomUUID(),
      evidenceRef: 'ticket:TEST-C4',
      reasonCode: 'APPROVED_CUSTODIAN',
      command,
    });
  await op({
    action: 'CAPABILITY_GRANT',
    granteeUserId: f.actors.get('admin')!.id,
    capability: 'CONTACT_CREATE',
  });
  await op({ action: 'TAG_SEED', names: ['พิเศษ'] });
  const tag = await f.owner.c360Tag.findFirstOrThrow({
    where: { tenantId: f.tenantId, name: 'พิเศษ' },
  });
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'ลูกค้าแท็ก',
  });
  const refs = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command.resourceRefs;
  const id = refs.find((ref) => ref.type === 'CONTACT')?.id;
  assert.ok(id);
  const options = await f.request('customer-360/tags/options', 'admin');
  assert.equal(options.status, 200);
  const optionsBody = options.body as unknown as { items: { id: string }[] };
  assert.ok(optionsBody.items.some((item) => item.id === tag.id));
  const attached = await f.request(
    `customer-360/contacts/${id}/tags`,
    'admin',
    {
      commandId: randomUUID(),
      expectedTagRevision: '0',
      expectedLineageRevision: '0',
      attachTagIds: [tag.id],
      detachTagIds: [],
    },
    'PATCH',
  );
  assert.equal(attached.status, 200);
  const noop = await f.request(
    `customer-360/contacts/${id}/tags`,
    'admin',
    {
      commandId: randomUUID(),
      expectedTagRevision: '1',
      expectedLineageRevision: '0',
      attachTagIds: [tag.id],
      detachTagIds: [],
    },
    'PATCH',
  );
  assert.equal((noop.body as unknown as { command: { outcome: string } }).command.outcome, 'NO_OP');
  await f.owner.c360Tag.update({
    where: { id: tag.id },
    data: { state: 'RETIRED', retiredAt: new Date(), revision: { increment: 1 } },
  });
  const detached = await f.request(
    `customer-360/contacts/${id}/tags`,
    'admin',
    {
      commandId: randomUUID(),
      expectedTagRevision: '1',
      expectedLineageRevision: '0',
      attachTagIds: [],
      detachTagIds: [tag.id],
    },
    'PATCH',
  );
  assert.equal(detached.status, 200);
  const rejected = await f.request(
    `customer-360/contacts/${id}/tags`,
    'admin',
    {
      commandId: randomUUID(),
      expectedTagRevision: '2',
      expectedLineageRevision: '0',
      attachTagIds: [tag.id],
      detachTagIds: [],
    },
    'PATCH',
  );
  assert.equal(rejected.status, 409);
  assert.equal((await f.owner.contact.findUniqueOrThrow({ where: { id } })).tagRevision, 2n);
});

test('receipt มี budget แยก; Redis ล่มกู้เฉพาะ receipt ที่ commit แล้วโดยไม่สร้าง tombstone', async (t) => {
  let receiptMode: 'normal' | 'limited' | 'down' = 'normal';
  const limiter: import('./shared-rate-limiter.js').SharedRateLimiter = {
    async consume({ policy }) {
      if (policy.name !== 'c360-receipt-v1' || receiptMode === 'normal') return null;
      if (receiptMode === 'limited') return { retryAfterSeconds: 7 };
      throw new Error('Redis unavailable');
    },
  };
  const f = await setup([Customer360OperatorController, Customer360ReadController], limiter);
  t.after(() => f.close());
  await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  const commandId = randomUUID();
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId,
    displayName: 'ลูกค้ากู้ผล',
  });
  assert.equal(created.status, 201);
  receiptMode = 'limited';
  const limited = await f.request(`customer-360/commands/${commandId}`, 'admin');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '7');
  receiptMode = 'down';
  const recovered = await f.request(`customer-360/commands/${commandId}`, 'admin');
  assert.equal(recovered.status, 201);
  assert.equal(
    (recovered.body as unknown as { command: { outcome: string } }).command.outcome,
    'APPLIED',
  );
  const unknownId = randomUUID();
  assert.equal((await f.request(`customer-360/commands/${unknownId}`, 'admin')).status, 503);
  assert.equal(
    (await f.request(`customer-360/commands/${unknownId}/reconcile`, 'admin', {})).status,
    503,
  );
  assert.equal(
    await f.owner.c360ProfileCommand.count({
      where: { tenantId: f.tenantId, commandId: unknownId },
    }),
    0,
  );
});

test('profile readback ใช้ budget แยกจาก search/write และ fail closed เมื่อ Redis ใช้ไม่ได้', async (t) => {
  let mode: 'limited' | 'down' = 'limited';
  const limiter: import('./shared-rate-limiter.js').SharedRateLimiter = {
    async consume({ policy }) {
      if (policy.name !== 'c360-receipt-v1') return null;
      if (mode === 'limited') return { retryAfterSeconds: 9 };
      throw new Error('Redis unavailable');
    },
  };
  const f = await setup([Customer360ReadController], limiter);
  t.after(() => f.close());
  const path = `customer-360/contacts/${randomUUID()}`;
  const limited = await f.request(path, 'admin');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '9');
  mode = 'down';
  const unavailable = await f.request(path, 'admin');
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error.code, 'RATE_LIMITER_UNAVAILABLE');
});

test('capability hint แสดงสร้างเฉพาะ Admin ที่ได้รับสิทธิ์และ runtime พร้อม', async (t) => {
  const f = await setup([Customer360OperatorController]);
  t.after(() => f.close());
  const before = await f.request('customer-360/capabilities', 'admin');
  assert.equal(before.status, 200);
  assert.equal((before.body as unknown as { create: boolean }).create, false);
  assert.deepEqual((before.body as unknown as { validation: unknown }).validation, {
    displayNameMax: 160,
    companyMax: 200,
    phoneRawMax: 64,
    emailRawMax: 512,
    activePointsPerKind: 10,
  });
  const grant = await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  assert.equal(grant.status, 201);
  const after = await f.request('customer-360/capabilities', 'admin');
  assert.equal((after.body as unknown as { create: boolean }).create, true);
  const supervisor = await f.request('customer-360/capabilities', 'supervisor');
  assert.equal(supervisor.status, 200);
  assert.equal((supervisor.body as unknown as { create: boolean }).create, false);
  assert.equal((supervisor.body as unknown as { writeReady: boolean }).writeReady, false);
});

test('runtime parser ไม่พร้อมปิด write hint และ route เขียน แต่ไม่ปิด navigation', async (t) => {
  const f = await setup([Customer360ReadController], undefined, { ready: false });
  t.after(() => f.close());
  const caps = await f.request('customer-360/capabilities', 'admin');
  assert.equal((caps.body as unknown as { writeReady: boolean }).writeReady, false);
  assert.equal((caps.body as unknown as { create: boolean }).create, false);
  const result = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'runtime',
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'WRITE_RUNTIME_UNAVAILABLE');
  assert.equal((await f.request('me/navigation', 'admin')).status, 200);
});

test('capability revoke ที่ถือ User lock ก่อน create ปิดการสร้างและไม่มีผลข้างเคียง', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  const operate = (command: unknown) =>
    f.request('customer-360/operator/commands', 'operator', {
      commandId: randomUUID(),
      evidenceRef: 'ticket:TEST-C4',
      reasonCode: 'APPROVED_CUSTODIAN',
      command,
    });
  await operate({
    action: 'CAPABILITY_GRANT',
    granteeUserId: f.actors.get('admin')!.id,
    capability: 'CONTACT_CREATE',
  });
  const capability = await f.owner.c360ActorCapabilityGrant.findFirstOrThrow({
    where: { tenantId: f.tenantId, granteeUserId: f.actors.get('admin')!.id },
  });
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION c4_test_hold_capability_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(794, 501); RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER c4_test_hold_capability_revoke BEFORE INSERT ON c360_actor_capability_revocations FOR EACH ROW EXECUTE FUNCTION c4_test_hold_capability_revoke()`,
  );
  let revoke: Promise<Awaited<ReturnType<typeof operate>>> | undefined;
  try {
    const baseline = await f.owner.contact.count({ where: { tenantId: f.tenantId } });
    const createId = randomUUID();
    await f.owner.$transaction(
      async (blocker) => {
        await blocker.$executeRaw`SELECT pg_advisory_xact_lock(794, 501)`;
        revoke = operate({ action: 'CAPABILITY_REVOKE', grantId: capability.id });
        let waiting = false;
        for (let i = 0; i < 75; i++) {
          const [locks] = await f.owner.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*)::bigint AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 794 AND objid = 501 AND NOT granted`;
          if (Number(locks?.count) > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'operator revoke ต้องรออยู่ใน transaction จริง');
        const blocked = await f.request('customer-360/contacts', 'admin', {
          commandId: createId,
          displayName: 'ห้ามสร้างระหว่างถอน',
        });
        assert.equal(blocked.status, 503);
      },
      { timeout: 10000 },
    );
    assert.equal((await revoke!).status, 201);
    const denied = await f.request('customer-360/contacts', 'admin', {
      commandId: createId,
      displayName: 'ห้ามสร้างระหว่างถอน',
    });
    assert.equal(denied.status, 403);
    assert.equal(await f.owner.contact.count({ where: { tenantId: f.tenantId } }), baseline);
  } finally {
    await f.owner.$executeRawUnsafe(
      'DROP TRIGGER c4_test_hold_capability_revoke ON c360_actor_capability_revocations',
    );
    await f.owner.$executeRawUnsafe('DROP FUNCTION c4_test_hold_capability_revoke()');
  }
});

test('create ที่ถือ User lock ก่อน revoke commit ได้ครั้งเดียว และ revoke เดิม retry ได้', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  const operate = (commandId: string, command: unknown) =>
    f.request('customer-360/operator/commands', 'operator', {
      commandId,
      evidenceRef: 'ticket:TEST-C4',
      reasonCode: 'APPROVED_CUSTODIAN',
      command,
    });
  await operate(randomUUID(), {
    action: 'CAPABILITY_GRANT',
    granteeUserId: f.actors.get('admin')!.id,
    capability: 'CONTACT_CREATE',
  });
  const capability = await f.owner.c360ActorCapabilityGrant.findFirstOrThrow({
    where: { tenantId: f.tenantId, granteeUserId: f.actors.get('admin')!.id },
  });
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION c4_test_hold_contact_create() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.display_name = 'C4 race create' THEN PERFORM pg_advisory_xact_lock(794, 502); END IF; RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER c4_test_hold_contact_create BEFORE INSERT ON contacts FOR EACH ROW EXECUTE FUNCTION c4_test_hold_contact_create()`,
  );
  let create: Promise<Awaited<ReturnType<typeof f.request>>> | undefined;
  try {
    const revokeId = randomUUID();
    await f.owner.$transaction(
      async (blocker) => {
        await blocker.$executeRaw`SELECT pg_advisory_xact_lock(794, 502)`;
        create = f.request('customer-360/contacts', 'admin', {
          commandId: randomUUID(),
          displayName: 'C4 race create',
        });
        let waiting = false;
        for (let i = 0; i < 75; i++) {
          const [locks] = await f.owner.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*)::bigint AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 794 AND objid = 502 AND NOT granted`;
          if (Number(locks?.count) > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true, 'create ต้องรออยู่ใน transaction จริง');
        const blocked = await operate(revokeId, {
          action: 'CAPABILITY_REVOKE',
          grantId: capability.id,
        });
        assert.equal(blocked.status, 503);
      },
      { timeout: 10000 },
    );
    assert.equal((await create!).status, 201);
    assert.equal(
      (await operate(revokeId, { action: 'CAPABILITY_REVOKE', grantId: capability.id })).status,
      201,
    );
    assert.equal(
      await f.owner.contact.count({
        where: { tenantId: f.tenantId, displayName: 'C4 race create' },
      }),
      1,
    );
  } finally {
    await f.owner.$executeRawUnsafe('DROP TRIGGER c4_test_hold_contact_create ON contacts');
    await f.owner.$executeRawUnsafe('DROP FUNCTION c4_test_hold_contact_create()');
  }
});

test('custodian revoke ที่ได้ fence ก่อน edit ปิดการแก้โดยไม่เปลี่ยน revision', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  const operate = (commandId: string, command: unknown) =>
    f.request('customer-360/operator/commands', 'operator', {
      commandId,
      evidenceRef: 'ticket:TEST-C4',
      reasonCode: 'APPROVED_CUSTODIAN',
      command,
    });
  await operate(randomUUID(), {
    action: 'CAPABILITY_GRANT',
    granteeUserId: f.actors.get('admin')!.id,
    capability: 'CONTACT_CREATE',
  });
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'C4 สิทธิ์ก่อนแก้',
  });
  const refs = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command.resourceRefs;
  const id = refs.find((ref) => ref.type === 'CONTACT')?.id;
  assert.ok(id);
  const grant = await f.owner.c360ContactCustodianGrant.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId: id, origin: 'CREATOR' },
  });
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION c4_test_hold_custodian_revoke() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(794, 503); RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER c4_test_hold_custodian_revoke BEFORE INSERT ON c360_contact_custodian_revocations FOR EACH ROW EXECUTE FUNCTION c4_test_hold_custodian_revoke()`,
  );
  let revoke: Promise<Awaited<ReturnType<typeof operate>>> | undefined;
  try {
    const patch = {
      commandId: randomUUID(),
      expectedProfileRevision: '0',
      expectedLineageRevision: '0',
      displayName: 'C4 ห้ามแก้',
    };
    await f.owner.$transaction(
      async (blocker) => {
        await blocker.$executeRaw`SELECT pg_advisory_xact_lock(794, 503)`;
        revoke = operate(randomUUID(), { action: 'CUSTODIAN_REVOKE', grantId: grant.id });
        let waiting = false;
        for (let i = 0; i < 75; i++) {
          const [locks] = await f.owner.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*)::bigint AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 794 AND objid = 503 AND NOT granted`;
          if (Number(locks?.count) > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true);
        assert.equal(
          (await f.request(`customer-360/contacts/${id}`, 'admin', patch, 'PATCH')).status,
          503,
        );
      },
      { timeout: 10000 },
    );
    assert.equal((await revoke!).status, 201);
    assert.equal(
      (await f.request(`customer-360/contacts/${id}`, 'admin', patch, 'PATCH')).status,
      404,
    );
    const contact = await f.owner.contact.findUniqueOrThrow({ where: { id } });
    assert.equal(contact.displayName, 'C4 สิทธิ์ก่อนแก้');
    assert.equal(contact.profileRevision, 0n);
  } finally {
    await f.owner.$executeRawUnsafe(
      'DROP TRIGGER c4_test_hold_custodian_revoke ON c360_contact_custodian_revocations',
    );
    await f.owner.$executeRawUnsafe('DROP FUNCTION c4_test_hold_custodian_revoke()');
  }
});

test('edit ที่ได้ fence ก่อน custodian revoke commit ได้ครั้งเดียว และ revoke เดิม retry ได้', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  const operate = (commandId: string, command: unknown) =>
    f.request('customer-360/operator/commands', 'operator', {
      commandId,
      evidenceRef: 'ticket:TEST-C4',
      reasonCode: 'APPROVED_CUSTODIAN',
      command,
    });
  await operate(randomUUID(), {
    action: 'CAPABILITY_GRANT',
    granteeUserId: f.actors.get('admin')!.id,
    capability: 'CONTACT_CREATE',
  });
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'C4 ก่อนแก้',
  });
  const refs = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command.resourceRefs;
  const id = refs.find((ref) => ref.type === 'CONTACT')?.id;
  assert.ok(id);
  const grant = await f.owner.c360ContactCustodianGrant.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId: id, origin: 'CREATOR' },
  });
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION c4_test_hold_contact_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.display_name = 'C4 ชนะการแก้' THEN PERFORM pg_advisory_xact_lock(794, 504); END IF; RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER c4_test_hold_contact_update BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION c4_test_hold_contact_update()`,
  );
  let edit: Promise<Awaited<ReturnType<typeof f.request>>> | undefined;
  try {
    const revokeId = randomUUID();
    await f.owner.$transaction(
      async (blocker) => {
        await blocker.$executeRaw`SELECT pg_advisory_xact_lock(794, 504)`;
        edit = f.request(
          `customer-360/contacts/${id}`,
          'admin',
          {
            commandId: randomUUID(),
            expectedProfileRevision: '0',
            expectedLineageRevision: '0',
            displayName: 'C4 ชนะการแก้',
          },
          'PATCH',
        );
        let waiting = false;
        for (let i = 0; i < 75; i++) {
          const [locks] = await f.owner.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*)::bigint AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 794 AND objid = 504 AND NOT granted`;
          if (Number(locks?.count) > 0) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true);
        assert.equal(
          (await operate(revokeId, { action: 'CUSTODIAN_REVOKE', grantId: grant.id })).status,
          503,
        );
      },
      { timeout: 10000 },
    );
    assert.equal((await edit!).status, 200);
    assert.equal(
      (await operate(revokeId, { action: 'CUSTODIAN_REVOKE', grantId: grant.id })).status,
      201,
    );
    const contact = await f.owner.contact.findUniqueOrThrow({ where: { id } });
    assert.equal(contact.displayName, 'C4 ชนะการแก้');
    assert.equal(contact.profileRevision, 1n);
  } finally {
    await f.owner.$executeRawUnsafe('DROP TRIGGER c4_test_hold_contact_update ON contacts');
    await f.owner.$executeRawUnsafe('DROP FUNCTION c4_test_hold_contact_update()');
  }
});

test('identity merge ที่ได้ fence ก่อน edit ทำให้ edit หยุดและแก้ predecessor ไม่ได้', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  const create = async (displayName: string) => {
    const result = await f.request('customer-360/contacts', 'admin', {
      commandId: randomUUID(),
      displayName,
    });
    assert.equal(result.status, 201);
    return (
      result.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
    ).command.resourceRefs.find((ref) => ref.type === 'CONTACT')!.id;
  };
  const source = await create('C4 identity source');
  const target = await create('C4 identity target');
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION c4_test_hold_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(794, 505); RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER c4_test_hold_identity BEFORE INSERT ON c360_identity_lineage FOR EACH ROW EXECUTE FUNCTION c4_test_hold_identity()`,
  );
  const mergeInput = {
    tenantId: f.tenantId,
    commandId: `identity:${randomUUID()}`,
    operation: 'MERGE' as const,
    sourceContactId: source,
    targetContactId: target,
    expectedSourceLineageRevision: 0,
    correlationId: 'c4-identity-race',
  };
  let merge: ReturnType<typeof f.memberships.recordIdentityTransition> | undefined;
  const patch = {
    commandId: randomUUID(),
    expectedProfileRevision: '0',
    expectedLineageRevision: '0',
    displayName: 'must not overwrite',
  };
  try {
    await f.owner.$transaction(
      async (blocker) => {
        await blocker.$executeRaw`SELECT pg_advisory_xact_lock(794, 505)`;
        merge = f.memberships.recordIdentityTransition(mergeInput);
        let waiting = false;
        for (let i = 0; i < 75; i++) {
          const [locks] = await f.owner.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*)::bigint AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 794 AND objid = 505 AND NOT granted`;
          if (Number(locks?.count)) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true);
        assert.equal(
          (await f.request(`customer-360/contacts/${source}`, 'admin', patch, 'PATCH')).status,
          503,
        );
      },
      { timeout: 10000 },
    );
    assert.equal((await merge!).operation, 'MERGE');
    assert.equal(
      (await f.request(`customer-360/contacts/${source}`, 'admin', patch, 'PATCH')).status,
      403,
    );
    const contact = await f.owner.contact.findUniqueOrThrow({ where: { id: source } });
    assert.equal(contact.displayName, 'C4 identity source');
    assert.equal(contact.profileRevision, 0n);
    const head = await f.owner.c360IdentityHead.findUniqueOrThrow({
      where: { tenantId_contactId: { tenantId: f.tenantId, contactId: source } },
    });
    assert.equal(head.state, 'MERGED');
    assert.equal(head.lineageRevision, 1);
  } finally {
    await f.owner.$executeRawUnsafe('DROP TRIGGER c4_test_hold_identity ON c360_identity_lineage');
    await f.owner.$executeRawUnsafe('DROP FUNCTION c4_test_hold_identity()');
  }
});

test('edit ที่ได้ identity fence ก่อน merge commit ก่อนและ merge retry สำเร็จ', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  const create = async (displayName: string) => {
    const result = await f.request('customer-360/contacts', 'admin', {
      commandId: randomUUID(),
      displayName,
    });
    assert.equal(result.status, 201);
    return (
      result.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
    ).command.resourceRefs.find((ref) => ref.type === 'CONTACT')!.id;
  };
  const source = await create('C4 identity edit source');
  const target = await create('C4 identity edit target');
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION c4_test_hold_identity_edit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.display_name = 'C4 edit won' THEN PERFORM pg_advisory_xact_lock(794, 506); END IF; RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER c4_test_hold_identity_edit BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION c4_test_hold_identity_edit()`,
  );
  const mergeInput = {
    tenantId: f.tenantId,
    commandId: `identity:${randomUUID()}`,
    operation: 'MERGE' as const,
    sourceContactId: source,
    targetContactId: target,
    expectedSourceLineageRevision: 0,
    correlationId: 'c4-identity-race',
  };
  const editId = randomUUID();
  let edit: ReturnType<typeof f.request> | undefined;
  let racingMerge:
    | Promise<
        | { ok: true; value: Awaited<ReturnType<typeof f.memberships.recordIdentityTransition>> }
        | { ok: false; error: unknown }
      >
    | undefined;
  try {
    await f.owner.$transaction(
      async (blocker) => {
        await blocker.$executeRaw`SELECT pg_advisory_xact_lock(794, 506)`;
        edit = f.request(
          `customer-360/contacts/${source}`,
          'admin',
          {
            commandId: editId,
            expectedProfileRevision: '0',
            expectedLineageRevision: '0',
            displayName: 'C4 edit won',
          },
          'PATCH',
        );
        let waiting = false;
        for (let i = 0; i < 75; i++) {
          const [locks] = await f.owner.$queryRaw<
            { count: bigint }[]
          >`SELECT count(*)::bigint AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 794 AND objid = 506 AND NOT granted`;
          if (Number(locks?.count)) {
            waiting = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(waiting, true);
        const fence = `c360-membership:${f.tenantId}:identity:${source}`;
        const [probe] = await blocker.$queryRaw<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_xact_lock(hashtext(${fence})) AS locked`;
        assert.equal(probe?.locked, false);
        racingMerge = f.memberships.recordIdentityTransition(mergeInput).then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        // เปิดให้ owner เริ่มแข่ง แต่ไม่รอจนเกิน mutation transaction timeout
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      { timeout: 10000 },
    );
    assert.equal((await edit!).status, 200);
    const merge = await racingMerge!;
    if (!merge.ok) {
      assert.equal((merge.error as { code?: string }).code, 'RESOURCE_BUSY');
      assert.equal((await f.memberships.recordIdentityTransition(mergeInput)).operation, 'MERGE');
    } else assert.equal(merge.value.operation, 'MERGE');
    const contact = await f.owner.contact.findUniqueOrThrow({ where: { id: source } });
    assert.equal(contact.displayName, 'C4 edit won');
    assert.equal(contact.profileRevision, 1n);
    assert.equal(
      await f.owner.c360ProfileCommandReceipt.count({
        where: { tenantId: f.tenantId, commandId: editId, outcome: 'APPLIED' },
      }),
      1,
    );
    assert.equal(
      await f.owner.c360ProfileAudit.count({ where: { tenantId: f.tenantId, commandId: editId } }),
      1,
    );
  } finally {
    await f.owner.$executeRawUnsafe('DROP TRIGGER c4_test_hold_identity_edit ON contacts');
    await f.owner.$executeRawUnsafe('DROP FUNCTION c4_test_hold_identity_edit()');
  }
});

test('ครบ quota 10 ช่องทางยัง replace 10→10 ได้โดยเก็บ history และปฏิเสธเพิ่มช่องที่ 11', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'C4 quota',
    points: Array.from({ length: 10 }, (_, i) => ({
      kind: 'EMAIL',
      value: `quota${i}@example.test`,
    })),
  });
  assert.equal(created.status, 201);
  const id = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command.resourceRefs.find((ref) => ref.type === 'CONTACT')!.id;
  const old = await f.owner.c360ContactPoint.findFirstOrThrow({
    where: { tenantId: f.tenantId, contactId: id, normalizedValue: 'quota0@example.test' },
  });
  const payload = {
    commandId: randomUUID(),
    expectedProfileRevision: '0',
    expectedLineageRevision: '0',
    kind: 'EMAIL',
    value: 'replacement@example.test',
  };
  const extra = await f.request(`customer-360/contacts/${id}/contact-points`, 'admin', payload);
  assert.equal(extra.status, 422);
  assert.equal(
    (extra.body as unknown as { command: { code: string } }).command.code,
    'POINT_QUOTA_EXCEEDED',
  );
  const replaced = await f.request(
    `customer-360/contacts/${id}/contact-points/${old.id}/replace`,
    'admin',
    { ...payload, commandId: randomUUID() },
  );
  assert.equal(replaced.status, 200);
  assert.equal(
    await f.owner.c360ContactPoint.count({
      where: { tenantId: f.tenantId, contactId: id, state: 'ACTIVE' },
    }),
    10,
  );
  assert.equal(
    await f.owner.c360ContactPoint.count({
      where: { tenantId: f.tenantId, contactId: id, state: 'RETIRED' },
    }),
    1,
  );
  assert.equal((await f.owner.contact.findUniqueOrThrow({ where: { id } })).profileRevision, 1n);
});

test('audit ล้มหลังสร้าง contact/point ต้อง rollback effect ทั้งหมด และ retry คำสั่งเดิมได้ครั้งเดียว', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  await f.request('customer-360/operator/commands', 'operator', {
    commandId: randomUUID(),
    evidenceRef: 'ticket:TEST-C4',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: {
      action: 'CAPABILITY_GRANT',
      granteeUserId: f.actors.get('admin')!.id,
      capability: 'CONTACT_CREATE',
    },
  });
  const commandId = randomUUID();
  const payload = {
    commandId,
    displayName: 'C4 rollback',
    points: [{ kind: 'EMAIL', value: 'rollback@example.test' }],
  };
  const before = {
    contacts: await f.owner.contact.count({ where: { tenantId: f.tenantId } }),
    heads: await f.owner.c360IdentityHead.count({ where: { tenantId: f.tenantId } }),
    points: await f.owner.c360ContactPoint.count({ where: { tenantId: f.tenantId } }),
    grants: await f.owner.c360ContactCustodianGrant.count({ where: { tenantId: f.tenantId } }),
  };
  await f.owner.$executeRawUnsafe(
    `CREATE FUNCTION c4_test_reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.operation = 'CONTACT_CREATE' THEN RAISE EXCEPTION 'fixture audit failure'; END IF; RETURN NEW; END $$`,
  );
  await f.owner.$executeRawUnsafe(
    `CREATE TRIGGER c4_test_reject_audit BEFORE INSERT ON c360_profile_audits FOR EACH ROW EXECUTE FUNCTION c4_test_reject_audit()`,
  );
  try {
    assert.equal((await f.request('customer-360/contacts', 'admin', payload)).status, 500);
    assert.equal(await f.owner.contact.count({ where: { tenantId: f.tenantId } }), before.contacts);
    assert.equal(
      await f.owner.c360IdentityHead.count({ where: { tenantId: f.tenantId } }),
      before.heads,
    );
    assert.equal(
      await f.owner.c360ContactPoint.count({ where: { tenantId: f.tenantId } }),
      before.points,
    );
    assert.equal(
      await f.owner.c360ContactCustodianGrant.count({ where: { tenantId: f.tenantId } }),
      before.grants,
    );
    assert.equal(
      await f.owner.c360ProfileCommandReceipt.count({ where: { tenantId: f.tenantId, commandId } }),
      0,
    );
  } finally {
    await f.owner.$executeRawUnsafe('DROP TRIGGER c4_test_reject_audit ON c360_profile_audits');
    await f.owner.$executeRawUnsafe('DROP FUNCTION c4_test_reject_audit()');
  }
  assert.equal((await f.request('customer-360/contacts', 'admin', payload)).status, 201);
  assert.equal((await f.request('customer-360/contacts', 'admin', payload)).status, 201);
  assert.equal(
    await f.owner.contact.count({ where: { tenantId: f.tenantId, displayName: 'C4 rollback' } }),
    1,
  );
  assert.equal(
    await f.owner.c360ProfileCommandReceipt.count({
      where: { tenantId: f.tenantId, commandId, outcome: 'APPLIED' },
    }),
    1,
  );
});

test('transaction ที่ retire tag ก่อน attach กันการเขียนซ้อนและปฏิเสธ tag ที่เลิกใช้', async (t) => {
  const f = await setup([Customer360OperatorController, Customer360ReadController]);
  t.after(() => f.close());
  const op = (command: unknown) =>
    f.request('customer-360/operator/commands', 'operator', {
      commandId: randomUUID(),
      evidenceRef: 'ticket:TEST-C4',
      reasonCode: 'APPROVED_CUSTODIAN',
      command,
    });
  await op({
    action: 'CAPABILITY_GRANT',
    granteeUserId: f.actors.get('admin')!.id,
    capability: 'CONTACT_CREATE',
  });
  await op({ action: 'TAG_SEED', names: ['C4 race tag'] });
  const tag = await f.owner.c360Tag.findFirstOrThrow({
    where: { tenantId: f.tenantId, name: 'C4 race tag' },
  });
  const created = await f.request('customer-360/contacts', 'admin', {
    commandId: randomUUID(),
    displayName: 'C4 tag race',
  });
  const id = (
    created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
  ).command.resourceRefs.find((ref) => ref.type === 'CONTACT')!.id;
  const payload = {
    commandId: randomUUID(),
    expectedTagRevision: '0',
    expectedLineageRevision: '0',
    attachTagIds: [tag.id],
    detachTagIds: [],
  };
  // ยังไม่มี production owner command สำหรับ TAG_RETIRE; ทดสอบเฉพาะ row lock ของ DB owner ที่รอ command นั้นในอนาคต
  await f.owner.$transaction(
    async (owner) => {
      await owner.c360Tag.update({
        where: { id: tag.id },
        data: { state: 'RETIRED', retiredAt: new Date(), revision: { increment: 1 } },
      });
      assert.equal(
        (await f.request(`customer-360/contacts/${id}/tags`, 'admin', payload, 'PATCH')).status,
        503,
      );
    },
    { timeout: 10000 },
  );
  const retry = await f.request(`customer-360/contacts/${id}/tags`, 'admin', payload, 'PATCH');
  assert.equal(retry.status, 409);
  assert.equal(
    (retry.body as unknown as { command: { code: string } }).command.code,
    'TAG_RETIRED',
  );
  assert.equal(
    await f.owner.c360ContactTag.count({ where: { tenantId: f.tenantId, contactId: id } }),
    0,
  );
  assert.equal((await f.owner.contact.findUniqueOrThrow({ where: { id } })).tagRevision, 0n);
  assert.equal(
    await f.owner.c360ProfileAudit.count({
      where: { tenantId: f.tenantId, commandId: payload.commandId },
    }),
    0,
  );
});
