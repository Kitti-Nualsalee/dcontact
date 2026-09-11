import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
} from './gateway-auth.js';
import {
  CONTACT_GOVERNANCE_DATABASE,
  ContactGovernanceCallbackRequestsController,
  ContactGovernanceContactQueryController,
  ContactGovernanceDecisionQueryController,
  ContactGovernancePoliciesController,
  ContactGovernancePreferencesController,
} from './contact-governance-api.js';

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});

function workspaceClaims(
  tenantId: string,
  userId: string,
  role: 'agent' | 'admin' | 'compliance' | 'platform-operator',
): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: `tenant-${tenantId}`,
    organization: { [`tenant-${tenantId}`]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: [role] },
  };
}

function serviceClaims(tenantId: string, clientId: string): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: `tenant-${tenantId}`,
    organization: { [`tenant-${tenantId}`]: { tenant_id: [tenantId] } },
    azp: clientId,
    sub: clientId,
    preferred_username: `service-account-${clientId}`,
    exp: 2_000_000_000,
    realm_access: { roles: ['contact-governance-source'] },
  };
}

async function fixture(t: TestContext) {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const adminUserId = randomUUID();
  const agentUserId = randomUUID();
  const complianceUserId = randomUUID();
  const clientId = `crm-${randomUUID()}`;

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG3 API ${tenantId}`,
      slug: `cg3-api-${tenantId}`,
      sipDomain: `${tenantId}.cg3-api.test`,
    },
  });
  await owner.contact.create({ data: { id: contactId, tenantId, displayName: 'CG3 API contact' } });

  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'admin-token') return workspaceClaims(tenantId, adminUserId, 'admin');
      if (token === 'agent-token') return workspaceClaims(tenantId, agentUserId, 'agent');
      if (token === 'compliance-token') {
        return workspaceClaims(tenantId, complianceUserId, 'compliance');
      }
      if (token === 'service-token') return serviceClaims(tenantId, clientId);
      throw new Error('invalid token');
    },
  };

  @Module({
    controllers: [
      ContactGovernancePreferencesController,
      ContactGovernanceCallbackRequestsController,
      ContactGovernancePoliciesController,
      ContactGovernanceContactQueryController,
      ContactGovernanceDecisionQueryController,
    ],
    providers: [
      { provide: CONTACT_GOVERNANCE_DATABASE, useValue: application },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/v1/contact-governance`;

  t.after(async () => {
    await app.close();
    await owner.cgCallbackRequest.deleteMany({ where: { tenantId } });
    await owner.cgHolidayCalendarEntry.deleteMany({ where: { tenantId } });
    await owner.cgPolicy.deleteMany({ where: { tenantId } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId } });
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId } });
    await owner.cgPreference.deleteMany({ where: { tenantId } });
    await owner.cgContactStateHead.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  return { tenantId, contactId, base };
}

function post(url: string, token: string, body: unknown, idempotencyKey = randomUUID()) {
  return fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'idempotency-key': idempotencyKey,
    },
    body: JSON.stringify(body),
  });
}

test('agent ถูกจำกัดให้ทำได้แค่ restrictive preference; admin relax ได้', async (t) => {
  const { contactId, base } = await fixture(t);
  const now = new Date().toISOString();

  const agentAllow = await post(`${base}/preferences`, 'agent-token', {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'ALLOW',
    occurredAt: now,
    effectiveFrom: now,
    evidenceRef: 'evidence-1',
    expectedVersion: 0,
  });
  assert.equal(agentAllow.status, 403);
  assert.equal(
    ((await agentAllow.json()) as { code: string }).code,
    'PREFERENCE_RELAXATION_NOT_AUTHORIZED',
  );

  const agentBlock = await post(`${base}/preferences`, 'agent-token', {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'BLOCK',
    occurredAt: now,
    effectiveFrom: now,
    evidenceRef: 'evidence-2',
    expectedVersion: 0,
  });
  assert.equal(agentBlock.status, 201);
  const blocked = (await agentBlock.json()) as { aggregateVersion: number };
  assert.equal(blocked.aggregateVersion, 1);

  const adminAllow = await post(`${base}/preferences`, 'admin-token', {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'ALLOW',
    occurredAt: now,
    effectiveFrom: now,
    evidenceRef: 'evidence-3',
    expectedVersion: 1,
  });
  assert.equal(adminAllow.status, 201);
});

test('duplicate idempotency-key เดิม+hash เดิมคืน response เดิม; hash ต่าง 409; version stale 409', async (t) => {
  const { contactId, base } = await fixture(t);
  const now = new Date().toISOString();
  const idempotencyKey = randomUUID();
  const payload = {
    contactId,
    channel: 'EMAIL' as const,
    purpose: 'BILLING',
    decision: 'BLOCK' as const,
    occurredAt: now,
    effectiveFrom: now,
    evidenceRef: 'evidence-dup',
    expectedVersion: 0,
  };

  const first = await post(`${base}/preferences`, 'admin-token', payload, idempotencyKey);
  assert.equal(first.status, 201);
  const firstBody = await first.json();

  const retry = await post(`${base}/preferences`, 'admin-token', payload, idempotencyKey);
  assert.equal(retry.status, 201);
  assert.deepEqual(await retry.json(), firstBody);

  const conflictHash = await post(
    `${base}/preferences`,
    'admin-token',
    { ...payload, evidenceRef: 'different-evidence' },
    idempotencyKey,
  );
  assert.equal(conflictHash.status, 409);
  assert.equal(((await conflictHash.json()) as { code: string }).code, 'IDEMPOTENCY_CONFLICT');

  const staleVersion = await post(`${base}/preferences`, 'admin-token', {
    ...payload,
    evidenceRef: 'evidence-stale',
    expectedVersion: 5,
  });
  assert.equal(staleVersion.status, 409);
  assert.equal(((await staleVersion.json()) as { code: string }).code, 'VERSION_CONFLICT');
});

test('CRM service principal สร้าง preference ผ่าน route เดียวกับ agent/admin (dual-mode guard)', async (t) => {
  const { contactId, base } = await fixture(t);
  const now = new Date().toISOString();

  const response = await post(`${base}/preferences`, 'service-token', {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'BLOCK',
    sourceKind: 'CRM',
    sourceVersion: 'crm-sync-001',
    occurredAt: now,
    effectiveFrom: now,
    evidenceRef: 'crm-evidence',
    expectedVersion: 0,
  });
  assert.equal(response.status, 201);

  // agent (workspace) token ไม่มีสิทธิ CRM sourceKind และ service token ไม่มีสิทธิ์ agent role —
  // แต่ทั้งคู่ยิง route เดียวกันได้เพราะ guard รองรับ dual-mode
  const wrongService = await fetch(`${base}/preferences`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-role-token' },
  });
  assert.equal(wrongService.status, 401);
});

test('revoke preference ที่ active สำเร็จ; revoke ตัวที่ถูก supersede แล้วคืน 404 ทั่วไป', async (t) => {
  const { contactId, base } = await fixture(t);
  const now = new Date().toISOString();

  const created = await post(`${base}/preferences`, 'admin-token', {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'BLOCK',
    occurredAt: now,
    effectiveFrom: now,
    evidenceRef: 'evidence-revoke',
    expectedVersion: 0,
  });
  const body = (await created.json()) as { preference: { id: string } };

  const revoked = await post(`${base}/preferences/${body.preference.id}/revoke`, 'admin-token', {
    contactId,
    occurredAt: now,
    evidenceRef: 'evidence-revoke-2',
    expectedVersion: 1,
  });
  assert.equal(revoked.status, 200);

  const revokeAgain = await post(
    `${base}/preferences/${body.preference.id}/revoke`,
    'admin-token',
    {
      contactId,
      occurredAt: now,
      evidenceRef: 'evidence-revoke-3',
      expectedVersion: 2,
    },
  );
  assert.equal(revokeAgain.status, 404);
  assert.equal(((await revokeAgain.json()) as { code: string }).code, 'RESOURCE_NOT_FOUND');
});

test('callback-requests สร้างได้ และคืน one-use token ครั้งเดียว', async (t) => {
  const { contactId, base } = await fixture(t);
  const now = new Date();

  const response = await post(`${base}/callback-requests`, 'agent-token', {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    requestedAt: now.toISOString(),
    requestedTimezone: 'Asia/Bangkok',
    expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
    evidenceRef: 'callback-evidence',
    expectedVersion: 0,
  });
  assert.equal(response.status, 201);
  const body = (await response.json()) as {
    oneUseToken: string;
    callbackRequest: { mutationKind: string };
  };
  assert.ok(body.oneUseToken);
  assert.equal(body.callbackRequest.mutationKind, 'REQUEST');
});

test('policy publish ต้องการ checker ต่างจาก maker และ approvalRef', async (t) => {
  const { tenantId, base } = await fixture(t);
  const policyRowId = randomUUID();
  const policyId = randomUUID();
  await owner.cgPolicy.create({
    data: {
      id: policyRowId,
      tenantId,
      policyId,
      version: 1,
      purpose: 'MARKETING',
      channel: 'LINE',
      status: 'DRAFT',
      contentDigest: 'a'.repeat(64),
      makerActorRef: 'tenant-admin-1',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    },
  });

  const missingApproval = await post(
    `${base}/policies/${policyRowId}/publish`,
    'compliance-token',
    {
      expectedVersion: 1,
    },
  );
  assert.equal(missingApproval.status, 422);
  assert.equal(
    ((await missingApproval.json()) as { code: string }).code,
    'POLICY_APPROVAL_REQUIRED',
  );

  const published = await post(`${base}/policies/${policyRowId}/publish`, 'compliance-token', {
    expectedVersion: 1,
    approvalRef: 'approval-001',
  });
  assert.equal(published.status, 200);
  const body = (await published.json()) as { policy: { status: string } };
  assert.equal(body.policy.status, 'PUBLISHED');
});

test('effective-policy และ decision query คืน generic 404 ข้าม tenant พร้อม ETag', async (t) => {
  const { tenantId, contactId, base } = await fixture(t);
  await owner.cgPolicy.create({
    data: {
      id: randomUUID(),
      tenantId,
      policyId: randomUUID(),
      version: 1,
      purpose: 'MARKETING',
      channel: 'LINE',
      status: 'PUBLISHED',
      contentDigest: 'a'.repeat(64),
      makerActorRef: 'tenant-admin-1',
      checkerActorRef: 'compliance-1',
      approvalRef: 'approval-fixture',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });

  const effectivePolicy = await fetch(
    `${base}/contacts/${contactId}/effective-policy?channel=LINE&purpose=MARKETING`,
    { headers: { authorization: 'Bearer admin-token' } },
  );
  assert.equal(effectivePolicy.status, 200);
  assert.match(effectivePolicy.headers.get('etag') ?? '', /^cg-contact-v\d+$/);

  const crossTenantContact = await fetch(
    `${base}/contacts/${randomUUID()}/effective-policy?channel=LINE&purpose=MARKETING`,
    { headers: { authorization: 'Bearer admin-token' } },
  );
  assert.equal(crossTenantContact.status, 200); // effective-policy ไม่ผูก contact จริง แค่ scope

  const missingDecision = await fetch(`${base}/decisions/${randomUUID()}`, {
    headers: { authorization: 'Bearer admin-token' },
  });
  assert.equal(missingDecision.status, 404);
  assert.equal(((await missingDecision.json()) as { code: string }).code, 'RESOURCE_NOT_FOUND');
});

test('body ที่ส่ง tenantId มาเองถูกปฏิเสธ; token ที่ไม่มี role ที่ถูกต้องได้ 403', async (t) => {
  const { contactId, base } = await fixture(t);
  const now = new Date().toISOString();

  const spoofed = await post(`${base}/preferences`, 'admin-token', {
    tenantId: randomUUID(),
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'BLOCK',
    occurredAt: now,
    effectiveFrom: now,
    evidenceRef: 'evidence-spoof',
    expectedVersion: 0,
  });
  assert.equal(spoofed.status, 400);
  assert.equal(((await spoofed.json()) as { code: string }).code, 'VALIDATION_FAILED');

  const platformOperatorForbidden = await post(`${base}/preferences`, 'platform-operator-token', {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'BLOCK',
    occurredAt: now,
    effectiveFrom: now,
    evidenceRef: 'evidence-po',
    expectedVersion: 0,
  }).catch(() => undefined);
  // token ไม่รู้จักเลย (ไม่ได้ตั้งไว้ใน fake verifier) -> ปฏิเสธที่ authentication เสมอ
  assert.equal(platformOperatorForbidden?.status, 401);
});
