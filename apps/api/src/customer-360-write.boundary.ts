/** C4: Keycloak จริง → gateway/proof → write command → PostgreSQL/RLS (sandbox แยกเท่านั้น) */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Customer360Controller } from './customer-360-api.js';
import { Customer360ReadController } from './customer-360-read-api.js';
import { coreIdentitySandbox } from './tenant-core-identity-sandbox.js';

const sandbox = process.env.CORE_IDENTITY_SANDBOX_URL;

test(
  'C4 actual OIDC: create/readback/replay ผูก actor เดิมและตรวจสิทธิ์ปัจจุบัน',
  {
    skip: !sandbox ? 'NOT_RUN: ต้องระบุ CORE_IDENTITY_SANDBOX_URL ของ sandbox แยก' : false,
    timeout: 180_000,
  },
  async (t) => {
    const { f, tokenFor } = await coreIdentitySandbox(
      (cleanup) => t.after(cleanup),
      [Customer360Controller, Customer360ReadController],
    );
    const admin = await tokenFor('admin');
    const denied = await f.request('customer-360/contacts', admin, {
      commandId: randomUUID(),
      displayName: 'OIDC denied',
    });
    assert.equal(denied.status, 403);
    // สิทธิ์เริ่มต้นเป็น fixture ที่มี command FK จริง; mutation ที่ทดสอบใช้ token Keycloak จริงทุกตัว
    const grantCommand = randomUUID();
    const fixtureActor = 'oidc-fixture-operator';
    await f.owner.c360ProfileCommand.create({
      data: {
        tenantId: f.tenantId,
        actorIdentityKey: fixtureActor,
        commandId: grantCommand,
        action: 'CAPABILITY_GRANT',
        resourceType: 'USER',
        payloadDigest: 'f'.repeat(64),
        normalizationContractVersion: 'fixture',
      },
    });
    await f.owner.c360ActorCapabilityGrant.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenantId,
        granteeUserId: f.actors.get('admin')!.id,
        capability: 'CONTACT_CREATE',
        evidenceRef: 'fixture-oidc-c4',
        actorIdentityKey: fixtureActor,
        commandId: grantCommand,
      },
    });
    const commandId = randomUUID();
    const payload = {
      commandId,
      displayName: 'OIDC C4 customer',
      points: [{ kind: 'EMAIL', value: 'oidc@example.test' }],
    };
    const created = await f.request('customer-360/contacts', admin, payload);
    assert.equal(created.status, 201);
    const receipt = (
      created.body as unknown as { command: { resourceRefs: { type: string; id: string }[] } }
    ).command;
    const id = receipt.resourceRefs.find((ref) => ref.type === 'CONTACT')!.id;
    const readback = await f.request(`customer-360/contacts/${id}`, admin);
    assert.equal(readback.status, 200);
    assert.equal(
      (readback.body as unknown as { contact: { displayName: string } }).contact.displayName,
      'OIDC C4 customer',
    );
    const renewed = await tokenFor('admin');
    assert.deepEqual(
      (await f.request('customer-360/contacts', renewed, payload)).body,
      created.body,
    );
    assert.equal((await f.request(`customer-360/commands/${commandId}`, renewed)).status, 201);
    assert.equal(
      await f.owner.contact.count({
        where: { tenantId: f.tenantId, displayName: 'OIDC C4 customer' },
      }),
      1,
    );
    const other = await tokenFor('admin-two');
    assert.equal((await f.request(`customer-360/contacts/${id}`, other)).status, 404);
    assert.equal(
      (await f.request('customer-360/contacts', other, { ...payload, commandId: randomUUID() }))
        .status,
      403,
    );
    for (const name of ['agent', 'supervisor', 'compliance', 'unbound', 'disabled', 'foreign']) {
      const token = await tokenFor(name);
      assert.equal(
        (await f.request('customer-360/contacts', token, { ...payload, commandId: randomUUID() }))
          .status,
        403,
        name,
      );
    }
  },
);
