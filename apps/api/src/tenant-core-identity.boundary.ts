/** ทดสอบ Keycloak/native Organization + verified proof + HTTP/PostgreSQL จริง ไม่ใช้ verifier stub */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

const sandbox = process.env.CORE_IDENTITY_SANDBOX_URL;
import { coreIdentitySandbox } from './tenant-core-identity-sandbox.js';

test(
  'Core real identity boundary: Keycloak 26.7.5/native Organizations → JWKS → proof → HTTP/RLS',
  {
    skip: !sandbox ? 'NOT_RUN: ต้องระบุ CORE_IDENTITY_SANDBOX_URL ของ sandbox แยก' : false,
    timeout: 120_000,
  },
  async (t) => {
    const { f, admin, prefix, issuer, keycloakUsers, roles, orgs, verifier, tokenFor } =
      await coreIdentitySandbox((cleanup) => t.after(cleanup));
    const token = await tokenFor('admin');
    const verified = await verifier.verifyAccessToken(token);
    const orgClaim = verified.organization as Record<string, { tenant_id: string[] }>;
    assert.deepEqual(
      orgClaim[`core-${f.tenantId}`]?.tenant_id,
      [f.tenantId],
      'native claimมีtenantattributeจริง',
    );
    assert.equal((await f.request('tenant/core-settings/capabilities', token)).status, 200);
    assert.deepEqual(
      (await f.request('tenant-voice/capabilities', token)).body.configuration.reasons,
      ['RESOURCE_POLICY_NOT_READY'],
    );
    const commandId = randomUUID();
    assert.equal(
      (await f.request(`tenant/core-settings/commands/${commandId}/reconcile`, token, {})).body
        .command.outcome,
      'NOT_APPLIED',
    );
    const foreignToken = await tokenFor('foreign');
    assert.equal((await f.request('tenant/core-settings/capabilities', foreignToken)).status, 200);
    assert.equal(
      (await f.request(`tenant/core-settings/commands/${commandId}`, foreignToken)).status,
      404,
      'foreign authenticated identityต้องไม่เห็นreceipt',
    );
    assert.equal(
      (await f.request(`tenant/core-settings/commands/${commandId}`, await tokenFor('admin-two')))
        .status,
      404,
      'Adminอื่นในtenantเดียวกันต้องไม่เห็นreceipt',
    );
    for (const name of ['unbound', 'disabled', 'agent'])
      assert.equal(
        (await f.request('tenant/core-settings/capabilities', await tokenFor(name))).status,
        403,
        name,
      );
    assert.equal(
      (await f.request('tenant/core-settings/capabilities', await tokenFor('supervisor'))).body
        .organization.write,
      false,
    );
    for (const client of ['unbound-console', 'platform-console'])
      assert.equal(
        (await f.request('tenant/core-settings/capabilities', await tokenFor('admin', client)))
          .status,
        403,
        client,
      );
    const signature = token.split('.');
    signature[2] = `${signature[2]![0] === 'a' ? 'b' : 'a'}${signature[2]!.slice(1)}`;
    assert.equal(
      (await f.request('tenant/core-settings/capabilities', signature.join('.'))).status,
      401,
      'invalid signature',
    );
    const actor = f.actors.get('admin')!;
    await f.owner.user.update({ where: { id: actor.id }, data: { role: 'AGENT' } });
    assert.equal(
      (await f.request('tenant/core-settings/capabilities', token)).status,
      403,
      'live domainrole beats still-valid admin JWT',
    );
    await f.owner.user.update({ where: { id: actor.id }, data: { role: 'ADMIN' } });
    await f.owner
      .$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=false,revision=revision+1 WHERE tenant_id=${f.tenantId}::uuid AND user_id=${actor.id}::uuid`;
    assert.equal(
      (await f.request('tenant/core-settings/capabilities', token)).status,
      403,
      'proofrevocation beats still-valid JWT',
    );
    await f.owner
      .$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=true,revision=revision+1 WHERE tenant_id=${f.tenantId}::uuid AND user_id=${actor.id}::uuid`;
    await admin(
      'POST',
      `${prefix}/organizations/${orgs.get(f.otherTenantId)!.id}/members`,
      keycloakUsers.get('admin')!.id,
    );
    const multiple = await tokenFor('admin', 'dcontact-console', 'openid organization:*');
    const response = await f.request('tenant/core-settings/capabilities', multiple);
    assert.ok(
      [401, 403].includes(response.status),
      'multiple native Organizationsห้าม self-select authority',
    );
    t.diagnostic(
      'PASS: real Keycloak/native Organization, JWKS, verified proof, role/proof drift และ B1 parity; ไม่มี token/secret ใน evidence',
    );
  },
);
