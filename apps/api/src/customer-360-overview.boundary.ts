import assert from 'node:assert/strict';
import test from 'node:test';
import { coreOverviewIdentitySandbox } from './tenant-core-identity-sandbox.js';

test(
  'Overview actual OIDC: counts/rules และ role/revoke ไม่ใช้ verifier stub',
  {
    skip: !process.env.CORE_IDENTITY_SANDBOX_URL
      ? 'NOT_RUN: isolated identity sandbox required'
      : false,
    timeout: 180000,
  },
  async (t) => {
    const { f, tokenFor } = await coreOverviewIdentitySandbox((cleanup) => t.after(cleanup));
    const admin = await tokenFor('admin');
    for (const route of ['overview/customers', 'overview/tags', 'field-rules'])
      assert.equal((await f.request(`customer-360/${route}`, admin)).status, 200);
    for (const alias of ['agent', 'supervisor', 'compliance', 'disabled', 'unbound']) {
      const token = await tokenFor(alias);
      assert.equal((await f.request('customer-360/overview/customers', token)).status, 403);
    }
    await f.owner.user.update({
      where: { id: f.actors.get('admin')!.id },
      data: { isActive: false },
    });
    assert.equal((await f.request('customer-360/field-rules', admin)).status, 403);
  },
);
