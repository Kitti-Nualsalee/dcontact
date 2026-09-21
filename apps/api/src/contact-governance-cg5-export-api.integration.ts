import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { CONTACT_GOVERNANCE_DATABASE } from './contact-governance-api.js';
import {
  CG5_EXPORT_STORAGE,
  ContactGovernanceCg5ExportController,
  type Cg5ExportDownloadStorage,
} from './contact-governance-cg5-export-api.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
} from './gateway-auth.js';

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

function claims(tenantId: string, userId: string): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: `tenant-${tenantId}`,
    organization: { [`tenant-${tenantId}`]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: ['admin'] },
  };
}

class FakeStorage implements Cg5ExportDownloadStorage {
  readonly calls: Array<{ tenantId: string; key: string }> = [];
  async put(): Promise<void> {}
  async delete(): Promise<void> {}
  async presignDownload(tenantId: string, key: string) {
    this.calls.push({ tenantId, key });
    return { url: `https://storage.test/${key}`, expiresAt: new Date('2026-09-20T00:05:00.000Z') };
  }
}

async function fixture(t: TestContext) {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const userId = `admin-${randomUUID()}`;
  const otherUserId = `admin-${randomUUID()}`;
  for (const [id, user] of [
    [tenantId, userId],
    [otherTenantId, otherUserId],
  ] as const) {
    await owner.tenant.create({ data: { id, name: id, slug: id, sipDomain: `${id}.test` } });
    await owner.cg4AuthorizationSubject.create({
      data: {
        id: randomUUID(),
        tenantId: id,
        subjectId: user,
        directComplianceAuthority: false,
        emergencyAuthority: false,
        isServicePrincipal: false,
        authorizationEpoch: 1,
        scopeVersion: 1,
      },
    });
  }
  const storage = new FakeStorage();
  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'tenant-token') return claims(tenantId, userId);
      if (token === 'other-token') return claims(otherTenantId, otherUserId);
      throw new Error('invalid token');
    },
  };
  @Module({
    controllers: [ContactGovernanceCg5ExportController],
    providers: [
      { provide: CONTACT_GOVERNANCE_DATABASE, useValue: application },
      { provide: CG5_EXPORT_STORAGE, useValue: storage },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const address = app.getHttpServer().address() as AddressInfo;
  const base = `http://127.0.0.1:${address.port}/api/v1/contact-governance/exports`;
  t.after(async () => {
    const tenantIdIn = { in: [tenantId, otherTenantId] };
    await app.close();
    await owner.cgEventOutbox.deleteMany({ where: { tenantId: tenantIdIn } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId: tenantIdIn } });
    await owner.cg5ExportJob.deleteMany({ where: { tenantId: tenantIdIn } });
    await owner.cg4CapabilityGrant.deleteMany({ where: { tenantId: tenantIdIn } });
    await owner.cg4AuthorizationSubject.deleteMany({ where: { tenantId: tenantIdIn } });
    await owner.tenant.deleteMany({ where: { id: tenantIdIn } });
  });
  return { tenantId, otherTenantId, base, storage };
}

function request(url: string, token = 'tenant-token', init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
}

const exportInput: Record<string, unknown> = {
  datasets: ['AUDIT_LOG'],
  rangeFrom: '2026-09-01T00:00:00.000Z',
  rangeTo: '2026-09-02T00:00:00.000Z',
  filters: { channel: 'VOICE' },
  reason: 'quarterly audit',
};

test('CG5.8 export route idempotent, ซ่อน requester ใน SUMMARY และบังคับ tenant/capability', async (t) => {
  const f = await fixture(t);
  const create = async (token = 'tenant-token', body = exportInput) =>
    request(f.base, token, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'export-1' },
      body: JSON.stringify(body),
    });
  const first = await create();
  assert.equal(first.status, 201);
  const one = (await first.json()) as { exportId: string; requestedByRef: string };
  assert.match(one.requestedByRef, /^redacted:/);
  const repeat = await create();
  assert.equal(repeat.status, 201);
  assert.equal(((await repeat.json()) as { exportId: string }).exportId, one.exportId);
  const evidence = await create('tenant-token', { ...exportInput, evidenceLevel: 'EVIDENCE' });
  assert.equal(evidence.status, 403);
  const foreignList = await request(`${f.base}?tenantId=${f.tenantId}`, 'other-token');
  assert.equal(foreignList.status, 200);
  assert.deepEqual(((await foreignList.json()) as { items: unknown[] }).items, []);

  await owner.cg5ExportJob.update({
    where: { exportId: one.exportId },
    data: {
      state: 'READY',
      version: 2,
      storagePrefix: `governance-exports/${f.tenantId}/${one.exportId}`,
      manifestDigest: 'a'.repeat(64),
      // route เทียบกับเวลาจริง: วันที่คงที่จะกลายเป็น expired เมื่อเวลาผ่านไปและทำให้เทสต์ล้มเอง
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const foreignDownload = await request(`${f.base}/${one.exportId}/download`, 'other-token');
  assert.equal(foreignDownload.status, 404);
  const download = await request(`${f.base}/${one.exportId}/download`);
  assert.equal(download.status, 200);
  assert.equal(f.storage.calls.length, 1);
  assert.equal(f.storage.calls[0]?.tenantId, f.tenantId);
  assert.equal(
    await owner.cgAuditLog.count({
      where: { tenantId: f.tenantId, action: 'CG5_EXPORT_DOWNLOADED' },
    }),
    1,
  );
});

test('CG5-TI02 ไฟล์ export อยู่ใต้ prefix ของ tenant และ tenant อื่นดึงไม่ได้แม้รู้ exportId', async (t) => {
  const f = await fixture(t);
  const created = await request(f.base, 'tenant-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'export-ti02' },
    body: JSON.stringify(exportInput),
  });
  assert.equal(created.status, 201);
  const { exportId } = (await created.json()) as { exportId: string };
  await owner.cg5ExportJob.update({
    where: { exportId },
    data: {
      state: 'READY',
      version: 2,
      storagePrefix: `governance-exports/${f.tenantId}/${exportId}`,
      manifestDigest: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  // not-found แบบเดียวกับ ID ที่ไม่มีอยู่จริง: ไม่เผยว่ามี export นี้ใน tenant อื่น
  const missing = await request(`${f.base}/${randomUUID()}`, 'other-token');
  const missingBody = await missing.json();
  for (const path of [`${f.base}/${exportId}`, `${f.base}/${exportId}/download`]) {
    const foreign = await request(path, 'other-token');
    assert.equal(foreign.status, missing.status, path);
    assert.deepEqual(await foreign.json(), missingBody, path);
  }
  assert.equal(missing.status, 404);
  assert.equal(f.storage.calls.length, 0);
  assert.equal(
    await owner.cgAuditLog.count({
      where: { tenantId: f.otherTenantId, action: 'CG5_EXPORT_DOWNLOADED' },
    }),
    0,
  );

  const own = await request(`${f.base}/${exportId}/download`);
  assert.equal(own.status, 200);
  assert.deepEqual(f.storage.calls, [
    { tenantId: f.tenantId, key: `governance-exports/${f.tenantId}/${exportId}/manifest.json` },
  ]);
});
