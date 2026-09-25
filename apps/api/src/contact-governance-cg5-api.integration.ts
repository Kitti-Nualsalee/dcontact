import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient } from '@d-contact/db';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import { Cg5AlertRepository, Cg5QueryCache } from '@d-contact/contact-governance';
import { CONTACT_GOVERNANCE_DATABASE } from './contact-governance-api.js';
import {
  CG5_QUERY_CACHE,
  ContactGovernanceCg5QueryController,
} from './contact-governance-cg5-api.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
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

const cacheValues = new Map<string, string>();
const cache = new Cg5QueryCache({
  get: async (key) => cacheValues.get(key) ?? null,
  set: async (key, value) => {
    cacheValues.set(key, value);
  },
});

async function fixture(t: TestContext) {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const userId = randomUUID();
  for (const id of [tenantId, otherTenantId]) {
    await owner.tenant.create({
      data: { id, name: `CG5 API ${id}`, slug: id, sipDomain: `${id}.test` },
    });
  }
  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'tenant-token') return claims(tenantId, userId);
      if (token === 'other-token') return claims(otherTenantId, randomUUID());
      throw new Error('invalid token');
    },
  };
  @Module({
    controllers: [ContactGovernanceCg5QueryController],
    providers: [
      { provide: CONTACT_GOVERNANCE_DATABASE, useValue: application },
      { provide: CG5_QUERY_CACHE, useValue: cache },
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
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
    const where = { tenantId: { in: [tenantId, otherTenantId] } };
    await app.close();
    await owner.cgEventOutbox.deleteMany({ where });
    await owner.cg5AlertTransition.deleteMany({ where });
    await owner.cg5AlertState.deleteMany({ where });
    await owner.cg5MetricBucket.deleteMany({ where });
    await owner.cg5ProjectionCursor.deleteMany({ where });
    await owner.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } });
  });
  return { tenantId, otherTenantId, base };
}

async function ready(tenantId: string) {
  await owner.cg5ProjectionCursor.create({
    data: {
      tenantId,
      sourceKey: 'cg5.projection.readiness',
      state: 'READY',
      lastRunAt: new Date(),
    },
  });
}

function request(url: string, token = 'tenant-token', init: RequestInit = {}) {
  return fetch(url, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });
}

test('CG5.7 route ปฏิเสธ projection ที่ยังไม่พร้อม และไม่รับ tenantId จาก query', async (t) => {
  const f = await fixture(t);
  const unavailable = await request(`${f.base}/metrics?granularity=FIVE_MIN`);
  assert.equal(unavailable.status, 503);
  assert.equal(((await unavailable.json()) as { code: string }).code, 'CG5_PROJECTION_NOT_READY');
  await ready(f.tenantId);
  await ready(f.otherTenantId);
  const at = new Date('2026-09-20T00:00:00.000Z');
  await owner.cg5MetricBucket.createMany({
    data: [
      {
        tenantId: f.tenantId,
        metricKey: 'cg.decision',
        granularity: 'FIVE_MIN',
        bucketStart: at,
        dimensionKey: 'a'.repeat(64),
        value: 1,
        sampleCount: 1n,
        updatedAt: at,
      },
      {
        tenantId: f.otherTenantId,
        metricKey: 'cg.decision',
        granularity: 'FIVE_MIN',
        bucketStart: at,
        dimensionKey: 'b'.repeat(64),
        value: 2,
        sampleCount: 2n,
        updatedAt: at,
      },
    ],
  });
  const response = await request(
    `${f.base}/metrics?granularity=FIVE_MIN&tenantId=${f.otherTenantId}`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    items: Array<{ value: string }>;
    asOf: string;
    nextCursor: string | null;
  };
  assert.deepEqual(
    body.items.map((item) => item.value),
    ['1'],
  );
  assert.equal(body.asOf, at.toISOString());
  assert.equal(body.nextCursor, null);
  const cached = await request(
    `${f.base}/metrics?granularity=FIVE_MIN&tenantId=${f.otherTenantId}`,
  );
  assert.equal(cached.status, 200);
  const cachedBody = (await cached.json()) as { items: Array<{ value: string }> };
  assert.deepEqual(
    cachedBody.items.map((item) => item.value),
    ['1'],
  );
});

test('CG5.7 ack map optimistic conflict เป็น CG5_ALERT_VERSION_CONFLICT', async (t) => {
  const f = await fixture(t);
  await ready(f.tenantId);
  const repository = new Cg5AlertRepository(application);
  const alert = await repository.record({
    tenantId: f.tenantId,
    ruleCode: 'CG5_PROJECTION_LAG',
    scope: { channel: null, purpose: null, teamId: null },
    state: 'OPEN',
    severity: 'CRITICAL',
    value: 1,
    threshold: 0,
  });
  const first = await request(`${f.base}/alerts/${alert.id}/ack`, 'tenant-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(first.status, 201);
  assert.deepEqual(await first.json(), { alertId: alert.id, version: 2 });
  const conflict = await request(`${f.base}/alerts/${alert.id}/ack`, 'tenant-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ version: 1 }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(((await conflict.json()) as { code: string }).code, 'CG5_ALERT_VERSION_CONFLICT');
});
