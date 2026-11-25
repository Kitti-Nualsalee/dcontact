import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { coreFixture } from './tenant-core-test-fixtures.js';

test('Core HTTP → PostgreSQL/RLS: a verified Admin can use Core without needing a Voice policy', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const response = await f.request('tenant/core-settings/capabilities');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(response.body, {
    organization: { read: true, write: true },
    teams: { read: true, create: true, rename: true, deactivate: true },
    notReadyReasons: { read: true, write: true },
    teamScope: 'TENANT',
    schemaVersion: 1,
  });
});

test('Core HTTP: the domain role/proof is the authority even if the token has a higher role', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  for (const token of ['unbound', 'disabled', 'agent']) {
    assert.equal((await f.request('tenant/core-settings/capabilities', token)).status, 403, token);
  }
  const supervisor = await f.request('tenant/core-settings/capabilities', 'supervisor');
  assert.equal(supervisor.status, 200);
  assert.equal(supervisor.body.organization.write, false);
  assert.equal(supervisor.body.teamScope, 'OWN');
  const voice = await f.request('tenant-voice/capabilities');
  assert.equal(voice.status, 200);
  assert.deepEqual(voice.body.configuration.reasons, ['RESOURCE_POLICY_NOT_READY']);
});

test('Core HTTP: a command that is not found is UNKNOWN and has an error contract that does not claim a rollback', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const result = await f.request(
    'tenant/core-settings/commands/93b908a4-89e3-4d78-bca2-6c87f98ef645',
  );
  assert.equal(result.status, 404);
  assert.equal(result.body.error.code, 'COMMAND_UNKNOWN');
  assert.equal(result.headers.get('cache-control'), 'no-store');
});

test("Core HTTP: reconcile of an unknown becomes a durable NOT_APPLIED only for the commander's own identity", async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const path = 'tenant/core-settings/commands/a2b431e9-297e-49bf-92a5-45c84b6cc218';
  const result = await f.request(`${path}/reconcile`, 'admin', {});
  assert.equal(result.status, 200);
  assert.equal(result.body.command.outcome, 'NOT_APPLIED');
  assert.equal(result.body.readbackRequired, false);
  assert.equal(result.body.command.committedRevision, null);
  assert.deepEqual((await f.request(path)).body, result.body);
  assert.deepEqual((await f.request(`${path}/reconcile`, 'admin', {})).body, result.body);
  assert.equal((await f.request(path, 'foreign')).status, 404);
  assert.equal((await f.request(`${path}/reconcile`, 'supervisor', {})).status, 403);
});

test('Core command HTTP: effects/audit/receipt commit together and a replay does not increase the revision', async (t) => {
  const { CoreCommandProbeController } = await import('./tenant-core-command-probe.js');
  const f = await coreFixture([CoreCommandProbeController]);
  t.after(() => f.close());
  const body = {
    commandId: 'e79282c2-5837-4750-8efc-aa222f292b73',
    expectedRevision: '0',
    displayName: 'Test company',
  };
  const result = await f.request('tenant/core-settings/_test/organization', 'admin', body);
  assert.equal(result.status, 200);
  assert.equal(result.body.command.outcome, 'APPLIED');
  assert.equal(result.body.command.committedRevision, '1');
  assert.deepEqual(
    (await f.request('tenant/core-settings/_test/organization')).body,
    result.body.command.resourceSnapshot,
  );
  assert.deepEqual(
    (await f.request('tenant/core-settings/_test/organization', 'admin', body)).body,
    result.body,
  );
  assert.deepEqual(
    (await f.request(`tenant/core-settings/commands/${body.commandId}`)).body,
    result.body,
  );
  assert.equal((await f.request('tenant/core-settings/_test/organization')).body.revision, '1');
});

test('Core HTTP: a no-op keeps revision 0 and a new stale command still conflicts even if its content equals the current one', async (t) => {
  const { CoreCommandProbeController } = await import('./tenant-core-command-probe.js');
  const f = await coreFixture([CoreCommandProbeController]);
  t.after(() => f.close());
  const initial = (await f.request('tenant/core-settings/_test/organization')).body;
  const noop = await f.request('tenant/core-settings/_test/organization', 'admin', {
    commandId: '26c1fb05-305e-4856-ab79-61728b5767f8',
    expectedRevision: '0',
    displayName: ` ${initial.displayName} `,
  });
  assert.equal(noop.body.command.outcome, 'NO_OP');
  assert.equal(noop.body.command.committedRevision, '0');
  const changed = {
    commandId: 'bf50ae72-3b17-40af-bf78-c14c1eaad728',
    expectedRevision: '0',
    displayName: 'New organization',
  };
  assert.equal(
    (await f.request('tenant/core-settings/_test/organization', 'admin', changed)).status,
    200,
  );
  const stale = { ...changed, commandId: 'b092d874-6057-4daa-a53e-bfb38d4ebc28' };
  const rejected = await f.request('tenant/core-settings/_test/organization', 'admin', stale);
  assert.equal(rejected.status, 409);
  assert.equal(rejected.body.error.code, 'REVISION_CONFLICT');
  assert.equal(rejected.body.command.outcome, 'REJECTED');
  const replayRejected = await f.request('tenant/core-settings/_test/organization', 'admin', stale);
  assert.deepEqual(replayRejected.body.command, rejected.body.command);
  assert.deepEqual(replayRejected.body.error, rejected.body.error);
  assert.equal(
    (
      await f.request('tenant/core-settings/_test/organization', 'admin', {
        ...stale,
        expectedRevision: '1',
      })
    ).body.error.code,
    'COMMAND_PAYLOAD_MISMATCH',
  );
});

test('Core HTTP: a process stopped after admission has no effects yet and can retry with the same ID', async (t) => {
  const { CoreCommandProbeController, probeHooks } = await import('./tenant-core-command-probe.js');
  const f = await coreFixture([CoreCommandProbeController]);
  t.after(() => f.close());
  const body = {
    commandId: 'b6b8edc6-3387-4bed-b120-42ff20b5a1db',
    expectedRevision: '0',
    displayName: 'Admission test',
  };
  t.after(() => probeHooks.delete(body.commandId));
  probeHooks.set(body.commandId, {
    afterAdmission: async () => {
      throw Error('fault after admission');
    },
  });
  assert.equal(
    (await f.request('tenant/core-settings/_test/organization', 'admin', body)).status,
    500,
  );
  assert.equal(
    (await f.request(`tenant/core-settings/commands/${body.commandId}`)).body.state,
    'ADMITTED',
  );
  assert.equal((await f.request('tenant/core-settings/_test/organization')).body.revision, '0');
  assert.equal(
    (
      await f.request('tenant/core-settings/_test/organization', 'admin', {
        ...body,
        displayName: 'Different data',
      })
    ).body.error.code,
    'COMMAND_PAYLOAD_MISMATCH',
  );
  probeHooks.delete(body.commandId);
  assert.equal(
    (await f.request('tenant/core-settings/_test/organization', 'admin', body)).body.command
      .outcome,
    'APPLIED',
  );
});

test('Core HTTP: a fault after effects rolls back the whole resource before reconcile and blocks a late POST', async (t) => {
  const { CoreCommandProbeController, probeHooks } = await import('./tenant-core-command-probe.js');
  const f = await coreFixture([CoreCommandProbeController]);
  t.after(() => f.close());
  const body = {
    commandId: '8f972a23-7d34-4499-92ea-0dd6ba909013',
    expectedRevision: '0',
    displayName: 'Data that must roll back',
  };
  t.after(() => probeHooks.delete(body.commandId));
  const before = (await f.request('tenant/core-settings/_test/organization')).body;
  probeHooks.set(body.commandId, {
    afterEffect: async () => {
      throw Error('fault before receipt');
    },
  });
  assert.equal(
    (await f.request('tenant/core-settings/_test/organization', 'admin', body)).status,
    500,
  );
  assert.deepEqual((await f.request('tenant/core-settings/_test/organization')).body, before);
  const reconciled = await f.request(
    `tenant/core-settings/commands/${body.commandId}/reconcile`,
    'admin',
    {},
  );
  assert.equal(reconciled.body.command.outcome, 'NOT_APPLIED');
  probeHooks.delete(body.commandId);
  const late = await f.request('tenant/core-settings/_test/organization', 'admin', body);
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'COMMAND_NOT_APPLIED');
  assert.deepEqual((await f.request('tenant/core-settings/_test/organization')).body, before);
});

test('Core HTTP: a response lost after commit is detected as APPLIED and a replay has no duplicate effects', async (t) => {
  const { CoreCommandProbeController, probeHooks } = await import('./tenant-core-command-probe.js');
  const f = await coreFixture([CoreCommandProbeController]);
  t.after(() => f.close());
  const body = {
    commandId: 'd4870294-3076-49ec-9ba5-aecfc011d44b',
    expectedRevision: '0',
    displayName: 'Saved but the response was lost',
  };
  t.after(() => probeHooks.delete(body.commandId));
  probeHooks.set(body.commandId, {
    afterCommit: async () => {
      throw Error('lost response');
    },
  });
  assert.equal(
    (await f.request('tenant/core-settings/_test/organization', 'admin', body)).status,
    500,
  );
  const receipt = await f.request(`tenant/core-settings/commands/${body.commandId}`);
  assert.equal(receipt.body.command.outcome, 'APPLIED');
  assert.deepEqual(
    (await f.request('tenant/core-settings/_test/organization')).body,
    receipt.body.command.resourceSnapshot,
  );
  assert.deepEqual(
    (await f.request('tenant/core-settings/_test/organization', 'admin', body)).body,
    receipt.body,
  );
});

test('Core HTTP: a proof revoked after admission forbids execution/replay/read until there is real authority again', async (t) => {
  const { CoreCommandProbeController, probeHooks } = await import('./tenant-core-command-probe.js');
  const f = await coreFixture([CoreCommandProbeController]);
  t.after(() => f.close());
  const body = {
    commandId: '0ca97d55-5acc-49c4-b615-30b146bf6d0c',
    expectedRevision: '0',
    displayName: 'Must have no effect when the proof is gone',
  };
  t.after(() => probeHooks.delete(body.commandId));
  const actor = f.actors.get('admin')!;
  probeHooks.set(body.commandId, {
    afterAdmission: async () => {
      await f.owner
        .$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=false,revision=revision+1 WHERE tenant_id=${f.tenantId}::uuid AND user_id=${actor.id}::uuid`;
    },
  });
  assert.equal(
    (await f.request('tenant/core-settings/_test/organization', 'admin', body)).status,
    403,
  );
  assert.equal((await f.request(`tenant/core-settings/commands/${body.commandId}`)).status, 403);
  await f.owner
    .$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=true,revision=revision+1 WHERE tenant_id=${f.tenantId}::uuid AND user_id=${actor.id}::uuid`;
  assert.equal((await f.request('tenant/core-settings/_test/organization')).body.revision, '0');
  assert.equal(
    (await f.request(`tenant/core-settings/commands/${body.commandId}`)).body.state,
    'ADMITTED',
  );
});

test('Core HTTP race: a command during execution returns PENDING and a revoke of the proof cannot slip in', async (t) => {
  const { CoreCommandProbeController, probeHooks } = await import('./tenant-core-command-probe.js');
  const f = await coreFixture([CoreCommandProbeController]);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = {
    commandId: 'd4f25c7e-47e8-4f7e-9264-bd390a173951',
    expectedRevision: '0',
    displayName: 'Concurrent execution test',
  };
  const options = {
    afterCommandLock: async () => {
      enter();
      await gate;
    },
  };
  probeHooks.set(body.commandId, options);
  const active = f.request('tenant/core-settings/_test/organization', 'admin', body);
  t.after(async () => {
    release();
    try {
      await active;
    } finally {
      probeHooks.delete(body.commandId);
      await f.close();
    }
  });
  assert.equal(
    await Promise.race([entered.then(() => true), active.then(() => false)]),
    true,
    'the server checkpoint must come after the lock and before the effects',
  );
  const pending = await f.request(
    `tenant/core-settings/commands/${body.commandId}/reconcile`,
    'admin',
    {},
  );
  assert.equal(pending.status, 202);
  assert.equal(pending.body.state, 'PENDING');
  assert.equal(
    (await f.request('tenant/core-settings/_test/organization', 'admin', body)).body.error.code,
    'CONFIG_BUSY',
  );
  const actor = f.actors.get('admin')!;
  await assert.rejects(
    f.owner
      .$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=false,revision=revision+1 WHERE tenant_id=${f.tenantId}::uuid AND user_id=${actor.id}::uuid`,
  );
  release();
  assert.equal((await active).body.command.outcome, 'APPLIED');
  assert.equal((await f.request('tenant/core-settings/_test/organization')).body.revision, '1');
});

test('Core HTTP race: reconcile during admission/execution blocks the original POST and an unknown late POST', async (t) => {
  const { CoreCommandProbeController, probeHooks } = await import('./tenant-core-command-probe.js');
  const f = await coreFixture([CoreCommandProbeController]);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const body = {
    commandId: '50a84065-4e2a-4965-85e4-39584978f784',
    expectedRevision: '0',
    displayName: 'Must not arrive late and change data',
  };
  probeHooks.set(body.commandId, {
    afterAdmission: async () => {
      enter();
      await gate;
    },
  });
  const active = f.request('tenant/core-settings/_test/organization', 'admin', body);
  t.after(async () => {
    release();
    try {
      await active;
    } finally {
      probeHooks.delete(body.commandId);
      await f.close();
    }
  });
  assert.equal(await Promise.race([entered.then(() => true), active.then(() => false)]), true);
  assert.equal(
    (await f.request(`tenant/core-settings/commands/${body.commandId}/reconcile`, 'admin', {})).body
      .command.outcome,
    'NOT_APPLIED',
  );
  release();
  assert.equal((await active).body.error.code, 'COMMAND_NOT_APPLIED');
  const unknown = { ...body, commandId: 'ffbb6d61-665b-4de1-bcd3-6a2d09f74068' };
  assert.equal(
    (await f.request(`tenant/core-settings/commands/${unknown.commandId}/reconcile`, 'admin', {}))
      .body.command.outcome,
    'NOT_APPLIED',
  );
  assert.equal(
    (await f.request('tenant/core-settings/_test/organization', 'admin', unknown)).body.error.code,
    'COMMAND_NOT_APPLIED',
  );
  assert.equal((await f.request('tenant/core-settings/_test/organization')).body.revision, '0');
});

test('Core HTTP: an error supports an X-Request-Id that passes the format check, without echoing an unsafe value', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const result = await f.request(
    'tenant/core-settings/commands/53547551-8190-419d-96ce-61a0be65b5d8',
    'admin',
    undefined,
    'GET',
    { 'x-request-id': 'core-725-request' },
  );
  assert.equal(result.status, 404);
  assert.equal(result.body.requestId, 'core-725-request');
});

test("Core HTTP: Admins in the same tenant can use the same UUID without reading or cancelling each other's commands", async (t) => {
  const { CoreCommandProbeController } = await import('./tenant-core-command-probe.js');
  const f = await coreFixture([CoreCommandProbeController]);
  t.after(() => f.close());
  const commandId = '21fd9664-f097-492b-af1c-ce1da6ad65d7';
  const path = `tenant/core-settings/commands/${commandId}`;
  assert.equal(
    (await f.request(`${path}/reconcile`, 'admin', {})).body.command.outcome,
    'NOT_APPLIED',
  );
  assert.equal((await f.request(path, 'admin-two')).status, 404);
  const body = { commandId, expectedRevision: '0', displayName: 'Saved by another Admin' };
  assert.equal(
    (await f.request('tenant/core-settings/_test/organization', 'admin-two', body)).body.command
      .outcome,
    'APPLIED',
  );
  assert.equal((await f.request(path, 'admin')).body.command.outcome, 'NOT_APPLIED');
  assert.equal((await f.request(path, 'admin-two')).body.command.outcome, 'APPLIED');
});

for (const drift of ['disable', 'role', 'team'] as const) {
  test(`Core HTTP race: a User ${drift} writer cannot slip into execution, and replay/reconcile check the latest state`, async (t) => {
    const { CoreCommandProbeController, probeHooks } =
      await import('./tenant-core-command-probe.js');
    const f = await coreFixture([CoreCommandProbeController]);
    const actor = f.actors.get('admin')!;
    const data =
      drift === 'disable'
        ? { isActive: false }
        : drift === 'role'
          ? { role: 'AGENT' as const }
          : { teamId: null };
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const body = { commandId: randomUUID(), expectedRevision: '0', displayName: `Race ${drift}` };
    probeHooks.set(body.commandId, {
      afterCommandLock: async () => {
        enter();
        await gate;
      },
    });
    const active = f.request('tenant/core-settings/_test/organization', 'admin', body);
    t.after(async () => {
      release();
      try {
        await active;
      } finally {
        probeHooks.delete(body.commandId);
        await f.close();
      }
    });
    assert.equal(await Promise.race([entered.then(() => true), active.then(() => false)]), true);
    await assert.rejects(
      f.owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe("SET LOCAL lock_timeout='100ms'");
        await tx.user.update({ where: { id: actor.id }, data });
      }),
      'the writer must not change authority during execution',
    );
    release();
    assert.equal((await active).body.command.outcome, 'APPLIED');
    await f.owner.user.update({ where: { id: actor.id }, data });
    const path = `tenant/core-settings/commands/${body.commandId}`;
    const expected = drift === 'team' ? 200 : 403;
    // an Admin has tenant scope: after a team move the Admin permission stays; disable/role drift must forbid a stale token
    assert.equal((await f.request(path)).status, expected);
    assert.equal((await f.request(`${path}/reconcile`, 'admin', {})).status, expected);
    assert.equal(
      (await f.request('tenant/core-settings/_test/organization', 'admin', body)).status,
      expected,
    );
    await f.owner.user.update({
      where: { id: actor.id },
      data: { isActive: true, role: 'ADMIN', teamId: f.teamId },
    });
    assert.equal((await f.request('tenant/core-settings/_test/organization')).body.revision, '1');
  });
}

test('Core HTTP race: Supervisor team drift must get the current own active Team and must not read authority while a writer is stuck', async (t) => {
  const f = await coreFixture();
  t.after(() => f.close());
  const actor = f.actors.get('supervisor')!;
  for (const change of ['assignment', 'active'] as const) {
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writer = f.owner.$transaction(async (tx) => {
      if (change === 'assignment')
        await tx.user.update({ where: { id: actor.id }, data: { teamId: null } });
      else {
        // owner-only legacy fault: the new guard forbids deactivating a Team that still has Users referencing it as usual
        // we still have to prove authorization when old data is found and a row lock is genuinely held
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role='replica'");
        await tx.team.update({ where: { id: f.teamId }, data: { isActive: false } });
      }
      enter();
      await gate;
    });
    try {
      assert.equal(await Promise.race([entered.then(() => true), writer.then(() => false)]), true);
      const busy = await f.request('tenant/core-settings/capabilities', 'supervisor');
      assert.equal(busy.status, 409);
      assert.equal(busy.body.error.code, 'CONFIG_BUSY');
    } finally {
      release();
      await writer;
    }
    assert.equal((await f.request('tenant/core-settings/capabilities', 'supervisor')).status, 403);
    await f.owner.user.update({ where: { id: actor.id }, data: { teamId: f.teamId } });
    await f.owner.team.update({ where: { id: f.teamId }, data: { isActive: true } });
    assert.equal(
      (await f.request('tenant/core-settings/capabilities', 'supervisor')).body.teamScope,
      'OWN',
    );
  }
});
