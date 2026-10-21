import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import { coreFixture } from './tenant-core-test-fixtures.js';

test('ทีม: Admin สร้างผ่าน HTTP แล้วอ่านกลับ UUID เดิมและ revision1 โดยไม่เปิด Voice policy', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const teamId = randomUUID();
  const result = await f.request('tenant/core-settings/teams', 'admin', {
    commandId: randomUUID(),
    teamId,
    name: ' ทีมบริการใหม่ ',
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.command.outcome, 'APPLIED');
  const read = await f.request(`tenant/core-settings/teams/${teamId}`);
  assert.equal(read.status, 200);
  assert.deepEqual((read.body as unknown as { team: unknown }).team, {
    id: teamId,
    name: 'ทีมบริการใหม่',
    isActive: true,
    revision: '1',
  });
});

test('ทีม: เปลี่ยนชื่อด้วย CAS และ replay เดิม ไม่เพิ่ม revision เมื่อ no-op และปฏิเสธ revision เก่า', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const path = `tenant/core-settings/teams/${f.teamId}`;
  const body = { commandId: randomUUID(), expectedRevision: '1', patch: { name: 'ทีมดูแลใหม่' } };
  const changed = await f.request(path, 'admin', body, 'PATCH');
  assert.equal(changed.status, 200);
  assert.equal(changed.body.command.committedRevision, '2');
  assert.deepEqual(await f.request(path, 'admin', body, 'PATCH').then((r) => r.body), changed.body);
  const noOp = await f.request(
    path,
    'admin',
    { ...body, commandId: randomUUID(), expectedRevision: '2' },
    'PATCH',
  );
  assert.equal(noOp.body.command.outcome, 'NO_OP');
  assert.equal(noOp.body.command.committedRevision, '2');
  const stale = await f.request(path, 'admin', { ...body, commandId: randomUUID() }, 'PATCH');
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  const read = await f.request(path);
  assert.deepEqual((read.body as unknown as { team: unknown }).team, {
    id: f.teamId,
    name: 'ทีมดูแลใหม่',
    isActive: true,
    revision: '2',
  });
});

test('ทีม: รายการ UUID keyset มี signed cursor ผูก tenant/live scope และ Supervisor เห็นทีมตนเอง', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  for (let i = 0; i < 2; i++)
    assert.equal(
      (
        await f.request('tenant/core-settings/teams', 'admin', {
          commandId: randomUUID(),
          teamId: randomUUID(),
          name: `ทีม ${i}`,
        })
      ).status,
      201,
    );
  type Page = { teams: { id: string; revision: string }[]; nextCursor: string | null };
  const first = await f.request('tenant/core-settings/teams?limit=1');
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('Cache-Control'), 'no-store');
  const page = first.body as unknown as Page;
  assert.equal(page.teams.length, 1);
  assert.ok(page.nextCursor);
  const second = await f.request(`tenant/core-settings/teams?limit=1&cursor=${page.nextCursor}`);
  assert.equal(second.status, 200);
  assert.ok((second.body as unknown as Page).teams[0].id > page.teams[0].id);
  for (const token of ['foreign', 'supervisor'])
    assert.equal(
      (await f.request(`tenant/core-settings/teams?cursor=${page.nextCursor}`, token)).status,
      400,
    );
  assert.equal(
    (await f.request(`tenant/core-settings/teams?cursor=${page.nextCursor}x`)).status,
    400,
  );
  const own = await f.request('tenant/core-settings/teams', 'supervisor');
  assert.deepEqual(
    (own.body as unknown as Page).teams.map((x) => x.id),
    [f.teamId],
  );
  const invalid = await f.request('tenant/core-settings/teams?limit=101');
  assert.equal(invalid.status, 400);
});

test('ทีม DB: no-op DML หลัง Core command ไม่เพิ่ม revision และไม่บังคับ receipt เก่าซ้ำ', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const teamId = randomUUID();
  assert.equal(
    (
      await f.request('tenant/core-settings/teams', 'admin', {
        commandId: randomUUID(),
        teamId,
        name: 'ชื่อเดิม',
      })
    ).status,
    201,
  );
  await withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
    tx.team.update({ where: { id: teamId }, data: { name: 'ชื่อเดิม' } }),
  );
  const renamed = await f.request(
    `tenant/core-settings/teams/${teamId}`,
    'admin',
    { commandId: randomUUID(), expectedRevision: '1', patch: { name: 'ชื่อใหม่' } },
    'PATCH',
  );
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.command.committedRevision, '2');
});

test('ทีม DB: app ลบ UUID หรือแก้ metadata revision และเปลี่ยนชื่อโดยไม่มี effect receipt ไม่ได้', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const teamId = randomUUID();
  assert.equal(
    (
      await f.request('tenant/core-settings/teams', 'admin', {
        commandId: randomUUID(),
        teamId,
        name: 'เก็บ UUID เดิม',
      })
    ).status,
    201,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
      tx.team.delete({ where: { id: teamId } }),
    ),
    /permission denied/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
      tx.team.update({ where: { id: teamId }, data: { revision: 2n } }),
    ),
    /permission denied/,
  );
  await assert.rejects(
    withTenantDatabaseTransaction(f.db, f.tenantId, (tx) =>
      tx.team.update({ where: { id: teamId }, data: { name: 'ห้ามเปลี่ยนทางลัด' } }),
    ),
    /CORE_TEAM_EFFECT_RECEIPT_REQUIRED/,
  );
  assert.deepEqual(
    ((await f.request(`tenant/core-settings/teams/${teamId}`)).body as unknown as { team: unknown })
      .team,
    { id: teamId, name: 'เก็บ UUID เดิม', isActive: true, revision: '1' },
  );
});

test('ทีม: ปิดทีมว่างด้วย CAS เก็บ receipt/audit แล้ว replay/no-op ได้; ยังเปลี่ยนชื่อทีมปิดได้', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const teamId = randomUUID();
  const create = { commandId: randomUUID(), teamId, name: 'ทีมพร้อมปิด' };
  assert.equal((await f.request('tenant/core-settings/teams', 'admin', create)).status, 201);
  const path = `tenant/core-settings/teams/${teamId}`;
  const body = { commandId: randomUUID(), expectedRevision: '1' };
  const closed = await f.request(`${path}/deactivate`, 'admin', body);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.command.outcome, 'APPLIED');
  assert.equal(closed.body.command.committedRevision, '2');
  assert.deepEqual((await f.request(`${path}/deactivate`, 'admin', body)).body, closed.body);
  const noop = await f.request(`${path}/deactivate`, 'admin', {
    ...body,
    commandId: randomUUID(),
    expectedRevision: '2',
  });
  assert.equal(noop.body.command.outcome, 'NO_OP');
  assert.equal(noop.body.command.committedRevision, '2');
  const stale = await f.request(`${path}/deactivate`, 'admin', {
    ...body,
    commandId: randomUUID(),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, 'REVISION_CONFLICT');
  const renamed = await f.request(
    path,
    'admin',
    { commandId: randomUUID(), expectedRevision: '2', patch: { name: 'ทีมปิดเปลี่ยนชื่อได้' } },
    'PATCH',
  );
  assert.equal(renamed.status, 200);
  const read = await f.request(path);
  assert.deepEqual((read.body as unknown as { team: unknown }).team, {
    id: teamId,
    name: 'ทีมปิดเปลี่ยนชื่อได้',
    isActive: false,
    revision: '3',
  });
  assert.equal(
    await f.owner.tenantCoreConfigAudit.count({
      where: { tenantId: f.tenantId, resourceId: teamId },
    }),
    3,
  );
});

test('ทีม: ปิดทีมที่มี User รวม inactive ไม่ได้ เก็บ rejection เดิม และส่งเฉพาะชนิดกับจำนวน', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const path = `tenant/core-settings/teams/${f.teamId}/deactivate`;
  const body = { commandId: randomUUID(), expectedRevision: '1' };
  const rejected = await f.request(path, 'admin', body);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'TEAM_REFERENCED');
  assert.deepEqual((rejected.body.error as unknown as { blockers: unknown }).blockers, [
    { kind: 'USER_REFERENCE', count: 7 },
  ]);
  assert.deepEqual((await f.request(path, 'admin', body)).body.command, rejected.body.command);
  const receipt = await f.request(`tenant/core-settings/commands/${body.commandId}`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.command.outcome, 'REJECTED');
  assert.equal(
    await f.owner.tenantCoreConfigAudit.count({
      where: { tenantId: f.tenantId, commandId: body.commandId },
    }),
    0,
  );
  assert.equal((await f.owner.team.findUniqueOrThrow({ where: { id: f.teamId } })).isActive, true);
});

test('ทีม: unknown legacy ระงับเฉพาะปิดทีม; create/rename ทำได้ และ inactive no-op ไม่ตรวจ closure ซ้ำ', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const teamId = randomUUID();
  assert.equal(
    (
      await f.request('tenant/core-settings/teams', 'admin', {
        commandId: randomUUID(),
        teamId,
        name: 'ทีมเก่า',
      })
    ).status,
    201,
  );
  const path = `tenant/core-settings/teams/${teamId}`;
  assert.equal(
    (
      await f.request(`${path}/deactivate`, 'admin', {
        commandId: randomUUID(),
        expectedRevision: '1',
      })
    ).status,
    200,
  );
  // owner-only fault fixture แทน legacy current work ที่มีอยู่ก่อน guard; ไม่มี self-attestation ใน API
  await f.owner.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
    await tx.jrEnrollment.create({
      data: { tenantId: f.tenantId, journeyVersion: 1, runState: 'RUNNING' },
    });
  });
  const noop = await f.request(`${path}/deactivate`, 'admin', {
    commandId: randomUUID(),
    expectedRevision: '2',
  });
  assert.equal(noop.status, 200);
  assert.equal(noop.body.command.outcome, 'NO_OP');
  const newId = randomUUID();
  assert.equal(
    (
      await f.request('tenant/core-settings/teams', 'admin', {
        commandId: randomUUID(),
        teamId: newId,
        name: 'ทีมใหม่ขณะตรวจงานเก่า',
      })
    ).status,
    201,
  );
  const rejected = await f.request(`tenant/core-settings/teams/${newId}/deactivate`, 'admin', {
    commandId: randomUUID(),
    expectedRevision: '1',
  });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'TEAM_REFERENCE_UNRESOLVED');
  assert.deepEqual((rejected.body.error as unknown as { blockers: unknown }).blockers, [
    { kind: 'UNRESOLVED_CURRENT_REFERENCE', count: 1 },
  ]);
  assert.equal(
    (
      await f.request(
        path,
        'admin',
        { commandId: randomUUID(), expectedRevision: '2', patch: { name: 'ยังเปลี่ยนชื่อได้' } },
        'PATCH',
      )
    ).status,
    200,
  );
});

test('ทีม: validation ใช้ UTF-16/trim/อักขระควบคุม และชื่อ unique รวม inactive แบบ case-sensitive', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const create = (name: unknown, extra = {}) =>
    f.request('tenant/core-settings/teams', 'admin', {
      commandId: randomUUID(),
      teamId: randomUUID(),
      name,
      ...extra,
    });
  for (const name of ['', ' '.repeat(3), 'a'.repeat(81), '\u200babc', 'a\u0000b', '\ud800']) {
    const response = await create(name);
    assert.equal(response.status, 422, JSON.stringify(name));
    assert.equal(response.body.error.code, 'VALIDATION_FAILED');
  }
  assert.equal((await create('😀'.repeat(40))).status, 201);
  assert.equal((await create('😀'.repeat(41))).status, 422);
  assert.equal((await create('x', { isActive: false })).status, 400);
  assert.equal((await create(42)).status, 400);
  const teamId = randomUUID();
  const body = { commandId: randomUUID(), teamId, name: '  Care  ' };
  const first = await f.request('tenant/core-settings/teams', 'admin', body);
  assert.equal(first.status, 201);
  assert.deepEqual(
    (await f.request('tenant/core-settings/teams', 'admin', { ...body, name: 'Care' })).body,
    first.body,
  );
  assert.equal(
    (await f.request('tenant/core-settings/teams', 'admin', { ...body, name: 'Different' })).body
      .error.code,
    'COMMAND_PAYLOAD_MISMATCH',
  );
  assert.equal(
    (
      await f.request('tenant/core-settings/teams', 'admin', {
        ...body,
        commandId: randomUUID(),
        teamId: randomUUID(),
      })
    ).body.error.code,
    'TEAM_NAME_CONFLICT',
  );
  assert.equal(
    (
      await f.request('tenant/core-settings/teams', 'admin', {
        ...body,
        commandId: randomUUID(),
        name: 'Other',
      })
    ).body.error.code,
    'RESOURCE_ID_CONFLICT',
  );
  assert.equal(
    (
      await f.request(`tenant/core-settings/teams/${teamId}/deactivate`, 'admin', {
        commandId: randomUUID(),
        expectedRevision: '1',
      })
    ).status,
    200,
  );
  assert.equal((await create('Care')).body.error.code, 'TEAM_NAME_CONFLICT');
  assert.equal((await create('care')).status, 201);
  for (const expectedRevision of ['0', '01', '1e0', '-1', '9223372036854775808', 1])
    assert.equal(
      (
        await f.request(`tenant/core-settings/teams/${teamId}/deactivate`, 'admin', {
          commandId: randomUUID(),
          expectedRevision,
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.request(
        `tenant/core-settings/teams/${teamId}`,
        'admin',
        { commandId: randomUUID(), expectedRevision: '2', patch: { name: 'Care', isActive: true } },
        'PATCH',
      )
    ).status,
    400,
  );
});

test('ทีม: ทุก endpoint ใช้ live proof/role และไม่เปิดเผยข้อมูล resource ต่าง tenant หรือทีม Supervisor อื่น', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const teamId = randomUUID();
  const body = { commandId: randomUUID(), teamId, name: 'ทีมสิทธิ์' };
  assert.equal((await f.request('tenant/core-settings/teams', 'admin', body)).status, 201);
  const path = `tenant/core-settings/teams/${teamId}`;
  for (const token of ['agent', 'compliance', 'unbound', 'disabled']) {
    for (const target of ['tenant/core-settings/teams', path])
      assert.equal((await f.request(target, token)).status, 403, token);
  }
  for (const token of ['foreign', 'supervisor'])
    assert.equal((await f.request(path, token)).status, 404);
  for (const method of ['PATCH', 'POST'])
    assert.equal(
      (
        await f.request(
          method === 'PATCH' ? path : `${path}/deactivate`,
          'supervisor',
          {
            commandId: randomUUID(),
            expectedRevision: '1',
            ...(method === 'PATCH' ? { patch: { name: 'ไม่ได้' } } : {}),
          },
          method,
        )
      ).status,
      403,
    );
  const admin = f.actors.get('admin')!;
  await f.owner.user.update({ where: { id: admin.id }, data: { role: 'AGENT' } });
  assert.equal((await f.request('tenant/core-settings/teams', 'admin', body)).status, 403);
  assert.equal(
    (await f.request(`tenant/core-settings/commands/${body.commandId}`, 'admin')).status,
    403,
  );
  await f.owner.user.update({ where: { id: admin.id }, data: { role: 'ADMIN' } });
  await f.owner
    .$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=false,revision=revision+1 WHERE tenant_id=${f.tenantId}::uuid AND user_id=${admin.id}::uuid`;
  assert.equal((await f.request(path)).status, 403);
  assert.equal(
    (await f.request(`tenant/core-settings/commands/${body.commandId}/reconcile`, 'admin', {}))
      .status,
    403,
  );
});

test('ทีม: reference fence busy คง admission ไว้ ไม่มี effect และ retry command เดิมสำเร็จหลังปล่อย lock', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const teamId = randomUUID();
  assert.equal(
    (
      await f.request('tenant/core-settings/teams', 'admin', {
        commandId: randomUUID(),
        teamId,
        name: 'ทีม busy',
      })
    ).status,
    201,
  );
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (entered = resolve)),
    done = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const holder = f.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT public.dc_team_reference_lock(${f.tenantId}::uuid,ARRAY[${teamId}::uuid],false)`;
    entered();
    await done;
  });
  await ready;
  const body = { commandId: randomUUID(), expectedRevision: '1' };
  const path = `tenant/core-settings/teams/${teamId}/deactivate`;
  try {
    const start = performance.now();
    const busy = await f.request(path, 'admin', body);
    assert.equal(busy.status, 409);
    assert.equal(busy.body.error.code, 'CONFIG_BUSY');
    assert.equal(busy.body.error.retryable, true);
    assert.ok(performance.now() - start < 2000);
    assert.equal(busy.headers.get('Retry-After'), '1');
    const admitted = await f.request(`tenant/core-settings/commands/${body.commandId}`);
    assert.equal(admitted.status, 202);
    assert.equal(admitted.body.state, 'ADMITTED');
  } finally {
    release();
    await holder;
  }
  const closed = await f.request(path, 'admin', body);
  assert.equal(closed.status, 200);
  assert.equal(closed.body.command.outcome, 'APPLIED');
});

test('ทีม: read/list คืน X-Request-Id ที่ตรวจแล้ว และไม่ cache ผลตามสิทธิ์ผู้ใช้', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  for (const path of ['tenant/core-settings/teams', `tenant/core-settings/teams/${f.teamId}`]) {
    const response = await f.request(path, 'admin', undefined, 'GET', {
      'X-Request-Id': 'core-team-read-check',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Request-Id'), 'core-team-read-check');
  }
});

test('ทีม: เปลี่ยนชื่อยังทำได้ขณะ reference fence ถูกถือ ไม่ต้องรอ tenant ว่าง', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  let enter!: () => void, release!: () => void;
  const ready = new Promise<void>((resolve) => (enter = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve));
  t.after(() => release());
  const held = f.owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT public.dc_team_reference_lock(${f.tenantId}::uuid,ARRAY[${f.teamId}::uuid],true)`;
    enter();
    await gate;
  });
  try {
    await Promise.race([ready, held]);
    const result = await f.request(
      `tenant/core-settings/teams/${f.teamId}`,
      'admin',
      {
        commandId: randomUUID(),
        expectedRevision: '1',
        patch: { name: 'เปลี่ยนชื่อระหว่างงานได้' },
      },
      'PATCH',
    );
    assert.equal(result.status, 200);
    assert.equal(result.body.command.committedRevision, '2');
  } finally {
    release();
    await held;
  }
});
