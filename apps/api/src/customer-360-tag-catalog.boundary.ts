/** M1-A: real Keycloak → gateway/proof → catalog → PostgreSQL/RLS in a separate sandbox */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Customer360Controller } from './customer-360-api.js';
import { Customer360TagCatalogController } from './customer-360-tag-catalog-api.js';
import { coreIdentitySandbox } from './tenant-core-identity-sandbox.js';

test(
  'M1 actual OIDC checks the catalog, replay and the current permission',
  {
    skip: !process.env.CORE_IDENTITY_SANDBOX_URL
      ? 'NOT_RUN: a separate Keycloak sandbox is required'
      : false,
    timeout: 180_000,
  },
  async (t) => {
    const { f, tokenFor } = await coreIdentitySandbox(
      (cleanup) => t.after(cleanup),
      [Customer360Controller, Customer360TagCatalogController],
    );
    const admin = await tokenFor('admin');
    const commandId = randomUUID();
    const body = { commandId, name: 'OIDC test tag' };
    const created = await f.request('customer-360/tags', admin, body);
    assert.equal(created.status, 201);
    const id = (
      created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
    ).command.resourceRefs.find((ref) => ref.type === 'TAG')!.id;
    assert.equal((await f.request(`customer-360/tags/${id}`, admin)).status, 200);
    const renewed = await tokenFor('admin');
    assert.deepEqual((await f.request('customer-360/tags', renewed, body)).body, created.body);
    assert.equal((await f.request(`customer-360/commands/${commandId}`, renewed)).status, 201);
    assert.equal(
      (await f.request(`customer-360/commands/${commandId}`, await tokenFor('admin-two'))).status,
      404,
    );
    assert.equal(
      (await f.request(`customer-360/tags/${id}`, await tokenFor('foreign'))).status,
      404,
    );
    for (const name of ['agent', 'supervisor', 'compliance', 'unbound', 'disabled']) {
      const token = await tokenFor(name);
      assert.equal((await f.request('customer-360/tags', token)).status, 403, name);
      assert.equal(
        (
          await f.request('customer-360/tags', token, {
            commandId: randomUUID(),
            name: 'Do not create',
          })
        ).status,
        403,
        name,
      );
    }
    await f.owner.user.update({
      where: { id: f.actors.get('admin')!.id },
      data: { isActive: false },
    });
    assert.equal((await f.request(`customer-360/commands/${commandId}`, renewed)).status, 403);
  },
);
