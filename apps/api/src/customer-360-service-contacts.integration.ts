import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Provider } from '@nestjs/common';
import type { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { CUSTOMER_360_DATABASE, Customer360Controller } from './customer-360-api.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { Customer360ReadController } from './customer-360-read-api.js';
import { Customer360ServiceApi } from './customer-360-service-api.js';
import { CUSTOMER_360_SERVICE_API } from './customer-360-service-port.js';
import { CUSTOMER_360_WRITE_RUNTIME, type C360WriteRuntime } from './customer-360-write-runtime.js';
import { CUSTOMER_360_SEARCH_LIMITER, type SharedRateLimiter } from './shared-rate-limiter.js';
import { coreFixture } from './tenant-core-test-fixtures.js';

/**
 * External customer API (#954): HTTP → PostgreSQL ด้วย application role (RLS) ของ service principal
 * Token เป็น synthetic verified claims; รอบ Keycloak จริงอยู่ใน customer-360-service-oidc.integration.ts
 */
const ISSUER = 'https://service.test/realms/dcontact';
const HUMAN_ISSUER = 'https://core-idp.test/realms/dcontact';
const SCOPES = 'customer360.contacts.read customer360.contacts.create';
type Core = Awaited<ReturnType<typeof coreFixture>>;
type Body = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function fixture(options: { enabled?: boolean } = {}) {
  const introspection: { active: boolean; fail: boolean; during?: () => Promise<void> } = {
    active: true,
    fail: false,
  };
  const clock = { skewMs: 0 };
  const services = new Map<string, VerifiedOidcClaims>();
  let f!: Core;
  const verifier = {
    verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
      const service = services.get(token);
      if (service) return service;
      const actor = f.actors.get(token);
      if (!actor) throw Error('invalid fixture token');
      return {
        iss: HUMAN_ISSUER,
        sub: actor.id,
        azp: 'dcontact-console',
        tenant_id: actor.tenantId,
        tenant_slug: `core-${actor.tenantId}`,
        organization: { [`core-${actor.tenantId}`]: { tenant_id: [actor.tenantId] } },
        dc_user_id: actor.id,
        sid: `core-${actor.id}`,
        exp: 2_000_000_000,
        realm_access: { roles: [actor.role.toLowerCase()] },
      } as VerifiedOidcClaims;
    },
  };
  const providers: Provider[] =
    options.enabled === false
      ? []
      : [
          {
            provide: CUSTOMER_360_SERVICE_API,
            inject: [
              CUSTOMER_360_DATABASE,
              CUSTOMER_360_SEARCH_LIMITER,
              CUSTOMER_360_WRITE_RUNTIME,
            ],
            useFactory: (db: PrismaClient, limiter: SharedRateLimiter, runtime: C360WriteRuntime) =>
              new Customer360ServiceApi(
                db,
                limiter,
                runtime,
                {
                  introspect: async () => {
                    if (introspection.fail) throw Error('idp down');
                    // จำลองเหตุการณ์ที่เกิดระหว่าง online proof กับ transaction ของ effect
                    await introspection.during?.();
                    return { active: introspection.active };
                  },
                },
                undefined,
                () => Date.now() + clock.skewMs,
              ),
          },
        ];
  f = await coreFixture(
    [Customer360Controller, Customer360ReadController, Customer360OperatorController],
    verifier,
    undefined,
    undefined,
    undefined,
    providers,
  );
  f.actors.set('operator', { id: randomUUID(), role: 'PLATFORM-OPERATOR', tenantId: f.tenantId });
  const subject = randomUUID();
  const serviceToken = (
    name: string,
    overrides: { tenantId?: string; scope?: string; clientId?: string; userId?: string } = {},
  ) => {
    const tenantId = overrides.tenantId ?? f.tenantId;
    const clientId = overrides.clientId ?? 'crm-954';
    services.set(name, {
      iss: ISSUER,
      sub: subject,
      azp: clientId,
      preferred_username: `service-account-${clientId}`,
      tenant_id: tenantId,
      tenant_slug: `core-${tenantId}`,
      organization: { [`core-${tenantId}`]: { tenant_id: [tenantId] } },
      exp: 2_000_000_000,
      realm_access: { roles: ['service'] },
      scope: overrides.scope ?? SCOPES,
      ...(overrides.userId ? { dc_user_id: overrides.userId, sid: 'mixed-session' } : {}),
    } as VerifiedOidcClaims);
    return name;
  };
  serviceToken('service');
  const operate = async (command: Body) => {
    const r = await f.request(
      'customer-360/operator/commands',
      'operator',
      {
        commandId: randomUUID(),
        evidenceRef: 'ticket:954',
        reasonCode: 'APPROVED_INTEGRATION',
        dryRun: false,
        command,
      },
      'POST',
    );
    assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
    return (r.body as Body).command as Body;
  };
  const bind = async () =>
    (
      await operate({
        action: 'SERVICE_BIND_CREATE',
        issuer: ISSUER,
        subject,
        clientId: 'crm-954',
        custodianAdminId: f.actors.get('admin')!.id,
      })
    ).resourceRefs[0].id as string;
  const create = (token: string, body: Body) =>
    f.request('customer-360/contacts', token, { commandId: randomUUID(), ...body }, 'POST');
  const contacts = () => f.owner.contact.count({ where: { tenantId: f.tenantId } });
  return { f, introspection, clock, serviceToken, operate, bind, create, contacts, subject };
}

test('External customer API: service สร้างลูกค้า อ่านกลับ ค้นเจอ และ custodian Admin ดูแลรายนั้นได้', async () => {
  const { f, serviceToken, operate, bind, create, contacts } = await fixture();
  try {
    const profile = {
      displayName: 'ลูกค้าจาก CRM',
      company: 'บริษัท ตัวอย่าง จำกัด',
      points: [{ kind: 'EMAIL', value: 'crm-954@example.test' }],
    };
    // ยังไม่มี binding: role/scope ใน token ไม่ให้สิทธิ์เอง
    assert.equal((await create('service', profile)).status, 403);
    assert.equal((await f.request('customer-360/contacts/search', 'service', {})).status, 403);

    const bindingId = await bind();
    // มี binding แต่ไม่มี capability: อ่านได้ (ยังไม่มีรายการ) แต่สร้างไม่ได้
    const empty = await f.request('customer-360/contacts/search', 'service', {});
    assert.equal(empty.status, 200);
    assert.deepEqual((empty.body as Body).items, []);
    assert.deepEqual((empty.body as Body).accessibleCount, { state: 'AVAILABLE', value: 0 });
    assert.equal((await create('service', profile)).status, 403);
    assert.equal(await contacts(), 0);

    await operate({
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    });
    // client กำหนด custodian/tenant/id เองไม่ได้
    assert.equal(
      (await create('service', { ...profile, custodianAdminId: f.actors.get('admin-two')!.id }))
        .status,
      400,
    );
    // token ที่ไม่มี scope create ถูกตัดที่ gateway
    assert.equal(
      (await create(serviceToken('read-only', { scope: 'customer360.contacts.read' }), profile))
        .status,
      403,
    );

    const commandId = randomUUID();
    const created = await f.request('customer-360/contacts', 'service', {
      commandId,
      ...profile,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const receipt = (created.body as Body).command as Body;
    assert.equal(receipt.outcome, 'APPLIED');
    const contactId = receipt.resourceRefs[0].id as string;
    // receipt ไม่มี PII snapshot
    assert.ok(!JSON.stringify(created.body).includes('crm-954@example.test'));

    // commandId เดิม: ได้ receipt เดิม ไม่สร้างซ้ำ; payload ต่าง = 409
    const replay = await f.request('customer-360/contacts', 'service', { commandId, ...profile });
    assert.deepEqual(replay.body, created.body);
    assert.equal(
      (
        await f.request('customer-360/contacts', 'service', {
          commandId,
          ...profile,
          displayName: 'ชื่ออื่น',
        })
      ).status,
      409,
    );
    assert.equal(await contacts(), 1);

    const detail = await f.request(`customer-360/contacts/${contactId}`, 'service');
    assert.equal(detail.status, 200, JSON.stringify(detail.body));
    const view = detail.body as Body;
    assert.equal(view.contact.displayName, 'ลูกค้าจาก CRM');
    assert.equal(view.contactPoints[0].value, 'crm-954@example.test');
    assert.deepEqual(view.capabilities, { read: true, manage: false });
    assert.equal(view.tags, undefined);
    assert.equal(view.source, undefined);

    const byEmail = await f.request('customer-360/contacts/search', 'service', {
      type: 'EMAIL',
      query: 'crm-954@example.test',
    });
    assert.deepEqual(
      (byEmail.body as Body).items.map((item: Body) => item.contactId),
      [contactId],
    );
    const lookup = await f.request(`customer-360/commands/${commandId}`, 'service');
    assert.deepEqual(lookup.body, created.body);
    // command ของ service อยู่คนละ namespace กับ human แม้ commandId เดียวกัน
    assert.equal((await f.request(`customer-360/commands/${commandId}`, 'admin')).status, 404);

    // custodian ที่ operator กำหนดได้ MANAGE; Admin คนอื่นไม่เห็น
    const admin = await f.request(`customer-360/contacts/${contactId}`, 'admin');
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal((admin.body as Body).capabilities.manage, true);
    assert.equal((await f.request(`customer-360/contacts/${contactId}`, 'admin-two')).status, 404);

    // หลักฐานใน DB: custody INTEGRATION, ledger, service READ grant และ audit ที่ไม่ปลอมเป็น Admin
    const custody = await f.owner.c360ContactCustodianGrant.findFirstOrThrow({
      where: { tenantId: f.tenantId, contactId },
    });
    assert.equal(custody.origin, 'INTEGRATION');
    assert.equal(custody.integrationPrincipalId, bindingId);
    assert.equal(custody.granteeUserId, f.actors.get('admin')!.id);
    assert.equal(custody.actorUserId, null);
    assert.equal(
      await f.owner.intServiceCommandEvidence.count({ where: { tenantId: f.tenantId, contactId } }),
      1,
    );
    assert.equal(
      await f.owner.intServiceContactGrant.count({
        where: { tenantId: f.tenantId, contactId, principalId: bindingId },
      }),
      1,
    );
    const audit = await f.owner.c360ProfileAudit.findFirstOrThrow({
      where: { tenantId: f.tenantId, resourceId: contactId },
    });
    assert.equal(audit.operation, 'CONTACT_CREATE');
    assert.equal(audit.actorUserId, null);

    // route ที่ไม่ได้เปิดให้ service ยังปฏิเสธ
    assert.equal(
      (
        await f.request(
          `customer-360/contacts/${contactId}`,
          'service',
          {
            commandId: randomUUID(),
            expectedProfileRevision: '0',
            expectedLineageRevision: '0',
            company: 'แก้ผ่าน service',
          },
          'PATCH',
        )
      ).status,
      401,
    );
    assert.equal(
      (await f.request(`customer-360/contacts/${contactId}/timeline`, 'service')).status,
      401,
    );
  } finally {
    await f.close();
  }
});

test('External customer API: อ่านได้เฉพาะ Contact ที่มี grant และหยุดทันทีเมื่อ operator ถอนหรือปิด binding', async () => {
  const { f, serviceToken, operate, bind, create } = await fixture();
  try {
    const bindingId = await bind();
    await operate({
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    });
    const created = await create('service', { displayName: 'ลูกค้ามี grant' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const mine = ((created.body as Body).command as Body).resourceRefs[0].id as string;

    // Contact ที่ Admin มีอยู่เดิมและของ tenant อื่น: service ไม่มี grant = เหมือนไม่พบ และไม่ถูกนับ
    const hidden = randomUUID();
    const foreign = randomUUID();
    await f.owner.contact.create({
      data: { id: hidden, tenantId: f.tenantId, displayName: 'ลูกค้ามี grant ซ้ำชื่อ' },
    });
    await f.owner.contact.create({
      data: { id: foreign, tenantId: f.otherTenantId, displayName: 'ลูกค้ามี grant ต่าง tenant' },
    });
    for (const id of [hidden, foreign, randomUUID(), 'not-a-uuid'])
      assert.equal((await f.request(`customer-360/contacts/${id}`, 'service')).status, 404);
    const byName = await f.request('customer-360/contacts/search', 'service', {
      type: 'NAME',
      query: 'ลูกค้ามี grant',
    });
    assert.deepEqual(
      (byName.body as Body).items.map((item: Body) => item.contactId),
      [mine],
    );
    const directory = await f.request('customer-360/contacts/search', 'service', {});
    assert.deepEqual((directory.body as Body).accessibleCount, { state: 'AVAILABLE', value: 1 });

    // token ของ subject/client เดียวกันแต่อ้าง tenant อื่น: ไม่มี binding ใน tenant นั้น
    const other = serviceToken('other-tenant', { tenantId: f.otherTenantId });
    assert.equal((await f.request(`customer-360/contacts/${mine}`, other)).status, 403);
    assert.equal((await f.request('customer-360/contacts/search', other, {})).status, 403);
    // client อื่นที่ยังไม่ผูก
    const unbound = serviceToken('unbound-client', { clientId: 'crm-other' });
    assert.equal((await f.request(`customer-360/contacts/${mine}`, unbound)).status, 403);

    // operator ให้ READ ของ Contact เดิมเป็นราย ๆ ได้
    await operate({
      action: 'SERVICE_CONTACT_GRANT',
      bindingId,
      expectedAuthzEpoch: '1',
      contactId: hidden,
      permission: 'READ',
    });
    assert.equal((await f.request(`customer-360/contacts/${hidden}`, 'service')).status, 200);

    // ถอน grant ของ Contact ที่ service สร้างเอง: อ่านไม่ได้ทันที และ receipt ไม่คืน ref ที่อ่านไม่ได้แล้ว
    const grant = await f.owner.intServiceContactGrant.findFirstOrThrow({
      where: { tenantId: f.tenantId, contactId: mine },
    });
    await operate({ action: 'SERVICE_CONTACT_REVOKE', grantId: grant.id, expectedAuthzEpoch: '2' });
    assert.equal((await f.request(`customer-360/contacts/${mine}`, 'service')).status, 404);
    const afterRevoke = await f.request('customer-360/contacts/search', 'service', {});
    assert.deepEqual(
      (afterRevoke.body as Body).items.map((item: Body) => item.contactId),
      [hidden],
    );
    const commandId = ((created.body as Body).command as Body).commandId as string;
    const receipt = await f.request(`customer-360/commands/${commandId}`, 'service');
    assert.deepEqual(((receipt.body as Body).command as Body).resourceRefs, []);

    // ปิด binding: ทุก route ของ service ถูกปฏิเสธ
    await operate({ action: 'SERVICE_BIND_DISABLE', bindingId, expectedAuthzEpoch: '3' });
    assert.equal((await f.request(`customer-360/contacts/${hidden}`, 'service')).status, 403);
    assert.equal((await f.request('customer-360/contacts/search', 'service', {})).status, 403);
    assert.equal((await create('service', { displayName: 'หลังปิด' })).status, 403);
    assert.equal((await f.request(`customer-360/commands/${commandId}`, 'service')).status, 403);
  } finally {
    await f.close();
  }
});

test('External customer API: create ต้องผ่าน online introspection และ custodian ที่ยัง active', async () => {
  const { f, introspection, operate, bind, create, contacts } = await fixture();
  try {
    const bindingId = await bind();
    await operate({
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    });
    introspection.active = false;
    assert.equal((await create('service', { displayName: 'token ถูกถอน' })).status, 401);
    introspection.active = true;
    introspection.fail = true;
    const unavailable = await create('service', { displayName: 'IdP ล่ม' });
    assert.equal(unavailable.status, 503);
    assert.equal((unavailable.body as Body).error.code, 'SERVICE_IDENTITY_UNAVAILABLE');
    introspection.fail = false;
    assert.equal(await contacts(), 0);

    // custodian ถูกปิดบัญชี: สร้างไม่ได้จน operator เปลี่ยน custodian
    await f.owner.user.update({
      where: { id: f.actors.get('admin')!.id },
      data: { isActive: false },
    });
    assert.equal((await create('service', { displayName: 'ไม่มีผู้ดูแล' })).status, 403);
    assert.equal(await contacts(), 0);
    await operate({
      action: 'SERVICE_BIND_REPLACE_CUSTODIAN',
      bindingId,
      expectedAuthzEpoch: '1',
      custodianAdminId: f.actors.get('admin-two')!.id,
    });
    const created = await create('service', { displayName: 'ผู้ดูแลใหม่' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const contactId = ((created.body as Body).command as Body).resourceRefs[0].id as string;
    assert.equal((await f.request(`customer-360/contacts/${contactId}`, 'admin-two')).status, 200);

    // ถอน capability: สร้างไม่ได้ แต่ยังอ่านรายที่มี grant ได้
    const capability = await f.owner.intServiceCapabilityGrant.findFirstOrThrow({
      where: { tenantId: f.tenantId, principalId: bindingId },
    });
    await operate({
      action: 'SERVICE_CAPABILITY_REVOKE',
      grantId: capability.id,
      expectedAuthzEpoch: '2',
    });
    assert.equal((await create('service', { displayName: 'หลังถอน' })).status, 403);
    assert.equal((await f.request(`customer-360/contacts/${contactId}`, 'service')).status, 200);
    assert.equal(await contacts(), 1);
  } finally {
    await f.close();
  }
});

test('External customer API: ปิดเป็นค่าเริ่มต้น และ route ของ Admin ไม่เปลี่ยน', async () => {
  const { f, bind, create } = await fixture({ enabled: false });
  try {
    await bind();
    assert.equal((await create('service', { displayName: 'feature ปิด' })).status, 403);
    assert.equal((await f.request('customer-360/contacts/search', 'service', {})).status, 403);
    assert.equal((await f.request(`customer-360/contacts/${randomUUID()}`, 'service')).status, 403);
    assert.equal((await f.request(`customer-360/commands/${randomUUID()}`, 'service')).status, 403);
    // human: Admin ที่ไม่มี CONTACT_CREATE ยังได้ 403 เดิม และค้นได้ตามสิทธิ์เดิม
    assert.equal((await create('admin', { displayName: 'Admin ไม่มี capability' })).status, 403);
    const directory = await f.request('customer-360/contacts/search', 'admin', {});
    assert.equal(directory.status, 200);
    assert.equal((await f.request('customer-360/contacts/search', 'agent', {})).status, 403);
  } finally {
    await f.close();
  }
});

test('External customer API: operator เปลี่ยน binding หรือ proof หมดเวลาระหว่าง create แล้วไม่เกิด effect', async () => {
  const { f, introspection, clock, serviceToken, operate, bind, create, contacts } =
    await fixture();
  try {
    const bindingId = await bind();
    await operate({
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    });
    // operator เปลี่ยน custodian หลัง service ผ่าน proof แต่ก่อน transaction ของ effect
    const commandId = randomUUID();
    const body = { commandId, displayName: 'แข่งกับ operator' };
    introspection.during = async () => {
      introspection.during = undefined;
      await operate({
        action: 'SERVICE_BIND_REPLACE_CUSTODIAN',
        bindingId,
        expectedAuthzEpoch: '1',
        custodianAdminId: f.actors.get('admin-two')!.id,
      });
    };
    const changed = await f.request('customer-360/contacts', 'service', body);
    assert.equal(changed.status, 409, JSON.stringify(changed.body));
    assert.equal((changed.body as Body).error.code, 'SERVICE_AUTHORIZATION_CHANGED');
    assert.equal(changed.headers.get('retry-after'), '1');
    assert.equal(await contacts(), 0);
    // ส่ง commandId เดิมซ้ำ: ตรวจสิทธิ์ใหม่แล้วสร้างได้หนึ่งราย โดย custodian เป็นคนปัจจุบัน
    const retried = await f.request('customer-360/contacts', 'service', body);
    assert.equal(retried.status, 201, JSON.stringify(retried.body));
    const contactId = ((retried.body as Body).command as Body).resourceRefs[0].id as string;
    assert.equal((await f.request(`customer-360/contacts/${contactId}`, 'admin-two')).status, 200);
    assert.equal((await f.request(`customer-360/contacts/${contactId}`, 'admin')).status, 404);
    assert.equal(await contacts(), 1);

    // proof หมดเวลาก่อนถึง effect: 503 ที่ส่งซ้ำได้ และไม่สร้างลูกค้า
    introspection.during = async () => {
      introspection.during = undefined;
      clock.skewMs += 6_000;
    };
    const late = await create('service', { displayName: 'proof หมดเวลา' });
    assert.equal(late.status, 503);
    assert.equal((late.body as Body).error.code, 'SERVICE_IDENTITY_UNAVAILABLE');
    assert.equal(await contacts(), 1);

    // binding ถูกปิดระหว่าง proof: ไม่เกิด effect (ทำท้ายสุด เพราะ binding ที่ปิดแล้วเปิดกลับไม่ได้)
    introspection.during = async () => {
      introspection.during = undefined;
      await operate({ action: 'SERVICE_BIND_DISABLE', bindingId, expectedAuthzEpoch: '2' });
    };
    assert.equal((await create('service', { displayName: 'ปิดระหว่าง proof' })).status, 403);
    assert.equal(await contacts(), 1);
    // token ที่มีทั้ง claims ของ service และของผู้ใช้ไม่ถูกนับเป็น service บน route dual-mode
    const mixed = serviceToken('mixed', { userId: f.actors.get('admin')!.id });
    assert.equal((await create(mixed, { displayName: 'mixed token' })).status, 403);
    assert.equal((await f.request('customer-360/contacts/search', mixed, {})).status, 403);
    assert.equal(await contacts(), 1);
  } finally {
    await f.close();
  }
});

test('External customer API: reconcile ปิดคำสั่งที่ไม่รู้ผล และ POST ที่มาทีหลังไม่สร้างลูกค้า', async () => {
  const { f, introspection, operate, bind, contacts } = await fixture();
  try {
    const bindingId = await bind();
    await operate({
      action: 'SERVICE_CAPABILITY_GRANT',
      bindingId,
      expectedAuthzEpoch: '0',
      capability: 'CONTACT_CREATE',
    });
    const commandId = randomUUID();
    const path = `customer-360/commands/${commandId}`;
    assert.equal((await f.request(path, 'service')).status, 404);
    // reconcile เปลี่ยนสถานะของ command จึงต้องผ่าน online proof
    introspection.active = false;
    assert.equal((await f.request(`${path}/reconcile`, 'service', {})).status, 401);
    introspection.active = true;
    assert.equal((await f.request(path, 'service')).status, 404);
    const closed = await f.request(`${path}/reconcile`, 'service', {});
    assert.equal(closed.status, 409);
    assert.equal(((closed.body as Body).command as Body).code, 'COMMAND_NOT_APPLIED');
    const late = await f.request('customer-360/contacts', 'service', {
      commandId,
      displayName: 'มาถึงหลัง reconcile',
    });
    assert.deepEqual(late.body, closed.body);
    assert.equal(await contacts(), 0);
    // Admin ที่ใช้ commandId เดียวกันอยู่คนละ namespace: ไม่เห็น tombstone ของ service
    assert.equal((await f.request(path, 'admin')).status, 404);
  } finally {
    await f.close();
  }
});
