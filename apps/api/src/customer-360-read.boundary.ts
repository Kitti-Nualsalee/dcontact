/**
 * Cus360 C2 (#792) S4: actual OIDC boundary ของ read routes — token จริงจาก Keycloak 26.7.5 (native Organizations)
 * → JWKS verifier → active User/proof → predicate ของ C1 → PostgreSQL/RLS ด้วย dcontact_app (ไม่ใช้ verifier stub)
 * รันใน CI job `identity-boundary` (ไม่มี CORE_IDENTITY_SANDBOX_URL = NOT_RUN ไม่ใช่ผ่าน)
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  C360SegmentEvaluator,
  C360SegmentMembershipRepository,
  C360SegmentRepository,
} from '@d-contact/customer-360';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
import { Customer360ReadController } from './customer-360-read-api.js';
import { contact, grant, point } from './customer-360-read-test-fixtures.js';
import {
  deliverToIam,
  ownerCommit,
  type Fixture as C1Fixture,
} from './customer-360-test-fixtures.js';
import { coreIdentitySandbox } from './tenant-core-identity-sandbox.js';

const sandbox = process.env.CORE_IDENTITY_SANDBOX_URL;

interface Body {
  items?: { contactId: string }[];
  contact?: { displayName: string };
  error?: { code: string };
}

test(
  'Customer 360 read: Keycloak token จริง → HTTP → predicate/RLS (Admin grant, Supervisor ทีม, Agent/Compliance, ต่าง tenant, token ปลอม)',
  {
    skip: !sandbox ? 'NOT_RUN: ต้องระบุ CORE_IDENTITY_SANDBOX_URL ของ sandbox แยก' : false,
    timeout: 180_000,
  },
  async (t) => {
    const { f, tokenFor } = await coreIdentitySandbox(
      (cleanup) => t.after(cleanup),
      [Customer360ReadController],
    );
    const get = (path: string, token: string) =>
      f.request(path, token) as Promise<{ status: number; body: Body }>;
    const search = (token: string, body: unknown = {}) =>
      f.request('customer-360/contacts/search', token, body) as Promise<{
        status: number;
        body: Body;
      }>;

    const granted = await contact(f, { displayName: 'OIDC Granted' });
    const hidden = await contact(f, { displayName: 'OIDC Hidden' });
    await grant(f, 'admin', granted, 'READ');
    await point(f, granted, 'PHONE', '+6621234567');

    // Admin ที่มี grant เห็นเฉพาะรายการนั้น; Admin ที่ไม่มี grant เห็นว่าง และ detail 404 เหมือนไม่พบ
    const adminToken = await tokenFor('admin');
    const list = await search(adminToken);
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.body.items?.map((i) => i.contactId),
      [granted],
    );
    assert.equal((await get(`customer-360/contacts/${granted}`, adminToken)).status, 200);
    const plain = await tokenFor('admin-two');
    assert.deepEqual((await search(plain)).body.items, []);
    const denied = await get(`customer-360/contacts/${granted}`, plain);
    const missing = await get(`customer-360/contacts/${randomUUID()}`, plain);
    assert.equal(denied.status, 404);
    assert.equal(missing.status, 404);
    assert.deepEqual(denied.body.error, missing.body.error);
    assert.equal((await get(`customer-360/contacts/${hidden}`, adminToken)).status, 404);
    // PHONE เต็มค่าผ่าน token จริง
    const byPhone = await search(adminToken, { type: 'PHONE', query: '+66 2 123 4567' });
    assert.deepEqual(
      byPhone.body.items?.map((i) => i.contactId),
      [granted],
    );

    // Agent/Compliance/unbound/disabled ไม่มี generic directory
    for (const name of ['agent', 'compliance', 'unbound', 'disabled']) {
      const token = await tokenFor(name);
      assert.equal((await search(token)).status, 403, name);
      assert.equal((await get(`customer-360/contacts/${granted}`, token)).status, 403, name);
    }
    // ต่าง tenant ไม่เห็นข้อมูลของ tenant แรก
    const foreign = await tokenFor('foreign');
    assert.deepEqual((await search(foreign)).body.items, []);
    assert.equal((await get(`customer-360/contacts/${granted}`, foreign)).status, 404);

    // Supervisor: อ่านได้ผ่าน IAM VIEW ของทีมเท่านั้น (ก่อนมี scope = ว่าง)
    const supervisorToken = await tokenFor('supervisor');
    assert.deepEqual((await search(supervisorToken)).body.items, []);
    const contactId = randomUUID();
    await f.owner.contact.create({
      data: { id: contactId, tenantId: f.tenantId, displayName: 'OIDC Team Scope' },
    });
    const segmentId = `segment:oidc-${f.tenantId.slice(0, 8)}`;
    const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
    const segments = new C360SegmentRepository(f.db, evaluator);
    const draft = await segments.createVersion({
      tenantId: f.tenantId,
      segmentId,
      version: 1,
      definition: {
        contractVersion: 1,
        name: 'OIDC VIEW',
        expression: {
          language: 'DC_EXPR',
          version: 1,
          expression: {
            type: 'comparison',
            operator: 'eq',
            left: { type: 'ref', path: ['contact', 'tier'] },
            right: { type: 'literal', value: 'GOLD' },
          },
        },
      },
      correlationId: 'c2-oidc-definition',
    });
    await segments.publishVersion({
      tenantId: f.tenantId,
      segmentId,
      version: 1,
      expectedContentDigest: draft.contentDigest,
      expectedHeadVersion: 0,
    });
    const scopes = new IamTeamSegmentScopeRepository(f.db);
    await scopes.grant({
      tenantId: f.tenantId,
      teamId: f.teamId,
      segmentId,
      permission: 'VIEW',
      correlationId: 'c2-oidc-grant',
    });
    const c1 = {
      ...f,
      contactId,
      segmentId,
      segments,
      memberships: new C360SegmentMembershipRepository(f.db, evaluator),
      scopes,
      snapshotVersion: 0,
      membershipRevision: 0,
    } as unknown as C1Fixture;
    await ownerCommit(c1, 'GOLD');
    // owner ยืนยันแล้วแต่ IAM ยังไม่ตามทัน → ไม่ใช่ ALLOW (503 ที่ detail)
    assert.equal((await get(`customer-360/contacts/${contactId}`, supervisorToken)).status, 503);
    await deliverToIam(c1);
    const team = await search(supervisorToken);
    assert.deepEqual(
      team.body.items?.map((i) => i.contactId),
      [contactId],
    );
    assert.equal(
      (await get(`customer-360/contacts/${contactId}`, supervisorToken)).body.contact?.displayName,
      'OIDC Team Scope',
    );
    assert.equal((await get(`customer-360/contacts/${granted}`, supervisorToken)).status, 404);

    // token ที่ไม่ผ่าน verifier ถูกปฏิเสธก่อนถึง predicate
    const [header, payload, signature] = adminToken.split('.') as [string, string, string];
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(payload, 'base64url').toString()),
        sub: randomUUID(),
      }),
    ).toString('base64url');
    for (const bad of [
      `${header}.${forged}.${signature}`,
      `${header}.${payload}.AAAA`,
      'garbage',
    ]) {
      assert.equal((await search(bad)).status, 401, bad.slice(0, 12));
      assert.equal((await get(`customer-360/contacts/${granted}`, bad)).status, 401);
    }
    const noToken = await fetch(`${f.base}/api/v1/customer-360/contacts/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(noToken.status, 401);
  },
);
