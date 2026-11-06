import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import {
  countC360CatalogTags,
  c360ActorIdentityKey,
  prepareC360ProfileCommand,
  C360_OPERATOR_CONTRACT_VERSION,
  C360_TAG_NORMALIZATION_VERSION,
} from '@d-contact/customer-360';
import test from 'node:test';
import { setup } from './customer-360-test-fixtures.js';
import { Customer360TagCatalogController } from './customer-360-tag-catalog-api.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';

/** M1-A: public HTTP → current actor → owner command/receipt → PostgreSQL RLS */
test('Admin สร้างแท็กแล้วอ่านกลับได้; replay ไม่สร้างซ้ำและไม่เพิ่มสิทธิ์อ่านลูกค้า', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  const commandId = randomUUID();
  const payload = { commandId, name: '  ลูกค้าสำคัญ  ' };
  const result = await f.request('customer-360/tags', 'admin', payload);
  assert.equal(result.status, 201);
  const receipt = (
    result.body as unknown as {
      command: { outcome: string; resourceRefs: { type: string; id: string }[] };
    }
  ).command;
  assert.equal(receipt.outcome, 'APPLIED');
  const id = receipt.resourceRefs.find((ref) => ref.type === 'TAG')?.id;
  assert.ok(id);
  assert.ok(!JSON.stringify(result.body).includes('ลูกค้าสำคัญ'), 'receipt ไม่มีชื่อแท็ก');
  const current = await f.request(`customer-360/tags/${id}`, 'admin');
  assert.equal(current.status, 200);
  const body = current.body as unknown as {
    id: string;
    name: string;
    state: string;
    revision: string;
  };
  assert.deepEqual(
    { id: body.id, name: body.name, state: body.state, revision: body.revision },
    {
      id,
      name: 'ลูกค้าสำคัญ',
      state: 'ACTIVE',
      revision: '0',
    },
  );
  assert.deepEqual((await f.request('customer-360/tags', 'admin', payload)).body, result.body);
  assert.equal(
    await f.owner.c360Tag.count({ where: { tenantId: f.tenantId, name: 'ลูกค้าสำคัญ' } }),
    1,
  );
  assert.equal(
    (await f.request('customer-360/tags', 'supervisor', { ...payload, commandId: randomUUID() }))
      .status,
    403,
  );
  assert.equal((await f.request(`customer-360/tags/${id}`, 'foreign')).status, 404);
  assert.equal((await f.request(`customer-360/tags/${id}`, 'admin-two')).status, 200);
  assert.equal((await f.request(`customer-360/commands/${commandId}`, 'admin-two')).status, 404);
  assert.equal(
    (await f.request(`customer-360/contacts/${f.contactId}/capabilities`, 'admin-two')).status,
    404,
  );
});

test('catalog และ receipt ตรวจ role, active user และ proof ปัจจุบันทุกครั้ง', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  const commandId = randomUUID();
  const created = await f.request('customer-360/tags', 'admin', {
    commandId,
    name: 'สิทธิ์ปัจจุบัน',
  });
  const id = (created.body as unknown as { command: { resourceRefs: { id: string }[] } }).command
    .resourceRefs[0]!.id;
  for (const token of ['agent', 'supervisor', 'compliance', 'disabled', 'unbound']) {
    assert.equal((await f.request('customer-360/tags', token)).status, 403, token);
    assert.equal((await f.request(`customer-360/tags/${id}`, token)).status, 403, token);
    assert.equal(
      (await f.request('customer-360/tags', token, { commandId: randomUUID(), name: 'ห้ามสร้าง' }))
        .status,
      403,
      token,
    );
  }
  const actor = f.actors.get('admin')!;
  for (const update of [
    { isActive: false },
    { keycloakId: randomUUID() },
    { role: 'SUPERVISOR' as const },
  ]) {
    await f.owner.user.update({ where: { id: actor.id }, data: update });
    for (const path of [
      'customer-360/tags',
      `customer-360/tags/${id}`,
      `customer-360/commands/${commandId}`,
    ])
      assert.equal((await f.request(path, 'admin')).status, 403, path);
    await f.owner.user.update({
      where: { id: actor.id },
      data: { isActive: true, keycloakId: actor.id, role: 'ADMIN' },
    });
  }
  assert.equal((await f.request(`customer-360/commands/${commandId}`, 'admin')).status, 201);
});

test('เมนู catalog แสดงเฉพาะ runtime พร้อมและ Admin ที่ proof ปัจจุบันผ่าน', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  const hasMenu = async (token: string) => {
    const response = await f.request('me/navigation', token);
    return (response.body as unknown as { apps: { id: string }[] }).apps.some(
      (app) => app.id === 'customer-tags',
    );
  };
  assert.equal(await hasMenu('admin'), true);
  assert.equal(await hasMenu('supervisor'), false);
  assert.equal(await hasMenu('disabled'), false);
  assert.equal(await hasMenu('unbound'), false);
  f.tagRuntime.ready = false;
  assert.equal(await hasMenu('admin'), false);
  f.tagRuntime.ready = true;
  await f.owner.user.update({
    where: { id: f.actors.get('admin')!.id },
    data: { role: 'SUPERVISOR' },
  });
  assert.equal(await hasMenu('admin'), false);
});

test('index ของ catalog และ Activity รองรับ keyset order ใน PostgreSQL', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  await withTenantDatabaseTransaction(f.db, f.tenantId, async (tx) => {
    // Fixture มีข้อมูลน้อยมาก จึงปิด seqscan เฉพาะ transaction นี้เพื่อพิสูจน์ว่า index ใช้กับ query ได้
    await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
    const tags = await tx.$queryRaw<
      { 'QUERY PLAN': string }[]
    >`EXPLAIN SELECT id FROM c360_tags WHERE tenant_id = ${f.tenantId}::uuid ORDER BY name_key COLLATE "C", id LIMIT 51`;
    const activity = await tx.$queryRaw<
      { 'QUERY PLAN': string }[]
    >`EXPLAIN SELECT id FROM c360_profile_audits WHERE tenant_id = ${f.tenantId}::uuid ORDER BY created_at DESC, id DESC LIMIT 51`;
    assert.match(tags.map((row) => row['QUERY PLAN']).join('\n'), /c360_tags_catalog_page_idx/);
    assert.match(
      activity.map((row) => row['QUERY PLAN']).join('\n'),
      /c360_profile_audits_activity_page_idx/,
    );
  });
});

test('reconcile command ที่ไม่ทราบผลปิดด้วย tombstone และ late create ไม่ทำงาน', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  const commandId = randomUUID();
  assert.equal((await f.request(`customer-360/commands/${commandId}`, 'admin')).status, 404);
  const reconciled = await f.request(`customer-360/commands/${commandId}/reconcile`, 'admin', {});
  assert.equal(
    (reconciled.body as unknown as { command: { code: string } }).command.code,
    'COMMAND_NOT_APPLIED',
  );
  const late = await f.request('customer-360/tags', 'admin', {
    commandId,
    name: 'ห้ามสร้างภายหลัง',
  });
  assert.deepEqual(late.body, reconciled.body);
  assert.equal(
    await f.owner.c360Tag.count({ where: { tenantId: f.tenantId, name: 'ห้ามสร้างภายหลัง' } }),
    0,
  );
});

test('catalog write และ detail ใช้ budget แยก; limiter ล่มปิดการเขียนโดยไม่สร้าง receipt', async (t) => {
  const calls: string[] = [];
  let mode: 'ok' | 'limited' | 'down' = 'ok';
  const f = await setup([Customer360TagCatalogController], {
    async consume({ policy }) {
      calls.push(policy.name);
      if (mode === 'limited') return { retryAfterSeconds: 7 };
      if (mode === 'down') throw new Error('limiter unavailable');
      return null;
    },
  });
  t.after(() => f.close());
  const commandId = randomUUID();
  mode = 'limited';
  const limited = await f.request('customer-360/tags', 'admin', {
    commandId,
    name: 'ทดสอบ budget',
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '7');
  mode = 'down';
  assert.equal(
    (await f.request('customer-360/tags', 'admin', { commandId, name: 'ทดสอบ budget' })).status,
    503,
  );
  assert.equal(
    await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId, commandId } }),
    0,
  );
  mode = 'ok';
  const created = await f.request('customer-360/tags', 'admin', {
    commandId,
    name: 'ทดสอบ budget',
  });
  const id = (created.body as unknown as { command: { resourceRefs: { id: string }[] } }).command
    .resourceRefs[0]!.id;
  assert.equal((await f.request(`customer-360/tags/${id}`, 'admin')).status, 200);
  assert.deepEqual(calls, ['c360-write-v1', 'c360-write-v1', 'c360-write-v1', 'c360-receipt-v1']);
});

test('ชื่อแท็กที่มี control หรือยาวเกินตอบ field error โดยไม่สร้าง command หรือสะท้อนค่า', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  for (const [name, code] of [
    ['a\u0000b', 'TAG_NAME_INVALID'],
    ['x'.repeat(81), 'TAG_NAME_TOO_LONG'],
  ] as const) {
    const commandId = randomUUID();
    const result = await f.request('customer-360/tags', 'admin', { commandId, name });
    assert.equal(result.status, 400);
    const error = (result.body as unknown as { error: { code: string; fieldErrors: unknown } })
      .error;
    assert.equal(error.code, 'VALIDATION_FAILED');
    assert.deepEqual(error.fieldErrors, [{ field: 'name', code }]);
    assert.equal(JSON.stringify(error).includes(name), false);
    assert.equal(
      await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId, commandId } }),
      0,
    );
  }
});

test('rename คง ID และ provenance; no-op/conflict/retire ไม่ทับ revision หรือสร้าง audit ซ้ำ', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  const create = await f.request('customer-360/tags', 'admin', {
    commandId: randomUUID(),
    name: 'VIP',
  });
  const id = (create.body as unknown as { command: { resourceRefs: { id: string }[] } }).command
    .resourceRefs[0]!.id;
  const initial = await f.owner.c360Tag.findUniqueOrThrow({ where: { id } });
  const renameId = randomUUID();
  const renamed = await f.request(
    `customer-360/tags/${id}`,
    'admin',
    { commandId: renameId, expectedRevision: '0', name: 'vip' },
    'PATCH',
  );
  assert.equal(renamed.status, 200);
  let tag = await f.owner.c360Tag.findUniqueOrThrow({ where: { id } });
  assert.equal(tag.name, 'vip');
  assert.equal(tag.nameKey, 'vip');
  assert.equal(tag.revision, 1n);
  assert.equal(tag.actorIdentityKey, initial.actorIdentityKey);
  assert.equal(tag.commandId, initial.commandId);
  const noOpId = randomUUID();
  const noop = await f.request(
    `customer-360/tags/${id}`,
    'admin',
    { commandId: noOpId, expectedRevision: '1', name: 'vip' },
    'PATCH',
  );
  assert.equal((noop.body as unknown as { command: { outcome: string } }).command.outcome, 'NO_OP');
  assert.equal(
    await f.owner.c360ProfileAudit.count({ where: { tenantId: f.tenantId, commandId: noOpId } }),
    0,
  );
  const stale = await f.request(
    `customer-360/tags/${id}`,
    'admin',
    { commandId: randomUUID(), expectedRevision: '0', name: 'overwrite' },
    'PATCH',
  );
  assert.equal(stale.status, 409);
  assert.equal(
    (stale.body as unknown as { command: { code: string } }).command.code,
    'REVISION_CONFLICT',
  );
  const retired = await f.request(`customer-360/tags/${id}/retire`, 'admin', {
    commandId: randomUUID(),
    expectedRevision: '1',
  });
  assert.equal(retired.status, 200);
  tag = await f.owner.c360Tag.findUniqueOrThrow({ where: { id } });
  assert.equal(tag.state, 'RETIRED');
  assert.equal(tag.revision, 2n);
  assert.ok(tag.retiredAt);
  const counts = await withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
    countC360CatalogTags(tx, f.tenantId),
  );
  assert.equal(counts.activeCount, '0');
  assert.equal(counts.retiredCount, '1');
  assert.ok(counts.asOf);
  const foreignCounts = await withTenantDatabaseTransaction(f.db, f.otherTenantId, (tx) =>
    countC360CatalogTags(tx, f.otherTenantId),
  );
  assert.equal(foreignCounts.retiredCount, '0');
  const denied = await f.request(
    `customer-360/tags/${id}`,
    'admin',
    { commandId: randomUUID(), expectedRevision: '2', name: 'new' },
    'PATCH',
  );
  assert.equal(
    (denied.body as unknown as { command: { code: string } }).command.code,
    'TAG_RETIRED',
  );
  const repeated = await f.request(`customer-360/tags/${id}/retire`, 'admin', {
    commandId: randomUUID(),
    expectedRevision: '2',
  });
  assert.equal(
    (repeated.body as unknown as { command: { outcome: string } }).command.outcome,
    'NO_OP',
  );
  const duplicate = await f.request('customer-360/tags', 'admin', {
    commandId: randomUUID(),
    name: 'VIP',
  });
  assert.equal(
    (duplicate.body as unknown as { command: { code: string } }).command.code,
    'TAG_NAME_CONFLICT',
  );
});

test('tag catalog ปิดโดยปริยายและเปิดได้เมื่อ runtime ผ่านและตั้ง feature flag ชัดเจน', async () => {
  const { createC360TagCatalogRuntime } = await import('./customer-360-tag-runtime.js');
  const { C360_PARSER_INTEGRITY } = await import('./customer-360-write-runtime.js');
  const { assertC360ContactPointRuntime } =
    await import('@d-contact/contact-points/runtime-manifest');
  assert.equal(createC360TagCatalogRuntime({}).ready, false);
  assert.equal(createC360TagCatalogRuntime({ C360_TAG_CATALOG_ENABLED: 'true' }).ready, true);
  const parser = assertC360ContactPointRuntime();
  const imageDigest = `sha256:${'a'.repeat(64)}`;
  const production = {
    NODE_ENV: 'production',
    C360_TAG_CATALOG_ENABLED: 'true',
    C360_IMAGE_DIGEST: imageDigest,
    C360_WRITE_RELEASE_MANIFEST: JSON.stringify({
      imageDigest,
      nodeVersion: parser.nodeVersion,
      icuVersion: process.versions.icu,
      unicodeVersion: process.versions.unicode,
      phoneMetadataSha256: parser.phoneMetadataSha256,
      normalizationVersions: parser.normalizationVersions,
      packageIntegrity: C360_PARSER_INTEGRITY,
    }),
  };
  assert.equal(createC360TagCatalogRuntime(production).ready, false);
  assert.equal(
    createC360TagCatalogRuntime({
      ...production,
      CUSTOMER_360_CURSOR_KEYS: `key:${Buffer.alloc(32, 1).toString('base64')}`,
    }).ready,
    true,
  );
});

test('catalog runtime ไม่พร้อมปิดเฉพาะ catalog routes โดยไม่สร้าง command', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  f.tagRuntime.ready = false;
  const commandId = randomUUID();
  const result = await f.request('customer-360/tags', 'admin', { commandId, name: 'ไม่ควรสร้าง' });
  assert.equal(result.status, 503);
  assert.equal(result.body.error.code, 'CATALOG_UNAVAILABLE');
  assert.equal((await f.request(`customer-360/tags/${randomUUID()}`, 'admin')).status, 503);
  assert.equal((await f.request('me/navigation', 'admin')).status, 200);
  assert.equal(
    await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId, commandId } }),
    0,
  );
});

test('catalog list ใช้ keyset cursor ที่ผูก actor/filter, ไม่ส่ง key หรือข้าม tenant', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  for (const name of ['Charlie', 'Alpha', 'Bravo'])
    assert.equal(
      (await f.request('customer-360/tags', 'admin', { commandId: randomUUID(), name })).status,
      201,
    );
  const first = await f.request('customer-360/tags?limit=2&state=ACTIVE', 'admin');
  assert.equal(first.status, 200);
  const page = first.body as unknown as {
    items: { id: string; name: string; revision: string }[];
    nextCursor: string;
    asOf: string;
  };
  assert.deepEqual(
    page.items.map((item) => item.name),
    ['Alpha', 'Bravo'],
  );
  assert.ok(page.asOf && page.nextCursor);
  assert.ok(!JSON.stringify(page.items).includes('nameKey'));
  assert.ok(!page.nextCursor.includes(page.items[1]!.id) && !page.nextCursor.includes('Bravo'));
  const path = `customer-360/tags?limit=2&state=ACTIVE&cursor=${encodeURIComponent(page.nextCursor)}`;
  const second = await f.request(path, 'admin');
  assert.equal(second.status, 200);
  assert.deepEqual(
    (second.body as unknown as { items: { name: string }[] }).items.map((item) => item.name),
    ['Charlie'],
  );
  assert.equal((await f.request(path, 'admin-two')).status, 400);
  assert.equal(
    (
      await f.request(
        `customer-360/tags?limit=2&state=RETIRED&cursor=${encodeURIComponent(page.nextCursor)}`,
        'admin',
      )
    ).status,
    400,
  );
  assert.equal((await f.request('customer-360/tags?limit=0', 'admin')).status, 400);
  assert.equal((await f.request('customer-360/tags?limit=1&limit=2', 'admin')).status, 400);
  assert.equal((await f.request('customer-360/tags?unknown=x', 'admin')).status, 400);
  assert.deepEqual(
    ((await f.request('customer-360/tags', 'foreign')).body as unknown as { items: unknown[] })
      .items,
    [],
  );
  await f.owner.user.update({ where: { id: f.actors.get('admin')!.id }, data: { teamId: null } });
  const changed = await f.request(path, 'admin');
  assert.equal(changed.status, 409);
  assert.equal(changed.body.error.code, 'CURSOR_CONTEXT_CHANGED');
});

test('receipt budget จำกัดแยกและ Redis ล่มกู้ได้เฉพาะ receipt ที่ commit แล้ว', async (t) => {
  let mode: 'ok' | 'limited' | 'down' = 'ok';
  const f = await setup([Customer360TagCatalogController], {
    async consume() {
      if (mode === 'limited') return { retryAfterSeconds: 11 };
      if (mode === 'down') throw new Error('unavailable');
      return null;
    },
  });
  t.after(() => f.close());
  const commandId = randomUUID();
  const created = await f.request('customer-360/tags', 'admin', {
    commandId,
    name: 'receipt test',
  });
  assert.equal(created.status, 201);
  mode = 'limited';
  const limited = await f.request(`customer-360/commands/${commandId}`, 'admin');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after'), '11');
  mode = 'down';
  const recovered = await f.request(`customer-360/commands/${commandId}`, 'admin');
  assert.equal(recovered.status, 201);
  assert.deepEqual(recovered.body, created.body);
  const unknown = randomUUID();
  assert.equal((await f.request(`customer-360/commands/${unknown}`, 'admin')).status, 503);
  assert.equal(
    (await f.request(`customer-360/commands/${unknown}/reconcile`, 'admin', {})).status,
    503,
  );
  assert.equal(
    await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId, commandId: unknown } }),
    0,
  );
});

for (const winner of ['catalog', 'operator'] as const) {
  test(`name-key fence: ${winner} สร้างก่อนและอีก owner ไม่สร้างชื่อซ้ำ`, async (t) => {
    const f = await setup([Customer360TagCatalogController, Customer360OperatorController]);
    t.after(() => f.close());
    const slot = winner === 'catalog' ? 601 : 602;
    const catalog = { commandId: randomUUID(), name: 'ชื่อชนกัน' };
    const operator = {
      commandId: randomUUID(),
      evidenceRef: 'ticket:TEST-M1A',
      reasonCode: 'APPROVED_CUSTODIAN',
      command: { action: 'TAG_SEED', names: ['ชื่อชนกัน'] },
    };
    const create = () => f.request('customer-360/tags', 'admin', catalog);
    const seed = () => f.request('customer-360/operator/commands', 'operator', operator);
    await f.owner.$executeRawUnsafe(
      `CREATE FUNCTION m1a_test_seed_race() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.name = 'ชื่อชนกัน' THEN PERFORM pg_advisory_xact_lock(819, ${slot}); END IF; RETURN NEW; END $$`,
    );
    await f.owner.$executeRawUnsafe(
      'CREATE TRIGGER m1a_test_seed_race BEFORE INSERT ON c360_tags FOR EACH ROW EXECUTE FUNCTION m1a_test_seed_race()',
    );
    let leader: ReturnType<typeof create> | undefined;
    try {
      await f.owner.$transaction(
        async (blocker) => {
          await blocker.$executeRaw`SELECT pg_advisory_xact_lock(819, ${slot}::integer)`;
          leader = winner === 'catalog' ? create() : seed();
          let waiting = false;
          for (let i = 0; i < 75; i++) {
            const [locks] = await f.owner.$queryRaw<
              { count: bigint }[]
            >`SELECT count(*)::bigint AS count FROM pg_locks WHERE locktype = 'advisory' AND classid = 819 AND objid = ${slot}::integer AND NOT granted`;
            if (Number(locks?.count)) {
              waiting = true;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.equal(waiting, true);
          const rejected = await (winner === 'catalog' ? seed() : create());
          assert.equal(rejected.status, 503);
        },
        { timeout: 10000 },
      );
      assert.equal((await leader!).status, 201);
      const retry = await (winner === 'catalog' ? seed() : create());
      if (winner === 'catalog')
        assert.equal(
          (retry.body as unknown as { command: { outcome: string } }).command.outcome,
          'NO_OP',
        );
      else
        assert.equal(
          (retry.body as unknown as { command: { code: string } }).command.code,
          'TAG_NAME_CONFLICT',
        );
      assert.equal(
        await f.owner.c360Tag.count({ where: { tenantId: f.tenantId, nameKey: 'ชื่อชนกัน' } }),
        1,
      );
    } finally {
      await f.owner.$executeRawUnsafe('DROP TRIGGER m1a_test_seed_race ON c360_tags');
      await f.owner.$executeRawUnsafe('DROP FUNCTION m1a_test_seed_race()');
    }
  });
}

test('สอง rename ชื่อเดียวกันไม่สร้างชื่อซ้ำ และคำสั่งที่แพ้กู้ผลโดยใช้ command เดิม', async (t) => {
  const f = await setup([Customer360TagCatalogController]);
  t.after(() => f.close());
  const ids: string[] = [];
  for (const name of ['หนึ่ง', 'สอง']) {
    const result = await f.request('customer-360/tags', 'admin', { commandId: randomUUID(), name });
    ids.push(
      (result.body as unknown as { command: { resourceRefs: { id: string }[] } }).command
        .resourceRefs[0]!.id,
    );
  }
  const commands = ids.map(() => ({
    commandId: randomUUID(),
    expectedRevision: '0',
    name: 'ชื่อร่วม',
  }));
  const results = await Promise.all(
    ids.map((id, index) => f.request(`customer-360/tags/${id}`, 'admin', commands[index], 'PATCH')),
  );
  assert.equal(results.filter((result) => result.status === 200).length, 1);
  const loser = results.findIndex((result) => result.status !== 200);
  assert.ok([409, 503].includes(results[loser]!.status));
  const retry = await f.request(
    `customer-360/tags/${ids[loser]}`,
    'admin',
    commands[loser],
    'PATCH',
  );
  assert.equal(retry.status, 409);
  assert.equal(
    (retry.body as unknown as { command: { code: string } }).command.code,
    'TAG_NAME_CONFLICT',
  );
  assert.equal(
    await f.owner.c360Tag.count({ where: { tenantId: f.tenantId, nameKey: 'ชื่อร่วม' } }),
    1,
  );
  assert.equal(
    await f.owner.c360ProfileAudit.count({
      where: { tenantId: f.tenantId, operation: 'TAG_RENAME' },
    }),
    1,
  );
});

test('operator replay receipt เดิมของชื่อที่เคยรับ control ได้ แต่ห้าม admit คำสั่งใหม่', async (t) => {
  const f = await setup([Customer360TagCatalogController, Customer360OperatorController]);
  t.after(() => f.close());
  const subject = f.actors.get('operator')!.id;
  const legacy = c360ActorIdentityKey({
    issuer: 'https://core-idp.test/realms/dcontact',
    subject,
    tenantId: f.tenantId,
    userId: subject,
  });
  const actorIdentityKey = createHash('sha256')
    .update(JSON.stringify(['c360-operator-actor-v1', legacy]))
    .digest('hex');
  const commandId = randomUUID();
  const payload = {
    commandId,
    evidenceRef: 'ticket:LEGACY-SEED',
    reasonCode: 'APPROVED_CUSTODIAN',
    command: { action: 'TAG_SEED', names: ['เดิม\tแท็ก'] },
  };
  const version = `${C360_OPERATOR_CONTRACT_VERSION}+${C360_TAG_NORMALIZATION_VERSION}`;
  const prepared = prepareC360ProfileCommand({
    commandId,
    action: 'OPERATOR_TAG_SEED',
    resourceType: 'TAG_CATALOG',
    resourceId: null,
    expectedRevisions: {},
    normalizationContractVersion: version,
    normalizedRequest: {
      command: payload.command,
      evidenceRef: payload.evidenceRef,
      reasonCode: payload.reasonCode,
    },
  });
  await f.owner.c360ProfileCommand.create({
    data: {
      tenantId: f.tenantId,
      actorIdentityKey,
      commandId,
      actorUserId: null,
      action: prepared.action,
      resourceType: prepared.resourceType,
      payloadDigest: prepared.payloadDigest,
      normalizationContractVersion: version,
      expectedRevisions: {},
    },
  });
  await f.owner.c360ProfileCommandReceipt.create({
    data: {
      tenantId: f.tenantId,
      actorIdentityKey,
      commandId,
      outcome: 'APPLIED',
      httpStatus: 201,
      committedRevisions: {},
      resourceRefs: [],
    },
  });
  assert.equal(
    (await f.request('customer-360/operator/commands', 'operator', payload)).status,
    201,
  );
  const mismatch = await f.request('customer-360/operator/commands', 'operator', {
    ...payload,
    command: { action: 'TAG_SEED', names: ['อื่น\tแท็ก'] },
  });
  assert.equal(mismatch.status, 409);
  const newId = randomUUID();
  assert.equal(
    (
      await f.request('customer-360/operator/commands', 'operator', {
        ...payload,
        commandId: newId,
      })
    ).status,
    400,
  );
  assert.equal(
    await f.owner.c360ProfileCommand.count({ where: { tenantId: f.tenantId, commandId: newId } }),
    0,
  );
  assert.equal(await f.owner.c360Tag.count({ where: { tenantId: f.tenantId } }), 0);
});
